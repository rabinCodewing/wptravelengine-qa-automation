// scripts/doctor/requestBuilder.js
//
// Request-aware payload planner. You paste a real request — a plain URL, a curl
// command (DevTools → Copy as cURL), or a raw HTTP request (Burp) — and it
// produces a test plan where EACH generated request changes ONE payload in ONE
// parameter, with everything else (other params, body fields, nonce, cookies)
// left normal. Query params become clickable URLs; body fields (form or JSON)
// become curl commands with the right encoding and headers.
//
// Detection only, authorized targets only. For SQLi it stops at "a quote causes
// a DB error"; it never extracts data.

const { PAYLOADS } = require("./payloads");

const GROUPS = Object.fromEntries(PAYLOADS.map((g) => [g.id, g]));
const CLASS_ORDER = ["traversal", "sqli", "ssrf", "xss", "redirect", "template", "email", "boundaries"];
const CLASS_TITLE = Object.fromEntries(PAYLOADS.map((g) => [g.id, g.title]));
CLASS_TITLE.boundaries = "Negative / boundary values";

const NUMERIC_NAME = /(^|_|\b)(id|qty|quantity|count|num|amount|price|total|cost|subtotal|travell?ers?|pax|adult|child|infant|seat|date|deposit|discount|fee|tax|year|month|day)(_|\b|$)/i;

// The boundary block the spec mandates for every numeric / price / date field.
const BOUNDARIES = [
  { p: "-1", note: "negative value" },
  { p: "0", note: "zero" },
  { p: "0.5", note: "fractional where only whole numbers make sense" },
  { p: "99999999999", note: "very large (overbooking / overflow)" },
  { p: "1e309", note: "beyond float range → Infinity in some code" },
  { p: "2026-13-45", note: "impossible date" },
  { p: "A".repeat(5000), label: "A … (5,000 chars)", note: "very long input" },
  { p: "", label: "(empty)", note: "empty value" },
];
const BOUNDARY_SAFE = "Rejected (validation error / 400); the total never drops or goes negative.";
const BOUNDARY_VULN = "Accepted, or the price/total changes to match your value, or the booking goes through.";

function safeVuln(group) {
  const m = /Safe:\s*(.*?)\s*Vulnerable:\s*(.*)$/s.exec(group.lookFor || "");
  return m ? { safe: m[1].replace(/\.$/, ""), vulnerable: m[2].replace(/\.$/, "") } : { safe: group.lookFor || "", vulnerable: "" };
}

function classesForParam(name) {
  const n = String(name).toLowerCase();
  const set = new Set(["xss", "sqli", "template"]);
  if (/(redirect|return|returnto|next|dest|destination|continue|goto|callback|url|uri|link)/.test(n)) set.add("redirect");
  if (/(url|uri|src|link|feed|ical|webhook|image|img|remote|fetch|proxy|load)/.test(n)) set.add("ssrf");
  if (/(file|path|template|tpl|page|download|doc|include|view|dir|folder)/.test(n)) set.add("traversal");
  if (/(e?mail|from|to|sender|reply)/.test(n)) set.add("email");
  if (NUMERIC_NAME.test(n)) set.add("boundaries");
  return set;
}

// ── Parse a pasted request ───────────────────────────────────────────────────

function parseRequest(text) {
  text = String(text || "").trim();
  if (!text) throw new Error("Paste a URL, a curl command, or a raw HTTP request.");
  if (/^curl\b/.test(text)) return parseCurl(text);
  if (/^(GET|POST|PUT|PATCH|DELETE)\s+\S+\s+HTTP\//i.test(text)) return parseRaw(text);
  if (/^https?:\/\//i.test(text)) return { method: "GET", url: text, headers: {}, body: null, bodyType: "none" };
  throw new Error("Unrecognised. Paste a full URL (https://…), a curl command, or a raw HTTP request (starts with e.g. POST /… HTTP/1.1).");
}

/** Splits a shell-ish string into tokens, honouring single and double quotes. */
function shellTokens(s) {
  const out = [];
  const re = /'([^']*)'|"((?:[^"\\]|\\.)*)"|(\S+)/g;
  let m;
  while ((m = re.exec(s))) out.push(m[1] ?? (m[2] != null ? m[2].replace(/\\(.)/g, "$1") : m[3]));
  return out;
}

