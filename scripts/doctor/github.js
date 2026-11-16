// scripts/doctor/github.js
//
// One-click "file this finding as a GitHub issue" for the Security UI.
// Uses the installed, authenticated GitHub CLI (`gh`). Config (the target repo
// + labels) is stored in data/doctor/github.json. Created issues are recorded
// back onto the finding in report.json so the UI shows "Filed #n" and never
// files the same finding twice.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");

const ROOT = path.resolve(__dirname, "..", "..");
const CONFIG_FILE = path.join(ROOT, "data", "doctor", "github.json");
const DEFAULT_LABELS = ["security", "qa-bug"];

// ── Finding the gh binary (it's often not on PATH on Windows) ────────────────
let cachedGh = null;
function ghCandidates() {
  const home = os.homedir();
  return [
    process.env.GH_PATH,
    "gh",
    path.join(home, "AppData", "Local", "Programs", "GitHubCLI", "bin", "gh.exe"),
    "C:/Program Files/GitHub CLI/gh.exe",
    "C:/Program Files (x86)/GitHub CLI/gh.exe",
    "/usr/bin/gh",
    "/usr/local/bin/gh",
    "/opt/homebrew/bin/gh",
  ].filter(Boolean);
}
function run(bin, args, { input } = {}) {
  return new Promise((resolve) => {
    const child = execFile(bin, args, { maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) =>
      resolve({ ok: !err, code: err?.code ?? 0, stdout: String(stdout || ""), stderr: String(stderr || err?.message || "") }),
    );
    if (input != null) {
      child.stdin.end(input);
    }
  });
}
/** Resolves (and caches) a working gh binary path, or null. */
async function resolveGh() {
  if (cachedGh) return cachedGh;
  for (const bin of ghCandidates()) {
    const r = await run(bin, ["--version"]);
    if (r.ok && /gh version/i.test(r.stdout)) {
      cachedGh = bin;
      return bin;
    }
  }
  return null;
}

