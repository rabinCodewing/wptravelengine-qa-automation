#!/usr/bin/env node
// scripts/qaReport.js — helper for an add-on's curated QA Report
// (data/addons/<slug>/qa-report.json). Used by the addon-bug-report skill.
//
//   node scripts/qaReport.js validate <slug>   check fields + that every scanPattern still matches the cloned repo
//   node scripts/qaReport.js drafts   <slug>   write issue drafts (exact title/body/repo) to data/addons/<slug>/issue-drafts/
//   node scripts/qaReport.js sync     <slug>   READ GitHub and mark findings already filed (by DOC-<id> tag or title)
//   node scripts/qaReport.js status   <slug>   one line per finding: id, status, severity, filed/not filed
//
// Never creates, edits or closes a GitHub issue. Filing stays a human click in
// the runner UI (npm run ui › QA Report › File issue › File to GitHub).

const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env"), quiet: true });

const { ADDONS } = require("../config/addons");
const github = require("./doctor/github");
const { buildReport, reportFindingForIssue, matchIssues, saveIssueLinks } = require("./repoAudit");

const ROOT = path.resolve(__dirname, "..");
const [, , cmd, slug] = process.argv;

function addonOrDie() {
  const addon = ADDONS.find((a) => a.slug === slug);
  if (!addon) die(`Unknown add-on "${slug}". Slugs: ${ADDONS.filter((a) => a.report).map((a) => a.slug).join(", ")}`);
  if (!addon.report) die(`${slug} has no "report" in config/addons.js — add one first (see addon-qa skill, step 4).`);
  return addon;
}
function die(msg) {
  console.error(`✘ ${msg}`);
  process.exit(1);
}

const REQUIRED = ["id", "title", "severity", "status", "category", "location", "impact", "steps", "fix"];
const SEVERITIES = ["critical", "high", "medium", "low", "info"];
const STATUSES = ["confirmed", "unverified"];

