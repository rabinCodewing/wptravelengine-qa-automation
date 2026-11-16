// scripts/doctor/siteProbes.js
//
// Read-only checks against a running WordPress + WP Travel Engine site, made
// as a visitor who isn't logged in (no cookies). They only send GET requests
// (plus HEAD for files), so they are safe to run against the QA site at any
// time. Writes such as POSTing to AJAX actions are not done here; the code
// findings carry the steps for a tester to try those by hand.
//
// Only point this at sites you own or are authorised to test.

const WTE_NS = /^(wptravelengine|wp-travel-engine|wte|wp-travel|paylexer)/i;
const SENSITIVE_KEYS = /(email|phone|billing|traveller|traveler|customer|passport|address|payment|transaction|card|booking|order|due|paid|user_login|ip_address)/i;
const SECRET_VALUE = /\b(sk_(live|test)_[0-9a-zA-Z]{10,}|rk_(live|test)_[0-9a-zA-Z]{10,}|whsec_[0-9a-zA-Z]{10,}|FLWSECK[_-]\w+|sk_[0-9a-f]{32,}|AKIA[0-9A-Z]{16}|-----BEGIN (RSA )?PRIVATE KEY-----)/;
const SECRET_KEY = /(secret|private_key|api_key|apikey|access_token|client_secret|webhook_secret|password|passphrase|signature_key|hmac)/i;

// PHP warnings/fatals seen in any response during a run (path disclosure).
const PHP_ERROR = /(?:<b>)?(Warning|Fatal error|Parse error|Notice|Deprecated|Uncaught \w*Exception)(?:<\/b>)?:\s[^<\n]{0,200}?\sin\s(?:<b>)?([^<\n]+\.php)(?:<\/b>)?\s+on line/;
let phpErrors = [];
// Requests that got no answer at all (timeout / connection error) during a run.
// A run with many of these says nothing about the site, so it isn't saved.
const net = { total: 0, failed: 0 };

async function get(url, { method = "GET", timeout = 30000, headers = {}, body } = {}) {
  net.total++;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { method, body, redirect: "manual", signal: ctrl.signal, headers: { "User-Agent": "wpte-doctor/1.0 (QA)", ...headers } });
    const text = method === "HEAD" ? "" : await res.text();
    const pe = PHP_ERROR.exec(text);
    if (pe && phpErrors.length < 20) phpErrors.push({ url, kind: pe[1], file: pe[2] });
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: res.status, headers: res.headers, text, json };
  } catch (error) {
    net.failed++;
    return { status: 0, error: error.name === "AbortError" ? "timeout" : error.message, text: "", json: null };
  } finally {
    clearTimeout(t);
  }
}

/** Walks a JSON value, yielding [path, key, value] for every leaf. */
function* leaves(value, p = "") {
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) yield* leaves(v, p ? `${p}.${k}` : k);
  } else {
    yield [p, p.split(".").pop(), value];
  }
}

function inspectJson(json) {
  const secrets = [];
  const sensitive = new Set();
  let count = 0;
  for (const [p, key, value] of leaves(json)) {
    if (count++ > 20000) break;
    const str = value == null ? "" : String(value);
    if (SECRET_VALUE.test(str)) secrets.push(`${p} = ${str.slice(0, 12)}…`);
    else if (SECRET_KEY.test(key) && str.length >= 8 && !/^(true|false|null|0|1)$/.test(str)) secrets.push(`${p} = ${str.slice(0, 4)}… (${str.length} chars)`);
    // Settings flags (allow_shared_room_bookings: true) aren't personal data.
    const isFlag = typeof value === "boolean" || /^(allow|enable|enabled|disable|is|has|show|hide|use|can)_/i.test(key) || /^(yes|no|on|off)$/i.test(str);
    if (SENSITIVE_KEYS.test(key) && str && !isFlag) sensitive.add(p.replace(/\.\d+\./g, ".*.").replace(/^\d+\./, "*."));
  }
  return { secrets, sensitive: [...sensitive].slice(0, 15) };
}

function probeFinding(base) {
  return { file: null, line: null, snippet: null, ...base };
}

/** Swaps route params for sample values: (?P<id>\d+) → 1. */
function fillRoute(route, id = "1") {
  return route.replace(/\(\?P<(\w+)>[^)]*\)/g, (_, name) => (/id$/i.test(name) ? id : "1"));
}

async function restExposure(site, log) {
  const out = [];
  const index = await get(`${site}/wp-json/`);
  if (!index.json || !index.json.routes) {
    log(`  REST index unavailable (${index.status || index.error})`);
    return out;
  }
  const routes = Object.entries(index.json.routes).filter(([r, def]) => {
    const ns = (def.namespace || r.split("/")[1] || "").replace(/^\//, "");
    return WTE_NS.test(ns) && (def.methods || []).includes("GET");
  });
  log(`  ${routes.length} WP Travel Engine GET routes found`);

  // A real trip id makes /trips/{id}/… routes return something meaningful.
  const trips = await get(`${site}/wp-json/wp/v2/trip?per_page=1&_fields=id`);
  const tripId = Array.isArray(trips.json) && trips.json[0]?.id ? String(trips.json[0].id) : "1";

  for (const [route] of routes) {
    const url = `${site}/wp-json${fillRoute(route, tripId)}`;
    const res = await get(url);
    if (res.status !== 200 || res.json == null) continue;
    const isEmpty = Array.isArray(res.json) ? res.json.length === 0 : typeof res.json === "object" && Object.keys(res.json).length === 0;
    if (isEmpty) continue;
    const { secrets, sensitive } = inspectJson(res.json);
    const looksPrivate = /(setting|booking|customer|payment|enquir|inquir|traveller|traveler|report|export|log|user|email|coupon|order)/i.test(route);
    if (secrets.length) {
      out.push(
        probeFinding({
          rule: "rest-leaks-secret",
          severity: "critical",
          title: `\`${route}\` returns what looks like a secret to visitors who aren't logged in`,
          detail: `GET ${url} → 200 with no login. Values that look like secrets:\n${secrets.slice(0, 8).map((s) => `- \`${s}\``).join("\n")}`,
          impact: "Gateway/API secrets exposed: refunds, charges or account takeover at the payment provider.",
          repro: [`Open a private window (not logged in).`, `Visit ${url}`, "Search the JSON for the keys listed."],
          fix: "Require manage_options in permission_callback and never return secret fields from the API (mask them).",
          cwe: "CWE-200",
          url,
        }),
      );
    } else if (sensitive.length || looksPrivate) {
      out.push(
        probeFinding({
          rule: "rest-anon-data",
          severity: sensitive.length ? "high" : "low",
          title: `\`${route}\` returns data to visitors who aren't logged in${sensitive.length ? " (personal or booking fields)" : ""}`,
          detail: `GET ${url} → 200 without login.${sensitive.length ? `\nFields that look personal or financial:\n${sensitive.map((s) => `- \`${s}\``).join("\n")}` : " The route name suggests private data; check what's in the response."}`,
          impact: sensitive.length ? "Personal or booking data exposed (GDPR-relevant)." : "Possible information exposure.",
          repro: ["Open a private window (not logged in).", `Visit ${url}`, "Check whether a visitor should see this."],
          fix: "Tighten permission_callback, or remove private fields in the response for users who aren't logged in.",
          cwe: "CWE-200",
          url,
        }),
      );
    }
  }
  return out;
}

