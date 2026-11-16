#!/usr/bin/env node
// scripts/doctor.js — WPTE Doctor: bug & security finder for WP Travel Engine
// and its add-ons.
//
//   npm run doctor -- --repo wptravelengine-accommodation          # code scan of a cloned add-on
//   npm run doctor -- --repo E:/code/wp-travel-engine               # any local plugin folder
//   npm run doctor -- --repo https://github.com/org/plugin.git      # clones it first
//   npm run doctor -- --site https://qa.example.com                 # live-site probes only
//   npm run doctor -- --repo <x> --site <url> --min high            # both, high+ only
//   --deps            also check composer/npm libraries against OSV.dev (known CVEs)
//   --fuzz            also fuzz the site's WP Travel Engine API (many malformed GET requests)
//
//   npm run doctor -- --url "https://site/?page_id=5&booking_id=101&redirect=/x"
//                     build detection payload URLs + curl for each parameter
//                     (--params a,b and --classes xss,sqli to narrow)
//   --user U --pass P also probe the site logged in as a Subscriber/customer
//                     (or set SECURITY_TEST_USER / SECURITY_TEST_PASSWORD in .env)
//
// Writes data/doctor/<target>/report.md (+ report.json). Each finding is a
// ready-to-file issue: severity, where, impact, steps to reproduce, fix.
// Finding IDs are stable across runs, so each report says which findings are
// new, still open, or fixed since the last run.
//
// Site probes are read-only GETs; only point them at sites you may test.

require("dotenv").config({ quiet: true });
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");
const { loadTree, indexFunctions } = require("./doctor/php");
const { runCodeRules } = require("./doctor/codeRules");
const { runSiteProbes } = require("./doctor/siteProbes");
const { runDepsCheck } = require("./doctor/deps");

const ROOT = path.resolve(__dirname, "..");
const SEVERITIES = ["critical", "high", "medium", "low", "info"];
const ICON = { critical: "🔴", high: "🟠", medium: "🟡", low: "🔵", info: "⚪" };

function parseArgs(argv) {
  const args = { min: "info" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--repo") args.repo = argv[++i];
    else if (a === "--site") args.site = argv[++i];
    else if (a === "--min") args.min = argv[++i];
    else if (a === "--name") args.name = argv[++i];
    else if (a === "--branch") args.branch = argv[++i];
    else if (a === "--deps") args.deps = true;
    else if (a === "--fuzz") args.fuzz = true;
    else if (a === "--url") args.url = argv[++i];
    else if (a === "--request") args.request = argv[++i];
    else if (a === "--params") args.params = argv[++i];
    else if (a === "--classes") args.classes = argv[++i];
    else if (a === "--user") args.user = argv[++i];
    else if (a === "--pass") args.pass = argv[++i];
    else if (a === "-h" || a === "--help") args.help = true;
  }
  return args;
}

/** Turns --repo into a local folder: existing path, add-on slug, or git URL (cloned). */
function resolveRepo(repo, branch) {
  if (fs.existsSync(repo)) return { dir: path.resolve(repo), name: path.basename(path.resolve(repo)) };
  const addonClone = path.join(ROOT, "data", "addons", repo, "repo");
  if (fs.existsSync(addonClone)) return { dir: addonClone, name: repo };
  if (/^(https?:|git@)/.test(repo)) {
    const name = path.basename(repo).replace(/\.git$/, "");
    const dir = path.join(ROOT, "data", "doctor", "repos", name);
    if (fs.existsSync(path.join(dir, ".git"))) {
      execFileSync("git", ["-C", dir, "pull", "--ff-only"], { stdio: "inherit" });
    } else {
      fs.mkdirSync(path.dirname(dir), { recursive: true });
      execFileSync("git", ["clone", "--depth", "1", ...(branch ? ["--branch", branch] : []), repo, dir], { stdio: "inherit" });
    }
    return { dir, name };
  }
  throw new Error(`--repo: not a folder, a known add-on slug or a git URL: ${repo}`);
}

