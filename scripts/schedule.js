// scripts/schedule.js
//
// The Settings page's "Scheduled run": on the chosen days at a set time, run
// an add-on's whole suite the same way pressing Run does. The run's Slack
// report goes out through the usual end-of-run notification.
//
// Saved in data/schedule.json:
//   { enabled, time: "02:00", days: [0-6], slug, headed, cleanup, lastRunAt, lastError }
//
// Times are the SERVER's local clock (the machine running `npm run ui`).

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const FILE = path.join(ROOT, "data", "schedule.json");

const DEFAULTS = {
  enabled: false,
  time: "02:00",
  days: [0, 1, 2, 3, 4, 5, 6],
  slug: "wptravelengine-accommodation",
  headed: false,
  cleanup: false,
  lastRunAt: null,
  lastError: null,
};

function load() {
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(FILE, "utf8")) };
  } catch {
    return { ...DEFAULTS };
  }
}

function save(next) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

/** Validates and saves the Settings form. */
function update(input = {}, { validSlugs = [] } = {}) {
  const next = load();
  if (input.enabled !== undefined) next.enabled = Boolean(input.enabled);
  if (input.time !== undefined) {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(input.time))) throw new Error("Time must be HH:MM (24-hour).");
    next.time = input.time;
  }
  if (input.days !== undefined) {
    const days = [...new Set((Array.isArray(input.days) ? input.days : []).map(Number))].filter((d) => d >= 0 && d <= 6).sort();
    if (!days.length) throw new Error("Pick at least one day.");
    next.days = days;
  }
  if (input.slug !== undefined) {
    if (validSlugs.length && !validSlugs.includes(input.slug)) throw new Error("Pick an add-on that has tests.");
    next.slug = input.slug;
  }
  if (input.headed !== undefined) next.headed = Boolean(input.headed);
  if (input.cleanup !== undefined) next.cleanup = Boolean(input.cleanup);
  return save(next);
}

/** The next time the schedule will fire, as an ISO string, or null. */
function nextRun(s = load(), from = new Date()) {
  if (!s.enabled || !s.days.length) return null;
  const [h, m] = s.time.split(":").map(Number);
  for (let i = 0; i < 8; i += 1) {
    const at = new Date(from);
    at.setDate(at.getDate() + i);
    at.setHours(h, m, 0, 0);
    if (at > from && s.days.includes(at.getDay())) return at.toISOString();
  }
  return null;
}

/**
 * Checks every 20s whether it's time. `start(s)` starts the run and throws
 * when it can't (another run going…); that error is kept for the page.
 */
function startTimer(start) {
  const tick = async () => {
    const s = load();
    if (!s.enabled) return;
    const now = new Date();
    const hhmm = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    if (hhmm !== s.time || !s.days.includes(now.getDay())) return;
    // Once per minute slot, even across restarts. The slot is claimed on disk
    // BEFORE starting, so a second runner process reading the same file a
    // moment later sees it taken.
    if (s.lastRunAt && now - new Date(s.lastRunAt) < 90 * 1000) return;
    s.lastRunAt = now.toISOString();
    save(s);
    try {
      await start(s);
      s.lastError = null;
      console.log(`⏰ Scheduled run started (${s.slug})`);
    } catch (error) {
      s.lastError = error.message;
      console.warn(`⚠ Scheduled run did not start: ${error.message}`);
    }
    save(s);
  };
  return setInterval(() => tick().catch((e) => console.warn(`⚠ schedule: ${e.message}`)), 20 * 1000);
}

module.exports = { load, update, nextRun, startTimer, save };
