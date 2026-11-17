// pages/WpteStripeCheckoutPage.js
//
// WP Travel Engine checkout paid through WPTE's own Stripe add-on
// (wp-travel-engine-stripe-payment-gateway), not through PayLexer.
//
// Markup:
//   #billing_fname … #billing_country           billing details
//   #stripe_payment                             gateway radio
//   Stripe Payment Element                      iframes on js.stripe.com; the
//                                               card inputs are name=number /
//                                               expiry / cvc (/ postalCode)
//   #wte-stripe-payment-button                  "Pay & Confirm Booking"
// Thank You page: "Booking ID: <n>".

const { expect } = require("@playwright/test");

class WpteStripeCheckoutPage {
  constructor(page) {
    this.page = page;
    this.payButton = page.locator("#wte-stripe-payment-button");
  }

  /** Ticks WP Travel Engine's Terms & Conditions checkbox (several fallbacks). */
  async checkTermsAndConditions() {
    const termsCheckbox = this.page.locator('input[name="wp_travel_engine_booking_setting[terms_conditions][]"]');
    await termsCheckbox.waitFor({ state: "visible", timeout: 30000 });
    if (await termsCheckbox.isChecked()) return;
    await termsCheckbox.evaluate((el) => el.scrollIntoView({ block: "center", inline: "nearest" }));
    const checkboxId = await termsCheckbox.getAttribute("id");
    const attempts = [
      async () => {
        if (!checkboxId) return false;
        const label = this.page.locator(`label[for="${checkboxId}"]`);
        if (!(await label.count())) return false;
        await label.first().click({ force: true });
        return true;
      },
      async () => {
        const wrap = termsCheckbox.locator("xpath=ancestor::*[contains(@class,'wpte-bf-checkbox-wrap') or contains(@class,'wpte-checkbox-wrap')][1]");
        if (!(await wrap.count())) return false;
        await wrap.first().click({ force: true });
        return true;
      },
      async () => {
        await termsCheckbox.check({ force: true });
        return true;
      },
      async () => {
        await termsCheckbox.evaluate((el) => {
          el.checked = true;
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
        });
        return true;
      },
    ];
    for (const run of attempts) {
      let ran = false;
      try {
        ran = await run();
      } catch {
        continue;
      }
      if (!ran) continue;
      await this.page.waitForTimeout(300);
      if (await termsCheckbox.isChecked()) return;
    }
    throw new Error("Could not check the Terms & Conditions checkbox — tried the label, the wrapper, a forced check(), and setting .checked directly.");
  }

  async fillBilling() {
    const stamp = Date.now();
    const values = {
      "#billing_fname": "QA",
      "#billing_lname": `Accommodation ${stamp}`,
      "#billing_email": `qa.accommodation+${stamp}@example.com`,
      "#billing_address": "1 Test Street",
      "#billing_city": "Kathmandu",
    };
    for (const [selector, value] of Object.entries(values)) {
      const field = this.page.locator(selector);
      await field.waitFor({ state: "visible", timeout: 30000 });
      await field.fill(value);
    }
    await this.page.locator("#billing_country").selectOption("NP");
    return { email: values["#billing_email"] };
  }

  async selectStripe() {
    const radio = this.page.locator("#stripe_payment");
    await radio.waitFor({ state: "attached", timeout: 30000 });
    if (!(await radio.isChecked())) await radio.check({ force: true });
  }

  /** The js.stripe.com frame that holds the card number input. */
  async cardFrame(timeout = 60000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      for (const frame of this.page.frames()) {
        if (!frame.url().includes("js.stripe.com")) continue;
        if (await frame.locator('input[name="number"]').count().catch(() => 0)) return frame;
      }
      await this.page.waitForTimeout(500);
    }
    throw new Error("Stripe card form never loaded (no js.stripe.com frame with a card number input). Are the Stripe keys valid?");
  }

  async fillCard(card) {
    const frame = await this.cardFrame();
    await frame.locator('input[name="number"]').fill(card.number);
    await frame.locator('input[name="expiry"]').fill(card.expiry);
    await frame.locator('input[name="cvc"]').fill(card.cvc);
    const postal = frame.locator('input[name="postalCode"]');
    if (await postal.count()) await postal.fill(card.postalCode);
  }

  /**
   * Billing → Stripe card → terms → Pay. Returns the Booking ID read from the
   * Thank You page, plus the page's text for further checks.
   */
  async pay(card) {
    const billing = await this.fillBilling();
    await this.selectStripe();
    await this.fillCard(card);
    await this.checkTermsAndConditions();
    await this.payButton.evaluate((el) => el.scrollIntoView({ block: "center" }));
    await this.payButton.click();

    // Older Thank You template: "Booking ID: 123"; newer: "BOOKING REFERENCE #123".
    const bookingIdLine = this.page.getByText(/Booking ID:|Booking Reference/i).first();
    try {
      await bookingIdLine.waitFor({ state: "visible", timeout: 120000 });
    } catch (error) {
      const shown = await this.page
        .locator(".wpte-error, .error, [role=alert]")
        .allInnerTexts()
        .catch(() => []);
      throw new Error(`No Thank You page after paying (still on ${this.page.url()}). ${shown.filter(Boolean).join(" | ")}`, { cause: error });
    }
    const thankYouText = await this.page.locator("body").innerText();
    const bookingId = Number((thankYouText.match(/Booking ID:\s*(\d+)/) || thankYouText.match(/Booking Reference\s*#?\s*(\d+)/i) || [])[1]);
    expect(bookingId, "Booking ID on the Thank You page").toBeGreaterThan(0);
    return { bookingId, thankYouText, billing };
  }
}

module.exports = { WpteStripeCheckoutPage };
