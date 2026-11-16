---
name: security-testing
description: Security-test a WP Travel Engine add-on or site with the built-in "WPTE Doctor" scanner (scripts/doctor.js) and its UI (Security tab in npm run ui). Use for any security scenario — scan an add-on's PHP/JS for vulnerabilities, probe a live site read-only (REST exposure, exposed files, headers, TLS, user enumeration), fuzz the WP Travel Engine REST API, check libraries for known CVEs, log in as a low-permission user to test access control, build payload URLs / full curl requests from a target (XSS, SQLi, traversal, SSRF, open-redirect, template, email-header, boundary/price tampering), work the manual security checklist (booking/payment tampering, IDOR, CSRF, uploads, logins), read the threat model / OWASP / PCI audit, or turn a finding into a filed issue. Use it even when the user only says "security", "vulnerability", "pentest", "fuzz", "is this endpoint safe", "price tampering", "payload", or pastes a REST/AJAX response, a 500/stack trace, or a curl command and asks whether it's a problem. Detection only, authorized/own targets only — never changes WP Travel Engine code or the site.
---

# Security testing (WPTE Doctor)

One skill for security-testing WP Travel Engine and its add-ons. The scanner
lives in this QA project and only **reads** code and makes HTTP requests — it
never edits the plugin or writes to the site. Find the scenario below and
follow it. `references/checks.md` holds the full rule catalogue (what each
finding means, how to confirm it on a site, and the fix) and the WP Travel
Engine attack surface (real endpoints worth testing).

## Golden rules

- **Authorized / own targets only.** Point site probes, fuzzing and payloads at QA sites you own or may test (e.g. `http://rabin.local`, `https://rabin.1wp.site`). Never a third party.
- **Detection only.** Probes prove a weakness *exists* (an error, an alert, a redirect). For SQLi stop at "a quote causes a DB error" — never extract data.
- **Never change engine code.** The scanner reads the add-on source and reports; any fix is a recommendation for the plugin developers, not something to apply here.
- **Findings are leads.** The code scan pattern-matches; confirm each on the QA site before filing.

## Where things live

| What | Where |
| --- | --- |
| Scanner CLI | `scripts/doctor.js` (`npm run doctor -- …`) |
| Code rules (PHP) | `scripts/doctor/codeRules.js`, `scripts/doctor/codeRulesExtra.js` |
| Site probes (read-only) | `scripts/doctor/siteProbes.js` (REST, files, headers, TLS, fuzz, low-priv) |
| Dependency CVE check | `scripts/doctor/deps.js` (OSV.dev) |
| Detection payloads | `scripts/doctor/payloads.js` |
| URL / request builders | `scripts/doctor/urlBuilder.js`, `scripts/doctor/requestBuilder.js` |
| Manual checklist | `scripts/doctor/checklist.js` |
| Threat model / OWASP / PCI | `scripts/doctor/standards.js` |
| UI (Security tab) | `scripts/addonsUi.js` + `scripts/addonsUi.html` → `npm run ui` → **Security** |
| Saved reports | `data/doctor/<target>/report.json` (+ `report.md`); ignore list `ignore.json` |
| Low-priv test account | `.env` → `SECURITY_TEST_USER` / `SECURITY_TEST_PASSWORD` (a Subscriber, never an admin) |

The seven testing types map onto the tool as: vulnerability scanning + config = site probe & deps; code review = code scan + manual code-review checklist; fuzzing = `--fuzz`; pen testing = manual checklist; threat modeling + auditing = the Threat model / Audit tabs.

---

## Scenario 1: Scan an add-on's code

```
npm run doctor -- --repo <slug|folder|git-url>
npm run doctor -- --repo wptravelengine-accommodation          # a cloned add-on under data/addons/<slug>/repo
npm run doctor -- --repo E:/code/wp-travel-engine               # any local plugin folder (e.g. WTE core)
npm run doctor -- --repo https://github.com/org/plugin.git      # clones first
npm run doctor -- --repo <x> --deps                             # also check libraries against OSV.dev
npm run doctor -- --repo <x> --min high                         # high+ only
```

