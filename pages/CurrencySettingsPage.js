const { candidates, openWithFallback } = require("../config/productChoice");
const { expect } = require("@playwright/test");

const currencyPlatforms = require("../config/currencyPlatforms");

class CurrencySettingsPage {
  constructor(page) {
    this.page = page;
  }

  /**
   * Navigates to whichever platform's currency settings screen is
   * configured via the CURRENCY_PLATFORM env var, changes the currency,
   * saves, verifies the success message, then (WTE-specific) ticks the
   * configured gateway's checkbox under Payments > General.
   *
   * @param {string} currencyCode - e.g. "USD", "EUR" (ISO-4217)
   * @param {string} gatewayIdentifier - the gateway's LOGO ALT on Payments >
   *   General, which the row is matched on below. Normally that's the gateway's
   *   displayName; where PayLexer's alt differs, gatewayConfigs.js carries a
   *   `logoAlt` for it and the caller passes that instead. Omit to skip the
   *   Payments > General visit entirely.
   * @param {string} [preferredTripName] - book this specific trip instead of
   *   the first priced one on the archive. Comes from a gateway's `trip` in
   *   gatewayConfigs.js, for gateways that only work against a particular
   *   trip's price or currency. Matched case-insensitively on the listing's
   *   link text; falls back to the priced-trip scan (with a warning) when the
   *   archive has no such trip.
   */
  async changeCurrency(
    currencyCode,
    gatewayIdentifier,
    preferredTripName,
    afterSave,
  ) {
    const platformKey = process.env.CURRENCY_PLATFORM || "wte";

    const platform = currencyPlatforms[platformKey];

    if (!platform) {
      throw new Error(
        `Unknown CURRENCY_PLATFORM "${platformKey}". Valid options: ${Object.keys(
          currencyPlatforms,
        ).join(", ")}. Set CURRENCY_PLATFORM in your .env file.`,
      );
    }

    console.log(`Navigating to ${platform.label} currency settings...`);
    await platform.navigate(this.page);
    console.log(`✓ ${platform.label} currency settings page opened`);

    let currentCurrency;
    let targetMatches;

    if (platform.getCurrentCurrencyText) {
      // Custom widget platform (e.g. WTE's react-window dropdown) — no
      // native <select>, read the visible trigger text instead. Comparison
      // uses the same dynamic Intl.DisplayNames + fuzzy substring approach
      // as selectCurrency() in currencyPlatforms.js, rather than a static
      // per-currency mapping.
      currentCurrency = await platform.getCurrentCurrencyText(this.page);

      let dynamicName;
      try {
        dynamicName = new Intl.DisplayNames(["en"], { type: "currency" }).of(
          currencyCode,
        );
      } catch {
        dynamicName = null;
      }

      const matchTarget = dynamicName?.split("(")[0].trim().toLowerCase();

      // A platform whose labels don't contain the Intl name (FluentCart's
      // "United States (US) dollar") supplies its own comparison.
      if (platform.currencyMatches) {
        targetMatches = platform.currencyMatches(currentCurrency, currencyCode);
      } else {
        targetMatches = matchTarget
          ? currentCurrency?.toLowerCase().includes(matchTarget)
          : false;
      }

      console.log(
        `Currency dropdown reads: "${currentCurrency}" (comparing against target code "${currencyCode}" / "~${dynamicName}")`,
      );
    } else {
      // Native <select> platform (e.g. WooCommerce) — original approach.
      const currencyDropdown = this.page.locator(platform.currencySelector);

      await currencyDropdown.waitFor({
        state: "attached",
        timeout: 30000,
      });

      currentCurrency = await currencyDropdown.inputValue();
      targetMatches = currentCurrency === currencyCode;

      console.log(
        `Currency dropdown reads: "${currentCurrency}" (comparing against target "${currencyCode}")`,
      );
    }

    if (targetMatches) {
      console.log(
        `ℹ Currency already set to "${currencyCode}" — skipping selection and save entirely.`,
      );
    } else {
      console.log(`Selecting currency "${currencyCode}"...`);

      if (platform.selectCurrency) {
        await platform.selectCurrency(this.page, currencyCode);
      } else {
        const currencyDropdown = this.page.locator(platform.currencySelector);
        await currencyDropdown.selectOption(currencyCode);
      }

      console.log(`✓ Currency set to "${currencyCode}"`);

      const saveButton = platform.saveButtonSelector
  ? this.page.locator(platform.saveButtonSelector)
  : this.page.getByRole("button", {
      name: platform.saveButtonName,
    });

await saveButton.waitFor({
  state: "visible",
  timeout: 30000,
});

      const isSaveEnabled = await saveButton.isEnabled();

      if (!isSaveEnabled) {
        // The selection may have been a genuine no-op (currency was
        // already this value from a prior run) — clicking a disabled
        // button has NO default per-action timeout in this project's
        // playwright.config.js, so it would otherwise hang silently,
        // bounded only by the overall test timeout. Skip entirely instead.
        console.log(
          `ℹ Save button is disabled after selecting "${currencyCode}" — likely already set to this value. Skipping save.`,
        );
      } else {
        // networkidle has no timeout of its own by default — if this page
        // has any lingering background request (analytics, polling, etc.)
        // that never fully settles, this would otherwise hang until the
        // OVERALL test timeout, with no intermediate error. Explicit timeout
        // + catch so a slow/never-idle page can't silently eat the whole run.
        await Promise.all([
          this.page
            .waitForLoadState("networkidle", { timeout: 15000 })
            .catch(() => {
              console.log(
                "⚠ Page didn't reach networkidle within 15s — continuing anyway.",
              );
            }),
          saveButton.click(),
        ]);

        console.log(`✓ ${platform.label} settings saved`);

        const successMessage = this.page.getByText(platform.successText);

        await successMessage.waitFor({
          state: "visible",
          timeout: 30000,
        });

        console.log(`✓ Currency change confirmed on ${platform.label}`);
      }
    }

    // ---- WTE-specific: tick the configured gateway under Payments > General ----
    // Only applies to the "wte" platform — WooCommerce/other platforms don't
    // have this nested Payments > General gateway checklist. Runs right
    // after currency setting, while still on WP admin.
    if (platformKey === "wte" && gatewayIdentifier) {
      console.log("Navigating to Payments...");

      const paymentsTab = this.page.locator(
        'span[title="Payments"].wpte-menu-link',
      );
      await paymentsTab.waitFor({ state: "visible", timeout: 30000 });
      await paymentsTab.click();

      console.log("Clicking Payments > General...");

      // Same pattern as Currency > General: the nested "General" here is an
      // <a> tag with href containing "payment-general", distinct from any
      // unrelated top-level "General" item.
      const paymentsGeneralLink = this.page.locator(
        'a[title="General"].wpte-menu-link[href*="payment-general"]',
      );
      await paymentsGeneralLink.waitFor({ state: "visible", timeout: 30000 });
      await paymentsGeneralLink.click();

      console.log("✓ Payments > General opened");

      console.log(`Enabling gateway "${gatewayIdentifier}" checkbox...`);

      // Real markup: <label><input type="checkbox"><figure><img alt="Westpac PayWay">...
      // Matching by the img's alt attribute is exact and reliable — no need
      // to guess at row/label text matching.
      const gatewayLabel = this.page.locator("label").filter({
        has: this.page.locator(`img[alt="${gatewayIdentifier}"]`),
      });

      await gatewayLabel.waitFor({ state: "visible", timeout: 30000 });

      const gatewayCheckbox = gatewayLabel.locator('input[type="checkbox"]');

      await gatewayCheckbox.waitFor({ state: "visible", timeout: 30000 });

      const paymentsGeneralSaveButton = this.page.getByRole("button", {
        name: "Save Settings",
      });

      // Small helper wrapping the wait/enable-check/click/log block. No
      // assertion here — a disabled Save after a checkbox toggle that turned
      // out to be a no-op is expected, not a failure.
      const saveIfEnabled = async (context) => {
        await paymentsGeneralSaveButton.waitFor({
          state: "visible",
          timeout: 30000,
        });

        const isSaveEnabled = await paymentsGeneralSaveButton.isEnabled();

        if (isSaveEnabled) {
          await Promise.all([
            this.page
              .waitForLoadState("networkidle", { timeout: 15000 })
              .catch(() => {}),
            paymentsGeneralSaveButton.click(),
          ]);
          console.log(`✓ Payments > General settings saved (after ${context})`);
        } else {
          console.log(
            `ℹ Save Settings button disabled after ${context} "${gatewayIdentifier}" — checkbox state likely unchanged. This is expected, not a failure.`,
          );
        }
      };

      // Already ticked means it's already enabled for checkout — bypass
      // entirely, leaving the checkbox and the settings untouched. Only an
      // unticked gateway needs a tick → save.
      if (await gatewayCheckbox.isChecked()) {
        console.log(
          `✓ "${gatewayIdentifier}" is already ticked — bypassing (no tick, no save)`,
        );
      } else {
        console.log(`Ticking "${gatewayIdentifier}"...`);
        await gatewayCheckbox.check();
        await saveIfEnabled("ticking");
      }
    }

    // ---- Caller's post-save step (e.g. EDD's gateway check) ----
    // Runs whether or not a save was actually needed, while still in WP admin.
    if (afterSave) {
      await afterSave(this.page);
    }

    // ---- Go straight to the front-end product/trip archive ----
    // Platform-specific: WTE lists trips at /trip, WooCommerce lists products
    // at /shop, and the card markup shares nothing between them. Each
    // platform owns that walk in its own openProduct(), so this method stays
    // about currency. Navigating directly via FRONTEND_URL (from .env)
    // instead of clicking the admin-bar site-name link — simpler, and works
    // for any tester by just changing that one env var.
    if (typeof platform.openProduct !== "function") {
      throw new Error(
        `Platform "${platformKey}" defines no openProduct(). Add one to its entry in config/currencyPlatforms.js.`,
      );
    }

    // Which product: the gateway's own trip, then the Products panel's list
    // for this site (or .env), then the first priced listing — the next one
    // tried whenever one can't be opened (config/productChoice.js).
    const products = candidates(platformKey, preferredTripName);
    const opened = await openWithFallback(platform, platformKey, this.page, products);

    // Return the page, the captured price, and which product was used —
    // `products` / `productIndex` let a later step that fails on this product
    // (an add to cart the site refuses) carry on with the next one.
    return {
      page: this.page,
      tripPrice: opened.price,
      product: opened.product,
      products,
      productIndex: opened.index,
    };
  }

