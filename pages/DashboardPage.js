const { expect } = require("@playwright/test");
const { DashboardLocators } = require("../locators/dashboard.locators");
const { revealElement } = require("../tests/smoothScroll");

/**
 * Escapes regex metacharacters so a gateway name is matched literally.
 *
 * Not optional: gatewayConfigs.js carries display names that are themselves
 * regex syntax. "Cost+" interpolated raw becomes /^Cost+$/i — "Cos" followed by
 * one or more "t" — which matches "Cost" and never "Cost+". "Pay.jp",
 * "Checkout.com" and "Authorize.Net" happen to still match because "." matches
 * the literal dot, but that's luck, not correctness.
 */
function escapeForRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

class DashboardPage {
  constructor(page) {
    this.page = page;
  }

  async openPaymentGateways() {
    await this.page.locator(DashboardLocators.paymentGatewayMenu).click();
  }

  async goToWebsites() {
    console.log("Opening Websites from sidebar...");

    const websitesLink = this.page
      .locator("span")
      .filter({ hasText: "Websites" })
      .first();

    await websitesLink.waitFor({
      state: "visible",
      timeout: 30000,
    });

    await websitesLink.click();

    console.log("✓ Websites page opened");
  }

  async clickEditWebsite() {
    console.log("Clicking edit (pencil) button...");

    const editButton = this.page
      .locator("button")
      .filter({ has: this.page.locator("svg.lucide-square-pen") })
      .first();

    await editButton.waitFor({
      state: "visible",
      timeout: 30000,
    });

    await editButton.click();

    console.log("✓ Edit button clicked");
  }

  /**
   * Ensures a gateway's checkbox is ticked in website settings, matching it by
   * the VISIBLE TEXT of its label. Use this for gateways where the on-screen
   * label text is unique and stable. For gateways where text matching is
   * unreliable (e.g. text differs between screens, or is ambiguous),
   * use toggleGatewayBySlug() instead.
   *
   * If the gateway is already ticked, this is a no-op — nothing is clicked.
   *
   * @param {string} gatewayName - the display text to match, e.g. "Stripe"
   * @returns {Promise<boolean>} true if the checkbox was changed (and so the
   *   settings need saving), false if it was already ticked and left alone.
   */
  async toggleGateway(gatewayName) {
    console.log(`Searching for gateway "${gatewayName}" in the list...`);

    const row = this.page.locator("div.flex.items-center.space-x-3").filter({
      has: this.page.locator("label", {
        hasText: new RegExp(`^${escapeForRegExp(gatewayName)}$`, "i"),
      }),
    });

    await row.waitFor({
      state: "visible",
      timeout: 30000,
    });

    console.log(`✓ Found "${gatewayName}" row`);

    const getCheckbox = () => row.locator('button[role="checkbox"]');
    const getLabel = () => row.locator("label");

    let checkbox = getCheckbox();

    await checkbox.waitFor({
      state: "visible",
      timeout: 30000,
    });

    const isChecked = (await checkbox.getAttribute("aria-checked")) === "true";

    console.log(
      `Current state of "${gatewayName}": ${isChecked ? "checked" : "unchecked"}`,
    );

    const clickAndVerify = async (expectedState) => {
      for (let attempt = 1; attempt <= 3; attempt++) {
        const cb = getCheckbox();
        await cb.scrollIntoViewIfNeeded();

        await cb.click({ force: true });

        try {
          await expect(cb).toHaveAttribute("aria-checked", expectedState, {
            timeout: 4000,
          });
          return;
        } catch (e) {
          console.log(
            `Attempt ${attempt}: click on checkbox button didn't register, trying label instead...`,
          );

          const label = getLabel();
          await label.click({ force: true });

          try {
            await expect(getCheckbox()).toHaveAttribute(
              "aria-checked",
              expectedState,
              { timeout: 4000 },
            );
            return;
          } catch (e2) {
            console.log(
              `Attempt ${attempt}: label click also didn't register, retrying...`,
            );
            await this.page.waitForTimeout(500);
          }
        }
      }

      throw new Error(
        `Failed to set "${gatewayName}" checkbox to aria-checked="${expectedState}" after retries`,
      );
    };

    if (isChecked) {
      console.log(
        `✓ "${gatewayName}" is already ticked — bypassing (nothing to change or save)`,
      );

      return false;
    }

    console.log(`Checking "${gatewayName}"...`);
    await clickAndVerify("true");
    console.log(`✓ "${gatewayName}" checked`);

    return true;
  }

