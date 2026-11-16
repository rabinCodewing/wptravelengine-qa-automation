// scripts/slackNotify.js
//
// Posts add-on test results to Slack, for the add-on QA runner (scripts/addonsUi.js).
//
//   automatically   when a run finishes, per the Settings page's "Send
//                   automatically" choice: every run, failures only, only when
//                   the result changes (pass ↔ fail), or off.
//   by hand         Settings → "Send last run" posts any add-on's last run.
//
// Two ways in, the Settings page's (data/slack.json) winning over .env:
//
//   bot token + channel ID   a Slack app with chat:write (+ files:write for
//                            failure screenshots in the message's thread).
//                            SLACK_BOT_TOKEN + SLACK_CHANNEL in .env.
//   incoming webhook         one channel, text only. SLACK_WEBHOOK_URL in .env.
//
// The page never receives a saved token or URL back, only its last 4.
// Nothing here can change a run's result: callers catch and log every error.

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const STORE_FILE = path.join(ROOT, "data", "slack.json");
const SLACK_API = "https://slack.com/api";

const SETTING_KEYS = ["botToken", "channel", "webhookUrl"];
const NOTIFY_MODES = ["every", "failures", "changes", "off"];
const DEFAULT_OPTIONS = { notifyOn: "every", includeBookings: true, includeErrors: true, includeScreenshots: true };

// ── settings ─────────────────────────────────────────────────────────────────
function readStore() {
  try {
    return JSON.parse(fs.readFileSync(STORE_FILE, "utf8")) || {};
  } catch {
    return {};
  }
}

function writeStore(next) {
  fs.mkdirSync(path.dirname(STORE_FILE), { recursive: true });
  const temp = `${STORE_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, STORE_FILE);
}

/** When and what to send. Saved on the Settings page; SLACK_NOTIFY_ON in .env as the fallback. */
function options(env = process.env) {
  const saved = readStore().options || {};
  const merged = { ...DEFAULT_OPTIONS, ...saved };
  if (!saved.notifyOn && NOTIFY_MODES.includes(env.SLACK_NOTIFY_ON)) merged.notifyOn = env.SLACK_NOTIFY_ON;
  if (!NOTIFY_MODES.includes(merged.notifyOn)) merged.notifyOn = DEFAULT_OPTIONS.notifyOn;
  return merged;
}

function saveOptions(input = {}) {
  const next = { ...options() };
  if (input.notifyOn !== undefined) {
    if (!NOTIFY_MODES.includes(input.notifyOn)) throw new Error(`notifyOn must be one of: ${NOTIFY_MODES.join(", ")}.`);
    next.notifyOn = input.notifyOn;
  }
  for (const key of ["includeBookings", "includeErrors", "includeScreenshots"]) {
    if (input[key] !== undefined) next[key] = Boolean(input[key]);
  }
  writeStore({ ...readStore(), options: next });
}

function savedConnection() {
  const store = readStore();
  return Object.fromEntries(SETTING_KEYS.map((key) => [key, typeof store[key] === "string" ? store[key].trim() : ""]));
}

/**
 * Saves the connection form. An empty field keeps what was saved before (the
 * page only ever shows the last 4 of a secret, so an untouched field comes
 * back blank). `remove` drops the connection and keeps the options.
 */
function saveConnection(input = {}, { remove = false } = {}) {
  const store = readStore();
  if (remove) {
    writeStore({ options: store.options });
    return;
  }
  const next = savedConnection();
  for (const key of SETTING_KEYS) {
    const value = typeof input[key] === "string" ? input[key].trim() : "";
    if (value) next[key] = value;
  }
  if (input.mode === "webhook") {
    next.botToken = "";
    next.channel = "";
    if (!next.webhookUrl) throw new Error("Enter the webhook URL.");
  } else if (input.mode === "bot") {
    next.webhookUrl = "";
    if (!next.botToken || !next.channel) throw new Error("Enter both the bot token and the channel ID.");
  }
  if (next.webhookUrl && !/^https:\/\/hooks\.slack\.com\//.test(next.webhookUrl)) {
    throw new Error("A Slack webhook URL starts with https://hooks.slack.com/.");
  }
  if (next.botToken && !/^xox[bp]-/.test(next.botToken)) throw new Error("A Slack bot token starts with xoxb-.");
  writeStore({ ...store, ...next });
}

/** The page's connection as a whole when anything is saved there, else .env's. */
function activeConnection(env = process.env) {
  const saved = savedConnection();
  if (SETTING_KEYS.some((key) => saved[key])) return { ...saved, source: "settings" };
  const fromEnv = {
    botToken: (env.SLACK_BOT_TOKEN || "").trim(),
    channel: (env.SLACK_CHANNEL || "").trim(),
    webhookUrl: (env.SLACK_WEBHOOK_URL || "").trim(),
  };
  return { ...fromEnv, source: SETTING_KEYS.some((key) => fromEnv[key]) ? "env" : null };
}

function config(env = process.env) {
  const { botToken, channel, webhookUrl } = activeConnection(env);
  if (botToken && channel) return { mode: "bot", token: botToken, channel };
  if (webhookUrl) return { mode: "webhook", webhook: webhookUrl };
  return { mode: null };
}

const tail = (value) => (value ? `…${value.slice(-4)}` : "");

/** What the Settings page shows: never a token or URL, only their last 4. */
function status(env = process.env) {
  const cfg = config(env);
  const active = activeConnection(env);
  return {
    configured: Boolean(cfg.mode),
    mode: cfg.mode,
    source: active.source,
    channel: active.channel || null,
    botToken: tail(active.botToken),
    webhookUrl: tail(active.webhookUrl),
    options: options(env),
    publicUrl: env.UI_PUBLIC_URL || null,
  };
}

// ── message ──────────────────────────────────────────────────────────────────
const COLOR = { passed: "#2EB67D", failed: "#E01E5A", stopped: "#9AA0A6" };
const ICON = { passed: ":large_green_circle:", failed: ":red_circle:", stopped: ":white_circle:" };
const VERDICT = { passed: "Passed", failed: "Failed", stopped: "Stopped" };
const MAX_TEXT = 7000;

const escape = (text) => String(text ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const field = (title, value, short = true) => ({ title, value: value === "" || value == null ? "—" : String(value), short });
const money = (n) => (n == null || Number.isNaN(Number(n)) ? "—" : `$${Number(n).toLocaleString("en-US", { maximumFractionDigits: 2 })}`);

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return url || "";
  }
}

function duration(ms) {
  if (ms == null) return "";
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s` : `${s}s`;
}

