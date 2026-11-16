// scripts/doctor/deps.js
//
// "Using components with known vulnerabilities" (OWASP A06): reads the
// plugin's composer.lock and package-lock.json / yarn.lock and asks the public
// OSV.dev database (Google's open vulnerability DB, which includes GitHub
// advisories) whether any shipped library version has a known vulnerability.
//
// Sends only package names + versions to api.osv.dev. Dev-only packages
// (build tools that never ship in the plugin zip) are skipped.

const fs = require("fs");
const path = require("path");

function composerPackages(dir) {
  const file = path.join(dir, "composer.lock");
  if (!fs.existsSync(file)) return [];
  const lock = JSON.parse(fs.readFileSync(file, "utf8"));
  return (lock.packages || []).map((p) => ({ name: p.name, version: String(p.version).replace(/^v/, ""), ecosystem: "Packagist", from: "composer.lock" }));
}

function npmPackages(dir) {
  const file = path.join(dir, "package-lock.json");
  if (fs.existsSync(file)) {
    const lock = JSON.parse(fs.readFileSync(file, "utf8"));
    if (lock.packages) {
      return Object.entries(lock.packages)
        .filter(([p, v]) => p && !v.dev && !v.devOptional && v.version)
        .map(([p, v]) => ({ name: p.split("node_modules/").pop(), version: v.version, ecosystem: "npm", from: "package-lock.json" }));
    }
    return Object.entries(lock.dependencies || {})
      .filter(([, v]) => !v.dev)
      .map(([name, v]) => ({ name, version: v.version, ecosystem: "npm", from: "package-lock.json" }));
  }
  return [];
}

const SEV_MAP = { CRITICAL: "critical", HIGH: "high", MODERATE: "medium", MEDIUM: "medium", LOW: "low" };

async function postJson(url, body) {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return res.json();
}

async function runDepsCheck(dir, log = console.log) {
  const pkgs = [...composerPackages(dir), ...npmPackages(dir)];
  // De-duplicate name@version.
  const uniq = [...new Map(pkgs.map((p) => [`${p.ecosystem}:${p.name}@${p.version}`, p])).values()];
  log(`  ${uniq.length} shipped package(s) found in lock files`);
  if (!uniq.length) return [];

  const hits = [];
  for (let i = 0; i < uniq.length; i += 500) {
    const chunk = uniq.slice(i, i + 500);
    const r = await postJson("https://api.osv.dev/v1/querybatch", { queries: chunk.map((p) => ({ package: { name: p.name, ecosystem: p.ecosystem }, version: p.version })) });
    (r.results || []).forEach((res, k) => (res.vulns || []).forEach((v) => hits.push({ pkg: chunk[k], id: v.id })));
  }
  log(`  ${hits.length} known vulnerabilit${hits.length === 1 ? "y" : "ies"}`);

  const out = [];
  for (const h of hits.slice(0, 60)) {
    let v = {};
    try {
      v = await (await fetch(`https://api.osv.dev/v1/vulns/${encodeURIComponent(h.id)}`)).json();
    } catch {}
    const sev = SEV_MAP[String(v.database_specific?.severity || "").toUpperCase()] || "medium";
    const fixed = (v.affected || [])
      .filter((a) => a.package?.name === h.pkg.name)
      .flatMap((a) => (a.ranges || []).flatMap((r) => (r.events || []).filter((e) => e.fixed).map((e) => e.fixed)));
    const aliases = (v.aliases || []).filter((a) => /^CVE-/.test(a));
    out.push({
      rule: "vulnerable-dependency",
      severity: sev,
      title: `${h.pkg.name} ${h.pkg.version} has a known vulnerability: ${v.summary || h.id}`,
      file: h.pkg.from,
      line: 1,
      // The advisory ID is part of the snippet so each advisory keeps its own stable finding ID.
      snippet: `${h.pkg.name}@${h.pkg.version}  ${h.id}`,
      detail: `${h.id}${aliases.length ? ` (${aliases.join(", ")})` : ""}. ${(v.details || "").split("\n")[0].slice(0, 400)}\nAdvisory: https://osv.dev/vulnerability/${h.id}`,
      impact: "The plugin ships a library with a published vulnerability. Check whether the plugin uses the affected part.",
      repro: ["Open the advisory link and read which function/feature is affected.", "Search the plugin for where it uses that library feature.", "If it's reachable, follow the advisory's proof of concept on the QA site."],
      fix: fixed.length ? `Upgrade ${h.pkg.name} to ${[...new Set(fixed)].join(" / ")} or later.` : `No fixed version listed; replace ${h.pkg.name} or confirm the vulnerable part isn't used.`,
      cwe: "CWE-1395",
    });
  }
  return out;
}

module.exports = { runDepsCheck };