  /**
   * Ensures a gateway's checkbox is ticked in website settings, matching it by
   * its stable slug (the label's `for="pg_{slug}"` attribute) instead of by
   * visible text, which can differ between screens (search card vs. toggle list).
   *
   * If the gateway is already ticked, this is a no-op — nothing is clicked.
   *
   * @param {string} slug - e.g. "westpac-payway" (from gatewayConfigs[name].slug)
   * @returns {Promise<boolean>} true if the checkbox was changed (and so the
   *   settings need saving), false if it was already ticked and left alone.
   */
  async toggleGatewayBySlug(slug) {
    console.log(`Searching for gateway checkbox with slug "${slug}"...`);

    const label = this.page.locator(`label[for="pg_${slug}"]`);

    await label.waitFor({
      state: "visible",
      timeout: 30000,
    });

    console.log(`✓ Found label for "pg_${slug}"`);

    const row = this.page
      .locator("div.flex.items-center.space-x-3")
      .filter({ has: label });

    await row.waitFor({
      state: "visible",
      timeout: 30000,
    });

    const getCheckbox = () => row.locator('button[role="checkbox"]');
    const getLabel = () => row.locator(`label[for="pg_${slug}"]`);

    let checkbox = getCheckbox();

    await checkbox.waitFor({
      state: "visible",
      timeout: 30000,
    });

    const isChecked = (await checkbox.getAttribute("aria-checked")) === "true";

    console.log(
      `Current state of "${slug}": ${isChecked ? "checked" : "unchecked"}`,
    );

    const clickAndVerify = async (expectedState) => {
      for (let attempt = 1; attempt <= 3; attempt++) {
        const cb = getCheckbox();
        await cb.scrollIntoViewIfNeeded();

        await cb.click({ force: true });

        try {
          await expect(cb).toHaveAttribute("aria-checked", expectedState, {
            timeout: 4000,
          });
          return;
        } catch (e) {
          console.log(
            `Attempt ${attempt}: click on checkbox button didn't register, trying label instead...`,
          );

          const label = getLabel();
          await label.click({ force: true });

          try {
            await expect(getCheckbox()).toHaveAttribute(
              "aria-checked",
              expectedState,
              { timeout: 4000 },
            );
            return;
          } catch (e2) {
            console.log(
              `Attempt ${attempt}: label click also didn't register, retrying...`,
            );
            await this.page.waitForTimeout(500);
          }
        }
      }

      throw new Error(
        `Failed to set "pg_${slug}" checkbox to aria-checked="${expectedState}" after retries`,
      );
    };

    if (isChecked) {
      console.log(
        `✓ "${slug}" is already ticked — bypassing (nothing to change or save)`,
      );

      return false;
    }

    console.log(`Checking "${slug}"...`);
    await clickAndVerify("true");
    console.log(`✓ "${slug}" checked`);

    return true;
  }

  /**
   * Whether the gateway is offered at all on the website-edit screen — WITHOUT
   * throwing when it isn't.
   *
   * toggleGateway() and toggleGatewayBySlug() both waitFor() the row, so on a
   * gateway that was never configured on the account they spend 30s and then
   * fail. That's a state a caller may want to RECOVER from (configure the
   * gateway, then come back), not die on, so this reports it as a boolean.
   *
   * Short timeout on purpose, same reasoning as readGatewayState() in
   * wpGatewayCheckout.spec.js: the gateway list renders with the rest of the
   * screen, so a row still absent after a few seconds isn't coming.
   *
   * @param {string|undefined} slug - gatewayConfigs[name].slug, when it has one
   * @param {string} gatewayName - display text, used when there's no slug
   * @returns {Promise<boolean>}
   */
  async isGatewayListed(slug, gatewayName, timeoutMs = 5000) {
    const target = slug
      ? this.page.locator(`label[for="pg_${slug}"]`)
      : this.page
          .locator("label")
          .filter({
            hasText: new RegExp(`^${escapeForRegExp(gatewayName)}$`, "i"),
          });

    try {
      await target.first().waitFor({ state: "visible", timeout: timeoutMs });
      // Show where it is on the website-edit screen — a read never scrolls.
      await revealElement(target.first());
      return true;
    } catch (e) {
      console.log(
        `ℹ "${slug ? `pg_${slug}` : gatewayName}" is not offered on the website-edit screen. ` +
          `Gateways actually listed: ${JSON.stringify(await this.listWebsiteGateways())}`,
      );

      return false;
    }
  }

