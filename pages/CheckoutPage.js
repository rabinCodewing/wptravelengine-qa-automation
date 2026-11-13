const { expect } = require("@playwright/test");

// Code (gatewayPaymentForms.js) or a recipe (data/gateways.json) — see config/paymentForms.js.
const { paymentFormFor } = require("../config/paymentForms");

/**
 * Escapes regex metacharacters so a gateway name is matched literally.
 *
 * Not optional: gatewayConfigs.js carries display names that are themselves
 * regex syntax. "Cost+" interpolated raw becomes /^Cost+$/i — "Cos" followed by
 * one or more "t" — which matches "Cost" and never matches "Cost+", so the
 * label was never found and the whole booking stalled at gateway selection.
 * "Pay.jp", "Checkout.com" and "Authorize.Net" happen to still match because
 * "." matches the literal dot, but they were matching by luck, not by rule.
 */
function escapeForRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Brings a field to the middle of the viewport before it's filled, so a
 * headed run shows each value going in. fill() itself never scrolls, and
 * scrollIntoViewIfNeeded() would leave it under the sticky header.
 */
async function scrollToCentre(locator) {
  await locator
    .evaluate((el) => el.scrollIntoView({ block: "center", inline: "nearest" }))
    .catch(() => {});
}

class CheckoutPage {
  constructor(page) {
    this.page = page;

    // WPTE's checkout re-renders the payment list from each update_cart
    // response, and fires one for every billing change and payment pick. A
    // slow one answering AFTER a newer pick puts the older method back: the
    // billing country's refresh (still carrying "paylexer-fatora") landed
    // ~3s later, after the gateway click, so Transbank, PayTabs and PhaJay
    // runs (2026-10-27) submitted Fatora. So the in-flight ones are counted,
    // and selecting waits for them (settleCart).
    this.cartRequests = new Set();
    const isCartRefresh = (request) => request.method() === "POST" && /_action=update_cart/.test(request.url());
    page.on("request", (request) => {
      if (isCartRefresh(request)) this.cartRequests.add(request);
    });
    const done = (request) => this.cartRequests.delete(request);
    page.on("requestfinished", done);
    page.on("requestfailed", done);
  }

  /**
   * Waits until no WPTE cart refresh is in flight and none has started for
   * `quietMs` — so the payment list on screen is the final one, not one a
   * late response is about to replace. Gives up quietly after `timeout`.
   */
  async settleCart({ quietMs = 700, timeout = 20000 } = {}) {
    const deadline = Date.now() + timeout;
    let quietSince = this.cartRequests.size ? null : Date.now();
    while (Date.now() < deadline) {
      if (this.cartRequests.size) quietSince = null;
      else if (quietSince === null) quietSince = Date.now();
      else if (Date.now() - quietSince >= quietMs) return;
      await this.page.waitForTimeout(100);
    }
    console.log(`⚠ Checkout cart was still refreshing after ${timeout / 1000}s — carrying on`);
  }

  /**
   * Clicks "Check Availability" on the trip page to start booking —
   * this opens the calendar/date-selection step.
   */
  async bookTrip() {
    console.log("Clicking Check Availability to start booking...");

    const bookButton = this.page.locator("button.wte-book-now", {
      hasText: "Check Availability",
    });

    await bookButton.waitFor({
      state: "visible",
      timeout: 30000,
    });

    await bookButton.click();

    console.log("✓ Check Availability clicked — calendar should appear");
  }

  /**
   * Clicks "Continue" after a date is selected on the calendar step.
   */
  async clickContinueOnCalendar() {
    console.log("Clicking Continue after calendar date selection...");

    const continueButton = this.page
      .getByRole("button", { name: "Continue", exact: true })
      .first();

    await continueButton.waitFor({
      state: "visible",
      timeout: 30000,
    });

    await continueButton.click();

    console.log("✓ Continue clicked");
  }

