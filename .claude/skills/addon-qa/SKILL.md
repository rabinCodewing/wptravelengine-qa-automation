---
name: addon-qa
description: Automate QA for a WP Travel Engine add-on end to end in this Playwright project — study the add-on (clone its repo + read its docs), build a feature test suite (config data + page objects + spec) mirroring the Accommodation/Activity Tour suites, wire it into the add-on runner UI (config/addons.js), enable its QA Report repo scan, and route its issue filing to its own repo. Use when the user says "automate <add-on>", "start automation of <add-on>'s features", "add tests for <add-on>", "put <add-on> in the UI", "add auto-scan repo for <add-on>", "list <add-on> features", or names any WP Travel Engine add-on (Activity Tour, Pickup Points, Extra Services, Group Discount, Resource Management, Trip Fixed Starting Dates, Partial Payment, …) to test. Builds QA test code only — never changes the add-on/plugin (engine) source.
---

# Add-on QA automation

One skill for turning a WP Travel Engine add-on into an automated QA suite in
this project, the way **Accommodation** (`tests/accommodation.spec.js`) and
**Activity Tour** (`tests/activityTour.spec.js`) are done. Follow the scenario.

## Golden rules

- **Build QA code only.** Add files under `tests/`, `pages/`, `config/`. Never edit the add-on's or WP Travel Engine's PHP/JS (the engine). A cloned add-on under `data/addons/<slug>/repo` is **read-only reference**.
- **Authorized QA site only** (e.g. `http://rabin.local`, from `FRONTEND_URL`).
- **Build fixtures over REST, verify over REST.** The UI is for exercising the add-on; `config/wpteApi.js` (`updateTrip`, `getTrip`, `upsertTrip`, `getSettings`) is the source of truth for setup and assertions. Trip meta round-trips through `/wptravelengine/v2/trips/{id}`.
- **Don't commit/push unless asked.** `data/` and `.env` are gitignored.

## Where things live

| What | Where |
| --- | --- |
| Add-on catalogue (runner UI reads it) | `config/addons.js` — one entry per add-on |
| A suite | `tests/<addon>.spec.js` |
| Page objects | `pages/*.js` |
| QA fixtures/data | `config/<addon>Data.js` |
| REST client | `config/wpteApi.js` |
| Login / session | `pages/WPLoginPage.js`, `config/session.js` (`resolveAuthFile`, `hasSavedSession`) |
| Extensions page object | `pages/WpteExtensionsPage.js` (`status`, `activatePlugin`, `activateLicense`) |
| Live view fixture | `tests/support/liveFrames.js` (`startLiveFrames`) |
| Runner UI + Security + QA Report | `scripts/addonsUi.js` → `npm run ui` |
| Cloned add-on source (reference) | `data/addons/<slug>/repo` (gitignored) |
| QA Report findings | `data/addons/<slug>/qa-report.json` |

## Scenario: automate a new add-on

**1. Study it.** Clone the add-on's repo into `data/addons/<slug>/repo` (read-only) and read its docs:
```
export GH_TOKEN="$(grep '^GH_TOKEN=' .env | cut -d= -f2-)"
git clone --depth 1 "https://x-access-token:${GH_TOKEN}@github.com/Codewing-Solutions/<repo>.git" data/addons/<slug>/repo
```
Read `README.txt` (changelog = regression-prone areas), `CLAUDE.md`/`developer-docs.md` (architecture), `includes/` (REST schema filters, trip-meta fields, settings builders, hooks), and `src/public/js` (React booking modal — grab **stable class hooks**, not styled-components hashes). Also read the public docs page if given. Find the real repo name with `gh repo list Codewing-Solutions` (filter by keyword) — slugs don't always match (e.g. Activity Tour's repo is `wptravelengine-activity-tour-booking`).

**2. Mirror the Accommodation/Activity Tour shape.** Create:
- `config/<addon>Data.js` — one fixture per feature, all titled with a `QA <Name>` prefix so cleanup can find them.
- `pages/<Addon>...Page.js` — admin (trip editor / settings) and front-end (booking modal) page objects. Prefer text/role and documented class hooks; note any selector that needs a first-run tweak.
- `tests/<addon>.spec.js` — `test.describe.configure({ mode: "serial" })`, `test.setTimeout(8 * 60 * 1000)`, groups `"1. Extension"`, `"2. … UI"`, `"3. … REST"`, `"4. Frontend booking"`, `"5. Known bugs (QA Report)"`, `"6. Stripe checkout"` (last — it leaves real test-mode bookings). `beforeAll` opens a context with the saved session, `ensureWpAdmin`, inits `WpteApi`; `afterAll` restores settings and (on `<ADDON>_CLEANUP=1`) deletes QA trips. Build fixtures via REST (idempotent: compare, only rewrite on mismatch); verify via REST.
- **Known bugs**: each confirmed QA-Report finding gets a test asserting the *correct* behaviour wrapped in `test.fail(true, "<ID> open: …")` — it passes while the bug exists and turns red when fixed (then drop the line). Keeps the serial suite green so Stripe still runs.
- **Stripe checkout**: `api.ensureStripe(...)`, book in the UI, `new WpteStripeCheckoutPage(page).pay(STRIPE_TEST_CARD)`, then `api.getBooking(id)` and assert trip, package, travellers, date/time, line totals, payment `success` + `pi_…`, `total_due_amount` 0. Write rows to `data/addons/<slug>/bookings.json` and add `bookings:` to the `config/addons.js` entry (Bookings tab).

