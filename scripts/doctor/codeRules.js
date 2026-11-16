// scripts/doctor/codeRules.js
//
// Security rules run over a plugin's PHP source. Each rule returns candidate
// findings; they are leads for a QA to confirm on a live site, not verdicts.
// Every finding names the file:line, why it matters, how to reproduce it on a
// site, and the usual fix, so it can be filed as an issue as-is.
//
// Rules cover what Patchstack / WPScan reports against WP plugins most often
// (missing capability checks on AJAX and REST, missing nonces, SQL built from
// variables, unescaped output of request data, unsafe unserialize/include,
// open redirects), plus WP Travel Engine specifics: prices or totals trusted
// from the request, payment webhooks with no signature check, and booking
// state changed from request data.

const { splitArgs, lineAt, resolveCallback, callbackCode, literal } = require("./php");
const { runExtraRules } = require("./codeRulesExtra");

const NONCE_RE = /\b(check_ajax_referer|wp_verify_nonce|check_admin_referer|verify_nonce|wp_verify_nonce_\w+)\s*\(/;
const CAP_RE = /\b(current_user_can|user_can|is_super_admin|current_user_can_for_blog)\s*\(/;
const SIGNATURE_RE = /\b(hash_hmac|hash_equals|openssl_verify|sodium_crypto_sign_verify_detached|constructEvent|verify_?signature|validate_?signature|verifyWebhook\w*|check_signature|is_valid_signature|verify_webhook\w*)\s*\(/i;
const SUPERGLOBAL = String.raw`\$_(?:GET|POST|REQUEST|COOKIE|SERVER|FILES)\b`;
const SANITIZERS = /\b(sanitize_\w+|absint|intval|floatval|boolval|esc_\w+|wp_kses\w*|wp_validate_\w+|filter_var|is_numeric|in_array|wp_unslash\s*\(\s*\$_\w+\[[^\]]+\]\s*\)\s*\)|\(int\)|\(float\)|\(bool\))/;
const REQUEST_SOURCES = new RegExp(`${SUPERGLOBAL}|\\$request\\s*(?:->\\s*get_(?:param|json_params|body_params|params)\\s*\\(|\\[)|\\$_data\\b|\\$posted_data\\b`);

function snippetAt(file, line) {
  return (file.src.split(/\r?\n/)[line - 1] || "").trim().slice(0, 200);
}

function finding(file, offset, base) {
  const line = lineAt(file.src, offset);
  return { file: file.rel, line, snippet: snippetAt(file, line), ...base };
}

/** Every call to `name(` in code (comments masked), with its argument list. */
function* calls(files, nameRe) {
  const re = new RegExp(`\\b(${nameRe})\\s*\\(`, "g");
  for (const file of files) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(file.masked))) {
      const open = m.index + m[0].length - 1;
      yield { file, name: m[1], offset: m.index, args: splitArgs(file.src, file.masked, open), open };
    }
  }
}

// ── AJAX handlers ───────────────────────────────────────────────────────────

