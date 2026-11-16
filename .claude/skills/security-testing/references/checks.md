# Checks reference

Every rule the scanner reports, what it means, how to confirm it on a QA site,
and the usual fix. Rules live in `scripts/doctor/codeRules.js` (base),
`codeRulesExtra.js` (more code + JS), `siteProbes.js` (live-site), `deps.js`
(CVEs). Severity shown is the default; confirm before filing.

## Code rules — PHP

| rule | sev | means / confirm | fix |
| --- | --- | --- | --- |
| `client-trusted-price` | high | A money field (price/total/amount/discount/deposit) is read from `$attributes`/`$_POST`/request. Confirm: in DevTools replay the add-to-cart/checkout request with the field lowered; if the total follows, it's trusted. | Recompute every amount on the server from saved trip/package/add-on settings; ignore client amounts. |
| `ajax-missing-capability` | high/med | `wp_ajax_<action>` handler never calls `current_user_can()`. Confirm: as a Subscriber, POST `admin-ajax.php?action=<action>`; a success = any logged-in user can run it. `is_admin()` is NOT an auth check. | Start the handler with a capability check; `wp_send_json_error(null,403)` otherwise. |
| `ajax-nopriv-writes` | high | `wp_ajax_nopriv_<action>` writes data (options/meta/posts/DB). Confirm: logged out, POST the action; check the data changed. | Remove nopriv or restrict + validate. |
| `ajax-missing-nonce` | med/low | AJAX handler has no `check_ajax_referer()` (CSRF). | `check_ajax_referer('<action>','security')` + send nonce from JS. |
| `rest-missing-permission` | high/med | `register_rest_route` with no `permission_callback`. Confirm: call it logged out. | Add a `permission_callback` with `current_user_can()`. |
| `rest-public-route` / `rest-any-logged-in` | high/med/low | `permission_callback` is `__return_true`, or only checks `is_user_logged_in()` on a writable route. Confirm: call logged out / as Subscriber. | Require the right capability, or an ownership check on IDs. |
| `idor` | high | Loads a record by a request ID (booking/order/customer) with no ownership/key check. Confirm: with two customer accounts, change the ID to the other's booking. | After loading, check it belongs to `get_current_user_id()` or verify a secret key; else 403. |
| `privilege-escalation` | critical | Role/login set from request (`role=>$_POST`, `wp_insert_user`, `set_role`, `wp_set_auth_cookie`). Confirm: add `role=administrator` to the registration request. | Never take role/caps/user-id from the request; hard-code the role. |
| `sql-injection` / `sql-unprepared` | critical/med | `$wpdb->query/get_*` built with request data / a variable, no `prepare()`. Confirm (detection only): send `'` in the parameter; a DB/SQL error = injectable. Stop there. | `$wpdb->prepare()` with placeholders; allowlist table/column names. |
| `xss-echo-request` | high | Request data printed without escaping (reflected). Confirm: open the page with `"><svg onload=alert(1)>`. | Escape on output (`esc_html`/`esc_attr`/`esc_url`). |
| `stored-xss-meta` | med | Request data saved to meta/option without sanitising (stored XSS). Confirm: save `<img src=x onerror=alert(1)>`; open every place it's shown (wp-admin, emails, front end). | Sanitise on save + escape on output. |
| `shortcode-xss` | med | Shortcode attribute printed raw (a Contributor can inject). | Escape each attribute on output. |
| `csv-injection` | med | `fputcsv` without neutralising leading `= + - @`. Confirm: book with `=HYPERLINK("https://example.org","x")`, export, open in Excel. | Prefix such cells with `'`. |
| `path-traversal` | high | File function path built from request. Confirm: set the file param to `../../../../wp-config.php`. | Allowlist file names; `basename()`+`realpath()` inside the allowed dir. |
| `ssrf` | med | Server fetches a request-supplied URL (`wp_remote_*`, curl). Confirm: point it at your request-catcher, then `http://127.0.0.1/`. | `wp_safe_remote_*`; allowlist hosts. |
| `file-inclusion` / `code-exec` | critical | `include`/`require` or `eval`/`exec` reaches request data. | Allowlist; never put input in a path or eval. |
| `unsafe-unserialize` | high | `unserialize()` on request data (object injection). | `json_decode`, or `allowed_classes=>false`. |
| `open-redirect` | med | `wp_redirect()` to a request URL. Confirm: set the redirect param to `https://example.org`. | `wp_safe_redirect()` + `wp_validate_redirect()`. |
| `option-from-request` | high | `update_option()` with a request-supplied option name. | Allowlist option names. |
| `unrestricted-upload` | high | Upload with no MIME/extension check. Confirm: upload `test.php`/`test.php.jpg`; open its URL. | `wp_handle_upload` with a `mimes` allowlist; never keep the client filename. |
| `webhook-no-signature` | high | Payment callback updates booking/payment state without HMAC/signature or a gateway lookup. Confirm: POST the gateway's success payload for an unpaid booking with no/invalid signature. | Verify the signature on the raw body (`hash_equals`) or look the payment up via the gateway API. |
| `booking-status-from-request` | high | Booking/payment status written from request data. | Only change payment state after verifying with the gateway. |
| `hardcoded-secret` | critical | Live key / private key in source (sk_live, whsec, AWS, Google, Slack, GitHub, PEM). | Remove, rotate at the provider, load from settings/constants. |
| `weak-random` | med | `rand/mt_rand/uniqid/time` used for a token/key/code. | `wp_generate_password(32,false)` / `random_bytes` / `wp_rand`. |
| `weak-password-hash` | med | Password via md5/sha1/base64. | `wp_hash_password`/`wp_check_password`. |
| `debug-leftover` / `log-sensitive` | low | `var_dump`/`print_r`/`phpinfo` left in; `error_log` of request/card/secret data. | Remove; don't log request bodies or secrets. |
| `direct-file-access` | info | PHP files with no `defined('ABSPATH')||exit;` guard. | Add the guard to every PHP file. |
| `phpcs-security-suppressed` | info | A `phpcs:ignore` silenced a security sniff — check the reason still holds. | Fix the issue or justify the suppression. |