function parseCurl(text) {
  const t = shellTokens(text.replace(/\\\r?\n/g, " "));
  const req = { method: null, url: null, headers: {}, body: null, bodyType: "none" };
  const form = [];
  for (let i = 1; i < t.length; i++) {
    const a = t[i];
    if (a === "-X" || a === "--request") req.method = t[++i];
    else if (a === "-H" || a === "--header") {
      const h = t[++i] || "";
      const idx = h.indexOf(":");
      if (idx > -1) req.headers[h.slice(0, idx).trim()] = h.slice(idx + 1).trim();
    } else if (a === "-b" || a === "--cookie") req.headers["Cookie"] = t[++i];
    else if (a === "--data-urlencode") {
      form.push(t[++i]);
    } else if (a === "-d" || a === "--data" || a === "--data-raw" || a === "--data-binary" || a === "--data-ascii") {
      req.body = (req.body ? req.body + "&" : "") + t[++i];
    } else if (a === "-G" || a === "--get") req.method = "GET";
    else if (/^https?:\/\//.test(a)) req.url = a;
    else if (!a.startsWith("-") && !req.url) req.url = a;
  }
  if (form.length) req.body = form.join("&");
  if (!req.url) throw new Error("No URL found in that curl command.");
  if (!req.method) req.method = req.body ? "POST" : "GET";
  req.bodyType = detectBodyType(req);
  return req;
}

function parseRaw(text) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const [method, path] = lines[0].split(/\s+/);
  const headers = {};
  let i = 1;
  for (; i < lines.length; i++) {
    if (lines[i].trim() === "") { i++; break; }
    const idx = lines[i].indexOf(":");
    if (idx > -1) headers[lines[i].slice(0, idx).trim()] = lines[i].slice(idx + 1).trim();
  }
  const body = lines.slice(i).join("\n").trim() || null;
  const host = headers["Host"] || headers["host"];
  if (!host) throw new Error("Raw request has no Host header, so the full URL can't be built.");
  const scheme = /^(443|https)/.test(headers["X-Forwarded-Proto"] || "") ? "https" : "https";
  const req = { method: method.toUpperCase(), url: `${scheme}://${host}${path}`, headers, body, bodyType: "none" };
  req.bodyType = detectBodyType(req);
  return req;
}

function detectBodyType(req) {
  if (!req.body) return "none";
  const ct = req.headers["Content-Type"] || req.headers["content-type"] || "";
  if (/application\/json/i.test(ct)) return "json";
  if (/^\s*[[{]/.test(req.body)) return "json";
  return "form";
}

// ── Flatten body into addressable fields ─────────────────────────────────────

function formPairs(body) {
  return body.split("&").filter(Boolean).map((p) => {
    const i = p.indexOf("=");
    return i === -1 ? [p, ""] : [decodeURIComponent(p.slice(0, i)), decodeURIComponent(p.slice(i + 1).replace(/\+/g, " "))];
  });
}

/** Leaf paths of a JSON value: [{ path, value }]. */
function jsonLeaves(value, prefix = "") {
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([k, v]) => jsonLeaves(v, prefix ? `${prefix}.${k}` : k));
  }
  return [{ path: prefix, value }];
}

function setJsonPath(obj, path, value) {
  const keys = path.split(".");
  let node = obj;
  for (let i = 0; i < keys.length - 1; i++) node = node[keys[i]];
  node[keys[keys.length - 1]] = value;
}

// ── Build the plan ───────────────────────────────────────────────────────────