  /**
   * Clicks the traveler count "+" (increment) icon a given number of times.
   *
   * NOTE: this exact "+" icon/button markup is reused across multiple
   * counters on the page (e.g. Adults, Children), all sharing the same
   * class="next wte-up" and SVG line transform. Using .first() defaults to
   * the first counter (typically "Adults") — if you need a different
   * counter, send me the HTML for its specific wrapping container so I can
   * scope this to that one instead of just taking the first match.
   *
   * @param {number} times - how many times to click (default 3)
   */
  async incrementTravelerCount(times = 3) {
    console.log(`Clicking traveler "+" button ${times} time(s)...`);

    const incrementButton = this.page.locator("button.next.wte-up").first();

    await incrementButton.waitFor({
      state: "visible",
      timeout: 30000,
    });

    for (let i = 1; i <= times; i++) {
      console.log(`Clicking "+" (${i}/${times})...`);
      await incrementButton.click();
      console.log(`✓ "+" click ${i}/${times} done`);
    }

    console.log(`✓ Traveler count incremented ${times} time(s)`);
  }

  /**
   * Fills in traveler details on the booking form.
   *
   * TODO: replace with real field locators — this is a placeholder shape,
   * update the field list to match the real form once confirmed.
   */
  async fillTravelerDetails(details = {}) {
    console.log("Filling traveler details...");

    // TODO: confirm real locators for these fields.
    const fields = {
      firstName: '[name="first_name"]',
      lastName: '[name="last_name"]',
      email: '[name="email"]',
      phone: '[name="phone"]',
    };

    for (const [key, locatorStr] of Object.entries(fields)) {
      const value = details[key];
      if (!value) continue;

      const input = this.page.locator(locatorStr);
      await input.waitFor({ state: "visible", timeout: 30000 });
      await scrollToCentre(input);
      await input.fill(value);

      console.log(`✓ ${key} filled`);
    }
  }

  /**
   * Clicks "Proceed To Checkout" after traveler count/details are set.
   */
  async proceedToCheckout() {
    console.log("Clicking Proceed To Checkout...");

    const proceedButton = this.page.getByRole("button", {
      name: "Proceed To Checkout",
      exact: true,
    });

    await proceedButton.waitFor({
      state: "visible",
      timeout: 30000,
    });

    await proceedButton.click();

    console.log("✓ Proceeded to checkout");
  }

  /**
   * Trip page → filled-out checkout form, in one call.
   *
   * Exists so tests/wpGatewayCheckout.spec.js can drive either platform
   * through the same interface: WooCheckoutPage.prepareOrder() adds to cart
   * and opens /checkout, this one books a trip. Everything the spec does after
   * this — billing, gateway, terms, submit — is identical for both.
   */
  async prepareOrder() {
    console.log("Booking trip (clicking Check Availability)...");
    await this.bookTrip();
    console.log("✓ Check Availability clicked");

    console.log("Waiting for calendar and clicking Continue...");
    await this.clickContinueOnCalendar();
    console.log("✓ Continue clicked on calendar step");

    console.log("Incrementing traveler count (3 times)...");
    await this.incrementTravelerCount(3);
    console.log("✓ Traveler count incremented 3 times");

    console.log("Proceeding to checkout...");
    await this.proceedToCheckout();
    console.log("✓ Proceeded to checkout");
  }

  /**
   * Fills the billing details form on the checkout page. First name and
   * email are randomized per run (to avoid collisions on repeated test
   * runs); address and city use fixed, realistic values; country defaults
   * to Australia (AU) since Westpac PayWay only supports AUD — adjust the
   * `country` value below if a different gateway/currency needs a
   * different country selected.
   */
  async fillBillingDetails() {
    console.log("Filling billing details...");

    const randomId = Date.now();
    const firstName = `Traveler${randomId}`;
    const lastName = `Test${randomId}`;
    const email = `traveler${randomId}@example.com`;
    const address = "123 Test Street";
    const city = "Sydney";
    const country = "AU"; // Australia — matches AUD/Westpac PayWay; change if needed

    const fnameInput = this.page.locator("#billing_fname");
    await fnameInput.waitFor({ state: "visible", timeout: 30000 });
    await scrollToCentre(fnameInput);
    await fnameInput.fill(firstName);
    console.log(`✓ First name filled: ${firstName}`);

    // Assuming standard billing_lname id, matching the billing_fname pattern.
    // If this field doesn't exist or uses a different id, send me its HTML
    // and I'll fix the selector.
    const lnameInput = this.page.locator("#billing_lname");
    await lnameInput.waitFor({ state: "visible", timeout: 30000 });
    await scrollToCentre(lnameInput);
    await lnameInput.fill(lastName);
    console.log(`✓ Last name filled: ${lastName}`);

    const emailInput = this.page.locator("#billing_email");
    await emailInput.waitFor({ state: "visible", timeout: 30000 });
    await scrollToCentre(emailInput);
    await emailInput.fill(email);
    console.log(`✓ Email filled: ${email}`);

    const addressInput = this.page.locator("#billing_address");
    await addressInput.waitFor({ state: "visible", timeout: 30000 });
    await scrollToCentre(addressInput);
    await addressInput.fill(address);
    console.log(`✓ Address filled: ${address}`);

    const cityInput = this.page.locator("#billing_city");
    await cityInput.waitFor({ state: "visible", timeout: 30000 });
    await scrollToCentre(cityInput);
    await cityInput.fill(city);
    console.log(`✓ City filled: ${city}`);

    const countrySelect = this.page.locator("#billing_country");
    await countrySelect.waitFor({ state: "visible", timeout: 30000 });
    await scrollToCentre(countrySelect);
    await countrySelect.selectOption(country);
    console.log(`✓ Country selected: ${country}`);

    console.log("✓ Billing details filled");
  }