  /**
   * Every gateway label rendered on the website-edit screen, as {slug, text}
   * pairs. Logged when a gateway reads as absent, so the run itself shows
   * whether it's genuinely not configured or just labelled/slugged differently
   * than what's in gatewayConfigs.js.
   */
  async listWebsiteGateways() {
    return this.page
      .evaluate(() =>
        Array.from(document.querySelectorAll('label[for^="pg_"]')).map(
          (label) => ({
            slug: (label.getAttribute("for") || "").replace(/^pg_/, ""),
            text: (label.textContent || "").trim().slice(0, 40),
          }),
        ),
      )
      .catch((err) => `<unreadable: ${err.message}>`);
  }

  async saveWebsiteSettings() {
    console.log("Clicking Save Settings...");

    // Located by structure, not by its label. Save Settings and Test
    // Connection are siblings in the same footer row:
    //   <div class="flex pt-4 justify-between items-center">
    //     <button data-slot="button" type="submit">Save Settings</button>
    //     <button data-slot="button" type="button" data-testid="test-connection-btn">Test Connection</button>
    //   </div>
    // Only Test Connection carries a data-testid, so that testid is the one
    // stable hook in the row — anchor on it, then take the sibling that is
    // type="submit". Save Settings is the only submit button there, so this
    // survives the button's text, its tailwind classes, and its width changing.
    //
    // `.first()` guards strict mode: PayLexer renders this footer inside a
    // dialog, and a second copy elsewhere in the DOM would otherwise make the
    // locator ambiguous rather than just picking the visible one.
    const settingsFooter = this.page.locator(
      'div:has(> [data-testid="test-connection-btn"])',
    );

    const saveButton = settingsFooter
      .locator('button[data-slot="button"][type="submit"]')
      .first();

    await saveButton.waitFor({
      state: "visible",
      timeout: 30000,
    });

    // PayLexer's Save Settings carries `disabled:opacity-50` /
    // `disabled:pointer-events-none` — it renders disabled until the form is
    // dirty, and React can take a beat to register the checkbox tick that
    // happened just before this call. So poll for enabled rather than clicking
    // straight away: a bare click on a disabled button burns the whole action
    // timeout and reports as "element is not enabled", which reads like a
    // missing button rather than a state issue.
    const enabledDeadline = Date.now() + 10000;
    let saveEnabled = await saveButton.isEnabled();

    while (!saveEnabled && Date.now() < enabledDeadline) {
      await this.page.waitForTimeout(300);
      saveEnabled = await saveButton.isEnabled();
    }

    if (!saveEnabled) {
      // Disabled after 10s means the form never went dirty — the setting was
      // already stored, so there is genuinely nothing to save. Same call as
      // CurrencySettingsPage makes on Payments > General: expected, not a
      // failure, but logged loudly in case a later step disagrees.
      console.log(
        "ℹ Save Settings is still disabled after 10s — the form never went dirty, so the setting was already stored. Skipping the save.",
      );
      return;
    }

    await saveButton.scrollIntoViewIfNeeded();

    // PayLexer confirms a save with a [role="status"] toast — the same pattern
    // as the "Connection verified successfully." toast used elsewhere in this
    // class. Waiting for it is what proves the save actually landed server-side
    // rather than just that the button was clicked, which matters because
    // callers immediately go and check the result on another site.
    //
    // The `hasText: /\S/` filter skips the always-present but empty aria-live
    // region, so this can't resolve on a blank container.
    const confirmation = this.page
      .locator('[role="status"]')
      .filter({ hasText: /\S/ })
      .first();

    // Armed BEFORE the click on purpose: these toasts auto-dismiss, so clicking
    // first and looking afterwards can miss the message entirely.
    const confirmationSeen = Promise.all([
      confirmation.waitFor({ state: "visible", timeout: 20000 }),
      confirmation.innerText(),
    ])
      .then(([, text]) => text.trim())
      .catch(() => null);

    await saveButton.click();

    const message = await confirmationSeen;

    if (message) {
      console.log(`✓ Save confirmed by PayLexer: "${message}"`);
    } else {
      // Non-fatal: the save may well have succeeded with different toast markup
      // or wording, and the caller's own verification is the real check. Loud
      // so it's obvious in the log if this is why a later step disagrees.
      console.log(
        "⚠ No save-confirmation message appeared within 20s — continuing, but the save may not have landed",
      );
    }

    await this.page
      .waitForLoadState("networkidle", { timeout: 15000 })
      .catch(() => {});

    console.log("✓ Save Settings clicked");
  }

