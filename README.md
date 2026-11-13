# WPTE test automation

Playwright automation for PayLexer payment gateways on **WP Travel Engine**.
One run covers the whole path: the PayLexer dashboard, the PayLexer WordPress
plugin, WPTE's gateway and currency settings, booking a trip, the WPTE
checkout, the gateway's card or redirect page, and the Thank You page.

This was ported from `paylexer-playwright`, keeping only the WP Travel Engine
(`wte`) platform. The WooCommerce, EDD, FluentCart and Tutor LMS flows were
left out, and so were the dashboard UI, Slack, run history and Docker.

## Setup

```bash
npm run setup                 # npm install + Playwright Firefox
cp env.example .env           # then fill in .env (see below)
npm run auth                  # sign in to PayLexer + wp-admin once, saves playwright/.auth/user.json
npm run test:wp               # one run, for PAYMENT_GATEWAY in .env
```

In `.env`, fill in:

- `BASE_URL`, `EMAIL`, `PASSWORD`: the PayLexer dashboard (staging or live).
- `FRONTEND_URL`, `WP_LOGIN_URL`, `WP_USERNAME`, `WP_PASSWORD`: the WordPress
  site that runs WP Travel Engine and the PayLexer plugin. The plugin must be
  built for the same PayLexer as `BASE_URL`.
- `PAYMENT_GATEWAY`: a key from `config/gatewayConfigs.js` (`npm run gateways` lists them).
- That gateway's sandbox keys, as `<GATEWAY>_<FIELD>` (for example `STRIPE_SECRET_KEY`).

Run `npm run auth` again whenever a run says the session has expired.

## Commands

| Command | What it does |
| --- | --- |
| `npm run test:wp` | Runs the full WordPress-first flow for `PAYMENT_GATEWAY` (headed) |
| `npm run test:all -- --only Stripe,Mollie` | Runs these gateways one after another (headless; `--headed`, `--verbose`) |
| `npm run test:all` | Runs every gateway (`--skip A,B` leaves some out) |
| `npm run gateways` | Lists every runnable gateway with its display name and currency |
| `npm run test:gateway` | Runs the older dashboard-first flow: configure in PayLexer, then tick and pay in WPTE |
| `npm run report` | Opens the HTML report with the screenshot, trace and failing API calls |
| `npm run auth` | Refreshes the saved PayLexer + WordPress session |

Runs on one site go **one at a time**. Every run sets the store currency to its
gateway's currency, so two runs at once would overwrite each other's currency.

## What one run does (`tests/wpGatewayCheckout.spec.js`)

1. Opens wp-admin using the saved session. It does not log in again.
2. Opens **WP Travel Engine > Settings > Payments > General** and checks the gateway's state there:
   - **ticked**: nothing to do here.
   - **unticked**: ticks it and saves.
   - **missing**: goes to the **PayLexer plugin** page in wp-admin (`pages/PaylexerPluginPage.js`):
     - checks the plugin connection and connects the site if it isn't connected;
     - reads the gateway card's badge. For *Needs Attention* or *not configured*, it clicks Configure.
       That opens the gateway's page in the **PayLexer dashboard**, where the run fills the keys
       from `.env`, then saves and verifies them (`pages/GatewayConfigurationPage.js`);
     - for *Configured*, it clicks **Add**, then reads the WPTE list again and ticks the gateway if needed.
3. Sets the WPTE currency (Currency > General) to the gateway's `defaultCurrency`, or `RUN_CURRENCY`.
4. Opens `/trip` and picks the gateway's `trip`, a trip from `WTE_TRIPS`, or the first priced trip. Then it books it.
5. Fills the WPTE checkout, selects the gateway, accepts the terms and submits (`pages/CheckoutPage.js`).
6. Pays on the gateway's page, using its code, a recipe, or auto-detection (`config/paymentForms.js`).
7. Checks that the run reaches the Thank You page.

With `PAYLEXER_RECONFIGURE=1`, the run first pushes the `.env` keys into the gateway in the PayLexer dashboard.

## Layout

```
config/
  gatewayConfigs.js        gateway definitions: display name, slug, credential fields, currencies
  gatewayPaymentForms.js   per-gateway card or redirect page code (61 gateways)
  paymentForms.js          picks how a run pays: code, then recipe, then auto-detect
  paymentRecipes.js        recipe engine (data-driven payment steps)
  paymentAuto.js           card-form auto-detection
  paymentform.json         shared recipes and test cards
  gatewayStore.js          optional local store: data/gateways.json (extra gateways, keys, recipes)
  currencyPlatforms.js     WPTE currency screen and trip archive
  productChoice.js         which trip to book, and the fallback order
  credentialKeys.js        maps a field name to its <GATEWAY>_<FIELD> env var
  session.js               saved session, openDashboard() and openWpAdmin()
pages/
  CheckoutPage.js          WPTE booking and checkout
  CurrencySettingsPage.js  WPTE currency
  PaylexerPluginPage.js    PayLexer plugin in wp-admin: connect, badges, Configure, Add
  DashboardPage.js, PaymentGatewayPage.js, GatewayConfigurationPage.js   PayLexer dashboard
  LoginPage.js, WPLoginPage.js   sign-in pages (used by npm run auth)
tests/
  wpGatewayCheckout.spec.js   the main WordPress-first flow
  paymentGateway.spec.js      the older dashboard-first flow
  login.setup.js              npm run auth
  liveView.js, networkWatch.js, consoleWatch.js   test fixture: failing API calls and JS errors attached on failure
scripts/runGateways.js     npm run test:all
.claude/skills/paylexer-gateways/   gateway catalogue and trace reader for Claude Code
docs/payment-recipes.md    how to write a payment-form recipe
```

