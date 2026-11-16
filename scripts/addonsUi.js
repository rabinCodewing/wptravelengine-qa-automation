#!/usr/bin/env node
// scripts/addonsUi.js — the WP Travel Engine add-on QA runner.
//
//   npm run ui                 → http://localhost:4417
//   PORT=5000 npm run ui
//
// One process: serves scripts/addonsUi.html and spawns the Playwright runs.
//
//   - The add-on index comes from config/addons.js. Add-ons with a `spec` are
//     automated; the rest show as coverage still to write.
//   - For an automated add-on it lists the spec's tests (grouped by their
//     top-level test.describe), runs all or a selection, streams the output,
//     serves a live view of the browser (tests/support/liveFrames.js), and
//     keeps the last result plus a short run history per add-on under
//     data/addons/<slug>/.
//
// Runs go one at a time across ALL add-ons: they share one WordPress site, and
// several add-on suites change site-wide settings.
//
// Binds to 127.0.0.1 only — it starts browser runs against your site.

const fs = require("fs");
const http = require("http");
const path = require("path");
const { spawn, execFile } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
require("dotenv").config({ path: path.join(ROOT, ".env"), quiet: true });

const { ADDONS, GROUP_ORDER } = require("../config/addons");
const { buildReport } = require("./repoAudit");
const doctor = require("./doctor");
const { CHECKLIST } = require("./doctor/checklist");
const { evaluate: evaluateStandards } = require("./doctor/standards");
const { PAYLOADS } = require("./doctor/payloads");
const { buildUrlPayloads } = require("./doctor/urlBuilder");
const { buildPlan: buildRequestPlan } = require("./doctor/requestBuilder");
const github = require("./doctor/github");
let doctorScan = null; // the security scan in progress, if any (one at a time)
let doctorLast = null; // how the last scan ended: { ok, name } or { ok: false, error }
const slack = require("./slackNotify");
const schedule = require("./schedule");
const CLI = path.join(ROOT, "node_modules", "@playwright", "test", "cli.js");
const PORT = Number(process.env.PORT) || 4417;
const HOST = "127.0.0.1";
const PAGE_FILE = path.join(__dirname, "addonsUi.html");
const HISTORY_LIMIT = 12;

const addonDir = (slug) => path.join(ROOT, "data", "addons", slug);
const resultsFile = (slug) => path.join(addonDir(slug), "last-run.json");
const historyFile = (slug) => path.join(addonDir(slug), "history.json");
const liveFile = (slug) => path.join(addonDir(slug), "live", "frame.jpg");
const liveMetaFile = (slug) => path.join(addonDir(slug), "live", "frame.json");
const findAddon = (slug) => ADDONS.find((a) => a.slug === slug);
const readJson = (file, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
};

// ── the (single) run ─────────────────────────────────────────────────────────
const run = {
  child: null,
  slug: null,
  status: "idle", // idle | running | passed | failed | stopped
  startedAt: null,
  finishedAt: null,
  selection: [],
  options: {},
  trigger: "manual", // manual | schedule
  log: [],
};

// Last Slack delivery, for the Settings page.
let lastSlack = null;
const clients = new Set();

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(payload);
}

function pushLog(text) {
  for (const line of text.replace(/\x1b\[[0-9;]*m/g, "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    run.log.push(line);
    if (run.log.length > 5000) run.log.shift();
    broadcast("log", line);
  }
}

function publicState() {
  const { child, log, ...rest } = run;
  return { ...rest, running: Boolean(child) };
}

// ── tests ────────────────────────────────────────────────────────────────────
const testCache = new Map();

/**
 * [{ id, section, title, line }] for an add-on, from `playwright test --list`.
 * `section` is the top-level describe ("2. Settings UI"); the id is the same
 * "section › title" path the JSON reporter produces, so results line up.
 */
function listTests(addon) {
  if (!addon?.spec) return Promise.resolve([]);
  if (testCache.has(addon.slug)) return Promise.resolve(testCache.get(addon.slug));
  const specName = path.basename(addon.spec).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [CLI, "test", addon.spec, "--project=firefox", "--list"],
      { cwd: ROOT, env: { ...process.env, FORCE_COLOR: "0" }, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout) => {
        const tests = [];
        const re = new RegExp(`›\\s*${specName}:(\\d+):\\d+\\s*›\\s*(.+)$`);
        for (const raw of String(stdout || "").split(/\r?\n/)) {
          const m = raw.match(re);
          if (!m) continue;
          const parts = m[2].trim().split(" › ");
          const section = parts.length > 1 ? parts[0] : "Tests";
          const title = parts.length > 1 ? parts.slice(1).join(" › ") : parts[0];
          tests.push({ id: `${section} › ${title}`, line: Number(m[1]), section, title });
        }
        if (error && !tests.length) console.log(`⚠ Could not list ${addon.spec}: ${error.message.split("\n")[0]}`);
        testCache.set(addon.slug, tests);
        resolve(tests);
      },
    );
  });
}

