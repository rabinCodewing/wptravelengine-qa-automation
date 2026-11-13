const path = require("path");

const dotenvResult = require("dotenv").config({
  path: path.resolve(__dirname, "../.env"),
  quiet: true,
});

// Deliberately NOT the parsed values. This printed all ~190 entries of .env —
// every gateway secret, the WordPress admin password, the ReportPortal API key
// — into a log that reaches the terminal, the run output directory,
// ReportPortal, and the UI log endpoint. What the line was read for is whether
// .env was found and how much of it loaded, which is all that is left here.
console.log(
  dotenvResult.error
    ? `DOTENV: failed to load .env — ${dotenvResult.error.message}`
    : `DOTENV: loaded ${Object.keys(dotenvResult.parsed || {}).length} values from .env`,
);

// Playwright's own `test`, plus the live-view frames the UI's mini browser
// polls (see tests/liveView.js). The fixture is inert unless PW_LIVE_VIEW=1,
// which only scripts/uiServer.js sets, so CLI runs are unchanged.
const { test, expect } = require("./liveView");
// Scrolls a found element into view so a watched run shows it — see the file.
const { revealElement } = require("./smoothScroll");

const GatewayConfigurationPage = require("../pages/GatewayConfigurationPage");
const CurrencySettingsPage = require("../pages/CurrencySettingsPage");
const CheckoutPage = require("../pages/CheckoutPage");
const PaylexerPluginPage = require("../pages/PaylexerPluginPage");
const DashboardPage = require("../pages/DashboardPage");
const PaymentGatewayPage = require("../pages/PaymentGatewayPage");

const gatewayConfigs = require("../config/gatewayConfigs");
const { openDashboard, openWpAdmin } = require("../config/session");
const { successUrlFor } = require("../config/paymentForms");

// 15 minutes, not the 10 it used to be: the WP-admin + booking prelude alone
// runs ~9.5 min under the 1400ms slowMo in playwright.config.js, which left
// nothing for the card form, the gateway round-trip and the 120s Thank You
// wait at the end. Square, with the most credential fields of any gateway,
// was timing out mid-submit with the card already filled correctly.
test.setTimeout(900000);

// ─── Payments > General helpers ───────────────────────────────────────────────
// Kept local to this spec on purpose: it's the only flow that needs to INSPECT
// that screen before touching anything (the existing paymentGateway.spec.js
// path only ever ticks, via CurrencySettingsPage). Same locators as the ones
// already proven in config/currencyPlatforms.js and CurrencySettingsPage.js.

/**
 * Scrolls an element to the middle of the viewport before it's acted on.
 * Centred so it doesn't end up under WP admin's sticky top bar; never fails
 * the step on its own.
 */
async function scrollTo(locator) {
  await locator
    .evaluate((el) => el.scrollIntoView({ block: "center", inline: "nearest" }))
    .catch(() => locator.scrollIntoViewIfNeeded().catch(() => {}));
}

/** WP admin (anywhere) → WP Travel Engine > Settings. */
async function openWteSettings(page) {
  const settingsLink = page.locator(
    'a[href="edit.php?post_type=booking&page=class-wp-travel-engine-admin.php"]',
  );

  // ---- Preferred: go straight to the Settings link's address ----
  // Same as edd/fc in currencyPlatforms.js. WordPress renders the submenu on
  // every admin screen, hidden until the menu opens, so its href can be read
  // without opening it. Clicking through the flyout could leave the run on the
  // Dashboard with the menu open and Settings never followed.
  const settingsHref = await settingsLink
    .first()
    .getAttribute("href", { timeout: 5000 })
    .catch(() => null);

  if (settingsHref) {
    const settingsUrl = new URL(settingsHref, page.url()).href;
    console.log(`Opening WP Travel Engine Settings directly: ${settingsUrl}`);
    await page.goto(settingsUrl);
    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
    return;
  }

  // ---- Fallback: click WP Travel Engine, then Settings ----
  console.log(
    "ℹ Couldn't read the WP Travel Engine Settings link — falling back to menu clicks",
  );

  const wteMenu = page
    .locator("div.wp-menu-name")
    .filter({ hasText: "WP Travel Engine" });
  await wteMenu.waitFor({ state: "visible", timeout: 30000 });
  await scrollTo(wteMenu);
  await wteMenu.click();

  await settingsLink.waitFor({ state: "visible", timeout: 30000 });
  await scrollTo(settingsLink);
  await settingsLink.click();
}

/**
 * Lands on Payments > General — the screen listing every gateway PayLexer has
 * pushed to this site as a checkbox. Reached from two different places (fresh
 * off wp-admin, or already on the settings screen), so the settings hop is
 * only made when the Payments tab isn't already on screen.
 */
async function openPaymentsGeneral(page) {
  const paymentsTab = page.locator('span[title="Payments"].wpte-menu-link');

  let alreadyOnSettings = true;

  try {
    await paymentsTab.waitFor({ state: "visible", timeout: 5000 });
  } catch (e) {
    alreadyOnSettings = false;
  }

  if (!alreadyOnSettings) {
    await openWteSettings(page);
  }

  await paymentsTab.waitFor({ state: "visible", timeout: 30000 });
  await scrollTo(paymentsTab);
  await paymentsTab.click();

  // The nested "General" here is an <a> whose href contains "payment-general",
  // distinct from the unrelated top-level "General" accordion item (a <span>).
  const paymentsGeneralLink = page.locator(
    'a[title="General"].wpte-menu-link[href*="payment-general"]',
  );
  await paymentsGeneralLink.waitFor({ state: "visible", timeout: 30000 });
  await scrollTo(paymentsGeneralLink);
  await paymentsGeneralLink.click();

  console.log("✓ Payments > General opened");
}