async function userEnumeration(site) {
  const res = await get(`${site}/wp-json/wp/v2/users?per_page=100&_fields=id,slug,name`);
  if (res.status === 200 && Array.isArray(res.json) && res.json.length) {
    return [
      probeFinding({
        rule: "user-enumeration",
        severity: "low",
        title: "Usernames can be listed through /wp-json/wp/v2/users",
        detail: `GET /wp-json/wp/v2/users returns ${res.json.length} user(s) to visitors who aren't logged in: ${res.json.slice(0, 5).map((u) => `\`${u.slug}\``).join(", ")}…`,
        impact: "Gives attackers valid login names for password guessing.",
        repro: [`Visit ${site}/wp-json/wp/v2/users without logging in.`],
        fix: "Fine on many sites (authors are public). If not wanted, hide the endpoint from visitors with a security plugin or a rest_endpoints filter.",
        cwe: "CWE-203",
        url: `${site}/wp-json/wp/v2/users`,
      }),
    ];
  }
  return [];
}

const EXPOSED_FILES = [
  { p: "/.git/HEAD", rule: "git-exposed", sev: "critical", title: "The .git folder is downloadable (full source + history)", must: /^ref:\s/m },
  { p: "/wp-config.php.save", rule: "config-backup-exposed", sev: "critical", title: "wp-config backup (.save) is downloadable", must: /DB_PASSWORD/ },
  { p: "/wp-config.php.old", rule: "config-backup-exposed", sev: "critical", title: "wp-config backup (.old) is downloadable", must: /DB_PASSWORD/ },
  { p: "/wp-config.txt", rule: "config-backup-exposed", sev: "critical", title: "wp-config copy (.txt) is downloadable", must: /DB_PASSWORD/ },
  { p: "/phpinfo.php", rule: "phpinfo-exposed", sev: "medium", title: "phpinfo() page is public", must: /PHP Version/ },
  { p: "/info.php", rule: "phpinfo-exposed", sev: "medium", title: "phpinfo() page is public", must: /PHP Version/ },
  { p: "/error_log", rule: "error-log-exposed", sev: "high", title: "error_log file is publicly downloadable", must: /PHP (Notice|Warning|Fatal)/ },
  { p: "/wp-content/uploads/wc-logs/", rule: "dir-listing", sev: "medium", title: "Directory listing on a logs folder", must: /Index of/i },
  { p: "/wp-includes/", rule: "dir-listing", sev: "low", title: "Directory listing on /wp-includes/", must: /Index of/i },
  { p: "/wp-content/debug.log", rule: "debug-log-exposed", sev: "high", title: "debug.log is publicly downloadable", must: /PHP (Notice|Warning|Fatal|Deprecated)|\[\d{2}-\w{3}-\d{4}/ },
  { p: "/.env", rule: "env-exposed", sev: "critical", title: ".env file is publicly downloadable", must: /^[A-Z_]+=/m },
  { p: "/wp-config.php.bak", rule: "config-backup-exposed", sev: "critical", title: "wp-config backup is downloadable", must: /DB_PASSWORD/ },
  { p: "/wp-config.php~", rule: "config-backup-exposed", sev: "critical", title: "wp-config editor backup is downloadable", must: /DB_PASSWORD/ },
  { p: "/wp-content/uploads/wp-travel-engine/", rule: "dir-listing", sev: "medium", title: "Directory listing on the WP Travel Engine uploads folder", must: /Index of/i },
  { p: "/wp-content/uploads/wte-booking-export/", rule: "dir-listing", sev: "medium", title: "Directory listing on the booking export folder", must: /Index of/i },
  { p: "/wp-content/uploads/", rule: "dir-listing", sev: "low", title: "Directory listing on /wp-content/uploads/", must: /Index of/i },
  { p: "/wp-content/plugins/wp-travel-engine/", rule: "dir-listing", sev: "low", title: "Directory listing on the WP Travel Engine plugin folder", must: /Index of/i },
];

async function exposedFiles(site) {
  const out = [];
  for (const f of EXPOSED_FILES) {
    const res = await get(site + f.p);
    if (res.status === 200 && f.must.test(res.text)) {
      out.push(
        probeFinding({
          rule: f.rule,
          severity: f.sev,
          title: f.title,
          detail: `GET ${site + f.p} → 200.`,
          impact: "Leaks paths, settings, customer data or credentials.",
          repro: [`Open ${site + f.p} in a private window.`],
          fix: "Block it in the web server config (or delete the file); turn off directory indexes (`Options -Indexes`); set WP_DEBUG_LOG to a path outside the web root.",
          cwe: "CWE-538",
          url: site + f.p,
        }),
      );
    }
  }
  return out;
}

async function reflectedXss(site) {
  const marker = `wpteDoc${Date.now().toString(36)}`;
  const payload = `"><${marker}>`;
  const enc = encodeURIComponent(payload);
  // Front-end URLs that print query args. Extra WTE search params are added
  // because the trip search/archive templates echo them back into filters.
  const targets = [
    `/?s=${enc}`,
    `/?s=${enc}&post_type=trip`,
    `/trip/?destination=${enc}`,
    `/trip-search-result/?search=${enc}&destination=${enc}&activities=${enc}&trip_types=${enc}&min-cost=${enc}&max-cost=${enc}`,
    `/?wte_search=${enc}`,
    `/checkout/?booking_id=${enc}`,
    `/thank-you/?booking_id=${enc}&payment_key=${enc}`,
  ];
  const out = [];
  for (const t of targets) {
    const res = await get(site + t);
    if (res.status === 200 && res.text.includes(`<${marker}>`)) {
      out.push(
        probeFinding({
          rule: "reflected-xss",
          severity: "high",
          title: `Reflected XSS: \`${t.split("?")[0]}\` prints a query parameter without escaping`,
          detail: `The test tag \`<${marker}>\` came back unescaped in the HTML for ${site + t}.`,
          impact: "Someone who sends a crafted link can run script in a visitor's or admin's browser (session theft, fake checkout).",
          repro: [`Open ${site}${t.replace(enc, encodeURIComponent('"><svg onload=alert(document.domain)>'))}`, "An alert box confirms it."],
          fix: "Escape the parameter where it is printed (esc_attr / esc_html).",
          cwe: "CWE-79",
          url: site + t,
        }),
      );
    }
  }
  return out;
}

async function versionDisclosure(site) {
  const res = await get(`${site}/wp-content/plugins/wp-travel-engine/readme.txt`);
  const m = /Stable tag:\s*([\d.]+)/i.exec(res.text || "");
  if (res.status === 200 && m) {
    return [
      probeFinding({
        rule: "version-disclosure",
        severity: "info",
        title: `WP Travel Engine version is public (${m[1]})`,
        detail: `readme.txt shows Stable tag ${m[1]}. Check it against the known advisories (WPScan / Patchstack) for that version.`,
        impact: "Lets attackers match the site against known-vulnerable versions.",
        repro: [`Open ${site}/wp-content/plugins/wp-travel-engine/readme.txt`],
        fix: "Keep the plugin updated; block readme.txt in the plugin folders if you want.",
        cwe: "CWE-200",
        url: `${site}/wp-content/plugins/wp-travel-engine/readme.txt`,
      }),
    ];
  }
  return [];
}

// ── Transport & headers ─────────────────────────────────────────────────────

async function transportAndHeaders(site) {
  const out = [];
  const u = new URL(site);
  const local = /(^localhost$|\.local$|\.test$|^127\.|^192\.168\.|^10\.)/.test(u.hostname);
  if (u.protocol === "http:") {
    out.push(
      probeFinding({
        rule: "no-https",
        severity: local ? "info" : "high",
        title: "Site is served over plain HTTP",
        detail: `${site} uses http://.${local ? " It's a local site, so this only matters if the live site does the same." : ""}`,
        impact: "Logins, traveller details and checkout data travel unencrypted.",
        repro: [`Open ${site}/wp-login.php and check the address bar shows "Not secure".`],
        fix: "Serve the whole site over HTTPS and redirect http → https.",
        cwe: "CWE-319",
        url: site,
      }),
    );
  } else {
    const plain = await get(site.replace(/^https:/, "http:") + "/");
    const loc = plain.headers?.get("location") || "";
    if (plain.status && !(plain.status >= 300 && plain.status < 400 && loc.startsWith("https:"))) {
      out.push(
        probeFinding({
          rule: "no-https-redirect",
          severity: "low",
          title: "http:// doesn't redirect to https://",
          detail: `GET ${site.replace(/^https:/, "http:")}/ → ${plain.status}${loc ? ` (Location: ${loc})` : ""}.`,
          impact: "Visitors who type the address without https stay on an unencrypted connection.",
          repro: [`Open ${site.replace(/^https:/, "http:")}/ and check it ends up on https.`],
          fix: "Add a permanent (301) redirect from http to https at the server.",
          cwe: "CWE-319",
          url: site.replace(/^https:/, "http:"),
        }),
      );
    }
  }

  const home = await get(`${site}/`);
  const h = home.headers;
  if (!h) return out;
  const missing = [];
  const csp = h.get("content-security-policy") || "";
  if (!h.get("x-frame-options") && !/frame-ancestors/i.test(csp)) missing.push("`X-Frame-Options: SAMEORIGIN` (or CSP `frame-ancestors 'self'`): stops clickjacking of checkout and wp-admin");
  if (u.protocol === "https:" && !h.get("strict-transport-security")) missing.push("`Strict-Transport-Security`: keeps browsers on HTTPS");
  if (!h.get("x-content-type-options")) missing.push("`X-Content-Type-Options: nosniff`");
  if (!h.get("referrer-policy")) missing.push("`Referrer-Policy: strict-origin-when-cross-origin`: stops booking URLs with keys leaking to other sites");
  if (!csp) missing.push("`Content-Security-Policy`: limits the damage of any XSS");
  if (missing.length) {
    out.push(
      probeFinding({
        rule: "security-headers",
        severity: "low",
        title: `${missing.length} security header(s) missing`,
        detail: `The home page response is missing:\n${missing.map((m) => `- ${m}`).join("\n")}`,
        impact: "Easier clickjacking (tricking a user into clicking hidden checkout/admin buttons) and worse XSS impact.",
        repro: [`Open DevTools → Network, reload ${site}/, click the first request and check Response Headers.`, `Clickjacking test: create an HTML file with \`<iframe src="${site}/wp-login.php">\` and open it. If the page shows inside the frame, it can be clickjacked.`],
        fix: "Add the headers in the web server config or with a security-headers plugin.",
        cwe: "CWE-1021",
        url: `${site}/`,
      }),
    );
  }
  const powered = [h.get("x-powered-by"), h.get("server")].filter((v) => v && /\d/.test(v));
  if (powered.length) {
    out.push(
      probeFinding({
        rule: "server-version",
        severity: "info",
        title: "Server software versions are shown in headers",
        detail: `Headers reveal: ${powered.map((p) => `\`${p}\``).join(", ")}.`,
        impact: "Helps attackers pick exploits for the exact PHP/server version.",
        repro: [`Check the Server / X-Powered-By headers of ${site}/.`],
        fix: "Turn off expose_php and server tokens.",
        cwe: "CWE-200",
        url: `${site}/`,
      }),
    );
  }
  return out;
}

async function wordpressSurface(site) {
  const out = [];
  const x = await get(`${site}/xmlrpc.php`);
  if (/XML-RPC server accepts POST requests only/i.test(x.text)) {
    out.push(
      probeFinding({
        rule: "xmlrpc-enabled",
        severity: "low",
        title: "XML-RPC is enabled",
        detail: `${site}/xmlrpc.php answers. Its system.multicall method can try hundreds of passwords in one request, which gets past login rate limits.`,
        impact: "Faster password guessing; pingback abuse.",
        repro: [`Open ${site}/xmlrpc.php: "XML-RPC server accepts POST requests only." means it's on.`],
        fix: "Disable XML-RPC if no app uses it (security plugin or `add_filter( 'xmlrpc_enabled', '__return_false' )`).",
        cwe: "CWE-307",
        url: `${site}/xmlrpc.php`,
      }),
    );
  }
  const a = await get(`${site}/?author=1`);
  const loc = a.headers?.get("location") || "";
  const m = /\/author\/([^/]+)/.exec(loc) || /\/author\/([^/"']+)\//.exec(a.text);
  if (m) {
    out.push(
      probeFinding({
        rule: "author-enumeration",
        severity: "low",
        title: "Usernames can be found through ?author=1",
        detail: `${site}/?author=1 reveals the login name \`${decodeURIComponent(m[1])}\`.`,
        impact: "Gives attackers valid login names for password guessing.",
        repro: [`Open ${site}/?author=1, ?author=2 … and watch the URL change to /author/<name>/.`],
        fix: "Block ?author= requests for visitors, and make display names differ from usernames.",
        cwe: "CWE-203",
        url: `${site}/?author=1`,
      }),
    );
  }
  const rm = await get(`${site}/readme.html`);
  if (rm.status === 200 && /WordPress/i.test(rm.text)) {
    out.push(
      probeFinding({
        rule: "wp-readme",
        severity: "info",
        title: "WordPress readme.html is public",
        detail: `${site}/readme.html exists. It confirms the site runs WordPress, and older versions show the version number.`,
        impact: "Fingerprinting.",
        repro: [`Open ${site}/readme.html`],
        fix: "Delete readme.html or block it at the server.",
        cwe: "CWE-200",
        url: `${site}/readme.html`,
      }),
    );
  }
  return out;
}

// WP Travel Engine stores bookings, customers, enquiries and payments as post types.
const WTE_PRIVATE_TYPES = ["booking", "customer", "enquiry", "wte-payments", "wte-coupon", "wte-travellers"];

async function privatePostTypes(site, auth) {
  const out = [];
  for (const type of WTE_PRIVATE_TYPES) {
    const url = `${site}/wp-json/wp/v2/${type}?per_page=3`;
    const res = await get(url, auth ? { headers: auth } : {});
    if (res.status === 200 && Array.isArray(res.json) && res.json.length) {
      const { sensitive } = inspectJson(res.json);
      out.push(
        probeFinding({
          rule: auth ? "lowpriv-private-records" : "anon-private-records",
          severity: "critical",
          title: `${auth ? "A low-permission user" : "Visitors who aren't logged in"} can list \`${type}\` records through the REST API`,
          detail: `GET ${url} → 200 with ${res.json.length} record(s).${sensitive.length ? `\nFields:\n${sensitive.map((s) => `- \`${s}\``).join("\n")}` : ""}`,
          impact: "Customer/booking/payment records (names, emails, phones, amounts) exposed.",
          repro: [auth ? "Log in as the low-permission test user." : "Open a private window (not logged in).", `Visit ${url}`],
          fix: `Register the \`${type}\` post type with show_in_rest => false, or with capabilities that only admins have.`,
          cwe: "CWE-284",
          url,
        }),
      );
    }
  }
  return out;
}

async function phpErrorDisclosure(site) {
  // Pages that tend to warn: a trip page, the archive, and an invalid REST id.
  const trips = await get(`${site}/wp-json/wp/v2/trip?per_page=1&_fields=link`);
  const link = Array.isArray(trips.json) && trips.json[0]?.link;
  for (const u of [link, `${site}/trip/`, `${site}/wp-json/wptravelengine/v2/trips/999999999`, `${site}/?p=999999999`].filter(Boolean)) await get(u);
  if (!phpErrors.length) return [];
  const uniq = [...new Map(phpErrors.map((e) => [e.file, e])).values()];
  return [
    probeFinding({
      rule: "php-error-disclosure",
      severity: "medium",
      title: "PHP errors are shown on public pages (server paths leak)",
      detail: `PHP ${[...new Set(uniq.map((e) => e.kind))].join("/")} messages appear in responses:\n${uniq.slice(0, 8).map((e) => `- ${e.url} → \`${e.file}\``).join("\n")}`,
      impact: "Reveals server paths and plugin internals; can break checkout JSON responses.",
      repro: ["Open the URLs listed and search the page source for “Warning” / “Fatal error”."],
      fix: "Set WP_DEBUG_DISPLAY to false on any public site, and fix the warnings (report them as bugs too).",
      cwe: "CWE-209",
      url: uniq[0].url,
    }),
  ];
}

// ── Logged in as a low-permission user (Subscriber / customer) ──────────────
//
// Logs in through wp-login.php, then repeats the read-only checks with that
// session. Anything a Subscriber can read that an anonymous visitor can't, on
// a route or admin screen meant for admins, is broken access control.

const ADMIN_SCREENS = [
  ["/wp-admin/edit.php?post_type=booking", "Bookings list"],
  ["/wp-admin/edit.php?post_type=customer", "Customers list"],
  ["/wp-admin/edit.php?post_type=enquiry", "Enquiries list"],
  ["/wp-admin/edit.php?post_type=trip", "Trips list"],
  ["/wp-admin/edit.php?post_type=booking&page=class-wp-travel-engine-admin.php", "WP Travel Engine settings"],
  ["/wp-admin/admin.php?page=class-wp-travel-engine-admin.php", "WP Travel Engine settings"],
  ["/wp-admin/edit.php?post_type=wte-coupon", "Coupons"],
  ["/wp-admin/options-general.php", "WordPress settings"],
  ["/wp-admin/plugins.php", "Plugins"],
  ["/wp-admin/users.php", "Users"],
];

async function login(site, user, pass) {
  const body = new URLSearchParams({ log: user, pwd: pass, "wp-submit": "Log In", redirect_to: `${site}/wp-admin/`, testcookie: "1" });
  const res = await fetch(`${site}/wp-login.php`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: "wordpress_test_cookie=WP%20Cookie%20check", "User-Agent": "wpte-doctor/1.0 (QA)" },
    body,
  });
  const cookies = (res.headers.getSetCookie?.() || []).map((c) => c.split(";")[0]).filter((c) => !/=deleted$/.test(c));
  if (!cookies.some((c) => /^wordpress_logged_in_/.test(c))) throw new Error("Low-permission login failed: check the username/password.");
  const cookie = cookies.join("; ");
  const nonceRes = await get(`${site}/wp-admin/admin-ajax.php?action=rest-nonce`, { headers: { Cookie: cookie } });
  const nonce = /^[a-f0-9]{10}$/.test(nonceRes.text.trim()) ? nonceRes.text.trim() : "";
  return { Cookie: cookie, ...(nonce ? { "X-WP-Nonce": nonce } : {}) };
}

async function lowPrivProbes(site, user, pass, log) {
  const out = [];
  const auth = await login(site, user, pass);
  const me = await get(`${site}/wp-json/wp/v2/users/me?context=edit`, { headers: auth });
  const roles = me.json?.roles || [];
  log(`  logged in as ${user} (${roles.join(", ") || "role unknown"})`);
  if (roles.some((r) => /administrator|editor|shop_manager|wte_manager/i.test(r))) {
    throw new Error(`The test user "${user}" has role ${roles.join(", ")}. Use a Subscriber or customer account for this test.`);
  }

  // Admin screens.
  for (const [p, label] of ADMIN_SCREENS) {
    const res = await get(site + p, { headers: { Cookie: auth.Cookie } });
    const denied = res.status >= 300 || /not allowed|Sorry, you are not|do not have sufficient permissions|wp-login\.php/i.test(res.text);
    if (!denied && res.status === 200 && /wp-admin|adminmenu/i.test(res.text)) {
      out.push(
        probeFinding({
          rule: "lowpriv-admin-screen",
          severity: "high",
          title: `A ${roles[0] || "low-permission"} user can open “${label}” in wp-admin`,
          detail: `GET ${site + p} as \`${user}\` → 200 with the admin screen.`,
          impact: "Customers/subscribers can see or change admin-only data.",
          repro: [`Log in as a ${roles[0] || "Subscriber"}.`, `Open ${site + p}`, "Expected: “Sorry, you are not allowed to access this page.”"],
          fix: "Register the menu page / post type with an admin capability (manage_options or a WTE manager capability).",
          cwe: "CWE-284",
          url: site + p,
        }),
      );
    }
  }

  // REST routes: what this user gets that a visitor doesn't.
  const index = await get(`${site}/wp-json/`);
  const routes = Object.entries(index.json?.routes || {}).filter(([r, d]) => WTE_NS.test((d.namespace || r.split("/")[1] || "").replace(/^\//, "")) && (d.methods || []).includes("GET"));
  const trips = await get(`${site}/wp-json/wp/v2/trip?per_page=1&_fields=id`);
  const tripId = Array.isArray(trips.json) && trips.json[0]?.id ? String(trips.json[0].id) : "1";
  for (const [route] of routes) {
    for (const ctx of ["", "context=edit"]) {
      const filled = fillRoute(route, tripId);
      const url = `${site}/wp-json${filled}${ctx ? (filled.includes("?") ? "&" : "?") + ctx : ""}`;
      const asUser = await get(url, { headers: auth });
      if (asUser.status !== 200 || asUser.json == null) continue;
      const asAnon = await get(url);
      if (asAnon.status === 200 && !ctx) continue; // public anyway: covered by the anonymous checks
      const { secrets, sensitive } = inspectJson(asUser.json);
      const looksPrivate = ctx || /(setting|booking|customer|payment|enquir|traveller|report|export|log|user|email|coupon|order)/i.test(route);
      if (!secrets.length && !sensitive.length && !looksPrivate) continue;
      out.push(
        probeFinding({
          rule: "lowpriv-rest",
          severity: secrets.length ? "critical" : sensitive.length || ctx ? "high" : "medium",
          title: `A ${roles[0] || "low-permission"} user can read \`${route}\`${ctx ? " in edit context" : ""}`,
          detail: `GET ${url} → 200 as \`${user}\` (visitors get ${asAnon.status}).${secrets.length ? `\nLooks like secrets:\n${secrets.slice(0, 6).map((s) => `- \`${s}\``).join("\n")}` : ""}${sensitive.length ? `\nPersonal/financial fields:\n${sensitive.map((s) => `- \`${s}\``).join("\n")}` : ""}`,
          impact: "Any customer account can read admin-level data.",
          repro: [`Log in as a ${roles[0] || "Subscriber"}.`, `Open ${url}`, "Expected: 401/403."],
          fix: "permission_callback must check an admin capability (current_user_can), not only that the user is logged in.",
          cwe: "CWE-285",
          url,
        }),
      );
    }
  }
  out.push(...(await privatePostTypes(site, auth)));
  return out;
}

// ── TLS & cookies (configuration testing) ───────────────────────────────────

const tls = require("tls");

function tlsHandshake(host, options = {}) {
  return new Promise((resolve) => {
    const sock = tls.connect({ host, port: 443, servername: host, rejectUnauthorized: false, timeout: 10000, ...options }, () => {
      const info = { ok: true, authorized: sock.authorized, authError: sock.authorizationError, protocol: sock.getProtocol(), cert: sock.getPeerCertificate() };
      sock.end();
      resolve(info);
    });
    sock.on("error", (e) => resolve({ ok: false, error: e.message }));
    sock.on("timeout", () => {
      sock.destroy();
      resolve({ ok: false, error: "timeout" });
    });
  });
}

async function tlsAndCookies(site) {
  const out = [];
  const u = new URL(site);
  if (u.protocol !== "https:") return out;
  const main = await tlsHandshake(u.hostname);
  if (main.ok) {
    const days = Math.floor((new Date(main.cert.valid_to) - Date.now()) / 86400000);
    if (!main.authorized) {
      out.push(probeFinding({ rule: "tls-cert", severity: "high", title: "TLS certificate isn't trusted", detail: `Browsers reject the certificate: ${main.authError}.`, impact: "Visitors see a warning and checkout data can be intercepted.", repro: [`Open ${site} and click the padlock.`], fix: "Install a valid certificate (e.g. Let's Encrypt) with the full chain.", cwe: "CWE-295", url: site }));
    } else if (days < 21) {
      out.push(probeFinding({ rule: "tls-cert", severity: days < 0 ? "high" : "medium", title: days < 0 ? "TLS certificate has expired" : `TLS certificate expires in ${days} day(s)`, detail: `Valid until ${main.cert.valid_to}.`, impact: "Site and checkout become unreachable behind a browser warning.", repro: [`Open ${site} and check the certificate dates.`], fix: "Renew it and turn on auto-renewal.", cwe: "CWE-298", url: site }));
    }
  }
  // Old protocols: a successful TLS 1.0/1.1 handshake is the problem.
  const old = await tlsHandshake(u.hostname, { minVersion: "TLSv1", maxVersion: "TLSv1.1", ciphers: "DEFAULT@SECLEVEL=0" });
  if (old.ok) {
    out.push(probeFinding({ rule: "tls-old-protocol", severity: "medium", title: `Server still accepts ${old.protocol}`, detail: `A ${old.protocol} handshake to ${u.hostname}:443 succeeded. PCI DSS and browsers require TLS 1.2 or newer.`, impact: "Downgrade attacks on old clients; fails PCI DSS.", repro: [`Run \`openssl s_client -connect ${u.hostname}:443 -tls1_1\` (or check with SSL Labs).`], fix: "Disable TLS 1.0 and 1.1 in the web server / CDN.", cwe: "CWE-326", url: site }));
  }
  const login = await get(`${site}/wp-login.php`);
  const insecure = (login.headers?.getSetCookie?.() || []).filter((c) => !/;\s*secure/i.test(c)).map((c) => c.split("=")[0]);
  if (insecure.length) {
    out.push(probeFinding({ rule: "cookie-flags", severity: "low", title: "Cookies set without the Secure flag on HTTPS", detail: `wp-login.php sets: ${insecure.map((c) => `\`${c}\``).join(", ")} without \`Secure\`.`, impact: "Cookies can be sent over plain HTTP if a user lands on an http:// link.", repro: ["Open wp-login.php, DevTools → Application → Cookies, check the Secure column."], fix: "Force HTTPS (FORCE_SSL_ADMIN, site URL on https) so WordPress sets Secure cookies.", cwe: "CWE-614", url: `${site}/wp-login.php` }));
  }
  return out;
}