/** Flattens Playwright's JSON report into { "section › title": result }. */
function readResults(slug) {
  const report = readJson(resultsFile(slug), null);
  if (!report) return {};
  const out = {};
  const walk = (suite, titles) => {
    const here = suite.title && !/\.spec\.[jt]s$/.test(suite.title) ? [...titles, suite.title] : titles;
    for (const spec of suite.specs || []) {
      const test = spec.tests?.[0];
      const result = test?.results?.[test.results.length - 1];
      const id = here.length ? `${here[0]} › ${[...here.slice(1), spec.title].join(" › ")}` : `Tests › ${spec.title}`;
      const status = result ? (result.status === "passed" ? "passed" : result.status === "skipped" ? "skipped" : "failed") : "notrun";
      const attachments = result?.attachments || [];
      out[id] = {
        status,
        duration: result?.duration ?? null,
        startTime: result?.startTime ?? null,
        error: result?.error?.message?.replace(/\x1b\[[0-9;]*m/g, "") || null,
        screenshot: attachments.find((a) => a.contentType === "image/png" && a.path)?.path || null,
        trace: attachments.find((a) => a.name === "trace" && a.path)?.path || null,
      };
    }
    for (const child of suite.suites || []) walk(child, here);
  };
  for (const suite of report.suites || []) walk(suite, []);
  return out;
}

function summarize(results) {
  const list = Object.values(results);
  return {
    passed: list.filter((r) => r.status === "passed").length,
    failed: list.filter((r) => r.status === "failed").length,
    skipped: list.filter((r) => r.status === "skipped" || r.status === "notrun").length,
    duration: list.reduce((a, r) => a + (r.duration || 0), 0),
  };
}

async function addonDetail(addon) {
  const tests = await listTests(addon);
  return {
    ...addon,
    tests,
    sections: [...new Set(tests.map((t) => t.section))],
    results: readResults(addon.slug),
    history: readJson(historyFile(addon.slug), []),
    fixtures: addon.fixtures ? readJson(path.join(ROOT, addon.fixtures), null) : null,
    bookings: addon.bookings ? readJson(path.join(ROOT, addon.bookings), null) : null,
    hasReport: Boolean(addon.report && fs.existsSync(path.join(ROOT, addon.report))),
    repo: addon.repo || null,
  };
}

async function catalog() {
  const items = [];
  for (const addon of ADDONS) {
    const tests = await listTests(addon);
    const history = readJson(historyFile(addon.slug), []);
    items.push({
      slug: addon.slug,
      name: addon.name,
      group: addon.group,
      description: addon.description,
      automated: Boolean(addon.spec),
      tests: tests.length,
      sections: new Set(tests.map((t) => t.section)).size,
      last: history[0] || null,
      hasReport: Boolean(addon.report && fs.existsSync(path.join(ROOT, addon.report))),
    });
  }
  return { groups: GROUP_ORDER, addons: items };
}

// ── running ──────────────────────────────────────────────────────────────────
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

async function startRun({ slug, selection = [], headed = false, live = true, cleanup = false, trigger = "manual" }) {
  if (run.child) throw new Error(`A run is already going (${findAddon(run.slug)?.name || run.slug}). Runs share one site, so they go one at a time.`);
  const addon = findAddon(slug);
  if (!addon?.spec) throw new Error("This add-on has no automated tests yet.");
  const all = await listTests(addon);
  const chosen = selection.length ? all.filter((t) => selection.includes(t.id)) : all;
  if (!chosen.length) throw new Error("Nothing selected.");

  const args = [CLI, "test", addon.spec, "--project=firefox", "--reporter=line,json,html"];
  if (chosen.length !== all.length) args.push("--grep", chosen.map((t) => `${escapeRegExp(t.title)}$`).join("|"));

  fs.mkdirSync(path.dirname(liveFile(slug)), { recursive: true });
  fs.rmSync(resultsFile(slug), { force: true });
  fs.rmSync(liveFile(slug), { force: true });

  Object.assign(run, {
    slug,
    status: "running",
    startedAt: new Date().toISOString(),
    finishedAt: null,
    selection: chosen.map((t) => t.id),
    options: { headed, live, cleanup },
    trigger,
    log: [],
  });
  broadcast("status", publicState());
  pushLog(`▶ ${addon.name} · ${chosen.length} test${chosen.length === 1 ? "" : "s"} · ${headed ? "headed" : "headless"}${cleanup ? " · cleanup on" : ""}`);

  const env = {
    ...process.env,
    FORCE_COLOR: "0",
    PW_HEADLESS: headed ? "0" : "1",
    PLAYWRIGHT_JSON_OUTPUT_NAME: resultsFile(slug),
    PLAYWRIGHT_HTML_OPEN: "never",
  };
  if (live) env.PW_LIVE_FILE = liveFile(slug);
  else delete env.PW_LIVE_FILE;
  if (addon.cleanupEnv) env[addon.cleanupEnv] = cleanup ? "1" : "0";

  const child = spawn(process.execPath, args, { cwd: ROOT, env });
  run.child = child;
  child.stdout.on("data", (b) => pushLog(b.toString()));
  child.stderr.on("data", (b) => pushLog(b.toString()));
  child.on("close", (code) => {
    run.child = null;
    run.finishedAt = new Date().toISOString();
    if (run.status !== "stopped") run.status = code === 0 ? "passed" : "failed";
    pushLog(`■ finished: ${run.status}`);

    const results = readResults(slug);
    const entry = {
      status: run.status,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      scope: chosen.length === all.length ? "all" : chosen.length,
      ...summarize(Object.fromEntries(Object.entries(results).filter(([id]) => run.selection.includes(id)))),
    };
    const previous = readJson(historyFile(slug), []);
    const history = [entry, ...previous].slice(0, HISTORY_LIMIT);
    fs.mkdirSync(addonDir(slug), { recursive: true });
    fs.writeFileSync(historyFile(slug), JSON.stringify(history, null, 2));

    broadcast("status", publicState());
    addonDetail(addon).then((detail) => broadcast("addon", detail));

    // Slack, after the result is recorded. Never changes the result.
    if (slack.shouldNotify(entry, previous[0])) {
      sendRunReport(addon, entry, { trigger: run.trigger, selection: run.selection })
        .then((result) => result && pushLog(`✉ Slack: report sent (${result.mode}${result.screenshots ? `, ${result.screenshots} screenshot(s)` : ""})`))
        .catch((error) => pushLog(`⚠ Slack: report not sent: ${error.message}`));
    }
  });
}

/**
 * Posts one finished run of an add-on to Slack: its result, failing tests and,
 * when the run wrote them, the Stripe bookings it made and verified.
 */
async function sendRunReport(addon, entry, { trigger = "manual", selection = null } = {}) {
  const all = readResults(addon.slug);
  const results = selection ? Object.fromEntries(Object.entries(all).filter(([id]) => selection.includes(id))) : all;
  const bookingsFile = addon.bookings ? readJson(path.join(ROOT, addon.bookings), null) : null;
  // Only bookings this run wrote, not an older run's.
  const bookings = bookingsFile && Date.parse(bookingsFile.updatedAt) >= Date.parse(entry.startedAt) ? bookingsFile : null;
  const opts = slack.options();
  const publicUrl = (process.env.UI_PUBLIC_URL || "").replace(/\/$/, "");
  const message = slack.buildRunMessage(
    { addon: { name: addon.name, slug: addon.slug }, ...entry },
    { results, bookings, site: process.env.FRONTEND_URL, reportUrl: publicUrl ? `${publicUrl}/#/${addon.slug}` : null, trigger },
    opts,
  );
  const screenshots = opts.includeScreenshots
    ? Object.entries(results)
        .filter(([, r]) => r.status === "failed" && r.screenshot && fs.existsSync(r.screenshot))
        .slice(0, 5)
        .map(([id, r]) => ({ file: r.screenshot, title: `${addon.name} · ${id}` }))
    : [];
  try {
    const result = await slack.notify(message, { screenshots });
    lastSlack = { at: new Date().toISOString(), ok: true, addon: addon.name, status: entry.status, mode: result?.mode };
    return result;
  } catch (error) {
    lastSlack = { at: new Date().toISOString(), ok: false, addon: addon.name, status: entry.status, error: error.message };
    throw error;
  }
}

/** Everything the Settings page shows. Secrets only ever as their last 4. */
function settingsState() {
  const env = process.env;
  const tail = (v) => (v ? `…${v.slice(-4)}` : "");
  const s = schedule.load();
  return {
    slack: { ...slack.status(), last: lastSlack },
    schedule: { ...s, next: schedule.nextRun(s), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone },
    addons: ADDONS.filter((a) => a.spec).map((a) => ({ slug: a.slug, name: a.name, last: readJson(historyFile(a.slug), [])[0] || null })),
    site: {
      url: env.FRONTEND_URL || "",
      loginUrl: env.WP_LOGIN_URL || "",
      username: env.WP_USERNAME || "",
      passwordSet: Boolean(env.WP_PASSWORD),
      stripe: {
        publishableKey: tail(env.STRIPE_PUBLISHABLE_KEY),
        secretKeySet: Boolean(env.STRIPE_SECRET_KEY),
        mode: /^pk_live_/.test(env.STRIPE_PUBLISHABLE_KEY || "") ? "live" : env.STRIPE_PUBLISHABLE_KEY ? "test" : null,
      },
    },
  };
}

function stopRun() {
  if (!run.child) return false;
  run.status = "stopped";
  if (process.platform === "win32") spawn("taskkill", ["/pid", String(run.child.pid), "/T", "/F"]);
  else run.child.kill("SIGTERM");
  return true;
}

// Tell pages a new live frame exists (they fetch it themselves).
let lastFrameAt = 0;
setInterval(() => {
  if (!run.child || !run.slug) return;
  const meta = readJson(liveMetaFile(run.slug), null);
  if (meta?.at && meta.at !== lastFrameAt) {
    lastFrameAt = meta.at;
    broadcast("frame", { slug: run.slug, ...meta });
  }
}, 400).unref();

// ── http ─────────────────────────────────────────────────────────────────────
function sendJson(res, code, body) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });
  });
}