**3. Wire it into the runner** (`config/addons.js` entry):
```js
{
  slug: "wptravelengine-<addon>", name: "<Name>", group: "<group>",
  description: "...",
  spec: "tests/<addon>.spec.js",
  fixtures: "data/addons/wptravelengine-<addon>/fixtures.json",
  repo: "https://github.com/Codewing-Solutions/<repo>.git",   // QA Report scan
  bugRepo: "Codewing-Solutions/<repo>",                        // issues route here
  report: "data/addons/wptravelengine-<addon>/qa-report.json", // enables QA Report tab
  cleanupEnv: "<ADDON>_CLEANUP",
}
```
The runner lists the suite automatically (tests grouped by their top-level `test.describe`). Confirm: `npm run ui` → the add-on shows **automated** with its feature groups.

**4. Enable the QA Report repo scan.** Create `data/addons/<slug>/qa-report.json`:
```json
{ "repo": "https://github.com/Codewing-Solutions/<repo>.git", "branch": "main",
  "intro": "QA pass over <Name>.", "findings": [], "checkedNotIssues": [] }
```
The **QA Report** tab's **Re-scan repo** then clones/pulls the source and runs the repo-wide pattern checks; add curated findings to this file as they're confirmed.

**5. Find, verify and report bugs.** Use the **`addon-bug-report`** skill: read the whole source, write findings into `qa-report.json`, reproduce them on the QA site, write UI steps + user experience, and prepare drafts. The user files them from the QA Report (**Preview issue › File issue › File to GitHub**) to the add-on's **own** `bugRepo`. `npm run doctor -- --repo wptravelengine-<addon>` adds a security scan (see `security-testing`).

## Validate & verify

- `node --check` each new file; `npx playwright test tests/<addon>.spec.js --list` to confirm discovery + groups.
- Run against the QA site to validate selectors (creates `QA <Name>` trips, reused on re-runs): `npx playwright test tests/<addon>.spec.js --project=firefox` (add `PW_HEADLESS=1`). Front-end modal selectors derived from source usually need one validation pass.

## QA-site gotchas (WPTE 6.9 on rabin.local)

These all "succeed" silently over REST — check the read-back.
- **Departures / time slots** aren't saved by `POST /wptravelengine/v2/trips/{id}` (`packages[].dates` is dropped). Create them with Fixed Starting Dates' `POST /wptravelengine/v1/trip-dates/create` `{trip_id, package_id, start_date, end_date, weekdays (JS 0=Sun), seats, times:[{from:"HH:MM",to,seats}]}`; it skips existing dates. Rewriting a trip's packages **wipes** its dates — recreate after.
- **Per-group pricing** only saves on a *new* package; changing an existing package's `pricing_type` is ignored (core). Give the fixture a fresh title.
- **Group-discount tiers** and package-level `min_pax` don't save without the Group Discount add-on; use a category `min_pax` instead. Extra Services isn't installed.
- **Booking REST (6.9)**: `booked_trips[0].travelers_count`, `start_datetime` (`YYYY-MM-DDTHH:MM`), `package.label`, `line_items[{id:"price_category", items}]`; `payments[].gateway === "stripe_payment"`, `status "success"`, `transaction_id pi_…`, `paid_amount`; `total_paid_amount`, `total_due_amount`.
- **Thank You page** shows "BOOKING REFERENCE #id" (newer) or "Booking ID: id" — `WpteStripeCheckoutPage` reads both.
- Fixed Starting Dates plugin slug: `wp-travel-engine-trip-fixed-starting-dates` (check plugins over `/wp/v2/plugins`).
- Playwright has **Firefox** installed (not Chromium); Brave can be driven with `chromium.launch({ executablePath: <brave.exe> })` for Brave-specific checks.

## Page-object pitfalls

- Fields sharing one `.wpte-form-control` (hours + minutes): target by `name` (`duration.period`, `duration.minutes`) or the suffix span right after the input — `filter({ hasText })` matches the whole row.
- Flatpickr: pick dates via `input._flatpickr.setDate(d, true)` (same onChange as a click, any month); read available dates with `fp.formatDate(d, "Y-m-d")`, not `toISOString()` (timezone shift).
- A category's minimum is enforced by the counter — you can't go below `min_pax` (Adult usually 1).
- Saving a trip with no changes posts nothing — `save()` waiting for the meta POST will time out.

## Reference: the two existing suites

- **Accommodation** — `tests/accommodation.spec.js`, `pages/Accommodation*`, `TripAccommodationPage`, `config/accommodationData.js`. Groups: Extension, Settings UI, Trip editor UI, Frontend booking, Stripe checkout. Builds global rooms/upgrades + one trip per feature via REST.
- **Activity Tour** — `tests/activityTour.spec.js` (34 tests), `pages/ActivityTourTripPage`, `pages/ActivityTourBookingPage`, `config/activityTourData.js`. 10 QA trips (basic, hours+minutes, time slots, adult+child, sale, packages, per-group, min travellers, limited seats, multi-day control), departures via the FSD endpoint, 5 known-bug `test.fail` tests, 8 Stripe checkouts. Its modal POSTs `wte_add_trip_to_cart`. Repo: `wptravelengine-activity-tour-booking`.