// ── Fuzz testing (opt-in) ───────────────────────────────────────────────────
//
// Sends malformed values to every parameter of the WP Travel Engine GET routes
// (still read-only methods) and to path IDs, and watches for crashes: HTTP
// 500s, PHP errors, database errors, or very slow answers. A well-behaved
// route answers bad input with a clean 400/404.

// ── Fuzzing corpus (generation-based) ────────────────────────────────────────
//
// A deliberately diverse set — valid, invalid, common, uncommon, simple,
// complex and malformed — grouped by category so a finding can say which class
// of input broke the route. FZ9MARK is a unique marker: if `<FZ9MARK>` comes
// back unescaped, the route reflects input (possible XSS).
const CORPUS = {
  valid: ["1", "test", "2026-01-01"],
  boundary: ["-1", "0", "0.5", "2147483647", "2147483648", "99999999999", "1e309"],
  empty: ["", " "],
  oversized: ["A".repeat(5000)],
  special: ["'", '"', "`", ";", "\\", "\n", "\t", "<FZ9MARK>", '"><FZ9MARK>', "😀🧳"],
  format: ["%s%s%s%s", "%n", "{{7*7}}", "${7*7}", "<%= 7*7 %>"],
  injection: ["1' OR '1'='1", "1 AND SLEEP(0)", "../../../../etc/passwd", "||1", "1)) OR 1=1--"],
  encoding: ["%00", "%2e%2e%2f", "%27", "%3Cscript%3E"],
  typeConfusion: ["[]", "{}", "true", "null", "NaN", "2026-13-45"],
};
const CORPUS_FLAT = Object.entries(CORPUS).flatMap(([cat, vs]) => vs.map((v) => ({ v, cat })));

