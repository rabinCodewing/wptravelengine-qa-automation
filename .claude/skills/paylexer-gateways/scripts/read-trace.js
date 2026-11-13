#!/usr/bin/env node
// Summarises a Playwright trace.zip into what a person needs to debug a
// gateway's payment step — without the trace viewer, and without reading a
// 100+ MB file by hand (an agent that tries gets lost in it).
//
//   node .claude/skills/paylexer-gateways/scripts/read-trace.js <trace.zip> [--last 40] [--grep <regex>]
//
// Prints:
//   1. Actions   the last N things the run DID: goto, click, fill, type, press,
//                select — with selector and value, and the error if one failed
//   2. Probes    every selector the run CHECKED (count / visible / enabled /
//                waitFor), how many times, and what it got back — a selector
//                that returned 0 every time was looking in the wrong place
//   3. Failed    calls that ended in an error
//   4. Pages     the URLs the browser had frames on, most active first
//
// --grep keeps only selectors/URLs matching a regex (e.g. --grep "card|cvv|pay").
// Reads only the *.trace event files out of the zip, with Node's own zlib — no
// unzip or tar needed (Git Bash's tar cannot open zips), nothing written to disk.

const fs = require("fs");
const zlib = require("zlib");

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};
const zip = args.find((a, i) => !a.startsWith("--") && !["--last", "--grep"].includes(args[i - 1]));
const LAST = Number(opt("--last", 40));
const GREP = opt("--grep", null) ? new RegExp(opt("--grep"), "i") : null;

if (args.includes("--help") || args.includes("-h")) {
  console.log(
    [
      "Usage: read-trace.js <path/to/trace.zip> [--last 40] [--grep <regex>]",
      "  --last N     how many of the run's last actions to list (default 40)",
      '  --grep RE    only selectors / URLs matching RE, e.g. --grep "card|cvv|pay"',
    ].join("\n"),
  );
  process.exit(0);
}

if (!zip || !fs.existsSync(zip)) {
  console.error("Usage: read-trace.js <path/to/trace.zip> [--last 40] [--grep <regex>]");
  process.exit(1);
}

/** The *.trace entries of a zip, as text. Plain zip (no zip64) — what Playwright writes. */
function traceEntries(file) {
  const buf = fs.readFileSync(file);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 70000); i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) throw new Error("not a zip file (no end-of-central-directory record)");

  const total = buf.readUInt16LE(eocd + 10);
  let at = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let n = 0; n < total; n += 1) {
    if (buf.readUInt32LE(at) !== 0x02014b50) break;
    const method = buf.readUInt16LE(at + 10);
    const size = buf.readUInt32LE(at + 20);
    const nameLen = buf.readUInt16LE(at + 28);
    const extraLen = buf.readUInt16LE(at + 30);
    const commentLen = buf.readUInt16LE(at + 32);
    const local = buf.readUInt32LE(at + 42);
    const name = buf.toString("utf8", at + 46, at + 46 + nameLen);
    at += 46 + nameLen + extraLen + commentLen;
    if (!name.endsWith(".trace") || name === "test.trace") continue;

    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + size);
    out.push(method === 8 ? zlib.inflateRawSync(data).toString("utf8") : data.toString("utf8"));
  }
  return out;
}

const ACTION = /^(goto|click|dblclick|fill|type|pressSequentially|press|selectOption|check|uncheck|setInputFiles|tap)$/;
const PROBE = /^(queryCount|isVisible|isEnabled|isHidden|waitForSelector|inputValue|textContent|innerText|getAttribute)$/;
const short = (text, n) => (String(text).length > n ? `${String(text).slice(0, n)}…` : String(text));
const keep = (text) => !GREP || GREP.test(text || "");

try {
  const texts = traceEntries(zip);
  if (!texts.length) throw new Error("no *.trace files inside the zip");

  const before = new Map();
  const actions = [];
  const probes = new Map();
  const failed = [];
  const frames = new Map();

  for (const text of texts) {
    for (const line of text.split("\n")) {
      if (!line) continue;
      let e;
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }

      if (e.type === "frame-snapshot" && e.snapshot?.frameUrl) {
        const url = e.snapshot.frameUrl.split("?")[0];
        frames.set(url, (frames.get(url) || 0) + 1);
        continue;
      }
      if (e.type === "before") {
        before.set(e.callId, e);
        continue;
      }
      if (e.type !== "after") continue;

      const b = before.get(e.callId);
      if (!b) continue;
      const p = b.params || {};
      const selector = p.selector || p.url || "";
      const error = e.error?.message || e.error?.error?.message || "";
      const result = error ? `ERROR ${short(error.split("\n")[0], 90)}` : JSON.stringify(e.result?.value ?? e.result ?? "");

      if (ACTION.test(b.method)) {
        if (!keep(selector)) continue;
        const value = p.text ?? p.value ?? p.key ?? (p.options ? JSON.stringify(p.options) : "");
        const shown = value !== "" && value !== undefined ? `  ← ${short(JSON.stringify(value), 40)}` : "";
        const err = error ? `\n${" ".repeat(18)}✗ ${short(error.split("\n")[0], 140)}` : "";
        actions.push({ t: b.startTime, line: `${b.method.padEnd(17)} ${short(selector, 110)}${shown}${err}` });
      } else if (PROBE.test(b.method) && selector) {
        if (!keep(selector)) continue;
        // Positions (nth=3) folded together: a loop over matches is one probe.
        const key = `${b.method} ${short(selector.replace(/ >> nth=\d+/g, ""), 120)}`;
        const entry = probes.get(key) || { count: 0, results: new Set() };
        entry.count += 1;
        if (entry.results.size < 4) entry.results.add(short(result, 40));
        probes.set(key, entry);
      }
      if (error && !PROBE.test(b.method) && keep(selector)) {
        failed.push(`${b.method} ${short(selector, 100)} → ${short(error.split("\n")[0], 160)}`);
      }
    }
  }

  actions.sort((a, b) => a.t - b.t);
  console.log(`== Actions (last ${Math.min(LAST, actions.length)} of ${actions.length})`);
  for (const a of actions.slice(-LAST)) console.log(a.line);

  console.log("\n== Probes (selector checked → results; most frequent first)");
  [...probes.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 40)
    .forEach(([key, v]) => console.log(`${String(v.count).padStart(5)}× ${key} → ${[...v.results].join(" | ")}`));

  console.log(`\n== Failed calls (${failed.length})`);
  for (const f of [...new Set(failed)].slice(-15)) console.log(f);

  console.log("\n== Pages and frames (by snapshot count)");
  [...frames.entries()]
    .filter(([url]) => keep(url))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .forEach(([url, n]) => console.log(`${String(n).padStart(6)}  ${short(url, 120)}`));
} catch (error) {
  console.error(`Could not read ${zip}: ${error.message}`);
  process.exitCode = 1;
}