const encc = (s) => encodeURIComponent(s);
const q = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;

function curlFor(req, { urlOverride, bodyOverride } = {}) {
  const parts = ["curl -s -i"];
  if (req.method !== "GET") parts.push(`-X ${req.method}`);
  parts.push(q(urlOverride || req.url));
  for (const [k, v] of Object.entries(req.headers)) parts.push(`-H ${q(`${k}: ${v}`)}`);
  const body = bodyOverride != null ? bodyOverride : req.body;
  if (body != null && req.method !== "GET") parts.push(`--data-raw ${q(body)}`);
  return parts.join(" ");
}

function queryUrl(url, targetKey, payload) {
  const u = new URL(url);
  const pairs = [...u.searchParams.entries()];
  if (!pairs.some(([k]) => k === targetKey)) pairs.push([targetKey, ""]);
  const query = pairs.map(([k, v]) => `${encc(k)}=${k === targetKey ? encc(payload) : encc(v)}`).join("&");
  return `${u.origin}${u.pathname}${query ? "?" + query : ""}${u.hash || ""}`;
}

function formBodyWith(pairs, targetKey, payload) {
  return pairs.map(([k, v]) => `${encc(k)}=${k === targetKey ? encc(payload) : encc(v)}`).join("&");
}

/** Which classes to emit for a field, honouring the user's focus. */
function classesFor(name, onlyClasses, isNumeric) {
  let set = classesForParam(name);
  if (isNumeric) set.add("boundaries");
  if (onlyClasses) set = new Set([...set].filter((c) => onlyClasses.includes(c)));
  return set;
}

function rowsForClass(cls) {
  if (cls === "boundaries") return { title: CLASS_TITLE.boundaries, safe: BOUNDARY_SAFE, vulnerable: BOUNDARY_VULN, items: BOUNDARIES };
  const g = GROUPS[cls];
  if (!g) return null;
  return { title: g.title, ...safeVuln(g), items: g.items };
}