/** Generation-based, schema-aware: values suited to an arg's declared type. */
function valuesForType(type) {
  const t = Array.isArray(type) ? type[0] : type;
  const pick = (...cats) => CORPUS_FLAT.filter((x) => cats.includes(x.cat));
  switch (t) {
    case "integer":
    case "number":
      return [...pick("boundary"), ...pick("special").slice(0, 3), { v: "abc", cat: "typeConfusion" }, { v: "0x10", cat: "typeConfusion" }];
    case "boolean":
      return [{ v: "2", cat: "typeConfusion" }, { v: "maybe", cat: "typeConfusion" }, { v: "-1", cat: "boundary" }, { v: "[]", cat: "typeConfusion" }];
    case "array":
      return [{ v: "notanarray", cat: "typeConfusion" }, { v: "1", cat: "typeConfusion" }, ...pick("injection").slice(0, 2)];
    case "object":
      return [{ v: "notanobject", cat: "typeConfusion" }, { v: "[]", cat: "typeConfusion" }];
    case "string":
      return [...pick("special"), ...pick("format"), ...pick("injection"), ...pick("encoding"), ...pick("oversized"), ...pick("empty")];
    default: // unknown/mixed — a broad sweep
      return [...pick("special").slice(0, 4), ...pick("boundary").slice(0, 3), ...pick("format").slice(0, 2), ...pick("injection").slice(0, 2), ...pick("oversized"), ...pick("empty")];
  }
}