/** Escapes regex metacharacters so gateway names are matched literally. */
function escapeForRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The gateway's row on Payments > General.
 * Real markup: <label><input type="checkbox"><figure><img alt="Westpac PayWay">
 *
 * The logo's alt is still the primary match, but deliberately not the only one.
 * `img[alt="X"]` is case-SENSITIVE and requires the row to render a logo at
 * all, so a gateway listed as alt="omise", or one with a missing/broken image,
 * would be unfindable — and this locator failing to resolve is precisely what
 * readGatewayState() reports as "missing". A gateway that IS listed must never
 * be reported missing, so two ways in:
 *   1. the logo's alt, case-insensitively (`[alt="X" i]`)
 *   2. the row's own visible text, for rows with no usable logo
 */
function gatewayRow(page, gatewayIdentifier) {
  // Both routes are constrained to labels that actually contain a checkbox, so
  // the row handed back always owns the input the caller ticks. Without this,
  // the text route could match some unrelated label and the tick would wait out
  // its timeout against an element that never had a checkbox.
  const gatewayRows = page
    .locator("label")
    .filter({ has: page.locator('input[type="checkbox"]') });

  const byLogoAlt = gatewayRows.filter({
    has: page.locator(`img[alt="${gatewayIdentifier}" i]`),
  });

  const byText = gatewayRows.filter({
    hasText: new RegExp(`^\\s*${escapeForRegExp(gatewayIdentifier)}\\s*$`, "i"),
  });

  return byLogoAlt.or(byText).first();
}

/**
 * Every gateway row actually rendered on Payments > General, as
 * {alt, text} pairs. Logged when a gateway reads as "missing" so the run itself
 * shows whether it's genuinely absent or just labelled differently than the
 * identifier being searched for.
 */
async function listRenderedGateways(page) {
  return page
    .evaluate(() =>
      Array.from(document.querySelectorAll("label"))
        .filter((label) => label.querySelector('input[type="checkbox"]'))
        .map((label) => ({
          alt: label.querySelector("img")?.getAttribute("alt") ?? null,
          text: (label.textContent || "").trim().slice(0, 40) || null,
        }))
        .filter((row) => row.alt || row.text),
    )
    .catch((err) => `<unreadable: ${err.message}>`);
}

/**
 * Reads the gateway's state on Payments > General. Assumes that screen is open.
 *
 * @returns {Promise<"missing"|"unticked"|"ticked">}
 *   "missing"  — the gateway isn't listed at all, i.e. PayLexer hasn't pushed
 *                it to this site yet because it isn't enabled on the website
 *                over in the PayLexer dashboard.
 *   "unticked" — listed, but its checkbox is off (not offered at checkout).
 *   "ticked"   — listed and enabled; nothing to change here.
 */
async function readGatewayState(page, gatewayIdentifier, timeout = 5000) {
  const row = gatewayRow(page, gatewayIdentifier);

  try {
    // Short on purpose: the gateway list renders with the rest of the screen,
    // so if the row isn't there within a few seconds it isn't coming. The
    // caller has already waited for networkidle, and a long wait here just
    // stalls the run on the common "not listed yet" path.
    await row.waitFor({ state: "visible", timeout });
  } catch (e) {
    console.log(
      `ℹ "${gatewayIdentifier}" not found. Gateway rows actually on screen: ` +
        JSON.stringify(await listRenderedGateways(page)),
    );
    return "missing";
  }

  await revealElement(row);

  const checkbox = row.locator('input[type="checkbox"]');
  await checkbox.waitFor({ state: "visible", timeout: 30000 });

  return (await checkbox.isChecked()) ? "ticked" : "unticked";
}

/**
 * Ticks a WP Travel Engine checkbox, bounded so it fails fast instead of hanging.
 *
 * These checkboxes are styled: the real <input> counts as visible to Playwright
 * but sits under its own label/wrapper, which swallows the pointer event (the
 * same trap documented in CheckoutPage.checkTermsAndConditions). This project
 * sets no per-action timeout, so a bare check() blocks on hit-target
 * actionability until the 600s test timeout — which looks like the run simply
 * freezing on a gateway that's plainly on screen.
 *
 * So: every attempt is explicitly bounded, and each is verified by reading
 * .isChecked() back rather than trusting that the action did anything.
 */
