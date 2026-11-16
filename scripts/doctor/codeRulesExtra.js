// scripts/doctor/codeRulesExtra.js
//
// More code checks, on top of codeRules.js. Together they cover the OWASP Top
// 10 areas that show up in WordPress plugins:
//
//   Broken access control  → IDOR on bookings/orders, privilege escalation, is_admin() used as auth
//   Injection              → path traversal, SSRF, stored XSS via meta/options, CSV/formula injection,
//                            shortcode attribute XSS, DOM XSS in the add-on's JS
//   Cryptographic failures → hard-coded keys, weak randomness for tokens, md5/sha1 passwords
//   Insecure design        → file uploads with no type check
//   Misconfiguration       → PHP files that run when opened directly, debug output left in
//
// Like the base rules, these find leads. Each one says how to confirm it.

const fs = require("fs");
const path = require("path");
const { walk, lineAt } = require("./php");

const SUPERGLOBAL = String.raw`\$_(?:GET|POST|REQUEST|COOKIE|SERVER|FILES)\b`;
const REQUEST = new RegExp(`${SUPERGLOBAL}|\\$request\\s*(?:->\\s*get_(?:param|json_params|body_params|params|file_params)\\s*\\(|\\[)`);
const SANITIZED = /\b(sanitize_\w+|absint|intval|floatval|esc_\w+|wp_kses\w*|\(int\)|\(float\)|wp_validate_\w+|filter_var)\b/;
const CAP_RE = /\b(current_user_can|user_can|is_super_admin)\s*\(/;
const SECRET_VALUE = /\b(sk_live_[0-9a-zA-Z]{16,}|rk_live_[0-9a-zA-Z]{16,}|whsec_[0-9a-zA-Z]{20,}|FLWSECK-[0-9a-f]{20,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|xox[baprs]-[0-9A-Za-z-]{10,}|ghp_[0-9A-Za-z]{36}|-----BEGIN (RSA |EC )?PRIVATE KEY-----)/;

const line = (file, i) => ({ file: file.rel, line: i + 1, snippet: file.src.split(/\r?\n/)[i].trim().slice(0, 200) });

const RULES = [
  {
    rule: "path-traversal",
    severity: "high",
    test: (l) => /\b(file_get_contents|readfile|fopen|file|unlink|wp_delete_file|copy|rename|fpassthru|parse_ini_file|simplexml_load_file)\s*\(/.test(l) && REQUEST.test(l) && !/php:\/\/input/.test(l),
    title: "File path built from request data (read or delete arbitrary files)",
    detail: "A file function gets a path that includes a request value. `../` in that value can reach files outside the intended folder.",
    impact: "Reading wp-config.php (database password, keys) or deleting it, which forces the WordPress setup screen and lets someone take over the site.",
    repro: ["Find the request that reaches this line.", "Set the file parameter to `../../../../wp-config.php`.", "Expected: rejected. File contents (or the file disappearing) means path traversal."],
    fix: "Accept only a file name from an allowlist, or use basename() + realpath() and check the result is inside the allowed folder.",
    cwe: "CWE-22",
  },
  {
    rule: "ssrf",
    severity: "medium",
    test: (l) => /\b(wp_remote_(get|post|request|head)|curl_init|file_get_contents|fsockopen|download_url)\s*\(/.test(l) && REQUEST.test(l),
    title: "Server fetches a URL taken from the request (SSRF)",
    detail: "The server makes an HTTP request to a URL the client controls. wp_remote_* does not block internal addresses; wp_safe_remote_* does.",
    impact: "Reaching internal services (cloud metadata, admin panels on localhost) from the server.",
    repro: ["Find the request that reaches this line.", "Set the URL parameter to a request-catcher URL (e.g. webhook.site) and check the server called it, then try `http://127.0.0.1/`.", "Expected: rejected."],
    fix: "Use wp_safe_remote_get()/post(), and only allow known hosts.",
    cwe: "CWE-918",
  },
  {
    rule: "stored-xss-meta",
    severity: "medium",
    test: (l) => /\b(update_post_meta|add_post_meta|update_option|add_option|update_user_meta|update_term_meta|wp_insert_post|wp_update_post)\s*\(/.test(l) && new RegExp(SUPERGLOBAL).test(l) && !SANITIZED.test(l),
    title: "Request data saved without sanitising (stored XSS risk)",
    detail: "A request value is saved straight to the database. Wherever it's printed later without escaping, it runs as script for every viewer (often an admin viewing bookings or enquiries).",
    impact: "Stored XSS: script runs for admins, which can lead to account takeover.",
    repro: ["Submit the form that saves this field with `<img src=x onerror=alert(document.domain)>`.", "Open every place that shows the field: wp-admin booking/enquiry screens, emails, front end.", "Expected: shown as text. An alert box means stored XSS."],
    fix: "Sanitise on save (sanitize_text_field / sanitize_email / absint / wp_kses_post) and escape on output.",
    cwe: "CWE-79",
  },
  {
    rule: "shortcode-xss",
    severity: "medium",
    test: (l) => /\b(echo|print|return)\b/.test(l) && /\$(atts|attributes)\s*\[/.test(l) && !/\besc_\w+\s*\(|absint|intval|wp_kses/.test(l),
    title: "Shortcode attribute printed without escaping",
    detail: "A shortcode attribute is printed raw. Contributors (who can't normally post script) can put a shortcode with a payload in a post.",
    impact: "Stored XSS by a Contributor-level user that runs for admins and visitors.",
    repro: ["As a Contributor, create a post with the shortcode and an attribute like `x=\"\\\"><img src=x onerror=alert(1)>\"`.", "Preview it. An alert box means XSS."],
    fix: "Escape every attribute on output (esc_attr / esc_html / esc_url).",
    cwe: "CWE-79",
  },
  {
    rule: "privilege-escalation",
    severity: "critical",
    test: (l) => (/\b(wp_insert_user|wp_update_user|wp_create_user|set_role|add_role|add_cap|wp_set_current_user|wp_set_auth_cookie|grant_super_admin)\s*\(/.test(l) && REQUEST.test(l)) || /['"]role['"]\s*=>\s*(\$_|\$request)/.test(l),
    title: "User role/login set from request data (privilege escalation)",
    detail: "A user is created/updated, given a role, or logged in using a value from the request.",
    impact: "Registering as, or upgrading to, administrator; logging in as another user.",
    repro: ["Find the registration/profile form or request that reaches this line.", "Add `role=administrator` (or change the user ID) in the request.", "Expected: ignored. An admin account means privilege escalation."],
    fix: "Never take role, capabilities or user ID from the request; hard-code the role and use get_current_user_id().",
    cwe: "CWE-269",
  },
  {
    rule: "hardcoded-secret",
    severity: "critical",
    test: (l) => SECRET_VALUE.test(l),
    title: "Live API key or private key hard-coded in the source",
    detail: "A string that looks like a live secret (Stripe sk_live/whsec, AWS, Google, Slack, GitHub, private key) is in the code. Anyone who gets the plugin zip gets the key.",
    impact: "Anyone with the plugin can use the account (charges, refunds, data).",
    fix: "Remove it, rotate the key at the provider, and load secrets from settings or wp-config constants.",
    cwe: "CWE-798",
  },
  {
    rule: "weak-random",
    severity: "medium",
    test: (l) => /\b(rand|mt_rand|uniqid|lcg_value|microtime|time)\s*\(/.test(l) && /(token|key|nonce|secret|password|pass|hash|code|otp|reset|coupon|voucher)/i.test(l) && !/wp_rand|random_bytes|random_int|wp_generate_password/.test(l),
    title: "Predictable value used for a token, key or code",
    detail: "rand()/mt_rand()/uniqid()/time() aren't cryptographically secure; values can be guessed.",
    impact: "Guessing booking keys, payment links, reset or coupon codes.",
    fix: "Use wp_generate_password( 32, false ), random_bytes() or wp_rand().",
    cwe: "CWE-338",
  },
  {
    rule: "weak-password-hash",
    severity: "medium",
    test: (l) => /\b(md5|sha1|crc32|base64_encode)\s*\(/.test(l) && /pass(word)?|pwd/i.test(l),
    title: "Password stored with md5/sha1/base64",
    detail: "Passwords hashed with a fast or reversible function.",
    impact: "Leaked hashes are cracked in seconds.",
    fix: "Use wp_hash_password() / wp_check_password().",
    cwe: "CWE-916",
  },
  {
    rule: "csv-injection",
    severity: "medium",
    // Already safe when the file neutralises leading = + - @ (regex or in_array list) or has an escape helper.
    test: (l, file) => /\bfputcsv\s*\(/.test(l) && !/\^\[[^\]]*[=+@][^\]]*\]|['"]=['"]\s*,\s*['"][+\-@]['"]|formula|csv_escape|escape_csv|sanitize_csv/i.test(file.src),
    title: "CSV export doesn't neutralise formulas (CSV/formula injection)",
    detail: "Exported cells (traveller names, enquiry messages…) are written as-is. A value starting with = + - @ runs as a formula when the admin opens the export in Excel.",
    impact: "A traveller enters `=HYPERLINK(...)` or a DDE payload as their name; it runs on the admin's computer when they open the bookings export.",
    repro: ["Make a booking/enquiry with the name `=HYPERLINK(\"https://example.org\",\"click\")`.", "Export bookings/enquiries to CSV and open it in Excel.", "Expected: shown as text. A live link/formula means CSV injection."],
    fix: "Prefix any cell starting with = + - @ tab or CR with a single quote before fputcsv().",
    cwe: "CWE-1236",
  },
  {
    rule: "debug-leftover",
    severity: "low",
    test: (l) => /^\s*(var_dump|print_r|var_export|debug_print_backtrace|phpinfo)\s*\(/.test(l) && !/,\s*true\s*\)/.test(l),
    title: "Debug output left in the code",
    detail: "var_dump/print_r/phpinfo prints internals to the page.",
    impact: "Leaks data and server details; can break JSON responses.",
    fix: "Remove it.",
    cwe: "CWE-489",
  },
  {
    rule: "log-sensitive",
    severity: "low",
    test: (l) => /\berror_log\s*\(/.test(l) && (new RegExp(SUPERGLOBAL).test(l) || /card|cvv|cvc|password|secret|token/i.test(l)),
    title: "Request or card/secret data written to the error log",
    detail: "error_log() records request bodies or sensitive values. debug.log is often downloadable.",
    impact: "Card, password or token data ending up in a readable log file.",
    fix: "Don't log request bodies or secrets; mask them.",
    cwe: "CWE-532",
  },
];

function lineRules({ files }) {
  const out = [];
  for (const file of files) {
    const code = file.codeOnly.split(/\r?\n/);
    for (const r of RULES) {
      for (let i = 0; i < code.length; i++) {
        if (!code[i].trim() || !r.test(code[i], file)) continue;
        out.push({ rule: r.rule, severity: r.severity, title: r.title, ...line(file, i), detail: r.detail, impact: r.impact, repro: r.repro, fix: r.fix, cwe: r.cwe });
      }
    }
  }
  return out;
}

// ── Function-level: IDOR and uploads ────────────────────────────────────────

const OBJ_ID = /\$(_GET|_POST|_REQUEST)\s*\[\s*['"](\w*(booking|order|customer|enquiry|inquiry|payment|invoice|traveller|traveler|user)_?id\w*|id)['"]\s*\]|\$request\s*(?:->\s*get_param\s*\(\s*|\[\s*)['"](\w*(booking|order|customer|enquiry|payment|invoice|user)_?id\w*)['"]/i;
const OWNERSHIP = /(get_current_user_id|wp_get_current_user|current_user_can|user_can|post_author|hash_equals|payment_key|booking_key|_key['"]\s*\]|token|verify_nonce|check_ajax_referer)/i;

function functionRules({ fnIndex }) {
  const out = [];
  for (const defs of fnIndex.values()) {
    for (const def of defs) {
      const b = def.body;
      const m = OBJ_ID.exec(b);
      if (m && /\b(get_post|get_post_meta|wc_get_order|get_user_by|get_userdata|new\s+\\?\w*Booking|Booking::|get_booking|wp_send_json|echo|update_post_meta|wp_delete_post)\b/.test(b) && !OWNERSHIP.test(b)) {
        const at = def.bodyStart + b.indexOf(m[0]);
        const ln = lineAt(def.file.src, at);
        out.push({
          rule: "idor",
          severity: "high",
          title: `\`${def.name}()\` loads a record by an ID from the request without checking it belongs to the user (IDOR)`,
          file: def.file.rel,
          line: ln,
          snippet: def.file.src.split(/\r?\n/)[ln - 1].trim().slice(0, 200),
          detail: "The ID comes straight from the request and the function never checks the current user owns that booking/order/customer (no user ID comparison, booking key, token or capability check).",
          impact: "Changing the ID in the URL or request shows or changes other customers' bookings: names, emails, phone numbers, passport details, payments.",
          repro: ["Make two bookings from two different customer accounts (or two browsers).", "As customer A, find the request/URL that carries the booking/order ID.", "Change the ID to customer B's booking and send it.", "Expected: denied. Seeing or changing B's booking means IDOR."],
          fix: "After loading the record, check it belongs to get_current_user_id() or verify a secret booking key/token; otherwise return 403.",
          cwe: "CWE-639",
        });
      }
      if (/\$_FILES\b|wp_handle_upload|move_uploaded_file|media_handle_upload/.test(b) && !/(wp_check_filetype|wp_check_filetype_and_ext|['"]mimes['"]|getimagesize|finfo_|mime_content_type|allowed_types|allowed_mime)/.test(b)) {
        const idx = b.search(/\$_FILES\b|wp_handle_upload|move_uploaded_file|media_handle_upload/);
        const ln = lineAt(def.file.src, def.bodyStart + idx);
        out.push({
          rule: "unrestricted-upload",
          severity: "high",
          title: `\`${def.name}()\` accepts an upload without checking the file type`,
          file: def.file.rel,
          line: ln,
          snippet: def.file.src.split(/\r?\n/)[ln - 1].trim().slice(0, 200),
          detail: "Uploaded files are saved without a MIME/extension allowlist.",
          impact: "Uploading a .php file (a web shell) gives full control of the server.",
          repro: ["Find the upload field that reaches this code (e.g. traveller documents, enquiry attachments).", "Upload `test.php` containing `<?php echo 'x'; ?>` (rename to test.php.jpg as a second try).", "Open the uploaded file's URL. Expected: rejected, or served as a download. Seeing `x` means code execution."],
          fix: "Use wp_handle_upload() with a 'mimes' allowlist and wp_check_filetype_and_ext(); never keep the client's file name.",
          cwe: "CWE-434",
        });
      }
    }
  }
  return out;
}

// ── File-level: direct access ───────────────────────────────────────────────

function directAccess({ files }) {
  const exposed = files.filter((f) => {
    if (/defined\s*\(\s*['"](ABSPATH|WPINC)['"]\s*\)/.test(f.src)) return false;
    // Only files that do something when run: output or top-level calls outside classes.
    return /^\s*(echo|print|\?>|<\?php\s+(echo|if)|\$\w+\s*=|[a-z_]+\s*\()/m.test(f.codeOnly.replace(/^\s*(namespace|use|class|interface|trait|abstract|final|function|declare|require|include)\b[\s\S]*/m, ""));
  });
  if (!exposed.length) return [];
  return [
    {
      rule: "direct-file-access",
      severity: "info",
      title: `${exposed.length} PHP file(s) run when opened directly by URL`,
      file: null,
      line: null,
      snippet: null,
      detail: `These files have no \`defined( 'ABSPATH' ) || exit;\` guard:\n${exposed.slice(0, 20).map((f) => `- \`${f.rel}\``).join("\n")}${exposed.length > 20 ? `\n- …and ${exposed.length - 20} more` : ""}`,
      impact: "Opening them at /wp-content/plugins/<plugin>/<file> can print PHP errors with server paths, or run partial logic.",
      repro: ["Open each file's URL under /wp-content/plugins/<plugin>/ on the site.", "Expected: blank page. Errors or output means it's exposed."],
      fix: "Add `defined( 'ABSPATH' ) || exit;` at the top of every PHP file.",
      cwe: "CWE-425",
    },
  ];
}

// ── The add-on's own JavaScript (not built bundles) ─────────────────────────

const JS_RULES = [
  {
    rule: "dom-xss",
    severity: "medium",
    test: (l) => (/\.(innerHTML|outerHTML)\s*\+?=\s*(?!['"`][^$]*['"`]\s*;?\s*$)/.test(l) || /\binsertAdjacentHTML\s*\(|document\.write\s*\(|\$\([^)]*\)\.(html|append|prepend|after|before)\s*\(\s*[^'"`)\s]/.test(l) || /dangerouslySetInnerHTML/.test(l)) && !/DOMPurify|sanitize|escape/i.test(l),
    title: "HTML built from data in JavaScript (DOM XSS risk)",
    detail: "innerHTML / jQuery .html() / dangerouslySetInnerHTML is given a variable. If it holds a trip title, traveller name, URL param or API value, script in it runs.",
    impact: "XSS in the booking modal, checkout or admin screens.",
    repro: ["Find where this data comes from (trip/room name, traveller field, URL, API response).", "Put `<img src=x onerror=alert(1)>` there (e.g. as a room or traveller name).", "Open the screen that renders it. An alert box means DOM XSS."],
    fix: "Use textContent / React text nodes, or sanitise with DOMPurify before inserting HTML.",
    cwe: "CWE-79",
  },
  {
    rule: "js-eval",
    severity: "medium",
    test: (l) => /\beval\s*\(|new\s+Function\s*\(|setTimeout\s*\(\s*['"`]/.test(l),
    title: "eval()/new Function() in the add-on's JavaScript",
    detail: "Code is built from a string at runtime.",
    impact: "XSS if any input reaches it.",
    fix: "Remove eval; parse data with JSON.parse.",
    cwe: "CWE-95",
  },
  {
    rule: "js-secret-storage",
    severity: "low",
    test: (l) => /(localStorage|sessionStorage)\.setItem\s*\([^)]*(token|card|cvv|password|secret|email|phone|passport)/i.test(l),
    title: "Sensitive data stored in browser storage",
    detail: "localStorage/sessionStorage holds tokens or personal data. Any XSS can read it, and it stays on shared computers.",
    impact: "Data exposure on shared devices or through XSS.",
    fix: "Keep it server-side or in memory only.",
    cwe: "CWE-922",
  },
  {
    rule: "hardcoded-secret",
    severity: "critical",
    test: (l) => SECRET_VALUE.test(l),
    title: "Live API key or private key hard-coded in JavaScript",
    detail: "A string that looks like a live secret key is in the front-end code, which every visitor downloads.",
    impact: "Anyone can use the account.",
    fix: "Remove it, rotate the key, and only ship publishable keys to the browser.",
    cwe: "CWE-798",
  },
];

function jsRules({ dir }) {
  if (!dir) return [];
  const out = [];
  for (const abs of walk(dir, /\.(js|jsx|ts|tsx)$/)) {
    if (/\.min\.js$|[\\/](assets[\\/]lib|lib|libs|third-party|bower_components)[\\/]/.test(abs)) continue;
    const src = fs.readFileSync(abs, "utf8");
    const lines = src.split(/\r?\n/);
    if (!lines.length || src.length / lines.length > 300) continue; // minified bundle
    const rel = path.relative(dir, abs).replace(/\\/g, "/");
    lines.forEach((l, i) => {
      if (/^\s*(\/\/|\*)/.test(l)) return;
      for (const r of JS_RULES) {
        if (r.test(l)) out.push({ rule: r.rule, severity: r.severity, title: r.title, file: rel, line: i + 1, snippet: l.trim().slice(0, 200), detail: r.detail, impact: r.impact, repro: r.repro, fix: r.fix, cwe: r.cwe });
      }
    });
  }
  return out;
}

function runExtraRules(ctx) {
  return [...lineRules(ctx), ...functionRules(ctx), ...directAccess(ctx), ...jsRules(ctx)];
}

module.exports = { runExtraRules };