function slackDate(iso) {
  const t = Date.parse(iso);
  if (!t) return "—";
  return `<!date^${Math.floor(t / 1000)}^{date_short_pretty} at {time}|${new Date(t).toISOString()}>`;
}

const firstLine = (text) => String(text || "").replace(/\x1b\[[0-9;]*m/g, "").split("\n").map((l) => l.trim()).find(Boolean) || "";

/**
 * One finished run of an add-on.
 *
 * @param run       { addon: { name, slug }, status, startedAt, finishedAt, scope, passed, failed, skipped }
 * @param results   { "section › title": { status, error, screenshot } } for the run's tests
 * @param bookings  bookings.json written during this run, or null
 */
function buildRunMessage(run, { results = {}, bookings = null, site = "", reportUrl = null, trigger = "manual" } = {}, opts = options()) {
  const status = run.status in COLOR ? run.status : "stopped";
  const verdict = VERDICT[status];
  const host = hostOf(site);
  const took = run.startedAt && run.finishedAt ? Date.parse(run.finishedAt) - Date.parse(run.startedAt) : null;
  const total = run.passed + run.failed + run.skipped;
  const triggerText = trigger === "schedule" ? ":alarm_clock: *Scheduled run* · " : "";

  const text = `${triggerText}A *WP Travel Engine add-on test run* ${status === "stopped" ? "was stopped" : verdict.toLowerCase()} on *${escape(host || "the test site")}* — ${escape(run.addon.name)}`;

  const lines = [];
  if (status === "passed") lines.push(`All ${run.passed} test${run.passed === 1 ? "" : "s"} passed${took ? ` in *${duration(took)}*` : ""}.`);
  else if (status === "failed") lines.push(`*${run.failed}* of ${total} test${total === 1 ? "" : "s"} failed${took ? ` after *${duration(took)}*` : ""}.`);
  else lines.push("The run was stopped before it finished.");

  const failures = Object.entries(results).filter(([, r]) => r.status === "failed");
  if (failures.length) {
    lines.push("", "*Failing tests*");
    for (const [id, r] of failures.slice(0, 10)) {
      lines.push(`:x: ${escape(id)}`);
      if (opts.includeErrors && r.error) lines.push(`> ${escape(firstLine(r.error).slice(0, 280))}`);
    }
    if (failures.length > 10) lines.push(`_…and ${failures.length - 10} more._`);
  }
  if (reportUrl) lines.push("", `<${reportUrl}|Open the runner>`);

  const fields = [
    field("Add-on", escape(run.addon.name)),
    field("Result", `${ICON[status]} ${verdict}`),
    field("Tests", `${total} total · ${run.passed} passed · ${run.failed} failed${run.skipped ? ` · ${run.skipped} not run` : ""}`),
    field("Scope", run.scope === "all" ? "All tests" : `${run.scope} selected`),
    field("Duration", took ? duration(took) : ""),
    field("Site", escape(host)),
    field("Started", slackDate(run.startedAt)),
    field("Finished", slackDate(run.finishedAt)),
  ];

  const attachments = [
    {
      color: COLOR[status],
      fallback: `${run.addon.name}: ${verdict}`,
      title: `${ICON[status]} ${run.addon.name} — ${verdict}`,
      ...(reportUrl ? { title_link: reportUrl } : {}),
      text: lines.join("\n").slice(0, MAX_TEXT),
      fields,
      footer: "WPTE Add-on QA",
      ...(run.finishedAt ? { ts: Math.floor(Date.parse(run.finishedAt) / 1000) } : {}),
      mrkdwn_in: ["text", "fields"],
    },
  ];

  const items = opts.includeBookings ? bookings?.items || [] : [];
  if (items.length) {
    const ok = items.filter((it) => it.verified).length;
    const rows = items.map((it) => {
      const acc = (it.lines || []).map((l) => `${escape(l.label)} ${l.quantity}×${money(l.price)}`).join(", ") || "no accommodation";
      const pay = it.payment ? `${it.payment.status} ${money(it.payment.amount)}` : "no payment";
      const id = it.bookingId ? `*#${it.bookingId}*` : "_no booking_";
      return `${it.verified ? ":white_check_mark:" : ":x:"} ${id} ${escape(it.trip)} — ${acc} — *${money(it.total)}* — ${escape(pay)}${it.verified ? "" : `\n> ${escape(firstLine(it.error).slice(0, 200))}`}`;
    });
    attachments.push({
      color: ok === items.length ? COLOR.passed : COLOR.failed,
      fallback: `${items.length} Stripe bookings, ${ok} verified`,
      title: `:credit_card: Stripe bookings — ${ok} of ${items.length} verified`,
      text: rows.join("\n").slice(0, MAX_TEXT),
      mrkdwn_in: ["text"],
    });
  }

  return { text, attachments };
}

// ── delivery ─────────────────────────────────────────────────────────────────
async function slackApi(token, method, body) {
  const response = await fetch(`${SLACK_API}/${method}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!data.ok) throw new Error(`Slack ${method} failed: ${data.error || `HTTP ${response.status}`}`);
  return data;
}

/** Slack's upload flow: get an upload URL, send the bytes, complete into the thread. */
async function uploadFile(token, channel, threadTs, file, title) {
  const bytes = fs.readFileSync(file);
  const target = await (
    await fetch(`${SLACK_API}/files.getUploadURLExternal`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ filename: path.basename(file), length: String(bytes.length) }),
    })
  ).json();
  if (!target.ok) throw new Error(`Slack files.getUploadURLExternal failed: ${target.error}`);
  const upload = await fetch(target.upload_url, { method: "POST", body: bytes });
  if (!upload.ok) throw new Error(`Slack upload failed: HTTP ${upload.status}`);
  await slackApi(token, "files.completeUploadExternal", { files: [{ id: target.file_id, title }], channel_id: channel, thread_ts: threadTs });
}

async function deliver(cfg, message, screenshots = []) {
  if (cfg.mode === "webhook") {
    const response = await fetch(cfg.webhook, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(message) });
    // The webhook URL is the secret, so it never goes into the error.
    if (!response.ok) throw new Error(`Slack webhook failed: HTTP ${response.status}`);
    return { mode: "webhook", screenshots: 0 };
  }
  const posted = await slackApi(cfg.token, "chat.postMessage", { channel: cfg.channel, ...message, unfurl_links: false });
  let uploaded = 0;
  for (const shot of screenshots) {
    try {
      await uploadFile(cfg.token, posted.channel, posted.ts, shot.file, shot.title);
      uploaded += 1;
    } catch (error) {
      console.warn(`⚠ Slack: screenshot upload failed (${shot.title}): ${error.message}`);
    }
  }
  return { mode: "bot", screenshots: uploaded };
}

// Errors no retry will fix.
const PERMANENT = /invalid_auth|not_authed|account_inactive|token_revoked|channel_not_found|not_in_channel|is_archived|missing_scope|no_permission|invalid_payload|no_service|HTTP 4\d\d\b/;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Sends with retries on transient failures. Returns null when Slack is not set up. */
async function notify(message, { screenshots = [], attempts = 3, backoffMs = 2000 } = {}, env = process.env) {
  const cfg = config(env);
  if (!cfg.mode) return null;
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await deliver(cfg, message, screenshots);
    } catch (error) {
      lastError = error;
      if (PERMANENT.test(error.message) || attempt === attempts) break;
      await wait(backoffMs * 3 ** (attempt - 1));
    }
  }
  throw lastError;
}

/** The Settings page's "Send test message". */
async function sendTest(env = process.env) {
  const cfg = config(env);
  if (!cfg.mode) throw new Error("Nothing to test: save a bot token + channel, or a webhook URL, first.");
  await deliver(cfg, { text: ":wave: WPTE Add-on QA is connected. Test results will be posted here." });
  return { mode: cfg.mode };
}

/**
 * Whether a finished run should be posted automatically.
 * @param previous  the add-on's history entry before this run, or undefined
 */
function shouldNotify(run, previous, opts = options()) {
  if (!config().mode) return false;
  switch (opts.notifyOn) {
    case "off":
      return false;
    case "failures":
      return run.status === "failed";
    case "changes":
      return run.status !== "stopped" && (!previous || previous.status !== run.status);
    default:
      return true;
  }
}

module.exports = { status, options, saveOptions, saveConnection, buildRunMessage, notify, sendTest, shouldNotify, NOTIFY_MODES };