function gitCommit(dir) {
  try {
    return execFileSync("git", ["-C", dir, "rev-parse", "--short", "HEAD"], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return "";
  }
}

/** Stable across runs: rule + file + the code itself (not the line number, which drifts). */
function fingerprint(f) {
  const basis = [f.rule, f.file || "", (f.snippet || "").replace(/\s+/g, " "), f.url ? f.url.replace(/wpteDoc\w+/, "") : "", f.file ? "" : f.title].join("|");
  return crypto.createHash("sha1").update(basis).digest("hex").slice(0, 8);
}

function renderFinding(f, n) {
  const where = f.file ? `\`${f.file}:${f.line}\`` : f.url ? `<${f.url}>` : "—";
  const lines = [
    `### ${n}. ${ICON[f.severity]} ${f.title}`,
    "",
    `**ID** \`DOC-${f.id}\` · **Severity** ${f.severity} · **Rule** \`${f.rule}\`${f.cwe ? ` · ${f.cwe}` : ""} · **Status** ${f.status}`,
    "",
    `**Where:** ${where}`,
  ];
  if (f.snippet) lines.push("", "```php", f.snippet, "```");
  lines.push("", f.detail);
  if (f.impact) lines.push("", `**Impact.** ${f.impact}`);
  if (f.repro?.length) lines.push("", "**Steps to reproduce.**", ...f.repro.map((s, i) => `${i + 1}. ${s}`));
  if (f.fix) lines.push("", `**Fix.** ${f.fix}`);
  lines.push("", "---", "");
  return lines.join("\n");
}

function renderReport(meta, findings, fixed) {
  const count = (s) => findings.filter((f) => f.severity === s).length;
  const head = [
    `# WPTE Doctor — ${meta.name}`,
    "",
    `- **Run:** ${meta.ranAt}`,
    meta.repo ? `- **Code:** \`${meta.repo}\`${meta.commit ? ` @ \`${meta.commit}\`` : ""} (${meta.phpFiles} PHP files)` : null,
    meta.site ? `- **Site:** ${meta.site} (read-only probes, not logged in)` : null,
    `- **Totals:** ${SEVERITIES.map((s) => `${ICON[s]} ${count(s)} ${s}`).join(" · ")}`,
    `- **Since last run:** ${findings.filter((f) => f.status === "new").length} new · ${findings.filter((f) => f.status === "open").length} still open · ${fixed.length} fixed`,
    "",
    "> Code findings are leads found by pattern-matching: confirm each on the QA site before filing.",
    "> A finding you've checked and dismissed can be listed in `data/doctor/<target>/ignore.json` by ID.",
    "",
    "| # | ID | Sev | Status | Finding | Where |",
    "| --- | --- | --- | --- | --- | --- |",
    ...findings.map((f, i) => `| ${i + 1} | DOC-${f.id} | ${ICON[f.severity]} ${f.severity} | ${f.status} | ${f.title.replace(/\|/g, "\\|")} | ${f.file ? `${f.file}:${f.line}` : f.url || ""} |`),
    "",
  ].filter((l) => l !== null);
  if (fixed.length) {
    head.push("## Fixed since last run", "", ...fixed.map((f) => `- ~~DOC-${f.id}~~ ${f.title} (${f.file ? `${f.file}:${f.line}` : f.url || ""})`), "");
  }
  head.push("## Findings", "", ...findings.map((f, i) => renderFinding(f, i + 1)));
  return head.join("\n");
}

const DOCTOR_DIR = path.join(ROOT, "data", "doctor");
const safeName = (name) => String(name).replace(/[^\w.-]+/g, "_");

/** Saved reports, newest first: [{ name, meta, counts }]. */
function listReports() {
  if (!fs.existsSync(DOCTOR_DIR)) return [];
  return fs
    .readdirSync(DOCTOR_DIR)
    .map((name) => {
      try {
        const r = JSON.parse(fs.readFileSync(path.join(DOCTOR_DIR, name, "report.json"), "utf8"));
        const counts = Object.fromEntries(SEVERITIES.map((s) => [s, r.findings.filter((f) => f.severity === s).length]));
        return { name, meta: r.meta, counts };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => String(b.meta.ranAt).localeCompare(String(a.meta.ranAt)));
}

function readReport(name) {
  const file = path.join(DOCTOR_DIR, safeName(name), "report.json");
  if (!fs.existsSync(file)) return null;
  const r = JSON.parse(fs.readFileSync(file, "utf8"));
  r.findings = r.findings.map((f) => ({ ...f, markdown: renderFinding(f, 1).replace(/^### 1\. /, "## ") }));
  r.ignored = readIgnore(name).length;
  return r;
}

function readIgnore(name) {
  try {
    return JSON.parse(fs.readFileSync(path.join(DOCTOR_DIR, safeName(name), "ignore.json"), "utf8"));
  } catch {
    return [];
  }
}

/** Marks a finding as "not a bug": hidden from this report and every later run. */
function ignoreFinding(name, id) {
  const dir = path.join(DOCTOR_DIR, safeName(name));
  const list = readIgnore(name);
  if (!list.includes(id)) list.push(id);
  fs.writeFileSync(path.join(dir, "ignore.json"), JSON.stringify(list, null, 2));
  const file = path.join(dir, "report.json");
  const r = JSON.parse(fs.readFileSync(file, "utf8"));
  r.findings = r.findings.filter((f) => f.id !== id);
  fs.writeFileSync(file, JSON.stringify(r, null, 2));
  fs.writeFileSync(path.join(dir, "report.md"), renderReport(r.meta, r.findings, r.fixed || []));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.url) {
    // Payload URL builder: print the table and exit (no scan, no report saved).
    const { buildUrlPayloads, toMarkdown } = require("./doctor/urlBuilder");
    console.log(toMarkdown(buildUrlPayloads(args.url, { params: args.params, classes: args.classes })));
    return;
  }
  if (args.request) {
    // Request-aware plan from a file holding a URL, curl command, or raw HTTP request.
    const { buildPlan, toMarkdown } = require("./doctor/requestBuilder");
    const text = fs.existsSync(args.request) ? fs.readFileSync(args.request, "utf8") : args.request;
    console.log(toMarkdown(buildPlan(text, { params: args.params, classes: args.classes })));
    return;
  }
  if (args.help || (!args.repo && !args.site)) {
    console.log(fs.readFileSync(__filename, "utf8").split("\n").slice(1, 21).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
    process.exit(args.help ? 0 : 1);
  }
  const { findings, outDir } = await runDoctor(args);
  console.log("");
  for (const s of SEVERITIES) {
    const n = findings.filter((f) => f.severity === s).length;
    if (n) console.log(`  ${ICON[s]} ${s.padEnd(8)} ${n}`);
  }
  console.log(`\n📄 ${path.relative(ROOT, path.join(outDir, "report.md"))}`);
  // Non-zero exit when critical/high findings exist, so CI can gate on it.
  process.exitCode = findings.some((f) => f.severity === "critical" || f.severity === "high") ? 2 : 0;
}

/** Runs a scan ({ repo?, site?, min?, name?, branch? }) and saves it. Used by the CLI and the UI. */
async function runDoctor(args, log = console.log) {
  args = { min: "info", ...args };
  if (!args.repo && !args.site) throw new Error("Choose code to scan, a site to probe, or both.");
  const minIdx = SEVERITIES.indexOf(args.min);
  if (minIdx === -1) throw new Error(`--min must be one of ${SEVERITIES.join(", ")}`);

  const meta = { ranAt: new Date().toISOString() };
  let findings = [];

  if (args.repo) {
    const { dir, name } = resolveRepo(args.repo, args.branch);
    meta.repo = path.relative(ROOT, dir).replace(/\\/g, "/") || dir;
    meta.name = name;
    meta.commit = gitCommit(dir);
    meta.repoUrl = repoWebUrl(dir);
    log(`🔎 Scanning code: ${dir}`);
    const files = loadTree(dir);
    meta.phpFiles = files.length;
    const found = runCodeRules({ files, fnIndex: indexFunctions(files), dir });
    log(`  → ${found.length} candidate finding(s) in ${files.length} PHP files`);
    findings.push(...found);
    if (args.deps) {
      log("📦 Checking libraries against OSV.dev");
      try {
        findings.push(...(await runDepsCheck(dir, log)));
      } catch (error) {
        log(`  ⚠ dependency check failed: ${error.message}`);
      }
    }
  }
  if (args.site) {
    meta.site = args.site.replace(/\/$/, "");
    if (!/^https?:\/\//.test(meta.site)) throw new Error("Site must start with http:// or https://");
    meta.name = meta.name ? `${meta.name}+${new URL(meta.site).hostname}` : new URL(meta.site).hostname;
    log(`🌐 Probing site: ${meta.site}`);
    const user = args.user || process.env.SECURITY_TEST_USER;
    const pass = args.pass || process.env.SECURITY_TEST_PASSWORD;
    if (user && pass) meta.loggedInAs = user;
    if (args.fuzz) meta.fuzzed = true;
    findings.push(...(await runSiteProbes(meta.site, log, { user, pass, fuzz: !!args.fuzz })));
  }
  if (args.name) meta.name = args.name;

  const outDir = path.join(DOCTOR_DIR, safeName(meta.name));
  fs.mkdirSync(outDir, { recursive: true });
  const prevFile = path.join(outDir, "report.json");
  const prev = fs.existsSync(prevFile) ? JSON.parse(fs.readFileSync(prevFile, "utf8")) : null;
  const ignore = new Set(fs.existsSync(path.join(outDir, "ignore.json")) ? JSON.parse(fs.readFileSync(path.join(outDir, "ignore.json"), "utf8")) : []);

  // De-duplicate, assign stable IDs, drop ignored and below --min.
  const byId = new Map();
  for (const f of findings) {
    f.id = fingerprint(f);
    if (!byId.has(f.id)) byId.set(f.id, f);
  }
  const prevIds = new Set((prev?.findings || []).map((f) => f.id));
  findings = [...byId.values()]
    .filter((f) => !ignore.has(f.id) && !ignore.has(`DOC-${f.id}`))
    .filter((f) => SEVERITIES.indexOf(f.severity) <= minIdx)
    .map((f) => ({ ...f, status: prev ? (prevIds.has(f.id) ? "open" : "new") : "new" }))
    .sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity) || String(a.file).localeCompare(String(b.file)) || a.line - b.line);

  // "Fixed" only when this run covered the same kind of target as last time.
  const nowIds = new Set(byId.keys());
  const fixed = (prev?.findings || []).filter((f) => !nowIds.has(f.id) && ((f.file && meta.repo) || (!f.file && meta.site)));

  fs.writeFileSync(prevFile, JSON.stringify({ meta, findings, fixed }, null, 2));
  const mdFile = path.join(outDir, "report.md");
  fs.writeFileSync(mdFile, renderReport(meta, findings, fixed));
  return { meta, findings, fixed, outDir, name: path.basename(outDir) };
}

/** GitHub web URL of a clone's origin, for file:line links; "" if none. */
function repoWebUrl(dir) {
  try {
    const url = execFileSync("git", ["-C", dir, "remote", "get-url", "origin"], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    return url.replace(/^git@github\.com:/, "https://github.com/").replace(/\.git$/, "");
  } catch {
    return "";
  }
}

/** Records a filed GitHub issue onto a finding in a saved report. */
function recordIssue(name, id, issue) {
  const file = path.join(DOCTOR_DIR, safeName(name), "report.json");
  const r = JSON.parse(fs.readFileSync(file, "utf8"));
  const f = r.findings.find((x) => x.id === id);
  if (f) f.issue = { number: issue.number, url: issue.url };
  fs.writeFileSync(file, JSON.stringify(r, null, 2));
  return readReport(name);
}

module.exports = { runDoctor, listReports, readReport, ignoreFinding, recordIssue, SEVERITIES };

if (require.main === module) {
  main().catch((error) => {
    console.error(`✖ ${error.message}`);
    process.exit(1);
  });
}