## Accommodation add-on (`tests/accommodation.spec.js`)

Covers the WP Travel Engine **Accommodation** extension end to end. It needs only
`FRONTEND_URL`, `WP_USERNAME` and `WP_PASSWORD`; if the saved session has expired it
logs into wp-admin by itself.

| Command | What it does |
| --- | --- |
| `npm run ui` | Opens the add-on QA runner at http://localhost:4417 (see below) |
| `npm run test:accommodation` | Runs the whole suite (headed; add `PW_HEADLESS=1` for headless) |
| `ACCOMMODATION_CLEANUP=1 npm run test:accommodation` | Same, then deletes the QA trips, rooms and upgrades |

What it checks, in order:

1. **Extension**: the add-on is listed on **WP Travel Engine > Extensions**, licensed and
   Active (it activates the plugin if it is off, and the license if
   `ACCOMMODATION_LICENSE_KEY` is set). Then it turns on **Settings > Extensions >
   Accommodation > Enable** if it is off.
2. **Settings UI**: title and description, pricing format (Per Traveler shows *Allow Shared
   Room Bookings*, which shows *Shared Occupancy Notice*), Mandatory For, and adding,
   disabling and deleting room types and room upgrades. Each save is read back over REST.
3. **Trip editor UI**: the trip's Accommodation tab, covering room price, short and long
   description, *Included in Package*, the enable switch, and adding or removing an
   upgrade with its price and room types.
4. **Frontend booking**: one QA trip per feature (`config/accommodationData.js`):
   per-room pricing through to checkout, per-traveler pricing (travellers split the room
   price), room upgrades, included in package, shared rooms (with sharing on and off),
   Mandatory For adults, room visibility (disabled rooms, and rooms bigger than the
   group), and the step disappearing when the extension is disabled.

The QA trips are created through the WPTE REST API and reused on later runs. Everything
the suite creates starts with `QA `. Tests run one at a time because pricing format,
sharing and Mandatory For are site-wide settings. When the run ends, those settings go
back to how they were, and the extension stays enabled. Payment is not submitted: the
run checks checkout up to Tour Details.

## Add-on QA runner (`npm run ui`)

A local UI for every WP Travel Engine add-on. The add-on list comes from `config/addons.js`.

- **Index**: all add-ons grouped by category, with a search box, filters (All, Automated,
  No tests yet), each add-on's last result, and overall coverage.
- **Add-on page**: Features (tests grouped by their `test.describe`, with select, run one,
  or run all), Run (the run as a route of stops with a live view of the browser and the
  output, and errors and screenshots on failed stops), History, Fixtures (what the
  suite built on the site, with links), and **QA Report** (bugs found by reading the
  add-on's source, with severity, GitHub line links and steps to reproduce).
- **QA Report tab**: reads `data/addons/<slug>/qa-report.json` and shows each finding as a
  card — severity, impact, evidence, where in the code, steps to reproduce and the fix.
  **Re-scan repo** shallow-clones (or pulls) the add-on's GitHub repo into
  `data/addons/<slug>/repo/`, re-locates every finding in the live source (marking any that
  no longer match as possibly fixed), and runs repo-wide pattern checks. Set `repo` and
  `report` on the add-on's entry in `config/addons.js` to enable it. The curated findings
  live in `qa-report.json`; `scripts/repoAudit.js` does the cloning and re-location.
- Options: Live view, Show browser (headed) and, where the suite supports it, Clean up after.
- Runs go one at a time across all add-ons, because they share one site.

To automate another add-on, write `tests/<name>.spec.js`, then set `spec` on its entry in
`config/addons.js`. For the live view, call `startLiveFrames(context)` from
`tests/support/liveFrames.js` in the spec's `beforeAll`. The add-on's page in the UI shows
these steps too. Results and history are kept under `data/addons/<slug>/`.

## When a run fails

- Open `npm run report`. The failed test includes a screenshot, a trace, and
  `network`/`console` attachments. The last failed API call before the error is
  marked as the likely cause.
- `error-context.md` next to the screenshot shows the page's accessibility
  snapshot, with the real field names and the iframe that holds them.
- To summarise a large trace:
  `node .claude/skills/paylexer-gateways/scripts/read-trace.js "<path>/trace.zip" --grep "card|cvv|pay"`
- `.claude/skills/paylexer-gateways/references/gateways.md` covers every
  gateway: how it pays, its test card, and its selectors.