  /**
   * Verifies the checkout flow landed on the Thank You confirmation page.
   * Call this right after CheckoutPage completes the purchase.
   */
  async verifyThankYouPage() {
    console.log("Verifying Thank You page...");

    const thankYouHeading = this.page.locator("h1.entry-title", {
      hasText: "Thank You",
    });

    await thankYouHeading.waitFor({ state: "visible", timeout: 30000 });

    await expect(thankYouHeading).toHaveText("Thank You");

    console.log("✓ Thank You page confirmed");
  }

  /**
   * Skips any Thank You page check — goes straight from checkout to the
   * PayLexer dashboard (reusing session if still logged in), opens Orders,
   * and verifies the status badge for the relevant order.
   *
   * @param {string} expectedStatus - e.g. "Completed"
   * @param {string} [orderIdentifier] - text unique to the order's row
   */
  async verifyOrderAfterCheckout(expectedStatus, orderIdentifier) {
    await this.verifyOrderStatus(expectedStatus, orderIdentifier);
  }

  /**
   * Navigates to the PayLexer dashboard. If the session is still valid
   * (e.g. from earlier in the same test run / persisted storageState),
   * this is a no-op past the goto. Only fills in credentials if a login
   * form is actually detected — so it won't re-log-in on every call.
   *
   * Adjust the login selectors/env var names below to match your actual
   * PayLexer login page.
   */
  async ensurePaylexerLoggedIn() {
    const paylexerUrl = process.env.PAYLEXER_URL;

    if (!paylexerUrl) {
      throw new Error(
        "PAYLEXER_URL is not set. Set it in your .env file to the PayLexer dashboard base URL.",
      );
    }

    console.log("Navigating to PayLexer dashboard...");
    await this.page.goto(paylexerUrl);
    await this.page
      .waitForLoadState("networkidle", { timeout: 15000 })
      .catch(() => {});

    // Detect whether we've been redirected to / landed on a login form.
    // Adjust this selector to whatever uniquely identifies PayLexer's
    // login page/form (e.g. an email input, a "Sign in" heading, etc.)
    const loginEmailInput = this.page.locator(
      'input[type="email"], input[name="email"]',
    );

    const isLoginPage = await loginEmailInput
      .first()
      .isVisible({ timeout: 5000 })
      .catch(() => false);

    if (!isLoginPage) {
      console.log("✓ Already logged in to PayLexer — skipping login");
      return;
    }

    console.log("Not logged in — filling PayLexer login credentials...");

    const paylexerEmail = process.env.PAYLEXER_EMAIL;
    const paylexerPassword = process.env.PAYLEXER_PASSWORD;

    if (!paylexerEmail || !paylexerPassword) {
      throw new Error(
        "PAYLEXER_EMAIL / PAYLEXER_PASSWORD not set. Add them to your .env file.",
      );
    }

    await loginEmailInput.first().fill(paylexerEmail);

    const loginPasswordInput = this.page.locator(
      'input[type="password"], input[name="password"]',
    );
    await loginPasswordInput.first().fill(paylexerPassword);

    const loginSubmitButton = this.page.getByRole("button", {
      name: /log in|sign in/i,
    });

    await Promise.all([
      this.page
        .waitForLoadState("networkidle", { timeout: 15000 })
        .catch(() => {}),
      loginSubmitButton.click(),
    ]);

    console.log("✓ Logged in to PayLexer");
  }

