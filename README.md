# WP Travel Engine — QA & security automation

Playwright QA automation and security testing for **WP Travel Engine**:

- **Add-on test suites** — the Accommodation extension end to end (settings UI, trip editor, front-end booking through checkout).
- **WPTE Doctor** — a security scanner for add-ons and the live site (code review, read-only site probes, API fuzzing, dependency CVEs), with a **Security** tab in the runner UI.
- **Add-on QA runner** — a local UI (`npm run ui`) for running the suites and the scans.

## Setup

```bash
npm run setup                 # npm install + Playwright Firefox
cp env.example .env           # then fill in .env (see below)
npm run auth                  # sign in to wp-admin once, saves playwright/.auth/user.json
npm run test:accommodation    # run the Accommodation suite
```

In `.env`, fill in:

- `WP_LOGIN_URL`, `WP_USERNAME`, `WP_PASSWORD` — the WordPress site running WP Travel Engine.
- `FRONTEND_URL` — the site under test (front end / REST base).
- `STRIPE_PUBLISHABLE_KEY`, `STRIPE_SECRET_KEY` — **test** keys; the accommodation checkout pays through WPTE's Stripe add-on.
- `SECURITY_TEST_USER` / `SECURITY_TEST_PASSWORD` — a Subscriber account, for the scanner's logged-in checks (never an admin).

Run `npm run auth` again whenever a run says the session has expired.

## Commands

| Command | What it does |
| --- | --- |
| `npm run ui` | Opens the add-on QA runner at http://localhost:4417 |
| `npm run test:accommodation` | Runs the Accommodation suite (headed; `PW_HEADLESS=1` for headless) |
| `npm run doctor -- --repo <slug\|folder\|git-url>` | Security-scan an add-on's code |
| `npm run doctor -- --site <url> [--fuzz]` | Read-only security probe of a live site |
| `npm run auth` | Refreshes the saved WordPress session |
| `npm run report` | Opens the HTML report (screenshot, trace, failing API calls) |

## Accommodation add-on (`tests/accommodation.spec.js`)

Covers the WP Travel Engine **Accommodation** extension end to end. Needs
`FRONTEND_URL`, `WP_USERNAME` and `WP_PASSWORD`; if the saved session has expired it
logs into wp-admin by itself.

| Command | What it does |
| --- | --- |
| `npm run test:accommodation` | Runs the whole suite (headed; add `PW_HEADLESS=1` for headless) |
| `ACCOMMODATION_CLEANUP=1 npm run test:accommodation` | Same, then deletes the QA trips, rooms and upgrades |

What it checks, in order:

1. **Extension**: listed on **WP Travel Engine > Extensions**, licensed and Active
   (activates the plugin / license if `ACCOMMODATION_LICENSE_KEY` is set), then turns on
   **Settings > Extensions > Accommodation > Enable**.
2. **Settings UI**: title/description, pricing format (Per Traveler → *Allow Shared Room
   Bookings* → *Shared Occupancy Notice*), Mandatory For, and adding/disabling/deleting
   room types and upgrades. Each save is read back over REST.
3. **Trip editor UI**: the trip's Accommodation tab — room price, descriptions, *Included
   in Package*, the enable switch, upgrades.
4. **Front-end booking**: one QA trip per feature (`config/accommodationData.js`) booked
   through to checkout; payment completes through WPTE's Stripe add-on (test keys).

QA trips are created through the WPTE REST API and reused on later runs; everything the
suite creates starts with `QA `. Tests run one at a time because pricing format, sharing
and Mandatory For are site-wide settings, which are restored when the run ends.

## Security testing — WPTE Doctor (`npm run doctor`, Security tab)

```bash
npm run doctor -- --repo wptravelengine-accommodation       # scan an add-on's code
npm run doctor -- --repo E:/code/wp-travel-engine --deps    # any local plugin + library CVEs
npm run doctor -- --site http://your-site.local --fuzz      # read-only site probe + API fuzzing
```

- **Code rules** — client-trusted prices, missing AJAX/REST capability & nonce checks,
  IDOR, privilege escalation, SQLi, XSS (reflected/stored/shortcode/DOM), CSV injection,
  path traversal, SSRF, unsafe unserialize, unrestricted upload, webhook-without-signature,
  hard-coded secrets, weak randomness, and more.
- **Site probes** (read-only, logged-out) — REST data exposure, user enumeration, XML-RPC,
  HTTPS/headers/TLS/cookies, exposed files, reflected XSS, PHP error disclosure, version.
- **Fuzzer** — grey-box REST fuzzing: mutation-based + schema-aware generation, categorized
  corpus, crash/exception/reflected/size-deviation monitoring, reproducibility triage.
- **Dependency CVEs** via OSV.dev; **logged-in** probes as a low-permission user.
- Payloads, URL/request builders, a manual checklist, and a STRIDE threat model + OWASP/PCI
  audit — all surfaced in the **Security** tab of `npm run ui`.

Reports are saved under `data/doctor/<target>/` (gitignored). Detection only, authorized
targets only — the scanner never changes plugin code or the site. See the
`security-testing` skill (`.claude/skills/security-testing`) for the full workflow.

## Add-on QA runner (`npm run ui`)

A local UI for every WP Travel Engine add-on. The add-on list comes from `config/addons.js`.

- **Index**: add-ons grouped by category, search, filters, last result, coverage.
- **Add-on page**: Features (tests grouped by `test.describe`), Run (live browser view +
  output), History, Fixtures, and **QA Report** (source-read findings with severity, GitHub
  line links and steps).
- **Security tab**: Overview (the seven testing types), Automated scan (code + site + deps +
  fuzz + low-priv), Manual tests, Payloads (+ Request builder), Threat model, Audit.
- Runs go one at a time across all add-ons, because they share one site.

To automate another add-on, write `tests/<name>.spec.js` and set `spec` on its entry in
`config/addons.js`. Results and history are kept under `data/addons/<slug>/`.

## Layout

```
config/
  session.js             saved-session resolution (resolveAuthFile, hasSavedSession)
  wpteApi.js             thin WP Travel Engine REST client (fixtures, settings)
  addons.js              the add-on catalogue the runner UI reads
  accommodationData.js   QA trips/rooms/upgrades for the accommodation suite
pages/
  WPLoginPage.js                 wp-admin sign-in (npm run auth)
  WpteExtensionsPage.js          WP Travel Engine > Extensions
  AccommodationSettingsPage.js   global Accommodation settings
  TripAccommodationPage.js       the trip editor's Accommodation tab
  AccommodationBookingPage.js    the front-end booking flow
  WpteStripeCheckoutPage.js      WPTE Stripe checkout (billing → card → pay)
tests/
  accommodation.spec.js   the Accommodation suite
  login.setup.js          npm run auth (WordPress login)
  support/                live-view and network/console fixtures
scripts/
  addonsUi.js             the runner UI server (npm run ui)
  doctor.js, doctor/      WPTE Doctor security scanner (npm run doctor)
  repoAudit.js            QA-Report repo clone + finding re-location
  slackNotify.js, schedule.js   optional Slack reports and scheduled runs
.claude/skills/
  security-testing/       the WPTE Doctor workflow for Claude Code
```

## When a run fails

- Open `npm run report`. The failed test includes a screenshot, a trace, and
  `network`/`console` attachments; the last failed API call before the error is marked as
  the likely cause.
- `error-context.md` next to the screenshot shows the page's accessibility snapshot, with
  the real field names and the iframe that holds them.