function ajaxHandlers({ files, fnIndex }) {
  const out = [];
  for (const call of calls(files, "add_action")) {
    const [hookArg, cbArg] = call.args;
    if (!hookArg || !cbArg) continue;
    const hook = literal(hookArg.text);
    if (hook === null) {
      if (/wp_ajax_/.test(hookArg.text)) {
        out.push(
          finding(call.file, call.offset, {
            rule: "ajax-dynamic-hook",
            severity: "info",
            title: "AJAX actions registered from a variable — check each one by hand",
            detail: `The hook name is built at runtime (\`${hookArg.text}\`), so the doctor can't tell which actions exist or whether each checks a nonce and capability.`,
            fix: "List the actions this registers and check each handler for check_ajax_referer() and current_user_can().",
            cwe: "CWE-862",
          }),
        );
      }
      continue;
    }
    const m = /^wp_ajax_(nopriv_)?(.+)$/.exec(hook);
    if (!m) continue;
    const nopriv = !!m[1];
    const action = m[2];
    const cb = resolveCallback(cbArg, call.file);
    const { code, def } = callbackCode(cb, fnIndex);
    if (!code) continue;
    const where = def ? `${def.file.rel}:${def.line}` : `${call.file.rel}:${lineAt(call.file.src, call.offset)}`;
    const hasNonce = NONCE_RE.test(code);
    const hasCap = CAP_RE.test(code);
    const writes = /\b(update_option|delete_option|update_post_meta|delete_post_meta|wp_update_post|wp_insert_post|wp_delete_post|update_user_meta|wp_update_user|\$wpdb->(?:insert|update|delete|query)|wp_mail|move_uploaded_file|file_put_contents|unlink)\s*\(/.test(code);
    const reqText = `curl -X POST "$SITE/wp-admin/admin-ajax.php" -d "action=${action}"`;

    if (!nopriv && !hasCap) {
      out.push(
        finding(call.file, call.offset, {
          rule: "ajax-missing-capability",
          severity: writes ? "high" : "medium",
          title: `AJAX action \`${action}\` has no capability check — any logged-in user can run it`,
          detail: `\`wp_ajax_${action}\` is available to every logged-in user (subscribers and customers too). Its handler (${where}) never calls current_user_can()${writes ? " and it changes stored data" : ""}.${/\bis_admin\s*\(/.test(code) ? " It checks is_admin(), but that is true for every admin-ajax.php request, so it doesn't restrict anything." : ""}`,
          impact: writes ? "A subscriber/customer account can change data meant for admins (settings, trips, bookings)." : "A subscriber/customer account can read data meant for admins.",
          repro: [
            "Log in as a Subscriber (or a traveller/customer account).",
            "Copy that session's cookies from the browser.",
            `Send: \`${reqText}\` with those cookies${hasNonce ? " and a nonce taken from a page that subscriber can open" : ""}.`,
            "Expected: 403 / -1. A success response means the check is missing.",
          ],
          fix: "Start the handler with `if ( ! current_user_can( 'manage_options' ) ) { wp_send_json_error( null, 403 ); }` (or the right capability for the action).",
          cwe: "CWE-862",
        }),
      );
    }
    if (!hasNonce) {
      out.push(
        finding(call.file, call.offset, {
          rule: "ajax-missing-nonce",
          severity: !nopriv && writes ? "medium" : "low",
          title: `AJAX action \`${action}\` has no nonce check (CSRF)`,
          detail: `The \`${nopriv ? "wp_ajax_nopriv_" : "wp_ajax_"}${action}\` handler (${where}) never verifies a nonce${nopriv ? " and it is open to visitors who aren't logged in" : ""}.`,
          impact: !nopriv && writes ? "A page on another site can make a logged-in admin's browser run this action without the admin knowing (CSRF)." : "The request can be forged or replayed without a token.",
          repro: [
            nopriv ? "Without logging in:" : "While logged in as an admin, from a page on another origin:",
            `Send: \`${reqText}\` with no \`_wpnonce\`/\`security\` field.`,
            "Expected: -1 / 403. A success response means the action runs without a nonce.",
          ],
          fix: "Call `check_ajax_referer( '<action>_nonce', 'security' );` first and send the nonce from the JS that calls it.",
          cwe: "CWE-352",
        }),
      );
    }
    if (nopriv && writes) {
      out.push(
        finding(call.file, call.offset, {
          rule: "ajax-nopriv-writes",
          severity: "high",
          title: `Visitors who aren't logged in can call \`${action}\`, and it writes data`,
          detail: `\`wp_ajax_nopriv_${action}\` (handler ${where}) changes stored data (options, post meta, posts or the DB) for unauthenticated requests.`,
          impact: "Anyone on the internet can change site data through this action.",
          repro: [`Without logging in, send: \`${reqText}\` plus the fields the handler reads.`, "Check whether the data changed."],
          fix: "Remove the nopriv hook, or limit what it can write and validate everything it accepts on the server.",
          cwe: "CWE-306",
        }),
      );
    }
  }
  return out;
}

// ── REST routes ─────────────────────────────────────────────────────────────

function restRoutes({ files, fnIndex }) {
  const out = [];
  for (const call of calls(files, "register_rest_route")) {
    const [nsArg, routeArg, optsArg] = call.args;
    if (!optsArg) continue;
    const ns = literal(nsArg?.text || "") ?? nsArg?.text;
    const route = literal(routeArg?.text || "") ?? routeArg?.text;
    const label = `${ns}${route}`;
    const opts = optsArg.text;
    const methodsMatch = /['"]methods['"]\s*=>\s*([^,\n]+)/.exec(opts);
    const methods = methodsMatch ? methodsMatch[1].trim() : "GET";
    const writable = /CREATABLE|EDITABLE|DELETABLE|ALLMETHODS|POST|PUT|PATCH|DELETE/i.test(methods);
    const permMatch = /['"]permission_callback['"]\s*=>\s*([^\n]+?)\s*,?\s*\n/.exec(opts + "\n");

    if (!permMatch) {
      out.push(
        finding(call.file, call.offset, {
          rule: "rest-missing-permission",
          severity: writable ? "high" : "medium",
          title: `REST route \`${label}\` has no permission_callback`,
          detail: `Methods: ${methods}. With no permission_callback, WordPress lets anyone call the route (and logs a _doing_it_wrong notice).`,
          impact: writable ? "Anyone can call a route that changes data." : "Anyone can read what this route returns.",
          repro: [`Without logging in: \`curl -i "$SITE/wp-json/${String(ns).replace(/^\//, "")}${route}"\``, "Expected: 401/403."],
          fix: "Add a permission_callback that calls current_user_can() for the right capability.",
          cwe: "CWE-862",
        }),
      );
      continue;
    }
    const permText = permMatch[1].replace(/,\s*$/, "");
    let permCode = "";
    let open = false;
    if (/__return_true/.test(permText)) open = true;
    else {
      const cb = resolveCallback({ text: permText, start: call.offset }, call.file);
      permCode = callbackCode(cb, fnIndex).code;
      // "return true" with no capability check anywhere means it's public.
      if (permCode && !CAP_RE.test(permCode) && !/is_user_logged_in|get_current_user_id/.test(permCode)) open = true;
      // Logged-in is not the same as allowed: any subscriber/customer passes.
      if (permCode && writable && !CAP_RE.test(permCode) && /is_user_logged_in|get_current_user_id/.test(permCode)) {
        out.push(
          finding(call.file, call.offset, {
            rule: "rest-any-logged-in",
            severity: "medium",
            title: `REST route \`${label}\` lets any logged-in user write (${methods})`,
            detail: `permission_callback only checks that someone is logged in (\`${permText}\`). Every Subscriber or customer account passes.`,
            impact: "A customer account can change data meant for admins, or other customers' data if IDs aren't checked.",
            repro: ["Log in as a Subscriber/customer.", `Send a ${methods} request to /wp-json/${String(ns).replace(/^\//, "")}${route} with the X-WP-Nonce from that session.`, "Expected: 403."],
            fix: "Check a specific capability, or that the record belongs to the current user.",
            cwe: "CWE-285",
          }),
        );
      }
      // Only checks capability for one context (e.g. 'edit') — still public for 'view'.
      if (permCode && CAP_RE.test(permCode) && /\breturn\s+true\s*;/.test(permCode) && /context/.test(permCode)) open = "partly";
    }
    if (open) {
      out.push(
        finding(call.file, call.offset, {
          rule: "rest-public-route",
          severity: writable ? "high" : "low",
          title: `REST route \`${label}\` is ${open === "partly" ? "public except in edit context" : "public"} (${methods})`,
          detail: `permission_callback: \`${permText}\`. ${writable ? "The route accepts write methods." : "Read-only: check that what it returns is fine for visitors who aren't logged in (no customer data, prices meant to stay hidden, or settings)."}`,
          impact: writable ? "Visitors who aren't logged in may change data." : "Possible information exposure; also a way to work out IDs (trips, bookings).",
          repro: [`Without logging in: \`curl -s "$SITE/wp-json/${String(ns).replace(/^\//, "")}${String(route).replace(/\(\?P<\w+>[^)]+\)/g, "1")}"\``, "Review the JSON for anything a visitor shouldn't see."],
          fix: writable ? "Require a capability in permission_callback." : "Fine if the data is public on purpose; otherwise require a capability and strip private fields.",
          cwe: "CWE-200",
        }),
      );
    }
  }
  return out;
}

// ── Line-level sinks ────────────────────────────────────────────────────────

const LINE_RULES = [
  {
    rule: "sql-injection",
    severity: "critical",
    test: (l) => /\$wpdb\s*->\s*(query|get_results|get_row|get_var|get_col)\s*\(/.test(l) && !/->\s*prepare\s*\(/.test(l) && new RegExp(SUPERGLOBAL).test(l),
    title: "Request data goes straight into a SQL query",
    detail: "A $wpdb query is built from a superglobal without $wpdb->prepare().",
    impact: "SQL injection: reading or changing any table, including users and bookings.",
    fix: "Use `$wpdb->prepare( '... %d / %s ...', $value )` and validate the input first.",
    cwe: "CWE-89",
  },
  {
    rule: "sql-unprepared",
    severity: "medium",
    test: (l) =>
      /\$wpdb\s*->\s*(query|get_results|get_row|get_var|get_col)\s*\(/.test(l) &&
      !/->\s*prepare\s*\(/.test(l) &&
      !new RegExp(SUPERGLOBAL).test(l) &&
      // a variable other than a table name / $wpdb->prefix inside the query
      /(["'][^"']*\$(?!wpdb\b|table\w*\b|this->table)\w+|\.\s*\$(?!wpdb\b|table\w*\b)\w+)/.test(l),
    title: "SQL query built from a variable without prepare()",
    detail: "A $wpdb query includes a variable that isn't passed through $wpdb->prepare(). Trace where the variable comes from.",
    impact: "SQL injection if the variable can be influenced by a request.",
    fix: "Use $wpdb->prepare() with placeholders.",
    cwe: "CWE-89",
  },
  {
    rule: "xss-echo-request",
    severity: "high",
    test: (l) => /\b(echo|print|printf|_e|die|exit)\b/.test(l) && new RegExp(SUPERGLOBAL).test(l) && !/\besc_(html|attr|url|js|textarea)\w*\s*\(|wp_kses|absint|intval|json_encode|wp_json_encode/.test(l),
    title: "Request data is printed without escaping (reflected XSS)",
    detail: "A superglobal is printed without esc_html()/esc_attr()/esc_url().",
    impact: "A link with a payload can run script in a visitor's or admin's browser.",
    repro: ["Find the page that prints this parameter.", 'Open it with the parameter set to `"><svg onload=alert(document.domain)>`.', "Expected: the payload is shown as text; an alert box means XSS."],
    fix: "Escape on output: `echo esc_html( sanitize_text_field( wp_unslash( $_GET['x'] ) ) );`",
    cwe: "CWE-79",
  },
  {
    rule: "unsafe-unserialize",
    severity: "high",
    test: (l) => /\b(maybe_)?unserialize\s*\(/.test(l) && REQUEST_SOURCES.test(l),
    title: "unserialize() on request data (PHP object injection)",
    detail: "Data from the request is unserialized.",
    impact: "PHP object injection; can lead to code execution or file deletion through POP chains in WP/plugins.",
    fix: "Use json_decode() for client data, or `unserialize( $x, array( 'allowed_classes' => false ) )`.",
    cwe: "CWE-502",
  },
  {
    rule: "file-inclusion",
    severity: "critical",
    test: (l) => /\b(include|require)(_once)?\b/.test(l) && REQUEST_SOURCES.test(l),
    title: "File include path built from request data",
    detail: "include/require uses a value from the request.",
    impact: "Local file inclusion; reading files or running code.",
    fix: "Map the input to an allowlist of known template names; never put it in a path.",
    cwe: "CWE-98",
  },
  {
    rule: "code-exec",
    severity: "critical",
    test: (l) => /\b(eval|assert|create_function|system|exec|shell_exec|passthru|proc_open|popen)\s*\(/.test(l) && !/\bpreg_|->exec\(|curl_exec/.test(l),
    title: "Code/command execution function used",
    detail: "eval/exec-style call. Check whether any input reaches it.",
    impact: "Remote code execution if input reaches it.",
    fix: "Remove it, or make sure only constants reach it.",
    cwe: "CWE-94",
  },
  {
    rule: "open-redirect",
    severity: "medium",
    test: (l) => /\bwp_redirect\s*\(/.test(l) && REQUEST_SOURCES.test(l),
    title: "wp_redirect() to a URL taken from the request (open redirect)",
    detail: "Redirect target comes from the request and wp_redirect() doesn't limit it to the site's hosts.",
    impact: "Phishing: a trusted link on the booking site sends people to an attacker's site.",
    repro: ["Find the request that triggers this redirect.", "Set the redirect parameter to `https://example.org`.", "Expected: stays on the site; going to example.org means an open redirect."],
    fix: "Use wp_safe_redirect() (plus wp_validate_redirect()).",
    cwe: "CWE-601",
  },
  {
    rule: "option-from-request",
    severity: "high",
    test: (l) => /\b(update_option|update_site_option)\s*\(\s*(\$_|sanitize_\w+\s*\(\s*(wp_unslash\s*\()?\s*\$_)/.test(l),
    title: "Option *name* taken from the request",
    detail: "update_option() is called with an option name supplied by the request.",
    impact: "Overwriting any option (users_can_register, default_role=administrator…) lets someone take over the site.",
    fix: "Only accept option names from a hard-coded allowlist.",
    cwe: "CWE-15",
  },
  {
    rule: "mass-extract",
    severity: "high",
    test: (l) => /\bextract\s*\(\s*\$_/.test(l),
    title: "extract() on request data",
    detail: "extract($_POST/$_GET) lets the request overwrite any local variable.",
    impact: "Logic bypass and variable overwriting.",
    fix: "Read the specific keys you need.",
    cwe: "CWE-621",
  },
  {
    rule: "booking-status-from-request",
    severity: "high",
    test: (l) => /(update_post_meta|wp_update_post|update_status|set_status|->set\s*\()/.test(l) && /(status|paid|payment_status|due|amount)/i.test(l) && REQUEST_SOURCES.test(l),
    title: "Booking/payment status written from request data",
    detail: "A booking or payment's status/amount is updated from a value the client sent.",
    impact: "A traveller could mark their own booking as paid.",
    fix: "Only change payment state after verifying with the gateway on the server (API lookup or a signed webhook).",
    cwe: "CWE-639",
  },
  {
    rule: "phpcs-security-suppressed",
    severity: "info",
    test: (l) => /phpcs:(ignore|disable)[^\n]*(NonceVerification|ValidatedSanitizedInput|EscapeOutput|PreparedSQL|DirectDatabaseQuery|InputNotSanitized)/.test(l),
    title: "Security sniff suppressed with phpcs:ignore",
    detail: "A developer silenced a WPCS security warning here. Check that the reason still holds.",
    fix: "Fix the underlying issue, or leave a comment saying why the suppression is safe.",
    cwe: "",
    raw: true, // runs on comments, so use the unmasked source
  },
];

function lineSinks({ files }) {
  const out = [];
  for (const file of files) {
    const code = file.codeOnly.split(/\r?\n/);
    const raw = file.src.split(/\r?\n/);
    for (const r of LINE_RULES) {
      const lines = r.raw ? raw : code;
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i].trim() || !r.test(lines[i])) continue;
        out.push({
          rule: r.rule,
          severity: r.severity,
          title: r.title,
          file: file.rel,
          line: i + 1,
          snippet: raw[i].trim().slice(0, 200),
          detail: r.detail,
          impact: r.impact,
          repro: r.repro,
          fix: r.fix,
          cwe: r.cwe,
        });
      }
    }
  }
  return out;
}

// ── Client-trusted prices (light per-function data trace) ───────────────────
//
// WP Travel Engine passes what the browser posted for a booking into add-on
// hooks as $attributes / $posted_data / $cart_data… (e.g.
// wptravelengine_before_add_item_to_cart). A money field read from those is a
// client-chosen price. Within one function: mark request-derived variables,
// follow them through assignments and foreach, then flag money keys read from them.

const TAINTED_PARAMS = /^\$(attributes|attrs|request|posted_data|post_data|posted|cart_data|form_data|booking_data|checkout_data|payload|body|params|request_data)$/;
const MONEY_KEY = /^\w*(price|total|amount|cost|subtotal|discount|deposit|due|fee|tax)\w*$/i;

function clientPrices({ fnIndex }) {
  const out = [];
  for (const defs of fnIndex.values()) {
    for (const def of defs) {
      const body = def.body;
      const header = def.file.codeOnly.slice(def.start, def.bodyStart);
      const tainted = new Set();
      for (const m of header.matchAll(/\$\w+/g)) if (TAINTED_PARAMS.test(m[0])) tainted.add(m[0]);
      // Seed from direct request reads.
      for (const m of body.matchAll(new RegExp(`(\\$\\w+)\\s*=\\s*[^;]*?(${SUPERGLOBAL}|\\$request\\s*->\\s*get_\\w+\\s*\\()`, "g"))) tainted.add(m[1]);
      if (/\$_(POST|REQUEST|GET)\b/.test(body)) ["$_POST", "$_REQUEST", "$_GET"].forEach((v) => tainted.add(v));
      if (!tainted.size) continue;
      // Propagate (a few passes is plenty for one function).
      for (let pass = 0; pass < 4; pass++) {
        const before = tainted.size;
        for (const m of body.matchAll(/(\$\w+)\s*=(?!=|>)\s*\(?\s*(\$\w+)/g)) if (tainted.has(m[2])) tainted.add(m[1]);
        for (const m of body.matchAll(/foreach\s*\(\s*(\$\w+)[^;{]*?\bas\s+(?:\$\w+\s*=>\s*)?(\$\w+)\s*\)/g)) if (tainted.has(m[1])) tainted.add(m[2]);
        if (tainted.size === before) break;
      }
      const reported = new Set();
      const bodyLines = body.split("\n");
      const firstLine = lineAt(def.file.src, def.bodyStart);
      bodyLines.forEach((text, i) => {
        if (/^\s*(if|elseif)?\s*\(?\s*!?\s*(isset|empty)\s*\(/.test(text) && !/=[^=]/.test(text.replace(/isset\([^)]*\)/g, ""))) return;
        for (const m of text.matchAll(/(\$\w+)((?:\s*\[\s*['"]\w+['"]\s*\])+)/g)) {
          if (!tainted.has(m[1])) continue;
          const keys = [...m[2].matchAll(/['"](\w+)['"]/g)].map((k) => k[1]);
          const key = keys[keys.length - 1];
          if (!MONEY_KEY.test(key)) continue;
          // Ignore pure existence checks / writes into the request array.
          const after = text.slice(m.index + m[0].length);
          if (/^\s*=(?!=)/.test(after)) continue;
          const line = firstLine + i;
          if (reported.has(line)) continue;
          reported.add(line);
          out.push({
            rule: "client-trusted-price",
            severity: "high",
            title: `\`${def.name}()\` uses \`${key}\` sent by the browser (booking amount can be tampered with)`,
            file: def.file.rel,
            line,
            snippet: (def.file.src.split(/\r?\n/)[line - 1] || "").trim().slice(0, 200),
            detail: `\`${m[0].trim()}\` comes from request data (${[...tainted].filter((t) => TAINTED_PARAMS.test(t) || t.startsWith("$_")).join(", ") || "request"} → ${m[1]}). In WP Travel Engine the cart and booking amounts must be recomputed on the server from trip/package/add-on settings.`,
            impact: "A booking can be paid for less than its configured price.",
            repro: [
              "Start a booking on a trip with a known price and choose the option this code prices.",
              "In DevTools → Network (or a proxy), find the add-to-cart request (`admin-ajax.php?action=wte_add_trip_to_cart` or the REST cart call).",
              `Replay it with the \`${key}\` field lowered (e.g. 1).`,
              "Expected: the checkout total doesn't change. A lower total means the price sent by the browser is trusted.",
            ],
            fix: `Don't read \`${key}\` from the request; look it up from the saved trip/settings by ID and compute totals on the server.`,
            cwe: "CWE-602",
          });
        }
      });
    }
  }
  return out;
}

// ── Payment webhooks / IPN ──────────────────────────────────────────────────

function webhooks({ files, fnIndex }) {
  const out = [];
  const seen = new Set();
  const HOOKISH = /(webhook|ipn|notify|notification|callback|listener|return_url|payment_response)/i;
  // Handlers reached through hooks/routes whose name looks like a webhook.
  for (const call of calls(files, "add_action|register_rest_route")) {
    // Match on the hook name / route path only, never on option keys like 'callback' =>.
    const all = call.name === "register_rest_route" ? `${call.args[0]?.text || ""}${call.args[1]?.text || ""}` : call.args[0]?.text || "";
    if (!HOOKISH.test(all)) continue;
    if (!/(wp_ajax|woocommerce_api_|init|template_redirect|rest_api_init|parse_request|wte_|wp_travel_engine|wptravelengine)/.test(all) && call.name === "add_action") continue;
    let cbArg = call.args[1];
    if (call.name === "register_rest_route" && call.args[2]) {
      const cm = /['"]callback['"]\s*=>\s*([^\n]+?)\s*,?\s*\n/.exec(call.args[2].text + "\n");
      if (!cm) continue;
      cbArg = { text: cm[1], start: call.offset };
    }
    if (!cbArg) continue;
    const cb = resolveCallback(cbArg, call.file);
    const { code, def } = callbackCode(cb, fnIndex);
    if (!code || !/(payment|paid|status|order|booking|transaction|amount)/i.test(code)) continue;
    const key = def ? `${def.file.rel}:${def.line}` : `${call.file.rel}:${call.offset}`;
    if (seen.has(key) || SIGNATURE_RE.test(code)) continue;
    // Accept a server-side lookup against the gateway as verification too.
    if (/wp_remote_(get|post|request)\s*\(/.test(code) && /(verify|retrieve|status|transaction|payment)/i.test(code)) continue;
    seen.add(key);
    out.push(
      finding(def ? def.file : call.file, def ? def.start : call.offset, {
        rule: "webhook-no-signature",
        severity: "high",
        title: `Payment callback \`${cb?.name || "closure"}\` updates payment state without verifying the gateway's signature`,
        detail: `Reached from \`${all.slice(0, 120)}\`. The handler touches payment/booking state but has no HMAC/signature check (hash_hmac / hash_equals / SDK verify) and doesn't look the payment up with the gateway.`,
        impact: "A forged webhook/IPN can mark an unpaid booking as paid.",
        repro: [
          "Make a booking and leave it unpaid (pick the gateway but abandon the payment page).",
          "Send the webhook URL a copy of the gateway's success payload with that booking/order ID and no (or a wrong) signature header.",
          "Expected: rejected (400/401) and the booking stays pending. A booking marked paid means the webhook can be forged.",
        ],
        fix: "Verify the gateway's signature header with hash_equals( hash_hmac( ..., $secret ), $sig ) on the raw body, or look the payment up through the gateway API before changing the booking.",
        cwe: "CWE-345",
      }),
    );
  }
  return out;
}

const RULE_SETS = [ajaxHandlers, restRoutes, lineSinks, clientPrices, webhooks];

function runCodeRules(ctx) {
  return [...RULE_SETS.flatMap((rule) => rule(ctx)), ...runExtraRules(ctx)];
}

module.exports = { runCodeRules, LINE_RULES };