Reads every PHP (and the add-on's own JS/JSX) and flags the rule hits in
`references/checks.md` — client-trusted prices, missing capability/nonce on
AJAX & REST, IDOR, privilege escalation, SQLi, XSS (reflected/stored/shortcode/DOM),
CSV injection, path traversal, SSRF, unsafe unserialize, unrestricted upload,
webhook-without-signature, hard-coded secrets, weak randomness, and more. Each
finding is a lead; confirm on the QA site. Exit code 2 if any critical/high.

## Scenario 2: Probe a live site (read-only)

```
npm run doctor -- --site http://rabin.local
npm run doctor -- --site http://rabin.local --fuzz              # also fuzz the WTE REST API (slower)
```

Not-logged-in GET/HEAD only. Checks: REST data exposure (settings/bookings/
customers/paylexer gateways), private post types, user enumeration (`/wp/v2/users`,
`?author=1`), XML-RPC, HTTPS + security headers, TLS cert/protocols/cookies,
exposed files (`.git`, `wp-config` backups, debug.log, phpinfo, dir listings),
reflected XSS in search, PHP error disclosure, plugin version.
`--fuzz` sends malformed values to every WTE route parameter and path ID and
flags 500s, DB errors, PHP errors and very slow answers. A run that loses >15%
of requests is discarded (so a flaky host can't look "clean").

Add a logged-in pass (grey-box) by setting `SECURITY_TEST_USER` /
`SECURITY_TEST_PASSWORD` in `.env` to a **Subscriber** account, or
`--user U --pass P`. It refuses to run as an admin. It flags any admin screen or
admin-only REST data that account can reach.

## Scenario 3: Run it in the UI

`npm run ui` → open **Security** (bottom-left, next to Settings). Tabs:
**Overview** (the 7 testing types + progress), **Automated scan** (run code +
site + deps + fuzz + low-priv, pick a saved report, mark findings "not a bug",
Copy as issue), **Manual tests** (the checklist, Pass/Fail/N·A + notes),
**Payloads** (detection strings + the Request builder), **Threat model**,
**Audit** (OWASP Top 10 + PCI). Reports read fresh from `data/doctor/` on each
load. If the Security link is missing, the running `npm run ui` is stale —
restart it and hard-reload (Ctrl+Shift+R).

## Scenario 4: Build payload URLs / full requests from a target

Turn a real request into one-change-per-request detection tests (query → clickable
URL, body → curl; includes a boundary block for numeric/price/date fields and a
"what to watch" checklist):

```
npm run doctor -- --url "http://rabin.local/?s=test&redirect=/thanks"          # GET params
npm run doctor -- --url "<url>" --params redirect --classes ssrf,redirect
npm run doctor -- --request path/to/request.txt --params price --classes boundaries
```

`--request` reads a file holding a plain URL, a **curl command** (DevTools →
Copy as cURL, carries the nonce+cookie) or a **raw HTTP request** (Burp). In the
UI the same lives under **Payloads → Request builder** (paste → Build test plan).
Payload reference and copyable detection strings: **Payloads** tab, or
`scripts/doctor/payloads.js`.

## Scenario 5: The manual checklist (what a scanner can't do)

Open **Security → Manual tests** (or `scripts/doctor/checklist.js`). Work the
high-risk areas first — booking/price tampering, payments & webhooks, access
control between users (IDOR), forms & XSS — using a second customer account and
DevTools "Edit and Resend". Mark Pass/Fail/N·A; a failed test gets Copy as issue.
Results persist in `data/doctor/checklist.json`.

## Scenario 6: Someone pastes a response / 500 / curl and asks "is this an issue?"

1. Note whether the request was **logged out** or not — most exposure findings only count for anonymous users.
2. **Public trip data** (prices, package names, published trips, availability) is **not** a leak — it's on the trip page anyway. Customer/booking/settings/secret-key data is.
3. Re-check with `context=edit` and `?status=draft/any` as anonymous — these must be denied (401/400). If denied, access control is fine.
4. A **500 / PHP fatal** on a bad/nonexistent ID (e.g. `trips/0/dates`) is a real robustness + info-disclosure finding (the route is valid, the resource isn't → should be 404). The server-path/stack trace only shows when `WP_DEBUG_DISPLAY` is on (dev/Local); on production it's a blank 500, so split it: crash = real everywhere, path leak = config-only.
5. Confirm by hand with curl (anon, and a bad-input variant), then record it. See `references/checks.md` for the per-rule confirm/fix.

## Scenario 7: Turn a finding into a filed issue

In the UI, open the finding → **Copy as issue** (includes severity, file:line or
URL, impact, steps, fix). Or from a report, each finding in `report.json` already
carries `detail`, `impact`, `repro`, `fix`, `cwe`. Enrich a finding's `detail`
with confirmed root cause (e.g. a stack trace) by editing `data/doctor/<target>/report.json`
— that's a QA-project file, not engine code. Mark a false positive with **Not a
bug** (adds its id to `ignore.json`, hidden in future scans). Re-scan after a fix
to see it move to "Fixed since last scan".

## Known confirmed findings (examples)

- **Accommodation add-on** — `Checkout.php` reads room `price`/`actual_price`/`total` from the browser (client-trusted price → booking total tampering). High.
- **WTE core REST** — `/wptravelengine/v2|v3/trips/{id}/dates` and `/trips/{id}/packages` throw an **unauthenticated 500 + server-path disclosure** on a nonexistent trip id (`0`, huge numbers). Root cause: `get_dates()` → `PostModel::make($id)` without an existence check (`V2/Trip.php:157/1373` → `PostModel.php:84`). Fix: validate `get_post_type($id) === 'trip'` → 404.
- **rabin.local** — username enumeration (`/wp/v2/users`, `?author=1`), XML-RPC enabled, missing security headers (low), readme public (info). Access control on trip/packages/dates (view vs edit, publish vs draft) is correctly enforced.