  /**
   * Selects a payment gateway on the checkout page by its display name.
   * Real markup: <input type="radio" id="paylexer-{slug}"><label for="paylexer-{slug}">{displayName}</label>
   * Matches the label by visible text, then uses its `for` attribute to
   * find the actual radio input — works without needing to know the
   * gateway's slug in advance.
   *
   * @param {string} gatewayIdentifier - displayName of the gateway (e.g. "Westpac PayWay")
   */
  async selectPaymentGateway(gatewayIdentifier) {
    console.log(`Selecting payment gateway "${gatewayIdentifier}"...`);

    const gatewayLabel = this.page
      .locator("label")
      .filter({
        hasText: new RegExp(`^${escapeForRegExp(gatewayIdentifier)}$`, "i"),
      })
      .first();

    const found = await gatewayLabel
      .waitFor({ state: "visible", timeout: 30000 })
      .then(() => true)
      .catch(() => false);

    if (!found) {
      // List what IS on the checkout. A bare timeout here says nothing about
      // whether the gateway is absent or just labelled differently, and this
      // step failing means the terms checkbox and Confirm Booking below are
      // never reached at all.
      const offered = await this.page
        .locator('input[type="radio"][id^="paylexer-"]')
        .evaluateAll((inputs) =>
          inputs.map((input) => {
            const id = input.getAttribute("id");
            const label = id
              ? document.querySelector(`label[for="${id}"]`)
              : null;

            return {
              id,
              label: (label?.textContent || "").trim().replace(/\s+/g, " "),
            };
          }),
        )
        .catch(() => []);

      throw new Error(
        `"${gatewayIdentifier}" is not offered on the WP Travel Engine checkout. ` +
          `Payment methods listed: ${
            offered.length ? JSON.stringify(offered) : "(none found)"
          }. Either it isn't ticked under Payments > General, or its displayName ` +
          `in config/gatewayConfigs.js doesn't match the label on the checkout.`,
      );
    }

    const forAttr = await gatewayLabel.getAttribute("for");

    const gatewayRadio = forAttr
      ? this.page.locator(`#${forAttr}`)
      : gatewayLabel.locator('input[type="radio"]');

    await gatewayRadio.waitFor({
      state: "visible",
      timeout: 30000,
    });

    // What the form will submit for this gateway (e.g. "paylexer-transbank"),
    // kept for submitPayment() to check against right before Confirm Booking.
    this.selectedGateway = {
      name: gatewayIdentifier,
      label: gatewayLabel,
      radio: gatewayRadio,
      value: (await gatewayRadio.getAttribute("value").catch(() => null)) || forAttr,
    };

    // Let the billing details' cart refresh land first: picking while it is
    // in flight is exactly how its stale answer overwrote the pick.
    await this.settleCart();

    if (await gatewayRadio.isChecked().catch(() => false)) {
      console.log(`✓ "${gatewayIdentifier}" already selected as payment method`);
    } else {
      await scrollToCentre(gatewayLabel);
      await gatewayLabel.click();
      // The pick's own refresh carries it to the server; wait for its answer.
      await this.settleCart();
    }

    await this.ensureGatewaySelected();
    console.log(`✓ "${gatewayIdentifier}" selected as payment method (${this.selectedGateway.value})`);
  }