// ── Config ───────────────────────────────────────────────────────────────────
function loadConfig() {
  try {
    return { labels: DEFAULT_LABELS, ...JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")) };
  } catch {
    return { repo: "", labels: DEFAULT_LABELS };
  }
}
function saveConfig(patch) {
  const cfg = { ...loadConfig(), ...patch };
  cfg.repo = String(cfg.repo || "").trim();
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
  return cfg;
}

// ── Status / access check ────────────────────────────────────────────────────
/** gh availability, auth account, and whether the configured repo is writable. */
async function status() {
  const gh = await resolveGh();
  const cfg = loadConfig();
  if (!gh) return { gh: false, installed: false, authed: false, account: null, repo: cfg.repo, labels: cfg.labels, repoOk: false, message: "GitHub CLI (gh) not found. Install it, or set GH_PATH." };

  const auth = await run(gh, ["auth", "status"]);
  const account = (auth.stderr.match(/account (\S+)/i) || auth.stdout.match(/account (\S+)/i) || [])[1] || null;
  const authed = /Logged in to/i.test(auth.stderr + auth.stdout);

  let repoOk = false;
  let repoMessage = "";
  if (authed && cfg.repo) {
    // viewer permission tells us whether this account can open issues.
    const view = await run(gh, ["repo", "view", cfg.repo, "--json", "viewerPermission,hasIssuesEnabled,nameWithOwner"]);
    if (view.ok) {
      try {
        const j = JSON.parse(view.stdout);
        const perm = j.viewerPermission || "";
        const canWrite = ["ADMIN", "MAINTAIN", "WRITE", "TRIAGE"].includes(perm);
        repoOk = canWrite && j.hasIssuesEnabled !== false;
        repoMessage = !j.hasIssuesEnabled ? "Issues are disabled on this repo." : !canWrite ? `Your access is ${perm || "read-only"} — can't create issues.` : `OK (${perm}).`;
      } catch {
        repoMessage = "Could not read repo permissions.";
      }
    } else {
      repoMessage = /Could not resolve/i.test(view.stderr) ? "No access to that repo (or it doesn't exist)." : view.stderr.split("\n")[0];
    }
  }
  return { gh: true, installed: true, authed, account, repo: cfg.repo, labels: cfg.labels, repoOk, message: repoMessage };
}

// ── Filing ───────────────────────────────────────────────────────────────────
const ICON = { critical: "Critical", high: "High", medium: "Medium", low: "Low", info: "Info" };

function issueTitle(f) {
  const where = f.file ? `${f.file.split("/").pop()}:${f.line}` : f.url ? new URL(f.url).pathname : "";
  const base = String(f.title || f.rule).replace(/[`*]/g, "").slice(0, 90);
  return `[QA][${ICON[f.severity] || f.severity}] ${base}${where ? ` (${where})` : ""} (DOC-${f.id})`;
}
function issueBody(f, meta) {
  // Prefer the ready-made markdown readReport() attaches; fall back to fields.
  const body =
    f.markdown ||
    [`**Severity** ${f.severity} · **Rule** \`${f.rule}\`${f.cwe ? ` · ${f.cwe}` : ""}`, "", f.detail || "", f.impact ? `\n**Impact.** ${f.impact}` : "", f.repro?.length ? `\n**Steps**\n${f.repro.map((s, i) => `${i + 1}. ${s}`).join("\n")}` : "", f.fix ? `\n**Fix.** ${f.fix}` : ""].join("\n");
  const src = meta?.repo ? `Code: \`${meta.repo}\`${meta.commit ? ` @ \`${meta.commit}\`` : ""}` : meta?.site ? `Site: ${meta.site}` : "";
  return `${body}\n\n---\n_Filed from WPTE Doctor (${meta?.name || "scan"}). ${src} · finding \`DOC-${f.id}\`._`;
}

/** Finds an existing issue for this finding's DOC id. Returns {number,url} or null. */
async function findExisting(gh, repo, id) {
  const r = await run(gh, ["issue", "list", "-R", repo, "--search", `DOC-${id} in:title,body`, "--state", "all", "--json", "number,url,title", "--limit", "5"]);
  if (!r.ok) return null;
  try {
    const hit = JSON.parse(r.stdout).find((i) => i.title.includes(`DOC-${id}`) || i.title.includes(id));
    return hit ? { number: hit.number, url: hit.url } : null;
  } catch {
    return null;
  }
}

/**
 * Files one finding as an issue (idempotent): if an issue with this DOC id
 * already exists it's returned instead of creating a duplicate.
 * Returns { number, url, existed }.
 */
async function fileIssue(finding, meta, opts = {}) {
  const gh = await resolveGh();
  if (!gh) throw new Error("GitHub CLI (gh) not found.");
  const cfg = loadConfig();
  const repo = opts.repo || cfg.repo; // per-add-on override, else the global target
  if (!repo) throw new Error("No target repo set. Configure it in the GitHub panel first.");

  const existing = await findExisting(gh, repo, finding.id);
  if (existing) return { ...existing, existed: true };

  const title = issueTitle(finding);
  const body = issueBody(finding, meta);
  const labelArgs = (cfg.labels || []).flatMap((l) => ["--label", l]);

  // Try with labels; if the repo lacks them, gh errors — retry label-free.
  let r = await run(gh, ["issue", "create", "-R", repo, "--title", title, "--body-file", "-", ...labelArgs], { input: body });
  if (!r.ok && /label|not found/i.test(r.stderr)) {
    r = await run(gh, ["issue", "create", "-R", repo, "--title", title, "--body-file", "-"], { input: body });
  }
  if (!r.ok) throw new Error(r.stderr.split("\n").filter(Boolean).slice(-1)[0] || "gh issue create failed");

  const url = (r.stdout.match(/https?:\/\/\S+\/issues\/\d+/) || [])[0] || r.stdout.trim();
  const number = Number((url.match(/\/issues\/(\d+)/) || [])[1]) || null;
  return { number, url, existed: false };
}

module.exports = { resolveGh, status, loadConfig, saveConfig, fileIssue };
