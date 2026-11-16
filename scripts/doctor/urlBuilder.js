// scripts/doctor/urlBuilder.js
//
// Turns a target URL into ready-to-fire detection requests: for each query
// parameter and each relevant vulnerability class, a clean clickable URL (the
// payload correctly encoded into that ONE parameter, every other left normal)
// plus the matching curl command. Detection only — proof-of-reachability, never
// data extraction.
//
// Authorized use only: run these against sites you own or may test.
//
// Classes that live in a form body rather than the query string (email header
// injection, boundary/price values) are emitted as `curl --data-urlencode`
// POST requests, with a note, because a GET URL wouldn't reach them.

const { PAYLOADS } = require("./payloads");

const GROUPS = Object.fromEntries(PAYLOADS.map((g) => [g.id, g]));
const POST_CLASSES = new Set(["email", "boundaries", "csv"]);
// Most impactful first.
const CLASS_ORDER = ["sqli", "traversal", "ssrf", "xss", "redirect", "template", "email", "boundaries", "csv"];

/** Short "safe" / "vulnerable" lines, split out of a group's lookFor text. */
function safeVuln(group) {
  const m = /Safe:\s*(.*?)\s*Vulnerable:\s*(.*)$/s.exec(group.lookFor || "");
  return m ? { safe: m[1].replace(/\.$/, ""), vulnerable: m[2].replace(/\.$/, "") } : { safe: group.lookFor || "", vulnerable: "" };
}

/** Classes worth trying on a parameter, from its name. */
function classesForParam(name) {
  const n = String(name).toLowerCase();
  const set = new Set(["xss", "sqli", "template"]); // worth a try on almost any text/number param
  if (/(redirect|return|returnto|next|dest|destination|continue|goto|callback|url|uri|link)/.test(n)) set.add("redirect");
  if (/(url|uri|src|link|feed|ical|webhook|image|img|remote|fetch|proxy|load)/.test(n)) set.add("ssrf");
  if (/(file|path|template|tpl|page|download|doc|include|view|dir|folder)/.test(n)) set.add("traversal");
  if (/(id|qty|quantity|count|num|amount|price|total|cost|travell?er|pax|adult|child|infant|seat|date|deposit|discount)/.test(n)) set.add("boundaries");
  if (/(e?mail|from|to|sender|reply|name)/.test(n)) set.add("email");
  return set;
}

function parseTarget(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`Not a valid URL: ${url}. Include the scheme, e.g. https://…`);
  }
  if (!/^https?:$/.test(u.protocol)) throw new Error("URL must start with http:// or https://");
  return { u, base: `${u.origin}${u.pathname}`, pairs: [...u.searchParams.entries()], hash: u.hash || "" };
}

/** Rebuilds the query URL with `payload` encoded into `targetParam`, others as-is. */
function urlWith(parsed, targetParam, payload) {
  const query = parsed.pairs
    .map(([k, v]) => `${encodeURIComponent(k)}=${k === targetParam ? encodeURIComponent(payload) : encodeURIComponent(v)}`)
    .join("&");
  return `${parsed.base}?${query}${parsed.hash}`;
}

function getCurl(url) {
  return `curl -s -i '${url.replace(/'/g, "'\\''")}'`;
}

function postCurl(base, param, payload) {
  return `curl -s -i -X POST '${base.replace(/'/g, "'\\''")}' --data-urlencode '${param.replace(/'/g, "'\\''")}=${payload.replace(/'/g, "'\\''")}'`;
}

/**
 * buildUrlPayloads(targetUrl, { params, classes })
 *   params  — array/comma-string of parameter names to target (default: all in the URL)
 *   classes — array/comma-string of class ids to include (default: all relevant)
 */
function buildUrlPayloads(targetUrl, { params, classes } = {}) {
  const parsed = parseTarget(targetUrl);
  const want = (v) => (Array.isArray(v) ? v : typeof v === "string" && v.trim() ? v.split(/[,\s]+/).filter(Boolean) : null);
  const onlyParams = want(params);
  const onlyClasses = want(classes);

  const targetParams = onlyParams || parsed.pairs.map(([k]) => k);
  const notes = [];
  if (!parsed.pairs.length) notes.push("This URL has no query parameters. Only the form-body (POST) payloads below apply — point them at the request your form/AJAX actually sends.");

  // class id -> rows
  const byClass = new Map();
  const addRow = (cls, row) => {
    if (!byClass.has(cls)) byClass.set(cls, []);
    byClass.get(cls).push(row);
  };

  // GET classes need a parameter in the query string.
  for (const param of targetParams) {
    if (!parsed.pairs.some(([k]) => k === param)) {
      // Allow a named param that isn't in the URL yet: append it so the URL still works.
      parsed.pairs.push([param, ""]);
    }
    let cls = classesForParam(param);
    if (onlyClasses) cls = new Set([...cls].filter((c) => onlyClasses.includes(c)).concat(onlyClasses.filter((c) => GROUPS[c])));
    for (const c of cls) {
      const group = GROUPS[c];
      if (!group) continue;
      const sv = safeVuln(group);
      for (const item of group.items) {
        const isPost = POST_CLASSES.has(c);
        addRow(c, {
          cls: c,
          title: group.title,
          param,
          payload: item.p,
          label: item.label || null,
          note: item.note,
          method: isPost ? "POST" : "GET",
          url: isPost ? null : urlWith(parsed, param, item.p),
          curl: isPost ? postCurl(parsed.base, param, item.p) : getCurl(urlWith(parsed, param, item.p)),
          safe: sv.safe,
          vulnerable: sv.vulnerable,
        });
      }
    }
  }

  const groups = CLASS_ORDER.filter((c) => byClass.has(c)).map((c) => ({ cls: c, title: GROUPS[c].title, rows: byClass.get(c) }));
  if (groups.some((g) => g.rows.some((r) => r.method === "POST"))) {
    notes.push("POST rows: a GET URL can't reach a form/AJAX field. In Burp, intercept the real request (booking → admin-ajax.php?action=wte_add_trip_to_cart, checkout, or the admin save), send it to Repeater, and put the payload in that one field — the curl shown is the shape to copy.");
  }
  return { target: targetUrl, params: targetParams, groups, notes, generatedAt: new Date().toISOString() };
}

/** Markdown table version, for the CLI and for copy-all. */
function toMarkdown(result) {
  const lines = [
    `# Payload URLs for ${result.target}`,
    "",
    "> Authorized testing of your own / permitted targets only. Detection only — stop at proof-of-reachability.",
    "",
  ];
  for (const g of result.groups) {
    lines.push(`## ${g.title}`, "", "| Param | Payload | Request | Safe vs Vulnerable |", "| --- | --- | --- | --- |");
    for (const r of g.rows) {
      const req = r.method === "GET" ? `<${r.url}>` : `\`${r.curl}\` (POST)`;
      lines.push(`| \`${r.param}\` | \`${(r.label || r.payload).replace(/\|/g, "\\|")}\` | ${req} | ✅ ${r.safe} / ⚠️ ${r.vulnerable} |`);
    }
    lines.push("");
  }
  if (result.notes.length) lines.push("## Notes", "", ...result.notes.map((n) => `- ${n}`), "");
  return lines.join("\n");
}

module.exports = { buildUrlPayloads, toMarkdown };