/** Mutation-based: derive malformed inputs from a valid seed value. */
function mutate(seed) {
  seed = String(seed == null || seed === "" ? "1" : seed);
  const mid = Math.max(1, Math.floor(seed.length / 2));
  return [
    { v: seed.slice(0, Math.max(0, seed.length - 1)), cat: "mutation:truncate" },
    { v: seed + seed, cat: "mutation:duplicate" },
    { v: seed === seed.toUpperCase() ? seed.toLowerCase() : seed.toUpperCase(), cat: "mutation:case" },
    { v: seed + "\u0000", cat: "mutation:null-byte" },
    { v: seed.slice(0, mid) + "'" + seed.slice(mid), cat: "mutation:inject-quote" },
    { v: "[" + seed + "]", cat: "mutation:type-swap" },
    { v: seed + "A".repeat(2000), cat: "mutation:oversize" },
  ];
}
/** A sensible seed for an arg whose type we know but value we don't. */
const seedForType = (type) => ((Array.isArray(type) ? type[0] : type) === "string" ? "test" : "1");
/** Runs async jobs a few at a time: fast enough, gentle enough for a shared QA host. */
async function pool(jobs, size = 4) {
  const queue = [...jobs];
  await Promise.all(Array.from({ length: size }, async () => {
    while (queue.length) await queue.shift()();
  }));
}

