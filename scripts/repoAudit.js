// scripts/repoAudit.js
//
// Looks into an add-on's GitHub repository and returns a QA report the UI can
// render: the curated findings (data/addons/<slug>/qa-report.json) with each
// finding's code location re-located in the live source, plus a handful of
// generic heuristic checks that flag common WP issues directly from the repo.
//
// A clone lives under data/addons/<slug>/repo/. `scan` shallow-clones it the
// first time and `git pull`s on later runs, so the report tracks the real repo.

const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const addonDir = (slug) => path.join(ROOT, "data", "addons", slug);
const reportFile = (slug) => path.join(addonDir(slug), "qa-report.json");
const repoDir = (slug) => path.join(addonDir(slug), "repo");
const scanMetaFile = (slug) => path.join(addonDir(slug), "qa-scan.json");

function git(args, cwd) {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) =>
      err ? reject(new Error((stderr || err.message).toString().trim())) : resolve(stdout.toString().trim()),
    );
  });
}

/** Shallow clone, or pull if it already exists. Returns { commit, branch }. */
async function syncRepo(slug, repoUrl, branch = "main") {
  const dir = repoDir(slug);
  if (fs.existsSync(path.join(dir, ".git"))) {
    await git(["fetch", "--depth", "1", "origin", branch], dir).catch(() => {});
    await git(["reset", "--hard", `origin/${branch}`], dir).catch(() => {});
  } else {
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    fs.rmSync(dir, { recursive: true, force: true });
    await git(["clone", "--depth", "1", "--branch", branch, repoUrl, dir]);
  }
  const commit = await git(["rev-parse", "--short", "HEAD"], dir).catch(() => "");
  return { commit, branch };
}

/** Finds the 1-based line of the first regex match in a file; 0 if none. */
function findLine(file, pattern) {
  if (!pattern || !fs.existsSync(file)) return 0;
  const re = new RegExp(pattern);
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) if (re.test(lines[i])) return i + 1;
  return 0;
}

/** Re-locates one curated finding in the cloned repo and marks if it still matches. */
function relocate(dir, finding) {
  if (!finding.scanPattern) return { ...finding, present: null };
  for (const loc of finding.location || []) {
    const abs = path.join(dir, loc.file);
    const line = findLine(abs, finding.scanPattern);
    if (line) return { ...finding, present: true, matchedAt: { file: loc.file, line } };
  }
  return { ...finding, present: false };
}

// Generic, repo-wide heuristics. Each returns candidate rows {file,line,text}.
const HEURISTICS = [
  {
    id: "client-price",
    label: "Price read from request (possible pricing-integrity gap)",
    glob: /\.php$/,
    re: /floatval\(\s*\$\w+\[['"](?:actual_price|price|total)['"]\]/,
  },
  {
    id: "commented-capacity",
    label: "Commented-out code mentioning seats/availability",
    glob: /\.php$/,
    re: /\/\/.*(available_seats|seats_booked|available_count|sold_out)/,
  },
  {
    id: "unescaped-output",
    label: "Output escaping suppressed (EscapeOutput.OutputNotEscaped)",
    glob: /\.php$/,
    re: /OutputNotEscaped/,
  },
];

function walk(dir, globRe, acc = [], base = dir) {
  for (const name of fs.readdirSync(dir)) {
    if (name === ".git" || name === "node_modules" || name === "vendor" || name === "dist") continue;
    const abs = path.join(dir, name);
    const stat = fs.statSync(abs);
    if (stat.isDirectory()) walk(abs, globRe, acc, base);
    else if (globRe.test(name)) acc.push(abs);
  }
  return acc;
}

function runHeuristics(dir) {
  const out = [];
  for (const h of HEURISTICS) {
    const hits = [];
    for (const file of walk(dir, h.glob)) {
      const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (h.re.test(lines[i])) hits.push({ file: path.relative(dir, file).replace(/\\/g, "/"), line: i + 1, text: lines[i].trim().slice(0, 160) });
      }
    }
    out.push({ id: h.id, label: h.label, count: hits.length, hits: hits.slice(0, 25) });
  }
  return out;
}

/** The report the UI reads. `doScan` controls whether the repo is synced + scanned. */
async function buildReport(addon, { doScan = false } = {}) {
  const slug = addon.slug;
  const curated = JSON.parse(fs.readFileSync(reportFile(slug), "utf8"));
  const result = { ...curated, repoUrl: addon.repo || curated.repo, scan: null };

  if (!doScan) {
    result.scan = (() => {
      try {
        return JSON.parse(fs.readFileSync(scanMetaFile(slug), "utf8"));
      } catch {
        return null;
      }
    })();
    return result;
  }

  if (!addon.repo && !curated.repo) throw new Error("No repository is configured for this add-on.");
  const repoUrl = addon.repo || curated.repo;
  const { commit, branch } = await syncRepo(slug, repoUrl, curated.branch || "main");
  const dir = repoDir(slug);

  result.commit = commit;
  result.branch = branch;
  result.findings = (curated.findings || []).map((f) => relocate(dir, f));
  const scan = {
    scannedAt: new Date().toISOString(),
    commit,
    branch,
    repoUrl,
    confirmedStillPresent: result.findings.filter((f) => f.present === true).length,
    findingsTotal: result.findings.length,
    heuristics: runHeuristics(dir),
  };
  result.scan = scan;
  fs.writeFileSync(scanMetaFile(slug), JSON.stringify(scan, null, 2));
  // Persist the re-located findings so a plain GET reflects the last scan.
  fs.writeFileSync(reportFile(slug), JSON.stringify({ ...curated, commit, findings: result.findings }, null, 2));
  return result;
}

module.exports = { buildReport, syncRepo };