function buildPlan(requestText, { params, classes } = {}) {
  const req = parseRequest(requestText);
  const want = (v) => (Array.isArray(v) ? v : typeof v === "string" && v.trim() ? v.split(/[,\s]+/).filter(Boolean) : null);
  const onlyParams = want(params);
  const onlyClasses = want(classes);

  const u = new URL(req.url);
  const queryKeys = [...u.searchParams.keys()];
  let bodyPairs = [];
  let bodyObj = null;
  let bodyLeaves = [];
  if (req.bodyType === "form") bodyPairs = formPairs(req.body);
  else if (req.bodyType === "json") {
    try { bodyObj = JSON.parse(req.body); bodyLeaves = jsonLeaves(bodyObj); } catch { throw new Error("Body looks like JSON but doesn't parse."); }
  }

  // Candidate fields: query keys + body fields, with where they live.
  const fields = [
    ...queryKeys.map((name) => ({ name, loc: "query" })),
    ...bodyPairs.map(([name]) => ({ name, loc: "form" })),
    ...bodyLeaves.map((l) => ({ name: l.path, loc: "json", value: l.value })),
  ];
  const targets = onlyParams ? fields.filter((f) => onlyParams.includes(f.name)) : fields;
  if (!targets.length) throw new Error(onlyParams ? "None of those parameters are in the request." : "No parameters found to fuzz (no query string and no body fields).");

  const byClass = new Map();
  const add = (cls, row) => { (byClass.get(cls) || byClass.set(cls, []).get(cls)).push(row); };

  for (const f of targets) {
    const isNumeric = NUMERIC_NAME.test(f.name) || (f.loc === "json" && typeof f.value === "number");
    for (const cls of classesFor(f.name, onlyClasses, isNumeric)) {
      const spec = rowsForClass(cls);
      if (!spec) continue;
      for (const item of spec.items) {
        const payload = item.p;
        let request, method, url;
        if (f.loc === "query") {
          url = queryUrl(req.url, f.name, payload);
          method = req.method;
          request = req.method === "GET" && req.bodyType === "none" ? url : curlFor(req, { urlOverride: url });
        } else if (f.loc === "form") {
          method = req.method;
          request = curlFor(req, { bodyOverride: formBodyWith(bodyPairs, f.name, payload) });
        } else {
          // JSON: numbers stay numbers for boundary tests where sensible.
          const clone = JSON.parse(JSON.stringify(bodyObj));
          let v = payload;
          if (cls === "boundaries" && payload !== "" && /^-?\d+(\.\d+)?(e\d+)?$/i.test(payload)) v = Number(payload);
          setJsonPath(clone, f.name, v);
          method = req.method;
          request = curlFor(req, { bodyOverride: JSON.stringify(clone) });
        }
        add(cls, {
          param: f.name,
          loc: f.loc,
          cls,
          title: spec.title,
          payload,
          label: item.label || null,
          encoded: f.loc === "json" ? JSON.stringify(payload) : encc(payload),
          note: item.note,
          method,
          url: f.loc === "query" && method === "GET" && req.bodyType === "none" ? url : null,
          request,
          safe: spec.safe,
          vulnerable: spec.vulnerable,
        });
      }
    }
  }

  const groups = CLASS_ORDER.filter((c) => byClass.has(c)).map((c) => ({ cls: c, title: CLASS_TITLE[c], rows: byClass.get(c) }));
  return {
    method: req.method,
    url: req.url,
    bodyType: req.bodyType,
    hasAuth: !!(req.headers["Cookie"] || req.headers["X-WP-Nonce"] || req.headers["x-wp-nonce"]),
    params: targets.map((f) => `${f.name}${f.loc === "query" ? "" : ` (${f.loc})`}`),
    groups,
    watch: WATCH,
    generatedAt: new Date().toISOString(),
  };
}

const WATCH = [
  "Status code — a 500 or a sudden 200-where-you-expected-403 is a red flag.",
  "Response length vs the normal request — a big jump/drop means your input changed the output.",
  "Response time — a long delay on a quote/sleep-style input hints at time-based SQLi.",
  "Reflected input — is your payload in the response unescaped (real <tag>, not &lt;tag&gt;)?",
  "Error strings — 'SQL syntax', 'mysqli', PHP 'Warning/Fatal', stack traces, file paths.",
  "Booking/total — for boundary tests, did the price or total actually change or go negative?",
];

function toMarkdown(plan) {
  const lines = [
    `# Payload test plan — ${plan.method} ${plan.url}`,
    "",
    "> Authorized / own targets only. Detection only — stop at proof-of-reachability (for SQLi, a quote causing a DB error is enough; never extract data).",
    plan.hasAuth ? "> This plan includes your session cookie/nonce in the curl commands — don't share it publicly." : "",
    "",
    `One variable changes per request. Parameters: ${plan.params.map((p) => `\`${p}\``).join(", ")}.`,
    "",
  ].filter(Boolean);
  for (const g of plan.groups) {
    lines.push(`## ${g.title}`, "", "| Param | Payload | Encoded | Request | Safe vs Vulnerable |", "| --- | --- | --- | --- | --- |");
    for (const r of g.rows) {
      const req = r.url ? `<${r.url}>` : `\`${r.request}\``;
      lines.push(`| \`${r.param}\` | \`${(r.label || r.payload).replace(/\|/g, "\\|").slice(0, 60)}\` | \`${r.encoded.slice(0, 40)}\` | ${req} | ✅ ${r.safe} / ⚠️ ${r.vulnerable} |`);
    }
    lines.push("");
  }
  lines.push("## What to watch in the response", "", ...plan.watch.map((w) => `- ${w}`), "");
  return lines.join("\n");
}

module.exports = { parseRequest, buildPlan, toMarkdown };