  /**
   * Makes sure the payment method chosen in selectPaymentGateway() is the one
   * the checkout form will submit, re-selecting it if something reset it.
   * Throws when it won't stay selected, rather than paying with another gateway.
   */
  async ensureGatewaySelected() {
    const chosen = this.selectedGateway;
    if (!chosen) return;

    const submitted = () =>
      this.page
        .locator('input[name="wpte_checkout_paymnet_method"]:checked, input[type="radio"][id^="paylexer-"]:checked')
        .first()
        .getAttribute("value")
        .catch(() => null);

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await this.settleCart();
      if (await chosen.radio.isChecked().catch(() => false)) return;

      // Gone from the checkout altogether (WPTE sends an empty or broken
      // cart to the home page): re-selecting can't help.
      if (!(await this.page.locator('input[name="wpte_checkout_paymnet_method"]').count().catch(() => 0))) {
        throw new Error(
          `The WP Travel Engine checkout is gone (now on ${this.page.url()}) while selecting "${chosen.name}" — ` +
            `the booking's cart was lost, so there is no payment method left to pick.`,
        );
      }

      console.log(
        `⚠ "${chosen.name}" is not the selected payment method (form has "${await submitted()}") — selecting it again (attempt ${attempt})...`,
      );
      // A click like a shopper's, so WPTE records the pick and its next
      // refresh keeps it. A forced check changes only the DOM, and the next
      // refresh re-renders whatever WPTE still has.
      await scrollToCentre(chosen.label);
      await chosen.label.click({ timeout: 10000 }).catch(() => chosen.radio.check({ force: true, timeout: 10000 }).catch(() => {}));
    }

    await this.settleCart();