const TYPES = { ".png": "image/png", ".jpg": "image/jpeg", ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".zip": "application/zip", ".woff2": "font/woff2" };

/** Serves a file only when it sits inside one of the allowed folders. */
function serveWithin(res, file, roots, extraHeaders = {}) {
  const resolved = path.resolve(file);
  if (!roots.some((r) => resolved.startsWith(path.resolve(r) + path.sep)) || !fs.existsSync(resolved)) {
    res.writeHead(404);
    return res.end("Not found");
  }
  res.writeHead(200, { "Content-Type": TYPES[path.extname(resolved)] || "application/octet-stream", ...extraHeaders });
  fs.createReadStream(resolved).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;
  try {
    if (req.method === "GET" && p === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      return res.end(fs.readFileSync(PAGE_FILE));
    }
    if (req.method === "GET" && p === "/api/catalog") {
      return sendJson(res, 200, { ...(await catalog()), state: publicState(), site: process.env.FRONTEND_URL || "", log: run.log });
    }
    const addonMatch = p.match(/^\/api\/addons\/([a-z0-9-]+)$/);
    if (req.method === "GET" && addonMatch) {
      const addon = findAddon(addonMatch[1]);
      if (!addon) return sendJson(res, 404, { ok: false, error: "Unknown add-on" });
      return sendJson(res, 200, await addonDetail(addon));
    }
    // QA Report: the curated findings re-located in the add-on's source.
    const reportMatch = p.match(/^\/api\/report\/([a-z0-9-]+)$/);
    if (reportMatch) {
      const addon = findAddon(reportMatch[1]);
      if (!addon) return sendJson(res, 404, { ok: false, error: "Unknown add-on" });
      if (!addon.report) return sendJson(res, 404, { ok: false, error: "No QA report for this add-on yet." });
      // POST re-scans the repo (git pull + re-locate); GET returns what's on disk.
      const doScan = req.method === "POST";
      const report = await buildReport(addon, { doScan });
      report.bugRepo = addon.bugRepo || github.loadConfig().repo || "";
      return sendJson(res, 200, { ok: true, report });
    }
    // File one QA-Report finding as a GitHub issue.
    const reportFileMatch = p.match(/^\/api\/report\/([a-z0-9-]+)\/file-issue$/);
    if (req.method === "POST" && reportFileMatch) {
      const addon = findAddon(reportFileMatch[1]);
      if (!addon || !addon.report) return sendJson(res, 404, { ok: false, error: "Unknown add-on or no QA report." });
      const { id } = await readBody(req);
      try {
        const report = await buildReport(addon, { doScan: false });
        const f = (report.findings || []).find((x) => x.id === id);
        if (!f) return sendJson(res, 404, { ok: false, error: "Finding not found." });
        const loc = f.matchedAt || (f.location || [])[0] || {};
        const normalized = {
          id: f.id,
          severity: f.severity,
          rule: f.category || "qa",
          title: f.title,
          file: loc.file || null,
          line: loc.line || null,
          cwe: f.cwe || "",
          detail: [f.evidence ? `Evidence: ${f.evidence}` : "", loc.note ? `Note: ${loc.note}` : ""].filter(Boolean).join("\n"),
          impact: f.impact,
          repro: f.steps,
          fix: f.fix,
        };
        const issue = await github.fileIssue(normalized, { name: addon.name, repo: report.repoUrl || report.repo, commit: report.commit }, { repo: addon.bugRepo });
        // Record the issue back onto the curated qa-report.json so the card shows "Filed #n".
        const reportPath = path.join(ROOT, addon.report);
        try {
          const saved = JSON.parse(fs.readFileSync(reportPath, "utf8"));
          const sf = (saved.findings || []).find((x) => x.id === id);
          if (sf) {
            sf.issue = { number: issue.number, url: issue.url };
            fs.writeFileSync(reportPath, JSON.stringify(saved, null, 2));
          }
        } catch {}
        return sendJson(res, 200, { ok: true, issue, report: await buildReport(addon, { doScan: false }) });
      } catch (error) {
        return sendJson(res, 400, { ok: false, error: error.message });
      }
    }
    // ── Security page (WPTE Doctor) ──
    if (req.method === "GET" && p === "/api/security") {
      const targets = ADDONS.filter((a) => fs.existsSync(path.join(addonDir(a.slug), "repo"))).map((a) => ({ value: a.slug, label: a.name }));
      return sendJson(res, 200, {
        ok: true,
        targets,
        site: process.env.FRONTEND_URL || "",
        // Only whether a test user is set in .env, never the password.
        envTestUser: process.env.SECURITY_TEST_USER && process.env.SECURITY_TEST_PASSWORD ? process.env.SECURITY_TEST_USER : "",
        reports: doctor.listReports(),
        scanning: doctorScan && { startedAt: doctorScan.startedAt, log: doctorScan.log.slice(-6) },
        last: doctorLast,
      });
    }
    // Overview / threat model / audit: scan findings + checklist results mapped onto them.
    if (req.method === "GET" && p === "/api/security/standards") {
      // Same finding ID in several reports (e.g. code-only and code+site scans) counts once, from the newest report.
      const byId = new Map();
      for (const r of doctor.listReports()) {
        for (const f of doctor.readReport(r.name)?.findings || []) {
          if (!byId.has(f.id)) byId.set(f.id, { id: f.id, rule: f.rule, title: f.title, severity: f.severity, file: f.file, report: r.name });
        }
      }
      const findings = [...byId.values()];
      const results = readJson(path.join(ROOT, "data", "doctor", "checklist.json"), {});
      return sendJson(res, 200, { ok: true, ...evaluateStandards({ findings, results, checklist: CHECKLIST }) });
    }
    // Detection payloads reference.
    if (req.method === "GET" && p === "/api/security/payloads") {
      return sendJson(res, 200, { ok: true, payloads: PAYLOADS });
    }
    // GitHub issue filing: status/config + one-click file a finding.
    if (req.method === "GET" && p === "/api/security/github") {
      return sendJson(res, 200, { ok: true, ...(await github.status()) });
    }
    if (req.method === "PUT" && p === "/api/security/github") {
      const { repo, labels } = await readBody(req);
      github.saveConfig({ repo: repo ?? "", ...(labels ? { labels } : {}) });
      return sendJson(res, 200, { ok: true, ...(await github.status()) });
    }
    if (req.method === "POST" && p === "/api/security/file-issue") {
      const { name, id } = await readBody(req);
      const report = doctor.readReport(name);
      const finding = report?.findings.find((f) => f.id === id);
      if (!finding) return sendJson(res, 404, { ok: false, error: "Finding not found." });
      try {
        // Route by add-on: a code scan's meta.name is the add-on slug/name, so
        // its findings file to that add-on's own repo (bugRepo). Site scans
        // (no matching add-on) fall back to the global target.
        const addon = ADDONS.find((a) => a.slug === report.meta.name || a.name === report.meta.name);
        const issue = await github.fileIssue(finding, report.meta, { repo: addon?.bugRepo });
        return sendJson(res, 200, { ok: true, issue, report: doctor.recordIssue(name, id, issue) });
      } catch (error) {
        return sendJson(res, 400, { ok: false, error: error.message });
      }
    }
    // Payload URL builder: target URL → clickable payload URLs + curl.
    if (req.method === "POST" && p === "/api/security/build-url") {
      const { url, params, classes } = await readBody(req);
      try {
        return sendJson(res, 200, { ok: true, result: buildUrlPayloads(url, { params, classes }) });
      } catch (error) {
        return sendJson(res, 400, { ok: false, error: error.message });
      }
    }
    // Request-aware plan: a pasted URL / curl / raw HTTP request → full test plan.
    if (req.method === "POST" && p === "/api/security/build-request") {
      const { request, params, classes } = await readBody(req);
      try {
        return sendJson(res, 200, { ok: true, plan: buildRequestPlan(request, { params, classes }) });
      } catch (error) {
        return sendJson(res, 400, { ok: false, error: error.message });
      }
    }
    // Manual checklist: the items plus what the tester recorded for each.
    if (p === "/api/security/checklist" && (req.method === "GET" || req.method === "PUT")) {
      const file = path.join(ROOT, "data", "doctor", "checklist.json");
      const results = readJson(file, {});
      if (req.method === "PUT") {
        const { id, status, note } = await readBody(req);
        if (!id) return sendJson(res, 400, { ok: false, error: "Missing id" });
        if (!status && !note) delete results[id];
        else results[id] = { status: status || "", note: note || "", at: new Date().toISOString() };
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(results, null, 2));
      }
      return sendJson(res, 200, { ok: true, checklist: CHECKLIST, results });
    }
    const secMatch = p.match(/^\/api\/security\/report\/([\w.+-]+)$/);
    if (req.method === "GET" && secMatch) {
      const report = doctor.readReport(secMatch[1]);
      if (!report) return sendJson(res, 404, { ok: false, error: "No such report." });
      // The repo this report's findings file to (add-on's bugRepo, else global).
      const addon = ADDONS.find((a) => a.slug === report.meta.name || a.name === report.meta.name);
      report.bugRepo = addon?.bugRepo || github.loadConfig().repo || "";
      return sendJson(res, 200, { ok: true, report });
    }
    if (req.method === "POST" && p === "/api/security/scan") {
      if (doctorScan) return sendJson(res, 409, { ok: false, error: "A scan is already running." });
      const { repo, site, min, deps, fuzz, user, pass } = await readBody(req);
      // Runs in the background (a fuzz run takes minutes); the page polls /api/security.
      doctorScan = { repo, site, startedAt: new Date().toISOString(), log: [] };
      const scan = doctorScan;
      doctor
        .runDoctor(
          { repo: repo || undefined, site: site || undefined, min: min || "info", deps: !!deps, fuzz: !!fuzz, user: user || undefined, pass: pass || undefined },
          (l) => {
            console.log(`[security] ${l}`);
            scan.log.push(l);
          },
        )
        .then((result) => (doctorLast = { ok: true, name: result.name, at: new Date().toISOString() }))
        .catch((error) => (doctorLast = { ok: false, error: error.message, at: new Date().toISOString() }))
        .finally(() => (doctorScan = null));
      return sendJson(res, 202, { ok: true, started: true });
    }
    if (req.method === "POST" && p === "/api/security/ignore") {
      const { name, id } = await readBody(req);
      doctor.ignoreFinding(name, id);
      return sendJson(res, 200, { ok: true, report: doctor.readReport(name) });
    }

    if (req.method === "GET" && p === "/api/stream") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
      res.write(": connected\n\n");
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }
    if (req.method === "POST" && p === "/api/run") {
      await startRun(await readBody(req));
      return sendJson(res, 200, { ok: true, state: publicState() });
    }
    if (req.method === "POST" && p === "/api/stop") return sendJson(res, 200, { ok: stopRun() });

    // ── Settings page ──
    if (req.method === "GET" && p === "/api/settings") return sendJson(res, 200, settingsState());
    if (p === "/api/slack/connection" && (req.method === "PUT" || req.method === "DELETE")) {
      if (req.method === "DELETE") slack.saveConnection({}, { remove: true });
      else slack.saveConnection(await readBody(req));
      return sendJson(res, 200, settingsState());
    }
    if (req.method === "PUT" && p === "/api/slack/options") {
      slack.saveOptions(await readBody(req));
      return sendJson(res, 200, settingsState());
    }
    if (req.method === "POST" && p === "/api/slack/test") {
      try {
        return sendJson(res, 200, { ok: true, ...(await slack.sendTest()) });
      } catch (error) {
        return sendJson(res, 502, { ok: false, error: error.message });
      }
    }
    if (req.method === "POST" && p === "/api/slack/send") {
      const { slug } = await readBody(req);
      const addon = findAddon(slug);
      const entry = addon && readJson(historyFile(addon.slug), [])[0];
      if (!entry) return sendJson(res, 400, { ok: false, error: "That add-on has no finished run to send." });
      try {
        const result = await sendRunReport(addon, entry);
        if (!result) return sendJson(res, 400, { ok: false, error: "Slack is not set up yet." });
        return sendJson(res, 200, { ok: true, ...result, settings: settingsState() });
      } catch (error) {
        return sendJson(res, 502, { ok: false, error: error.message, settings: settingsState() });
      }
    }
    if (req.method === "PUT" && p === "/api/schedule") {
      schedule.update(await readBody(req), { validSlugs: ADDONS.filter((a) => a.spec).map((a) => a.slug) });
      return sendJson(res, 200, settingsState());
    }
    if (req.method === "POST" && p === "/api/refresh") {
      testCache.clear();
      return sendJson(res, 200, { ok: true });
    }
    const liveMatch = p.match(/^\/api\/live\/([a-z0-9-]+)\.jpg$/);
    if (req.method === "GET" && liveMatch) {
      return serveWithin(res, liveFile(liveMatch[1]), [path.join(ROOT, "data", "addons")], { "Cache-Control": "no-store" });
    }
    if (req.method === "GET" && p === "/api/file") {
      return serveWithin(res, url.searchParams.get("path") || "", [path.join(ROOT, "test-results")]);
    }
    if (req.method === "GET" && p.startsWith("/report")) {
      const rel = decodeURIComponent(p.replace(/^\/report\/?/, "")) || "index.html";
      return serveWithin(res, path.join(ROOT, "playwright-report", rel), [path.join(ROOT, "playwright-report")]);
    }
    res.writeHead(404);
    res.end("Not found");
  } catch (error) {
    sendJson(res, 400, { ok: false, error: error.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`WPTE add-on QA → http://localhost:${PORT}`);
  // NO_SCHEDULE=1: a second copy of the runner (another port, same folder)
  // must not fire the schedule too — data/schedule.json is shared.
  if (process.env.NO_SCHEDULE === "1") {
    console.log("⏰ Scheduled runs are off in this process (NO_SCHEDULE=1).");
  } else {
    schedule.startTimer((s) => startRun({ slug: s.slug, headed: s.headed, live: true, cleanup: s.cleanup, trigger: "schedule" }));
    const next = schedule.nextRun();
    if (next) console.log(`⏰ Next scheduled run: ${new Date(next).toLocaleString()}`);
  }
  for (const addon of ADDONS.filter((a) => a.spec)) listTests(addon);
});

process.on("SIGINT", () => {
  stopRun();
  process.exit(0);
});
