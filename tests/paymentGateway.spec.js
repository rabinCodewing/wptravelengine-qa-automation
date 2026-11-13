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

const { test } = require("@playwright/test");

const DashboardPage = require("../pages/DashboardPage");
const PaymentGatewayPage = require("../pages/PaymentGatewayPage");
const GatewayConfigurationPage = require("../pages/GatewayConfigurationPage");
const CurrencySettingsPage = require("../pages/CurrencySettingsPage");
const CheckoutPage = require("../pages/CheckoutPage");

const gatewayConfigs = require("../config/gatewayConfigs");
const { openDashboard, openWpAdmin } = require("../config/session");

test.setTimeout(600000);

test("Configure Payment Gateway", async ({ page }) => {
  const dashboard = new DashboardPage(page);
  const gateway = new PaymentGatewayPage(page);
  const configure = new GatewayConfigurationPage(page);

  console.log("========== TEST STARTED ==========");

  const gatewayName = process.env.PAYMENT_GATEWAY;

  const gatewayConfig = gatewayConfigs[gatewayName];

  if (!gatewayConfig) {
    throw new Error(
      `No configuration found for gateway "${gatewayName}". Please add it to config/gatewayConfigs.js`,
    );
  }

  // Some gateway keys (e.g. "WestpacPayWay") don't match the exact on-screen
  // text (e.g. "Westpac PayWay"). Use displayName for anything that matches
  // visible UI text; keep gatewayName (the key) for env-var/credential lookups.
  const displayGatewayName = gatewayConfig.displayName || gatewayName;

  // No login here on purpose. playwright.config.js loads
  // playwright/.auth/user.json as the default storageState, so this context
  // starts already authenticated and goes straight to the dashboard.
  // Mint that file once with:
  //   npx playwright test tests/login.setup.js --project=setup
  console.log("Opening dashboard with the saved session...");
  await openDashboard(page);
  console.log("✓ Dashboard opened — login skipped (saved session reused)");

  console.log("Opening Payment Gateways...");
  await dashboard.openPaymentGateways();
  console.log("✓ Payment Gateways page opened");

  console.log(`Searching for "${displayGatewayName}"...`);
  await gateway.searchGateway(displayGatewayName);
  console.log(`✓ ${displayGatewayName} found`);

  console.log(`Opening "${displayGatewayName}" configuration...`);
  await gateway.clickConfigure(displayGatewayName);
  console.log("✓ Configuration page opened");

  // wait for configuration form to load
  await page.waitForTimeout(2000);

  // Try the already-saved credentials first: click Verify connection directly.
  // If it verifies, there's nothing to change. Only if it errors (or there's
  // nothing saved yet) do we clear the existing credentials and refill them
  // from .env, then save and verify again.
  const credentialsAlreadyValid = await configure.tryVerifyExistingConnection(
    gatewayConfig.successMessage,
  );

  if (credentialsAlreadyValid) {
    console.log(
      "✓ Existing credentials already verify — skipping credential fill",
    );
  } else {
    console.log(`Filling ${gatewayName} credentials from .env...`);
    await configure.fillCredentials(gatewayName, gatewayConfig.fields);
    console.log("✓ Credentials filled");

    console.log("Saving & Verifying...");
    await configure.saveAndVerify();
    console.log("✓ Save & Verify clicked");

    console.log("Checking connection...");
    await configure.verifyConnection(gatewayConfig.successMessage);
    console.log("✓ Connection verified");
  }

  console.log("Opening Display Settings...");
  await configure.clickPaymentMethod();
  console.log("✓ Display Settings opened");

  console.log("Saving Display Settings...");
  await configure.saveDisplaySettings();
  console.log("✓ Save Display Settings clicked");

  console.log("Verifying Display Settings...");
  await configure.verifyDisplaySettingsSaved();
  console.log("✓ Display Settings saved");

  console.log("========== GATEWAY CONFIGURATION COMPLETE ==========");

  // ---- Post-configuration: navigate to Websites and toggle gateway ----

  console.log("Navigating to Websites...");
  await dashboard.goToWebsites();
  console.log("✓ Websites page opened");

  console.log("Clicking edit (pencil) button...");
  await dashboard.clickEditWebsite();
  console.log("✓ Edit button clicked");

  // If the gateway is already ticked there's nothing to change, so both the
  // tick and the save are bypassed — Save Settings would either be disabled or
  // write back the exact same state — and the flow goes straight to the Test
  // Connection button. Only an actual tick triggers a save.
  console.log(
    `Ensuring gateway "${displayGatewayName}" is ticked in website settings...`,
  );
  const gatewayWasTicked = gatewayConfig.slug
    ? await dashboard.toggleGatewayBySlug(gatewayConfig.slug)
    : await dashboard.toggleGateway(displayGatewayName);

  if (gatewayWasTicked) {
    console.log(`✓ "${displayGatewayName}" ticked`);

    console.log("Saving website settings...");
    await dashboard.saveWebsiteSettings();
    console.log("✓ Website settings saved");
  } else {
    console.log(
      `✓ "${displayGatewayName}" was already ticked — bypassing tick and save, going straight to Test Connection`,
    );
  }

  console.log("========== WEBSITE SETTINGS COMPLETE ==========");

  // ---- Check the PayLexer ↔ WordPress connection ----
  // Plugin v2 connects from its own admin page (Connect Account, then
  // authorize in PayLexer) — there is no Client ID / Site Key to copy any more.
  // Sign in to both (tests/login.setup.js) establishes it; this only checks.
  console.log("Checking whether the connection is active...");
  const connectionActive = await dashboard.checkConnectionActive();

  if (!connectionActive) {
    throw new Error(
      "This WordPress site isn't connected to PayLexer. Connect it with Sign in to both in the UI " +
        "(or Connect Account on WP admin > PayLexer), then re-run.",
    );
  }
  console.log("✓ Connection active");

  console.log("Navigating to Websites...");
  await dashboard.goToWebsites();
  console.log("✓ Websites page opened");

  console.log("Verifying website status is Active...");
  await dashboard.verifyWebsiteActive();
  console.log("✓ Website status confirmed Active");

  // ---- Reopen WordPress in a new tab and log in again ----

  console.log("Reopening wp-admin in a new tab...");
  const wpPage2 = await page.context().newPage();
  await openWpAdmin(wpPage2);
  console.log("✓ wp-admin reopened — WordPress login skipped");

  // ---- Change WP Travel Engine currency to match the gateway ----

  const currencySettings = new CurrencySettingsPage(wpPage2);

  const currencyToSet = gatewayConfig.currencies?.[0];

  let frontEndPage = wpPage2;
  let tripPrice = null;

  if (!currencyToSet) {
    console.log(
      `⚠ No currency defined for "${gatewayName}" in gatewayConfigs.js — skipping currency change.`,
    );
  } else {
    console.log(`Changing WP Travel Engine currency to "${currencyToSet}"...`);
    // changeCurrency() finds the Payments > General row by the logo's alt and
    // matches it exactly, so it's given gatewayConfigs' `logoAlt` where a
    // gateway's alt doesn't read the same as its display name. Gateways without
    // that field fall back to the display name.
    // gatewayConfig.trip, where a gateway defines one, books that named trip
    // instead of the first priced listing. Undefined for most gateways, which
    // keeps the priced-trip scan.
    const result = await currencySettings.changeCurrency(
      currencyToSet,
      gatewayConfig.logoAlt || displayGatewayName,
      gatewayConfig.trip,
    );
    frontEndPage = result.page;
    tripPrice = result.tripPrice;
    console.log(`✓ Currency changed to "${currencyToSet}"`);
    if (tripPrice !== null) {
      console.log(`ℹ Selected trip's listed price: $${tripPrice}`);
    }
  }

  // ---- Book the trip and pay using the gateway configured in .env ----
  // Uses displayGatewayName (from gatewayConfig.displayName || gatewayName),
  // the same identifier already used to match visible UI text elsewhere.
  // Uses frontEndPage in case the site-name link opened a new tab.

  const checkout = new CheckoutPage(frontEndPage);

  console.log("Booking trip (clicking Check Availability)...");
  await checkout.bookTrip();
  console.log("✓ Check Availability clicked");

  console.log("Waiting for calendar and clicking Continue...");
  await checkout.clickContinueOnCalendar();
  console.log("✓ Continue clicked on calendar step");

  console.log("Incrementing traveler count (3 times)...");
  await checkout.incrementTravelerCount(3);
  console.log("✓ Traveler count incremented 3 times");

  console.log("Proceeding to checkout...");
  await checkout.proceedToCheckout();
  console.log("✓ Proceeded to checkout");

  console.log("Filling billing details...");
  await checkout.fillBillingDetails();
  console.log("✓ Billing details filled");

  console.log(`Selecting payment gateway "${displayGatewayName}"...`);
  await checkout.selectPaymentGateway(displayGatewayName);
  console.log(`✓ "${displayGatewayName}" selected as payment method`);

  console.log("Checking Terms & Conditions...");
  await checkout.checkTermsAndConditions();
  console.log("✓ Terms & Conditions checked");

  console.log("Clicking Confirm Booking...");
  const cardPage = await checkout.submitPayment();
  console.log("✓ Confirm Booking clicked — card page/popup ready");

  // ---- Card details popup (dispatches to config/gatewayPaymentForms.js) ----
  // Only gateways with an entry in gatewayPaymentForms.js present a card form
  // after Confirm Booking — today that's Westpac. For every other gateway
  // there's nothing to fill, so the flow passes straight through rather than
  // failing on a form that was never going to appear.

  if (checkout.hasCardDetailsForm(gatewayName)) {
    console.log(`Filling card details for "${gatewayName}"...`);
    console.log(
      "Using fixed test card: 4564 7100 0000 0004, Token Tutorial, CVV 847, exp 02/29",
    );
    await checkout.fillPaymentDetails(cardPage, gatewayName);

    console.log("Submitting card payment...");
    await checkout.submitCardPayment(cardPage, gatewayName);
    console.log("✓ Card payment submitted");
  } else {
    console.log(
      `⏭ "${gatewayName}" has no card-details form (no entry in config/gatewayPaymentForms.js) — passing the flow without card entry.`,
    );
    console.log(
      "  To exercise its card form, add an entry there following the Westpac one.",
    );
  }

  // ---- Verify the booking actually landed on Thank You ----
  // Outside the if/else on purpose, so EVERY gateway is verified the same way —
  // the card-form ones and the bank-redirect ones that skip card entry alike.
  //
  // Replaces the commented-out verifyPaymentSuccess(cardPage) that used to sit
  // in the if-block above. That one only looked for callback_type=success in the
  // URL, which the gateway handlers already treat as "done"; this checks the
  // /thank-you path AND the rendered "Thank You" heading, so a redirect that
  // lands somewhere else can't pass. It also polls every page in the context,
  // so it works whether the gateway finished in this tab or in a popup.
  //
  // 120s rather than the 60s default: slowMo is 2000ms in playwright.config.js,
  // which pads every action in the poll loop, and the redirect chain back from
  // the gateway can add several hops of its own.
  console.log("Verifying the Thank You page...");
  await checkout.waitForThankYouPage(120000);
  console.log("✓ Thank You page verified");

  console.log("========== CHECKOUT COMPLETE ==========");

  console.log("========== TEST COMPLETED ==========");

  // Nothing is verified past the card submission, so tear the browser down
  // right away rather than leaving it open — no pause, no trailing waits.
  await page.context().close();
});