    if (!(await chosen.radio.isChecked().catch(() => false))) {
      throw new Error(
        `Could not keep "${chosen.name}" (${chosen.value}) selected on the WP Travel Engine checkout — ` +
          `the form would submit "${await submitted()}" instead. Something on the page keeps resetting the payment method.`,
      );
    }
  }

  /**
   * Clicks "Confirm Booking" and returns the page to use for card entry.
   * Confirmed this gateway's card details form is always a same-page
   * popup/modal (never a new browser tab), so this no longer waits on a
   * "page" event that would never fire — it just clicks, waits briefly for
   * the popup to render, and returns this.page.
   */
  async submitPayment() {
    console.log("Clicking Confirm Booking...");

    const confirmButton = this.page.locator(
      "button.wpte-checkout__form-submit-button",
      { hasText: "Confirm Booking" },
    );

    await confirmButton.waitFor({
      state: "visible",
      timeout: 30000,
    });

    // The terms tick and anything else since selection can redraw the payment
    // list too: last check that the form pays with the gateway under test.
    await this.ensureGatewaySelected();

    await confirmButton.click();

    console.log("Waiting for card details popup to appear...");
    await this.page.waitForTimeout(6000);

    // When PayLexer can't open the payment, WPTE shows a "Session Error" popup
    // with the gateway's refusal (PayTabs: "Payment connector error: Not found
    // merchant") and the page goes nowhere. Fail with that message now rather
    // than after the card-form search times out without saying why.
    // Read in the page, from the VISIBLE popup: the theme keeps more than one
    // "Session Error" element around, and a locator on the text alone matched
    // a hidden one and came back without the message.
    const reason = await this.page
      .evaluate(() => {
        const visible = (el) => {
          const box = el.getBoundingClientRect();
          return box.width > 0 && box.height > 0 && getComputedStyle(el).visibility !== "hidden";
        };
        const heading = [...document.querySelectorAll("h1, h2, h3, h4, strong, div, span")].find(
          (el) => el.childElementCount === 0 && el.textContent.trim() === "Session Error" && visible(el),
        );
        if (!heading) return null;
        const text = (heading.parentElement?.innerText || "").replace(/\s+/g, " ").trim();
        return text.replace(/^Session Error\s*/, "").trim() || "(no message)";
      })
      .catch(() => null);
    if (reason !== null) {
      throw new Error(
        `The checkout could not start the payment — WPTE showed "Session Error": ${reason || "(no message)"} ` +
          `(payment method submitted: ${this.selectedGateway?.value || "unknown"}). ` +
          `This is PayLexer/the gateway refusing the payment session (account, profile or currency), not the card form.`,
      );
    }

    console.log("✓ Confirm Booking clicked — card details popup should appear");

    return this.page;
  }

  /**
   * Whether this gateway asks for card details after Confirm Booking.
   *
   * config/gatewayPaymentForms.js is the source of truth: a gateway with an
   * entry there presents a card form, and that entry already knows how to
   * fill and submit it. Today only "Westpac" has one. Every other gateway is
   * treated as having no card-details step, so the flow passes after Confirm
   * Booking instead of failing on a form that was never going to appear.
   *
   * Adding an entry to gatewayPaymentForms.js automatically moves that
   * gateway onto the card-entry path — nothing to change here.
   *
   * @param {string} gatewayKey - the gatewayConfigs.js key (e.g. "Westpac")
   * @returns {boolean}
   */
  hasCardDetailsForm(gatewayKey) {
    return Boolean(paymentFormFor(gatewayKey));
  }

  /**
   * Fills in the gateway's own card details, dispatching to that gateway's
   * entry in config/gatewayPaymentForms.js. Different gateways have
   * completely different card forms (popup vs iframe vs redirect), so the
   * actual field-filling logic lives per-gateway there, not here.
   *
   * @param {import('@playwright/test').Page} cardPage - the page returned by submitPayment()
   * @param {string} gatewayKey - the gatewayConfigs.js key (e.g. "Westpac")
   */
  async fillPaymentDetails(cardPage, gatewayKey) {
    console.log(`Filling card details for "${gatewayKey}"...`);

    const gatewayForm = paymentFormFor(gatewayKey);

    if (!gatewayForm) {
      console.log(
        `⚠ No entry for "${gatewayKey}" in config/gatewayPaymentForms.js yet — skipping card fill. Add an entry there once you have the real card form HTML.`,
      );
      return;
    }

    await gatewayForm.fillCardDetails(cardPage);
  }

  /**
   * Submits the card payment, dispatching to that gateway's entry in
   * config/gatewayPaymentForms.js.
   *
   * @param {import('@playwright/test').Page} cardPage - the page returned by submitPayment()
   * @param {string} gatewayKey - the gatewayConfigs.js key (e.g. "Westpac")
   */
  async submitCardPayment(cardPage, gatewayKey) {
    console.log(`Submitting card payment for "${gatewayKey}"...`);

    const gatewayForm = paymentFormFor(gatewayKey);

    if (!gatewayForm) {
      console.log(
        `⚠ No entry for "${gatewayKey}" in config/gatewayPaymentForms.js yet — skipping submit.`,
      );
      return;
    }

    await gatewayForm.submitCardPayment(cardPage);
  }

  async checkTermsAndConditions() {
    console.log("Checking Terms & Conditions checkbox...");

    const termsCheckbox = this.page.locator(
      'input[name="wp_travel_engine_booking_setting[terms_conditions][]"]',
    );

    await termsCheckbox.waitFor({ state: "visible", timeout: 30000 });

    if (await termsCheckbox.isChecked()) {
      console.log("✓ Terms & Conditions already checked");
      return;
    }

    // Centre it in the viewport first — scrollIntoViewIfNeeded() alone leaves
    // it under the sticky header, which is what the "custom-logo intercepts
    // pointer events" retries in the failure log were hitting.
    await termsCheckbox.evaluate((el) =>
      el.scrollIntoView({ block: "center", inline: "nearest" }),
    );

    const checkboxId = await termsCheckbox.getAttribute("id");

    const attempts = [
      {
        label: 'label[for="..."]',
        run: async () => {
          if (!checkboxId) return false;
          const label = this.page.locator(`label[for="${checkboxId}"]`);
          if (!(await label.count())) return false;
          await label.first().click({ force: true });
          return true;
        },
      },
      {
        label: ".wpte-bf-checkbox-wrap wrapper",
        run: async () => {
          const wrap = termsCheckbox.locator(
            "xpath=ancestor::*[contains(@class,'wpte-bf-checkbox-wrap') or contains(@class,'wpte-checkbox-wrap')][1]",
          );
          if (!(await wrap.count())) return false;
          await wrap.first().click({ force: true });
          return true;
        },
      },
      {
        label: "check({ force: true })",
        run: async () => {
          await termsCheckbox.check({ force: true });
          return true;
        },
      },
      {
        label: "direct .checked + input/change events",
        run: async () => {
          await termsCheckbox.evaluate((el) => {
            el.checked = true;
            el.dispatchEvent(new Event("input", { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
          });
          return true;
        },
      },
    ];

    for (const attempt of attempts) {
      let ran = false;

      try {
        ran = await attempt.run();
      } catch (e) {
        console.log(`  ✗ ${attempt.label} threw: ${e.message.split("\n")[0]}`);
        continue;
      }

      if (!ran) {
        console.log(`  – ${attempt.label} not present — skipping`);
        continue;
      }

      await this.page.waitForTimeout(300);

      if (await termsCheckbox.isChecked()) {
        console.log(`✓ Terms & Conditions checked (via ${attempt.label})`);
        return;
      }

      console.log(`  ✗ ${attempt.label} did not change the state — escalating`);
    }

    throw new Error(
      "Could not check the Terms & Conditions checkbox — tried the label, the .wpte-bf-checkbox-wrap wrapper, a forced check(), and setting .checked directly. All left it unchecked.",
    );
  }

  /**
   * Waits for the booking to land on the Thank You page, confirms the page's
   * own Thank You heading is actually rendered, and returns the instant it is.
   * That heading is the end of the flow — nothing after it is asserted.
   *
   * Matches on the PATH only — the payment key and every other query
   * parameter the gateway appends is stripped before comparing, so all of
   * these count as the same landing:
   *   https://rabin.1wp.site/thank-you-2
   *   https://rabin.1wp.site/thank-you-2/
   *   https://rabin.1wp.site/thank-you-2/?payment_key=abc123
   *   https://rabin.1wp.site/thank-you-2/?payment_key=abc123&callback_type=success#x
   *
   * The redirect can land on the checkout page itself or on a popup/tab the
   * gateway opened, so every page in the context is polled.
   *
   * @param {number} [timeout=60000] - how long to wait for the redirect
   * @returns {Promise<import('@playwright/test').Page>} the page showing Thank You
   */
  async waitForThankYouPage(timeout = 60000) {
    console.log("Waiting for the Thank You page...");

    // The end-of-flow marker on that page is a heading reading "Thank You".
    // Matching the URL alone can succeed while the page is still rendering, so
    // the heading is what actually proves the Thank You page loaded.
    //
    // Matched by ROLE, not by tag or class: the live page renders it as an <h3>,
    // while the older markup this method was written against was
    //   <header class="entry-header"><h1 class="entry-title">Thank You</h1></header>
    // getByRole("heading") matches h1–h6 alike, so it covers the h3 and the h1
    // without this having to track which level the theme currently emits. The
    // original h1.entry-title selector is kept as an .or() fallback for the case
    // where the heading text is there but the accessible name isn't (e.g. the
    // theme wraps it in a way that changes the computed name).
    const thankYouHeading = (p) =>
      p
        .getByRole("heading", { name: /^\s*Thank You\s*$/i })
        .or(
          p
            .locator("header.entry-header h1.entry-title")
            .filter({ hasText: /^\s*Thank You\s*$/i }),
        )
        .first();

    // Take the pathname and drop ?payment_key=... / #fragment entirely, then
    // match "/thank-you" with an optional "-<number>" suffix. Nothing after
    // the slug is looked at, so a changing payment key can never affect this.
    const isThankYou = (url) => {
      let pathname;

      try {
        pathname = new URL(url).pathname;
      } catch (e) {
        return false; // e.g. "about:blank" before the redirect lands
      }

      return /^\/thank-you(-\d+)?\/?$/i.test(pathname);
    };

    /**
     * Reads WP Travel Engine's payment-failure modal, if it's up.
     *
     * A declined payment drops the booking back on /checkout-2/ and raises:
     *   <h2>Payment Failed</h2>
     *   <p>Payment processing failed. Please try again.</p>
     * The Thank You redirect is never coming in that case, so without this the
     * poll below just burns the whole timeout and then blames the URL — which
     * is what a failing Culqi run reported: "Never landed on the Thank You page
     * within 120000ms", with no mention of the payment having been declined.
     *
     * Matched by heading ROLE rather than tag, same reasoning as
     * thankYouHeading() above, and the detail line is looked up by its own text
     * rather than by walking the modal's DOM structure.
     *
     * @returns {Promise<string|null>} the failure text, or null if no modal
     */
    const readPaymentFailure = async (p) => {
      const heading = p
        .getByRole("heading", {
          name: /payment failed|payment error|transaction failed|payment unsuccessful/i,
        })
        .first();

      if (!(await heading.isVisible().catch(() => false))) return null;

      const title =
        (await heading.textContent().catch(() => ""))?.trim() ||
        "Payment failed";

      const detail = await p
        .getByText(/payment processing failed|please try again/i)
        .first()
        .textContent()
        .catch(() => null);

      return detail ? `${title} — ${detail.trim()}` : title;
    };

    const deadline = Date.now() + timeout;

    while (Date.now() < deadline) {
      for (const p of this.page.context().pages()) {
        if (p.isClosed()) continue;

        if (isThankYou(p.url())) {
          console.log(`✓ Thank You URL reached: ${p.url()}`);

          console.log('Waiting for the "Thank You" heading...');

          const heading = thankYouHeading(p);

          await heading.waitFor({
            state: "visible",
            timeout: Math.max(5000, deadline - Date.now()),
          });

          // The heading being visible IS the end of the flow, so return on the
          // spot. Nothing else touches the page after this: an expect()
          // re-check and a textContent() read were both dropped from here
          // because they're extra Playwright actions — each padded by the
          // slowMo in playwright.config.js — running after the last thing that
          // actually mattered had already passed.
          console.log("✓ Thank You heading seen — ending the test here");

          return p;
        }
      }

      // Only once no page is on Thank You: bail out early if the gateway
      // reported a failure instead. Checked in a SECOND pass, after every page
      // has been offered the Thank You test above, so that a success always
      // wins a race against a stale failure modal left up behind it.
      for (const p of this.page.context().pages()) {
        if (p.isClosed()) continue;

        const failure = await readPaymentFailure(p);

        if (failure) {
          throw new Error(
            `Payment failed — the booking never reached Thank You. The gateway reported: "${failure}". ` +
              `Page is back on "${p.url()}". This is a real payment failure, not a timing problem, ` +
              `so there was no point waiting out the remaining ${Math.max(0, deadline - Date.now())}ms.`,
          );
        }
      }

      // Short poll — the point is to exit the moment the redirect lands,
      // not to sit on a fixed wait after it has already happened.
      await this.page.waitForTimeout(250);
    }

    throw new Error(
      `Never landed on the Thank You page within ${timeout}ms. Last URLs seen: ${this.page
        .context()
        .pages()
        .filter((p) => !p.isClosed())
        .map((p) => p.url())
        .join(", ")}`,
    );
  }

  /**
   * Verifies the booking/payment succeeded. Confirmed real signal: the page
   * auto-redirects to a URL containing "callback_type=success" (e.g.
   * ".../thank-you-2/?payment_key=...&callback_type=success&...").
   * Also checks for visible confirmation text as a secondary signal.
   */
  async verifyPaymentSuccess(cardPage = this.page) {
    console.log("Verifying payment success...");

    // Primary check: the URL itself confirms success — PayWay redirects
    // here automatically once the payment is actually processed.
    if (cardPage.url().includes("callback_type=success")) {
      console.log(`✓ Payment success confirmed via URL: ${cardPage.url()}`);
      return;
    }

    // Fallback: wait briefly for the redirect to happen, in case this is
    // called right as the navigation is still in flight.
    await cardPage
      .waitForURL(/callback_type=success/, { timeout: 15000 })
      .catch(() => {});

    if (cardPage.url().includes("callback_type=success")) {
      console.log(`✓ Payment success confirmed via URL: ${cardPage.url()}`);
      return;
    }

    // Last resort: look for generic confirmation text on whatever page we're on.
    const successMessage = cardPage.getByText(
      /Thank you|Booking Confirmed|Payment Successful/i,
    );

    await successMessage.waitFor({
      state: "visible",
      timeout: 15000,
    });

    await expect(successMessage).toBeVisible();

    console.log("✓ Payment success confirmed via page text");
  }
}

module.exports = CheckoutPage;