async function tickCheckbox(page, checkbox, label) {
  // Centre it first — scrollIntoViewIfNeeded() alone can leave it under the
  // sticky admin bar, which is itself a pointer-event interceptor.
  await checkbox.evaluate((el) =>
    el.scrollIntoView({ block: "center", inline: "nearest" }),
  );

  const checkboxId = await checkbox.getAttribute("id");

  const attempts = [
    {
      name: "check()",
      run: () => checkbox.check({ timeout: 5000 }),
    },
    {
      name: 'label[for="…"] click',
      run: async () => {
        if (!checkboxId) throw new Error("checkbox has no id to target");
        await page
          .locator(`label[for="${checkboxId}"]`)
          .first()
          .click({ force: true, timeout: 5000 });
      },
    },
    {
      name: "forced click on the input",
      run: () => checkbox.click({ force: true, timeout: 5000 }),
    },
    {
      // Last resort: flip it in the DOM and fire the events the UI listens for,
      // so the Save button still registers the change.
      name: "JS set + change event",
      run: () =>
        checkbox.evaluate((el) => {
          if (!el.checked) {
            el.checked = true;
            el.dispatchEvent(new Event("input", { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
          }
        }),
    },
  ];

  for (const attempt of attempts) {
    try {
      await attempt.run();
    } catch (e) {
      console.log(`  ↻ ${attempt.name} failed: ${e.message.split("\n")[0]}`);
      continue;
    }

    if (await checkbox.isChecked()) {
      console.log(`✓ "${label}" ticked via ${attempt.name}`);
      return;
    }

    console.log(`  ↻ ${attempt.name} ran but the box is still unticked`);
  }

  throw new Error(
    `Could not tick "${label}" on Payments > General — tried check(), its label, a forced click, and setting it in JS. ` +
      `The checkbox is present but nothing flips it.`,
  );
}

/** Ticks the gateway on Payments > General and saves. Assumes it's listed. */
async function tickGatewayAndSave(page, gatewayIdentifier) {
  const checkbox = gatewayRow(page, gatewayIdentifier).locator(
    'input[type="checkbox"]',
  );

  await checkbox.waitFor({ state: "visible", timeout: 10000 });

  if (await checkbox.isChecked()) {
    console.log(
      `✓ "${gatewayIdentifier}" was already ticked — nothing to flip`,
    );
  } else {
    await tickCheckbox(page, checkbox, gatewayIdentifier);
  }

  const saveButton = page.getByRole("button", { name: "Save Settings" });
  await saveButton.waitFor({ state: "visible", timeout: 10000 });
  await scrollTo(saveButton);

  // A disabled Save here means the tick was a no-op (already in that state
  // server-side) — expected, not a failure. Clicking a disabled button has no
  // per-action timeout in this project's config, so it would hang instead.
  if (await saveButton.isEnabled()) {
    await Promise.all([
      page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {}),
      // Bounded for the same reason as the checkbox above: an intercepted click
      // would otherwise stall until the 600s test timeout.
      saveButton.click({ timeout: 10000 }),
    ]);
    console.log("✓ Payments > General settings saved");
  } else {
    console.log(
      "ℹ Save Settings is disabled — checkbox state was already stored. Skipping save.",
    );
  }
}

/**
 * Logs a gateway-setup step as a greppable "##STEP## <key> <detail>" line, so
 * a run's setup trail (wte-missing → plugin-active → added → currency-set …)
 * can be pulled out of a long log with `grep "##STEP##"`.
 */
function reportStep(key, detail = "") {
  console.log(`##STEP## ${key} ${String(detail).replace(/\s+/g, " ").trim()}`);
}

/** The trip this run booked, when one was named (gateway `trip` / WTE_TRIPS). */
function reportProduct(name) {
  if (name) reportStep("product", name);
}

// ─── Platform flow ────────────────────────────────────────────────────────────
// This project automates WP Travel Engine only. The source project
// (paylexer-playwright) keeps one entry per platform here; the shape is kept
// so the flow below reads the same.
const platformFlows = {
  wte: {
    label: "WP Travel Engine",
    // WPTE keeps its own per-site gateway checklist under Payments > General,
    // separate from what PayLexer has pushed to the site, and a gateway is
    // invisible at checkout until it's ticked there. So the run has to open
    // that screen, and its "not listed at all" state is what triggers the
    // PayLexer round-trip below.
    gatewayScreen: "WP Travel Engine > Settings > Payments > General",
    // Prefix of the ##STEP## key the gateway-list state is reported under
    // (wte-ticked, edd-missing, ...), so the UI can name the right platform.
    stepPrefix: "wte",
    openGatewayList: openPaymentsGeneral,
    readGatewayState,
    enableGateway: tickGatewayAndSave,
    // The plugin's Add usually ticks the gateway here too, but not always:
    // PayTabs (2026-10-26) arrived listed and unticked, so it never reached the
    // checkout. Re-read the list after Add and tick it if needed, as for EDD.
    recheckAfterAdd: true,
    CheckoutPage,
    // WPTE's checkout labels the method with whatever PayLexer's plugin pushed
    // as its display title, which is what displayName/logoAlt in
    // gatewayConfigs.js exist to track.
    checkoutGatewayName: (gatewayKey, config) =>
      config.displayName || gatewayKey,
  },
};

// ─── PayLexer gateway configuration ───────────────────────────────────────────

/**
 * On a gateway's PayLexer configuration page, already open: verify (or fill
 * from .env) its credentials, then save its Display Settings.
 *
 * Reached through the plugin page's Configure link on a Needs Attention card,
 * which lands on this page directly.
 */
async function fillGatewayCredentialsInPaylexer(
  paylexerPage,
  gatewayName,
  gatewayConfig,
  { force = false, onFilled } = {},
) {
  const configure = new GatewayConfigurationPage(paylexerPage);

  // Let the configuration form render, same as paymentGateway.spec.js.
  await paylexerPage.waitForTimeout(2000);

  // Try whatever is already saved first: only clear and refill from .env when
  // verifying the existing credentials fails (or there are none yet). Skipped
  // when forced: the keys were just changed in the UI, so the ones PayLexer
  // holds verifying says nothing about the new ones.
  const credentialsAlreadyValid =
    !force &&
    (await configure.tryVerifyExistingConnection(gatewayConfig.successMessage));

  if (credentialsAlreadyValid) {
    console.log(
      "✓ Existing credentials already verify — skipping credential fill",
    );
  } else {
    console.log(`Filling ${gatewayName} credentials from .env...`);
    await configure.fillCredentials(gatewayName, gatewayConfig.fields, { onFilled });
    console.log("✓ Credentials filled");

    console.log("Saving & Verifying...");
    await configure.saveAndVerify();

    console.log("Checking connection...");
    await configure.verifyConnection(gatewayConfig.successMessage);
    console.log("✓ Connection verified");
  }

  // The current configure screen: Verify connection, then "Save Changes" at
  // the bottom of the page publishes the gateway — and the run goes back to
  // WordPress. The older screen published it through Display Settings
  // instead; that path still runs where the screen still has it.
  if (await configure.hasSaveChanges()) {
    await configure.saveChanges();
    console.log("✓ Saved — back to WordPress");
    return;
  }

  if (!(await configure.hasDisplaySettings())) {
    console.log("✓ Verified — nothing else to save on this screen, back to WordPress");
    return;
  }

  console.log("Opening Display Settings...");
  await configure.clickPaymentMethod();

  console.log("Saving Display Settings...");
  await configure.saveDisplaySettings();
  await configure.verifyDisplaySettingsSaved();
  console.log("✓ Display Settings saved");
}

/**
 * Pushes this run's keys to the gateway in the PayLexer dashboard: Payment
 * Gateways → search → Configure, then a forced fill, Save & Verify and Display
 * Settings. Run when PAYLEXER_RECONFIGURE=1, which the UI sets after a gateway's
 * keys are changed and saved in its Credentials tab — the run's environment
 * already carries the saved values, which is what fillCredentials() reads.
 *
 * In a tab of its own in the same context, so the saved PayLexer session signs
 * it in and the WordPress tab is left where it was.
 */
async function reconfigureInPaylexer(page, gatewayName, gatewayConfig, displayGatewayName) {
  const paylexerPage = await page.context().newPage();
  // Shown on the card while the live view follows this tab (it captures the
  // newest page), so the PayLexer screen is labelled as what it is.
  reportStep("reconfiguring-in-paylexer", displayGatewayName);

  try {
    console.log("Opening the PayLexer dashboard to apply the keys saved in the UI...");
    await openDashboard(paylexerPage);

    const dashboard = new DashboardPage(paylexerPage);
    const gateways = new PaymentGatewayPage(paylexerPage);

    await dashboard.openPaymentGateways();
    console.log(`Searching for "${displayGatewayName}"...`);
    await gateways.searchGateway(displayGatewayName);
    await gateways.clickConfigure(displayGatewayName);
    console.log("✓ Configuration page opened");

    await fillGatewayCredentialsInPaylexer(paylexerPage, gatewayName, gatewayConfig, {
      force: true,
      // One chip per key on the run card: "Secret Key …1a2b → …9f3c".
      onFilled: ({ field, from, to }) => reportStep("paylexer-key", `${field} ${from} → ${to}`),
    });
  } finally {
    await paylexerPage.close().catch(() => {});
    await page.bringToFront();
  }
}

// ─── The flow ─────────────────────────────────────────────────────────────────

// The run's gateway and platform go in the TEST TITLE, not just the launch
// name, because scripts/runAllGateways.js puts all ~120 runs in a single
// ReportPortal launch (RP_LAUNCH_ID — see scripts/reportPortalLaunch.js). Every
// one of those processes runs this same file and this same test, so without the
// suffix the launch shows 120 items with one identical name and no way to tell
// which gateway a failure belongs to.
//
// Read at module load rather than inside the test body: Playwright fixes titles
// at collection time, and this is set by then — runPlatform() puts both vars in
// the child's environment before the process starts, and dotenv does not
// overwrite variables that are already set.
//
// Empty for a bare `npx playwright test` with neither var set, which leaves the
// original title untouched.
const runLabel = [process.env.PAYMENT_GATEWAY, process.env.CURRENCY_PLATFORM]
  .filter(Boolean)
  .join(" / ");

test(`WordPress-first: enable gateway, set currency, and pay${runLabel ? ` — ${runLabel}` : ""}`, async ({
  page,
}) => {
  console.log("========== TEST STARTED (WordPress-first flow) ==========");

  // ---- Everything below comes from .env ----

  const gatewayName = process.env.PAYMENT_GATEWAY;

  if (!gatewayName) {
    throw new Error(
      dotenvResult.error
        ? `No .env file in ${path.resolve(__dirname, "..")}. Copy env.example (or your existing .env from paylexer-playwright) to .env, ` +
            `fill in PayLexer, WordPress and PAYMENT_GATEWAY, then run "npm run auth" once.`
        : `PAYMENT_GATEWAY is not set in .env. Set it to a key from config/gatewayConfigs.js — "npm run gateways" lists them.`,
    );
  }

  const gatewayConfig = gatewayConfigs[gatewayName];

  if (!gatewayConfig) {
    throw new Error(
      `No configuration found for gateway "${gatewayName}" (PAYMENT_GATEWAY in .env). Please add it to config/gatewayConfigs.js`,
    );
  }

  // Same convention as paymentGateway.spec.js: displayName matches visible UI
  // text, the key stays for env-var/credential lookups.
  const displayGatewayName = gatewayConfig.displayName || gatewayName;

  // WP Travel Engine only. CURRENCY_PLATFORM is still read so a stray value
  // from a copied .env fails loudly instead of silently running WPTE.
  const platformKey = process.env.CURRENCY_PLATFORM || "wte";
  const flow = platformFlows[platformKey];

  if (!flow) {
    throw new Error(
      `Unknown CURRENCY_PLATFORM "${platformKey}". This spec supports: ${Object.keys(
        platformFlows,
      ).join(", ")}. Set it in your .env file.`,
    );
  }

  // The name the platform's admin gateway list is searched by.
  const gatewayListName = flow.gatewayListName
    ? flow.gatewayListName(gatewayName, gatewayConfig)
    : displayGatewayName;

  console.log(`Platform: ${flow.label} (CURRENCY_PLATFORM=${platformKey})`);
  console.log(`Gateway : ${gatewayName}`);

  // The name to look for on the FRONT-END checkout's payment-method list, which
  // is a different thing from displayGatewayName (the WP-admin/PayLexer text).
  // WPTE keeps using displayName; WooCommerce takes PAYMENT_GATEWAY verbatim.
  // A string on wte (the display name); an object carrying slug + displayName +
  // key on woocommerce, whose page object tries them in that order.
  const checkoutGatewayName = flow.checkoutGatewayName(
    gatewayName,
    gatewayConfig,
  );

  const checkoutGatewayLabel =
    typeof checkoutGatewayName === "string"
      ? `"${checkoutGatewayName}"`
      : JSON.stringify(checkoutGatewayName);

  console.log(
    `Payment method to select at checkout: ${checkoutGatewayLabel} (from PAYMENT_GATEWAY="${gatewayName}")`,
  );

  const frontendUrl = process.env.FRONTEND_URL;

  if (!frontendUrl) {
    throw new Error(
      "FRONTEND_URL is not set. Add it to your .env file, e.g. FRONTEND_URL=https://your-test-site.example.com",
    );
  }

  // The gateway's defaultCurrency in config/gatewayConfigs.js (its first
  // supported currency when it has none), which PAYMENT_GATEWAY selects. No
  // separate currency env var — the gateway choice in .env decides it.
  // RUN_CURRENCY (the dashboard's currency filter) picks one of the gateway's
  // own currencies; anything else falls back to that default. The default, not
  // the first in the list: catalog-ordered lists start with whatever sorts
  // first (Razorpay's with AED, Raiffeisen's with ALL), not the currency the
  // sandbox account takes.
  const requestedCurrency = (process.env.RUN_CURRENCY || "").toUpperCase();
  const fallbackCurrency = gatewayConfig.currencies?.includes(gatewayConfig.defaultCurrency)
    ? gatewayConfig.defaultCurrency
    : gatewayConfig.currencies?.[0];
  const currencyToSet = gatewayConfig.currencies?.includes(requestedCurrency)
    ? requestedCurrency
    : fallbackCurrency;

  console.log(
    `Gateway: "${displayGatewayName}" | target currency: "${currencyToSet || "(none defined)"}"`,
  );

  // ---- 1. Start at wp-admin, already signed in ----
  // No WPLoginPage.login() here: the storage state loaded by
  // playwright.config.js carries the WordPress cookie too, so this goes
  // straight to wp-admin. This was the login that ran on EVERY run — it is the
  // first thing the spec did.
  console.log("Opening wp-admin with the saved session...");
  await openWpAdmin(page);
  console.log("✓ wp-admin opened — WordPress login skipped (saved session reused)");

  // ---- 1b. Keys changed in the UI → configure them in PayLexer first ----
  // Before the gateway list is read, so a gateway whose new keys make PayLexer
  // (re)publish it is settled against the result.
  if (process.env.PAYLEXER_RECONFIGURE === "1") {
    await reconfigureInPaylexer(page, gatewayName, gatewayConfig, displayGatewayName);
    reportStep("reconfigured-in-paylexer");
  }

  // ---- 2–4. Settle the gateway on the platform's gateway list ----
  const settleGateway = async () => {
    // ---- 2. Is the gateway on the platform's gateway list? ----
    // Stays null on a platform with no such list (WooCommerce), which skips both
    // step 3 and step 4 below without either of them needing to know why.

    let gatewayState = null;

    if (flow.gatewaysPreEnabled) {
      console.log(
        `${flow.label} has no gateway checklist to settle — PayLexer's gateways arrive already enabled, ` +
          `so going straight to the currency step. ${checkoutGatewayLabel} being absent would show up at checkout.`,
      );
      reportStep(`${flow.stepPrefix}-pre-enabled`);
    } else {
      console.log(`Opening ${flow.gatewayScreen}...`);
      await flow.openGatewayList(page);

      console.log(`Looking for "${displayGatewayName}" in the gateway list...`);
      gatewayState = await flow.readGatewayState(page, gatewayListName);
      console.log(`Gateway state on ${flow.gatewayScreen}: "${gatewayState}"`);
      reportStep(`${flow.stepPrefix}-${gatewayState}`, displayGatewayName);
    }

    // ---- 3. Not listed → sort it out on the PayLexer plugin page ----
    // The list here is populated by the PayLexer plugin, so a gateway that never
    // shows up means the plugin hasn't added it to this site yet.

    if (gatewayState === "missing") {
      // ---- 3a. Test connection: is this site connected to PayLexer? ----
      // A gateway can only reach this list through the PayLexer plugin, so check
      // the plugin's connection first. If it's Disconnected, nothing PayLexer-side
      // can make the gateway appear, so stop here with that as the reason.
      console.log(
        `"${displayGatewayName}" is not listed on ${flow.gatewayScreen} — checking the PayLexer plugin connection...`,
      );

      const plugin = new PaylexerPluginPage(page);
      await plugin.open();

      // Everything below goes to the PayLexer this plugin build talks to. When
      // that isn't the PayLexer this run is signed into, it can only end on a
      // sign-in page — so say why now.
      const runPaylexer = new URL(process.env.BASE_URL || "https://app-staging.paylexer.com").origin;
      const mismatch = await plugin.environmentMismatch(runPaylexer);
      if (mismatch) {
        reportStep("plugin-other-environment", mismatch);
        throw new Error(mismatch);
      }

      let connectionStatus = await plugin.getConnectionStatus();
      console.log(`PayLexer plugin connection status: "${connectionStatus}"`);

      reportStep(`plugin-${connectionStatus}`);

      // Not connected (typically the "Connect to PayLexer" banner, and no
      // gateway at all on Payments > General) → connect it from the banner.
      if (connectionStatus !== "active") {
        if (await plugin.connectBanner().isVisible().catch(() => false)) {
          console.log(
            'Plugin shows "Connect to PayLexer" — connecting the site via Connect Account...',
          );
          connectionStatus = await plugin.connect();
          reportStep(`plugin-connect-${connectionStatus}`);
        }

        if (connectionStatus !== "active") {
          throw new Error(
            `"${displayGatewayName}" is not listed on ${flow.gatewayScreen}, and the PayLexer plugin is not connected to PayLexer` +
              ` (still not Active after Connect Account, or no Connect Account banner to use). No gateway can reach this site until it is.`,
          );
        }
      }

      console.log("✓ PayLexer plugin is Active (connected to the dashboard)");

      // ---- 3b. Find the gateway in the plugin's available-gateways list ----
      // Same screen as the connection pill. Each gateway's card badge says where
      // it stands:
      //   "Needs Attention" → not configured in PayLexer yet
      //   "Configured" + Add → configured, not yet on this site
      //   anything else (Sandbox / Live) → already on the site
      console.log(
        `Looking for "${displayGatewayName}" in the plugin's gateway list...`,
      );
      let pluginGateway = await plugin.readGatewayState(displayGatewayName);
      console.log(
        `Plugin badge for "${displayGatewayName}": "${pluginGateway.label}" (${pluginGateway.state})`,
      );

      reportStep(
        pluginGateway.state === "missing"
          ? "plugin-no-card"
          : pluginGateway.state === "added"
            ? "plugin-already-added"
            : pluginGateway.state,
        pluginGateway.detail || pluginGateway.label,
      );

      if (pluginGateway.state === "site-not-connected") {
        throw new Error(
          `The PayLexer plugin's gateway cards are not links — this WordPress site is not connected to PayLexer. ` +
            `Sign in again from the UI (it connects the site), or use Connect Account on WP admin > PayLexer.`,
        );
      }

      if (pluginGateway.state === "missing") {
        throw new Error(
          `"${displayGatewayName}" is not listed on ${flow.gatewayScreen} and has no card in the PayLexer plugin's gateway list either. ` +
            `Check that displayName in config/gatewayConfigs.js matches the card's name on the plugin page.`,
        );
      }

      // ---- 3c. Needs Attention → Configure on the card, fill creds in PayLexer ----
      // A Needs Attention card is itself a link to the gateway's configure page
      // on PayLexer, so clicking its Configure opens that page in a new tab —
      // same browser context, so the saved PayLexer session signs it in.
      // A card with no badge is a gateway never set up in PayLexer — the same
      // Configure → enter keys path, the first time instead of a repair.
      if (pluginGateway.state === "needs-attention" || pluginGateway.state === "not-configured") {
        console.log(
          pluginGateway.state === "not-configured"
            ? `"${displayGatewayName}" isn't set up in PayLexer yet — opening its card to configure it...`
            : `"${displayGatewayName}" needs attention in PayLexer` +
                (pluginGateway.detail ? ` (${pluginGateway.detail})` : "") +
                ` — clicking Configure on its plugin card...`,
        );

        const paylexerPage = await plugin.openConfigure(displayGatewayName);

        // A lapsed PayLexer session lands on sign-in instead of the form, and the
        // credential fill would then time out on fields that never appear.
        if (/sign-?in|login/i.test(new URL(paylexerPage.url()).pathname)) {
          const landedOn = new URL(paylexerPage.url()).origin;
          await paylexerPage.close().catch(() => {});
          const runOrigin = new URL(process.env.BASE_URL || landedOn).origin;
          if (landedOn !== runOrigin) {
            throw new Error(
              `Configure for "${displayGatewayName}" opened ${landedOn}, but this run is signed into ${runOrigin} — ` +
                `the WordPress plugin belongs to the other PayLexer environment. Switch the dashboard's Environment ` +
                `to match the plugin and click "Sign in to both".`,
            );
          }
          throw new Error(
            `Clicking Configure for "${displayGatewayName}" landed on the PayLexer sign-in page (${paylexerPage.url()}) — ` +
              `the saved PayLexer session has expired. Sign in again from the UI (or run tests/login.setup.js), then re-run.`,
          );
        }

        await fillGatewayCredentialsInPaylexer(paylexerPage, gatewayName, gatewayConfig);
        reportStep("configured-in-paylexer");

        await paylexerPage.close();
        console.log("✓ PayLexer tab closed");

        console.log("Back on the WordPress tab — reloading the plugin page...");
        await page.bringToFront();
        await page.reload();
        await page
          .waitForLoadState("networkidle", { timeout: 15000 })
          .catch(() => {});

        pluginGateway = await plugin.readGatewayState(displayGatewayName);
        console.log(
          `Plugin badge for "${displayGatewayName}" after configuring: "${pluginGateway.label}" (${pluginGateway.state})`,
        );

        if (["needs-attention", "not-configured", "missing"].includes(pluginGateway.state)) {
          throw new Error(
            `"${displayGatewayName}" still reads "${pluginGateway.label || "missing"}" on the PayLexer plugin page after being configured in PayLexer` +
              (pluginGateway.detail ? ` (${pluginGateway.detail})` : "") +
              `. Its credentials verified and its Display Settings saved in the dashboard.`,
          );
        }
      }

      // ---- 3d. Configured → Add it (installs it AND enables it in WPTE) ----
      if (pluginGateway.state === "configured") {
        console.log(
          `"${displayGatewayName}" is configured but not on this site — clicking Add...`,
        );
        await plugin.addGateway(displayGatewayName);
        reportStep("added");
      } else {
        console.log(
          `ℹ "${displayGatewayName}" already shows "${pluginGateway.label}" on the plugin page, though it wasn't listed on ${flow.gatewayScreen}.`,
        );
      }

      // Adding normally enables the gateway on the platform, so without a
      // re-check step 4 is skipped and the run goes straight to the currency step.
      gatewayState = "added";

      // EDD never switches a newly added gateway on, and WPTE sometimes
      // doesn't, so their list is read again and, if the gateway arrived
      // unticked, step 4 ticks it.
      if (flow.recheckAfterAdd) {
        console.log(`Re-checking ${flow.gatewayScreen} after the plugin added it...`);
        await flow.openGatewayList(page);
        gatewayState = await flow.readGatewayState(page, gatewayListName, 15000);
        console.log(`Gateway state on ${flow.gatewayScreen}: "${gatewayState}"`);
        reportStep(`${flow.stepPrefix}-${gatewayState}`, displayGatewayName);
        if (gatewayState === "missing") {
          throw new Error(
            `"${displayGatewayName}" was added via the PayLexer plugin but is still not listed on ${flow.gatewayScreen}` +
              (flow.stepPrefix === "edd"
                ? ` (looked for data-gateway-key="paylexer-${gatewayListName.toLowerCase()}").`
                : ` (looked for a row named "${gatewayListName}").`),
          );
        }
      }
    }

    // ---- 4. Listed but not enabled → tick it here ----

    if (gatewayState === "unticked") {
      console.log(
        `"${displayGatewayName}" is listed but not enabled — enabling it...`,
      );
      await flow.enableGateway(page, gatewayListName);
    } else if (gatewayState === "ticked") {
      console.log(
        `✓ "${displayGatewayName}" is already enabled on ${flow.gatewayScreen} — going straight to the currency step`,
      );
    }
  };

  await settleGateway();

  // ---- 5. Currency step, then straight to the product archive ----
  // changeCurrency() sets the currency on the platform's own General screen
  // (WPTE's Currency > General, WooCommerce > Settings > General), saves, then
  // hands off to that platform's openProduct() — FRONTEND_URL/trip for WPTE,
  // FRONTEND_URL/shop for WooCommerce — opening the first priced listing.

  const currencySettings = new CurrencySettingsPage(page);

  let frontEndPage = page;
  let tripPrice = null;
  // Which product was opened, and the rest of the list (config/productChoice.js).
  let productChoice = null;

  if (!currencyToSet) {
    console.log(
      `⚠ No currency defined for "${gatewayName}" in gatewayConfigs.js — skipping currency change.`,
    );
  } else {
    console.log(`Changing the ${flow.label} currency to "${currencyToSet}"...`);

    // No gateway identifier passed on purpose. changeCurrency() only revisits
    // WPTE's Payments > General to tick a gateway when it's given one — and on
    // wte this spec has already settled that screen above, so passing it would
    // send the flow back through it a second time and re-tick/re-save. On
    // woocommerce that block never runs regardless.
    // Third argument: gatewayConfig.trip, where a gateway defines one, books
    // that named trip instead of the first priced listing. Undefined for most
    // gateways, which keeps the priced-trip scan.
    const result = await currencySettings.changeCurrency(
      currencyToSet,
      undefined,
      gatewayConfig.trip,
    );
    frontEndPage = result.page;
    tripPrice = result.tripPrice;
    productChoice = result;
    reportProduct(productChoice.product);
    console.log(`✓ Currency changed to "${currencyToSet}"`);
    reportStep("currency-set", currencyToSet);
    if (tripPrice !== null) {
      console.log(`ℹ Selected trip's listed price: $${tripPrice}`);
    }
  }

  // ---- 6. Book and pay with the gateway from .env ----

  const checkout = new flow.CheckoutPage(frontEndPage);

  // Trip page → date / travellers → Book Now → the WPTE checkout form.
  console.log(`Preparing the order (${flow.label})...`);
  await checkout.prepareOrder();

  console.log("Filling billing details...");
  await checkout.fillBillingDetails();
  console.log("✓ Billing details filled");

  console.log("✓ Reached the checkout form");

  console.log(`Selecting payment gateway ${checkoutGatewayLabel}...`);
  await checkout.selectPaymentGateway(checkoutGatewayName);
  console.log(`✓ ${checkoutGatewayLabel} selected as payment method`);

  console.log("Checking Terms & Conditions...");
  await checkout.checkTermsAndConditions();
  console.log("✓ Terms & Conditions checked");

// A gateway whose sandbox ends on its own site instead of the store's Thank
// You page ("successUrl" on its payment form — Galaxy Pay only). Watched from
// here on, on every page and popup, so the landing still counts if something
// navigates away from it afterwards.
const successUrl = successUrlFor(gatewayName);
let reachedSuccessUrl = null;
if (successUrl) {
  frontEndPage.context().on("request", (request) => {
    if (!reachedSuccessUrl && request.isNavigationRequest() && request.url().startsWith(successUrl)) {
      reachedSuccessUrl = request.url();
    }
  });
}

console.log("Submitting the order...");
const cardPage = await checkout.submitPayment();
console.log("✓ Order submitted — card page/popup ready");

  // Every gateway pays here — through its code, its recipe, or auto-detection
  // of the card form (config/paymentForms.js). Only one marked
  // "noCardForm": true in data/gateways.json passes straight through.
  if (checkout.hasCardDetailsForm(gatewayName)) {
    console.log(`Filling card details for "${gatewayName}"...`);
    await checkout.fillPaymentDetails(cardPage, gatewayName);

    console.log("Submitting card payment...");
    await checkout.submitCardPayment(cardPage, gatewayName);
    console.log("✓ Card payment submitted");
  } else {
    console.log(
      `⏭ "${gatewayName}" is marked "noCardForm" in data/gateways.json — passing the flow without card entry.`,
    );
  }

  // ---- 7. Verify the booking actually landed on Thank You ----
  // Outside the if/else on purpose, so EVERY gateway is verified the same way —
  // the card-form ones and the bank-redirect ones that skip card entry alike.
  //
  // This is the only real end-of-flow assertion in the run. Each gateway's own
  // submitCardPayment() in config/gatewayPaymentForms.js stops as soon as the
  // page LEAVES its card form (waitForSubmissionToTakeEffect: the URL changed,
  // or it carries callback_type=success) — which an error page or an
  // intermediate 3DS hop satisfies just as well. waitForThankYouPage() is what
  // confirms where it actually ended up: the /thank-you path plus the rendered
  // "Thank You" heading, on whichever page/popup the redirect landed on.
  //
  // 120s rather than the 60s default: slowMo is 2000ms in playwright.config.js,
  // which pads every action in the poll loop, and the redirect chain back from
  // the gateway can add several hops of its own.
  if (successUrl) {
    console.log(`Verifying the redirect to ${successUrl} (this gateway's success page, in place of Thank You)...`);
    const deadline = Date.now() + 120000;
    while (!reachedSuccessUrl && Date.now() < deadline) {
      const open = frontEndPage.context().pages().filter((p) => !p.isClosed());
      reachedSuccessUrl = open.map((p) => p.url()).find((url) => url.startsWith(successUrl)) || null;
      if (!reachedSuccessUrl) await page.waitForTimeout(1000);
    }
    if (!reachedSuccessUrl) {
      throw new Error(
        `"${gatewayName}" never redirected to ${successUrl} within 120000ms. Last URLs seen: ${page
          .context()
          .pages()
          .filter((p) => !p.isClosed())
          .map((p) => p.url())
          .join(", ")}`,
      );
    }
    console.log(`✓ Redirected to ${reachedSuccessUrl} — payment accepted`);
  } else {
    console.log("Verifying the Thank You page...");
    await checkout.waitForThankYouPage(120000);
    console.log("✓ Thank You page verified");
  }

  console.log("========== CHECKOUT COMPLETE ==========");

  console.log("========== TEST COMPLETED ==========");

  // Tear the browser down right away — no pause, no trailing waits.
  //
  // Never fails the test. Closing also finalises the trace (playwright.config.js
  // keeps one for failed tests), and that can throw while a response is still
  // streaming into it ("file data stream has unexpected number of bytes") —
  // after the Thank You page has already been verified. A passing test's trace
  // is discarded anyway, so the error says nothing about the payment.
  await page
    .context()
    .close()
    .catch((error) => console.log(`ℹ Closing the browser: ${error.message.split("\n")[0]} (test already passed)`));
});