async function validate(addon) {
  const report = JSON.parse(fs.readFileSync(path.join(ROOT, addon.report), "utf8"));
  const repoDir = path.join(ROOT, "data", "addons", addon.slug, "repo");
  const ids = new Set();
  let problems = 0;
  const warn = (id, msg) => { problems++; console.log(`  ✘ ${id}: ${msg}`); };

  for (const f of report.findings || []) {
    for (const k of REQUIRED) if (f[k] === undefined || f[k] === "" || (Array.isArray(f[k]) && !f[k].length)) warn(f.id, `missing "${k}"`);
    if (ids.has(f.id)) warn(f.id, "duplicate id");
    ids.add(f.id);
    if (!SEVERITIES.includes(f.severity)) warn(f.id, `severity "${f.severity}" not in ${SEVERITIES.join("/")}`);
    if (!STATUSES.includes(f.status)) warn(f.id, `status "${f.status}" not in ${STATUSES.join("/")}`);
    if (f.status === "confirmed" && !f.evidence) warn(f.id, "confirmed without evidence (what you saw on the QA site)");
    if (f.status === "confirmed" && !f.userExperience?.length) warn(f.id, "confirmed without userExperience");
    if (String(f.title).length > 90) warn(f.id, `title is ${f.title.length} chars — the issue title is cut at 90`);
    if ((f.steps || []).some((s) => /\b(PUT|POST|GET)\s+\/|wp-json|curl\b|stub|route\(/i.test(s))) warn(f.id, "steps mention REST/curl/stubs — write them as UI clicks (see the skill)");
    if (!f.scanPattern) warn(f.id, "no scanPattern — Re-scan can't tell if it's still in the source");
    else if (fs.existsSync(repoDir)) {
      const re = new RegExp(f.scanPattern);
      const hit = (f.location || []).find((l) => {
        const file = path.join(repoDir, l.file);
        return fs.existsSync(file) && fs.readFileSync(file, "utf8").split(/\r?\n/).some((line) => re.test(line));
      });
      if (!hit) warn(f.id, `scanPattern does not match any location file (${(f.location || []).map((l) => l.file).join(", ")})`);
    }
  }
  if (!fs.existsSync(repoDir)) console.log(`  ℹ ${repoDir} not cloned — scanPatterns not checked (run Re-scan repo or clone it).`);
  console.log(problems ? `✘ ${problems} problem(s) in ${addon.report}` : `✓ ${addon.report}: ${(report.findings || []).length} findings look good`);
  if (problems) process.exitCode = 1;
}

async function drafts(addon) {
  const report = await buildReport(addon, { doScan: false });
  const dir = path.join(ROOT, "data", "addons", addon.slug, "issue-drafts");
  fs.mkdirSync(dir, { recursive: true });
  for (const old of fs.readdirSync(dir)) if (old.endsWith(".md")) fs.rmSync(path.join(dir, old));
  const meta = { name: addon.name, repo: report.repoUrl || report.repo, commit: report.commit };
  const todo = (report.findings || []).filter((f) => f.status === "confirmed" && !f.issue);
  for (const f of todo) {
    const p = github.previewIssue(reportFindingForIssue(f), meta, { repo: addon.bugRepo });
    fs.writeFileSync(path.join(dir, `${f.id}.md`), `<!-- will be filed to: ${p.repo} -->\n# ${p.title}\n\n${p.body}\n`);
    console.log(`  ${f.id} → ${p.repo}\n     ${p.title}`);
  }
  console.log(todo.length ? `✓ ${todo.length} draft(s) in ${path.relative(ROOT, dir)} — nothing was sent` : "✓ No confirmed, unfiled findings — no drafts to write");
}

async function sync(addon) {
  const repo = addon.bugRepo || github.loadConfig().repo;
  if (!repo) die("No bugRepo for this add-on and no global repo configured.");
  const issues = await github.listIssues(repo);
  const report = await buildReport(addon, { doScan: false });
  const byNumber = new Map(issues.map((i) => [i.number, i]));
  const matched = matchIssues((report.findings || []).filter((f) => !f.issue), issues);
  const links = {};
  const now = new Date().toISOString();
  for (const f of report.findings || []) {
    if (f.issue) {
      const live = byNumber.get(Number(f.issue.number));
      if (live) links[f.id] = { ...f.issue, url: live.url, state: live.state, title: live.title, closedAt: live.closedAt || null, syncedAt: now };
    } else if (matched[f.id]) {
      const i = matched[f.id];
      links[f.id] = { number: i.number, url: i.url, state: i.state, title: i.title, closedAt: i.closedAt || null, source: "github", linkedAt: now, syncedAt: now };
      console.log(`  + ${f.id} is already on GitHub as #${i.number} (${i.state})`);
    }
  }
  saveIssueLinks(addon.slug, links, { issuesSyncedAt: now });
  console.log(`✓ Read ${issues.length} issues from ${repo} (read-only); ${Object.keys(matched).length} newly linked`);
}

async function status(addon) {
  const report = await buildReport(addon, { doScan: false });
  for (const f of report.findings || []) {
    const filed = f.issue ? `#${f.issue.number} ${f.issue.state || "open"}` : f.status === "confirmed" ? "NOT FILED" : "-";
    console.log(`  ${f.id.padEnd(8)} ${String(f.status).padEnd(11)} ${String(f.severity).padEnd(8)} ${filed.padEnd(12)} ${f.title}`);
  }
  console.log(`  files to: ${addon.bugRepo || github.loadConfig().repo || "(none)"}`);
}

const COMMANDS = { validate, drafts, sync, status };
if (!COMMANDS[cmd] || !slug) die(`Usage: node scripts/qaReport.js <${Object.keys(COMMANDS).join("|")}> <addon-slug>`);
COMMANDS[cmd](addonOrDie()).catch((e) => die(e.message));