## Code rules — the add-on's own JS/JSX

| rule | sev | means | fix |
| --- | --- | --- | --- |
| `dom-xss` | med | `innerHTML` / jQuery `.html()` / `dangerouslySetInnerHTML` fed a variable (trip/room/traveller name, URL, API value). Confirm: put `<img src=x onerror=alert(1)>` in that source. | `textContent` / React text nodes, or DOMPurify. |
| `js-eval` | med | `eval`/`new Function`/`setTimeout('string')`. | Remove; parse with JSON.parse. |
| `js-secret-storage` | low | token/card/email in localStorage/sessionStorage. | Keep server-side / in memory. |
| `hardcoded-secret` | critical | live key in front-end JS. | Ship only publishable keys. |

Minified files and `assets/lib`/`vendor` are skipped.

## Site probes (anonymous, read-only)

`rest-leaks-secret` (crit), `rest-anon-data` / `anon-private-records` /
`lowpriv-*` (access control), `user-enumeration` / `author-enumeration` (low),
`xmlrpc-enabled` / `wp-readme` (low/info), `no-https` / `no-https-redirect` /
`tls-cert` / `tls-old-protocol` / `cookie-flags` (config), `security-headers` /
`server-version` (low/info), `debug-log-exposed` / `env-exposed` /
`config-backup-exposed` / `git-exposed` / `phpinfo-exposed` / `error-log-exposed`
/ `dir-listing` (exposed files), `reflected-xss` (high), `php-error-disclosure`
(med), `version-disclosure` (info). Fuzz: `fuzz-db-error` (high, likely SQLi),
`fuzz-server-error` (med, 500), `fuzz-php-error` (med), `fuzz-slow` (low).
Dependencies: `vulnerable-dependency` (severity from OSV.dev).

## WP Travel Engine attack surface (real endpoints to test)

Pull the live list per site with `GET /wp-json/` (filter `wptravelengine`).
Priority order (test logged out, then as a Subscriber):

1. **Secret leak** — `/wptravelengine/v2/paylexer/gateways`, `/wptravelengine/v2/settings` (look for `sk_live`, keys).
2. **Customer/booking data** — `/wptravelengine/v2/bookings`, `/bookings/{id}`, `/wptravelengine/v1/analytics/customers`, `/analytics/customers_table`.
3. **Price tampering (POST, Copy as cURL)** — `admin-ajax.php?action=wte_add_trip_to_cart` (params `price,quantity,pax,total`), checkout/place-order (`total,deposit,coupon`), nested JSON cart (`items.0.price`).
4. **IDOR / crash on IDs** — `/trips/{id}/dates`, `/trips/{id}/packages` (bad id → 500, confirmed), `/bookings/{id}`.
5. **Access control** — any route with `?context=edit` and `?status=draft/any` as anon must be denied (401/400).
6. **XSS** — `/?s=<payload>`, trip search/destination/activities/min-max-cost params; traveller/enquiry/review form fields.
7. **Admin-only** — `/wptravelengine/v2/trips/{id}` POST/PUT, `DELETE /trips/{id}/packages/{pid}` — run as a Subscriber; must be denied.

## STRIDE threat model (ranked, from `standards.js`)

Highest risk first: pay less than real price (T1), unpaid booking marked paid
(T2), one customer sees another's booking/PII (T3), gateway secret keys leaked
(T4), low-priv user gains admin (T5), stored XSS runs for admins (T6). Each
threat in the Threat model tab links to the scan rules + manual tests that cover
it and shows pass/found/untested. Audit tab maps the same onto OWASP Top 10
(2021) and PCI DSS 4.0 (payment-page scope).