  /**
   * Guarantees the website-edit dialog is open, reopening it if it isn't.
   *
   * The edit screen is itself a dialog, and closeConnectionModalIfPresent()
   * targets [data-slot="dialog-close"] — so when the connection test raises no
   * modal of its own (a FAILED test does not), that close click lands on the
   * EDIT dialog and drops the page back to the Websites list. Everything that
   * reads the edit screen afterwards — the Test Connection button — has to
   * confirm it's actually open first.
   *
   * Keyed on #clientId rather than a dialog wrapper: it's the field callers
   * actually need, so its visibility is the condition that matters.
   */
  async ensureWebsiteEditOpen() {
    const clientIdInput = this.page.locator("#clientId");

    if (await clientIdInput.isVisible().catch(() => false)) {
      console.log("✓ Website-edit screen is already open");
      return;
    }

    console.log("Website-edit screen isn't open — reopening it...");
    await this.clickEditWebsite();
    await clientIdInput.waitFor({ state: "visible", timeout: 30000 });
    console.log("✓ Website-edit screen reopened");
  }

  /**
   * Closes the website-edit dialog via its X, and waits for it to actually go.
   *
   * Needed before navigating anywhere from that screen. The edit screen is a
   * MODAL: while it is open its overlay sits over the sidebar, so a click on
   * "Payment Gateways" lands on the overlay instead of the link and the run
   * stalls until the action timeout — with a call log that reads "visible,
   * enabled and stable", because the link genuinely is all three. It is simply
   * covered.
   *
   * Waits on #clientId DISAPPEARING rather than on the click returning: the
   * dialog animates out, and a sidebar click fired during that animation hits
   * the overlay on its way off screen — the same failure, just harder to spot.
   *
   * Best-effort about the button itself: a caller that is already on the
   * Websites list has nothing to close and should carry on, not fail.
   */
  async closeWebsiteEditDialog() {
    const clientIdInput = this.page.locator("#clientId");

    if (!(await clientIdInput.isVisible().catch(() => false))) {
      console.log("ℹ Website-edit screen isn't open — nothing to close");
      return;
    }

    console.log("Closing the website-edit dialog (X button)...");

    const closeButton = this.page.locator('[data-slot="dialog-close"]');

    await closeButton.first().waitFor({ state: "visible", timeout: 15000 });
    await closeButton.first().click();

    await clientIdInput
      .waitFor({ state: "hidden", timeout: 15000 })
      .catch(() => {
        console.log("⚠ Website-edit dialog did not close within 15s");
      });

    console.log("✓ Website-edit dialog closed");
  }

  async testConnection() {
    console.log("Clicking Test Connection...");

    const testConnectionBtn = this.page.locator(
      '[data-testid="test-connection-btn"]',
    );

    await testConnectionBtn.waitFor({ state: "visible", timeout: 30000 });
    await testConnectionBtn.scrollIntoViewIfNeeded();
    await testConnectionBtn.click();

    console.log("✓ Test Connection clicked");

    console.log("Waiting for verification message...");

    const statusMessage = this.page.locator('[role="status"]', {
      hasText: "Connection verified successfully.",
    });

    await statusMessage.waitFor({ state: "visible", timeout: 30000 });

    console.log("✓ Connection verified successfully");
  }

  async closeConnectionModal() {
    console.log("Closing connection modal (X button)...");

    const closeButton = this.page.locator('[data-slot="dialog-close"]');

    await closeButton.waitFor({
      state: "visible",
      timeout: 30000,
    });

    await closeButton.click();

    console.log("✓ Modal closed");
  }

  /**
   * Best-effort close of the connection modal. Unlike closeConnectionModal(),
   * this does NOT throw when no modal is present — useful after
   * checkConnectionActive(), where a modal may or may not be open depending
   * on the outcome.
   */
  async closeConnectionModalIfPresent() {
    const closeButton = this.page.locator('[data-slot="dialog-close"]');

    try {
      await closeButton.waitFor({ state: "visible", timeout: 5000 });
      await closeButton.click();
      console.log("✓ Connection modal closed");
    } catch (e) {
      // No modal open — nothing to close.
    }
  }