  /**
   * Opens Orders (assumes ensurePaylexerLoggedIn() has already run / the
   * dashboard is the current page) and verifies the status badge for the
   * relevant order.
   *
   * @param {string} expectedStatus - e.g. "Completed"
   * @param {string} [orderIdentifier] - text unique to the order's row
   *   (e.g. order number or trip name) so the correct row's badge is
   *   checked instead of just the first one in the list. If omitted,
   *   falls back to the first row (assumed most recent order).
   */
  async verifyOrderStatus(expectedStatus, orderIdentifier) {
    // Reuses the existing session if already logged in; only fills
    // credentials if PayLexer actually shows a login form.
    await this.ensurePaylexerLoggedIn();

    console.log("Clicking Orders in sidebar...");

    const ordersLink = this.page.locator(
      'li[data-slot="sidebar-menu-item"] a[href="/orders"]',
    );

    await ordersLink.waitFor({ state: "visible", timeout: 30000 });

    await Promise.all([
      this.page
        .waitForLoadState("networkidle", { timeout: 15000 })
        .catch(() => {}),
      ordersLink.click(),
    ]);

    console.log("✓ Orders page opened");

    // Scope to the specific order's row if an identifier is given, so we
    // don't accidentally read the badge from an unrelated order. Falls
    // back to the first badge on the page if no identifier is provided.
    let statusBadge;

    if (orderIdentifier) {
      const orderRow = this.page
        .locator("tr, [data-slot='table-row']")
        .filter({ hasText: orderIdentifier });

      statusBadge = orderRow.locator('span[data-slot="badge"]');
    } else {
      statusBadge = this.page.locator('span[data-slot="badge"]').first();
    }

    await statusBadge.waitFor({ state: "visible", timeout: 30000 });

    await expect(statusBadge).toContainText(expectedStatus);

    console.log(`✓ Order status confirmed as "${expectedStatus}"`);
  }
}

module.exports = CurrencySettingsPage;