const DB_ERROR = /WordPress database error|You have an error in your SQL syntax|mysqli?_|PDOException|SQLSTATE\[/;

// Grey-box API fuzzer: mutation-based + schema-aware generation, with
// reproducibility triage. Read-only GET only.
async function fuzzApi(site, log, budget = 360) {
  const index = await get(`${site}/wp-json/`);
  // Namespace index routes (/wptravelengine/v1) are generated by WordPress core,
  // not the plugin; core itself 500s on ?namespace[]=x, so fuzzing them only
  // reports a core bug as if it were WP Travel Engine's.
  const routes = Object.entries(index.json?.routes || {}).filter(
    ([r, d]) => WTE_NS.test((d.namespace || r.split("/")[1] || "").replace(/^\//, "")) && (d.methods || []).includes("GET") && r !== `/${d.namespace}`,
  );
  const trips = await get(`${site}/wp-json/wp/v2/trip?per_page=1&_fields=id`);
  const tripId = Array.isArray(trips.json) && trips.json[0]?.id ? String(trips.json[0].id) : "1";

  // Baseline: how each route answers VALID input (timing + size), so anomalies
  // are judged relative to normal, not to a fixed threshold.
  const baseline = new Map();
  await pool(routes.map(([route]) => async () => {
    const t0 = Date.now();
    const r = await get(`${site}/wp-json${fillRoute(route, tripId)}`, { timeout: 30000 });
    baseline.set(route, { ms: Date.now() - t0, size: (r.text || "").length });
  }));
  const avg = Math.round([...baseline.values()].reduce((a, b) => a + b.ms, 0) / (baseline.size || 1));
  log(`  baseline: routes answer valid input in ~${avg} ms`);

  // Monitor: classify one response into an anomaly kind (or null = looks fine).
  const classify = (route, res, ms, payload) => {
    if (DB_ERROR.test(res.text)) return "db"; // exception → likely SQLi
    if (res.status >= 500) return "500"; // crash
    if (PHP_ERROR.test(res.text)) return "php"; // exception / path leak
    // Reflected input unescaped → possible XSS (distinct marker avoids noise).
    if (res.status === 200 && /FZ9MARK/.test(String(payload)) && res.text.includes("<FZ9MARK>")) return "reflected";
    const base = baseline.get(route) || {};
    if (res.error === "timeout" || ms > Math.max(10000, (base.ms || 3000) * 3)) return "hang"; // DoS-ish
    // Big deviation in response size on a 200 (different output for bad input).
    if (res.status === 200 && base.size > 200 && (res.text.length > base.size * 3 || res.text.length < base.size / 3)) return "deviation";
    return null;
  };

  let sent = 0;
  const candidates = []; // { route, kind, label, cat, url }
  const seen = new Set();
  const record = (route, kind, label, cat, url) => {
    const key = `${route}|${kind}|${label}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({ route, kind, label, cat, url });
  };
  const tasks = [];
  const probe = (route, url, label, cat) => {
    if (tasks.length < budget) tasks.push([route, url, label, cat]);
  };
  const run = async (route, url, label, cat, payload) => {
    sent++;
    const t0 = Date.now();
    const res = await get(url, { timeout: 15000 });
    const kind = classify(route, res, Date.now() - t0, payload);
    if (kind) record(route, kind, label, cat, url);
  };

  const short = (v) => (v.length > 32 ? `${v.slice(0, 18)}…(${v.length} chars)` : v || "(empty)");
  const idUrl = (route, v) => `${site}/wp-json${route.replace(/\(\?P<(\w+)>[^)]*\)/g, encodeURIComponent(v))}`;
  const argUrl = (base, arg, v) => `${base}${base.includes("?") ? "&" : "?"}${encodeURIComponent(arg)}=${encodeURIComponent(v)}`;

  // Highest-signal first: path IDs — a valid-looking but nonexistent id is the
  // classic unhandled-"post not found" crash. Mutate the real id AND generate
  // boundary/garbage ids, so this never gets starved by the budget.
  for (const [route] of routes) {
    if (!/\(\?P<\w+>/.test(route)) continue;
    const idValues = [...mutate(tripId), ...valuesForType("integer")];
    for (const { v, cat } of idValues) probe(route, idUrl(route, v), `id=${short(v)}`, cat);
  }
  // Then each GET arg: schema-aware generation + mutation of a typed seed + array type-confusion.
  for (const [route, def] of routes) {
    const base = `${site}/wp-json${fillRoute(route, tripId)}`;
    const argSchema = Object.assign({}, ...(def.endpoints || []).filter((e) => (e.methods || []).includes("GET")).map((e) => e.args || {}));
    for (const [arg, spec] of Object.entries(argSchema)) {
      const values = [...valuesForType(spec?.type), ...mutate(seedForType(spec?.type))];
      for (const { v, cat } of values) probe(route, argUrl(base, arg, v), `${arg}=${short(v)}`, cat);
      probe(route, `${base}${base.includes("?") ? "&" : "?"}${encodeURIComponent(arg)}[]=x&${encodeURIComponent(arg)}[a]=y`, `${arg} as nested array`, "typeConfusion");
    }
  }
  await pool(tasks.map(([route, url, label, cat]) => () => run(route, url, label, cat, decodeURIComponent((url.split("=").pop() || "")))));

  // Triage: group by route+kind, then REPLAY each group's first trigger once.
  // Fuzzing is nondeterministic (the article's own caveat), so only anomalies
  // that reproduce become findings; the rest are dropped as noise.
  const groups = new Map();
  for (const c of candidates) {
    const key = `${c.route}|${c.kind}`;
    if (!groups.has(key)) groups.set(key, { route: c.route, kind: c.kind, count: 0, cats: new Set(), examples: [] });
    const g = groups.get(key);
    g.count++;
    g.cats.add(c.cat);
    if (g.examples.length < 5) g.examples.push(c);
  }
  let dropped = 0;
  for (const g of groups.values()) {
    const ex = g.examples[0];
    const t0 = Date.now();
    const res = await get(ex.url, { timeout: 15000 });
    g.reproduced = classify(g.route, res, Date.now() - t0, decodeURIComponent((ex.url.split("=").pop() || ""))) === g.kind;
    if (!g.reproduced) dropped++;
  }
  log(`  ${sent} fuzz request(s); ${groups.size} candidate anomaly group(s), ${dropped} dropped as non-reproducible`);

  const KIND = {
    db: { rule: "fuzz-db-error", severity: "high", what: "a database error", impact: "Database errors on bad input usually mean the value reaches SQL unescaped: a likely SQL injection.", fix: "Validate/sanitise the parameter in the route's args schema and use $wpdb->prepare().", cwe: "CWE-89" },
    "500": { rule: "fuzz-server-error", severity: "medium", what: "a server error (HTTP 500)", impact: "The route crashes on unexpected input — missing validation, sometimes exploitable.", fix: "Declare type/validate_callback for every arg in register_rest_route and handle bad input with a 400/404.", cwe: "CWE-20" },
    php: { rule: "fuzz-php-error", severity: "medium", what: "a PHP warning/fatal", impact: "An uncaught exception; leaks server paths when debug display is on and shows input isn't validated.", fix: "Validate the parameter types in the args schema; fix the warning.", cwe: "CWE-209" },
    reflected: { rule: "fuzz-reflected", severity: "high", what: "your input reflected back unescaped", impact: "The route echoes attacker input into the response unescaped — a likely XSS sink.", fix: "Escape output (esc_html/esc_attr) and sanitise the parameter.", cwe: "CWE-79" },
    hang: { rule: "fuzz-slow", severity: "low", what: "a very slow answer / hang (>10 s or 3× baseline)", impact: "Cheap requests tie up the server (DoS), or a time-based SQL injection.", fix: "Limit input size/ranges; look for unbounded loops or queries.", cwe: "CWE-400" },
    deviation: { rule: "fuzz-deviation", severity: "low", what: "a response very different in size from the valid baseline", impact: "Bad input changes the output materially — worth checking what leaked or broke.", fix: "Return a consistent 400/404 for invalid input.", cwe: "CWE-20" },
  };
  return [...groups.values()]
    .filter((g) => g.reproduced && KIND[g.kind])
    .map((g) => {
      const k = KIND[g.kind];
      return probeFinding({
        rule: k.rule,
        severity: k.severity,
        title: `Fuzzing \`${g.route}\` causes ${k.what}`,
        detail:
          `Reproduced: yes. Triggered by ${g.count} input(s) (categories: ${[...g.cats].join(", ")}).\n` +
          `Example inputs:\n${g.examples.map((e) => `- \`${e.label}\` [${e.cat}]`).join("\n")}`,
        impact: k.impact,
        repro: [
          `Send ${site}/wp-json${fillRoute(g.route, tripId)} with an input like \`${g.examples[0].label}\` (browser, Postman, or the Request builder).`,
          "Expected: a clean 400/404 JSON error, not a crash / reflected input / hang.",
        ],
        fix: k.fix,
        cwe: k.cwe,
        url: g.examples[0].url,
      });
    });
}