  /**
   * Clicks Test Connection and reports whether the connection is already
   * active (verified). NON-FATAL: returns true if the "Connection verified
   * successfully." status appears within the timeout, false otherwise. The
   * result modal (if any) is closed before returning, so the page is left
   * clean for the caller regardless of outcome.
   *
   * Used to check the site is connected before a run relies on it.
   */
  async checkConnectionActive() {
    console.log("Checking connection status via Test Connection...");

    const testConnectionBtn = this.page.locator(
      '[data-testid="test-connection-btn"]',
    );

    await testConnectionBtn.waitFor({ state: "visible", timeout: 30000 });
    await testConnectionBtn.scrollIntoViewIfNeeded();
    await testConnectionBtn.click();

    console.log("✓ Test Connection clicked — waiting for status...");

    const successStatus = this.page.locator('[role="status"]', {
      hasText: "Connection verified successfully.",
    });

    let active = false;

    try {
      await successStatus.waitFor({ state: "visible", timeout: 15000 });
      active = true;
      console.log("✓ Connection is already active");
    } catch (e) {
      console.log(
        "Connection is not active yet — credentials still need to be set in WordPress",
      );
    }

    await this.closeConnectionModalIfPresent();

    return active;
  }

  async verifyWebsiteActive() {
    console.log("Verifying website status is Active...");

    const activeBadge = this.page
      .locator('[data-slot="badge"]')
      .filter({ hasText: "Active" })
      .first();

    await activeBadge.waitFor({
      state: "visible",
      timeout: 30000,
    });

    await expect(activeBadge).toBeVisible();

    console.log("✓ Website status confirmed Active");
  }

  /**
   * Reads the current website status badge text (e.g. "Active" or "Disconnected").
   * Does NOT assert anything itself — the caller decides how to handle the result
   * (e.g. soft assertion), since this method is also useful for plain logging.
   */
  async getWebsiteStatusText() {
    const badge = this.page.locator('[data-slot="badge"]').first();

    await badge.waitFor({
      state: "visible",
      timeout: 30000,
    });

    const text = (await badge.textContent()).trim();

    console.log(`Website status badge reads: "${text}"`);

    return text;
  }

  /**
   * Opens Orders from the sidebar. Assumes we're already on an
   * authenticated Paylexer page (this.page) — no login/navigation by URL
   * needed since the session carries over from earlier in the test.
   */
  async goToOrders() {
    console.log("Opening Orders from sidebar...");

    const ordersLink = this.page.locator(
      'li[data-slot="sidebar-menu-item"] a[href="/orders"]',
    );

    await ordersLink.waitFor({
      state: "visible",
      timeout: 30000,
    });

    await Promise.all([
      this.page.waitForLoadState("networkidle"),
      ordersLink.click(),
    ]);

    console.log("✓ Orders page opened");

    // Hard reload to make sure we're reading fresh order data, not a
    // stale/cached list from before the order was placed.
    console.log("Hard reloading Orders page...");

    await this.page.reload({ waitUntil: "networkidle" });

    console.log("✓ Orders page reloaded");
  }

  /**
   * Verifies the status badge for an order on the Orders page.
   *
   * @param {string} expectedStatus - e.g. "Completed"
   * @param {string} [orderIdentifier] - text unique to the order's row
   *   (e.g. order number or trip name), so the correct row's badge is
   *   checked instead of just the first one in the list. If omitted,
   *   falls back to the first row (assumed most recent order).
   */
  async verifyOrderStatus(expectedStatus, orderIdentifier) {
    console.log(
      `Verifying order status is "${expectedStatus}"${orderIdentifier ? ` for order matching "${orderIdentifier}"` : ""}...`,
    );

    // Status badges (e.g. "Completed") contain a small colored dot
    // (div.rounded-full) — the sidebar's notification-count badge (e.g.
    // "49") uses the same span[data-slot="badge"] wrapper but has no dot,
    // so filtering on the dot disambiguates the two.
    const allStatusBadges = this.page
      .locator('span[data-slot="badge"]')
      .filter({ has: this.page.locator("div.rounded-full") });

    let statusBadge;

    if (orderIdentifier) {
      const orderRow = this.page
        .locator("tr, [data-slot='table-row']")
        .filter({ hasText: orderIdentifier });

      statusBadge = orderRow
        .locator('span[data-slot="badge"]')
        .filter({ has: this.page.locator("div.rounded-full") });
    } else {
      statusBadge = allStatusBadges.first();
    }

    await statusBadge.waitFor({
      state: "visible",
      timeout: 30000,
    });

    await expect(statusBadge).toContainText(expectedStatus);

    console.log(`✓ Order status confirmed as "${expectedStatus}"`);
  }
}

module.exports = DashboardPage;