async function runSiteProbes(site, log = console.log, opts = {}) {
  site = site.replace(/\/$/, "");
  phpErrors = [];
  net.total = 0;
  net.failed = 0;
  const ping = await get(`${site}/wp-json/`, { timeout: 15000 });
  if (!ping.status) throw new Error(`Site not reachable: ${site} (${ping.error})`);
  const out = [];
  const steps = [
    ["REST exposure", () => restExposure(site, log)],
    ["Private WTE records", () => privatePostTypes(site)],
    ["User enumeration", () => userEnumeration(site)],
    ["WordPress surface (XML-RPC, ?author=, readme)", () => wordpressSurface(site)],
    ["HTTPS & security headers", () => transportAndHeaders(site)],
    ["TLS certificate, protocols & cookies", () => tlsAndCookies(site)],
    ["Exposed files", () => exposedFiles(site)],
    ["Reflected XSS", () => reflectedXss(site)],
    ["Version", () => versionDisclosure(site)],
  ];
  if (opts.user && opts.pass) steps.push([`Logged in as ${opts.user}`, () => lowPrivProbes(site, opts.user, opts.pass, log)]);
  if (opts.fuzz) steps.push(["Fuzzing the WP Travel Engine API", () => fuzzApi(site, log)]);
  steps.push(["PHP error disclosure", () => phpErrorDisclosure(site)]);
  for (const [name, fn] of steps) {
    log(`• ${name}`);
    const before = net.failed;
    const found = await fn();
    log(`  → ${found.length} finding(s)${net.failed > before ? ` (${net.failed - before} request(s) got no answer)` : ""}`);
    out.push(...found);
  }
  if (net.failed >= 5 && net.failed / net.total > 0.15) {
    throw new Error(
      `The site stopped answering reliably: ${net.failed} of ${net.total} requests timed out or failed. ` +
        "The results would look cleaner than reality, so this run wasn't saved. Try again later (the host may be slow or rate-limiting), or without fuzzing.",
    );
  }
  log(`  ${net.total} request(s), ${net.failed} without an answer`);
  return out;
}

module.exports = { runSiteProbes };
