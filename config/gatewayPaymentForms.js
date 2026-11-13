// config/gatewayPaymentForms.js

async function waitForFrameByUrl(page, urlSubstring, timeoutMs = 45000) {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const frame = page.frames().find((f) => f.url().includes(urlSubstring));
    if (frame) return frame;
    await page.waitForTimeout(500);
  }

  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for a frame with URL containing "${urlSubstring}"`,
  );
}

/**
 * Finds the frame that actually contains `selector`, whatever its URL.
 *
 * Same flat-frames scan as waitForFrameByUrl(), but keyed on content instead
 * of host — for frames whose URL there's no stable substring to match. Dodo
 * iframes its card fields from a per-session src, so the field itself is the
 * only reliable thing to look for.
 */
async function waitForFrameWithSelector(page, selector, timeoutMs = 45000) {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    for (const frame of page.frames()) {
      const visible = await frame
        .locator(selector)
        .first()
        .isVisible()
        .catch(() => false);

      if (visible) return frame;
    }

    await page.waitForTimeout(500);
  }

  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for any frame containing a visible "${selector}". ` +
      `Frames present:\n${page
        .frames()
        .map((f) => `  - ${f.url()}`)
        .join("\n")}`,
  );
}

/**
 * Finds a single field wherever it lives across the page's frames, and returns
 * a Locator already scoped to the frame that owns it.
 *
 * For hosted-field checkouts that put EVERY input in its own iframe — SumUp
 * gives cardholder name, number, expiry, CVV and zip a frame each — so there's
 * no one "card frame" to resolve once and reuse the way Dodo and Conekta allow.
 * Each of those frames also loads the same bundle, carrying hidden copies of
 * the OTHER fields, so the locator has to identify the field by something the
 * decoys don't share (its accessible name), not by id or position.
 *
 * @param {(frame: import('@playwright/test').Frame) => import('@playwright/test').Locator} buildLocator
 *   Called per frame to build the candidate locator, e.g.
 *   `(frame) => frame.getByRole("textbox", { name: "CVV" })`.
 * @param {string} fieldName - for logging and the timeout message
 */
async function waitForFieldInAnyFrame(
  page,
  buildLocator,
  fieldName,
  timeoutMs = 45000,
) {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    for (const frame of page.frames()) {
      const locator = buildLocator(frame).first();

      const visible = await locator.isVisible().catch(() => false);

      if (visible) {
        console.log(`✓ Found "${fieldName}" in frame: ${frame.url()}`);
        return locator;
      }
    }

    await page.waitForTimeout(500);
  }

  throw new Error(
    `Timed out after ${timeoutMs}ms looking for "${fieldName}" in any frame. ` +
      `Frames present:\n${page
        .frames()
        .map((f) => `  - ${f.url()}`)
        .join("\n")}`,
  );
}

const PAY_NOW_XPATHS = [
  '//button[@id="payway-submit-button"][normalize-space()="Pay Now"]',
  '//button[normalize-space()="Pay Now"]',
];

/**
 * The submit button on Checkout.com's hosted payment page — the one that
 * follows the CVV field:
 *   <button class="buttonsstyles__ButtonBase-sc-… buttonsstyles__PrimaryButton-sc-…">
 *     <span>Pay US$3,300.00</span>
 *   </button>
 *
 * NOT a bare :has-text("Pay"). That's a case-insensitive SUBSTRING match, and
 * the HPP also renders alternative payment-method buttons — Google Pay, PayPal,
 * "Pay by bank" — which contain "Pay" too. resolveField() hands back the FIRST
 * match in DOM order, and the APM buttons sit above the card form, so the loose
 * selector can submit the wrong thing.
 *
 * Keyed on "PrimaryButton" because that's the styled-components DISPLAY name,
 * derived from the component's own name. The `-sc-1qfkjn6-2` suffix and the
 * generated classes (`iIzGMO fvthgO gUNTra`) are build-specific hashes and do
 * change; the readable part doesn't unless the component is renamed. The
 * :has-text("Pay") is kept alongside it so a differently-styled primary button
 * elsewhere on the page still can't be mistaken for this one.
 *
 * Used by both fillCardDetails() (waits for it) and submitCardPayment() (clicks
 * it) — declared once here so the two can't drift apart.
 */
const CHECKOUT_PAY_BUTTON = 'button[class*="PrimaryButton"]:has-text("Pay")';

/**
 * Finds the "Pay Now" button in whichever frame actually owns it.
 *
 * CRITICAL: the card form is a modal whose contents are iframed in — the
 * PayLexer-hosted checkout frame, which itself nests PayWay's trusted frame
 * for the card fields. The button therefore is NOT in the top-level page's
 * DOM, so `page.locator()` can never see it however the selector is written
 * (this is why an on-screen, clearly-enabled "Pay Now" still timed out).
 *
 * `page.frames()` is a FLAT list including nested frames, so scanning it
 * covers the main frame and every nesting level uniformly — the same reason
 * waitForFrameByUrl() above works for the card fields.
 *
 * @returns {Promise<import('@playwright/test').Locator|null>}
 */
async function findPayNowButton(page) {
  for (const frame of page.frames()) {
    for (const xpath of PAY_NOW_XPATHS) {
      const button = frame.locator(`xpath=${xpath}`).first();

      const visible = await button.isVisible().catch(() => false);
      if (visible) return button;
    }
  }

  return null;
}

/**
 * Polls for a click having actually done something: either the payment reached
 * its success callback, or the page navigated away from the card form.
 *
 * @returns {Promise<boolean>} true if the submission took effect in time.
 */
async function waitForSubmissionToTakeEffect(page, urlBeforeClick, timeoutMs) {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    if (paymentAlreadyCompleted(page)) return true;
    if (page.url() !== urlBeforeClick) return true;

    await page.waitForTimeout(500);
  }

  return false;
}

async function describeSubmitButtons(page) {
  const rows = [];

  for (const frame of page.frames()) {
    const buttons = await frame
      .evaluate(() =>
        Array.from(document.querySelectorAll("button"))
          .filter((b) => b.id || /pay|complete|card/i.test(b.textContent || ""))
          .map((b) => ({
            id: b.id || null,
            text: (b.textContent || "").trim().slice(0, 60),
            disabled: b.disabled,
          })),
      )
      .catch((err) => `<unreadable: ${err.message}>`);

    rows.push(
      `  frame ${frame.url() || "(about:blank)"} → ${JSON.stringify(buttons)}`,
    );
  }

  return rows.join("\n");
}

function paymentAlreadyCompleted(page) {
  return page.url().includes("callback_type=success");
}

/**
 * Races the "Pay Now" button appearing against the payment having already
 * completed on its own. Polls both rather than using a single locator wait:
 * the alternative outcome here isn't "not yet", it's "the card form is gone
 * for good", which a locator wait can only ever report as a timeout.
 *
 * Returns the resolved Locator alongside the status so the caller clicks the
 * exact element found here, in the frame it was found in — re-deriving it from
 * the page would land back in the main frame and miss it again.
 *
 * @returns {Promise<{status: "ready"|"completed", button: import('@playwright/test').Locator|null}>}
 *   "ready"     — button is showing "Pay Now"; caller should click `button`.
 *   "completed" — payment already went through; caller must NOT click.
 */
async function waitForSubmitReadyOrCompletion(page, timeoutMs = 30000) {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    if (paymentAlreadyCompleted(page))
      return { status: "completed", button: null };

    const button = await findPayNowButton(page);
    if (button) return { status: "ready", button };

    await page.waitForTimeout(500);
  }

  if (paymentAlreadyCompleted(page)) {
    return { status: "completed", button: null };
  }

  throw new Error(
    `Timed out after ${timeoutMs}ms: no button labelled "Pay Now" was found in any frame, ` +
      `and the payment never completed (still on "${page.url()}"). ` +
      `Buttons present, per frame:\n${await describeSubmitButtons(page)}`,
  );
}

/**
 * Waits for the full-page redirect to Dodo's hosted checkout.
 *
 * Must live at module scope: it was previously declared inside
 * waitForSubmitReadyOrCompletion() — after that function's `throw`, so it was
 * unreachable there AND invisible to Dodo.fillCardDetails(), which called it
 * and got "waitForDodoCheckoutPage is not defined".
 */
async function waitForDodoCheckoutPage(page, timeoutMs = 45000) {
  console.log("Waiting for redirect to the Dodo Payments checkout page...");
  await page.waitForURL(
    (url) =>
      url.href.startsWith("https://test.checkout.dodopayments.com/session/"),
    { timeout: timeoutMs },
  );
  console.log(`✓ Landed on Dodo checkout page: ${page.url()}`);
}

/**
 * Waits for a full-page redirect to any URL starting with `urlPrefix`.
 *
 * The general form of waitForDodoCheckoutPage() above, for hosted checkouts
 * whose path is dynamic (a session id, a per-payment slug) but whose origin is
 * fixed — match the stable prefix and ignore the rest.
 *
 * NOTE: page.waitForURL() resolves immediately when the CURRENT url already
 * matches, so this waits for a redirect only when the page hasn't arrived yet.
 * For a hop BETWEEN two pages sharing a prefix it returns at once — the
 * caller's own wait for an element on the destination is what covers that.
 */
async function waitForUrlPrefix(page, urlPrefix, timeoutMs = 45000) {
  console.log(`Waiting for redirect to "${urlPrefix}"...`);

  await page.waitForURL((url) => url.href.startsWith(urlPrefix), {
    timeout: timeoutMs,
  });

  console.log(`✓ Landed on: ${page.url()}`);
}

/**
 * Waits for a hosted-checkout redirect, but gives up the moment the CHECKOUT
 * page says the payment could not be started.
 *
 * waitForUrlPrefix() above can only ever report "no navigation within 45s", and
 * that one message covers three very different causes: the gateway is slow, the
 * URL prefix is wrong, or — much the most common — no payment session was ever
 * opened. In that last case PayLexer's checkout raises its own modal ("Session
 * Error" over the reason) and STAYS PUT, so the wait is guaranteed to burn its
 * full timeout and the actual cause survives only in the failure screenshot.
 *
 * Racing the redirect against that modal turns a 45-second opaque navigation
 * timeout into an immediate failure quoting what the checkout said.
 */
async function waitForHostedRedirectOrCheckoutError(
  page,
  urlPrefix,
  gatewayLabel,
  timeoutMs = 45000,
) {
  console.log(`Waiting for redirect to "${urlPrefix}"...`);

  // Matched by role, not by class: the modal is PayLexer's own and its class
  // names are not part of any contract, while an "<something> Error" heading
  // above a message is the shape it always renders.
  const errorHeading = page.getByRole("heading", { name: /error/i }).first();

  // The loser of the race rejects after the winner has already resolved.
  // `never` absorbs that rejection — left alone it surfaces as an unhandled
  // rejection and takes the run down seconds after it had moved on.
  const never = () => new Promise(() => {});

  let guard;
  let outcome;

  try {
    outcome = await Promise.race([
      page
        .waitForURL((url) => url.href.startsWith(urlPrefix), {
          timeout: timeoutMs,
        })
        .then(() => "redirected", never),
      errorHeading
        .waitFor({ state: "visible", timeout: timeoutMs })
        .then(() => "checkout-error", never),
      // Both branches above are swallowed on rejection, so without this the
      // race would hang for good when neither outcome happens.
      new Promise((resolve) => {
        guard = setTimeout(() => resolve("timeout"), timeoutMs + 1000);
      }),
    ]);
  } finally {
    // Or the pending timer keeps the process alive for another 46s after the
    // test itself is over.
    clearTimeout(guard);
  }

  if (outcome === "redirected") {
    console.log(`✓ Landed on: ${page.url()}`);
    return;
  }

  if (outcome === "checkout-error") {
    // The heading renders before the reason under it is filled in, so reading
    // straight away quotes a bare "Error". Give the modal a moment to finish.
    await errorHeading
      .locator("xpath=..")
      .locator("p, [class*=message], [class*=desc]")
      .filter({ hasText: /\S/ })
      .first()
      .waitFor({ state: "visible", timeout: 5000 })
      .catch(() => {});

    // The whole modal, not just the heading: "Session Error" on its own says
    // nothing, and the line under it ("Authentication required") is the entire
    // diagnosis. Collected from the leaf elements rather than as one innerText
    // so the dialog's close control does not end up quoted as part of the error.
    const lines = await errorHeading
      .locator("xpath=..")
      .evaluate((container) =>
        Array.from(container.querySelectorAll("*"))
          .filter(
            (node) =>
              node.childElementCount === 0 &&
              !["BUTTON", "SVG", "IMG", "SCRIPT", "STYLE"].includes(
                node.tagName,
              ),
          )
          .map((node) => (node.textContent || "").trim())
          .filter(Boolean),
      )
      .catch(() => []);

    const summary =
      [...new Set(lines)].join(" — ") || "(an error with no readable text)";

    throw new Error(
      `${gatewayLabel} never opened a payment session: the checkout stayed on ` +
        `"${page.url()}" and showed "${summary}".\n` +
        `The card form was never reached, so this is a CONFIGURATION failure rather ` +
        `than a checkout one — the credentials PayLexer sent were refused. Check the ` +
        `gateway's keys in .env against env.example, and that they are the SANDBOX ` +
        `pair, not production.`,
    );
  }

  throw new Error(
    `${gatewayLabel}: no redirect to "${urlPrefix}" within ${timeoutMs}ms, and the ` +
      `checkout reported no error either — still on "${page.url()}".`,
  );
}

/**
 * Waits until a masked input actually holds the digits that were typed into it,
 * then logs what it's showing.
 *
 * Compares DIGITS ONLY, because Dodo's card inputs reformat as you type —
 * "4564710000000004" becomes "4564 7100 0000 0004" and "0229" becomes
 * "02 / 29" — so the typed string never matches the displayed value character
 * for character. The digits are what prove the field kept every keystroke,
 * whatever the mask does with them.
 *
 * Needed because pressSequentially() returning only means the keystrokes were
 * delivered, not that the masked field accepted and kept them.
 */
async function waitForFieldValue(
  page,
  input,
  fieldName,
  typed,
  timeoutMs = 10000,
) {
  const digitsOf = (value) => (value || "").replace(/\D/g, "");
  const expected = digitsOf(typed);
  const deadline = Date.now() + timeoutMs;
  let seen = "";

  while (Date.now() < deadline) {
    seen = await input.inputValue().catch(() => "");

    if (digitsOf(seen) === expected) {
      console.log(`✓ ${fieldName} now contains: "${seen}"`);
      return;
    }

    await page.waitForTimeout(300);
  }

  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for ${fieldName} to hold "${typed}" — ` +
      `field currently reads "${seen}" (digits "${digitsOf(seen)}", expected "${expected}").`,
  );
}
/**
 * Resolves the frame that owns Square's "Complete Payment" modal.
 *
 * CRITICAL: Square nests two levels of iframe. The checkout page iframes in the
 * whole modal, and Square then iframes its card fields inside THAT — so the
 * card inputs, the status message and the "Pay Now" button sit at three
 * different levels, and neither the message nor the button is reachable from
 * `page.locator()` (which is why `page.locator("#square-submit-button")` timed
 * out on a button that was plainly on screen and enabled).
 *
 * Derived as the card frame's PARENT rather than matched on its own URL: the
 * card iframe's filename is stable across SDK releases, the modal's URL is not.
 *
 * Deliberately not the all-frames scan findPayNowButton() does — that costs one
 * slowMo delay (1400ms in playwright.config.js) per frame per selector, which
 * is far too slow to run inside a poll loop.
 */
async function squareModalFrame(page, timeoutMs = 45000) {
  const cardFrame = await waitForFrameByUrl(
    page,
    "single-card-element-iframe.html",
    timeoutMs,
  );

  return cardFrame.parentFrame() || cardFrame;
}

/**
 * Reads Square's status line, which lives in the modal frame — not the page.
 *
 * Square reuses this one element for both hints ("Enter the zip code") and real
 * validation errors, telling them apart only by the class, so both are returned
 * and neither is asserted on.
 */
async function squareCardMessage(page) {
  const frame = await squareModalFrame(page).catch(() => null);

  if (!frame) return { text: null, className: null };

  const message = frame.locator(".sq-card-message").first();

  return {
    text: await message.textContent().catch(() => null),
    className: await message.getAttribute("class").catch(() => null),
  };
}

const describeSquareCardMessage = async (page) => {
  const { text, className } = await squareCardMessage(page);

  return `"${text}" (class "${className}")`;
};

module.exports = {
  //1st
  Stripe: {
    // Stripe test card (documented Visa, always approves, no 3DS).
    TEST_CARD_NUMBER: "4242424242424242",
    TEST_CVC: "123",
    TEST_POSTAL_CODE: "42424",

    async fillCardDetails(page, card = {}) {
      // House convention: month 02, year = current year + 3.
      const expiryMonth = "02";
      const expiryYearShort = String(new Date().getFullYear() + 3).slice(-2);
      const expiryCombined = `${expiryMonth}${expiryYearShort}`;

      // ---- Resolve the context holding the outer Stripe container ----
      console.log("[Stripe] Locating the Stripe checkout container...");

      let ctx = null;
      const ctxDeadline = Date.now() + 90000;
      while (Date.now() < ctxDeadline) {
        for (const frame of page.frames()) {
          const found = await frame
            .locator("#stripe-container")
            .count()
            .then((c) => c > 0)
            .catch(() => false);
          if (found) {
            ctx = frame;
            break;
          }
        }
        if (ctx) break;
        await page.waitForTimeout(500);
      }

      if (!ctx) {
        const urls = page.frames().map((f) => f.url());
        throw new Error(
          `[Stripe] #stripe-container never appeared. Frames present: ${JSON.stringify(urls)}`,
        );
      }

      console.log(
        `[Stripe] Container found in: ${ctx === page.mainFrame() ? "main frame" : ctx.url()}`,
      );

      await ctx
        .locator("#stripe-container")
        .waitFor({ state: "visible", timeout: 30000 });

      // ---- Select the Card tab if a payment method chooser is present ----
      // The ACH bank-search frame in the markup indicates us_bank_account is
      // enabled, so the Payment Element may render a method tab strip. Searched
      // across all Stripe frames since the tabs are not necessarily in the same
      // frame as the fields. Poll briefly and skip if it is a card-only layout.
      const TAB_SELECTORS = [
        "#tab-card",
        "[data-testid='card-tab']",
        "button[id^='tab-card']",
      ];

      let cardTabFrame = null;
      let cardTabSelector = null;
      const tabDeadline = Date.now() + 8000;

      while (Date.now() < tabDeadline && !cardTabFrame) {
        for (const frame of page.frames()) {
          if (!frame.url().includes("js.stripe.com")) continue;
          for (const selector of TAB_SELECTORS) {
            const visible = await frame
              .locator(selector)
              .first()
              .isVisible()
              .catch(() => false);
            if (visible) {
              cardTabFrame = frame;
              cardTabSelector = selector;
              break;
            }
          }
          if (cardTabFrame) break;
        }
        if (!cardTabFrame) await page.waitForTimeout(500);
      }

      if (cardTabFrame) {
        const tab = cardTabFrame.locator(cardTabSelector).first();
        const selected = await tab
          .getAttribute("aria-selected")
          .catch(() => null);
        if (selected === "true") {
          console.log("[Stripe] Card tab already selected.");
        } else {
          console.log(
            `[Stripe] Payment method tabs present — selecting Card via ${cardTabSelector}...`,
          );
          await tab.click();
          await page.waitForTimeout(1500);
        }
      } else {
        console.log("[Stripe] No method tabs — card-only layout.");
      }

      // ---- Locate the frame actually rendering the card inputs ----
      // The iframe under #stripe-payment-element points at
      // elements-inner-accessory-target-*.html, which is a shim — Stripe nests the
      // real inputs in a descendant frame. Rather than assume a nesting depth,
      // search every js.stripe.com frame for the card number input directly.
      //
      // Frame names (__privateStripeFrame5204) carry a counter that increments per
      // Stripe.js instance and differs between runs, so they can never be
      // hardcoded. The src is equally unusable — it embeds a per-session elementId,
      // controllerId and experiment token.
      const CARD_SELECTORS = [
        "#Field-numberInput",
        'input[name="number"]',
        'input[autocomplete="cc-number"]',
        'input[data-elements-stable-field-name="cardNumber"]',
      ];

      console.log(
        "[Stripe] Searching Stripe frames for the card number input...",
      );

      let paymentFrame = null;
      let cardSelector = null;
      const fieldDeadline = Date.now() + 60000;

      while (Date.now() < fieldDeadline && !paymentFrame) {
        for (const frame of page.frames()) {
          if (!frame.url().includes("js.stripe.com")) continue;
          for (const selector of CARD_SELECTORS) {
            const visible = await frame
              .locator(selector)
              .first()
              .isVisible()
              .catch(() => false);
            if (visible) {
              paymentFrame = frame;
              cardSelector = selector;
              console.log(`[Stripe] Card input found via ${selector}`);
              break;
            }
          }
          if (paymentFrame) break;
        }
        if (!paymentFrame) await page.waitForTimeout(500);
      }

      if (!paymentFrame) {
        // Dump every Stripe frame with its inputs so the next run has real data.
        const tree = [];
        for (const f of page.frames()) {
          if (!f.url().includes("js.stripe.com")) continue;
          const inputs = await f
            .locator("input")
            .evaluateAll((els) =>
              els.map((el) => ({
                id: el.id || null,
                name: el.getAttribute("name"),
                type: el.type,
                autocomplete: el.getAttribute("autocomplete"),
                placeholder: el.getAttribute("placeholder"),
                stableName: el.getAttribute("data-elements-stable-field-name"),
              })),
            )
            .catch(() => []);
          const buttons = await f
            .locator("button")
            .evaluateAll((els) =>
              els.map((el) => (el.textContent || "").trim()).filter(Boolean),
            )
            .catch(() => []);
          tree.push({
            component:
              (f.url().match(/elements-inner-([a-z-]+)/i) || [])[1] ||
              "unknown",
            name: f.name(),
            inputs,
            buttons,
          });
        }
        throw new Error(
          `[Stripe] Card number input not found in any Stripe frame. Frame tree: ${JSON.stringify(tree, null, 2)}`,
        );
      }

      // Resolve a sibling field within the same frame, trying each candidate.
      const resolveField = async (candidates, timeout) => {
        const deadline = Date.now() + timeout;
        while (Date.now() < deadline) {
          for (const selector of candidates) {
            const visible = await paymentFrame
              .locator(selector)
              .first()
              .isVisible()
              .catch(() => false);
            if (visible) return selector;
          }
          await page.waitForTimeout(300);
        }
        return null;
      };

      const fillField = async (candidates, label, value, required = true) => {
        const selector = await resolveField(
          candidates,
          required ? 30000 : 4000,
        );

        if (!selector) {
          if (required) {
            throw new Error(
              `[Stripe] Required field "${label}" never appeared. Tried ${JSON.stringify(candidates)}`,
            );
          }
          console.log(
            `[Stripe] Optional field "${label}" not present — skipping.`,
          );
          return;
        }

        const input = paymentFrame.locator(selector).first();
        await input.click();
        console.log(`[Stripe] Typing ${label}: ${value}`);
        // Stripe formats as characters arrive (grouping spaces on the number,
        // slash on the expiry), so pressSequentially, never fill().
        await input.pressSequentially(value, { delay: 50 });

        const actual = await input.inputValue();
        console.log(`[Stripe] "${label}" now reads: "${actual}"`);
        if (actual.replace(/\D/g, "") !== value.replace(/\D/g, "")) {
          throw new Error(
            `[Stripe] ${label} failed to register. Expected "${value}", got "${actual}"`,
          );
        }
      };

      // ---- Card number ----
      // Filled first so Stripe can detect the brand and size the CVC field.
      await fillField([cardSelector], "Card Number", this.TEST_CARD_NUMBER);

      // ---- Expiry (single combined MM/YY field) ----
      // Stripe inserts the slash itself, so type four bare digits.
      await fillField(
        [
          "#Field-expiryInput",
          'input[name="expiry"]',
          'input[autocomplete="cc-exp"]',
          'input[data-elements-stable-field-name="cardExpiry"]',
        ],
        "Expiry",
        expiryCombined,
      );
      console.log(`[Stripe] Expiry set to ${expiryMonth}/${expiryYearShort}.`);

      // ---- CVC ----
      await fillField(
        [
          "#Field-cvcInput",
          'input[name="cvc"]',
          'input[autocomplete="cc-csc"]',
          'input[data-elements-stable-field-name="cardCvc"]',
        ],
        "CVC",
        this.TEST_CVC,
      );

      // ---- Postal code (conditional) ----
      // Only rendered when billing address collection is 'auto' and the detected
      // country requires it. Not an error when absent.
      await fillField(
        [
          "#Field-postalCodeInput",
          'input[name="postalCode"]',
          'input[autocomplete="postal-code"]',
          'input[data-elements-stable-field-name="postalCode"]',
        ],
        "Postal Code",
        this.TEST_POSTAL_CODE,
        false,
      );

      // ---- Surface any error the outer container is already showing ----
      const errorText = await ctx
        .locator("#stripe-error")
        .textContent()
        .catch(() => "");
      if ((errorText || "").trim()) {
        throw new Error(
          `[Stripe] Error shown before submit: ${errorText.trim()}`,
        );
      }

      console.log(
        "[Stripe] All card details filled and validated. Ready to submit.",
      );
    },

    async submitCardPayment(page) {
      // Re-resolve the context — the handle does not carry across calls.
      console.log("[Stripe] Re-resolving the Stripe container for submit...");

      let ctx = null;
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline) {
        for (const frame of page.frames()) {
          const found = await frame
            .locator("#stripe-submit-button")
            .count()
            .then((c) => c > 0)
            .catch(() => false);
          if (found) {
            ctx = frame;
            break;
          }
        }
        if (ctx) break;
        await page.waitForTimeout(500);
      }

      if (!ctx) {
        throw new Error(
          "[Stripe] #stripe-submit-button not found when attempting to submit.",
        );
      }

      const payButton = ctx
        .locator("#stripe-submit-button:not([disabled])")
        .first();
      console.log("[Stripe] Waiting for Pay Now button to be enabled...");
      await payButton.waitFor({ state: "visible", timeout: 30000 });
      await payButton.scrollIntoViewIfNeeded();

      const startUrl = page.url();
      console.log(`[Stripe] URL before submit: ${startUrl}`);

      console.log("[Stripe] Clicking Pay Now (attempt 1: real mouse)...");
      const box = await payButton.boundingBox();
      if (box) {
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.down();
        await page.mouse.up();
      } else {
        await payButton.click();
      }

      const readError = async () => {
        const text = await ctx
          .locator("#stripe-error")
          .textContent()
          .catch(() => "");
        return (text || "").trim();
      };

      const submissionTook = async (ms) => {
        // The container detaching (or being hidden) is the clearest signal the
        // charge went through — it carries an inline display:block that Stripe's
        // own handler toggles rather than removing the node.
        const gone = await page
          .waitForFunction(
            () => {
              const el = document.querySelector("#stripe-container");
              return !el || el.style.display === "none";
            },
            null,
            { timeout: ms },
          )
          .then(() => true)
          .catch(() => false);
        if (gone) return true;
        return page.url() !== startUrl;
      };

      let submitted = await submissionTook(30000);

      if (!submitted) {
        const err = await readError();
        if (err) throw new Error(`[Stripe] Submission rejected: ${err}`);
        console.log(
          "[Stripe] No effect yet — retrying (attempt 2: native JS click)...",
        );
        await payButton.evaluate((el) => el.click()).catch(() => {});
        submitted = await submissionTook(30000);
      }

      if (!submitted) {
        console.log(
          "[Stripe] Still no effect — retrying (attempt 3: dispatched event)...",
        );
        // #stripe-submit-button is a bare <button> in a <div> with no type and no
        // parent <form>, so requestSubmit() does not apply here — the handler is a
        // JS click listener. Dispatch a bubbling click instead.
        await payButton
          .evaluate((el) =>
            el.dispatchEvent(
              new MouseEvent("click", { bubbles: true, cancelable: true }),
            ),
          )
          .catch(() => {});
        submitted = await submissionTook(60000);
      }

      if (!submitted) {
        const err = await readError();
        if (err) throw new Error(`[Stripe] Submission rejected: ${err}`);
        console.log(
          `[Stripe] WARNING: submission had no observable effect. URL still ${page.url()}`,
        );
      }

      // ---- 3DS challenge (conditional) ----
      // 4242424242424242 does not trigger 3DS, but a Radar rule or a different
      // test card would. Poll briefly, skip if absent.
      await page.waitForTimeout(2000);
      const challenge = page
        .frames()
        .find(
          (f) =>
            /acs|3ds|challenge|authenticate/i.test(f.url()) &&
            !f.url().includes("elements-inner"),
        );
      if (challenge) {
        console.log(
          `[Stripe] 3DS challenge detected: ${challenge.url().split("#")[0]}`,
        );
      } else {
        console.log("[Stripe] No 3DS challenge — continuing.");
      }

      console.log("[Stripe] Waiting for the post-payment page to settle...");
      await page.waitForLoadState("domcontentloaded").catch(() => {});
      console.log(`[Stripe] Post-payment URL: ${page.url()}`);
    },
  },

  Mollie: {
    fillCardDetails: async (page) => {
      console.log("Filling Mollie card details (Components iframe)...");

      await waitForUrlPrefix(
        page,
        "https://www.mollie.com/checkout/select-method",
        60000,
      );
      console.log(`✓ Mollie method selection reached: ${page.url()}`);

      const CARD_NUMBER = "4111111111111111";
      const CARD_CVV = "847";
      const CARD_HOLDER = "Token Tutorial";
      const CARD_EXPIRY_MONTH = "02";
      const CARD_EXPIRY_YEAR = String(new Date().getFullYear() + 3).slice(-2);

      console.log(`Using fixed test card ending in ${CARD_NUMBER.slice(-4)}`);
      console.log(`Expiry to enter: ${CARD_EXPIRY_MONTH}/${CARD_EXPIRY_YEAR}`);

      // -----------------------------------------------------------------
      // Resolves whichever frame owns a marker element. page.frames() puts the
      // main frame at index 0, so one loop covers both the Components iframe
      // and the outer document without committing to either — which matters
      // because Mollie may serve a non-Components card page for some profiles.
      // -----------------------------------------------------------------
      const resolveContext = async (marker, label, timeout = 45000) => {
        const deadline = Date.now() + timeout;
        while (Date.now() < deadline) {
          for (const frame of page.frames()) {
            const count = await frame
              .locator(marker)
              .count()
              .catch(() => 0);
            if (count > 0) {
              const where =
                frame === page.mainFrame() ? "main frame" : frame.url();
              console.log(`[scope] ${label} (${marker}) found in: ${where}`);
              return frame;
            }
          }
          await page.waitForTimeout(500);
        }
        return null;
      };

      // Dumps everything needed to diagnose a miss without another run.
      const dumpState = async (stage) => {
        console.log(`[diag] --- ${stage} ---`);
        console.log(`[diag] URL: ${page.url()}`);
        console.log(
          `[diag] Frames: ${JSON.stringify(page.frames().map((f) => f.url()))}`,
        );
        for (const frame of page.frames()) {
          const inputs = await frame
            .evaluate(() =>
              Array.from(document.querySelectorAll("input")).map((el) => ({
                id: el.id || null,
                name: el.getAttribute("name") || null,
                autocomplete: el.getAttribute("autocomplete") || null,
                type: el.type,
              })),
            )
            .catch(() => "(unreadable)");
          const where = frame === page.mainFrame() ? "main frame" : frame.url();
          console.log(`[diag] inputs in ${where}: ${JSON.stringify(inputs)}`);
        }
      };

      // -- 1. Choose the Card method -------------------------------------
      // Matched on an EXACT text node: the method list also carries entries
      // like "Cartes Bancaires", and a loose hasText:"Card" would match several
      // and trip strict mode.
      const cardRow = page
        .locator(".payment-method-list--bordered")
        .filter({ has: page.locator('p:text-is("Card")') })
        .first();

      await cardRow.waitFor({ state: "visible", timeout: 45000 });
      console.log("✓ Card method row located");

      // A <span> is not natively clickable. If the row is wrapped in an anchor,
      // label or button, THAT is the element that activates it — clicking the
      // span can be swallowed instead of bubbling. Ancestor preferred, span
      // as fallback.
      const clickable = cardRow.locator(
        "xpath=ancestor-or-self::*[self::a or self::button or self::label][1]",
      );
      const hasClickableAncestor = (await clickable.count().catch(() => 0)) > 0;

      if (hasClickableAncestor) {
        const tag = await clickable
          .first()
          .evaluate((el) => el.tagName.toLowerCase());
        const href = await clickable
          .first()
          .getAttribute("href")
          .catch(() => null);
        console.log(
          `[scope] Clicking <${tag}> ancestor of the Card row (href=${href})`,
        );
        await clickable.first().scrollIntoViewIfNeeded();
        await clickable.first().click();
      } else {
        console.log(
          "[scope] No clickable ancestor — clicking the Card row span itself",
        );
        await cardRow.scrollIntoViewIfNeeded();
        await cardRow.click();
      }
      console.log("✓ Card method clicked");

      // Mollie navigates to a dedicated card page, which then boots the
      // Components iframe. Settle before looking for the form.
      await page.waitForLoadState("domcontentloaded").catch(() => {});
      await page.waitForTimeout(1500);
      console.log(`[diag] URL after Card click: ${page.url()}`);

      // -- 2. Resolve the card form's context ------------------------------
      let ctx = await resolveContext("#cardNumber", "Card form", 45000);

      if (!ctx) {
        // The row click may not have registered at all. Retried once against
        // the span directly before giving up.
        console.log(
          "⚠ Card form not found — retrying the row click on the span itself",
        );
        await dumpState("card form missing, before retry");
        await cardRow.click({ force: true }).catch((err) => {
          console.log(`⚠ Forced row click failed: ${err.message}`);
        });
        await page.waitForLoadState("domcontentloaded").catch(() => {});
        await page.waitForTimeout(2000);
        ctx = await resolveContext("#cardNumber", "Card form (retry)", 30000);
      }

      if (!ctx) {
        await dumpState("card form missing, after retry");
        throw new Error(
          `Mollie card form (#cardNumber) not found in any frame after clicking the Card method. ` +
            `URL: ${page.url()}. Expected a frame matching ` +
            `js.mollie.com/v2/components/card/private/index.html — see the [diag] dumps above.`,
        );
      }

      // -- 3. Card number -------------------------------------------------
      // Every field is targeted by its stable id. The svelte-e0yh71 /
      // svelte-wc0xob class hashes are build artifacts and will change on
      // Mollie's next deploy.
      //
      // pressSequentially rather than fill(): the number groups itself into
      // blocks of four and the expiry inserts its own separator, both driven by
      // input events that fill() does not produce.
      const cardNumberInput = ctx.locator("#cardNumber");
      await cardNumberInput.waitFor({ state: "visible", timeout: 30000 });
      await cardNumberInput.click();
      await cardNumberInput.pressSequentially(CARD_NUMBER, { delay: 60 });
      console.log(
        `✓ Card number filled — value="${await cardNumberInput.inputValue()}"`,
      );

      // -- 4. Expiry ------------------------------------------------------
      // Placeholder is "MM / YY" — spaces around the separator, inserted by the
      // mask. Only digits are typed; the result is verified rather than
      // assumed, because a mask that didn't fire leaves "0229" in the field.
      const expiryInput = ctx.locator("#cardExpiryDate");
      await expiryInput.waitFor({ state: "visible", timeout: 30000 });
      await expiryInput.click();
      await expiryInput.pressSequentially(
        `${CARD_EXPIRY_MONTH}${CARD_EXPIRY_YEAR}`,
        { delay: 80 },
      );

      let expiryValue = await expiryInput.inputValue();
      if (!expiryValue.includes("/")) {
        console.log(
          `⚠ Expiry mask did not insert a separator (field reads "${expiryValue}") — retyping explicitly`,
        );
        await expiryInput.fill("");
        await expiryInput.click();
        await expiryInput.pressSequentially(
          `${CARD_EXPIRY_MONTH} / ${CARD_EXPIRY_YEAR}`,
          { delay: 80 },
        );
        expiryValue = await expiryInput.inputValue();
      }
      console.log(`✓ Expiry filled — value="${expiryValue}"`);

      // -- 5. CVC ---------------------------------------------------------
      // maxlength="3", so the suite's 3-digit 847 fits. A 4-digit Amex CVV
      // would be silently truncated by the browser.
      const cvvInput = ctx.locator("#cardCvv");
      await cvvInput.waitFor({ state: "visible", timeout: 30000 });
      await cvvInput.click();
      await cvvInput.pressSequentially(CARD_CVV, { delay: 60 });
      console.log(`✓ CVC filled — value="${await cvvInput.inputValue()}"`);

      // -- 6. Cardholder ---------------------------------------------------
      const cardHolderInput = ctx.locator("#cardHolder");
      await cardHolderInput.waitFor({ state: "visible", timeout: 30000 });
      await cardHolderInput.click();
      await cardHolderInput.pressSequentially(CARD_HOLDER, { delay: 40 });
      console.log(`✓ Cardholder filled: ${CARD_HOLDER}`);

      // -- Validation confirmation (no clicking — that's submitCardPayment) --
      //
      // NOTE the difference from Authorize.Net: aria-invalid is "false" on all
      // four Mollie fields while they are still EMPTY, and only flips to "true"
      // after a rejected submit. It is useless as a filled/valid gate here, so
      // value length is the only usable check.
      for (const [selector, label] of [
        ["#cardNumber", "Card number"],
        ["#cardExpiryDate", "Expiry"],
        ["#cardCvv", "CVC"],
        ["#cardHolder", "Cardholder"],
      ]) {
        const value = await ctx.locator(selector).inputValue();
        if (!value || value.trim().length === 0) {
          throw new Error(
            `Mollie ${label} ("${selector}") is empty after fill — keystrokes did not land. URL: ${page.url()}`,
          );
        }
      }
      console.log("✓ All card fields hold values");

      console.log("✓ All card fields filled");
    },

    submitCardPayment: async (page) => {
      console.log("Submitting Mollie card payment...");

      if (await paymentAlreadyCompleted(page)) {
        console.log("✓ Payment already completed — skipping submit");
        return;
      }

      const urlBeforeSubmit = page.url();

      // Resolved by content rather than assumed to be the main frame, matching
      // fillCardDetails — the Pay button sits in the same Components frame as
      // the card fields.
      const resolvePayContext = async (timeout = 30000) => {
        const deadline = Date.now() + timeout;
        while (Date.now() < deadline) {
          for (const frame of page.frames()) {
            const count = await frame
              .locator('button[type="submit"]')
              .filter({ hasText: /Pay with card/i })
              .count()
              .catch(() => 0);
            if (count > 0) {
              const where =
                frame === page.mainFrame() ? "main frame" : frame.url();
              console.log(`[scope] Pay with card button found in: ${where}`);
              return frame;
            }
          }
          await page.waitForTimeout(500);
        }
        throw new Error(
          `Mollie "Pay with card" button not found in any frame. URL: ${page.url()}. ` +
            `Frames: ${JSON.stringify(page.frames().map((f) => f.url()))}`,
        );
      };

      const ctx = await resolvePayContext(30000);

      // -- 1. Pay with card ------------------------------------------------
      // Matched by text rather than the class list: mc-button--* plus a svelte-
      // build hash is fragile, and there is more than one submit button across
      // this flow (this one, then the simulator's Continue).
      const payButton = ctx
        .locator('button[type="submit"]')
        .filter({ hasText: /Pay with card/i })
        .first();
      await payButton.waitFor({ state: "visible", timeout: 30000 });

      // page, NOT ctx. describeSubmitButtons iterates page.frames() internally,
      // so it needs a Page — handing it a Frame throws
      // "page.frames is not a function". It walks every frame itself, so
      // passing page still surfaces the in-iframe buttons.
      await describeSubmitButtons(page, 'button[type="submit"]');

      // Attempt 1 — real mouse movement then click.
      try {
        await payButton.scrollIntoViewIfNeeded();
        await payButton.hover();
        await payButton.click({ timeout: 10000 });
        console.log("✓ Pay with card clicked (real mouse)");
      } catch (mouseError) {
        console.log(`⚠ Real mouse click failed: ${mouseError.message}`);

        // Attempt 2 — native JS click.
        try {
          await payButton.evaluate((btn) => btn.click());
          console.log("✓ Pay with card clicked (native JS)");
        } catch (jsError) {
          console.log(`⚠ Native JS click failed: ${jsError.message}`);

          // Attempt 3 — requestSubmit on the owning form. Valid here, unlike
          // Authorize.Net, because this IS a type="submit" inside a real form.
          await payButton.evaluate((btn) => {
            const form = btn.closest("form");
            if (!form)
              throw new Error("Pay with card button has no owning form");
            form.requestSubmit ? form.requestSubmit() : form.submit();
          });
          console.log("✓ Pay with card submitted (requestSubmit)");
        }
      }

      // -- 2. Test-mode outcome simulator -----------------------------------
      // Mollie test mode interposes a page that picks the payment's final
      // state. Other values on this radio group are "failed", "canceled" and
      // "expired" — grep for final_state to switch a negative-path test.
      //
      // The simulator is a plain Mollie page in the top-level document, not in
      // the Components iframe, so main-frame scope is correct here.
      const paidRadio = page.locator(
        'input[type="radio"][name="final_state"][value="paid"]',
      );
      await paidRadio.waitFor({ state: "attached", timeout: 60000 });
      console.log("✓ Test-mode outcome simulator reached");

      // check() rather than click(): the radio carries class checkbox__input
      // and is likely visually replaced by a styled label, so a plain click can
      // land on a zero-size or covered element. force skips the visibility
      // assertion that would otherwise fail on exactly that.
      try {
        await paidRadio.check({ timeout: 10000 });
        console.log('✓ Selected final_state "paid"');
      } catch (checkError) {
        console.log(`⚠ check() failed: ${checkError.message} — forcing`);
        await paidRadio.check({ force: true });
        console.log('✓ Selected final_state "paid" (forced)');
      }

      // -- 3. Continue -------------------------------------------------------
      const continueButton = page.locator('button[name="submit"].form__button');
      await continueButton.waitFor({ state: "visible", timeout: 30000 });

      try {
        await continueButton.scrollIntoViewIfNeeded();
        await continueButton.click({ timeout: 10000 });
        console.log("✓ Continue clicked (real mouse)");
      } catch (mouseError) {
        console.log(
          `⚠ Continue real mouse click failed: ${mouseError.message}`,
        );
        await continueButton.evaluate((btn) => btn.click());
        console.log("✓ Continue clicked (native JS)");
      }

      // Mollie redirects back to the WTE return URL after the simulator, so the
      // top-level URL genuinely changes and the shared URL-comparison helper is
      // valid here.
      await waitForSubmissionToTakeEffect(page, urlBeforeSubmit);

      // Surface a stall on mollie.com — a card rejected at the form step keeps
      // the URL on checkout and otherwise reads as a silent timeout.
      if (page.url().includes("mollie.com")) {
        const errorText = await page
          .locator('.mc-text-field__validation-text, [role="alert"]')
          .first()
          .textContent({ timeout: 3000 })
          .catch(() => null);
        console.log(
          errorText && errorText.trim()
            ? `⚠ Still on Mollie with validation error: "${errorText.trim()}"`
            : `⚠ Still on Mollie with no visible error — URL: ${page.url()}`,
        );
      }

      console.log("✓ Card payment submitted");
    },
  },

  Flutterwave: {
    // Flutterwave sandbox test card (Mastercard, PIN + OTP flow).
    TEST_CARD_NUMBER: "5531886652142950",
    TEST_CVV: "123",
    TEST_PIN: "3310",
    TEST_OTP: "12345",

    // Shared element search. Scans every frame of every page on the context, so a
    // popup ACS window is found as readily as an inline iframe. Returns the owning
    // page too, since later steps need it for waitForURL and mouse actions.
    async _findIn(page, selectors, timeout) {
      const deadline = Date.now() + timeout;
      const context = page.context();
      while (Date.now() < deadline) {
        for (const p of context.pages()) {
          if (p.isClosed()) continue;
          for (const frame of p.frames()) {
            for (const selector of selectors) {
              const visible = await frame
                .locator(selector)
                .first()
                .isVisible()
                .catch(() => false);
              if (visible) return { frame, selector, page: p };
            }
          }
        }
        // Guard the sleep: if the harness tears the browser down mid-poll, exit
        // cleanly instead of throwing "Target page has been closed".
        const slept = await page.waitForTimeout(400).then(
          () => true,
          () => false,
        );
        if (!slept) return null;
      }
      return null;
    },

    // Dumps every frame's inputs and clickable labels across all open pages —
    // used on failure so the next run has real markup rather than a bare timeout.
    async _dumpFrames(page) {
      const tree = [];
      for (const p of page.context().pages()) {
        if (p.isClosed()) continue;
        for (const f of p.frames()) {
          const inputs = await f
            .locator("input")
            .evaluateAll((els) =>
              els.map((el) => ({
                id: el.id || null,
                name: el.getAttribute("name"),
                type: el.type,
                ariaLabel: el.getAttribute("aria-label"),
                placeholder: el.getAttribute("placeholder"),
                visible: !!(el.offsetWidth || el.offsetHeight),
              })),
            )
            .catch(() => []);
          const clickables = await f
            .locator("button, li, [role='tab']")
            .evaluateAll((els) =>
              els
                .map((el) => (el.textContent || "").trim().slice(0, 40))
                .filter(Boolean)
                .slice(0, 25),
            )
            .catch(() => []);
          if (inputs.length || clickables.length) {
            tree.push({ url: f.url().split("?")[0], inputs, clickables });
          }
        }
      }
      return JSON.stringify(tree, null, 2);
    },

    async fillCardDetails(page, card = {}) {
      // House convention: month 02, year = current year + 3.
      const expiryMonth = "02";
      const expiryYearShort = String(new Date().getFullYear() + 3).slice(-2);
      const expiryCombined = `${expiryMonth}${expiryYearShort}`;

      console.log(
        "[Flutterwave] Waiting for redirect to the Flutterwave hosted page...",
      );
      await waitForUrlPrefix(
        page,
        "https://checkout-v2.dev-flutterwave.com/v3/hosted/pay",
      );
      console.log(`[Flutterwave] Landed on hosted page: ${page.url()}`);

      // The hosted page mounts asynchronously and animates in.
      await page.waitForLoadState("domcontentloaded").catch(() => {});
      await page.waitForTimeout(3000);

      // ---- Select the Card payment method if a chooser is present ----
      // Flutterwave's v3 hosted page commonly lists Card / Bank Transfer / USSD /
      // Mobile Money before revealing the card fields. Poll briefly, then skip if
      // this is a card-only layout.
      const cardTab = await this._findIn(
        page,
        [
          'li[aria-label*="card" i]',
          'button[aria-label*="card" i]',
          '[role="tab"]:has-text("Card")',
          'li:has-text("Card")',
          'button:has-text("Pay with card")',
        ],
        8000,
      );

      if (cardTab) {
        console.log(
          `[Flutterwave] Payment method chooser present — selecting Card via ${cardTab.selector}`,
        );
        await cardTab.frame
          .locator(cardTab.selector)
          .first()
          .click()
          .catch(() => {});
        await page.waitForTimeout(2000);
      } else {
        console.log(
          "[Flutterwave] No method chooser detected — assuming card-only layout.",
        );
      }

      // ---- Locate the frame holding the card number field ----
      // Ids (#cardnumber, #expiry, #cvv) are author-written and stable.
      // name="primary" is shared by all three inputs and useless as a
      // discriminator; the Vue scope attribute (data-v-35530402) churns on rebuild.
      const cardNumber = await this._findIn(
        page,
        [
          "#cardnumber",
          'input[aria-label="CARD NUMBER"]',
          'input[placeholder="0000 0000 0000 0000"]',
        ],
        45000,
      );

      if (!cardNumber) {
        throw new Error(
          `[Flutterwave] Card number field not found. Frame tree: ${await this._dumpFrames(page)}`,
        );
      }

      const ctx = cardNumber.frame;
      console.log(
        `[Flutterwave] Card form found in: ${
          ctx === page.mainFrame() ? "main frame" : ctx.url()
        }`,
      );

      const fillField = async (selectors, label, value) => {
        let input = null;
        const deadline = Date.now() + 30000;
        while (Date.now() < deadline && !input) {
          for (const selector of selectors) {
            const candidate = ctx.locator(selector).first();
            const visible = await candidate.isVisible().catch(() => false);
            if (visible) {
              input = candidate;
              break;
            }
          }
          if (!input) await page.waitForTimeout(300);
        }

        if (!input) {
          throw new Error(
            `[Flutterwave] ${label} field never appeared. Tried ${JSON.stringify(selectors)}`,
          );
        }

        await input.click();
        console.log(`[Flutterwave] Typing ${label}: ${value}`);
        // Flutterwave formats as characters arrive (grouping spaces on the number,
        // slash on the expiry), so pressSequentially, never fill().
        await input.pressSequentially(value, { delay: 50 });

        const actual = await input.inputValue();
        console.log(`[Flutterwave] "${label}" now reads: "${actual}"`);
        if (actual.replace(/\D/g, "") !== value.replace(/\D/g, "")) {
          throw new Error(
            `[Flutterwave] ${label} failed to register. Expected "${value}", got "${actual}"`,
          );
        }
      };

      // ---- Card number ----
      // maxlength="23" allows the spaced form; type bare digits and let
      // Flutterwave insert the grouping.
      await fillField(
        [cardNumber.selector],
        "Card Number",
        this.TEST_CARD_NUMBER,
      );

      // ---- Expiry (single combined MM/YY field) ----
      // maxlength="5" — Flutterwave inserts the slash, so type four bare digits.
      await fillField(
        [
          "#expiry",
          'input[aria-label="VALID TILL"]',
          'input[placeholder="MM/YY"]',
        ],
        "Expiry",
        expiryCombined,
      );
      console.log(
        `[Flutterwave] Expiry set to ${expiryMonth}/${expiryYearShort}.`,
      );

      // ---- CVV ----
      // type="password" but readable via inputValue() (same as the eWAY CVV).
      await fillField(
        ["#cvv", 'input[aria-label="CVV"]', 'input[placeholder="123"]'],
        "CVV",
        this.TEST_CVV,
      );

      console.log(
        "[Flutterwave] All card details filled and validated. Ready to submit.",
      );
    },

    async submitCardPayment(page) {
      // ---- Step 1: Pay button ----
      // The label carries the live booking total ("Pay NGN 1,624.00"), so match on
      // the aria-label prefix rather than exact text. The Vue scope attributes and
      // the generic .btn.base class are unusable as discriminators — Pay, Proceed
      // and Submit all share them.
      const payHit = await this._findIn(
        page,
        ['button[aria-label^="Pay "]', 'button[type="submit"]:has-text("Pay")'],
        60000,
      );

      if (!payHit) {
        throw new Error(
          `[Flutterwave] Pay button not found. Frame tree: ${await this._dumpFrames(page)}`,
        );
      }

      const payButton = payHit.frame.locator(payHit.selector).first();
      await payButton.scrollIntoViewIfNeeded();

      const payLabel = await payButton
        .getAttribute("aria-label")
        .catch(() => "");
      console.log(`[Flutterwave] Pay button reads: "${payLabel}"`);

      console.log("[Flutterwave] Clicking Pay (attempt 1: real mouse)...");
      const payBox = await payButton.boundingBox();
      if (payBox) {
        await page.mouse.move(
          payBox.x + payBox.width / 2,
          payBox.y + payBox.height / 2,
        );
        await page.mouse.down();
        await page.mouse.up();
      } else {
        await payButton.click();
      }

      // ---- Step 2: Proceed confirmation ----
      const PROCEED_SELECTORS = [
        'button[aria-label="Proceed"]',
        'button:has-text("Proceed")',
      ];

      let proceedHit = await this._findIn(page, PROCEED_SELECTORS, 45000);

      if (!proceedHit) {
        console.log(
          "[Flutterwave] Proceed not visible — retrying Pay (attempt 2: native JS click)...",
        );
        await payButton.evaluate((el) => el.click()).catch(() => {});
        proceedHit = await this._findIn(page, PROCEED_SELECTORS, 45000);
      }

      if (!proceedHit) {
        console.log(
          "[Flutterwave] Proceed still absent — retrying Pay (attempt 3: requestSubmit())...",
        );
        // The Pay button is type="submit", so requestSubmit() on its owning form is
        // a valid escalation here.
        await payButton
          .evaluate((el) => {
            if (el.form) el.form.requestSubmit();
            else
              el.dispatchEvent(
                new MouseEvent("click", { bubbles: true, cancelable: true }),
              );
          })
          .catch(() => {});
        proceedHit = await this._findIn(page, PROCEED_SELECTORS, 45000);
      }

      // ---- Optional PIN step ----
      // 5531886652142950 is Flutterwave's PIN-authenticated test card. Depending on
      // amount and account config, a PIN screen can appear before Proceed. Poll
      // briefly and skip if absent.
      if (!proceedHit) {
        const pinHit = await this._findIn(
          page,
          [
            "input#pin",
            'input[aria-label*="PIN" i]',
            'input[placeholder*="PIN" i]',
          ],
          5000,
        );

        if (pinHit) {
          console.log("[Flutterwave] PIN screen detected — entering PIN...");
          const pinInput = pinHit.frame.locator(pinHit.selector).first();
          await pinInput.click();
          await pinInput.pressSequentially(this.TEST_PIN, { delay: 50 });

          const pinSubmit = await this._findIn(
            page,
            ['button[aria-label^="Pay "]', 'button[type="submit"]'],
            10000,
          );
          if (pinSubmit) {
            await pinSubmit.frame
              .locator(pinSubmit.selector)
              .first()
              .click()
              .catch(() => {});
          }
          proceedHit = await this._findIn(page, PROCEED_SELECTORS, 45000);
        }
      }

      if (!proceedHit) {
        throw new Error(
          `[Flutterwave] Proceed button never appeared after Pay. URL: ${page.url()}\nFrame tree: ${await this._dumpFrames(page)}`,
        );
      }

      const proceedButton = proceedHit.frame
        .locator(proceedHit.selector)
        .first();
      console.log("[Flutterwave] Proceed button visible — clicking...");
      await proceedButton.scrollIntoViewIfNeeded();
      const proceedBox = await proceedButton.boundingBox();
      if (proceedBox) {
        await page.mouse.move(
          proceedBox.x + proceedBox.width / 2,
          proceedBox.y + proceedBox.height / 2,
        );
        await page.mouse.down();
        await page.mouse.up();
      } else {
        await proceedButton.click();
      }

      // ---- Step 3: OTP on the mock ACS page ----
      // The ids (#fake_otp, #mocksubmit) belong to Flutterwave's sandbox OTP
      // simulator. It may render inline, in an iframe, or in a popup window —
      // _findIn scans all pages on the context, so all three are covered.
      const OTP_SELECTORS = ["#fake_otp", 'input[placeholder="Enter OTP"]'];

      console.log("[Flutterwave] Waiting for the OTP page...");
      let otpHit = await this._findIn(page, OTP_SELECTORS, 90000);

      if (!otpHit) {
        console.log(
          "[Flutterwave] OTP field absent — retrying Proceed (native JS click)...",
        );
        await proceedButton.evaluate((el) => el.click()).catch(() => {});
        otpHit = await this._findIn(page, OTP_SELECTORS, 45000);
      }

      if (!otpHit) {
        const pages = page
          .context()
          .pages()
          .filter((p) => !p.isClosed())
          .map((p) => p.url());
        throw new Error(
          `[Flutterwave] OTP field never appeared. Pages open: ${JSON.stringify(pages)}\nFrame tree: ${await this._dumpFrames(page)}`,
        );
      }

      // Subsequent steps operate on whichever page actually holds the OTP form.
      const otpPage = otpHit.page;
      if (otpPage !== page) {
        console.log(
          `[Flutterwave] OTP is in a separate window: ${otpPage.url()}`,
        );
        await otpPage.bringToFront().catch(() => {});
      }

      console.log(`[Flutterwave] OTP page reached: ${otpPage.url()}`);
      const otpInput = otpHit.frame.locator(otpHit.selector).first();
      await otpInput.click();
      console.log(`[Flutterwave] Typing OTP: ${this.TEST_OTP}`);
      await otpInput.pressSequentially(this.TEST_OTP, { delay: 50 });

      const otpValue = await otpInput.inputValue();
      console.log(`[Flutterwave] OTP field now reads: "${otpValue}"`);
      if (otpValue.replace(/\D/g, "") !== this.TEST_OTP) {
        throw new Error(
          `[Flutterwave] OTP failed to register. Expected "${this.TEST_OTP}", got "${otpValue}"`,
        );
      }

      // The OTP input fires stoppedTyping() on keyup — pressSequentially triggers
      // real keyup events, so that handler runs. Give it a beat before submitting.
      await otpPage.waitForTimeout(1000);

      const otpSubmitHit = await this._findIn(
        otpPage,
        ["#mocksubmit", 'button:has-text("Submit OTP")'],
        30000,
      );

      if (!otpSubmitHit) {
        throw new Error(
          `[Flutterwave] OTP submit button not found. URL: ${otpPage.url()}`,
        );
      }

      const otpSubmit = otpSubmitHit.frame
        .locator(otpSubmitHit.selector)
        .first();
      await otpSubmit.scrollIntoViewIfNeeded();

      const startUrl = otpPage.url();
      console.log(
        "[Flutterwave] Clicking Submit OTP (attempt 1: real mouse)...",
      );
      const otpBox = await otpSubmit.boundingBox();
      if (otpBox) {
        await otpPage.mouse.move(
          otpBox.x + otpBox.width / 2,
          otpBox.y + otpBox.height / 2,
        );
        await otpPage.mouse.down();
        await otpPage.mouse.up();
      } else {
        await otpSubmit.click();
      }

      // ---- Step 4: leave the Flutterwave domain ----
      // If the OTP was in a popup, that window typically closes and the original
      // page completes the redirect — so watch both, plus the popup close event.
      const leftFlutterwave = async (target, ms) =>
        target
          .waitForURL((url) => !/flutterwave\.com/i.test(url.hostname), {
            timeout: ms,
          })
          .then(() => true)
          .catch(() => false);

      let redirected = await Promise.race([
        leftFlutterwave(page, 90000),
        otpPage === page
          ? Promise.resolve(false)
          : leftFlutterwave(otpPage, 90000),
        otpPage === page
          ? Promise.resolve(false)
          : otpPage
              .waitForEvent("close", { timeout: 90000 })
              .then(() => true)
              .catch(() => false),
      ]);

      if (!redirected) {
        console.log(
          `[Flutterwave] Still on Flutterwave (${page.url()}) — retrying (native JS click)...`,
        );
        const stillThere = await otpSubmit.isVisible().catch(() => false);
        if (stillThere) {
          await otpSubmit.evaluate((el) => el.click()).catch(() => {});
          redirected = await leftFlutterwave(page, 60000);
        }
      }

      if (!redirected) {
        console.log(
          `[Flutterwave] WARNING: never left the Flutterwave domain. Final URL: ${page.url()} (started at ${startUrl})`,
        );
      }

      await page.waitForLoadState("domcontentloaded").catch(() => {});
      console.log(`[Flutterwave] Post-payment URL: ${page.url()}`);
    },
  },

  Braintree: {
    // Braintree sandbox test card (documented Visa, always approves).
    TEST_CARD_NUMBER: "4111111111111111",
    TEST_CVV: "123",

    async fillCardDetails(page, card = {}) {
      const cardholderName = card.name || "Token Tutorial";

      // House convention: month 02, year = current year + 3.
      const expiryMonth = "02";
      const expiryYearShort = String(new Date().getFullYear() + 3).slice(-2);
      const expiryCombined = `${expiryMonth}${expiryYearShort}`;

      // ---- Resolve the context holding the outer Braintree form ----
      // The outer #braintree-payment-form may sit on the main page or inside a
      // gateway iframe, so search the main frame and all children.
      console.log("[Braintree] Locating the Braintree payment form...");

      let formContext = null;
      const formDeadline = Date.now() + 90000;
      while (Date.now() < formDeadline) {
        for (const frame of page.frames()) {
          const hasForm = await frame
            .locator("#braintree-payment-form")
            .count()
            .then((c) => c > 0)
            .catch(() => false);
          if (hasForm) {
            formContext = frame;
            break;
          }
        }
        if (formContext) break;
        await page.waitForTimeout(500);
      }

      if (!formContext) {
        const urls = page.frames().map((f) => f.url());
        throw new Error(
          `[Braintree] #braintree-payment-form never appeared. Frames present: ${JSON.stringify(urls)}`,
        );
      }

      console.log(
        `[Braintree] Form found in: ${
          formContext === page.mainFrame() ? "main frame" : formContext.url()
        }`,
      );

      await formContext
        .locator("#braintree-payment-form")
        .waitFor({ state: "visible", timeout: 30000 });

      // ---- Cardholder name (plain input on the outer form) ----
      const nameInput = formContext.locator("#cardholder-name");
      console.log("[Braintree] Waiting for cardholder name field...");
      await nameInput.waitFor({ state: "visible", timeout: 30000 });
      await nameInput.click();
      console.log(`[Braintree] Typing cardholder name: ${cardholderName}`);
      await nameInput.pressSequentially(cardholderName, { delay: 50 });

      const nameValue = await nameInput.inputValue();
      console.log(`[Braintree] Cardholder name now reads: "${nameValue}"`);
      if (nameValue.trim() !== cardholderName) {
        throw new Error(
          `[Braintree] Cardholder name failed to register. Expected "${cardholderName}", got "${nameValue}"`,
        );
      }

      // ---- Resolve the three hosted-field iframes ----
      // All three share the same src (hosted-fields-frame.min.html#<component-id>),
      // so the URL cannot distinguish them — the differentiator is the frame's
      // name/id attribute. The component GUID in the fragment is regenerated per
      // page load, so nothing about the URL can be hardcoded.
      const hostedField = (fieldId) =>
        formContext.frameLocator(`iframe#braintree-hosted-field-${fieldId}`);

      // Each hosted-fields frame renders the real input alongside two 1px,
      // opacity:0 focus-intercept shims (data-braintree-direction="before"/"after").
      // Those shims report as visible to Playwright but sit under the .hosted-field
      // wrapper, so clicking one loops until timeout. Target the real input via
      // data-braintree-name and explicitly exclude .focus-intercept.
      const fillHostedField = async (fieldId, label, value) => {
        const frame = hostedField(fieldId);
        const input = frame
          .locator(
            `input[data-braintree-name="${fieldId}"]:not(.focus-intercept)`,
          )
          .first();

        console.log(`[Braintree] Waiting for "${label}" hosted input...`);
        await input.waitFor({ state: "visible", timeout: 45000 });

        // Focus rather than click. Braintree's wrapper div intercepts pointer
        // events on the frame, so a real click can never land on the input —
        // focus() goes straight to the element and Braintree's own handlers pick
        // it up the same way.
        await input.focus();
        console.log(`[Braintree] Typing ${label}: ${value}`);
        // Braintree formats as characters arrive (grouping spaces on the number,
        // slash on the expiry), so pressSequentially, never fill().
        await input.pressSequentially(value, { delay: 50 });

        const actual = await input.inputValue();
        console.log(`[Braintree] "${label}" now reads: "${actual}"`);
        if (actual.replace(/\D/g, "") !== value.replace(/\D/g, "")) {
          throw new Error(
            `[Braintree] ${label} failed to register. Expected "${value}", got "${actual}"`,
          );
        }
      };

      // ---- Card number ----
      // Filled first so Braintree can detect the brand and size the CVV field.
      await fillHostedField("number", "Card Number", this.TEST_CARD_NUMBER);

      // ---- Expiry (single combined MM/YY field) ----
      // Braintree inserts the slash itself, so type four bare digits.
      await fillHostedField("expirationDate", "Expiry", expiryCombined);
      console.log(
        `[Braintree] Expiry set to ${expiryMonth}/${expiryYearShort}.`,
      );

      // ---- CVV ----
      await fillHostedField("cvv", "CVV", this.TEST_CVV);

      // ---- Confirm Braintree considers the fields valid ----
      // Braintree adds braintree-hosted-fields-invalid to the outer .hosted-field
      // wrapper when a field fails validation, so read the wrappers rather than
      // trying to reach into the frames.
      const wrapperIds = ["card-number", "expiration-date", "cvv"];
      const invalid = [];
      for (const id of wrapperIds) {
        const classes =
          (await formContext
            .locator(`#${id}`)
            .getAttribute("class")
            .catch(() => "")) || "";
        if (classes.includes("braintree-hosted-fields-invalid")) {
          invalid.push(id);
        }
      }

      if (invalid.length) {
        throw new Error(
          `[Braintree] Braintree flagged these fields invalid: ${invalid.join(", ")}`,
        );
      }

      console.log(
        "[Braintree] All fields filled and validated. Ready to submit.",
      );
    },

    async submitCardPayment(page) {
      // Re-resolve the form context — the handle does not carry across calls.
      console.log("[Braintree] Re-resolving the Braintree form for submit...");

      let formContext = null;
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline) {
        for (const frame of page.frames()) {
          const hasForm = await frame
            .locator("#braintree-payment-form")
            .count()
            .then((c) => c > 0)
            .catch(() => false);
          if (hasForm) {
            formContext = frame;
            break;
          }
        }
        if (formContext) break;
        await page.waitForTimeout(500);
      }

      if (!formContext) {
        throw new Error(
          "[Braintree] #braintree-payment-form not found when attempting to submit.",
        );
      }

      const payButton = formContext
        .locator("#braintree-submit-button:not([disabled])")
        .first();

      console.log("[Braintree] Waiting for Pay Now button to be enabled...");
      await payButton.waitFor({ state: "visible", timeout: 30000 });
      await payButton.scrollIntoViewIfNeeded();

      const startUrl = page.url();
      console.log(`[Braintree] URL before submit: ${startUrl}`);

      console.log("[Braintree] Clicking Pay Now (attempt 1: real mouse)...");
      const box = await payButton.boundingBox();
      if (box) {
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.down();
        await page.mouse.up();
      } else {
        await payButton.click();
      }

      const readInvalidFields = async () => {
        const found = [];
        for (const id of ["card-number", "expiration-date", "cvv"]) {
          const classes =
            (await formContext
              .locator(`#${id}`)
              .getAttribute("class")
              .catch(() => "")) || "";
          if (classes.includes("braintree-hosted-fields-invalid"))
            found.push(id);
        }
        return found;
      };

      const submissionTook = async (ms) => {
        // The form detaching is the clearest signal tokenisation succeeded and the
        // charge went through.
        const detached = await page
          .waitForFunction(
            () => !document.querySelector("#braintree-payment-form"),
            null,
            {
              timeout: ms,
            },
          )
          .then(() => true)
          .catch(() => false);
        if (detached) return true;
        return page.url() !== startUrl;
      };

      let submitted = await submissionTook(30000);

      if (!submitted) {
        const invalid = await readInvalidFields();
        if (invalid.length) {
          throw new Error(
            `[Braintree] Submission rejected — invalid fields: ${invalid.join(", ")}`,
          );
        }
        console.log(
          "[Braintree] No effect yet — retrying (attempt 2: native JS click)...",
        );
        await payButton.evaluate((el) => el.click()).catch(() => {});
        submitted = await submissionTook(30000);
      }

      if (!submitted) {
        console.log(
          "[Braintree] Still no effect — retrying (attempt 3: requestSubmit())...",
        );
        // The form carries novalidate, so requestSubmit() will not be blocked by
        // constraint validation.
        await formContext
          .locator("#braintree-payment-form")
          .evaluate((el) => el.requestSubmit())
          .catch(() => {});
        submitted = await submissionTook(60000);
      }

      if (!submitted) {
        const invalid = await readInvalidFields();
        if (invalid.length) {
          throw new Error(
            `[Braintree] Submission rejected — invalid fields: ${invalid.join(", ")}`,
          );
        }
        console.log(
          `[Braintree] WARNING: submission had no observable effect. URL still ${page.url()}`,
        );
      }

      // ---- 3DS challenge (conditional) ----
      // Braintree runs 3DS on some merchant configurations. Poll briefly, skip if
      // absent — never block on it.
      await page.waitForTimeout(2000);
      const challenge = page
        .frames()
        .find(
          (f) =>
            /acs|3ds|challenge|threedsecure/i.test(f.url()) &&
            !f.url().includes("hosted-fields-frame"),
        );
      if (challenge) {
        console.log(
          `[Braintree] 3DS challenge detected: ${challenge.url().split("#")[0]}`,
        );
      } else {
        console.log("[Braintree] No 3DS challenge — continuing.");
      }

      console.log("[Braintree] Waiting for the post-payment page to settle...");
      await page.waitForLoadState("domcontentloaded").catch(() => {});
      console.log(`[Braintree] Post-payment URL: ${page.url()}`);
    },
  },

  Airwallex: {
    TEST_CARD_NUMBER: "4111111111111111",
    TEST_CVC: "123",

    async fillCardDetails(page, card = {}) {
      const expiryMonth = "02";
      const expiryYearShort = String(new Date().getFullYear() + 3).slice(-2);
      const expiryCombined = `${expiryMonth}${expiryYearShort}`;

      console.log("[Airwallex] Polling for the Drop-in element iframe...");

      // Matched on the dropin route only — intent_id, client_secret, sessionId and
      // appVersion all change per booking or per Airwallex release.
      let dropInFrame = null;
      const deadline = Date.now() + 90000;
      while (Date.now() < deadline) {
        dropInFrame = page
          .frames()
          .find(
            (f) =>
              f.url().includes("airwallex.com") &&
              f.url().includes("elements/dropin"),
          );
        if (dropInFrame) break;
        await page.waitForTimeout(500);
      }

      if (!dropInFrame) {
        const urls = page.frames().map((f) => f.url());
        throw new Error(
          `[Airwallex] Drop-in iframe never appeared. Frames present: ${JSON.stringify(urls)}`,
        );
      }

      console.log("[Airwallex] Drop-in iframe resolved.");

      // The container animates height (transition: height 0.35s) as fields mount.
      await page.waitForTimeout(2000);

      // Drop-in may render the three card fields together in the dropin frame or
      // split them into child iframes. Search every Airwallex frame for each field
      // rather than assuming either layout.
      const findFieldFrame = async (selectors, label, timeout = 45000) => {
        const fieldDeadline = Date.now() + timeout;
        while (Date.now() < fieldDeadline) {
          for (const frame of page.frames()) {
            if (!frame.url().includes("airwallex.com")) continue;
            for (const selector of selectors) {
              const visible = await frame
                .locator(selector)
                .first()
                .isVisible()
                .catch(() => false);
              if (visible) {
                console.log(`[Airwallex] "${label}" found via ${selector}`);
                return { frame, selector };
              }
            }
          }
          await page.waitForTimeout(500);
        }
        const awFrames = page
          .frames()
          .filter((f) => f.url().includes("airwallex.com"))
          .map((f) => f.url().split("?")[0]);
        throw new Error(
          `[Airwallex] "${label}" not found. Tried ${JSON.stringify(selectors)} across ${JSON.stringify(awFrames)}`,
        );
      };

      const fillField = async (target, label, value, expectDigits = true) => {
        const input = target.frame.locator(target.selector).first();
        await input.waitFor({ state: "visible", timeout: 20000 });
        await input.click();
        console.log(`[Airwallex] Typing ${label}: ${value}`);
        await input.pressSequentially(value, { delay: 50 });

        const actual = await input.inputValue();
        console.log(`[Airwallex] "${label}" now reads: "${actual}"`);
        const norm = (s) => (expectDigits ? s.replace(/\D/g, "") : s.trim());
        if (norm(actual) !== norm(value)) {
          throw new Error(
            `[Airwallex] ${label} failed to register. Expected "${value}", got "${actual}"`,
          );
        }
      };

      // Card number — filled first so Drop-in can detect the brand and size the CVC.
      const numberTarget = await findFieldFrame(
        [
          'input[name="number"]',
          'input[autocomplete="cc-number"]',
          'input[aria-label*="card number" i]',
        ],
        "Card Number",
      );
      await fillField(numberTarget, "Card Number", this.TEST_CARD_NUMBER);

      // Expiry — confirmed markup: name="expiry", autocomplete="cc-exp",
      // maxlength="7", placeholder "MM / YY". Drop-in inserts the separator, so
      // type four bare digits.
      const expiryTarget = await findFieldFrame(
        ['input[name="expiry"]', 'input[autocomplete="cc-exp"]'],
        "Expiry",
      );
      await fillField(expiryTarget, "Expiry", expiryCombined);
      console.log(
        `[Airwallex] Expiry set to ${expiryMonth}/${expiryYearShort}.`,
      );

      const cvcTarget = await findFieldFrame(
        [
          'input[name="cvc"]',
          'input[autocomplete="cc-csc"]',
          'input[name="cvv"]',
          'input[aria-label*="security code" i]',
        ],
        "CVC",
      );
      await fillField(cvcTarget, "CVC", this.TEST_CVC);

      console.log("[Airwallex] All card fields filled and validated.");
    },

    async submitCardPayment(page) {
      const startUrl = page.url();
      console.log(`[Airwallex] URL before submit: ${startUrl}`);

      // Airwallex renders the amount into the Pay button on most configurations,
      // so match on prefix rather than exact text.
      const buttonPatterns = [/^Pay(\s|$)/i, /^Confirm/i, /^Place order/i];

      let payButton = null;
      const deadline = Date.now() + 45000;
      while (Date.now() < deadline && !payButton) {
        for (const frame of page.frames()) {
          if (!frame.url().includes("airwallex.com")) continue;
          for (const pattern of buttonPatterns) {
            const candidate = frame
              .getByRole("button", { name: pattern })
              .first();
            const visible = await candidate.isVisible().catch(() => false);
            if (visible) {
              payButton = candidate;
              const label = (
                await candidate.textContent().catch(() => "")
              )?.trim();
              console.log(`[Airwallex] Pay button found, label: "${label}"`);
              break;
            }
          }
          if (payButton) break;
        }
        if (!payButton) await page.waitForTimeout(500);
      }

      if (!payButton) {
        // Dump every button label so the next run has something to go on.
        const seen = [];
        for (const frame of page.frames()) {
          if (!frame.url().includes("airwallex.com")) continue;
          const labels = await frame
            .locator("button")
            .evaluateAll((els) =>
              els.map((el) => (el.textContent || "").trim()).filter(Boolean),
            )
            .catch(() => []);
          if (labels.length)
            seen.push({ frame: frame.url().split("?")[0], labels });
        }
        throw new Error(
          `[Airwallex] Pay button not found. Buttons present: ${JSON.stringify(seen)}`,
        );
      }

      await payButton.scrollIntoViewIfNeeded();
      console.log("[Airwallex] Clicking Pay (attempt 1: real mouse)...");
      const box = await payButton.boundingBox();
      if (box) {
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.down();
        await page.mouse.up();
      } else {
        await payButton.click();
      }

      // ---- 3DS / ACS challenge (conditional) ----
      // Poll briefly and skip if absent — never block on this.
      await page.waitForTimeout(3000);
      const challengeFrame = page
        .frames()
        .find(
          (f) =>
            /acs|3ds|challenge|secure/i.test(f.url()) &&
            !f.url().includes("elements/dropin"),
        );
      if (challengeFrame) {
        console.log(
          `[Airwallex] 3DS challenge detected: ${challengeFrame.url().split("?")[0]}`,
        );
        console.log("[Airwallex] Waiting for challenge to resolve...");
      } else {
        console.log("[Airwallex] No 3DS challenge — continuing.");
      }

      // No thank-you wait here on purpose. Every gateway's submit differs, but
      // they all end on the same booking Thank You page, so that check belongs
      // in exactly one place — CheckoutPage.waitForThankYouPage(), called by
      // both specs right after this returns.
      //
      // What used to sit here was a 180s waitForURL on
      // /thank|confirm|success|complete|.../ wrapped in .catch(() => false),
      // which only WARNED on failure. That was worse than nothing twice over: a
      // declined payment burned the full 180s before the real check even
      // started, and the loose regex would have matched plenty of non-landing
      // URLs. The shared check matches the /thank-you path AND the rendered
      // heading, and fails fast on the "Payment Failed" modal.
      //
      // The drop-in-still-mounted detail the old warning logged is worth
      // keeping, since it distinguishes "Airwallex never submitted" from
      // "submitted but the booking didn't complete".
      const dropInStillUp = page
        .frames()
        .some((f) => f.url().includes("elements/dropin"));
      console.log(
        `[Airwallex] Drop-in iframe still mounted: ${dropInStillUp} (false = the widget handed off)`,
      );

      await page.waitForLoadState("domcontentloaded").catch(() => {});
      console.log(`[Airwallex] Post-submit URL: ${page.url()}`);
    },
  },

  //2nd

  Authorize: {
    fillCardDetails: async (page) => {
      console.log(
        "Filling Authorize.Net card details (inside Accept UI iframe)...",
      );

      // Resolved by CONTENT, not by URL. Accept UI puts more than one frame on
      // the authorize.net host, and page.frames() ordering is not stable — a
      // URL match returned a frame successfully and then timed out waiting on a
      // #cardNum that was never in it. Whichever frame owns #cardNum is the
      // card form.
      const resolveAcceptFrame = async (marker, timeout = 60000) => {
        const deadline = Date.now() + timeout;
        while (Date.now() < deadline) {
          for (const frame of page.frames()) {
            if (frame === page.mainFrame()) continue;
            const visible = await frame
              .locator(marker)
              .first()
              .isVisible()
              .catch(() => false);
            if (visible) {
              console.log(
                `[scope] Accept UI frame (${marker}): ${frame.url()}`,
              );
              return frame;
            }
          }
          await page.waitForTimeout(500);
        }
        throw new Error(
          `Authorize.Net Accept UI frame containing ${marker} not found within ${timeout}ms. ` +
            `Frames: ${JSON.stringify(page.frames().map((f) => f.url()))}`,
        );
      };

      console.log(
        `[diag] Frames currently present: ${JSON.stringify(page.frames().map((f) => f.url()))}`,
      );
      const cardFrame = await resolveAcceptFrame("#cardNum", 60000);

      // Fixed test card. NOTE the deviation from the suite default
      // 4564710000000004 — Authorize.Net's sandbox only approves cards from its
      // own published test set, the way SumUp needs its own number.
      // Expiry MONTH fixed, YEAR computed (current year + 3).
      const CARD_NUMBER = "4111111111111111";
      const CARD_CVV = "847";
      const CARD_EXPIRY_MONTH = "02";
      const CARD_EXPIRY_YEAR = String(new Date().getFullYear() + 3).slice(-2);

      const BILLING_FIRST_NAME = "Token";
      const BILLING_LAST_NAME = "Tutorial";
      const BILLING_ZIP = "10001";

      console.log(`Using fixed test card ending in ${CARD_NUMBER.slice(-4)}`);
      console.log(`Expiry to enter: ${CARD_EXPIRY_MONTH}/${CARD_EXPIRY_YEAR}`);

      // -----------------------------------------------------------------
      // Three escalating strategies per field, because the earlier
      // floating-label theory was built on runs that were talking to the WRONG
      // frame — the real fault was frame resolution, fixed above. With the
      // correct frame in hand the ordinary Playwright path should work, so it
      // is tried first and the exotic paths are kept only as fallbacks.
      //
      // Every strategy reads the value back and escalates only if the field is
      // still short, so whichever one this form actually needs is the one that
      // wins — and the log names it, which is what tells us next run which
      // path Accept UI really requires.
      //
      // fill() is never used on its own: Accept UI is an Angular reactive form
      // that formats and validates off keypress events, and a bare value set
      // leaves the model pristine. Strategy 3 therefore fires those events by
      // hand.
      // -----------------------------------------------------------------
      const fillField = async (inputSelector, value, name) => {
        const input = cardFrame.locator(inputSelector);
        await input.waitFor({ state: "visible", timeout: 30000 });
        await input.scrollIntoViewIfNeeded();

        const readBack = async () =>
          (await input.inputValue().catch(() => "")) || "";

        // Digit count, not equality — the expiry mask inserts "/" and the card
        // number may be space-grouped as it is typed.
        const wanted = value.replace(/\D/g, "").length;
        const filled = async () => {
          const current = await readBack();
          return wanted === 0
            ? current.length > 0
            : current.replace(/\D/g, "").length >= wanted;
        };

        const isFocused = () =>
          cardFrame
            .evaluate((sel) => {
              const el = document.querySelector(sel);
              return el ? document.activeElement === el : false;
            }, inputSelector)
            .catch(() => false);

        // -- Strategy 1: click the input, type into it ---------------------
        try {
          await input.click({ timeout: 10000 });
        } catch (clickError) {
          // An overlaying floating label shows up here as a pointer-event
          // interception; force skips the actionability check and lands it.
          console.log(
            `  ${name}: click intercepted (${clickError.message.split("\n")[0]}) — forcing`,
          );
          await input.click({ force: true, timeout: 10000 }).catch(() => {});
        }
        await input.pressSequentially(value, { delay: 60 }).catch(() => {});

        if (await filled()) {
          console.log(
            `✓ ${name} — value="${await readBack()}" (typed into input, focused=${await isFocused()})`,
          );
          return readBack();
        }

        // -- Strategy 2: focus in-frame, type at page level ----------------
        console.log(
          `  ${name}: empty after typing into the input — retrying via focus() + page.keyboard`,
        );
        await input.evaluate((el) => el.focus()).catch(() => {});
        await page.keyboard.type(value, { delay: 60 });

        if (await filled()) {
          console.log(
            `✓ ${name} — value="${await readBack()}" (page-level keyboard)`,
          );
          return readBack();
        }

        // -- Strategy 3: set the value and fire Angular's events by hand ---
        console.log(
          `  ${name}: still empty — setting value directly and dispatching input/change`,
        );
        await input
          .evaluate((el, v) => {
            el.focus();
            el.value = v;
            el.dispatchEvent(new Event("input", { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
            el.dispatchEvent(new Event("blur", { bubbles: true }));
          }, value)
          .catch(() => {});

        const finalValue = await readBack();
        const classes = (await input.getAttribute("class")) || "";

        if (!finalValue) {
          throw new Error(
            `Authorize.Net: could not enter "${value}" into ${inputSelector} (${name}). ` +
              `All three strategies left it empty. classes="${classes}", ` +
              `focused=${await isFocused()}, frame=${cardFrame.url()}`,
          );
        }

        console.log(
          `✓ ${name} — value="${finalValue}" classes="${classes}" (direct set + events)`,
        );
        return finalValue;
      };

      // -- 1. Card number ------------------------------------------------
      await fillField("#cardNum", CARD_NUMBER, "Card number");

      // -- 2. Expiry -----------------------------------------------------
      // Single combined field, maxlength=5 — the mask inserts "/" as the digits
      // arrive, so only MMYY is typed.
      let expiryValue = await fillField(
        "#expiryDate",
        `${CARD_EXPIRY_MONTH}${CARD_EXPIRY_YEAR}`,
        "Expiry",
      );

      if (!expiryValue.includes("/")) {
        console.log(
          `⚠ Expiry mask did not insert "/" (field reads "${expiryValue}") — retyping with explicit separator`,
        );
        await cardFrame.locator("#expiryDate").fill("");
        expiryValue = await fillField(
          "#expiryDate",
          `${CARD_EXPIRY_MONTH}/${CARD_EXPIRY_YEAR}`,
          "Expiry (retry)",
        );
      }

      // -- 3. Card code --------------------------------------------------
      // Labelled "Card Code", aria-required="false" — this merchant account has
      // CVV optional. Sent anyway, since a reconfigured account starts
      // requiring it without the markup changing.
      await fillField("#cvv", CARD_CVV, "Card code");

      // -- 4/5/6. Billing ------------------------------------------------
      // These inputs carry NO id, so they are reached by name attribute.
      await fillField(
        'input[name="firstName"]',
        BILLING_FIRST_NAME,
        "Billing first name",
      );

      await fillField(
        'input[name="lastName"]',
        BILLING_LAST_NAME,
        "Billing last name",
      );

      await fillField('input[name="zip"]', BILLING_ZIP, "Billing zip");

      // -- Validation confirmation (no clicking — that's submitCardPayment) --
      //
      // aria-invalid, not ng-valid: #cardNum ships ng-valid while completely
      // empty, because no required validator is bound to the Angular control.
      // Accept UI validates separately and reflects the result into
      // aria-invalid alone.
      await cardFrame
        .locator('#cardNum[aria-invalid="false"]')
        .waitFor({ state: "attached", timeout: 30000 })
        .catch(async () => {
          const classes = await cardFrame
            .locator("#cardNum")
            .getAttribute("class");
          const value = await cardFrame.locator("#cardNum").inputValue();
          throw new Error(
            `Authorize.Net card number still reports aria-invalid="true". ` +
              `value="${value}" classes="${classes}". Present but ng-pristine means the ` +
              `keystrokes never reached the Angular model; present AND ng-dirty means the ` +
              `number is outside the sandbox's accepted test set.`,
          );
        });
      console.log('✓ Card number reports aria-invalid="false"');

      // #payButton ships disabled="" and only enables once the whole form
      // validates — same state-gated pattern as PayWay's submit button.
      await cardFrame
        .locator("button#payButton:not([disabled])")
        .waitFor({ state: "visible", timeout: 30000 });
      console.log("✓ Pay button enabled — Accept UI validation complete");

      // Free assertion that the gateway config step pushed our credentials
      // through: Accept UI echoes the public API Login ID into the button.
      // Logged, not thrown, so a mismatch doesn't mask the payment result.
      const injectedLoginId = await cardFrame
        .locator("button#payButton")
        .getAttribute("data-apiloginid")
        .catch(() => null);
      console.log(
        `[config] Accept UI rendered with API Login ID: ${injectedLoginId}`,
      );

      console.log("✓ All card fields filled");
    },

    submitCardPayment: async (page) => {
      console.log("Submitting Authorize.Net card payment...");

      if (await paymentAlreadyCompleted(page)) {
        console.log("✓ Payment already completed — skipping submit");
        return;
      }

      // Re-resolved by content for the same reason as in fillCardDetails, and
      // re-resolved at all because the two are separate entry points — the
      // earlier frame handle is not guaranteed live by the time this runs.
      const resolvePayFrame = async (timeout = 45000) => {
        const deadline = Date.now() + timeout;
        while (Date.now() < deadline) {
          for (const frame of page.frames()) {
            if (frame === page.mainFrame()) continue;
            const count = await frame
              .locator("button#payButton")
              .count()
              .catch(() => 0);
            if (count > 0) {
              console.log(`[scope] Accept UI pay frame: ${frame.url()}`);
              return frame;
            }
          }
          await page.waitForTimeout(500);
        }
        throw new Error(
          `Authorize.Net frame containing button#payButton not found within ${timeout}ms. ` +
            `Frames: ${JSON.stringify(page.frames().map((f) => f.url()))}`,
        );
      };

      const cardFrame = await resolvePayFrame(45000);
      const urlBeforeSubmit = page.url();

      // Selected by STATE, not id alone — the button is disabled until the form
      // validates, so an unqualified #payButton can match a dead element.
      const submitButton = cardFrame.locator(
        "button#payButton:not([disabled])",
      );
      await submitButton.waitFor({ state: "visible", timeout: 30000 });
      console.log(await describeSubmitButtons(page));

      // Attempt 1 — real mouse movement then click.
      try {
        await submitButton.scrollIntoViewIfNeeded();
        await submitButton.hover();
        await submitButton.click({ timeout: 10000 });
        console.log("✓ Pay button clicked (real mouse)");
      } catch (mouseError) {
        console.log(`⚠ Real mouse click failed: ${mouseError.message}`);

        // Attempt 2 — native JS click inside the frame. The disabled attribute
        // is stripped first in case Angular re-applied it after validation.
        try {
          await cardFrame.evaluate(() => {
            const btn = document.querySelector("button#payButton");
            if (!btn)
              throw new Error("button#payButton not in Accept UI document");
            btn.removeAttribute("disabled");
            btn.click();
          });
          console.log("✓ Pay button clicked (native JS)");
        } catch (jsError) {
          console.log(`⚠ Native JS click failed: ${jsError.message}`);

          // Attempt 3 — dispatched event. No requestSubmit() rung here:
          // #payButton is type="button" with no enclosing form, Accept UI
          // tokenises through its own handler.
          await submitButton.dispatchEvent("click");
          console.log("✓ Pay button click dispatched (synthetic event)");
        }
      }

      // Accept UI tokenises client-side, hands the opaque nonce back to the
      // parent WTE form, and THAT form posts to WordPress — so unlike
      // Checkout.com the top-level URL really does change and the shared
      // URL-comparison helper is valid here.
      await waitForSubmissionToTakeEffect(page, urlBeforeSubmit);

      // Surface any inline rejection (declined card, AVS mismatch) before
      // handing back — those keep the iframe open and the URL unchanged, which
      // otherwise reads as a silent timeout.
      const stillOpen = page
        .frames()
        .some((f) => f.url().includes("authorize.net"));
      if (stillOpen) {
        const errorText = await cardFrame
          .locator(".text-danger, .error, [role='alert'], .errorLabelColor")
          .first()
          .textContent({ timeout: 3000 })
          .catch(() => null);
        console.log(
          errorText && errorText.trim()
            ? `⚠ Accept UI still open with error: "${errorText.trim()}"`
            : "⚠ Accept UI still open with no visible error — check test-results screenshot",
        );
      }

      console.log("✓ Card payment submitted");
    },
  },

  GoCardless: {
    fillCardDetails: async (page) => {
      console.log("Filling GoCardless ACH details (full-page redirect)...");

      // The id query param is a per-session billing request token, so only the
      // path prefix is matched.
      await waitForUrlPrefix(
        page,
        "https://pay-sandbox.gocardless.com/billing/static/collect-customer-details",
        60000,
      );
      console.log(`✓ GoCardless customer details URL reached: ${page.url()}`);

      // Non-secret GoCardless sandbox bank details, inlined as constants per
      // house convention rather than pushed into .env.
      const GIVEN_NAME = "Token";
      const FAMILY_NAME = "Tutorial";
      const ADDRESS_LINE1 = "123 Main St";
      const CITY = "New York";
      const POSTAL_CODE = "10001";
      const BANK_CODE = "026073150";
      const ACCOUNT_NUMBER = "2715500356";
      const ACCOUNT_TYPE = "checking";

      // -----------------------------------------------------------------
      // Resolves whichever frame owns a marker element, main frame included.
      // Returns null on timeout rather than throwing, so callers can dump
      // diagnostics before deciding what the failure means.
      // -----------------------------------------------------------------
      const resolveContext = async (marker, label, timeout = 45000) => {
        const deadline = Date.now() + timeout;
        while (Date.now() < deadline) {
          for (const frame of page.frames()) {
            const count = await frame
              .locator(marker)
              .count()
              .catch(() => 0);
            if (count > 0) {
              const where =
                frame === page.mainFrame() ? "main frame" : frame.url();
              console.log(`[scope] ${label} found in: ${where}`);
              return frame;
            }
          }
          await page.waitForTimeout(500);
        }
        return null;
      };

      // Dumps every field in every frame. Used when a step fails to render or
      // Continue fails to advance — on this flow that almost always means a
      // required field that wasn't in the markup we were given.
      const dumpForm = async (stage) => {
        console.log(`[diag] --- ${stage} ---`);
        console.log(`[diag] URL: ${page.url()}`);
        console.log(
          `[diag] Frames: ${JSON.stringify(page.frames().map((f) => f.url()))}`,
        );

        for (const frame of page.frames()) {
          const fields = await frame
            .evaluate(() =>
              Array.from(document.querySelectorAll("input, select")).map(
                (el) => ({
                  tag: el.tagName.toLowerCase(),
                  id: el.id || null,
                  name: el.getAttribute("name") || null,
                  autocomplete: el.getAttribute("autocomplete") || null,
                  testid: el.getAttribute("data-testid") || null,
                  type: el.getAttribute("type") || null,
                  required:
                    el.required || el.getAttribute("aria-required") === "true",
                  empty: !el.value,
                  visible: !!(el.offsetWidth || el.offsetHeight),
                }),
              ),
            )
            .catch(() => "(unreadable)");
          const where = frame === page.mainFrame() ? "main frame" : frame.url();
          console.log(`[diag] fields in ${where}: ${JSON.stringify(fields)}`);
        }

        const errors = await page
          .evaluate(() =>
            Array.from(
              document.querySelectorAll(
                '[role="alert"], [aria-invalid="true"]',
              ),
            ).map(
              (el) => el.textContent.trim() || el.getAttribute("name") || el.id,
            ),
          )
          .catch(() => []);
        console.log(`[diag] errors/invalid: ${JSON.stringify(errors)}`);
      };

      // -----------------------------------------------------------------
      // waitForUrlPrefix returns the moment the URL matches, but GoCardless is
      // a React app — a previous run resolved the URL and then found
      // #given_name absent because the form had not mounted yet. So every field
      // waits for its own element rather than testing count() immediately.
      //
      // Each field takes a comma-OR selector: id, then name, then autocomplete.
      // A single id is a single point of failure across GoCardless deploys, and
      // the autocomplete tokens are spec-defined so they outlast both.
      // -----------------------------------------------------------------
      const typeInto = async (ctx, selector, value, label, required = true) => {
        const field = ctx.locator(selector).first();

        try {
          await field.waitFor({
            state: "visible",
            timeout: required ? 30000 : 5000,
          });
        } catch (err) {
          if (required) {
            await dumpForm(`${label} not found`);
            throw new Error(
              `GoCardless ${label} ("${selector}") never rendered on ${page.url()}. ` +
                `See the [diag] field dump above for the attributes actually present.`,
            );
          }
          console.log(`  ${label}: not present on this form — skipped`);
          return false;
        }

        await field.click();
        await field.pressSequentially(value, { delay: 40 });
        const actual = await field.inputValue();
        console.log(`✓ ${label} filled — value="${actual}"`);
        return true;
      };

      // Both Continue buttons are byte-identical (button[type="submit"] wrapping
      // a "Continue" span, same Emotion hash), so they cannot be distinguished
      // by selector — only by which step is currently rendered. Advancement is
      // therefore detected by the NEXT step's marker appearing, never by the
      // button itself.
      const clickContinue = async (ctx, stepLabel) => {
        const continueButton = ctx
          .locator('button[type="submit"]')
          .filter({ hasText: /Continue/i })
          .first();

        await continueButton.waitFor({ state: "visible", timeout: 30000 });
        await continueButton.scrollIntoViewIfNeeded();

        try {
          await continueButton.click({ timeout: 10000 });
          console.log(`✓ Continue clicked (${stepLabel}, real mouse)`);
        } catch (mouseError) {
          console.log(
            `⚠ Continue real mouse click failed: ${mouseError.message}`,
          );
          try {
            await continueButton.evaluate((btn) => btn.click());
            console.log(`✓ Continue clicked (${stepLabel}, native JS)`);
          } catch (jsError) {
            console.log(`⚠ Native JS click failed: ${jsError.message}`);
            await continueButton.evaluate((btn) => {
              const form = btn.closest("form");
              if (!form) throw new Error("Continue button has no owning form");
              form.requestSubmit ? form.requestSubmit() : form.submit();
            });
            console.log(`✓ Continue submitted (${stepLabel}, requestSubmit)`);
          }
        }
      };

      // ==================================================================
      // STEP 1 — Customer details
      // ==================================================================
      console.log("--- Step 1: customer details ---");

      // Waits for the React form to actually mount before touching anything.
      const givenNameSelector =
        '#given_name, [name="given_name"], input[autocomplete="given-name"]';
      let ctx = await resolveContext(givenNameSelector, "Step 1 form", 60000);

      if (!ctx) {
        await dumpForm("step 1 form never mounted");
        throw new Error(
          `GoCardless step 1 form (${givenNameSelector}) never mounted within 60s. ` +
            `URL: ${page.url()}. The URL resolved but the React app did not render the ` +
            `fields — see the [diag] dump above.`,
        );
      }

      await typeInto(ctx, givenNameSelector, GIVEN_NAME, "Given name");
      await typeInto(
        ctx,
        '#family_name, [name="family_name"], input[autocomplete="family-name"]',
        FAMILY_NAME,
        "Family name",
      );
      await typeInto(
        ctx,
        '#address_line1, [name="address_line1"], input[autocomplete="address-line1"]',
        ADDRESS_LINE1,
        "Address line 1",
      );
      await typeInto(
        ctx,
        '#city, [name="city"], input[autocomplete="address-level2"]',
        CITY,
        "City",
      );
      await typeInto(
        ctx,
        '#postal_code, [name="postal_code"], input[autocomplete="postal-code"]',
        POSTAL_CODE,
        "Postal code",
      );

      // Email deliberately NOT filled — GoCardless carries it through from the
      // billing request, and pressSequentially appends rather than replaces, so
      // typing into a prefilled field would mangle the address.

      // Region/state/country is sometimes a select, sometimes free text. Only
      // reported here — a required one left blank shows up in the pre-flight
      // dump below as required:true empty:true.
      const regionSelect = ctx.locator(
        'select[name="region"], select[name="state"], select[name="country_code"]',
      );
      if ((await regionSelect.count().catch(() => 0)) > 0) {
        const optionCount = await regionSelect
          .first()
          .locator("option")
          .count();
        console.log(
          `  Region/country select present with ${optionCount} options`,
        );
      }

      // Pre-flight: report anything still empty BEFORE clicking, so a stalled
      // Continue is explainable from the same run.
      await dumpForm("step 1 state before Continue");

      await clickContinue(ctx, "step 1");

      // ==================================================================
      // STEP 2 — Bank details
      // ==================================================================
      // Advancement detected by the step-2 marker, not by the button. Re-resolved
      // because a step change can remount the form in a different context.
      console.log("--- Step 2: bank details ---");

      const bankCodeSelector =
        '[data-testid="bank_code"], #bank_code, [name="bank_code"]';
      ctx = await resolveContext(bankCodeSelector, "Step 2 form", 45000);

      if (!ctx) {
        await dumpForm("step 2 never rendered");
        throw new Error(
          `GoCardless bank details step did not render after Continue. URL: ${page.url()}. ` +
            `See the [diag] field dump above — an empty required field on step 1 will ` +
            `silently block advancement.`,
        );
      }
      console.log("✓ Bank details step reached");

      await typeInto(ctx, bankCodeSelector, BANK_CODE, "Routing number");
      await typeInto(
        ctx,
        '[data-testid="account_number"], #account_number, [name="account_number"]',
        ACCOUNT_NUMBER,
        "Account number",
      );

      // selectOption by VALUE, not label — the visible label is
      // "Checking (Most common)" but the option value is bare "checking", and
      // the label text is the more likely of the two to be reworded.
      const accountTypeSelect = ctx.locator('select[name="account_type"]');
      await accountTypeSelect.waitFor({ state: "visible", timeout: 30000 });
      await accountTypeSelect.selectOption(ACCOUNT_TYPE);
      console.log(`✓ Account type selected: ${ACCOUNT_TYPE}`);

      const selectedValue = await accountTypeSelect.inputValue();
      if (selectedValue !== ACCOUNT_TYPE) {
        throw new Error(
          `GoCardless account type did not take — reads "${selectedValue}", expected "${ACCOUNT_TYPE}"`,
        );
      }

      await dumpForm("step 2 state before Continue");

      await clickContinue(ctx, "step 2");

      // ==================================================================
      // STEP 3 — Mandate confirmation (reached, not clicked)
      // ==================================================================
      // Only waited for here. The click belongs in submitCardPayment, since
      // confirming the mandate is the authorising action.
      console.log("--- Step 3: mandate confirmation ---");

      const confirmSelector =
        '[data-testid="billing-request.bank-confirm.direct-debit-cta-button"]';
      const confirmCtx = await resolveContext(
        confirmSelector,
        "Step 3 confirm button",
        45000,
      );

      if (!confirmCtx) {
        await dumpForm("step 3 never rendered");
        throw new Error(
          `GoCardless mandate confirmation did not render after step 2. URL: ${page.url()}. ` +
            `See the [diag] dump above — a rejected routing or account number keeps the flow ` +
            `on the bank details step.`,
        );
      }
      console.log("✓ Mandate confirmation step reached");

      console.log("✓ All ACH details filled");
    },

    submitCardPayment: async (page) => {
      console.log("Submitting GoCardless ACH mandate...");

      if (await paymentAlreadyCompleted(page)) {
        console.log("✓ Payment already completed — skipping submit");
        return;
      }

      const urlBeforeSubmit = page.url();
      const confirmSelector =
        '[data-testid="billing-request.bank-confirm.direct-debit-cta-button"]';

      // Resolved by content rather than assumed to be the main frame, matching
      // fillCardDetails — the two are separate entry points.
      const resolveConfirmContext = async (timeout = 45000) => {
        const deadline = Date.now() + timeout;
        while (Date.now() < deadline) {
          for (const frame of page.frames()) {
            const count = await frame
              .locator(confirmSelector)
              .count()
              .catch(() => 0);
            if (count > 0) {
              const where =
                frame === page.mainFrame() ? "main frame" : frame.url();
              console.log(`[scope] Confirm button found in: ${where}`);
              return frame;
            }
          }
          await page.waitForTimeout(500);
        }
        throw new Error(
          `GoCardless confirm button (${confirmSelector}) not found in any frame. ` +
            `URL: ${page.url()}. Frames: ${JSON.stringify(page.frames().map((f) => f.url()))}`,
        );
      };

      const ctx = await resolveConfirmContext(45000);

      // The one genuinely stable selector in this whole flow — an explicit
      // data-testid rather than an Emotion hash.
      const confirmButton = ctx.locator(confirmSelector).first();
      await confirmButton.waitFor({ state: "visible", timeout: 30000 });

      // page, NOT ctx. describeSubmitButtons iterates page.frames() internally,
      // so handing it a Frame throws "page.frames is not a function".
      await describeSubmitButtons(page, 'button[type="submit"]');

      // Attempt 1 — real mouse movement then click.
      try {
        await confirmButton.scrollIntoViewIfNeeded();
        await confirmButton.hover();
        await confirmButton.click({ timeout: 10000 });
        console.log("✓ ACH authorization confirmed (real mouse)");
      } catch (mouseError) {
        console.log(`⚠ Real mouse click failed: ${mouseError.message}`);

        // Attempt 2 — native JS click.
        try {
          await confirmButton.evaluate((btn) => btn.click());
          console.log("✓ ACH authorization confirmed (native JS)");
        } catch (jsError) {
          console.log(`⚠ Native JS click failed: ${jsError.message}`);

          // Attempt 3 — requestSubmit on the owning form. Valid here: this is a
          // real type="submit" inside a form, unlike Midtrans's or
          // Authorize.Net's type="button" pay buttons.
          await confirmButton.evaluate((btn) => {
            const form = btn.closest("form");
            if (!form) throw new Error("Confirm button has no owning form");
            form.requestSubmit ? form.requestSubmit() : form.submit();
          });
          console.log("✓ ACH authorization submitted (requestSubmit)");
        }
      }

      // GoCardless redirects back to the WTE return URL once the mandate is
      // created, so the top-level URL genuinely changes and the shared
      // URL-comparison helper is valid here.
      await waitForSubmissionToTakeEffect(page, urlBeforeSubmit);

      // Surface a stall — a rejected mandate keeps the flow on
      // pay-sandbox.gocardless.com, which otherwise reads as a silent timeout.
      if (page.url().includes("gocardless.com")) {
        const errorText = await page
          .locator('[role="alert"], [aria-invalid="true"]')
          .first()
          .textContent({ timeout: 3000 })
          .catch(() => null);
        console.log(
          errorText && errorText.trim()
            ? `⚠ Still on GoCardless with error: "${errorText.trim()}"`
            : `⚠ Still on GoCardless with no visible error — URL: ${page.url()}`,
        );
      }

      console.log("✓ ACH mandate submitted");
    },
  },

  Midtrans: {
    fillCardDetails: async (page) => {
      console.log("Filling Midtrans card details (Snap popup iframe)...");

      // Fixed test card. NOTE the deviation from the suite default
      // 4564710000000004 — Midtrans's sandbox only approves cards from its own
      // published set, and 4811111111111114 is its documented 3DS-success Visa.
      // Expiry MONTH fixed, YEAR computed (current year + 3).
      const CARD_NUMBER = "4811111111111114";
      const CARD_CVV = "123";
      const CARD_EXPIRY_MONTH = "02";
      const CARD_EXPIRY_YEAR = String(new Date().getFullYear() + 3).slice(-2);

      // Midtrans sandbox 3DS OTP. Only used if the challenge actually appears.
      const THREEDS_OTP = "112233";

      console.log(`Using fixed test card ending in ${CARD_NUMBER.slice(-4)}`);
      console.log(`Expiry to enter: ${CARD_EXPIRY_MONTH}/${CARD_EXPIRY_YEAR}`);

      // -----------------------------------------------------------------
      // Resolves whichever frame owns a marker element. page.frames() puts the
      // main frame at index 0, so one loop covers the popup iframe, any nested
      // frame, and the top-level document without committing to any of them.
      // -----------------------------------------------------------------
      const resolveContext = async (marker, label, timeout = 60000) => {
        const deadline = Date.now() + timeout;
        while (Date.now() < deadline) {
          for (const frame of page.frames()) {
            const count = await frame
              .locator(marker)
              .count()
              .catch(() => 0);
            if (count > 0) {
              const where =
                frame === page.mainFrame() ? "main frame" : frame.url();
              console.log(`[scope] ${label} (${marker}) found in: ${where}`);
              return frame;
            }
          }
          await page.waitForTimeout(500);
        }
        return null;
      };

      const dumpState = async (stage) => {
        console.log(`[diag] --- ${stage} ---`);
        console.log(`[diag] URL: ${page.url()}`);
        console.log(
          `[diag] Frames: ${JSON.stringify(page.frames().map((f) => f.url()))}`,
        );
        for (const frame of page.frames()) {
          const inputs = await frame
            .evaluate(() =>
              Array.from(document.querySelectorAll("input")).map((el) => ({
                id: el.id || null,
                autocomplete: el.getAttribute("autocomplete") || null,
                placeholder: el.getAttribute("placeholder") || null,
                type: el.type,
                className: el.className || null,
              })),
            )
            .catch(() => "(unreadable)");
          const where = frame === page.mainFrame() ? "main frame" : frame.url();
          console.log(`[diag] inputs in ${where}: ${JSON.stringify(inputs)}`);
        }
      };

      // -- 1. Resolve the Snap popup and pick Card Payment -----------------
      // Located by the method link itself rather than by URL: Snap is served
      // from a snap.midtrans.com path with a session token, and the hash route
      // means the URL is identical before and after the card form opens.
      const methodSelector = 'a[data-testid="list-item"][href="#/credit-card"]';
      const snapFrame = await resolveContext(
        methodSelector,
        "Snap method list",
        60000,
      );

      if (!snapFrame) {
        await dumpState("Snap method list not found");
        throw new Error(
          `Midtrans Snap popup containing ${methodSelector} not found. URL: ${page.url()}. ` +
            `Frames: ${JSON.stringify(page.frames().map((f) => f.url()))}`,
        );
      }

      // The href is a hash route, so this is a real anchor and clicking it
      // directly is correct — no clickable-ancestor hunt needed the way Mollie
      // needed one for its bare <span> rows.
      const cardMethod = snapFrame.locator(methodSelector);
      await cardMethod.waitFor({ state: "visible", timeout: 30000 });
      await cardMethod.scrollIntoViewIfNeeded();
      await cardMethod.click();
      console.log("✓ Card Payment method clicked");

      // -- 2. Resolve the card form ----------------------------------------
      // Hash routing means the frame URL is unchanged, so the form is detected
      // by its own field appearing. Snap renders the card fields in the same
      // frame as the method list, but this is resolved rather than assumed in
      // case a future Snap version nests them.
      const numberSelector = 'input[autocomplete="cc-number"]';
      let ctx = await resolveContext(numberSelector, "Card form", 45000);

      if (!ctx) {
        console.log("⚠ Card form not found — retrying the method click");
        await dumpState("card form missing, before retry");
        await cardMethod.click({ force: true }).catch((err) => {
          console.log(`⚠ Forced method click failed: ${err.message}`);
        });
        await page.waitForTimeout(2000);
        ctx = await resolveContext(numberSelector, "Card form (retry)", 30000);
      }

      if (!ctx) {
        await dumpState("card form missing, after retry");
        throw new Error(
          `Midtrans card form (${numberSelector}) not found after selecting Card Payment. ` +
            `URL: ${page.url()}. See the [diag] input dumps above.`,
        );
      }

      // -----------------------------------------------------------------
      // All three fields are targeted by AUTOCOMPLETE, not id.
      //
      // The card number input has no id and no name at all — autocomplete is
      // the only handle on it. The expiry markup showed id "card-expiry"
      // appearing TWICE, so an id selector there would be ambiguous and trip
      // strict mode the way PayWay's duplicated #payway-submit-button does.
      // (#card-cvv does appear unique, but autocomplete is used uniformly for
      // consistency and because it survives Snap renaming its ids.)
      //
      // pressSequentially rather than fill() throughout: the number groups
      // itself into blocks of four and the expiry inserts its own "/", both
      // driven by input events that fill() does not produce.
      // -----------------------------------------------------------------

      // -- 3. Card number -------------------------------------------------
      const cardNumberInput = ctx.locator(numberSelector).first();
      await cardNumberInput.waitFor({ state: "visible", timeout: 30000 });
      await cardNumberInput.click();
      await cardNumberInput.pressSequentially(CARD_NUMBER, { delay: 60 });
      console.log(
        `✓ Card number filled — value="${await cardNumberInput.inputValue()}"`,
      );

      // -- 4. Expiry ------------------------------------------------------
      // Placeholder "MM/YY" — no spaces around the separator, unlike Mollie's
      // "MM / YY". Only digits are typed and the result is verified, because a
      // mask that didn't fire leaves "0229" in a field Snap rejects.
      const expiryInput = ctx.locator('input[autocomplete="cc-exp"]').first();
      await expiryInput.waitFor({ state: "visible", timeout: 30000 });
      await expiryInput.click();
      await expiryInput.pressSequentially(
        `${CARD_EXPIRY_MONTH}${CARD_EXPIRY_YEAR}`,
        { delay: 80 },
      );

      let expiryValue = await expiryInput.inputValue();
      if (!expiryValue.includes("/")) {
        console.log(
          `⚠ Expiry mask did not insert "/" (field reads "${expiryValue}") — retyping explicitly`,
        );
        await expiryInput.fill("");
        await expiryInput.click();
        await expiryInput.pressSequentially(
          `${CARD_EXPIRY_MONTH}/${CARD_EXPIRY_YEAR}`,
          { delay: 80 },
        );
        expiryValue = await expiryInput.inputValue();
      }
      console.log(`✓ Expiry filled — value="${expiryValue}"`);

      // -- 5. CVV ---------------------------------------------------------
      // CONFIRMED markup: id="card-cvv" autocomplete="cc-csc" type="password".
      // The password type does NOT hide the value from Playwright —
      // inputValue() returns real content, same as eWAY's CVV field, so the
      // verification below works and does not need a reveal-toggle workaround
      // like Culqi's masked fields.
      const cvvInput = ctx.locator('input[autocomplete="cc-csc"]').first();
      await cvvInput.waitFor({ state: "visible", timeout: 30000 });
      await cvvInput.click();
      await cvvInput.pressSequentially(CARD_CVV, { delay: 60 });
      console.log(`✓ CVV filled — value="${await cvvInput.inputValue()}"`);

      // -- Validation confirmation (no clicking — that's submitCardPayment) --
      //
      // Snap toggles a per-field validation class. Note the POLARITY: the
      // number and expiry both carry "valid-input-value" while still EMPTY, so
      // that class is the neutral default and is NOT proof of a fill. The
      // meaningful signal is the ABSENCE of "invalid-input-value", which Snap
      // adds once a field has been touched and failed. So both are checked:
      // value present, and not flagged invalid.
      const fields = [
        [numberSelector, "Card number"],
        ['input[autocomplete="cc-exp"]', "Expiry"],
        ['input[autocomplete="cc-csc"]', "CVV"],
      ];

      for (const [selector, label] of fields) {
        const field = ctx.locator(selector).first();
        const value = await field.inputValue();
        const classes = (await field.getAttribute("class")) || "";

        if (!value || value.trim().length === 0) {
          throw new Error(
            `Midtrans ${label} ("${selector}") is empty after fill — keystrokes did not land.`,
          );
        }
        if (classes.includes("invalid-input-value")) {
          throw new Error(
            `Midtrans ${label} ("${selector}") is flagged invalid-input-value after fill. ` +
              `value="${value}" classes="${classes}". A populated but rejected field usually ` +
              `means the card number is outside the sandbox's accepted test set, or the expiry ` +
              `mask produced an unparseable value.`,
          );
        }
        console.log(`  ${label}: value="${value}" classes="${classes}"`);
      }
      console.log("✓ All card fields hold values and none flagged invalid");

      // Stashed so submitCardPayment can reuse the OTP without redeclaring it.
      page.__midtransOtp = THREEDS_OTP;

      console.log("✓ All card fields filled");
    },

    submitCardPayment: async (page) => {
      console.log("Submitting Midtrans card payment...");

      if (await paymentAlreadyCompleted(page)) {
        console.log("✓ Payment already completed — skipping submit");
        return;
      }

      const urlBeforeSubmit = page.url();
      const THREEDS_OTP = page.__midtransOtp || "112233";

      // Resolved by content, matching fillCardDetails — the Pay now button is
      // inside the Snap popup frame, not the top-level document.
      const resolvePayContext = async (timeout = 45000) => {
        const deadline = Date.now() + timeout;
        while (Date.now() < deadline) {
          for (const frame of page.frames()) {
            const count = await frame
              .locator("button.btn-theme")
              .filter({ hasText: /Pay now/i })
              .count()
              .catch(() => 0);
            if (count > 0) {
              const where =
                frame === page.mainFrame() ? "main frame" : frame.url();
              console.log(`[scope] Pay now button found in: ${where}`);
              return frame;
            }
          }
          await page.waitForTimeout(500);
        }
        throw new Error(
          `Midtrans "Pay now" button not found in any frame. URL: ${page.url()}. ` +
            `Frames: ${JSON.stringify(page.frames().map((f) => f.url()))}`,
        );
      };

      const ctx = await resolvePayContext(45000);

      // Matched on text plus the single stable class. The full class attribute
      // is "btn full primary  btn-theme" — note the DOUBLE SPACE before
      // btn-theme, which makes a chained .btn.full.primary.btn-theme selector
      // fragile to whitespace handling; text is the reliable discriminator.
      const payButton = ctx
        .locator("button.btn-theme")
        .filter({ hasText: /Pay now/i })
        .first();
      await payButton.waitFor({ state: "visible", timeout: 30000 });

      // page, NOT ctx. describeSubmitButtons iterates page.frames() internally,
      // so handing it a Frame throws "page.frames is not a function". It walks
      // every frame itself, so the in-iframe buttons still get reported.
      await describeSubmitButtons(page, "button.btn-theme");

      // Attempt 1 — real mouse movement then click.
      try {
        await payButton.scrollIntoViewIfNeeded();
        await payButton.hover();
        await payButton.click({ timeout: 10000 });
        console.log("✓ Pay now clicked (real mouse)");
      } catch (mouseError) {
        console.log(`⚠ Real mouse click failed: ${mouseError.message}`);

        // Attempt 2 — native JS click.
        try {
          await payButton.evaluate((btn) => btn.click());
          console.log("✓ Pay now clicked (native JS)");
        } catch (jsError) {
          console.log(`⚠ Native JS click failed: ${jsError.message}`);

          // Attempt 3 — dispatched event. No requestSubmit() rung: this is a
          // type="button" with no owning form, same as Authorize.Net's
          // #payButton, so form submission is not the mechanism here.
          await payButton.dispatchEvent("click");
          console.log("✓ Pay now click dispatched (synthetic event)");
        }
      }

      // -- Conditional 3DS challenge ---------------------------------------
      // Polled briefly and SKIPPED if absent, following the MyFatoorah pattern
      // — not every sandbox card or profile triggers a challenge, and a long
      // fixed wait here would add a minute to every green run.
      const otpSelectors = [
        'input[name="otp"]',
        'input[name="OTP"]',
        "#otp",
        'input[type="tel"][maxlength="6"]',
        'input[autocomplete="one-time-code"]',
      ].join(", ");

      let otpCtx = null;
      const otpDeadline = Date.now() + 20000;
      while (Date.now() < otpDeadline && !otpCtx) {
        for (const frame of page.frames()) {
          const count = await frame
            .locator(otpSelectors)
            .count()
            .catch(() => 0);
          if (count > 0) {
            otpCtx = frame;
            console.log(`[scope] 3DS OTP field found in: ${frame.url()}`);
            break;
          }
        }
        if (!otpCtx) await page.waitForTimeout(1000);
      }

      if (otpCtx) {
        const otpInput = otpCtx.locator(otpSelectors).first();
        await otpInput.click();
        await otpInput.pressSequentially(THREEDS_OTP, { delay: 80 });
        console.log("✓ 3DS OTP entered");

        // Submit label varies across Midtrans's ACS templates, so several are
        // accepted. Skipped if none is present — some templates auto-submit
        // once the OTP length is satisfied.
        const otpSubmit = otpCtx
          .locator('button, input[type="submit"]')
          .filter({ hasText: /OK|Submit|Continue|Verify|Pay/i })
          .first();

        if ((await otpSubmit.count().catch(() => 0)) > 0) {
          await otpSubmit.click().catch(async (err) => {
            console.log(
              `⚠ OTP submit click failed: ${err.message} — trying native JS`,
            );
            await otpSubmit.evaluate((btn) => btn.click());
          });
          console.log("✓ 3DS OTP submitted");
        } else {
          console.log(
            "⚠ No OTP submit button — assuming auto-submit on length",
          );
        }
      } else {
        console.log("✓ No 3DS challenge appeared within 20s — continuing");
      }

      // Snap closes and returns to the WTE finish URL, so the top-level URL
      // genuinely changes and the shared URL-comparison helper is valid here.
      await waitForSubmissionToTakeEffect(page, urlBeforeSubmit);

      // Surface a stall — a declined card keeps Snap open with the URL
      // unchanged, which otherwise reads as a silent timeout.
      const snapStillOpen = page
        .frames()
        .some((f) => (f.url() || "").includes("midtrans.com"));
      if (snapStillOpen) {
        const errorText = await ctx
          .locator('.error, .alert, [role="alert"], .text-error')
          .first()
          .textContent({ timeout: 3000 })
          .catch(() => null);
        console.log(
          errorText && errorText.trim()
            ? `⚠ Snap still open with error: "${errorText.trim()}"`
            : `⚠ Snap still open with no visible error — URL: ${page.url()}`,
        );
      }

      console.log("✓ Card payment submitted");
    },
  },

  Moyasar: {
    fillCardDetails: async (page) => {
      console.log("Filling Moyasar card details...");

      // Fixed test card. 4111111111111111 is Moyasar's documented success card.
      // Expiry MONTH fixed, YEAR computed (current year + 3).
      const CARD_NUMBER = "4111111111111111";
      const CARD_CVV = "123";
      const CARD_HOLDER = "Token Tutorial";
      const CARD_EXPIRY_MONTH = "02";
      const CARD_EXPIRY_YEAR = String(new Date().getFullYear() + 3).slice(-2);

      console.log(`Using fixed test card ending in ${CARD_NUMBER.slice(-4)}`);
      console.log(`Expiry to enter: ${CARD_EXPIRY_MONTH}/${CARD_EXPIRY_YEAR}`);

      // -----------------------------------------------------------------
      // Resolves whichever frame owns a marker element, main frame included.
      // page.frames() puts the main frame at index 0, so one loop covers both
      // the inline and iframe-embedded variants of the Moyasar form.
      // -----------------------------------------------------------------
      const resolveContext = async (marker, label, timeout = 60000) => {
        const deadline = Date.now() + timeout;
        while (Date.now() < deadline) {
          for (const frame of page.frames()) {
            const count = await frame
              .locator(marker)
              .count()
              .catch(() => 0);
            if (count > 0) {
              const where =
                frame === page.mainFrame() ? "main frame" : frame.url();
              console.log(`[scope] ${label} found in: ${where}`);
              return frame;
            }
          }
          await page.waitForTimeout(500);
        }
        return null;
      };

      const dumpForm = async (stage) => {
        console.log(`[diag] --- ${stage} ---`);
        console.log(`[diag] URL: ${page.url()}`);
        console.log(
          `[diag] Frames: ${JSON.stringify(page.frames().map((f) => f.url()))}`,
        );
        for (const frame of page.frames()) {
          const fields = await frame
            .evaluate(() =>
              Array.from(document.querySelectorAll("input")).map((el) => ({
                id: el.id || null,
                name: el.getAttribute("name") || null,
                autocomplete: el.getAttribute("autocomplete") || null,
                maska: el.getAttribute("data-maska") || null,
                type: el.getAttribute("type") || null,
                empty: !el.value,
              })),
            )
            .catch(() => "(unreadable)");
          const where = frame === page.mainFrame() ? "main frame" : frame.url();
          console.log(`[diag] inputs in ${where}: ${JSON.stringify(fields)}`);
        }
      };

      const ctx = await resolveContext(
        "#mysr-cc-name",
        "Moyasar card form",
        60000,
      );

      if (!ctx) {
        await dumpForm("Moyasar form never rendered");
        throw new Error(
          `Moyasar card form (#mysr-cc-name) not found in any frame. URL: ${page.url()}. ` +
            `See the [diag] dumps above.`,
        );
      }

      // Currency sanity check. The Pay button embeds the currency as an <img alt>
      // plus the formatted amount, so this confirms the WTE currency-switch step
      // actually took effect before any card data is entered. Logged, not thrown.
      const currencyAlt = await ctx
        .locator("button[type='submit'] .currency-amount img")
        .getAttribute("alt")
        .catch(() => null);
      const amountText = await ctx
        .locator("button[type='submit'] .currency-amount span")
        .textContent()
        .catch(() => null);
      console.log(
        `[config] Moyasar rendering currency="${currencyAlt}" amount="${amountText}"`,
      );

      // pressSequentially rather than fill() throughout: the number groups into
      // blocks of four and the expiry runs through maska, both driven by input
      // events that fill() does not produce.
      //
      // Every field is clicked immediately before typing, matching the order
      // given: name → number → expiry → CVC.

      // -- 1. Name on card -------------------------------------------------
      const nameInput = ctx.locator("#mysr-cc-name");
      await nameInput.waitFor({ state: "visible", timeout: 30000 });
      await nameInput.click();
      await nameInput.pressSequentially(CARD_HOLDER, { delay: 40 });
      console.log(
        `✓ Name on card filled — value="${await nameInput.inputValue()}"`,
      );

      // -- 2. Card number --------------------------------------------------
      const cardNumberInput = ctx.locator("#mysr-cc-number");
      await cardNumberInput.waitFor({ state: "visible", timeout: 30000 });
      await cardNumberInput.click();
      await cardNumberInput.pressSequentially(CARD_NUMBER, { delay: 60 });
      console.log(
        `✓ Card number filled — value="${await cardNumberInput.inputValue()}"`,
      );

      // -- 3. Expiry -------------------------------------------------------
      // data-maska="** / **" with data-maska-eager="true" and maxlength=7, so
      // the mask inserts " / " WITH SPACES as digits arrive — only MMYY is
      // typed. Eager masking applies the separator immediately rather than
      // waiting for the next keystroke, so the value is checked after.
      const expiryInput = ctx.locator("#mysr-cc-exp");
      await expiryInput.waitFor({ state: "visible", timeout: 30000 });
      await expiryInput.click();
      await expiryInput.pressSequentially(
        `${CARD_EXPIRY_MONTH}${CARD_EXPIRY_YEAR}`,
        { delay: 80 },
      );

      let expiryValue = await expiryInput.inputValue();
      if (!expiryValue.includes("/")) {
        console.log(
          `⚠ maska did not insert a separator (field reads "${expiryValue}") — retyping explicitly`,
        );
        await expiryInput.fill("");
        await expiryInput.click();
        await expiryInput.pressSequentially(
          `${CARD_EXPIRY_MONTH} / ${CARD_EXPIRY_YEAR}`,
          { delay: 80 },
        );
        expiryValue = await expiryInput.inputValue();
      }
      console.log(`✓ Expiry filled — value="${expiryValue}"`);

      // -- 4. CVC ----------------------------------------------------------
      // CONFIRMED markup: id="mysr-cc-csc" autocomplete="cc-csc" maxlength="3".
      // The id follows the cc-csc autocomplete token, NOT "cvc" — worth noting
      // since the visible placeholder and aria-label both read "CVC".
      // maxlength=3 means the suite's 3-digit code fits with no truncation.
      const cvvInput = ctx.locator("#mysr-cc-csc");
      await cvvInput.waitFor({ state: "visible", timeout: 30000 });
      await cvvInput.click();
      await cvvInput.pressSequentially(CARD_CVV, { delay: 60 });
      console.log(`✓ CVC filled — value="${await cvvInput.inputValue()}"`);

      // -- Validation confirmation (no clicking — that's submitCardPayment) --
      //
      // Two signals available on this form. Value presence is the hard check.
      // The class "shadow-input-error" is Moyasar's per-field error state — both
      // the name and CVC fields carried it while empty in the supplied markup —
      // so its ABSENCE after a fill is a useful secondary check. Note the same
      // polarity trap as Midtrans: the error class only appears after a field
      // has been touched and failed, so it is not proof of a fill on its own.
      const fields = [
        ["#mysr-cc-name", "Name on card"],
        ["#mysr-cc-number", "Card number"],
        ["#mysr-cc-exp", "Expiry"],
        ["#mysr-cc-csc", "CVC"],
      ];

      for (const [selector, label] of fields) {
        const field = ctx.locator(selector).first();
        const value = await field.inputValue();
        const classes = (await field.getAttribute("class")) || "";

        if (!value || value.trim().length === 0) {
          throw new Error(
            `Moyasar ${label} ("${selector}") is empty after fill — keystrokes did not land.`,
          );
        }
        if (classes.includes("shadow-input-error")) {
          console.log(
            `⚠ ${label} still carries shadow-input-error after fill — value="${value}"`,
          );
        }
        console.log(`  ${label}: value="${value}"`);
      }
      console.log("✓ All card fields hold values");

      console.log("✓ All card fields filled");
    },

    submitCardPayment: async (page) => {
      console.log("Submitting Moyasar card payment...");

      if (await paymentAlreadyCompleted(page)) {
        console.log("✓ Payment already completed — skipping submit");
        return;
      }

      const urlBeforeSubmit = page.url();

      // Resolved by content, matching fillCardDetails.
      const resolvePayContext = async (timeout = 45000) => {
        const deadline = Date.now() + timeout;
        while (Date.now() < deadline) {
          for (const frame of page.frames()) {
            const count = await frame
              .locator('button[type="submit"]')
              .filter({ hasText: /Pay/i })
              .count()
              .catch(() => 0);
            if (count > 0) {
              const where =
                frame === page.mainFrame() ? "main frame" : frame.url();
              console.log(`[scope] Pay button found in: ${where}`);
              return frame;
            }
          }
          await page.waitForTimeout(500);
        }
        throw new Error(
          `Moyasar Pay button not found in any frame. URL: ${page.url()}. ` +
            `Frames: ${JSON.stringify(page.frames().map((f) => f.url()))}`,
        );
      };

      const ctx = await resolvePayContext(45000);

      // -- 1. Pay ----------------------------------------------------------
      // BUTTON, not input — matched on tag + text. Two reasons the tag matters:
      // the Tailwind class chain on this element is far too volatile to select
      // on, and the 3DS simulator later in this flow uses an
      // input[type="submit"], so a bare [type="submit"] selector would be
      // ambiguous across the two steps.
      const payButton = ctx
        .locator('button[type="submit"]')
        .filter({ hasText: /Pay/i })
        .first();
      await payButton.waitFor({ state: "visible", timeout: 30000 });

      // page, NOT ctx. describeSubmitButtons iterates page.frames() internally,
      // so handing it a Frame throws "page.frames is not a function".
      await describeSubmitButtons(page, 'button[type="submit"]');

      // Attempt 1 — real mouse movement then click.
      try {
        await payButton.scrollIntoViewIfNeeded();
        await payButton.hover();
        await payButton.click({ timeout: 10000 });
        console.log("✓ Pay clicked (real mouse)");
      } catch (mouseError) {
        console.log(`⚠ Real mouse click failed: ${mouseError.message}`);

        // Attempt 2 — native JS click.
        try {
          await payButton.evaluate((btn) => btn.click());
          console.log("✓ Pay clicked (native JS)");
        } catch (jsError) {
          console.log(`⚠ Native JS click failed: ${jsError.message}`);

          // Attempt 3 — requestSubmit on the owning form. Valid here: this is a
          // real type="submit" inside a form.
          await payButton.evaluate((btn) => {
            const form = btn.closest("form");
            if (!form) throw new Error("Pay button has no owning form");
            form.requestSubmit ? form.requestSubmit() : form.submit();
          });
          console.log("✓ Pay submitted (requestSubmit)");
        }
      }

      // -- 2. Test 3DS simulator -------------------------------------------
      // Moyasar test mode interposes an ACS page whose only control is a bare
      // input[type="submit"][value="Submit"]. Resolved across frames because
      // ACS pages are commonly iframed.
      //
      // Polled and skipped if absent, following the MyFatoorah pattern — a
      // non-3DS card or a changed test profile would otherwise stall here.
      const simulatorSelector = 'input[type="submit"][value="Submit"]';
      let simCtx = null;
      const simDeadline = Date.now() + 45000;

      while (Date.now() < simDeadline && !simCtx) {
        for (const frame of page.frames()) {
          const count = await frame
            .locator(simulatorSelector)
            .count()
            .catch(() => 0);
          if (count > 0) {
            simCtx = frame;
            const where =
              frame === page.mainFrame() ? "main frame" : frame.url();
            console.log(`[scope] 3DS simulator Submit found in: ${where}`);
            break;
          }
        }
        if (!simCtx) await page.waitForTimeout(1000);
      }

      if (simCtx) {
        const submitInput = simCtx.locator(simulatorSelector).first();
        await submitInput.waitFor({ state: "visible", timeout: 15000 });

        try {
          await submitInput.scrollIntoViewIfNeeded();
          await submitInput.click({ timeout: 10000 });
          console.log("✓ 3DS simulator Submit clicked (real mouse)");
        } catch (mouseError) {
          console.log(
            `⚠ Simulator real mouse click failed: ${mouseError.message}`,
          );
          await submitInput.evaluate((btn) => btn.click());
          console.log("✓ 3DS simulator Submit clicked (native JS)");
        }
      } else {
        console.log("✓ No 3DS simulator appeared within 45s — continuing");
      }

      // Moyasar redirects back to the WTE callback once the payment resolves, so
      // the top-level URL genuinely changes and the shared URL-comparison helper
      // is valid here.
      await waitForSubmissionToTakeEffect(page, urlBeforeSubmit);

      // Surface a stall — a declined card keeps the form up with the URL
      // unchanged, which otherwise reads as a silent timeout.
      if (page.url().includes("moyasar.com")) {
        const errorText = await ctx
          .locator('[role="alert"], .text-red-500, .error')
          .first()
          .textContent({ timeout: 3000 })
          .catch(() => null);
        console.log(
          errorText && errorText.trim()
            ? `⚠ Still on Moyasar with error: "${errorText.trim()}"`
            : `⚠ Still on Moyasar with no visible error — URL: ${page.url()}`,
        );
      }

      console.log("✓ Card payment submitted");
    },
  },

  Paddle: {
    fillCardDetails: async (page) => {
      console.log("Filling Paddle card details (overlay iframe)...");

      // Fixed test card details. 4242424242424242 is Paddle's documented sandbox
      // card. Expiry MONTH stays fixed, YEAR is computed (current year + 3) so it
      // never becomes a past date.
      const CARD_NUMBER = "4242424242424242";
      const CARD_HOLDER = "Token Tutorial";
      const CARD_CVV = "100";
      const CARD_COUNTRY = "US";
      // Five digits, because CARD_COUNTRY is US. The observed markup had a
      // 3-digit value sitting in this field with aria-invalid="true" — Paddle
      // validates the postcode against the selected country, so this constant
      // has to change alongside CARD_COUNTRY.
      const CARD_POSTCODE = "10001";
      const CARD_EXPIRY_MONTH = "02";
      const CARD_EXPIRY_YEAR = String(
        (new Date().getFullYear() + 3) % 100,
      ).padStart(2, "0");

      console.log(`Using fixed test card ending in ${CARD_NUMBER.slice(-4)}`);
      console.log(
        `Expiry set to ${CARD_EXPIRY_MONTH}/${CARD_EXPIRY_YEAR} (always current year + 3)`,
      );

      // -----------------------------------------------------------------
      // Resolves whichever frame owns the card number field, main frame included
      // (page.frames() puts it at index 0), so this covers both the overlay
      // iframe and a hypothetical inline render.
      //
      // Anchored on the card number rather than on the Card tab: the tablist only
      // appears when Paddle has more than one payment method enabled, so keying
      // on it would make a single-method checkout unfillable.
      // -----------------------------------------------------------------
      const resolveContext = async (timeout = 60000) => {
        const deadline = Date.now() + timeout;
        while (Date.now() < deadline) {
          for (const frame of page.frames()) {
            const count = await frame
              .locator('[data-testid="cardNumberInput"]')
              .count()
              .catch(() => 0);
            if (count > 0) {
              const where =
                frame === page.mainFrame() ? "main frame" : frame.url();
              console.log(`[scope] Paddle card form found in: ${where}`);
              return frame;
            }
          }
          await page.waitForTimeout(500);
        }
        return null;
      };

      const ctx = await resolveContext(60000);

      if (!ctx) {
        const frames = page.frames().map((f) => f.url());
        const testids = await page
          .evaluate(() =>
            Array.from(document.querySelectorAll("[data-testid]"))
              .map((el) => el.getAttribute("data-testid"))
              .slice(0, 40),
          )
          .catch(() => []);
        throw new Error(
          `Paddle card form ([data-testid="cardNumberInput"]) not found in any frame within 60s.\n` +
            `  URL: ${page.url()}\n` +
            `  Frames: ${JSON.stringify(frames)}\n` +
            `  data-testids in the main document: ${JSON.stringify(testids)}\n` +
            `  If no buy.paddle.com frame is listed, the overlay never opened — the WTE checkout ` +
            `step before this did not launch Paddle.`,
        );
      }

      // -- Card tab (optional) ----------------------------------------------
      // Only present when Paddle has more than one payment method enabled, and
      // in the observed markup it already carried aria-selected="true". Skipped
      // when absent or already selected — clicking an already-selected tab in a
      // React tablist can be a no-op or re-trigger a transition.
      const cardTab = ctx.locator(
        '[data-testid="CARD_PaymentSelectionButton"]',
      );
      const tabCount = await cardTab.count().catch(() => 0);

      if (tabCount === 0) {
        console.log("✓ No payment method tablist — Card is the only method");
      } else {
        const tabSelected = await cardTab.getAttribute("aria-selected");
        console.log(`[state] Card tab aria-selected="${tabSelected}"`);
        if (tabSelected === "true") {
          console.log("✓ Card tab already selected — no click needed");
        } else {
          await cardTab.click();
          console.log("✓ Card tab clicked");
        }
      }

      // Each field is clicked immediately before typing into it.
      // pressSequentially rather than fill() throughout: the card number groups
      // itself into blocks of four and the expiry inserts its own separator, both
      // driven by input events that fill() does not produce.

      // -- Cardholder name --------------------------------------------------
      const holderInput = ctx.locator('[data-testid="cardholderNameInput"]');
      await holderInput.waitFor({ state: "visible", timeout: 30000 });
      await holderInput.click();
      await holderInput.pressSequentially(CARD_HOLDER, { delay: 40 });
      console.log(
        `✓ Cardholder name field now contains: "${await holderInput.inputValue()}"`,
      );

      // -- Card number ------------------------------------------------------
      const cardNumberInput = ctx.locator('[data-testid="cardNumberInput"]');
      await cardNumberInput.waitFor({ state: "visible", timeout: 30000 });
      await cardNumberInput.click();
      await cardNumberInput.pressSequentially(CARD_NUMBER, { delay: 50 });
      console.log(
        `✓ Card number field now contains: "${await cardNumberInput.inputValue()}"`,
      );

      // -- Expiry -----------------------------------------------------------
      // Placeholder is "MM / YY" — SPACES around the separator, like Moyasar and
      // DOKU rather than Square's bare "MM/YY". Only the four digits are typed
      // and the result verified, because a mask that didn't fire leaves "0229" in
      // a field Paddle rejects.
      const expiryInput = ctx.locator('[data-testid="expiryDateField"]');
      await expiryInput.waitFor({ state: "visible", timeout: 30000 });
      await expiryInput.click();
      await expiryInput.pressSequentially(
        `${CARD_EXPIRY_MONTH}${CARD_EXPIRY_YEAR}`,
        { delay: 50 },
      );

      let expiryValue = await expiryInput.inputValue();
      if (!expiryValue.includes("/")) {
        console.log(
          `⚠ Expiry mask did not insert a separator (field reads "${expiryValue}") — retyping explicitly`,
        );
        await expiryInput.fill("");
        await expiryInput.click();
        await expiryInput.pressSequentially(
          `${CARD_EXPIRY_MONTH} / ${CARD_EXPIRY_YEAR}`,
          { delay: 50 },
        );
        expiryValue = await expiryInput.inputValue();
      }
      console.log(`✓ Expiry field now contains: "${expiryValue}"`);

      // -- CVV --------------------------------------------------------------
      // maxlength=4 accommodates a 4-digit Amex code.
      const cvvInput = ctx.locator(
        '[data-testid="cardVerificationValueInput"]',
      );
      await cvvInput.waitFor({ state: "visible", timeout: 30000 });
      await cvvInput.click();
      await cvvInput.pressSequentially(CARD_CVV, { delay: 50 });
      console.log(`✓ CVV field now contains: "${await cvvInput.inputValue()}"`);

      // -- Country ----------------------------------------------------------
      // REQUIRED and easy to miss. Its first option is
      // <option value="" disabled> so nothing is preselected, and Paddle collects
      // it for fraud checks — leaving it blank blocks submission.
      //
      // selectOption by VALUE (the ISO code), not label: the visible names are
      // localised display text, whereas the codes are stable.
      const countrySelect = ctx.locator('[data-testid="countriesSelect"]');
      await countrySelect.waitFor({ state: "visible", timeout: 30000 });
      await countrySelect.selectOption(CARD_COUNTRY);
      const countryValue = await countrySelect.inputValue();
      console.log(`✓ Country now set to: "${countryValue}"`);

      if (countryValue !== CARD_COUNTRY) {
        throw new Error(
          `Paddle country select reads "${countryValue}" but "${CARD_COUNTRY}" was chosen — ` +
            `the option may not exist in this list.`,
        );
      }

      // -- ZIP / Postcode ----------------------------------------------------
      // Country-dependent: Paddle only renders this once a country that uses
      // postcodes is selected, which is why it comes AFTER the country select.
      // Treated as optional so a country without one does not fail the run.
      //
      // type="tel" with text-transform: uppercase — the uppercasing is CSS
      // only, so the value stays exactly what is typed. Typed rather than
      // fill()'d, to match the rest of the form.
      const postcodeInput = ctx.locator('[data-testid="postcodeInput"]');
      const hasPostcode = await postcodeInput
        .waitFor({ state: "visible", timeout: 10000 })
        .then(() => true)
        .catch(() => false);

      if (hasPostcode) {
        await postcodeInput.click();

        // Cleared first: Paddle can prefill this from the buyer's IP, and typing
        // onto an existing value produces a concatenation the validator rejects.
        await postcodeInput.fill("");
        await postcodeInput.pressSequentially(CARD_POSTCODE, { delay: 50 });

        const postcodeValue = await postcodeInput.inputValue();
        console.log(`✓ Postcode field now contains: "${postcodeValue}"`);

        // aria-invalid is Paddle's own verdict on the value, so it is read back
        // rather than assumed. Blur first — validation runs on blur, so reading
        // the attribute while the field still has focus reports a stale state.
        await postcodeInput.blur().catch(() => {});
        const postcodeInvalid =
          await postcodeInput.getAttribute("aria-invalid");
        if (postcodeInvalid === "true") {
          console.log(
            `⚠ Paddle marks the postcode "${postcodeValue}" invalid (aria-invalid="true") — ` +
              `it must match the selected country (${CARD_COUNTRY}). Submission will likely be blocked.`,
          );
        }
      } else {
        console.log(
          `No postcode field shown for country "${CARD_COUNTRY}" — skipping`,
        );
      }

      // "Add VAT number" and "Add discount code" are deliberately untouched —
      // both are optional disclosure toggles, and expanding either adds further
      // required fields.

      console.log("✓ All card fields filled — readback values logged above");

      // No click here on purpose: submitCardPayment() runs immediately after
      // this and owns the click.
    },

    submitCardPayment: async (page) => {
      console.log("Clicking Paddle pay button...");

      // Re-resolved by content, matching fillCardDetails — the two are separate
      // entry points and the earlier frame handle is not guaranteed live.
      const resolvePayContext = async (timeout = 45000) => {
        const deadline = Date.now() + timeout;
        while (Date.now() < deadline) {
          for (const frame of page.frames()) {
            const count = await frame
              .locator('[data-testid="cardPaymentFormSubmitButton"]')
              .count()
              .catch(() => 0);
            if (count > 0) {
              const where =
                frame === page.mainFrame() ? "main frame" : frame.url();
              console.log(`[scope] Paddle pay button found in: ${where}`);
              return frame;
            }
          }
          await page.waitForTimeout(500);
        }
        throw new Error(
          `Paddle pay button ([data-testid="cardPaymentFormSubmitButton"]) not found in any ` +
            `frame. URL: ${page.url()}. Frames: ${JSON.stringify(
              page.frames().map((f) => f.url()),
            )}`,
        );
      };

      const ctx = await resolvePayContext(45000);

      // Targeted by data-testid, not by its label: the button text embeds the
      // amount ("Pay $66.00"), which changes with the booking.
      //
      // Not state-gated — the observed markup carries no disabled attribute.
      const button = ctx.locator('[data-testid="cardPaymentFormSubmitButton"]');
      await button.waitFor({ state: "visible", timeout: 30000 });

      // Currency sanity check off the button label, confirming the WTE
      // currency-switch step took effect. Logged, not thrown.
      const label = await button.textContent().catch(() => null);
      console.log(`[config] Paddle pay button reads: "${label?.trim()}"`);

      await button.scrollIntoViewIfNeeded();
      await button.click();
      console.log("✓ Pay clicked");

      // Paddle writes submission errors into its aria-live status region rather
      // than navigating, so a rejected card leaves the overlay open and would
      // otherwise surface only as a downstream thank-you-page timeout.
      await page.waitForTimeout(3000);
      const statusText = await ctx
        .locator(".submission-block, [role='status']")
        .first()
        .textContent()
        .catch(() => null);
      if (statusText && statusText.trim()) {
        console.log(`[state] Paddle submission status: "${statusText.trim()}"`);
      }
    },
  },
  //3rd

  PayFast: {
    fillCardDetails: async (page) => {
      console.log("PayFast sandbox wallet flow — no card entry required");

      // The path segment after /payment/ is a per-session payment UUID, and the
      // trailing "#wf" is a client-side hash route (wallet flow) that does not
      // trigger navigation. Only the stable prefix is matched.
      await waitForUrlPrefix(
        page,
        "https://sandbox.payfast.co.za/eng/process/payment/",
        60000,
      );
      console.log(`✓ PayFast payment page reached: ${page.url()}`);

      // Waited on VISIBLE, not attached. The button ships in the DOM before the
      // wallet flow finishes booting, so an attached-only wait would pass too
      // early and the click would land on a dead element.
      const payButton = page.locator("#pay-with-wallet");

      try {
        await payButton.waitFor({ state: "visible", timeout: 60000 });
      } catch (err) {
        console.log(`[diag] URL: ${page.url()}`);
        console.log(
          `[diag] Frames: ${JSON.stringify(page.frames().map((f) => f.url()))}`,
        );
        const buttons = await page
          .evaluate(() =>
            Array.from(
              document.querySelectorAll("button, input[type='submit']"),
            ).map((el) => ({
              id: el.id || null,
              text: (el.textContent || el.value || "").trim(),
              visible: !!(el.offsetWidth || el.offsetHeight),
              disabled: el.disabled,
            })),
          )
          .catch(() => "(unreadable)");
        console.log(`[diag] buttons: ${JSON.stringify(buttons)}`);
        throw new Error(
          `PayFast "Complete Payment" button (#pay-with-wallet) never became visible within 60s. ` +
            `URL: ${page.url()}. See the [diag] button dump above.`,
        );
      }

      const labelText = await page
        .locator("#pay-with-wallet .button-label")
        .textContent()
        .catch(() => null);
      console.log(
        `✓ Complete Payment button visible — label="${labelText?.trim()}"`,
      );

      console.log("✓ PayFast ready to submit");
    },

    submitCardPayment: async (page) => {
      console.log("Submitting PayFast payment...");

      if (await paymentAlreadyCompleted(page)) {
        console.log("✓ Payment already completed — skipping submit");
        return;
      }

      const urlBeforeSubmit = page.url();

      // Targeted by id — unique and stable here, unlike the class chain
      // ("btn btn-primary button") which is generic Bootstrap and would match
      // any other button on the page.
      const payButton = page.locator("#pay-with-wallet");
      await payButton.waitFor({ state: "visible", timeout: 60000 });
      await describeSubmitButtons(page, "button[type='submit']");

      // Attempt 1 — real mouse movement then click.
      try {
        await payButton.scrollIntoViewIfNeeded();
        await payButton.hover();
        await payButton.click({ timeout: 10000 });
        console.log("✓ Complete Payment clicked (real mouse)");
      } catch (mouseError) {
        console.log(`⚠ Real mouse click failed: ${mouseError.message}`);

        // Attempt 2 — native JS click.
        try {
          await payButton.evaluate((btn) => btn.click());
          console.log("✓ Complete Payment clicked (native JS)");
        } catch (jsError) {
          console.log(`⚠ Native JS click failed: ${jsError.message}`);

          // Attempt 3 — requestSubmit on the owning form. Valid here: this is a
          // real type="submit" inside a form.
          await payButton.evaluate((btn) => {
            const form = btn.closest("form");
            if (!form)
              throw new Error("Complete Payment button has no owning form");
            form.requestSubmit ? form.requestSubmit() : form.submit();
          });
          console.log("✓ Complete Payment submitted (requestSubmit)");
        }
      }

      // Cheap confirmation that the click actually registered rather than
      // silently missing: the button carries a processing-loader span alongside
      // its label, and PayFast reveals it on submit. Logged, not thrown — the
      // loader can come and go faster than this check on a quick redirect.
      const loaderVisible = await page
        .locator("#pay-with-wallet .processing-loader__small")
        .isVisible({ timeout: 3000 })
        .catch(() => false);
      console.log(
        `[state] Processing loader visible after click: ${loaderVisible}`,
      );

      // PayFast redirects back to the WTE return URL once the sandbox payment
      // resolves, so the top-level URL genuinely changes and the shared
      // URL-comparison helper is valid here.
      await waitForSubmissionToTakeEffect(page, urlBeforeSubmit);

      // Surface a stall — a failed sandbox payment keeps the URL on
      // sandbox.payfast.co.za, which otherwise reads as a silent timeout.
      if (page.url().includes("payfast.co.za")) {
        const errorText = await page
          .locator('[role="alert"], .alert, .alert-danger, .error')
          .first()
          .textContent({ timeout: 3000 })
          .catch(() => null);
        console.log(
          errorText && errorText.trim()
            ? `⚠ Still on PayFast with error: "${errorText.trim()}"`
            : `⚠ Still on PayFast with no visible error — URL: ${page.url()}`,
        );
      }

      console.log("✓ Payment submitted");
    },
  },

  Paystack: {
    fillCardDetails: async (page) => {
      console.log(
        "Selecting Paystack card channel and test card (popup iframe)...",
      );

      // -----------------------------------------------------------------
      // Resolves whichever frame owns a marker element, main frame included.
      // Located by CONTENT rather than URL: the Paystack checkout iframe carries
      // a per-session access code in its path, so there is no stable URL to
      // match on.
      // -----------------------------------------------------------------
      const resolveContext = async (marker, label, timeout = 60000) => {
        const deadline = Date.now() + timeout;
        while (Date.now() < deadline) {
          for (const frame of page.frames()) {
            const count = await frame
              .locator(marker)
              .count()
              .catch(() => 0);
            if (count > 0) {
              const where =
                frame === page.mainFrame() ? "main frame" : frame.url();
              console.log(`[scope] ${label} found in: ${where}`);
              return frame;
            }
          }
          await page.waitForTimeout(500);
        }
        return null;
      };

      const dumpState = async (stage) => {
        console.log(`[diag] --- ${stage} ---`);
        console.log(`[diag] URL: ${page.url()}`);
        console.log(
          `[diag] Frames: ${JSON.stringify(page.frames().map((f) => f.url()))}`,
        );
        for (const frame of page.frames()) {
          const testids = await frame
            .evaluate(() =>
              Array.from(document.querySelectorAll("[data-testid]")).map(
                (el) => ({
                  testid: el.getAttribute("data-testid"),
                  tag: el.tagName.toLowerCase(),
                  text: (el.textContent || "").trim().slice(0, 40),
                  visible: !!(el.offsetWidth || el.offsetHeight),
                }),
              ),
            )
            .catch(() => "(unreadable)");
          const where = frame === page.mainFrame() ? "main frame" : frame.url();
          console.log(`[diag] testids in ${where}: ${JSON.stringify(testids)}`);
        }
      };

      // -- 1. Resolve the Paystack popup -----------------------------------
      const ctx = await resolveContext(
        '[data-testid="nav-items"]',
        "Paystack channel nav",
        60000,
      );

      if (!ctx) {
        await dumpState("Paystack popup not found");
        throw new Error(
          `Paystack popup containing [data-testid="nav-items"] not found. URL: ${page.url()}. ` +
            `Frames: ${JSON.stringify(page.frames().map((f) => f.url()))}`,
        );
      }

      // -- 2. Select the Card channel --------------------------------------
      // Checked BEFORE clicking: in the observed markup the Card <li> already
      // carried class "active", so Card is the default channel and clicking it
      // is a no-op. Skipped when already active rather than clicking blind,
      // since on a Vue nav a redundant click can toggle state rather than
      // re-assert it.
      const cardNavItem = ctx.locator('[data-testid="nav-item-card"]');
      await cardNavItem.waitFor({ state: "visible", timeout: 30000 });

      const navClasses = (await cardNavItem.getAttribute("class")) || "";
      console.log(`[state] Card nav item classes: "${navClasses}"`);

      if (navClasses.includes("active")) {
        console.log("✓ Card channel already active — no click needed");
      } else {
        const cardNavLink = ctx.locator('[data-testid="card-nav"]');
        await cardNavLink.waitFor({ state: "visible", timeout: 30000 });
        await cardNavLink.click();
        console.log("✓ Card channel clicked");

        await cardNavItem
          .waitFor({ state: "visible", timeout: 10000 })
          .catch(() => {});
        const afterClasses = (await cardNavItem.getAttribute("class")) || "";
        console.log(
          `[state] Card nav item classes after click: "${afterClasses}"`,
        );
      }

      // -- 3. Pick the prefilled test card ---------------------------------
      // Test mode only. This is a picker, not a form — there is nothing to type,
      // so none of the usual pressSequentially / mask handling applies here.
      const testCard = ctx.locator('[data-testid="testCard-0"]');

      try {
        await testCard.waitFor({ state: "visible", timeout: 30000 });
      } catch (err) {
        await dumpState("test card picker not found");
        throw new Error(
          `Paystack test card ([data-testid="testCard-0"]) not visible. URL: ${page.url()}. ` +
            `If the popup rendered a real card form instead of the test picker, the ` +
            `integration is running in LIVE mode — see the [diag] testid dump above.`,
        );
      }

      // The element is an empty <div> with no text, so a click is the only way
      // to interact and there is no value to verify afterwards. The Pay button's
      // disabled state below is the confirmation that it registered.
      await testCard.scrollIntoViewIfNeeded();
      await testCard.click();
      console.log("✓ Test card selected");

      // -- Validation confirmation (no paying — that's submitCardPayment) ---
      //
      // The Pay button ships disabled="" and only enables once a test card is
      // selected, so this is a real gate — same state-gated pattern as PayWay's
      // and Authorize.Net's submit buttons, and it doubles as proof the
      // testCard-0 click landed.
      const payButton = ctx.locator(
        '[data-testid="testCardsPaymentButton"]:not([disabled])',
      );

      try {
        await payButton.waitFor({ state: "visible", timeout: 20000 });
      } catch (err) {
        const stillDisabled = await ctx
          .locator('[data-testid="testCardsPaymentButton"]')
          .getAttribute("disabled")
          .catch(() => null);
        await dumpState("Pay button never enabled");
        throw new Error(
          `Paystack Pay button is still disabled after selecting the test card ` +
            `(disabled="${stillDisabled}"). The testCard-0 click did not register.`,
        );
      }
      console.log("✓ Pay button enabled — test card selection registered");

      // Currency sanity check. The button label embeds the currency and amount
      // ("Pay GHS 1,600"), so this confirms the WTE currency-switch step took
      // effect. Logged, not thrown — the label uses a non-breaking space, which
      // is why it is not matched on as a selector.
      const payLabel = await payButton.textContent().catch(() => null);
      console.log(`[config] Paystack Pay button reads: "${payLabel?.trim()}"`);

      console.log("✓ Paystack ready to submit");
    },

    submitCardPayment: async (page) => {
      console.log("Submitting Paystack payment...");

      if (await paymentAlreadyCompleted(page)) {
        console.log("✓ Payment already completed — skipping submit");
        return;
      }

      const urlBeforeSubmit = page.url();

      // Re-resolved by content, matching fillCardDetails — the two are separate
      // entry points and the earlier frame handle is not guaranteed live.
      const resolvePayContext = async (timeout = 45000) => {
        const deadline = Date.now() + timeout;
        while (Date.now() < deadline) {
          for (const frame of page.frames()) {
            const count = await frame
              .locator('[data-testid="testCardsPaymentButton"]')
              .count()
              .catch(() => 0);
            if (count > 0) {
              const where =
                frame === page.mainFrame() ? "main frame" : frame.url();
              console.log(`[scope] Pay button found in: ${where}`);
              return frame;
            }
          }
          await page.waitForTimeout(500);
        }
        throw new Error(
          `Paystack Pay button not found in any frame. URL: ${page.url()}. ` +
            `Frames: ${JSON.stringify(page.frames().map((f) => f.url()))}`,
        );
      };

      const ctx = await resolvePayContext(45000);

      // Selected by STATE as well as testid — the button is disabled until a
      // test card is picked, so an unqualified selector can match a dead
      // element. The class attribute is just "button" and useless as a
      // discriminator.
      const payButton = ctx.locator(
        '[data-testid="testCardsPaymentButton"]:not([disabled])',
      );
      await payButton.waitFor({ state: "visible", timeout: 30000 });

      // page, NOT ctx. describeSubmitButtons iterates page.frames() internally,
      // so handing it a Frame throws "page.frames is not a function".
      await describeSubmitButtons(page, "button[type='submit']");

      // Attempt 1 — real mouse movement then click.
      try {
        await payButton.scrollIntoViewIfNeeded();
        await payButton.hover();
        await payButton.click({ timeout: 10000 });
        console.log("✓ Pay clicked (real mouse)");
      } catch (mouseError) {
        console.log(`⚠ Real mouse click failed: ${mouseError.message}`);

        // Attempt 2 — native JS click, stripping disabled in case Vue
        // re-applied it between the state check and the click.
        try {
          await ctx.evaluate(() => {
            const btn = document.querySelector(
              '[data-testid="testCardsPaymentButton"]',
            );
            if (!btn) throw new Error("Pay button not in Paystack document");
            btn.removeAttribute("disabled");
            btn.click();
          });
          console.log("✓ Pay clicked (native JS)");
        } catch (jsError) {
          console.log(`⚠ Native JS click failed: ${jsError.message}`);

          // Attempt 3 — requestSubmit on the owning form. Valid here: this is a
          // real type="submit", unlike Midtrans's or Authorize.Net's
          // type="button" pay buttons.
          await payButton.evaluate((btn) => {
            const form = btn.closest("form");
            if (!form) throw new Error("Pay button has no owning form");
            form.requestSubmit ? form.requestSubmit() : form.submit();
          });
          console.log("✓ Pay submitted (requestSubmit)");
        }
      }

      // -- Conditional OTP / PIN step --------------------------------------
      // Some Paystack test cards route through an OTP or PIN screen and some
      // authorise straight through. Polled briefly and SKIPPED if absent,
      // following the MyFatoorah pattern — a long fixed wait would cost every
      // green run a minute.
      //
      // Test-mode OTP is 123456. Selectors here are EXTRAPOLATED, not observed.
      const otpSelectors = [
        '[data-testid="otp-input"]',
        'input[name="otp"]',
        "#otp",
        'input[autocomplete="one-time-code"]',
      ].join(", ");

      let otpCtx = null;
      const otpDeadline = Date.now() + 20000;
      while (Date.now() < otpDeadline && !otpCtx) {
        for (const frame of page.frames()) {
          const count = await frame
            .locator(otpSelectors)
            .count()
            .catch(() => 0);
          if (count > 0) {
            otpCtx = frame;
            console.log(`[scope] OTP field found in: ${frame.url()}`);
            break;
          }
        }
        if (!otpCtx) await page.waitForTimeout(1000);
      }

      if (otpCtx) {
        const otpInput = otpCtx.locator(otpSelectors).first();
        await otpInput.click();
        await otpInput.pressSequentially("123456", { delay: 80 });
        console.log("✓ Test OTP entered");

        const otpSubmit = otpCtx
          .locator('button, input[type="submit"]')
          .filter({ hasText: /Authorise|Authorize|Submit|Continue|Pay/i })
          .first();

        if ((await otpSubmit.count().catch(() => 0)) > 0) {
          await otpSubmit.click().catch(async (err) => {
            console.log(
              `⚠ OTP submit click failed: ${err.message} — trying native JS`,
            );
            await otpSubmit.evaluate((btn) => btn.click());
          });
          console.log("✓ OTP submitted");
        } else {
          console.log(
            "⚠ No OTP submit button — assuming auto-submit on length",
          );
        }
      } else {
        console.log("✓ No OTP step appeared within 20s — continuing");
      }

      // Paystack closes the popup and returns to the WTE callback, so the
      // top-level URL genuinely changes and the shared URL-comparison helper is
      // valid here.
      await waitForSubmissionToTakeEffect(page, urlBeforeSubmit);

      // Surface a stall — a declined test card keeps the popup open with the URL
      // unchanged, which otherwise reads as a silent timeout.
      const popupStillOpen = page
        .frames()
        .some((f) => (f.url() || "").includes("paystack"));
      if (popupStillOpen) {
        const errorText = await ctx
          .locator('[role="alert"], .error, .alert, .text-error')
          .first()
          .textContent({ timeout: 3000 })
          .catch(() => null);
        console.log(
          errorText && errorText.trim()
            ? `⚠ Paystack popup still open with error: "${errorText.trim()}"`
            : `⚠ Paystack popup still open with no visible error — URL: ${page.url()}`,
        );
      }

      console.log("✓ Payment submitted");
    },
  },

  Revolut: {
    fillCardDetails: async (page) => {
      console.log("Filling Revolut card details (nested card-field iframe)...");

      // The path segment after /payment-link/ is a per-session token — the same
      // token also appears in the card-field iframe's query string — so only the
      // stable prefix is matched.
      await waitForUrlPrefix(
        page,
        "https://sandbox-checkout.revolut.com/payment-link/",
        60000,
      );
      console.log(`✓ Revolut checkout reached: ${page.url()}`);

      // Revolut sandbox test card, as supplied. Expiry MONTH fixed, YEAR
      // computed (current year + 3) so it cannot drift into the past.
      const CARD_NUMBER = "4929420573595709";
      const CARD_CVV = "123";
      const CARD_HOLDER = "Token Tutorial";
      const CARD_EMAIL = "token.tutorial@example.com";
      const CARD_EXPIRY_MONTH = "02";
      const CARD_EXPIRY_YEAR = String(new Date().getFullYear() + 3).slice(-2);

      console.log(`Using fixed test card ending in ${CARD_NUMBER.slice(-4)}`);
      console.log(`Expiry to enter: ${CARD_EXPIRY_MONTH}/${CARD_EXPIRY_YEAR}`);

      const dumpState = async (stage) => {
        console.log(`[diag] --- ${stage} ---`);
        console.log(`[diag] URL: ${page.url()}`);
        console.log(
          `[diag] Frames: ${JSON.stringify(page.frames().map((f) => f.url()))}`,
        );
        for (const frame of page.frames()) {
          const inputs = await frame
            .evaluate(() =>
              Array.from(document.querySelectorAll("input")).map((el) => ({
                id: el.id || null,
                name: el.getAttribute("name") || null,
                placeholder: el.getAttribute("placeholder") || null,
                autocomplete: el.getAttribute("autocomplete") || null,
                inputmode: el.getAttribute("inputmode") || null,
                maxlength: el.getAttribute("maxlength") || null,
                type: el.type,
              })),
            )
            .catch(() => "(unreadable)");
          const where = frame === page.mainFrame() ? "main frame" : frame.url();
          console.log(`[diag] inputs in ${where}: ${JSON.stringify(inputs)}`);
        }
      };

      // -- 1. Choose "Pay with card" ---------------------------------------
      // Matched on text: this is a type="button" with nothing but hashed classes
      // on it, and its label sits in a nested <span> so textContent is the only
      // stable discriminator.
      const payWithCard = page
        .locator('button[type="button"]')
        .filter({ hasText: /Pay with card/i })
        .first();

      await payWithCard.waitFor({ state: "visible", timeout: 45000 });
      await payWithCard.scrollIntoViewIfNeeded();
      await payWithCard.click();
      console.log("✓ Pay with card clicked");

      // -- 2. Resolve the card-field iframe --------------------------------
      // Matched on card-field.html, NOT on a generic iframe walk: the same form
      // also contains upsell/card-gateway-banner.html, and both are served from
      // sandbox-merchant.revolut.com, so host alone cannot tell them apart.
      const resolveCardFrame = async (timeout = 45000) => {
        const deadline = Date.now() + timeout;
        while (Date.now() < deadline) {
          for (const frame of page.frames()) {
            const url = frame.url() || "";
            if (!url.includes("card-field.html")) continue;
            const count = await frame
              .locator("input")
              .count()
              .catch(() => 0);
            if (count > 0) {
              console.log(`[scope] Card field frame resolved: ${url}`);
              return frame;
            }
          }
          await page.waitForTimeout(500);
        }
        return null;
      };

      const cardFrame = await resolveCardFrame(45000);

      if (!cardFrame) {
        await dumpState("card-field iframe not found");
        throw new Error(
          `Revolut card field iframe (card-field.html) not found, or it contains no input. ` +
            `URL: ${page.url()}. See the [diag] dumps above — note the sibling ` +
            `upsell/card-gateway-banner.html iframe is NOT the card field.`,
        );
      }

      // -- 3. Card number / expiry / CVC -----------------------------------
      // The outer wrapper carries "rc-card-field rc-card-field--empty" and the
      // iframe is height:1.5em — one line — which indicates Revolut's COMBINED
      // field: a single input that takes number, then expiry, then CVC,
      // auto-advancing between segments as you type.
      //
      // The inner markup was never observed, so both shapes are handled: one
      // input takes all three values in sequence; three or more inputs get one
      // value each. The [diag] dump above records which it actually is.
      const cardInputs = cardFrame.locator("input");
      const inputCount = await cardInputs.count();
      console.log(`[state] Card field frame contains ${inputCount} input(s)`);

      // pressSequentially throughout, never fill(): a combined field advances
      // between segments on keystroke events, and fill() would dump the whole
      // string into the number segment and fail validation.
      if (inputCount === 1) {
        console.log("[state] Treating as a COMBINED number/expiry/CVC field");
        const combined = cardInputs.first();
        await combined.waitFor({ state: "visible", timeout: 20000 });
        await combined.click();
        await combined.pressSequentially(CARD_NUMBER, { delay: 60 });
        await combined.pressSequentially(
          `${CARD_EXPIRY_MONTH}${CARD_EXPIRY_YEAR}`,
          { delay: 80 },
        );
        await combined.pressSequentially(CARD_CVV, { delay: 80 });
        console.log(
          `✓ Combined card field filled — value="${await combined.inputValue()}"`,
        );
      } else if (inputCount >= 3) {
        console.log("[state] Treating as SEPARATE number/expiry/CVC fields");
        const values = [
          [CARD_NUMBER, "Card number", 60],
          [`${CARD_EXPIRY_MONTH}${CARD_EXPIRY_YEAR}`, "Expiry", 80],
          [CARD_CVV, "CVC", 60],
        ];
        for (let i = 0; i < values.length; i += 1) {
          const [value, label, delay] = values[i];
          const field = cardInputs.nth(i);
          await field.waitFor({ state: "visible", timeout: 20000 });
          await field.click();
          await field.pressSequentially(value, { delay });
          console.log(
            `✓ ${label} filled — value="${await field.inputValue()}"`,
          );
        }
      } else {
        await dumpState(`unexpected input count (${inputCount}) in card frame`);
        throw new Error(
          `Revolut card field frame contains ${inputCount} inputs — expected 1 (combined) ` +
            `or 3+ (separate). See the [diag] dump above.`,
        );
      }

      // -- 4. Cardholder name ----------------------------------------------
      // No id, no name — placeholder is the only handle. These two inputs are
      // otherwise identical, sharing the same hashed InputBase class.
      const nameInput = page.locator('input[placeholder="Cardholder name"]');
      await nameInput.waitFor({ state: "visible", timeout: 30000 });
      await nameInput.click();
      await nameInput.pressSequentially(CARD_HOLDER, { delay: 40 });
      console.log(
        `✓ Cardholder name filled — value="${await nameInput.inputValue()}"`,
      );

      // -- 5. Email address -------------------------------------------------
      const emailInput = page.locator('input[placeholder="Email address"]');
      await emailInput.waitFor({ state: "visible", timeout: 30000 });
      await emailInput.click();
      await emailInput.pressSequentially(CARD_EMAIL, { delay: 30 });
      console.log(`✓ Email filled — value="${await emailInput.inputValue()}"`);

      // -- Validation confirmation (no paying — that's submitCardPayment) ---
      //
      // The card field wrapper drops its "rc-card-field--empty" class once it
      // holds content, which is the only signal available for an iframed field
      // whose value cannot be read from the parent document. Checked as a
      // warning rather than a throw, since the class name is undocumented and
      // could change independently of the field working.
      const cardFieldClasses = await page
        .locator(".rc-card-field")
        .first()
        .getAttribute("class")
        .catch(() => null);
      console.log(`[state] Card field wrapper classes: "${cardFieldClasses}"`);
      if (
        cardFieldClasses &&
        cardFieldClasses.includes("rc-card-field--empty")
      ) {
        console.log(
          "⚠ Card field still reports rc-card-field--empty after typing",
        );
      }

      // aria-invalid sits on the wrapper div and on the plain inputs, and starts
      // "false" while EMPTY — so like Mollie it is not a filled/valid gate, only
      // a post-rejection signal. Reported, not gated on.
      const invalidCount = await page
        .locator('[aria-invalid="true"]')
        .count()
        .catch(() => 0);
      console.log(
        `[state] Elements reporting aria-invalid="true": ${invalidCount}`,
      );

      for (const [selector, label] of [
        ['input[placeholder="Cardholder name"]', "Cardholder name"],
        ['input[placeholder="Email address"]', "Email"],
      ]) {
        const value = await page.locator(selector).inputValue();
        if (!value || value.trim().length === 0) {
          throw new Error(
            `Revolut ${label} ("${selector}") is empty after fill — keystrokes did not land.`,
          );
        }
      }
      console.log("✓ All card fields filled");
    },

    submitCardPayment: async (page) => {
      console.log("Submitting Revolut card payment...");

      if (await paymentAlreadyCompleted(page)) {
        console.log("✓ Payment already completed — skipping submit");
        return;
      }

      const urlBeforeSubmit = page.url();

      // form="payment-link-id" is the one semantic attribute on this button and
      // the only thing distinguishing it from the earlier "Pay with card"
      // button, which is a type="button" with an identical class prefix. The
      // label ("Pay $800") is not matched on — it carries the amount, which
      // changes with the booking.
      const payButton = page.locator(
        'button[type="submit"][form="payment-link-id"]',
      );
      await payButton.waitFor({ state: "visible", timeout: 45000 });

      // Currency sanity check off the button label, confirming the WTE
      // currency-switch step took effect. Logged, not thrown.
      const payLabel = await payButton.textContent().catch(() => null);
      console.log(`[config] Revolut Pay button reads: "${payLabel?.trim()}"`);

      await describeSubmitButtons(page, 'button[type="submit"]');

      // data-pending="false" flips to "true" while the request is in flight —
      // captured before clicking so the post-click state below means something.
      const pendingBefore = await payButton
        .getAttribute("data-pending")
        .catch(() => null);
      console.log(`[state] data-pending before click: ${pendingBefore}`);

      // Attempt 1 — real mouse movement then click.
      try {
        await payButton.scrollIntoViewIfNeeded();
        await payButton.hover();
        await payButton.click({ timeout: 10000 });
        console.log("✓ Pay clicked (real mouse)");
      } catch (mouseError) {
        console.log(`⚠ Real mouse click failed: ${mouseError.message}`);

        // Attempt 2 — native JS click.
        try {
          await payButton.evaluate((btn) => btn.click());
          console.log("✓ Pay clicked (native JS)");
        } catch (jsError) {
          console.log(`⚠ Native JS click failed: ${jsError.message}`);

          // Attempt 3 — requestSubmit on the associated form. NOTE this button
          // uses the form ATTRIBUTE rather than being nested inside the form, so
          // closest("form") would return null — the form is looked up by id.
          await payButton.evaluate((btn) => {
            const formId = btn.getAttribute("form");
            const form = formId
              ? document.getElementById(formId)
              : btn.closest("form");
            if (!form) throw new Error(`No form found for id "${formId}"`);
            form.requestSubmit ? form.requestSubmit() : form.submit();
          });
          console.log("✓ Pay submitted (requestSubmit)");
        }
      }

      // Cheap confirmation the click registered rather than silently missing.
      // Logged, not thrown — on a fast redirect the pending state can come and
      // go before this check runs.
      const pendingAfter = await payButton
        .getAttribute("data-pending", { timeout: 3000 })
        .catch(() => "(button gone)");
      console.log(`[state] data-pending after click: ${pendingAfter}`);

      // -- Conditional 3DS challenge ---------------------------------------
      // Polled briefly and SKIPPED if absent, following the MyFatoorah pattern.
      // Selectors are EXTRAPOLATED across common ACS templates, not observed.
      const otpSelectors = [
        'input[name="otp"]',
        'input[autocomplete="one-time-code"]',
        "#otp",
        'input[inputmode="numeric"][maxlength="6"]',
      ].join(", ");

      let otpCtx = null;
      const otpDeadline = Date.now() + 20000;
      while (Date.now() < otpDeadline && !otpCtx) {
        for (const frame of page.frames()) {
          if ((frame.url() || "").includes("card-field.html")) continue; // not the card input
          const count = await frame
            .locator(otpSelectors)
            .count()
            .catch(() => 0);
          if (count > 0) {
            otpCtx = frame;
            console.log(`[scope] 3DS OTP field found in: ${frame.url()}`);
            break;
          }
        }
        if (!otpCtx) await page.waitForTimeout(1000);
      }

      if (otpCtx) {
        const otpInput = otpCtx.locator(otpSelectors).first();
        await otpInput.click();
        await otpInput.pressSequentially("123456", { delay: 80 });
        console.log("✓ 3DS OTP entered");

        const otpSubmit = otpCtx
          .locator('button, input[type="submit"]')
          .filter({ hasText: /Submit|Continue|Confirm|Verify|Pay/i })
          .first();

        if ((await otpSubmit.count().catch(() => 0)) > 0) {
          await otpSubmit.click().catch(async (err) => {
            console.log(
              `⚠ OTP submit click failed: ${err.message} — trying native JS`,
            );
            await otpSubmit.evaluate((btn) => btn.click());
          });
          console.log("✓ 3DS OTP submitted");
        } else {
          console.log(
            "⚠ No OTP submit button — assuming auto-submit on length",
          );
        }
      } else {
        console.log("✓ No 3DS challenge appeared within 20s — continuing");
      }

      // Revolut redirects back to the WTE return URL once the payment resolves,
      // so the top-level URL genuinely changes and the shared URL-comparison
      // helper is valid here.
      await waitForSubmissionToTakeEffect(page, urlBeforeSubmit);

      // Surface a stall — a declined card keeps the URL on
      // sandbox-checkout.revolut.com, which otherwise reads as a silent timeout.
      if (page.url().includes("revolut.com")) {
        const errorText = await page
          .locator('[aria-live="polite"], [role="alert"]')
          .filter({ hasText: /\S/ })
          .first()
          .textContent({ timeout: 3000 })
          .catch(() => null);
        console.log(
          errorText && errorText.trim()
            ? `⚠ Still on Revolut with message: "${errorText.trim()}"`
            : `⚠ Still on Revolut with no visible error — URL: ${page.url()}`,
        );
      }

      console.log("✓ Card payment submitted");
    },
  },

  Square: {
    fillCardDetails: async (page) => {
      console.log("Filling Square card details (inside iframe)...");

      // Polled on the iframe FILENAME, not the full src: the path carries an SDK
      // version (.../1.84.2/...) that changes on every Square release.
      console.log(
        "Waiting for the Square card iframe to appear (polling by URL)...",
      );
      const cardFrame = await waitForFrameByUrl(
        page,
        "single-card-element-iframe.html",
        45000,
      );
      console.log(`✓ Square card iframe found: ${cardFrame.url()}`);

      // Fixed test card details — card number, CVV, and ZIP never change.
      // Expiry MONTH stays fixed, but YEAR is computed dynamically (current
      // year + 3) so it never accidentally becomes a past date.
      //
      // NOTE the CVV deviates from the suite's 847: Square's sandbox pairs
      // 4111111111111111 with CVV 111 and ZIP 94103, the way SumUp needs its own
      // card number.
      const CARD_NUMBER = "4111111111111111";
      const CARD_CVV = "111";
      const CARD_POSTAL = "94103";
      const CARD_EXPIRY_MONTH = "02";
      const CARD_EXPIRY_YEAR = String(
        (new Date().getFullYear() + 3) % 100,
      ).padStart(2, "0");

      console.log(`Using fixed test card ending in ${CARD_NUMBER.slice(-4)}`);
      console.log(
        `Expiry set to ${CARD_EXPIRY_MONTH}/${CARD_EXPIRY_YEAR} (always current year + 3)`,
      );

      // Filled in tabindex order. Each field is clicked immediately before
      // typing — focus does not survive being set once and carried across fields
      // in a cross-origin card frame.
      const cardNumberInput = cardFrame.locator("#cardNumber");
      await cardNumberInput.waitFor({ state: "visible", timeout: 30000 });
      await cardNumberInput.click();
      await cardNumberInput.pressSequentially(CARD_NUMBER, { delay: 50 });
      const cardNumberValue = await cardNumberInput.inputValue();
      console.log(`✓ Card number field now contains: "${cardNumberValue}"`);

      // Combined MM/YY field, maxlength=5 — the mask inserts a bare slash with
      // NO surrounding spaces, so only the four digits are typed. Verified after,
      // because a mask that didn't fire leaves "0229" in a field Square rejects.
      const expiryInput = cardFrame.locator("#expirationDate");
      await expiryInput.waitFor({ state: "visible", timeout: 30000 });
      await expiryInput.click();
      await expiryInput.pressSequentially(
        `${CARD_EXPIRY_MONTH}${CARD_EXPIRY_YEAR}`,
        { delay: 50 },
      );
      let expiryValue = await expiryInput.inputValue();

      if (!expiryValue.includes("/")) {
        console.log(
          `⚠ Expiry mask did not insert "/" (field reads "${expiryValue}") — retyping with the separator`,
        );
        await expiryInput.fill("");
        await expiryInput.click();
        await expiryInput.pressSequentially(
          `${CARD_EXPIRY_MONTH}/${CARD_EXPIRY_YEAR}`,
          { delay: 50 },
        );
        expiryValue = await expiryInput.inputValue();
      }
      console.log(`✓ Expiry field now contains: "${expiryValue}"`);

      const cvvInput = cardFrame.locator("#cvv");
      await cvvInput.waitFor({ state: "visible", timeout: 30000 });
      await cvvInput.click();
      await cvvInput.pressSequentially(CARD_CVV, { delay: 50 });
      const cvvValue = await cvvInput.inputValue();
      console.log(`✓ CVV field now contains: "${cvvValue}"`);

      // Required, not optional — aria-required="true", same as the other three.
      const postalInput = cardFrame.locator("#postalCode");
      await postalInput.waitFor({ state: "visible", timeout: 30000 });
      await postalInput.click();
      await postalInput.pressSequentially(CARD_POSTAL, { delay: 50 });
      const postalValue = await postalInput.inputValue();
      console.log(`✓ ZIP field now contains: "${postalValue}"`);

      console.log("✓ All card fields filled — readback values logged above");

      console.log("Waiting for card details to register before submitting...");
      await page.waitForTimeout(3000);
      console.log("✓ Wait complete");

      // Logged, not asserted: the hint for whichever field still has focus is
      // normal and must not fail the run, but when a click later goes nowhere
      // this line is what says whether Square had rejected the card.
      console.log(
        `ℹ Square card message: ${await describeSquareCardMessage(page)}`,
      );

      // No click here on purpose: submitCardPayment() runs immediately after
      // this and owns the click, so clicking here too would submit twice.
    },

    submitCardPayment: async (page) => {
      console.log("Attempting to click Square 'Pay Now' button...");

      // Checked before anything else because submitCardPayment is called
      // directly by CheckoutPage and can't assume fillCardDetails just ran.
      if (paymentAlreadyCompleted(page)) {
        console.log(
          `✓ Payment already went through — at "${page.url()}". Nothing to click.`,
        );
        return;
      }

      // Resolved in the modal frame, NOT via page.locator() — see
      // squareModalFrame() for why the button is unreachable from the page.
      // Matched on the id first and the visible label second, as a union in one
      // selector rather than two probes: every locator call costs a slowMo
      // delay, and this runs with only seconds of the test budget left.
      const modalFrame = await squareModalFrame(page);

      const button = modalFrame
        .locator('button#square-submit-button, button:text-is("Pay Now")')
        .first();

      try {
        await button.waitFor({ state: "visible", timeout: 20000 });
      } catch (err) {
        // The alternative outcome isn't "not yet", it's "the modal is gone for
        // good" — which a locator wait can only ever report as a timeout.
        if (paymentAlreadyCompleted(page)) {
          console.log(
            `✓ Payment submitted itself while waiting — at "${page.url()}". Nothing to click.`,
          );
          return;
        }

        throw err;
      }

      console.log('✓ Found the "Pay Now" button in the Square modal frame');

      const urlBeforeClick = page.url();

      await button.scrollIntoViewIfNeeded();

      // Real mouse movement + click at the button's actual bounding box, rather
      // than a synthetic click: Square's SDK gates tokenisation on trusted
      // input events. boundingBox() is viewport-relative even for an element
      // inside nested frames, so page.mouse lands on it correctly.
      const box = await button.boundingBox();

      if (box) {
        const targetX = box.x + box.width / 2;
        const targetY = box.y + box.height / 2;

        console.log(
          `Moving mouse to (${Math.round(targetX)}, ${Math.round(targetY)})...`,
        );
        await page.mouse.move(targetX, targetY, { steps: 25 });
        await page.waitForTimeout(200);
        await page.mouse.down();
        await page.waitForTimeout(100);
        await page.mouse.up();
        console.log("Clicked 'Pay Now' (attempt 1: real mouse move + click)");
      } else {
        console.log(
          "⚠ Could not get bounding box — falling back to element click()",
        );
        await button.click({ force: true });
      }

      // Square tokenises the card and calls its payments API before the page
      // navigates, so allow for several round-trips rather than a flat wait.
      if (await waitForSubmissionToTakeEffect(page, urlBeforeClick, 20000)) {
        console.log(
          "✓ Page left the card form after click — payment submitted",
        );
        return;
      }

      console.log(
        `⚠ Still on the card form after the real click (Square card message: ${await describeSquareCardMessage(page)}) — trying native JS click...`,
      );

      // Dispatched via the Locator, NOT page.evaluate() — locator.evaluate()
      // runs in the frame that owns the element, whereas page.evaluate() runs
      // in the top-level frame, where this button doesn't exist at all.
      await button
        .evaluate((el) => el.click())
        .catch((err) => {
          console.log(`⚠ Native JS click failed: ${err.message}`);
        });

      if (await waitForSubmissionToTakeEffect(page, urlBeforeClick, 20000)) {
        console.log(
          "✓ Page left the card form after JS click — payment submitted",
        );
        return;
      }

      throw new Error(
        `Clicked 'Pay Now' (both real mouse click and native JS click) but the page never left "${urlBeforeClick}" — the click isn't triggering submission.\n` +
          `Square card message: ${await describeSquareCardMessage(page)}\n` +
          `Buttons present, per frame:\n${await describeSubmitButtons(page)}`,
      );
    },
  },

  Xendit: {
    fillCardDetails: async (page) => {
      console.log("Filling Xendit card details (full-page redirect)...");

      // The path segment after /web/ is a per-session checkout id, so only the
      // stable prefix is matched.
      await waitForUrlPrefix(
        page,
        "https://checkout-staging.xendit.co/web/",
        60000,
      );
      console.log(`✓ Xendit checkout reached: ${page.url()}`);

      // Fixed test card details. 4000000000001091 is Xendit's own test card —
      // it is the value they put in the field's placeholder — and it is the
      // 3DS-REQUIRED one, which is why the challenge step in submitCardPayment
      // is unconditional. Swapping to 4000000000001000 skips the challenge, but
      // that step would then need to become a poll-and-skip.
      //
      // Expiry MONTH stays fixed, YEAR is computed (current year + 3) so it can
      // never drift into the past.
      const CARD_NUMBER = "4000 0000 0000 1091";
      const CARD_CVN = "123";
      const CARD_EXPIRY_MONTH = "02";
      const CARD_EXPIRY_YEAR = String(
        (new Date().getFullYear() + 3) % 100,
      ).padStart(2, "0");

      const FIRST_NAME = "Token";
      const LAST_NAME = "Tutorial";
      const EMAIL = "token.tutorial@example.com";
      const MOBILE_NUMBER = "9741021021";

      console.log(`Using fixed test card ending in ${CARD_NUMBER.slice(-4)}`);
      console.log(
        `Expiry set to ${CARD_EXPIRY_MONTH}/${CARD_EXPIRY_YEAR} (always current year + 3)`,
      );

      // Each field is clicked immediately before typing into it.
      // pressSequentially rather than fill() throughout: the card number groups
      // itself into blocks of four and the expiry inserts its own separator,
      // both driven by input events that fill() does not produce.
      const cardNumberInput = page.locator('[data-testid="card-number"]');
      await cardNumberInput.waitFor({ state: "visible", timeout: 30000 });
      await cardNumberInput.click();
      await cardNumberInput.pressSequentially(CARD_NUMBER, { delay: 50 });
      const cardNumberValue = await cardNumberInput.inputValue();
      console.log(`✓ Card number field now contains: "${cardNumberValue}"`);

      // Combined MM/YY field — placeholder shows a bare slash with no spaces, so
      // only the four digits are typed. Verified after, because a mask that
      // didn't fire leaves "0229" in a field Xendit rejects.
      const expiryInput = page.locator('[data-testid="valid-thru"]');
      await expiryInput.waitFor({ state: "visible", timeout: 30000 });
      await expiryInput.click();
      await expiryInput.pressSequentially(
        `${CARD_EXPIRY_MONTH}${CARD_EXPIRY_YEAR}`,
        { delay: 50 },
      );
      let expiryValue = await expiryInput.inputValue();

      if (!expiryValue.includes("/")) {
        console.log(
          `⚠ Expiry mask did not insert "/" (field reads "${expiryValue}") — retyping with the separator`,
        );
        await expiryInput.fill("");
        await expiryInput.click();
        await expiryInput.pressSequentially(
          `${CARD_EXPIRY_MONTH}/${CARD_EXPIRY_YEAR}`,
          { delay: 50 },
        );
        expiryValue = await expiryInput.inputValue();
      }
      console.log(`✓ Valid Thru field now contains: "${expiryValue}"`);

      // type="password" does NOT hide the value from Playwright — inputValue()
      // returns real content, same as eWAY's and Midtrans's CVV fields, so the
      // readback below is meaningful and needs no reveal-toggle workaround.
      // maxlength=4 accommodates a 4-digit Amex code.
      const cvnInput = page.locator('[data-testid="cvv"]');
      await cvnInput.waitFor({ state: "visible", timeout: 30000 });
      await cvnInput.click();
      await cvnInput.pressSequentially(CARD_CVN, { delay: 50 });
      const cvnValue = await cvnInput.inputValue();
      console.log(`✓ CVN field now contains: "${cvnValue}"`);

      const firstNameInput = page.locator('[data-testid="first-name"]');
      await firstNameInput.waitFor({ state: "visible", timeout: 30000 });
      await firstNameInput.click();
      await firstNameInput.pressSequentially(FIRST_NAME, { delay: 40 });
      console.log(
        `✓ First name field now contains: "${await firstNameInput.inputValue()}"`,
      );

      const lastNameInput = page.locator('[data-testid="surname"]');
      await lastNameInput.waitFor({ state: "visible", timeout: 30000 });
      await lastNameInput.click();
      await lastNameInput.pressSequentially(LAST_NAME, { delay: 40 });
      console.log(
        `✓ Last name field now contains: "${await lastNameInput.inputValue()}"`,
      );

      const emailInput = page.locator('[data-testid="email"]');
      await emailInput.waitFor({ state: "visible", timeout: 30000 });
      await emailInput.click();
      await emailInput.pressSequentially(EMAIL, { delay: 30 });
      console.log(
        `✓ Email field now contains: "${await emailInput.inputValue()}"`,
      );

      // The dial code combobox is left alone — it already renders 🇳🇵 +977, so
      // only the subscriber digits go in this field.
      const mobileInput = page.locator('[data-testid="mobile-number"]');
      await mobileInput.waitFor({ state: "visible", timeout: 30000 });
      await mobileInput.click();
      await mobileInput.pressSequentially(MOBILE_NUMBER, { delay: 40 });
      console.log(
        `✓ Mobile number field now contains: "${await mobileInput.inputValue()}"`,
      );

      // [data-testid="installment"] is deliberately untouched: it ships with a
      // disabled attribute and already reads "Pay in full", which is the value
      // we want. Clicking a disabled button would either no-op or throw.

      console.log("✓ All card fields filled — readback values logged above");

      // The Pay Now button ships disabled="" and only enables once the form
      // validates, so waiting for it is the confirmation that everything above
      // was accepted.
      //
      // NOTE aria-invalid is NOT usable as a gate here: the card number, expiry
      // and CVN all carry aria-invalid="true" while still EMPTY, so it is a
      // post-rejection signal rather than a validity one — same as Mollie.
      console.log("Waiting for the Pay Now button to enable...");
      await page
        .locator('[data-testid="pay-now"]:not([disabled])')
        .waitFor({ state: "visible", timeout: 30000 });
      console.log("✓ Pay Now button enabled — form validated");

      // No click here on purpose: submitCardPayment() runs immediately after
      // this and owns the click.
    },

    submitCardPayment: async (page) => {
      console.log("Clicking Xendit 'Pay Now' button...");

      // Selected by STATE as well as testid — the button is disabled until the
      // form validates, so an unqualified selector can match a dead element.
      const button = page.locator('[data-testid="pay-now"]:not([disabled])');
      await button.waitFor({ state: "visible", timeout: 30000 });
      await button.scrollIntoViewIfNeeded();
      await button.click();
      console.log("✓ Pay Now clicked");

      // -- 3DS challenge ----------------------------------------------------
      // Unconditional because 4000000000001091 is Xendit's 3DS-REQUIRED card and
      // always challenges.
      //
      // Resolved across frames rather than assumed top-level: ACS challenge
      // pages are commonly iframed, and page.locator() only ever searches the
      // main frame, so it would silently never find the field.
      const CHALLENGE_CODE = "1234";
      const codeSelector = 'input[name="challengeDataEntry"]';

      console.log(
        "Waiting for the 3DS challenge field (polling all frames)...",
      );
      let challengeFrame = null;
      const deadline = Date.now() + 60000;

      while (Date.now() < deadline && !challengeFrame) {
        for (const frame of page.frames()) {
          const count = await frame
            .locator(codeSelector)
            .count()
            .catch(() => 0);
          if (count > 0) {
            challengeFrame = frame;
            const where =
              frame === page.mainFrame() ? "main frame" : frame.url();
            console.log(`✓ 3DS challenge field found in: ${where}`);
            break;
          }
        }
        if (!challengeFrame) await page.waitForTimeout(500);
      }

      if (!challengeFrame) {
        throw new Error(
          `Xendit 3DS challenge field (${codeSelector}) not found in any frame within 60s. ` +
            `URL: ${page.url()}. Frames: ${JSON.stringify(
              page.frames().map((f) => f.url()),
            )}`,
        );
      }

      // Targeted by name, not placeholder — the placeholder is " Enter Code Here"
      // with a LEADING SPACE, which makes it fragile to match on.
      const codeInput = challengeFrame.locator(codeSelector);
      await codeInput.waitFor({ state: "visible", timeout: 30000 });
      await codeInput.click();
      await codeInput.pressSequentially(CHALLENGE_CODE, { delay: 50 });
      console.log(
        `✓ Challenge code field now contains: "${await codeInput.inputValue()}"`,
      );

      // input[type="submit"], not a <button> — matched on type plus its value
      // attribute so it cannot collide with any other control on the ACS page.
      const submitInput = challengeFrame.locator(
        'input[type="submit"][value="SUBMIT"]',
      );
      await submitInput.waitFor({ state: "visible", timeout: 30000 });
      await submitInput.scrollIntoViewIfNeeded();
      await submitInput.click();
      console.log("✓ 3DS challenge submitted");
    },
  },
  //4th

  Adyen: {
    fillCardDetails: async (page) => {
      console.log(
        "Filling Adyen card details (iframe popup + Secured Fields)...",
      );

      // Two LAYERS of iframe here, unlike Westpac's single one:
      //   popup iframe  →  holds the Drop-in chrome (#adyen-dropin, Pay button)
      //     └─ securedFields iframes  →  one per card field
      // page.frames() returns the whole tree flattened, so the field walk below
      // reaches the inner frames fine — but the Drop-in chrome does NOT exist in
      // the top-level document, so it needs the popup frame explicitly.
      //
      // Resolved by CONTENT, not URL: the popup is served from the processor host
      // embedded in the securedFields query string, which isn't a stable thing to
      // match on. Whichever frame owns #adyen-dropin is the popup.
      const resolveDropinFrame = async (timeout = 60000) => {
        const deadline = Date.now() + timeout;
        while (Date.now() < deadline) {
          for (const frame of page.frames()) {
            // Skip the field frames — they're inside the popup, not the popup.
            if (frame.url().includes("securedfields")) continue;
            const found = await frame
              .locator("#adyen-dropin")
              .count()
              .catch(() => 0);
            if (found) {
              const where =
                frame === page.mainFrame() ? "top-level page" : frame.url();
              console.log(`✓ Adyen Drop-in host found: ${where}`);
              return frame;
            }
          }
          await page.waitForTimeout(500);
        }
        throw new Error(
          `Adyen Drop-in (#adyen-dropin) not found in the page or any frame.\n` +
            `URL: "${page.url()}"\n` +
            `Frames: ${JSON.stringify(page.frames().map((f) => f.url()))}`,
        );
      };

      const dropinFrame = await resolveDropinFrame();

      await dropinFrame
        .locator("#adyen-dropin .adyen-checkout__dropin--ready")
        .waitFor({ state: "visible", timeout: 45000 })
        .catch(async () => {
          const classes = await dropinFrame
            .locator("#adyen-dropin .adyen-checkout__dropin")
            .getAttribute("class")
            .catch(() => "(no .adyen-checkout__dropin element)");
          console.log(
            `⚠ Drop-in never reported --ready. Classes: "${classes}" — continuing anyway`,
          );
        });
      console.log("✓ Drop-in reported ready");

      // The card form renders behind a spinner while Secured Fields boot.
      await dropinFrame
        .locator(".adyen-checkout__spinner")
        .first()
        .waitFor({ state: "hidden", timeout: 30000 })
        .catch(() => {
          console.log("⚠ Spinner never hid — continuing anyway");
        });

      // Fixed test card details. Unlike Westpac, the expiry is NOT computed:
      // Adyen's test cards are issued against a fixed date and reject anything
      // else, so this is hardcoded rather than current year + 3.
      const CARD_NUMBER = "4035 5010 0000 0008";
      const CARD_EXPIRY = "0330";
      const CARD_CVC = "737";

      console.log(`Using fixed test card ending in ${CARD_NUMBER.slice(-4)}`);
      console.log(
        `Expiry set to ${CARD_EXPIRY.slice(0, 2)}/${CARD_EXPIRY.slice(2)} (fixed — Adyen test cards reject other dates)`,
      );

      // All three field iframes share the SAME securedFields.html URL, so
      // waitForFrameByUrl can't tell them apart — the input's data-fieldtype
      // inside each frame is the only reliable handle. The data-uid values in the
      // markup are mount timestamps (1786961984982 etc), so the ids can't be
      // hardcoded either.
      const resolveSecuredField = async (fieldType, label, timeout = 45000) => {
        const selector = `input[data-fieldtype="${fieldType}"]`;
        const deadline = Date.now() + timeout;
        while (Date.now() < deadline) {
          for (const frame of page.frames()) {
            if (!frame.url().includes("securedfields")) continue;
            const input = frame.locator(selector);
            if (await input.count().catch(() => 0)) {
              console.log(`✓ ${label} iframe found (${fieldType})`);
              return input.first();
            }
          }
          await page.waitForTimeout(500);
        }
        throw new Error(
          `Adyen ${label} ("${selector}") not found in any securedFields frame.\n` +
            `Frames: ${JSON.stringify(page.frames().map((f) => f.url()))}`,
        );
      };

      // Secured Fields are keystroke-driven by design — they encrypt on keyup and
      // never expose a value to the page, so pressSequentially is mandatory here,
      // not just preferred (fill() leaves the field unencrypted and the Pay
      // button dead). This is also why there's no inputValue() readback below,
      // unlike Westpac: the value is an encrypted blob in a cross-origin frame.
      const numberInput = await resolveSecuredField(
        "encryptedCardNumber",
        "Card number",
      );
      await numberInput.waitFor({ state: "visible", timeout: 30000 });
      await numberInput.click();
      await numberInput.pressSequentially(CARD_NUMBER, { delay: 50 });
      console.log(
        "✓ Card number field filled (value is encrypted, not readable)",
      );

      // maxlength="5" — the "/" is auto-inserted, so digits only.
      const expiryInput = await resolveSecuredField(
        "encryptedExpiryDate",
        "Expiry date",
      );
      await expiryInput.waitFor({ state: "visible", timeout: 30000 });
      await expiryInput.click();
      await expiryInput.pressSequentially(CARD_EXPIRY, { delay: 50 });
      console.log("✓ Expiry field filled (value is encrypted, not readable)");

      // encryptedSecurityCode — confirmed by data-cse on the third field's span.
      const cvcInput = await resolveSecuredField(
        "encryptedSecurityCode",
        "Security code",
      );
      await cvcInput.waitFor({ state: "visible", timeout: 30000 });
      await cvcInput.click();
      await cvcInput.pressSequentially(CARD_CVC, { delay: 50 });
      console.log("✓ CVC field filled (value is encrypted, not readable)");

      console.log("✓ All card fields filled");

      console.log("Waiting for card details to register before submitting...");
      await page.waitForTimeout(4000);
      console.log("✓ Wait complete");

      // The error-text spans are the only signal the fields were accepted —
      // present but empty and aria-hidden until a field is rejected. This
      // substitutes for the inputValue() readbacks Westpac can do. Scoped to the
      // popup frame, since that's where the Drop-in chrome lives.
      const fieldErrors = (
        await dropinFrame
          .locator(".adyen-checkout__error-text")
          .allInnerTexts()
          .catch(() => [])
      )
        .map((t) => t.trim())
        .filter(Boolean);

      if (fieldErrors.length) {
        throw new Error(
          `Adyen rejected the card details: ${JSON.stringify(fieldErrors)}`,
        );
      }
      console.log("✓ No field validation errors reported");

      // No click here on purpose: submitCardPayment() runs immediately after this
      // and owns the click, so clicking here too would submit twice.
      const payButton = dropinFrame.locator(".adyen-checkout__button--pay");
      await payButton.waitFor({ state: "visible", timeout: 30000 });
      console.log(
        `✓ Found the enabled Pay button: "${(await payButton.innerText()).trim().replace(/\s+/g, " ")}" — ready to click`,
      );
    },

    submitCardPayment: async (page) => {
      console.log("Attempting to click Adyen 'Pay' button...");

      // Checked before anything else because submitCardPayment is called directly
      // by CheckoutPage and can't assume fillCardDetails just ran.
      if (paymentAlreadyCompleted(page)) {
        console.log(
          `✓ Payment already went through — at "${page.url()}". Nothing to click.`,
        );
        return;
      }

      // Frame handles can't cross calls, so the popup frame is re-resolved here.
      const resolveDropinFrame = async (timeout = 45000) => {
        const deadline = Date.now() + timeout;
        while (Date.now() < deadline) {
          for (const frame of page.frames()) {
            if (frame.url().includes("securedfields")) continue;
            const found = await frame
              .locator(".adyen-checkout__button--pay")
              .count()
              .catch(() => 0);
            if (found) {
              const where =
                frame === page.mainFrame() ? "top-level page" : frame.url();
              console.log(`✓ Pay button's host frame: ${where}`);
              return frame;
            }
          }
          await page.waitForTimeout(500);
        }
        throw new Error(
          `Adyen Pay button not found in the page or any frame.\n` +
            `URL: "${page.url()}"\n` +
            `Buttons present, per frame:\n${await describeSubmitButtons(page)}`,
        );
      };

      const dropinFrame = await resolveDropinFrame();
      const button = dropinFrame.locator(".adyen-checkout__button--pay");
      await button.waitFor({ state: "visible", timeout: 30000 });

      const urlBeforeClick = page.url();
      await button.scrollIntoViewIfNeeded();

      // Real mouse movement + click, using the button's actual bounding box
      // coordinates — moves the mouse there in steps (like a human dragging the
      // cursor) then does a genuine mouse down/up, rather than a synthetic/forced
      // click. This produces trusted OS-level input events. boundingBox() returns
      // main-viewport coordinates even for a nested frame, so this works through
      // both iframe layers.
      const box = await button.boundingBox();

      if (box) {
        const targetX = box.x + box.width / 2;
        const targetY = box.y + box.height / 2;

        console.log(
          `Moving mouse to (${Math.round(targetX)}, ${Math.round(targetY)})...`,
        );
        await page.mouse.move(targetX, targetY, { steps: 25 });
        await page.waitForTimeout(200);
        await page.mouse.down();
        await page.waitForTimeout(100);
        await page.mouse.up();
        console.log("Clicked 'Pay' (attempt 1: real mouse move + click)");
      } else {
        console.log(
          "⚠ Could not get bounding box — falling back to element click()",
        );
        await button.click({ force: true });
      }

      // ---- 3DS2 challenge (CONDITIONAL) ----
      // Adyen renders 3DS2 in a THIRD iframe layer inside the popup, so unlike
      // Westpac the top-level URL may not change at all — progress is measured by
      // that frame attaching, not by navigation. Frictionless authentication
      // skips the challenge entirely, hence poll-and-skip rather than a wait.
      const findChallenge = async (timeout = 25000) => {
        const deadline = Date.now() + timeout;
        while (Date.now() < deadline) {
          for (const frame of page.frames()) {
            if (frame === page.mainFrame()) continue;
            // Skip the three card-field frames — always attached, and a loose
            // regex would otherwise match one of them.
            if (frame.url().includes("securedfields")) continue;
            if (/threeds|3ds|challenge/i.test(frame.url())) {
              console.log(`✓ 3DS2 challenge iframe found: ${frame.url()}`);
              return frame;
            }
          }
          if (page.url() !== urlBeforeClick) {
            console.log(
              `✓ Page left the card form — no challenge iframe needed ("${page.url()}")`,
            );
            return null;
          }
          await page.waitForTimeout(500);
        }
        return null;
      };

      const challengeFrame = await findChallenge();

      if (challengeFrame) {
        // "password" is the answer for Adyen's 3DS2 test ACS.
        const answerInput = challengeFrame.locator(
          'input[type="password"], input[name="answer"], input#username',
        );

        if (
          await answerInput
            .first()
            .isVisible({ timeout: 15000 })
            .catch(() => false)
        ) {
          await answerInput.first().click();
          await answerInput
            .first()
            .pressSequentially("password", { delay: 50 });
          console.log("✓ 3DS2 challenge answer entered");

          // Located via the challenge frame, not page — the button doesn't exist
          // in the top-level document.
          await challengeFrame
            .locator('button[type="submit"], input[type="submit"]')
            .first()
            .click();
          console.log("✓ Submitted the 3DS2 challenge");
        } else {
          console.log(
            "⚠ Challenge iframe attached but no answer field found — dump its DOM to add the selectors",
          );
        }
      } else {
        console.log("No 3DS2 challenge appeared — frictionless authentication");
      }

      // Generous window on purpose: the Drop-in encrypts, posts to the processor,
      // and resolves 3DS before the page navigates. A short wait here would call
      // a perfectly good click a failure.
      if (await waitForSubmissionToTakeEffect(page, urlBeforeClick, 30000)) {
        console.log(
          "✓ Page left the card form after click — payment submitted",
        );
        return;
      }

      console.log(
        "⚠ Still on the card form after the real click — trying native JS click...",
      );

      // Dispatched via the Locator, NOT page.evaluate() — locator.evaluate() runs
      // in the frame that owns the element, whereas page.evaluate() runs in the
      // top-level frame, where this button doesn't exist at all.
      await button
        .evaluate((el) => el.click())
        .catch((err) => {
          console.log(`⚠ Native JS click failed: ${err.message}`);
        });

      if (await waitForSubmissionToTakeEffect(page, urlBeforeClick, 20000)) {
        console.log(
          "✓ Page left the card form after JS click — payment submitted",
        );
        return;
      }

      // The Drop-in reports processor-side declines in its own status element
      // rather than navigating, so surface that before blaming the click.
      const dropinStatus = (
        await dropinFrame
          .locator(".adyen-checkout__status, #adyen-error")
          .first()
          .innerText()
          .catch(() => "")
      ).trim();

      throw new Error(
        `Clicked Adyen 'Pay' (both real mouse click and native JS click) but the page never left "${urlBeforeClick}" — the click isn't triggering submission.\n` +
          (dropinStatus ? `Drop-in status text: "${dropinStatus}"\n` : "") +
          `Buttons present, per frame:\n${await describeSubmitButtons(page)}`,
      );
    },
  },

  AmwalPay: {
    fillCardDetails: async (page) => {
      console.log("Waiting for the AmwalPay card form...");

      // AmwalPay's checkout is an Angular app (the _ngcontent-ng-c… attributes
      // in its markup) that the store embeds as an overlay, so the fields can
      // land either in the main document or inside AmwalPay's iframe depending
      // on how the SDK mounts. waitForFrameWithSelector() scans page.frames(),
      // which INCLUDES the main frame, so one call covers both without caring
      // which host serves the form — its URL carries a per-session token and
      // has no stable substring to match on anyway.
      const formFrame = await waitForFrameWithSelector(
        page,
        "#CardNumber",
        60000,
      );
      console.log(`✓ AmwalPay card form found in frame: ${formFrame.url()}`);

      // Overridable because AmwalPay's sandbox card set is issued per merchant
      // account: drop AMWALPAY_TEST_CARD_NUMBER / _EXPIRY / _CVV in .env to use
      // the numbers issued for this terminal instead.
      const CARD_NUMBER =
        process.env.AMWALPAY_TEST_CARD_NUMBER || "4242424242424242";
      const CARD_EXPIRY = process.env.AMWALPAY_TEST_CARD_EXPIRY || "12/30";
      const CARD_CVV = process.env.AMWALPAY_TEST_CARD_CVV || "123";
      const CARD_HOLDER = "Test Card";
      const EMAIL = process.env.PAYLEXER_TEST_EMAIL || "test@example.com";

      /**
       * Types into one of the form's inputs and confirms the value stuck.
       *
       * pressSequentially, not fill(): every field on this form carries a
       * keystroke-driven Angular directive — appnumbersonly on the card number
       * and CVV, appnumbersandslashonly on the expiry, applanguagemask on the
       * holder name — and fill() sets .value in one shot without firing the
       * keypress handlers those directives listen on. The reactive form would
       * stay ng-pristine/ng-invalid and the Pay button would never enable.
       */
      const typeField = async (
        selector,
        label,
        value,
        { optional = false } = {},
      ) => {
        const input = formFrame.locator(selector).first();

        try {
          await input.waitFor({
            state: "visible",
            timeout: optional ? 5000 : 30000,
          });
        } catch {
          if (optional) {
            console.log(
              `↷ Optional field "${label}" (${selector}) not rendered — skipping`,
            );
            return;
          }
          throw new Error(
            `AmwalPay's card form never rendered the required field "${label}" (${selector}) ` +
              `within 30000ms — form frame is "${formFrame.url()}".`,
          );
        }

        await input.click();
        await input.fill("");
        await input.pressSequentially(value, { delay: 80 });

        // Digits-only comparison: the card-number directive inserts its own
        // grouping spaces (hence maxlength="19" for a 16-digit card) and the
        // expiry directive supplies the "/", so the literal strings differ
        // from what was typed even on a perfectly filled field.
        await waitForFieldValue(page, input, `AmwalPay ${label}`, value);
      };

      // Contact block first — it sits above the payment block and carries no
      // required-flag, so it is filled but not insisted on.
      await typeField('input[name="Email"]', "Email", EMAIL, {
        optional: true,
      });

      await typeField('input[name="CardName"]', "Name on card", CARD_HOLDER);
      await typeField("#CardNumber", "Card number", CARD_NUMBER);
      await typeField("#CardExpiration", "Expiry", CARD_EXPIRY);
      await typeField("#CardCvv", "CVV", CARD_CVV);

      // "Save Card for Future Payments" is left off: the run should exercise a
      // plain one-off charge, and a saved card changes what the gateway sends
      // back on the next run against the same terminal.

      // The form's own verdict, read off the button rather than guessed at: the
      // Pay button ships with disabled="" and Angular only clears it once every
      // required control is valid. If it is still disabled here, a directive
      // rejected something and clicking would be a no-op.
      const payButton = formFrame.locator("button.pay-now-btn").first();
      const enabledDeadline = Date.now() + 15000;
      let payEnabled = false;

      while (Date.now() < enabledDeadline) {
        payEnabled = await payButton.isEnabled().catch(() => false);
        if (payEnabled) break;
        await page.waitForTimeout(300);
      }

      if (!payEnabled) {
        const invalid = await formFrame
          .locator("form.card-form input.ng-invalid")
          .evaluateAll((els) =>
            els.map((el) => el.getAttribute("name") || el.id),
          )
          .catch(() => []);

        throw new Error(
          `AmwalPay's "Pay" button was still disabled 15000ms after the card was filled — the ` +
            `Angular form considers ${
              invalid.length
                ? `these controls invalid: ${invalid.join(", ")}`
                : "the form invalid"
            }. Card "${CARD_NUMBER}" may not be a valid test card for terminal ` +
            `${process.env.AMWALPAY_TERMINAL_ID || "(unset)"} — set AMWALPAY_TEST_CARD_NUMBER.`,
        );
      }

      console.log("✓ All AmwalPay card fields filled and 'Pay' is enabled");

      // No click here on purpose: submitCardPayment() runs next and owns it.
    },

    submitCardPayment: async (page) => {
      console.log("Submitting AmwalPay payment...");

      if (paymentAlreadyCompleted(page)) {
        console.log(
          `✓ Payment already went through — at "${page.url()}". Nothing to click.`,
        );
        return;
      }

      // Re-resolved rather than carried over from fillCardDetails(): the two
      // hooks are separate calls from CheckoutPage, and the overlay re-mounts
      // its frame on some validation paths, which would leave a stale handle.
      const formFrame = await waitForFrameWithSelector(
        page,
        "button.pay-now-btn",
        30000,
      );
      const payButton = formFrame.locator("button.pay-now-btn").first();

      await payButton.scrollIntoViewIfNeeded().catch(() => {});

      // The label is "Pay <inline rial SVG> 3,300.000" — the currency is drawn
      // as an <svg>, so innerText gives "Pay 3,300.000" with no currency code.
      const label = (await payButton.innerText().catch(() => ""))
        .replace(/\s+/g, " ")
        .trim();
      const enabled = await payButton.isEnabled().catch(() => false);
      console.log(`[state] Pay button reads: "${label}" (enabled: ${enabled})`);

      const urlBeforeClick = page.url();
      await payButton.click();
      console.log("✓ AmwalPay 'Pay' clicked");

      // ---- Settle ----
      // The overlay authorises over XHR and only then redirects out to
      // PayLexer's callback, so a declined card produces NO navigation at all —
      // a URL-only wait would sit out the full timeout on a payment that had
      // already failed. Both outcomes are polled together, and the window is
      // generous because OmanNet/Visa sandbox cards routinely step up to 3DS.
      const deadline = Date.now() + 120000;

      while (Date.now() < deadline) {
        if (await waitForSubmissionToTakeEffect(page, urlBeforeClick, 500)) {
          console.log(
            `✓ AmwalPay submission took effect — now on: ${page.url()}`,
          );
          return;
        }

        // AmwalPay renders failures as an in-overlay banner and its field-level
        // messages stay inside the form frame, so both are read from there.
        const errors = (
          await formFrame
            .locator(
              '.error-message, .alert-danger, [role="alert"], .invalid-feedback',
            )
            .allTextContents()
            .catch(() => [])
        )
          .map((t) => t.replace(/\s+/g, " ").trim())
          .filter(Boolean);

        if (errors.length) {
          throw new Error(
            `AmwalPay rejected the payment: "${errors.join(" | ")}"`,
          );
        }
      }

      throw new Error(
        `AmwalPay neither completed nor reported an error within 120000ms of the submit — still ` +
          `on "${page.url()}". If a 3DS/OTP step appeared, this card needs one and the test flow ` +
          `has no way to answer it.\n${await describeSubmitButtons(page)}`,
      );
    },
  },

  DOKU: {
    fillCardDetails: async (page) => {
      console.log("Filling DOKU card details (full-page redirect)...");

      await waitForUrlPrefix(
        page,
        "https://staging.doku.com/checkout-link-v2/payment/page",
        60000,
      );
      console.log(`✓ DOKU checkout reached: ${page.url()}`);

      // VERIFY THIS CARD NUMBER against DOKU's sandbox documentation — DOKU
      // publishes its own accepted test set and nothing in the form's markup
      // hints at it, unlike Xendit which puts its test card in the placeholder.
      // If the Pay Now button never enables, or DOKU rejects the card, this
      // constant is the first thing to change.
      //
      // Expiry MONTH stays fixed, YEAR is computed (current year + 3) so it can
      // never drift into the past.
      const CARD_NUMBER = "	4617006911111130";
      const CARD_CVV = "123";
      const CARD_EXPIRY_MONTH = "02";
      const CARD_EXPIRY_YEAR = String(
        (new Date().getFullYear() + 3) % 100,
      ).padStart(2, "0");

      console.log(`Using fixed test card ending in ${CARD_NUMBER.slice(-4)}`);
      console.log(
        `Expiry set to ${CARD_EXPIRY_MONTH}/${CARD_EXPIRY_YEAR} (always current year + 3)`,
      );

      // -- Expand the Cards accordion panel ---------------------------------
      // Targeted by aria-controls, which names the panel it opens. The visible
      // label "Cards" would also work but the accordion holds several channels
      // and a text match is the weaker discriminator of the two.
      const cardsToggle = page.locator(
        'button[aria-controls="panel-CREDIT_CARD"]',
      );
      await cardsToggle.waitFor({ state: "visible", timeout: 45000 });
      await cardsToggle.scrollIntoViewIfNeeded();
      await cardsToggle.click();
      console.log("✓ Cards accordion panel clicked");

      // -- Card number ------------------------------------------------------
      // Each field is clicked immediately before typing into it.
      //
      // pressSequentially rather than fill() throughout: this is an Angular form
      // (ng-untouched ng-pristine ng-invalid on every input) that validates off
      // keypress events, and the CVV carries mask="0009" which is also
      // keystroke-driven. fill() sets the value without firing those events,
      // leaving the model pristine and the Pay Now button dead.
      const cardNumberInput = page.locator("#h2h-cc-card-number-input");
      await cardNumberInput.waitFor({ state: "visible", timeout: 30000 });
      await cardNumberInput.click();
      await cardNumberInput.pressSequentially(CARD_NUMBER, { delay: 50 });
      const cardNumberValue = await cardNumberInput.inputValue();
      console.log(`✓ Card number field now contains: "${cardNumberValue}"`);

      // -- Expiry -----------------------------------------------------------
      // Placeholder is "mm / yy" — SPACES around the separator, like Moyasar and
      // unlike Square's bare "MM/YY". Only the four digits are typed and the
      // result verified, because a mask that didn't fire leaves "0229" in a
      // field DOKU rejects.
      const expiryInput = page.locator("#h2h-cc-card-expiry-date-input");
      await expiryInput.waitFor({ state: "visible", timeout: 30000 });
      await expiryInput.click();
      await expiryInput.pressSequentially(
        `${CARD_EXPIRY_MONTH}${CARD_EXPIRY_YEAR}`,
        { delay: 50 },
      );
      let expiryValue = await expiryInput.inputValue();

      if (!expiryValue.includes("/")) {
        console.log(
          `⚠ Expiry mask did not insert a separator (field reads "${expiryValue}") — retyping explicitly`,
        );
        await expiryInput.fill("");
        await expiryInput.click();
        await expiryInput.pressSequentially(
          `${CARD_EXPIRY_MONTH} / ${CARD_EXPIRY_YEAR}`,
          { delay: 50 },
        );
        expiryValue = await expiryInput.inputValue();
      }
      console.log(`✓ Expiry field now contains: "${expiryValue}"`);

      // -- CVV --------------------------------------------------------------
      // type="password" does NOT hide the value from Playwright — inputValue()
      // returns real content, same as eWAY's and Xendit's CVV fields, so the
      // readback below is meaningful. maxlength=4 with mask="0009" accommodates
      // a 4-digit Amex code.
      const cvvInput = page.locator("#h2h-cc-card-cvv-input");
      await cvvInput.waitFor({ state: "visible", timeout: 30000 });
      await cvvInput.click();
      await cvvInput.pressSequentially(CARD_CVV, { delay: 50 });
      const cvvValue = await cvvInput.inputValue();
      console.log(`✓ CVV field now contains: "${cvvValue}"`);

      // The installment dropdown is deliberately untouched: it ships with a
      // disabled attribute reading "Select option tenor", and its only menu item
      // is "Full Payment", which is the default we want.

      console.log("✓ All card fields filled — readback values logged above");

      // The Pay Now button ships disabled="" and only enables once the whole
      // Angular form validates, so waiting for it confirms everything above was
      // accepted. This is a better gate than the ng-valid class: DOKU does bind
      // validators here (the inputs start ng-invalid rather than ng-valid, unlike
      // Authorize.Net where an empty field reported ng-valid), but the button
      // reflects the form as a whole rather than one field.
      console.log("Waiting for the Pay Now button to enable...");
      await page
        .locator("#h2h-cc-form-submit-button:not([disabled])")
        .waitFor({ state: "visible", timeout: 30000 });
      console.log("✓ Pay Now button enabled — form validated");

      // No click here on purpose: submitCardPayment() runs immediately after
      // this and owns the click.
    },

    submitCardPayment: async (page) => {
      console.log("Clicking DOKU 'Pay Now' button...");

      // Selected by STATE as well as id — the button is disabled until the form
      // validates, so an unqualified selector can match a dead element.
      //
      // NOTE this is type="button", not type="submit", despite sitting inside a
      // <form> — so there is no requestSubmit fallback to reach for here. DOKU
      // handles submission through its own Angular click handler.
      const button = page.locator("#h2h-cc-form-submit-button:not([disabled])");
      await button.waitFor({ state: "visible", timeout: 30000 });
      await button.scrollIntoViewIfNeeded();
      await button.click();

      console.log("✓ Pay Now clicked");
    },
  },

  Fatora: {
    fillCardDetails: async (page) => {
      console.log("Waiting for the Fatora hosted payment page...");

      // Fatora hands off to MyFatoorah/Maktapp's hosted page. The paymentID
      // query string is per-session, so only the stable path prefix is matched.
      await waitForUrlPrefix(
        page,
        "https://maktapp.credit/pay/MCPaymentPage",
        45000,
      );
      console.log(`✓ Fatora payment page found: ${page.url()}`);

      // The hosted test page arrives with the card number and expiry already
      // filled in — CVV is the only field the tester supplies. Fixed 3 digits:
      // the input carries maxlength="3" and a digits-only keypress guard.
      const CARD_CVC = "123";

      const cvvInput = page.locator("#Cvv2");
      await cvvInput.waitFor({ state: "visible", timeout: 45000 });
      await cvvInput.click();

      // pressSequentially, not fill(): the field's onkeypress isNumber() guard
      // is keystroke-driven, and fill() sets the value without firing it.
      await cvvInput.pressSequentially(CARD_CVC, { delay: 100 });

      const cvvValue = await cvvInput.inputValue();
      console.log(`✓ CVV field now contains ${cvvValue.length} digit(s)`);

      if (cvvValue !== CARD_CVC) {
        throw new Error(
          `Fatora CVV field holds ${cvvValue.length} digit(s) after typing ${CARD_CVC.length} — ` +
            `the field is rejecting or truncating input. #Cvv2 is maxlength="3" and digits-only.`,
        );
      }

      // No click here on purpose: submitCardPayment() runs next and owns it.
    },

    submitCardPayment: async (page) => {
      console.log("Submitting Fatora payment...");

      const payButton = page.locator("#btnPay");
      await payButton.waitFor({ state: "visible", timeout: 30000 });
      await payButton.scrollIntoViewIfNeeded();

      const buttonText = (await payButton.innerText().catch(() => ""))
        .replace(/\s+/g, " ")
        .trim();
      console.log(`[state] Pay button reads: "${buttonText}"`);

      const urlBeforeClick = page.url();

      // type="button" with an onclick="return PayNow();" — the click runs JS
      // that posts and then redirects, so there is no form submit to await.
      await payButton.click();
      console.log("✓ 'Pay' clicked");

      const moved = await waitForSubmissionToTakeEffect(
        page,
        urlBeforeClick,
        60000,
      );

      if (!moved) {
        throw new Error(
          `Fatora payment page did not navigate within 60000ms of clicking #btnPay — still on ` +
            `"${page.url()}". PayNow() likely failed validation on the hosted page.\n` +
            `${await describeSubmitButtons(page)}`,
        );
      }

      console.log(`✓ Fatora submission took effect — now on: ${page.url()}`);
    },
  },

  Checkout: {
    fillCardDetails: async (page) => {
      console.log("Filling Checkout.com hosted payment page (HPP)...");

      // URL is https://pay.sandbox.checkout.com/page/hpp_<id> — the HPP id is
      // per-session, so only the fixed prefix matches.
      await waitForUrlPrefix(page, "https://pay.sandbox.checkout.com/page/");

      const CARD_HOLDER = "Token Tutorial";
      const CARD_NUMBER = "4242424242424242"; // Checkout.com sandbox Visa (3DS-enrolled)
      const CARD_CVV = "100";
      // Same convention as the other gateways: fixed month, current year + 3.
      // #card-expiry-date is a single MM/YY field, not two selects.
      const EXPIRY_MONTH = "02";
      const EXPIRY_YY = String((new Date().getFullYear() + 3) % 100).padStart(
        2,
        "0",
      );

      // All four fields share class="fotwrsk", so they live in one document.
      const resolveField = async (selector, label, timeout = 45000) => {
        const deadline = Date.now() + timeout;
        while (Date.now() < deadline) {
          if (await page.locator(selector).count()) {
            console.log(`[scope] ${label}: main page`);
            return page.locator(selector).first();
          }
          for (const frame of page.frames()) {
            if (frame === page.mainFrame()) continue;
            const found = await frame
              .locator(selector)
              .count()
              .catch(() => 0);
            if (found) {
              console.log(`[scope] ${label}: ${frame.url()}`);
              return frame.locator(selector).first();
            }
          }
          await page.waitForTimeout(500);
        }
        throw new Error(
          `Checkout.com ${label} ("${selector}") not found. URL: "${page.url()}". ` +
            `Frames: ${JSON.stringify(page.frames().map((f) => f.url()))}`,
        );
      };

      // Each field is clicked to focus it before typing — the HPP mounts the
      // next field only once the previous one has been focused and filled, so
      // typing without the click leaves the rest hidden.
      const clickAndType = async (selector, label, value) => {
        const input = await resolveField(selector, label);
        await input.waitFor({ state: "visible", timeout: 30000 });
        await input.scrollIntoViewIfNeeded();
        await input.click();
        await input.pressSequentially(value, { delay: 50 });
        return input;
      };

      // The card fields attach lazily, so give the HPP a beat before resolving.
      await page.waitForTimeout(3000);

      const holderInput = await clickAndType(
        "#cardholder-name",
        "cardholder name",
        CARD_HOLDER,
      );
      console.log(
        `✓ Cardholder field now contains: "${await holderInput.inputValue()}"`,
      );

      const numberInput = await clickAndType(
        "#card-number",
        "card number",
        CARD_NUMBER,
      );
      // pattern="[0-9 ]+" — the field groups digits in fours, so the value
      // reads back spaced.
      console.log(
        `✓ Card number field now contains: "${await numberInput.inputValue()}"`,
      );

      // The "/" is auto-inserted — send digits only, or the separator eats one
      // of the year characters.
      const expiryInput = await clickAndType(
        "#card-expiry-date",
        "expiry date",
        `${EXPIRY_MONTH}${EXPIRY_YY}`,
      );

      if (!/^\d{2}\s*\/\s*\d{2}$/.test(await expiryInput.inputValue())) {
        console.log(
          `⚠ Expiry looks unmasked ("${await expiryInput.inputValue()}") — retyping with separator...`,
        );
        await expiryInput.fill("");
        await expiryInput.click();
        await expiryInput.pressSequentially(`${EXPIRY_MONTH}/${EXPIRY_YY}`, {
          delay: 50,
        });
      }
      console.log(
        `✓ Expiry field now contains: "${await expiryInput.inputValue()}"`,
      );

      const cvvInput = await clickAndType("#card-cvv", "CVV", CARD_CVV);
      console.log(
        `✓ CVV field now holds ${(await cvvInput.inputValue()).length} character(s)`,
      );

      // Straight after the CVV. Wait only — the click belongs to
      // submitCardPayment (same split as PayWay). The label carries the amount
      // ("Pay US$3,300.00"), which is logged below to confirm the currency and
      // total the gateway actually received.
      const payButton = await resolveField(CHECKOUT_PAY_BUTTON, "Pay button");
      await payButton.waitFor({ state: "visible", timeout: 30000 });
      console.log(
        `✓ Pay button ready: "${(await payButton.innerText()).trim().replace(/\s+/g, " ")}"`,
      );

      console.log("✓ All Checkout.com fields filled");
    },

    submitCardPayment: async (page) => {
      console.log("Attempting Checkout.com three-step submission...");

      if (paymentAlreadyCompleted(page)) {
        console.log(
          `✓ Payment already went through — at "${page.url()}". Nothing to click.`,
        );
        return;
      }

      const CHALLENGE_PASSWORD = "Checkout1!";
      // The 3DS challenge is served INSIDE AN IFRAME on the HPP, at the same
      // top-level URL. So none of this flow can key off page.url() changing —
      // presence and absence of the challenge form is the progress signal.
      const CHALLENGE_FORM =
        'form#form[action="/simulator/acs/challenge-submit"]';

      // Frame handles can't cross calls, so re-resolve here.
      const resolveField = async (selector, label, timeout = 45000) => {
        const deadline = Date.now() + timeout;
        while (Date.now() < deadline) {
          if (await page.locator(selector).count()) {
            console.log(`[scope] ${label}: main page`);
            return page.locator(selector).first();
          }
          for (const frame of page.frames()) {
            if (frame === page.mainFrame()) continue;
            const found = await frame
              .locator(selector)
              .count()
              .catch(() => 0);
            if (found) {
              console.log(`[scope] ${label}: ${frame.url()}`);
              return frame.locator(selector).first();
            }
          }
          await page.waitForTimeout(500);
        }
        throw new Error(
          `Checkout.com ${label} ("${selector}") not found. URL: "${page.url()}". ` +
            `Frames: ${JSON.stringify(page.frames().map((f) => f.url()))}`,
        );
      };

      // True once the challenge form exists anywhere — page or frame.
      const challengePresent = async () => {
        if (
          await page
            .locator(CHALLENGE_FORM)
            .count()
            .catch(() => 0)
        )
          return true;
        for (const frame of page.frames()) {
          if (frame === page.mainFrame()) continue;
          if (
            await frame
              .locator(CHALLENGE_FORM)
              .count()
              .catch(() => 0)
          )
            return true;
        }
        return false;
      };

      // ---- Step 1: "Pay US$X" on the hosted payment page ----
      // The button whose <span> carries the amount — see CHECKOUT_PAY_BUTTON
      // for why this isn't matched on the label text alone.
      const payButton = await resolveField(CHECKOUT_PAY_BUTTON, "Pay button");
      await payButton.waitFor({ state: "visible", timeout: 30000 });

      // Progress here is the challenge appearing, OR the url leaving the HPP for
      // a non-3DS card. Explicitly NOT a plain url change: with 3DS the ACS
      // mounts in an iframe and the top-level url stays on /page/hpp_<id>, which
      // reads as failure to waitForSubmissionToTakeEffect().
      const payTookEffect = async (timeout = 45000) => {
        const deadline = Date.now() + timeout;
        while (Date.now() < deadline) {
          if (await challengePresent()) {
            console.log("[pay] progressed: 3DS challenge form present");
            return true;
          }
          if (
            !page.url().startsWith("https://pay.sandbox.checkout.com/page/")
          ) {
            console.log(`[pay] progressed: left the HPP — "${page.url()}"`);
            return true;
          }
          await page.waitForTimeout(500);
        }
        return false;
      };

      await page.mouse.move(10, 10);
      await payButton.scrollIntoViewIfNeeded();
      await payButton.click();
      console.log("✓ Clicked Checkout.com 'Pay' button");

      if (!(await payTookEffect())) {
        // Real mouse press at the element's centre. Firefox dispatches
        // synthesised clicks differently on styled-components buttons, and this
        // is closer to a manual click than el.click() is.
        console.log(
          "⚠ No progress after click — retrying with a real mouse press...",
        );
        const box = await payButton.boundingBox();
        if (box) {
          await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        }

        if (!(await payTookEffect(30000))) {
          console.log("⚠ Still nothing — trying native JS click...");
          await payButton
            .evaluate((el) => el.click())
            .catch((err) => {
              console.log(`⚠ Native JS click failed: ${err.message}`);
            });
        }

        if (!(await payTookEffect(30000))) {
          // Validation errors are the other reason Pay no-ops: the fields were
          // filled in a separate call, and anything the HPP rejects surfaces as
          // aria-invalid plus visible text rather than as a failed click.
          const invalid = await page
            .locator('[aria-invalid="true"]')
            .evaluateAll((els) => els.map((el) => el.id || el.name))
            .catch(() => []);

          await page.screenshot({
            path: "test-results/checkout-pay-noop.png",
            fullPage: true,
          });

          throw new Error(
            `Clicked the Checkout.com 'Pay' button but nothing advanced — still at ` +
              `"${page.url()}" with no 3DS challenge. ` +
              `Invalid fields: ${JSON.stringify(invalid)}. ` +
              `Frames: ${JSON.stringify(page.frames().map((f) => f.url()))}. ` +
              `Screenshot: test-results/checkout-pay-noop.png`,
          );
        }
      }
      console.log("✓ Pay accepted");

      // ---- Step 2: 3D-Secure 2 sandbox challenge ----
      // Plain server-rendered form inside the iframe:
      //   <form id="form" method="post" action="/simulator/acs/challenge-submit">
      // It carries a hidden transactionId the POST needs, so everything below is
      // scoped to the form and submission goes through the form itself.
      //
      // pressSequentially, NOT fill(). The page gates its Continue button on key
      // events — fill() sets the value and fires input/change only, so a
      // keyup-driven handler never runs: the field reads back empty, the border
      // turns red, and Continue stays greyed out.
      const challengeForm = await resolveField(
        CHALLENGE_FORM,
        "3DS challenge form",
        60000,
      );
      await challengeForm.waitFor({ state: "visible", timeout: 30000 });

      const passwordInput = challengeForm.locator(
        'input#password[name="password"]',
      );
      await passwordInput.waitFor({ state: "visible", timeout: 30000 });
      await passwordInput.scrollIntoViewIfNeeded();
      await passwordInput.click();
      // Clear via keyboard too — fill("") would leave the same handlers unfired.
      await passwordInput.press("Control+a");
      await passwordInput.press("Delete");
      await passwordInput.pressSequentially(CHALLENGE_PASSWORD, { delay: 80 });

      // Verified before Continue is clicked: submitting the challenge with an
      // empty password fails the payment on the gateway's side, which surfaces
      // much later as a confusing "payment declined" rather than as this step.
      // inputValue() returns the real value for type="password" — it's only
      // masked visually.
      const passwordEntered = await passwordInput.inputValue().catch(() => "");

      if (passwordEntered !== CHALLENGE_PASSWORD) {
        throw new Error(
          `The 3DS password field never took "${CHALLENGE_PASSWORD}" — it reads ` +
            `"${passwordEntered}" (${passwordEntered.length} chars). ` +
            `URL: "${page.url()}"`,
        );
      }

      console.log(
        `✓ 3DS password entered (${passwordEntered.length} characters)`,
      );

      // ---- Step 3: "Continue" on the 3DS challenge ----
      // Matched on the id alone, scoped to the form. Its class is unstable
      // across renders (plain "btn" in one, "btn btn-blue" repeated five times
      // in another), and value="Continue" is the visible LABEL — it changes if
      // the ACS page is ever served in another language, whereas the id doesn't.
      const continueButton = challengeForm.locator("#txtButton");
      await continueButton.waitFor({ state: "visible", timeout: 30000 });

      // Progress is the challenge form going away — the POST happens inside the
      // iframe, so the top-level url may not move until the ACS hands back to
      // the merchant, and it may never move on this page at all.
      const challengeCleared = async (timeout = 60000) => {
        const deadline = Date.now() + timeout;
        while (Date.now() < deadline) {
          if (!(await challengePresent())) {
            console.log(`[3ds] challenge cleared — now at "${page.url()}"`);
            return true;
          }
          await page.waitForTimeout(500);
        }
        return false;
      };

      await continueButton.scrollIntoViewIfNeeded();
      await continueButton.click();
      console.log("✓ Clicked 'Continue' on the 3DS challenge");

      if (!(await challengeCleared())) {
        // Enter in the password field submits natively and fires the same key
        // handlers the button relies on.
        console.log(
          "⚠ Challenge still showing after click — pressing Enter in the password field...",
        );
        await passwordInput.press("Enter");

        if (!(await challengeCleared(30000))) {
          // No onsubmit handler on this form, so requestSubmit() posts to
          // /simulator/acs/challenge-submit exactly as the click does.
          console.log("⚠ Enter had no effect — calling requestSubmit()...");
          await challengeForm
            .evaluate((form) => form.requestSubmit())
            .catch((err) => {
              console.log(`⚠ requestSubmit() failed: ${err.message}`);
            });

          if (!(await challengeCleared(30000))) {
            await page.screenshot({
              path: "test-results/checkout-3ds-stuck.png",
              fullPage: true,
            });
            throw new Error(
              `Submitted the 3DS challenge but it never cleared. URL: "${page.url()}". ` +
                `Frames: ${JSON.stringify(page.frames().map((f) => f.url()))}. ` +
                `Screenshot: test-results/checkout-3ds-stuck.png`,
            );
          }
        }
      }

      // Only now does a top-level navigation happen — the ACS result hands back
      // to the merchant. Bounded and swallowed: on some sandbox configs the
      // return happens via the parent frame and the url has already settled.
      await page
        .waitForLoadState("networkidle", { timeout: 30000 })
        .catch(() => {});

      console.log(`✓ Checkout.com payment submitted — now at "${page.url()}"`);
    },
  },
  //5th

  Culqi: {
    // Culqi sandbox test card.
    TEST_CARD_NUMBER: "4111111111111111",
    TEST_CVV: "123",
    TEST_EMAIL: "qa@yopmail.com",

    async fillCardDetails(page, card = {}) {
      // House convention: month 02, year = current year + 3.
      const expiryMonth = "02";
      const expiryYearShort = String(new Date().getFullYear() + 3).slice(-2);
      const expiryCombined = `${expiryMonth}${expiryYearShort}`;

      // ---- Resolve the context holding the Culqi checkout ----
      // Culqi may render inline or inside its own iframe depending on the
      // integration mode, so search the main frame and all children rather than
      // assuming either.
      console.log("[Culqi] Locating the Culqi checkout form...");

      let ctx = null;
      const deadline = Date.now() + 90000;
      while (Date.now() < deadline) {
        for (const frame of page.frames()) {
          const found = await frame
            .locator("#cardNum")
            .count()
            .then((c) => c > 0)
            .catch(() => false);
          if (found) {
            ctx = frame;
            break;
          }
        }
        if (ctx) break;
        await page.waitForTimeout(500);
      }

      if (!ctx) {
        const urls = page.frames().map((f) => f.url());
        throw new Error(
          `[Culqi] Checkout form never appeared. Frames present: ${JSON.stringify(urls)}`,
        );
      }

      console.log(
        `[Culqi] Form found in: ${ctx === page.mainFrame() ? "main frame" : ctx.url()}`,
      );

      // Located by semantic ids (#cardNum, #cardDate, #cardCvv, #cardEmail) — these
      // are author-written and stable. The Vue scope attribute (data-v-1a95047c)
      // and Tailwind utility classes both churn on rebuild, so neither is used.
      //
      // Culqi masks the card number, expiry and CVV in the DOM: inputValue() comes
      // back as "**** **** **** ****" rather than the digits. Each masked field has
      // a sibling eye-toggle button that reveals the real value, so validation
      // reveals first and falls back to a mask-shape check if the toggle misbehaves.
      const fillField = async (selector, label, value, expectDigits = true) => {
        const input = ctx.locator(selector);
        console.log(`[Culqi] Waiting for ${label} field...`);
        await input.waitFor({ state: "visible", timeout: 30000 });
        await input.click();
        console.log(`[Culqi] Typing ${label}: ${value}`);
        // All three card fields carry a mask-pattern attribute and reformat as
        // characters arrive — pressSequentially, never fill().
        await input.pressSequentially(value, { delay: 50 });

        const norm = (s) => (expectDigits ? s.replace(/\D/g, "") : s.trim());
        let actual = await input.inputValue();

        // The reveal toggle lives in the same wrapping div.relative as the input.
        const revealButton = input
          .locator("xpath=..")
          .locator('button[type="button"]')
          .first();

        if (actual.includes("*")) {
          console.log(
            `[Culqi] "${label}" is masked ("${actual}") — clicking reveal toggle...`,
          );
          const hasToggle = await revealButton.isVisible().catch(() => false);

          if (hasToggle) {
            await revealButton.click();
            // Vue re-renders the input value on toggle; give it a beat to settle.
            await ctx
              .waitForFunction(
                (sel) => {
                  const el = document.querySelector(sel);
                  return el && !el.value.includes("*");
                },
                selector,
                { timeout: 5000 },
              )
              .catch(() => {});
            actual = await input.inputValue();
            console.log(`[Culqi] "${label}" revealed as: "${actual}"`);
          } else {
            console.log(`[Culqi] No reveal toggle found for "${label}".`);
          }
        }

        if (actual.includes("*")) {
          // Reveal did not take. Fall back to comparing the number of characters
          // entered — a mask char per digit is still meaningful confirmation that
          // the keystrokes landed, even though the digits cannot be read back.
          const maskedCount = actual.replace(/\s/g, "").length;
          const expectedCount = value.length;
          console.log(
            `[Culqi] "${label}" still masked — validating on length: ${maskedCount}/${expectedCount} characters.`,
          );
          if (maskedCount !== expectedCount) {
            throw new Error(
              `[Culqi] ${label} failed to register. Expected ${expectedCount} characters, masked field shows ${maskedCount} ("${actual}")`,
            );
          }
        } else {
          console.log(`[Culqi] "${label}" now reads: "${actual}"`);
          if (norm(actual) !== norm(value)) {
            throw new Error(
              `[Culqi] ${label} failed to register. Expected "${value}", got "${actual}"`,
            );
          }
        }

        // Re-hide if the toggle was used, so the field is left as the gateway
        // expects it before submit.
        if (await revealButton.isVisible().catch(() => false)) {
          const current = await input.inputValue();
          if (!current.includes("*")) {
            await revealButton.click().catch(() => {});
          }
        }
      };

      // ---- Card number ----
      // mask-pattern="/[0-9\ ]/" — Culqi inserts the grouping spaces itself.
      await fillField("#cardNum", "Card Number", this.TEST_CARD_NUMBER);

      // ---- Expiry (single combined MM/YY field) ----
      // Culqi inserts the slash, so type four bare digits.
      await fillField("#cardDate", "Expiry", expiryCombined);
      console.log(`[Culqi] Expiry set to ${expiryMonth}/${expiryYearShort}.`);

      // ---- CVV ----
      // type="tel", not type="password", but still masked in the DOM.
      await fillField("#cardCvv", "CVV", this.TEST_CVV);

      // ---- Email ----
      // Culqi prefills this from the booking (it arrived as lyje@mailinator.com in
      // the sample markup), so only type if it came through empty. Typing into a
      // populated masked field would concatenate. This field has no reveal toggle.
      const emailInput = ctx.locator("#cardEmail");
      await emailInput.waitFor({ state: "visible", timeout: 15000 });
      const existingEmail = (await emailInput.inputValue()).trim();

      if (existingEmail) {
        console.log(
          `[Culqi] Email prefilled from booking: "${existingEmail}" — leaving as is.`,
        );
      } else {
        console.log("[Culqi] Email empty — filling from constant.");
        await emailInput.click();
        await emailInput.pressSequentially(this.TEST_EMAIL, { delay: 50 });
        const emailValue = await emailInput.inputValue();
        console.log(`[Culqi] Email now reads: "${emailValue}"`);
        if (emailValue.trim() !== this.TEST_EMAIL) {
          throw new Error(
            `[Culqi] Email failed to register. Expected "${this.TEST_EMAIL}", got "${emailValue}"`,
          );
        }
      }

      // ---- Confirm the form considers itself valid ----
      // The Pay button ships disabled and Culqi enables it only once every field
      // passes validation, so its enabled state is the single best readiness
      // signal — better than inspecting the .info-messages-container slots, which
      // are empty comment nodes until an error fires.
      const payButton = ctx.locator("button.Culqi-Button").first();
      console.log("[Culqi] Waiting for the Pay button to become enabled...");

      const enabled = await payButton
        .waitFor({ state: "visible", timeout: 15000 })
        .then(() =>
          ctx
            .waitForFunction(
              () => {
                const btn = document.querySelector("button.Culqi-Button");
                return btn && !btn.disabled;
              },
              null,
              { timeout: 20000 },
            )
            .then(() => true)
            .catch(() => false),
        )
        .catch(() => false);

      if (!enabled) {
        // Surface whatever Culqi wrote into its message slots so the failure is
        // readable rather than a bare timeout.
        const messages = await ctx
          .locator(".info-messages-container")
          .evaluateAll((els) =>
            els.map((el) => (el.textContent || "").trim()).filter(Boolean),
          )
          .catch(() => []);
        throw new Error(
          `[Culqi] Pay button never enabled — form considers itself invalid.${
            messages.length ? ` Messages: ${messages.join(" | ")}` : ""
          }`,
        );
      }

      console.log("[Culqi] All fields filled and Pay button is enabled.");
    },

    async submitCardPayment(page) {
      // Re-resolve the context — the handle does not carry across calls.
      console.log("[Culqi] Re-resolving the Culqi checkout for submit...");

      let ctx = null;
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline) {
        for (const frame of page.frames()) {
          const found = await frame
            .locator("button.Culqi-Button")
            .count()
            .then((c) => c > 0)
            .catch(() => false);
          if (found) {
            ctx = frame;
            break;
          }
        }
        if (ctx) break;
        await page.waitForTimeout(500);
      }

      if (!ctx) {
        throw new Error(
          "[Culqi] Checkout not found when attempting to submit.",
        );
      }

      // The button label carries the live booking total (e.g. "Pay  $ 2,100.00",
      // with a double space in the source), so never anchor on exact text.
      const payButton = ctx
        .locator("button.Culqi-Button:not([disabled])")
        .first();
      await payButton.waitFor({ state: "visible", timeout: 30000 });
      await payButton.scrollIntoViewIfNeeded();

      const label = (await payButton.textContent().catch(() => ""))?.trim();
      console.log(`[Culqi] Pay button label reads: "${label}"`);

      const startUrl = page.url();
      console.log(`[Culqi] URL before submit: ${startUrl}`);

      console.log("[Culqi] Clicking Pay (attempt 1: real mouse)...");
      const box = await payButton.boundingBox();
      if (box) {
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.down();
        await page.mouse.up();
      } else {
        await payButton.click();
      }

      const submissionTook = async (ms) => {
        // The checkout detaching is the clearest signal the charge went through.
        const gone = await ctx
          .waitForFunction(() => !document.querySelector("#cardNum"), null, {
            timeout: ms,
          })
          .then(() => true)
          .catch(() => false);
        if (gone) return true;
        return page.url() !== startUrl;
      };

      let submitted = await submissionTook(30000);

      if (!submitted) {
        console.log(
          "[Culqi] No effect yet — retrying (attempt 2: native JS click)...",
        );
        await payButton.evaluate((el) => el.click()).catch(() => {});
        submitted = await submissionTook(30000);
      }

      if (!submitted) {
        console.log(
          "[Culqi] Still no effect — retrying (attempt 3: dispatched event)...",
        );
        // The <form> here has no novalidate, so requestSubmit() would run
        // constraint validation. None of the inputs carry `required`, so it would
        // likely pass — but a dispatched click on the button is the safer
        // escalation since it goes through Vue's own handler.
        await payButton
          .evaluate((el) =>
            el.dispatchEvent(
              new MouseEvent("click", { bubbles: true, cancelable: true }),
            ),
          )
          .catch(() => {});
        submitted = await submissionTook(60000);
      }

      if (!submitted) {
        const messages = await ctx
          .locator(".info-messages-container")
          .evaluateAll((els) =>
            els.map((el) => (el.textContent || "").trim()).filter(Boolean),
          )
          .catch(() => []);
        if (messages.length) {
          throw new Error(
            `[Culqi] Submission rejected: ${messages.join(" | ")}`,
          );
        }
        console.log(
          `[Culqi] WARNING: submission had no observable effect. URL still ${page.url()}`,
        );
      }

      // ---- 3DS challenge (conditional) ----
      // Culqi runs 3DS on some card/amount combinations. Poll briefly, skip if
      // absent — never block on it.
      await page.waitForTimeout(2000);
      const challenge = page
        .frames()
        .find((f) => /acs|3ds|challenge|secure/i.test(f.url()));
      if (challenge) {
        console.log(
          `[Culqi] 3DS challenge detected: ${challenge.url().split("?")[0]}`,
        );
      } else {
        console.log("[Culqi] No 3DS challenge — continuing.");
      }

      // No thank-you / success check here on purpose — same reasoning as
      // Airwallex above: the shared CheckoutPage.waitForThankYouPage() owns it.
      //
      // Worth noting what this function used to end on: a bare
      // waitForLoadState() and a URL log, with nothing asserting the payment
      // succeeded. A declined Culqi payment was therefore indistinguishable
      // from a successful one, and the run went green — which is exactly what
      // the shared check caught on its first outing ("Payment Failed —
      // Payment processing failed. Please try again.").
      await page.waitForLoadState("domcontentloaded").catch(() => {});
      console.log(`[Culqi] Post-submit URL: ${page.url()}`);
    },
  },

  Viva: {
    fillCardDetails: async (page) => {
      console.log(
        "Filling Viva Wallet checkout (full-page redirect, no iframe)...",
      );

      // URL is https://demo.vivapayments.com/web2?ref=<order-code> — the ref is
      // per-order, so only the fixed prefix matches.
      await waitForUrlPrefix(page, "https://demo.vivapayments.com/web2");

      const CARD_HOLDER = "Token Tutorial";
      const CARD_NUMBER = "4564710000000004"; // shared suite test card
      const CARD_CVV = "847";
      // Same convention as the other gateways: fixed month, current year + 3.
      // #card-expiration is a single MM/YY field (maxlength="5"), not two selects.
      const EXPIRY_MONTH = "02";
      const EXPIRY_YY = String((new Date().getFullYear() + 3) % 100).padStart(
        2,
        "0",
      );

      // Vue app — the form mounts after the initial paint, so wait for the
      // first field rather than assuming it's there on load.
      await page
        .locator("#card-holder")
        .waitFor({ state: "visible", timeout: 60000 });

      // Each field is clicked to focus it before typing. The number, expiry and
      // CVV fields are inputmode="numeric" with live formatting, so
      // pressSequentially rather than fill() — same reasoning as
      // PayWay/Omise/iyzico/Checkout.
      const clickAndType = async (selector, label, value) => {
        const input = page.locator(selector);
        await input.waitFor({ state: "visible", timeout: 30000 });
        await input.scrollIntoViewIfNeeded();
        await input.click();
        await input.pressSequentially(value, { delay: 50 });
        return input;
      };

      const holderInput = await clickAndType(
        "#card-holder",
        "cardholder name",
        CARD_HOLDER,
      );
      console.log(
        `✓ Cardholder field now contains: "${await holderInput.inputValue()}"`,
      );

      const numberInput = await clickAndType(
        "#card-number",
        "card number",
        CARD_NUMBER,
      );
      // The field groups digits in fours, so the value reads back spaced.
      console.log(
        `✓ Card number field now contains: "${await numberInput.inputValue()}"`,
      );

      // maxlength="5" means the "/" is auto-inserted — send digits only, or the
      // separator eats one of the year characters.
      const expiryInput = await clickAndType(
        "#card-expiration",
        "expiry date",
        `${EXPIRY_MONTH}${EXPIRY_YY}`,
      );

      if (!/^\d{2}\s*\/\s*\d{2}$/.test(await expiryInput.inputValue())) {
        console.log(
          `⚠ Expiry looks unmasked ("${await expiryInput.inputValue()}") — retyping with separator...`,
        );
        await expiryInput.fill("");
        await expiryInput.click();
        await expiryInput.pressSequentially(`${EXPIRY_MONTH}/${EXPIRY_YY}`, {
          delay: 50,
        });
      }
      console.log(
        `✓ Expiry field now contains: "${await expiryInput.inputValue()}"`,
      );

      const cvvInput = await clickAndType("#cvv", "CVV", CARD_CVV);
      console.log(
        `✓ CVV field now holds ${(await cvvInput.inputValue()).length} character(s)`,
      );

      // Wait only — the click belongs to submitCardPayment (same split as
      // PayWay). aria-label carries the amount ("Pay £1,600.00"), which is a
      // cheap check on the currency and total the gateway actually received.
      const payButton = page.locator("#pay-btn:not([disabled])");
      await payButton.waitFor({ state: "visible", timeout: 30000 });
      console.log(
        `✓ Pay button ready: "${await payButton.getAttribute("aria-label")}"`,
      );

      console.log("✓ All Viva Wallet fields filled");
    },

    submitCardPayment: async (page) => {
      console.log("Attempting Viva Wallet payment submission...");

      if (paymentAlreadyCompleted(page)) {
        console.log(
          `✓ Payment already went through — at "${page.url()}". Nothing to click.`,
        );
        return;
      }

      // Matched on the id, not the label text: the button's text is split
      // across five nested spans ("Pay", "£", "1,600.00"), so a text match is
      // both fragile and whitespace-dependent.
      const payButton = page.locator("#pay-btn:not([disabled])");
      await payButton.waitFor({ state: "visible", timeout: 30000 });

      const urlBeforePay = page.url();
      await page.mouse.move(10, 10);
      await payButton.scrollIntoViewIfNeeded();
      await payButton.click();
      console.log("✓ Clicked Viva Wallet 'Pay' button");

      if (!(await waitForSubmissionToTakeEffect(page, urlBeforePay, 60000))) {
        console.log(
          "⚠ Still on the payment page after click — trying native JS click...",
        );
        await payButton
          .evaluate((el) => el.click())
          .catch((err) => {
            console.log(`⚠ Native JS click failed: ${err.message}`);
          });

        if (!(await waitForSubmissionToTakeEffect(page, urlBeforePay, 30000))) {
          throw new Error(
            `Clicked the Viva Wallet 'Pay' button but the page never left "${urlBeforePay}".`,
          );
        }
      }

      console.log(`✓ Viva Wallet payment submitted — now at "${page.url()}"`);
    },
  },

  HitPay: {
    fillCardDetails: async (page) => {
      console.log("Waiting for the HitPay hosted checkout page...");

      // https://checkout.sandbox.hit-pay.com/payment-request/@paylexer-app/<uuid>/checkout
      // The business handle and the payment-request uuid are both per-payment,
      // so only the fixed origin + /payment-request prefix is matched.
      // Production would be checkout.hit-pay.com — this suite only ever runs
      // against the sandbox host.
      await waitForUrlPrefix(
        page,
        "https://checkout.sandbox.hit-pay.com/payment-request",
        45000,
      );
      console.log(`✓ HitPay checkout page found: ${page.url()}`);

      // HitPay's own page renders only the container, the accepted-card logos
      // and the "Pay INR 3,300.00" button:
      //   <div id="payment-request-method-details-id">
      //     <div id="stripe-card-id" class="StripeElement"> … iframe … </div>
      //
      // The card fields themselves come from Stripe's Payment Element, so they
      // live inside js.stripe.com frames and are NOT reachable from
      // page.locator() at all. Same shape as the Stripe entry above, and the
      // same two reasons its selectors can't be shortcut here:
      //   - the frame NAME (__privateStripeFrame8279) carries a counter that
      //     changes per Stripe.js instance, so it differs every run;
      //   - the frame SRC embeds a per-session elementId, controllerId and
      //     experiment token, plus a fingerprinted filename.
      // The iframe named in the markup (elements-inner-accessory-target-*) is
      // only a shim; Stripe nests the real inputs in a descendant frame, so the
      // frames are searched for the card input itself rather than by depth.
      const stripeContainer = page.locator("#stripe-card-id");
      await stripeContainer.waitFor({ state: "visible", timeout: 45000 });
      console.log("✓ #stripe-card-id mounted");

      // House convention across this file: fixed month, current year + 3, so
      // the expiry never drifts into the past.
      const EXPIRY_MONTH = "02";
      const EXPIRY_YY = String((new Date().getFullYear() + 3) % 100).padStart(
        2,
        "0",
      );

      // Stripe's documented always-approves test Visa. HitPay's sandbox settles
      // card payments through its own Stripe test account (note the
      // apiKey=pk_test_… on the element's iframe src), so it is Stripe's test
      // cards that apply here, not a HitPay-specific number.
      const CARD_NUMBER = "4242424242424242";
      const CARD_CVC = "123";

      console.log(`Using Stripe test card ending in ${CARD_NUMBER.slice(-4)}`);
      console.log(
        `Expiry set to ${EXPIRY_MONTH}/${EXPIRY_YY} (always current year + 3)`,
      );

      const CARD_NUMBER_SELECTORS = [
        "#Field-numberInput",
        'input[name="number"]',
        'input[autocomplete="cc-number"]',
        'input[data-elements-stable-field-name="cardNumber"]',
      ];

      console.log("Searching Stripe frames for the card number input...");

      let cardFrame = null;
      let cardNumberSelector = null;
      const frameDeadline = Date.now() + 60000;

      while (Date.now() < frameDeadline && !cardFrame) {
        for (const frame of page.frames()) {
          if (!frame.url().includes("js.stripe.com")) continue;

          for (const selector of CARD_NUMBER_SELECTORS) {
            const visible = await frame
              .locator(selector)
              .first()
              .isVisible()
              .catch(() => false);

            if (visible) {
              cardFrame = frame;
              cardNumberSelector = selector;
              break;
            }
          }

          if (cardFrame) break;
        }

        if (!cardFrame) await page.waitForTimeout(500);
      }

      if (!cardFrame) {
        // Dump every Stripe frame with its inputs, so a layout change reports
        // what IS there instead of just "not found".
        const tree = [];

        for (const f of page.frames()) {
          if (!f.url().includes("js.stripe.com")) continue;

          const inputs = await f
            .locator("input")
            .evaluateAll((els) =>
              els.map((el) => ({
                id: el.id || null,
                name: el.getAttribute("name"),
                autocomplete: el.getAttribute("autocomplete"),
                stableName: el.getAttribute("data-elements-stable-field-name"),
              })),
            )
            .catch(() => []);

          tree.push({
            component:
              (f.url().match(/elements-inner-([a-z-]+)/i) || [])[1] ||
              "unknown",
            name: f.name(),
            inputs,
          });
        }

        throw new Error(
          `HitPay's Stripe card number input never appeared in any js.stripe.com frame within ` +
            `60s. The element mounted (#stripe-card-id is visible) but its fields did not, so ` +
            `there is nothing to type into. Stripe frame tree: ${JSON.stringify(tree, null, 2)}`,
        );
      }

      console.log(`✓ Card input found via ${cardNumberSelector}`);

      // Every field is resolved within the SAME frame the card number was found
      // in — the Payment Element renders number, expiry, CVC and postal code as
      // siblings, and re-scanning per field would cost a slowMo delay per frame.
      const resolveField = async (candidates, timeoutMs) => {
        const deadline = Date.now() + timeoutMs;

        while (Date.now() < deadline) {
          for (const selector of candidates) {
            const visible = await cardFrame
              .locator(selector)
              .first()
              .isVisible()
              .catch(() => false);

            if (visible) return selector;
          }

          await page.waitForTimeout(300);
        }

        return null;
      };

      // pressSequentially, never fill(): the Payment Element reformats as
      // characters arrive (grouping spaces on the number, the "/" on the
      // expiry) and detects the brand per keystroke, and both behaviours hang
      // off the key events fill() skips entirely.
      const typeField = async (candidates, label, value, required = true) => {
        const selector = await resolveField(
          candidates,
          required ? 30000 : 4000,
        );

        if (!selector) {
          if (required) {
            throw new Error(
              `HitPay's Stripe element never rendered the required field "${label}". Tried ` +
                `${JSON.stringify(candidates)} in ${cardFrame.url()}.`,
            );
          }

          console.log(`– Optional field "${label}" not present — skipping`);
          return;
        }

        const input = cardFrame.locator(selector).first();
        await input.click();
        await input.pressSequentially(value, { delay: 50 });

        const actual = await input.inputValue();
        console.log(`✓ ${label} now contains: "${actual}"`);

        if (actual.replace(/\D/g, "") !== value.replace(/\D/g, "")) {
          throw new Error(
            `HitPay's ${label} field kept "${actual}" (digits "${actual.replace(
              /\D/g,
              "",
            )}") instead of the "${value}" typed — the element is truncating or ` +
              `rejecting input.`,
          );
        }
      };

      // Card number first: the CVC field is sized from the detected brand, so
      // typing into it before the number is in risks the keystrokes being
      // silently dropped.
      await typeField([cardNumberSelector], "Card number", CARD_NUMBER);

      // Stripe inserts the "/" itself, so four bare digits go in.
      await typeField(
        [
          "#Field-expiryInput",
          'input[name="expiry"]',
          'input[autocomplete="cc-exp"]',
          'input[data-elements-stable-field-name="cardExpiry"]',
        ],
        "Expiry",
        `${EXPIRY_MONTH}${EXPIRY_YY}`,
      );

      await typeField(
        [
          "#Field-cvcInput",
          'input[name="cvc"]',
          'input[autocomplete="cc-csc"]',
          'input[data-elements-stable-field-name="cardCvc"]',
        ],
        "CVC",
        CARD_CVC,
      );

      // No postal-code step: the element is configured with
      // fields[billingDetails][address]=if_required (see the iframe src) and
      // this checkout renders number/expiry/CVC only — confirmed on the live
      // sandbox page. Polling for a postal-code input that is never rendered
      // only spent the optional-field timeout before moving on, so the card is
      // complete after the CVC and the Pay button is what comes next.

      // Blur out of the element so it runs its validators, then read whatever
      // it has to say. Stripe renders per-field messages as
      // <p id="Field-numberError" role="alert"> INSIDE the frame — the HitPay
      // page shows nothing — so the frame is where they have to be read from.
      await cardFrame
        .locator("body")
        .click({ position: { x: 5, y: 5 } })
        .catch(() => {});

      const fieldErrors = (
        await cardFrame
          .locator('p[id$="Error"], [role="alert"]')
          .allTextContents()
          .catch(() => [])
      )
        .map((t) => t.replace(/\s+/g, " ").trim())
        .filter(Boolean);

      if (fieldErrors.length) {
        throw new Error(
          `HitPay's Stripe element rejected the card details before submit: ` +
            `"${fieldErrors.join(" | ")}". The Pay button would never reach the gateway.`,
        );
      }

      console.log("✓ All HitPay card fields filled");
    },

    submitCardPayment: async (page) => {
      console.log("Submitting HitPay payment...");

      if (paymentAlreadyCompleted(page)) {
        console.log(
          `✓ Payment already went through — at "${page.url()}". Nothing to click.`,
        );
        return;
      }

      // .hp-button__primary is HitPay's own primary-button class, so it picks
      // out the wide submit button under the card fields — the one reading
      // "Pay INR 3,300.00". div.checkout-button is tried first because on the
      // layouts that do render that wrapper it isolates the submit button from
      // HitPay's other payment-method rows above the card form; when the
      // wrapper is absent the primary button is matched on its own, filtered to
      // an amount-bearing "Pay …" label so those other rows still can't win.
      // A bare case-insensitive "Pay" substring match would reach them, which
      // is why the label filter requires the currency/amount too.
      const payButtonCandidates = [
        page.locator("div.checkout-button button.hp-button__primary"),
        page
          .locator("button.hp-button__primary")
          .filter({ hasText: /Pay\s+[A-Z]{3}\s*[\d.,]+/i }),
        page.locator("button.hp-button__primary"),
      ];

      let payButton = null;
      for (const candidate of payButtonCandidates) {
        const first = candidate.first();
        try {
          await first.waitFor({ state: "visible", timeout: 10000 });
          payButton = first;
          break;
        } catch {
          // Next candidate.
        }
      }

      if (!payButton) {
        throw new Error(
          `HitPay's primary "Pay" button never became visible within 30000ms of the ` +
            `card fields being filled — still at "${page.url()}".`,
        );
      }

      await payButton.scrollIntoViewIfNeeded();

      const label = (await payButton.innerText().catch(() => "")).trim();
      console.log(`Pay button reads: "${label}"`);

      const urlBeforeClick = page.url();
      await payButton.click();
      console.log("✓ HitPay 'Pay' clicked");

      // ---- Settle ----
      // The element confirms over XHR, so a card the gateway refuses comes back
      // as text with NO navigation — a URL-only wait would sit out the whole
      // timeout on a payment that had already failed. Both outcomes are polled
      // together.
      //
      // On success HitPay redirects out to PayLexer's /redirect-callback and on
      // to the store's return URL, so "left the hit-pay.com hosts" is what
      // counts as done — not merely "url changed", which a 3DS hop alone would
      // satisfy.
      const stillOnHitPay = () => page.url().includes("hit-pay.com");

      const deadline = Date.now() + 120000;
      let sawChallenge = false;

      while (Date.now() < deadline) {
        if (paymentAlreadyCompleted(page)) {
          console.log(`✓ HitPay payment completed — now on: ${page.url()}`);
          return;
        }

        if (!stillOnHitPay() && page.url() !== urlBeforeClick) {
          console.log(
            `✓ HitPay submission took effect — now on: ${page.url()}`,
          );
          return;
        }

        // HitPay's own failure banner, plus the element's in-frame field
        // errors — a decline surfaces in one or the other depending on whether
        // Stripe or HitPay rejected it.
        const pageError = (
          await page
            .locator('[role="alert"], .text-oc-error, .hp-alert')
            .allTextContents()
            .catch(() => [])
        )
          .map((t) => t.replace(/\s+/g, " ").trim())
          .find(Boolean);

        if (pageError) {
          throw new Error(`HitPay rejected the payment: "${pageError}"`);
        }

        // A 3DS challenge is only NOTED, never answered: 4242… is documented
        // not to trigger one, so a challenge screen means this payment wants an
        // OTP nobody in this suite has. Recording that it appeared makes the
        // eventual timeout say so instead of blaming the fill.
        if (!sawChallenge) {
          const challenge = page
            .frames()
            .find(
              (f) =>
                /acs|3ds|challenge|authenticate|threeds/i.test(f.url()) &&
                !f.url().includes("elements-inner"),
            );

          if (challenge) {
            sawChallenge = true;
            console.log(
              `[state] HitPay opened a 3DS challenge frame: ${
                challenge.url().split("#")[0]
              }`,
            );
          }
        }

        await page.waitForTimeout(500);
      }

      throw new Error(
        `HitPay neither left its hosted checkout nor reported an error within 120000ms of the ` +
          `submit — still on "${page.url()}".` +
          (sawChallenge
            ? ` A 3DS challenge frame appeared and was never answered: this payment needs an OTP, ` +
              `which the 4242… test card is not supposed to ask for.`
            : "") +
          `\n${await describeSubmitButtons(page)}`,
      );
    },
  },

  Westpac: {
    fillCardDetails: async (page) => {
      console.log("Filling WestpacPayWay card details (inside iframe)...");

      console.log(
        "Waiting for the PayWay iframe to appear (polling by URL)...",
      );
      const cardFrame = await waitForFrameByUrl(
        page,
        "api.payway.com.au",
        45000,
      );
      console.log(`✓ PayWay iframe found: ${cardFrame.url()}`);

      // Fixed test card details — card number, name, and CVV never change.
      // Expiry MONTH stays fixed, but YEAR is computed dynamically (current
      // year + 3) so it never accidentally becomes a past date.
      const CARD_NUMBER = "4564710000000004";
      const CARD_NAME = "Token Tutorial";
      const CARD_CVV = "847";
      const CARD_EXPIRY_MONTH = "02";
      const CARD_EXPIRY_YEAR = String(
        (new Date().getFullYear() + 3) % 100,
      ).padStart(2, "0");

      console.log(`Using fixed test card ending in ${CARD_NUMBER.slice(-4)}`);
      console.log(
        `Expiry set to ${CARD_EXPIRY_MONTH}/${CARD_EXPIRY_YEAR} (always current year + 3)`,
      );

      const cardNumberInput = cardFrame.locator(".payway-number-formatted");
      await cardNumberInput.waitFor({ state: "visible", timeout: 30000 });
      await cardNumberInput.click();
      await cardNumberInput.pressSequentially(CARD_NUMBER, { delay: 50 });
      const cardNumberValue = await cardNumberInput.inputValue();
      console.log(`✓ Card number field now contains: "${cardNumberValue}"`);

      const nameInput = cardFrame.locator("#cardholderName");
      await nameInput.waitFor({ state: "visible", timeout: 30000 });
      await nameInput.click();
      await nameInput.fill(CARD_NAME);
      const nameValue = await nameInput.inputValue();
      console.log(`✓ Name field now contains: "${nameValue}"`);

      const cvvInput = cardFrame.locator("#cvn");
      await cvvInput.waitFor({ state: "visible", timeout: 30000 });
      await cvvInput.click();
      await cvvInput.pressSequentially(CARD_CVV, { delay: 50 });
      const cvvValue = await cvvInput.inputValue();
      console.log(`✓ CVV field now contains: "${cvvValue}"`);

      const monthSelect = cardFrame.locator('select[name="expiryDateMonth"]');
      await monthSelect.waitFor({ state: "visible", timeout: 30000 });
      await monthSelect.selectOption(CARD_EXPIRY_MONTH);
      const monthValue = await monthSelect.inputValue();
      console.log(`✓ Month field now set to: "${monthValue}"`);

      const yearSelect = cardFrame.locator('select[name="expiryDateYear"]');
      await yearSelect.waitFor({ state: "visible", timeout: 30000 });
      await yearSelect.selectOption(CARD_EXPIRY_YEAR);
      const yearValue = await yearSelect.inputValue();
      console.log(`✓ Year field now set to: "${yearValue}"`);

      console.log("✓ All card fields filled — readback values logged above");

      console.log("Waiting for card details to register before submitting...");
      await page.waitForTimeout(4000);
      console.log("✓ Wait complete");

      // Now that every required field is filled, the modal relabels its submit
      // button to "Pay Now" — findPayNowButton() waits for exactly that, in
      // whichever frame owns it. No click here on purpose: submitCardPayment()
      // runs immediately after this and owns the click, so clicking here too
      // would submit twice.
      console.log(
        "Waiting for a button labelled 'Pay Now' in any frame (or for the payment to complete on its own)...",
      );
      const { status } = await waitForSubmitReadyOrCompletion(page, 30000);

      if (status === "completed") {
        console.log(
          `✓ Payment already completed after the fields validated — at "${page.url()}". No Pay Now click needed.`,
        );
        return;
      }

      console.log('✓ Found the enabled "Pay Now" button — ready to click');
    },
    submitCardPayment: async (page) => {
      console.log("Attempting to click 'Pay Now' button...");

      // Checked before anything else because submitCardPayment is called
      // directly by CheckoutPage and can't assume fillCardDetails just ran.
      if (paymentAlreadyCompleted(page)) {
        console.log(
          `✓ Payment already went through — at "${page.url()}". Nothing to click.`,
        );
        return;
      }

      // The button is located by its "Pay Now" label, in whichever frame owns
      // it — the modal's contents are iframed, so it isn't in the top-level
      // page's DOM. The locator comes back from the wait rather than being
      // re-derived here, so the click targets the frame it was actually found
      // in. A "completed" status means the payment went through without a
      // click, which is a pass-through, not a failure.
      const { status, button } = await waitForSubmitReadyOrCompletion(
        page,
        30000,
      );

      if (status === "completed") {
        console.log(
          `✓ Payment submitted itself while waiting — at "${page.url()}". Nothing to click.`,
        );
        return;
      }

      const urlBeforeClick = page.url();

      await button.scrollIntoViewIfNeeded();

      // Real mouse movement + click, using the button's actual bounding box
      // coordinates — moves the mouse there in steps (like a human dragging
      // the cursor) then does a genuine mouse down/up, rather than a
      // synthetic/forced click. This produces trusted OS-level input events.
      const box = await button.boundingBox();

      if (box) {
        const targetX = box.x + box.width / 2;
        const targetY = box.y + box.height / 2;

        console.log(
          `Moving mouse to (${Math.round(targetX)}, ${Math.round(targetY)})...`,
        );
        await page.mouse.move(targetX, targetY, { steps: 25 });
        await page.waitForTimeout(200);
        await page.mouse.down();
        await page.waitForTimeout(100);
        await page.mouse.up();
        console.log("Clicked 'Pay Now' (attempt 1: real mouse move + click)");
      } else {
        console.log(
          "⚠ Could not get bounding box — falling back to element click()",
        );
        await button.click({ force: true });
      }

      // Generous window on purpose: the modal tokenises the card with PayWay
      // and posts to the processor before the page navigates, which took ~3s of
      // round-trips in the traced run. A flat 2s wait here would call a
      // perfectly good click a failure.
      if (await waitForSubmissionToTakeEffect(page, urlBeforeClick, 20000)) {
        console.log(
          "✓ Page left the card form after click — payment submitted",
        );
        return;
      }

      console.log(
        "⚠ Still on the card form after the real click — trying native JS click...",
      );

      // Dispatched via the Locator, NOT page.evaluate() — locator.evaluate()
      // runs in the frame that owns the element, whereas page.evaluate() runs
      // in the top-level frame, where this button doesn't exist at all.
      await button
        .evaluate((el) => el.click())
        .catch((err) => {
          console.log(`⚠ Native JS click failed: ${err.message}`);
        });

      if (await waitForSubmissionToTakeEffect(page, urlBeforeClick, 20000)) {
        console.log(
          "✓ Page left the card form after JS click — payment submitted",
        );
        return;
      }

      throw new Error(
        `Clicked 'Pay Now' (both real mouse click and native JS click) but the page never left "${urlBeforeClick}" — the click isn't triggering submission.\n` +
          `Buttons present, per frame:\n${await describeSubmitButtons(page)}`,
      );
    },
  },

  Iyzico: {
    fillCardDetails: async (page) => {
      console.log(
        "Filling iyzico checkout (hosted CPP, full-page redirect, no iframe)...",
      );

      // Token in the query string is per-session (?token=<uuid>&lang=en), so
      // only the fixed host prefix is matchable.
      await waitForUrlPrefix(page, "https://sandbox-cpp.iyzipay.com/");

      const CARD_HOLDER = "Token Tutorial";
      const CARD_NUMBER = "5400010000000004"; // Akbank Mastercard, non-3DS sandbox card
      const CARD_CVC = "000";
      // Same convention as the other gateways: fixed month, current year + 3.
      // #ccexp is a single mm/yy masked field, not separate month/year selects.
      const EXPIRY_MONTH = "02";
      const EXPIRY_YY = String((new Date().getFullYear() + 3) % 100).padStart(
        2,
        "0",
      );

      // Every field here is a StyledInputMask driven by keypress events, so
      // fill() gets swallowed — same reasoning as PayWay/Omise/ToyyibPay phone.
      const holderInput = page.locator("#ccname");
      await holderInput.waitFor({ state: "visible", timeout: 30000 });
      await holderInput.click();
      await holderInput.pressSequentially(CARD_HOLDER, { delay: 50 });
      console.log(
        `✓ Card holder field now contains: "${await holderInput.inputValue()}"`,
      );

      const numberInput = page.locator("#ccnumber");
      await numberInput.waitFor({ state: "visible", timeout: 30000 });
      await numberInput.click();
      await numberInput.pressSequentially(CARD_NUMBER, { delay: 50 });
      console.log(
        `✓ Card number field now contains: "${await numberInput.inputValue()}"`,
      );

      // The mask inserts the "/" itself, so send digits only. If a future
      // build stops auto-inserting, retry with the separator typed in.
      const expiryInput = page.locator("#ccexp");
      await expiryInput.waitFor({ state: "visible", timeout: 30000 });
      await expiryInput.click();
      await expiryInput.pressSequentially(`${EXPIRY_MONTH}${EXPIRY_YY}`, {
        delay: 50,
      });

      if (!/^\d{2}\s*\/\s*\d{2}$/.test(await expiryInput.inputValue())) {
        console.log(
          `⚠ Expiry looks unmasked ("${await expiryInput.inputValue()}") — retyping with separator...`,
        );
        await expiryInput.fill("");
        await expiryInput.pressSequentially(`${EXPIRY_MONTH}/${EXPIRY_YY}`, {
          delay: 50,
        });
      }
      console.log(
        `✓ Expiry field now contains: "${await expiryInput.inputValue()}"`,
      );

      const cvcInput = page.locator("#cccvc");
      await cvcInput.waitFor({ state: "visible", timeout: 30000 });
      await cvcInput.click();
      await cvcInput.pressSequentially(CARD_CVC, { delay: 50 });
      console.log(`✓ CVC field now contains: "${await cvcInput.inputValue()}"`);

      // Only wait for the button to become enabled — the click itself belongs
      // to submitCardPayment (same split as PayWay).
      const payButton = page.locator(
        "button#iyz-payment-button:not([disabled])",
      );
      await payButton.waitFor({ state: "visible", timeout: 30000 });
      // Label carries the amount, e.g. "PAY 800.00 GBP" — useful in the log to
      // confirm the currency the gateway actually received.
      console.log(
        `✓ Pay button enabled: "${(await payButton.innerText()).trim().replace(/\s+/g, " ")}"`,
      );

      console.log("✓ All iyzico fields filled");
    },

    submitCardPayment: async (page) => {
      console.log("Attempting iyzico payment submission...");

      if (paymentAlreadyCompleted(page)) {
        console.log(
          `✓ Payment already went through — at "${page.url()}". Nothing to click.`,
        );
        return;
      }

      const payButton = page.locator(
        "button#iyz-payment-button:not([disabled])",
      );
      await payButton.waitFor({ state: "visible", timeout: 30000 });

      const urlBeforeClick = page.url();
      await page.mouse.move(10, 10);
      await payButton.scrollIntoViewIfNeeded();
      await payButton.click();
      console.log("Clicked iyzico 'PAY' button");

      if (!(await waitForSubmissionToTakeEffect(page, urlBeforeClick, 20000))) {
        console.log(
          "⚠ Still on the CPP after click — trying native JS click...",
        );
        await payButton
          .evaluate((el) => el.click())
          .catch((err) => {
            console.log(`⚠ Native JS click failed: ${err.message}`);
          });

        if (
          !(await waitForSubmissionToTakeEffect(page, urlBeforeClick, 20000))
        ) {
          throw new Error(
            `Clicked iyzico 'PAY' button but the page never left "${urlBeforeClick}".`,
          );
        }
      }

      console.log(`✓ Left the CPP — now at "${page.url()}"`);

      // 5400010000000004 is the non-3DS sandbox card, so this shouldn't fire.
      // Kept as a cheap guard in case the gateway is switched to a 3DS card.
      const otpConfirm = page.locator(
        'form[name="threeDSForm"] button[type="submit"], input[value="Onayla"]',
      );
      if (await otpConfirm.count()) {
        console.log("3DS interstitial detected — confirming...");
        const urlBeforeOtp = page.url();
        await otpConfirm.first().click();
        await waitForSubmissionToTakeEffect(page, urlBeforeOtp, 30000);
        console.log(`✓ Past 3DS — now at "${page.url()}"`);
      }

      console.log("✓ iyzico payment submitted");
    },
  },
  //6th
  Omise: {
    fillCardDetails: async (page) => {
      console.log("Filling Omise card details (inside iframe)...");

      console.log(
        "Waiting for the Omise checkout iframe to appear (polling by URL)...",
      );
      const cardFrame = await waitForFrameByUrl(page, "omise.co", 45000);
      console.log(`✓ Omise iframe found: ${cardFrame.url()}`);

      // Fixed test card details — same convention as Westpac. Expiry MONTH
      // stays fixed, YEAR is computed dynamically (current year + 3).
      const CARD_NUMBER = "4564710000000004";
      const CARD_NAME = "Token Tutorial";
      const CARD_CVV = "847";
      const CARD_EXPIRY_MONTH = "02";
      const CARD_EXPIRY_YEAR = String(
        (new Date().getFullYear() + 3) % 100,
      ).padStart(2, "0");
      const CARD_EXPIRY = `${CARD_EXPIRY_MONTH}/${CARD_EXPIRY_YEAR}`;
      const CARDHOLDER_EMAIL = "test@paylexer.com";

      console.log(`Using fixed test card ending in ${CARD_NUMBER.slice(-4)}`);
      console.log(`Expiry set to ${CARD_EXPIRY} (always current year + 3)`);

      const cardNumberInput = cardFrame.locator('[data-testid="card-number"]');
      await cardNumberInput.waitFor({ state: "visible", timeout: 30000 });
      await cardNumberInput.click();
      await cardNumberInput.pressSequentially(CARD_NUMBER, { delay: 50 });
      console.log(
        `✓ Card number field now contains: "${await cardNumberInput.inputValue()}"`,
      );

      const nameInput = cardFrame.locator('[data-testid="card-holder-name"]');
      await nameInput.waitFor({ state: "visible", timeout: 30000 });
      await nameInput.click();
      await nameInput.pressSequentially(CARD_NAME, { delay: 50 });
      console.log(
        `✓ Name field now contains: "${await nameInput.inputValue()}"`,
      );

      const expiryInput = cardFrame.locator('[data-testid="expiryDate"]');
      await expiryInput.waitFor({ state: "visible", timeout: 30000 });
      await expiryInput.click();
      await expiryInput.pressSequentially(CARD_EXPIRY, { delay: 50 });
      console.log(
        `✓ Expiry field now contains: "${await expiryInput.inputValue()}"`,
      );

      const cvvInput = cardFrame.locator('[data-testid="securityCode"]');
      await cvvInput.waitFor({ state: "visible", timeout: 30000 });
      await cvvInput.click();
      await cvvInput.pressSequentially(CARD_CVV, { delay: 50 });
      console.log(`✓ CVV field now contains: "${await cvvInput.inputValue()}"`);

      const emailInput = cardFrame.locator('[data-testid="cardholder-email"]');
      await emailInput.waitFor({ state: "visible", timeout: 30000 });
      await emailInput.click();
      await emailInput.pressSequentially(CARDHOLDER_EMAIL, { delay: 50 });
      console.log(
        `✓ Email field now contains: "${await emailInput.inputValue()}"`,
      );

      console.log("✓ All card fields filled — readback values logged above");

      console.log("Waiting for card details to register before submitting...");
      await page.waitForTimeout(2000);
      console.log("✓ Wait complete");
    },

    submitCardPayment: async (page) => {
      console.log("Attempting to click Omise submit button...");

      // Checked before anything else — submitCardPayment can be called
      // directly by CheckoutPage without fillCardDetails having just run.
      if (paymentAlreadyCompleted(page)) {
        console.log(
          `✓ Payment already went through — at "${page.url()}". Nothing to click.`,
        );
        return;
      }

      console.log(
        "Locating the Omise checkout iframe again to find the submit button...",
      );
      const cardFrame = await waitForFrameByUrl(page, "omise.co", 30000);

      // Unlike PayWay, Omise's button is directly locatable by data-testid —
      // no cross-frame "Pay Now" label search needed, and its text is
      // dynamic ("Pay 800 JPY") so text matching would be fragile anyway.
      const button = cardFrame.locator('[data-testid="submit-button"]');
      await button.waitFor({ state: "visible", timeout: 30000 });

      const urlBeforeClick = page.url();

      await button.scrollIntoViewIfNeeded();

      // Real mouse movement + click first, same as Westpac, to produce
      // trusted OS-level input events rather than a synthetic click.
      const box = await button.boundingBox();

      if (box) {
        const targetX = box.x + box.width / 2;
        const targetY = box.y + box.height / 2;

        console.log(
          `Moving mouse to (${Math.round(targetX)}, ${Math.round(targetY)})...`,
        );
        await page.mouse.move(targetX, targetY, { steps: 25 });
        await page.waitForTimeout(200);
        await page.mouse.down();
        await page.waitForTimeout(100);
        await page.mouse.up();
        console.log(
          "Clicked submit button (attempt 1: real mouse move + click)",
        );
      } else {
        console.log(
          "⚠ Could not get bounding box — falling back to element click()",
        );
        await button.click({ force: true });
      }

      if (await waitForSubmissionToTakeEffect(page, urlBeforeClick, 20000)) {
        console.log(
          "✓ Page left the card form after click — payment submitted",
        );
        return;
      }

      console.log(
        "⚠ Still on the card form after the real click — trying native JS click...",
      );

      // Dispatched via the Locator (runs in the frame that owns the button),
      // not page.evaluate() (runs in the top-level frame, where it doesn't exist).
      await button
        .evaluate((el) => el.click())
        .catch((err) => {
          console.log(`⚠ Native JS click failed: ${err.message}`);
        });

      if (await waitForSubmissionToTakeEffect(page, urlBeforeClick, 20000)) {
        console.log(
          "✓ Page left the card form after JS click — payment submitted",
        );
        return;
      }

      throw new Error(
        `Clicked Omise submit button (both real mouse click and native JS click) but the page never left "${urlBeforeClick}" — the click isn't triggering submission.\n` +
          `Buttons present, per frame:\n${await describeSubmitButtons(page)}`,
      );
    },
  },

  SumUp: {
    fillCardDetails: async (page) => {
      console.log(
        "Filling SumUp checkout (full-page redirect; every field is its own iframe)...",
      );

      await waitForUrlPrefix(page, "https://checkout.sumup.com/");

      const CARDHOLDER_NAME = "Token Tutorial";
      const CARD_NUMBER = "4200000000000059";
      const currentYear = new Date().getFullYear();
      const expiryYear = String((currentYear + 3) % 100).padStart(2, "0");
      const CARD_EXPIRY = `02/${expiryYear}`;
      const CARD_CVV = "847";
      const POSTAL_CODE = "10001";

      // Hosted fields: #cardholder-name, #credit-card-number etc. are NOT in the
      // top-level document — each sits in its own iframe, and every one of those
      // iframes loads the same bundle so it carries hidden copies of the other
      // fields' ids too. Matching by accessible name is what distinguishes the
      // one real, visible input from the decoys; matching by id can't, which is
      // why page.locator("#cardholder-name") sat there until it timed out.
      const FIELDS = [
        { name: "Cardholder name", value: CARDHOLDER_NAME },
        { name: "Card number", value: CARD_NUMBER },
        { name: "Expiration date", value: CARD_EXPIRY },
        { name: "CVV", value: CARD_CVV },
        { name: "Zip code", value: POSTAL_CODE },
      ];

      for (const field of FIELDS) {
        const input = await waitForFieldInAnyFrame(
          page,
          (frame) => frame.getByRole("textbox", { name: field.name }),
          field.name,
        );

        await input.click();
        // Real keystrokes rather than fill(): these are third-party hosted
        // fields that format and validate as you type, same as PayWay/Omise.
        await input.pressSequentially(field.value, { delay: 50 });

        console.log(
          `✓ ${field.name} field now contains: "${await input.inputValue()}"`,
        );
      }

      console.log("✓ All SumUp card fields filled");
    },

    submitCardPayment: async (page) => {
      console.log(
        "Attempting SumUp two-step submission (Pay → Back to merchant)...",
      );

      if (paymentAlreadyCompleted(page)) {
        console.log(
          `✓ Payment already went through — at "${page.url()}". Nothing to click.`,
        );
        return;
      }

      // ---- Step 1: "Pay $X.XX" ----
      const payButton = page.locator('[data-testid="widget-pay-button"]');
      await payButton.waitFor({ state: "visible", timeout: 30000 });

      await payButton.scrollIntoViewIfNeeded();
      await payButton.click();
      console.log("✓ Clicked 'Pay' button");

      // ---- Step 2: "Back to merchant website" ----
      // No URL wait between the two steps, on purpose. SumUp renders its
      // success view IN PLACE: the address stays on the very same
      // checkout.sumup.com/pay/c-<uuid> the card form was already on, so
      // "did the URL change?" is answered "no" on a payment that succeeded —
      // which is what made both page.waitForURL() and the URL poll time out
      // here. What actually appears is this link, and its href already carries
      // callback_type=success, so its presence IS the success signal.
      //
      // PaymentSuccess_button__xqdps is a hashed CSS-module class that changes
      // whenever SumUp rebuilds, so the visible text is tried first and the
      // class kept only as a fallback.
      const backToMerchantButton = page
        .getByRole("link", { name: /back to merchant/i })
        .or(page.locator("a.PaymentSuccess_button__xqdps"))
        .first();

      // Raced against the payment having gone straight back to the merchant,
      // the same reasoning as waitForSubmitReadyOrCompletion(): the alternative
      // to "not yet" is "no button is ever coming", which a bare locator wait
      // can only report as a timeout after burning the full budget.
      const deadline = Date.now() + 60000;
      let successPageReady = false;

      while (Date.now() < deadline) {
        if (paymentAlreadyCompleted(page)) {
          console.log(
            `✓ Already back on the merchant site at "${page.url()}" — no "Back to merchant website" step needed`,
          );
          return;
        }

        if (await backToMerchantButton.isVisible().catch(() => false)) {
          successPageReady = true;
          break;
        }

        await page.waitForTimeout(500);
      }

      if (!successPageReady) {
        throw new Error(
          `Clicked SumUp's Pay button but neither the "Back to merchant website" link nor a ` +
            `redirect back to the merchant appeared within 60s (still at "${page.url()}").\n` +
            `Buttons present, per frame:\n${await describeSubmitButtons(page)}`,
        );
      }

      console.log(`✓ SumUp success page ready at "${page.url()}"`);

      const urlBeforeBackClick = page.url();
      await backToMerchantButton.scrollIntoViewIfNeeded();
      await backToMerchantButton.click();
      console.log("✓ Clicked 'Back to merchant website'");

      if (
        await waitForSubmissionToTakeEffect(page, urlBeforeBackClick, 20000)
      ) {
        console.log(`✓ Landed back on merchant site — now at "${page.url()}"`);
        return;
      }

      // Real click didn't move the page — could mean the link's handler
      // intercepted the click (preventDefault + JS redirect) rather than a
      // plain navigation. Falling back to a direct goto using the known,
      // static href is more reliable here than re-triggering the same
      // intercepted handler with el.click().
      console.log(
        "⚠ Still on SumUp success page after click — falling back to direct navigation via href...",
      );
      const href = await backToMerchantButton.getAttribute("href");
      if (!href) {
        throw new Error(
          `'Back to merchant website' link had no href to fall back on, and the page never left "${urlBeforeBackClick}".`,
        );
      }
      await page.goto(href);
      console.log(`✓ Navigated directly via href — now at "${page.url()}"`);
    },
  },

  Eway: {
    fillCardDetails: async (page) => {
      console.log("Filling eWAY checkout (full-page redirect, no iframe)...");

      const cardNumberInput = page.locator("#EWAY_CARDNUMBER");
      await cardNumberInput.waitFor({ state: "visible", timeout: 45000 });
      console.log(`✓ eWAY checkout page loaded: ${page.url()}`);

      const CARD_NUMBER = "4564710000000004";
      const CARD_NAME = "Token Tutorial";
      const CARD_CVV = "847";
      const currentYear = new Date().getFullYear();
      const expiryYearFull = currentYear + 3;

      // Month <option> values are unpadded ("2", not "02") — unlike PayWay's
      // padded month select. Year <option> values are two-digit ("26" for 2026).
      const CARD_EXPIRY_MONTH_VALUE = "2"; // February, matches your fixed convention
      const CARD_EXPIRY_YEAR_VALUE = String(expiryYearFull % 100);

      await cardNumberInput.click();
      await cardNumberInput.pressSequentially(CARD_NUMBER, { delay: 50 });
      console.log(
        `✓ Card number field now contains: "${await cardNumberInput.inputValue()}"`,
      );

      const nameInput = page.locator("#EWAY_CARDNAME");
      await nameInput.waitFor({ state: "visible", timeout: 30000 });
      await nameInput.click();
      await nameInput.fill(CARD_NAME);
      console.log(
        `✓ Name field now contains: "${await nameInput.inputValue()}"`,
      );

      const monthSelect = page.locator("#EWAY_CARDEXPIRYMONTH");
      await monthSelect.waitFor({ state: "visible", timeout: 30000 });
      await monthSelect.selectOption(CARD_EXPIRY_MONTH_VALUE);
      console.log(
        `✓ Month field now set to option value: "${await monthSelect.inputValue()}"`,
      );

      const yearSelect = page.locator("#EWAY_CARDEXPIRYYEAR");
      await yearSelect.waitFor({ state: "visible", timeout: 30000 });
      // Only options 24–36 exist (2024–2036) — guard so "current year + 3"
      // never silently selects nothing if this ever runs past 2033ish.
      const availableYearValues = await yearSelect
        .locator("option")
        .evaluateAll((opts) => opts.map((o) => o.value));
      if (!availableYearValues.includes(CARD_EXPIRY_YEAR_VALUE)) {
        throw new Error(
          `eWAY expiry year select has no option for "${CARD_EXPIRY_YEAR_VALUE}" ` +
            `(current year + 3). Available values: ${availableYearValues.join(", ")}. ` +
            `The dropdown likely needs updating on eWAY's side, or this test needs a capped offset.`,
        );
      }
      await yearSelect.selectOption(CARD_EXPIRY_YEAR_VALUE);
      console.log(
        `✓ Year field now set to option value: "${await yearSelect.inputValue()}"`,
      );

      const cvvInput = page.locator("#EWAY_CARDCVN");
      await cvvInput.waitFor({ state: "visible", timeout: 30000 });
      await cvvInput.click();
      // type="password" — Playwright's inputValue() still returns the real
      // typed value (password fields are only visually masked), so the
      // readback log below is accurate, not asterisks.
      await cvvInput.pressSequentially(CARD_CVV, { delay: 50 });
      console.log(`✓ CVV field now contains: "${await cvvInput.inputValue()}"`);

      console.log("✓ All eWAY card fields filled");
    },

    submitCardPayment: async (page) => {
      console.log(
        "Attempting eWAY two-step submission (Pay Now → Finalise)...",
      );

      if (paymentAlreadyCompleted(page)) {
        console.log(
          `✓ Payment already went through — at "${page.url()}". Nothing to click.`,
        );
        return;
      }

      // ---- Step 1: "Pay Now" on the card entry page ----
      const payNowButton = page.locator("#EWAYPayNowButton");
      await payNowButton.waitFor({ state: "visible", timeout: 30000 });

      const urlBeforePayNow = page.url();
      await payNowButton.scrollIntoViewIfNeeded();
      await payNowButton.click();
      console.log("✓ Clicked 'Pay Now'");

      // "Pay Now" is an <a>, not a submit button — wait on URL change rather
      // than assuming a form navigation event.
      await page.waitForURL((url) => url.href !== urlBeforePayNow, {
        timeout: 30000,
      });
      console.log(`✓ Redirected to confirmation page: ${page.url()}`);

      // ---- Step 2: "Finalise Transaction" ----
      const finaliseButton = page.locator("#EWAYFinaliseButton");
      await finaliseButton.waitFor({ state: "visible", timeout: 30000 });

      const urlBeforeFinalise = page.url();
      await finaliseButton.scrollIntoViewIfNeeded();
      await finaliseButton.click();
      console.log("✓ Clicked 'Finalise Transaction'");

      // ---- Wait for the booking thank-you page ----
      // NOTE: this only confirms the URL changed, not that it's actually the
      // thank-you page rather than an error page — paymentAlreadyCompleted()
      // checks for "callback_type=success", which may not match eWAY's real
      // final URL. Needs tightening once the actual thank-you page URL/text
      // is confirmed.
      if (await waitForSubmissionToTakeEffect(page, urlBeforeFinalise, 20000)) {
        console.log(
          `✓ Page left the confirmation page after Finalise click — now at "${page.url()}"`,
        );
      } else {
        console.log(
          "⚠ Still on confirmation page after Finalise click — trying native JS click...",
        );
        await finaliseButton
          .evaluate((el) => el.click())
          .catch((err) => {
            console.log(`⚠ Native JS click failed: ${err.message}`);
          });

        if (
          !(await waitForSubmissionToTakeEffect(page, urlBeforeFinalise, 20000))
        ) {
          throw new Error(
            `Clicked 'Finalise Transaction' (both real and JS click) but the page never left "${urlBeforeFinalise}".`,
          );
        }
        console.log("✓ Page left the confirmation page after JS click");
      }

      console.log("✓ eWAY flow complete — payment finalised");
    },
  },

  openpay: {
    fillCardDetails: async (page) => {
      console.log("Filling Openpay card details...");

      // Fixed test card details. 4111111111111111 is the value Openpay puts in
      // the field's own placeholder. Expiry MONTH stays fixed, YEAR is computed
      // (current year + 3) so it never becomes a past date.
      //
      // NOTE the expiry is TWO separate 2-digit text inputs here, not one masked
      // field — so there is no separator to insert and nothing to verify against
      // a mask.
      const CARD_NUMBER = "4111111111111111";
      const CARD_HOLDER = "Token Tutorial";
      const CARD_CVV = "123";
      const CARD_EXPIRY_MONTH = "02";
      const CARD_EXPIRY_YEAR = String(
        (new Date().getFullYear() + 3) % 100,
      ).padStart(2, "0");

      console.log(`Using fixed test card ending in ${CARD_NUMBER.slice(-4)}`);
      console.log(
        `Expiry set to ${CARD_EXPIRY_MONTH}/${CARD_EXPIRY_YEAR} (always current year + 3)`,
      );

      // Each field is clicked immediately before typing into it.
      // pressSequentially rather than fill() throughout: the card number groups
      // itself into blocks of four (maxlength=19 leaves room for the spaces),
      // and the Openpay SDK reads its values off input events.

      // -- Cardholder name --------------------------------------------------
      const holderInput = page.locator("#holder-name");
      await holderInput.waitFor({ state: "visible", timeout: 45000 });
      await holderInput.click();
      await holderInput.pressSequentially(CARD_HOLDER, { delay: 40 });
      console.log(
        `✓ Holder name field now contains: "${await holderInput.inputValue()}"`,
      );

      // -- Card number ------------------------------------------------------
      const cardNumberInput = page.locator("#card-number");
      await cardNumberInput.waitFor({ state: "visible", timeout: 30000 });
      await cardNumberInput.click();
      await cardNumberInput.pressSequentially(CARD_NUMBER, { delay: 50 });
      console.log(
        `✓ Card number field now contains: "${await cardNumberInput.inputValue()}"`,
      );

      // -- Expiry month -----------------------------------------------------
      const monthInput = page.locator("#expiry-month");
      await monthInput.waitFor({ state: "visible", timeout: 30000 });
      await monthInput.click();
      await monthInput.pressSequentially(CARD_EXPIRY_MONTH, { delay: 50 });
      console.log(
        `✓ Expiry month field now contains: "${await monthInput.inputValue()}"`,
      );

      // -- Expiry year ------------------------------------------------------
      // maxlength=2, so a 2-digit year — a 4-digit value would be truncated to
      // its first two characters and silently become the wrong year.
      const yearInput = page.locator("#expiry-year");
      await yearInput.waitFor({ state: "visible", timeout: 30000 });
      await yearInput.click();
      await yearInput.pressSequentially(CARD_EXPIRY_YEAR, { delay: 50 });
      console.log(
        `✓ Expiry year field now contains: "${await yearInput.inputValue()}"`,
      );

      // -- CVV --------------------------------------------------------------
      // type="password" does NOT hide the value from Playwright — inputValue()
      // returns real content, same as eWAY's and Xendit's CVV fields, so the
      // readback below is meaningful. The label asks for 3 digits though
      // maxlength allows 4.
      const cvvInput = page.locator("#cvv");
      await cvvInput.waitFor({ state: "visible", timeout: 30000 });
      await cvvInput.click();
      await cvvInput.pressSequentially(CARD_CVV, { delay: 50 });
      console.log(`✓ CVV field now contains: "${await cvvInput.inputValue()}"`);

      console.log("✓ All card fields filled — readback values logged above");

      // No click here on purpose: submitCardPayment() runs immediately after
      // this and owns the click.
    },

    submitCardPayment: async (page) => {
      console.log("Clicking Openpay 'Pagar' button...");

      // Targeted by id. Not state-gated — the observed markup carries no
      // disabled attribute, so no :not([disabled]) qualifier is added; Openpay
      // validates on submit and writes the result into #openpay-error.
      const button = page.locator("#openpay-submit-button");
      await button.waitFor({ state: "visible", timeout: 30000 });
      await button.scrollIntoViewIfNeeded();
      await button.click();
      console.log("✓ Pagar clicked");

      // Openpay tokenises client-side and writes failures into #openpay-error
      // rather than navigating, so a rejected card leaves the page unchanged and
      // would otherwise surface only as a downstream thank-you-page timeout.
      await page.waitForTimeout(3000);
      const errorText = await page
        .locator("#openpay-error")
        .textContent()
        .catch(() => null);

      if (errorText && errorText.trim()) {
        throw new Error(
          `Openpay rejected the payment: "${errorText.trim()}". A populated but rejected card ` +
            `usually means the number is outside the sandbox's accepted test set, or the ` +
            `2-digit expiry year was truncated.`,
        );
      }
      console.log("✓ No Openpay error reported");
    },
  },

  Nets: {
    fillCardDetails: async (page) => {
      console.log("Waiting for the Nets hosted payment page...");

      // The path segment after /hostedpaymentpage/ is a per-session payment id,
      // so only the stable prefix is matched.
      await waitForUrlPrefix(
        page,
        "https://test.checkout.dibspayment.eu/hostedpaymentpage/",
        45000,
      );
      console.log(`✓ Nets payment page found: ${page.url()}`);

      // Fixed test card details. Card number is Nets' own test card. Expiry
      // MONTH is preserved from the working script; YEAR is computed (current
      // year + 3) so it never becomes a past date.
      const CARD_NUMBER = "4268270087374847";
      const CARD_CVC = "123";
      const CARD_EXPIRY_MONTH = "11";
      const CARD_EXPIRY_YEAR = String(
        (new Date().getFullYear() + 3) % 100,
      ).padStart(2, "0");

      const FIRST_NAME = "Token";
      const LAST_NAME = "Tutorial";
      const ADDRESS_LINE1 = "123 Main St";
      const POSTAL_CODE = "12345";
      const CITY = "Kathmandu";
      const EMAIL = "token.tutorial@example.com";
      const PHONE = "9999999999";

      console.log(`Using fixed test card ending in ${CARD_NUMBER.slice(-4)}`);
      console.log(
        `Expiry set to ${CARD_EXPIRY_MONTH}/${CARD_EXPIRY_YEAR} (always current year + 3)`,
      );

      // -----------------------------------------------------------------
      // Resolves whichever frame owns a marker element, main frame included.
      // Returns null on timeout so callers can report their own diagnostics.
      //
      // Used instead of frameLocator("iframe") and instead of frames()[N]:
      // both of those pick a frame by POSITION, which is only correct until
      // Nets adds or reorders an iframe.
      // -----------------------------------------------------------------
      const resolveFrame = async (marker, label, timeout = 45000) => {
        const deadline = Date.now() + timeout;
        while (Date.now() < deadline) {
          for (const frame of page.frames()) {
            const count = await frame
              .locator(marker)
              .count()
              .catch(() => 0);
            if (count > 0) {
              const where =
                frame === page.mainFrame() ? "main frame" : frame.url();
              console.log(`[scope] ${label} found in: ${where}`);
              return frame;
            }
          }
          await page.waitForTimeout(250);
        }
        return null;
      };

      const cardFrame = await resolveFrame(
        'input[name="cardNumber"]',
        "Nets card form",
        45000,
      );

      if (!cardFrame) {
        throw new Error(
          `Nets card form (input[name="cardNumber"]) not found in any frame within 45s. ` +
            `URL: ${page.url()}. Frames: ${JSON.stringify(
              page.frames().map((f) => f.url()),
            )}`,
        );
      }

      // Stashed so submitCardPayment can reach the same frame without
      // re-resolving from scratch. Falls back to its own resolution if absent.
      page.__netsCardFrameUrl = cardFrame.url();

      // -----------------------------------------------------------------
      // Each field is clicked immediately before typing into it.
      //
      // The plain text fields use fill() — no masking on them, so there is
      // nothing keystroke-driven to trigger. The card number and expiry use
      // pressSequentially: the number groups into blocks of four and the expiry
      // inserts its own separator, both driven by input events fill() skips.
      // -----------------------------------------------------------------
      const fillPlain = async (name, value, label) => {
        const field = cardFrame.locator(`input[name="${name}"]`);
        await field.waitFor({ state: "visible", timeout: 30000 });
        await field.click();
        await field.fill(value);
        console.log(`✓ ${label} now contains: "${await field.inputValue()}"`);
      };

      await fillPlain("firstName", FIRST_NAME, "First name");
      await fillPlain("lastName", LAST_NAME, "Last name");
      await fillPlain("addressLine1", ADDRESS_LINE1, "Address line 1");
      await fillPlain("postalCode", POSTAL_CODE, "Postal code");
      await fillPlain("city", CITY, "City");
      await fillPlain("email", EMAIL, "Email");
      await fillPlain("phone", PHONE, "Phone");

      // -- Card number ------------------------------------------------------
      const cardNumberInput = cardFrame.locator('input[name="cardNumber"]');
      await cardNumberInput.waitFor({ state: "visible", timeout: 30000 });
      await cardNumberInput.click();
      await cardNumberInput.pressSequentially(CARD_NUMBER, { delay: 50 });
      console.log(
        `✓ Card number now contains: "${await cardNumberInput.inputValue()}"`,
      );

      // -- Expiry -----------------------------------------------------------
      // MMYY with no separator, matching the working script's "1132".
      const expiryInput = cardFrame.locator('input[name="expiryDate"]');
      await expiryInput.waitFor({ state: "visible", timeout: 30000 });
      await expiryInput.click();
      await expiryInput.pressSequentially(
        `${CARD_EXPIRY_MONTH}${CARD_EXPIRY_YEAR}`,
        { delay: 50 },
      );
      console.log(`✓ Expiry now contains: "${await expiryInput.inputValue()}"`);

      // -- CVC --------------------------------------------------------------
      const cvcInput = cardFrame.locator('input[name="cardVerificationCode"]');
      await cvcInput.waitFor({ state: "visible", timeout: 30000 });
      await cvcInput.click();
      await cvcInput.pressSequentially(CARD_CVC, { delay: 50 });
      console.log(`✓ CVC now contains: "${await cvcInput.inputValue()}"`);

      // -- Merchant terms consent -------------------------------------------
      // check() rather than click(): it is idempotent, so a re-run or a
      // pre-checked box cannot toggle the consent back OFF the way a blind
      // click would. force covers the common case of the real input being
      // visually replaced by a styled label.
      const consent = cardFrame.locator('input[name="consentOnMerchantTerms"]');
      await consent.waitFor({ state: "attached", timeout: 30000 });
      try {
        await consent.check({ timeout: 10000 });
        console.log("✓ Merchant terms consent checked");
      } catch (err) {
        console.log(`⚠ check() failed: ${err.message} — forcing`);
        await consent.check({ force: true });
        console.log("✓ Merchant terms consent checked (forced)");
      }

      console.log("✓ All card fields filled — readback values logged above");

      // No click here on purpose: submitCardPayment() runs immediately after
      // this and owns the Pay click plus the 3DS step.
    },

    submitCardPayment: async (page) => {
      console.log("Clicking Nets 'Pay' button...");

      // Re-resolved by content rather than by the stashed URL alone — the two
      // functions are separate entry points and the frame handle from the fill
      // step is not guaranteed live here.
      const resolveFrame = async (marker, label, timeout = 45000) => {
        const deadline = Date.now() + timeout;
        while (Date.now() < deadline) {
          for (const frame of page.frames()) {
            const count = await frame
              .locator(marker)
              .count()
              .catch(() => 0);
            if (count > 0) {
              const where =
                frame === page.mainFrame() ? "main frame" : frame.url();
              console.log(`[scope] ${label} found in: ${where}`);
              return frame;
            }
          }
          await page.waitForTimeout(250);
        }
        return null;
      };

      // Anchored on the card number field, not on button[type="submit"] —
      // several frames in this flow contain a submit button, so the card field
      // is what identifies the right one.
      const cardFrame = await resolveFrame(
        'input[name="cardNumber"]',
        "Nets card form",
        30000,
      );

      if (!cardFrame) {
        throw new Error(
          `Nets card form not found when submitting. URL: ${page.url()}. ` +
            `Frames: ${JSON.stringify(page.frames().map((f) => f.url()))}`,
        );
      }

      const payButton = cardFrame.locator('button[type="submit"]');
      await payButton.waitFor({ state: "visible", timeout: 30000 });
      await payButton.scrollIntoViewIfNeeded();
      await payButton.click();
      console.log("✓ Pay clicked");

      // -- 3DS authentication ------------------------------------------------
      // The original waited with `while (page.frames().length < 3)` and then
      // took frames()[2]. Both replaced:
      //   - the count loop had no deadline, so a 3DS frame that never arrived
      //     spun until the test timed out with no diagnostic;
      //   - the index assumed frame ordering, which breaks as soon as Nets adds
      //     an analytics iframe or the frames settle in a different order.
      //
      // The Approve button's own id identifies the frame, whichever position it
      // lands in.
      await page.waitForLoadState("domcontentloaded").catch(() => {});
      console.log("Waiting for the 3DS authentication frame...");

      const authFrame = await resolveFrame(
        "#AuthenticationSuccessButton",
        "3DS authentication frame",
        60000,
      );

      if (!authFrame) {
        throw new Error(
          `Nets 3DS frame (#AuthenticationSuccessButton) not found in any frame within 60s.\n` +
            `  URL: ${page.url()}\n` +
            `  Frames (${page.frames().length}): ${JSON.stringify(
              page.frames().map((f) => f.url()),
            )}\n` +
            `  If the payment already completed without a challenge, this step needs to become ` +
            `conditional — poll briefly and skip when absent.`,
        );
      }

      const authButton = authFrame.locator("#AuthenticationSuccessButton");
      await authButton.waitFor({ state: "visible", timeout: 30000 });
      console.log("✓ Authentication button visible");

      await authButton.click();
      console.log("✓ Authentication button clicked");
    },
  },
  //7th
  ToyyibPay: {
    fillCardDetails: async (page) => {
      console.log(
        "Filling ToyyibPay checkout (full-page redirect, no iframe)...",
      );

      await waitForUrlPrefix(page, "https://dev.toyyibpay.com/");

      const PAYOR_EMAIL = "test@paylexer.com";
      const PAYOR_NAME = "Token Tutorial";
      const PAYOR_PHONE = "0123456789";
      // FPX doesn't process a real card — it's bank-redirect based, so there's
      // no card number/CVV here. "Bank" selection substitutes for a card.
      const BANK_VALUE = "BCBB0235"; // CIMB Clicks

      const emailInput = page.locator("#email");
      await emailInput.waitFor({ state: "visible", timeout: 30000 });
      await emailInput.click();
      await emailInput.fill(PAYOR_EMAIL);
      console.log(
        `✓ Email field now contains: "${await emailInput.inputValue()}"`,
      );

      const nameInput = page.locator("#name");
      await nameInput.waitFor({ state: "visible", timeout: 30000 });
      await nameInput.click();
      await nameInput.fill(PAYOR_NAME);
      console.log(
        `✓ Name field now contains: "${await nameInput.inputValue()}"`,
      );

      const phoneInput = page.locator("#phone");
      await phoneInput.waitFor({ state: "visible", timeout: 30000 });
      await phoneInput.click();
      // Uses onkeypress="phoneFormat(...)" — a live formatting handler, same
      // reasoning as PayWay/Omise masked fields: pressSequentially fires real
      // keystroke events so the formatter actually runs.
      await phoneInput.pressSequentially(PAYOR_PHONE, { delay: 50 });
      console.log(
        `✓ Phone field now contains: "${await phoneInput.inputValue()}"`,
      );

      const bankSelect = page.locator("#select-bank");
      await bankSelect.waitFor({ state: "visible", timeout: 30000 });
      await bankSelect.selectOption(BANK_VALUE);
      console.log(`✓ Bank selected: "${await bankSelect.inputValue()}"`);

      const agreeCheckbox = page.locator("#agree");
      await agreeCheckbox.waitFor({ state: "visible", timeout: 30000 });
      await agreeCheckbox.check();
      console.log("✓ Agree checkbox ticked");

      console.log("✓ All ToyyibPay fields filled");
    },

    submitCardPayment: async (page) => {
      console.log("Attempting ToyyibPay two-step submission...");

      if (paymentAlreadyCompleted(page)) {
        console.log(
          `✓ Payment already went through — at "${page.url()}". Nothing to click.`,
        );
        return;
      }

      // ---- Step 1: "Proceed to <Bank>" on the FPX form ----
      const proceedButton = page.locator(
        'button.form-submit[onclick^="submitClick"]',
      );
      await proceedButton.waitFor({ state: "visible", timeout: 30000 });
      await proceedButton.click();
      console.log('✓ Clicked "Proceed to <Bank>"');

      // ---- Redirect hop to the bank payment simulator ----
      // Path segment after the domain is dynamic (e.g. "fh4u0vos"), so match
      // only the fixed domain prefix, same as the first redirect.
      await waitForUrlPrefix(page, "https://dev.toyyibpay.com/", 30000);

      // ---- Step 2: "Success" button on the bank simulator ----
      const successButton = page.locator("#btnSuccess");
      await successButton.waitFor({ state: "visible", timeout: 30000 });

      const urlBeforeClick = page.url();
      await successButton.scrollIntoViewIfNeeded();
      await successButton.click();
      console.log("Clicked 'Success' on bank simulator");

      if (await waitForSubmissionToTakeEffect(page, urlBeforeClick, 20000)) {
        console.log(
          "✓ Page left the bank simulator after click — payment submitted",
        );
        return;
      }

      console.log(
        "⚠ Still on the bank simulator after click — trying native JS click...",
      );
      await successButton
        .evaluate((el) => el.onclick && el.onclick())
        .catch((err) => {
          console.log(`⚠ Native JS invoke failed: ${err.message}`);
        });

      if (await waitForSubmissionToTakeEffect(page, urlBeforeClick, 20000)) {
        console.log(
          "✓ Page left the bank simulator after JS invoke — payment submitted",
        );
        return;
      }

      throw new Error(
        `Clicked ToyyibPay 'Success' button but the page never left "${urlBeforeClick}".`,
      );
    },
  },

  MyFatoorah: {
    fillCardDetails: async (page) => {
      console.log("Filling MyFatoorah checkout (full-page redirect)...");

      // URL is .../PayInvoice/Details/<invoice-id>-<hash> and carries a locale
      // and country segment (/En/KWT/), so only the fixed host prefix matches.
      await waitForUrlPrefix(page, "https://demo.myfatoorah.com/");

      const CARD_HOLDER = "Token Tutorial";
      const CARD_NUMBER = "4564710000000004"; // shared suite test card
      const CARD_CVV = "847";
      // Same convention as the other gateways: fixed month, current year + 3.
      // #expirationdate is a single MM/YY field, not two selects.
      const EXPIRY_MONTH = "02";
      const EXPIRY_YY = String((new Date().getFullYear() + 3) % 100).padStart(
        2,
        "0",
      );

      // MyFatoorah renders the card fields inside its own embedded card-view
      // iframe on some invoice types and inline on others, so resolve the scope
      // rather than assuming — same approach as Checkout.com.
      const resolveField = async (selector, label, timeout = 60000) => {
        const deadline = Date.now() + timeout;
        while (Date.now() < deadline) {
          if (await page.locator(selector).count()) {
            console.log(`[scope] ${label}: main page`);
            return page.locator(selector).first();
          }
          for (const frame of page.frames()) {
            if (frame === page.mainFrame()) continue;
            const found = await frame
              .locator(selector)
              .count()
              .catch(() => 0);
            if (found) {
              console.log(`[scope] ${label}: ${frame.url()}`);
              return frame.locator(selector).first();
            }
          }
          await page.waitForTimeout(500);
        }
        throw new Error(
          `MyFatoorah ${label} ("${selector}") not found. URL: "${page.url()}". ` +
            `Frames: ${JSON.stringify(page.frames().map((f) => f.url()))}`,
        );
      };

      // Each field is clicked to focus it before typing, and the numeric fields
      // format as you type, so pressSequentially rather than fill() — same
      // reasoning as PayWay/Omise/iyzico/Checkout.
      const clickAndType = async (selector, label, value) => {
        const input = await resolveField(selector, label);
        await input.waitFor({ state: "visible", timeout: 30000 });
        await input.scrollIntoViewIfNeeded();
        await input.click();
        await input.pressSequentially(value, { delay: 50 });
        return input;
      };

      const holderInput = await clickAndType(
        "#cardholdername",
        "cardholder name",
        CARD_HOLDER,
      );
      console.log(
        `✓ Cardholder field now contains: "${await holderInput.inputValue()}"`,
      );

      const numberInput = await clickAndType(
        "#cardnumber",
        "card number",
        CARD_NUMBER,
      );
      // The field groups digits in fours, so the value reads back spaced.
      console.log(
        `✓ Card number field now contains: "${await numberInput.inputValue()}"`,
      );

      // placeholder is "MM / YY" with spaces, but the separator is inserted by
      // the field itself — send digits only, or it eats a year character.
      const expiryInput = await clickAndType(
        "#expirationdate",
        "expiry date",
        `${EXPIRY_MONTH}${EXPIRY_YY}`,
      );

      if (!/\d{2}\s*\/\s*\d{2}/.test(await expiryInput.inputValue())) {
        console.log(
          `⚠ Expiry looks unmasked ("${await expiryInput.inputValue()}") — retyping with separator...`,
        );
        await expiryInput.fill("");
        await expiryInput.click();
        await expiryInput.pressSequentially(`${EXPIRY_MONTH}/${EXPIRY_YY}`, {
          delay: 50,
        });
      }
      console.log(
        `✓ Expiry field now contains: "${await expiryInput.inputValue()}"`,
      );

      // type="password" — inputValue() still returns the real value, it's only
      // masked visually, but log the length to keep it out of the console.
      const cvvInput = await clickAndType("#securitycode", "CVV", CARD_CVV);
      console.log(
        `✓ CVV field now holds ${(await cvvInput.inputValue()).length} character(s)`,
      );

      // Wait only — the click belongs to submitCardPayment (same split as
      // PayWay). The label carries the amount ("1,600.000 KD"), a cheap check on
      // the currency and total the gateway actually received.
      const payButton = await resolveField(
        "button.mfi-pay-now",
        "Pay Now button",
      );
      await payButton.waitFor({ state: "visible", timeout: 30000 });
      console.log(
        `✓ Pay Now button ready: "${(await payButton.innerText()).trim().replace(/\s+/g, " ")}"`,
      );

      console.log("✓ All MyFatoorah fields filled");
    },

    submitCardPayment: async (page) => {
      console.log("Attempting MyFatoorah two-step submission...");

      if (paymentAlreadyCompleted(page)) {
        console.log(
          `✓ Payment already went through — at "${page.url()}". Nothing to click.`,
        );
        return;
      }

      // Frame handles can't cross calls, so re-resolve here.
      const resolveField = async (selector, label, timeout = 60000) => {
        const deadline = Date.now() + timeout;
        while (Date.now() < deadline) {
          if (await page.locator(selector).count()) {
            console.log(`[scope] ${label}: main page`);
            return page.locator(selector).first();
          }
          for (const frame of page.frames()) {
            if (frame === page.mainFrame()) continue;
            const found = await frame
              .locator(selector)
              .count()
              .catch(() => 0);
            if (found) {
              console.log(`[scope] ${label}: ${frame.url()}`);
              return frame.locator(selector).first();
            }
          }
          await page.waitForTimeout(500);
        }
        throw new Error(
          `MyFatoorah ${label} ("${selector}") not found. URL: "${page.url()}". ` +
            `Frames: ${JSON.stringify(page.frames().map((f) => f.url()))}`,
        );
      };

      // ---- Step 1: "Pay Now" on the card form ----
      // Matched on the class rather than the text: the label is split across
      // nested spans and includes the amount, so a text match is whitespace- and
      // currency-dependent. onclick="cardViewPay()" is the real handler.
      const payButton = await resolveField(
        "button.mfi-pay-now",
        "Pay Now button",
      );
      await payButton.waitFor({ state: "visible", timeout: 30000 });

      const urlBeforePay = page.url();
      await page.mouse.move(10, 10);
      await payButton.scrollIntoViewIfNeeded();
      await payButton.click();
      console.log("✓ Clicked MyFatoorah 'Pay Now' button");

      // ---- Step 2 (CONDITIONAL): 3DS ACS challenge ----
      // Not every card or invoice triggers 3DS — a non-enrolled card goes
      // straight from Pay Now to the thank-you page. So #acssubmit is polled
      // and skipped if it doesn't show, rather than resolved with a 90s timeout:
      // that timeout would be spent in full on every non-3DS run and then throw
      // on a flow that had already succeeded.
      const findAcs = async (timeout = 20000) => {
        const deadline = Date.now() + timeout;
        while (Date.now() < deadline) {
          const top = page.locator("#acssubmit");
          if (await top.isVisible().catch(() => false)) {
            console.log("[scope] ACS Submit button: main page");
            return top;
          }
          for (const frame of page.frames()) {
            if (frame === page.mainFrame()) continue;
            const framed = frame.locator("#acssubmit");
            if (await framed.isVisible().catch(() => false)) {
              console.log(`[scope] ACS Submit button: ${frame.url()}`);
              return framed;
            }
          }
          await page.waitForTimeout(500);
        }
        return null;
      };

      const acsSubmit = await findAcs();

      if (acsSubmit) {
        console.log("✓ ACS challenge page rendered");

        const urlBeforeAcs = page.url();
        await acsSubmit.scrollIntoViewIfNeeded();
        await acsSubmit.click();
        console.log("✓ Clicked 'Submit' on the ACS challenge");

        if (!(await waitForSubmissionToTakeEffect(page, urlBeforeAcs, 60000))) {
          console.log(
            "⚠ Still on the ACS page after click — trying native JS click...",
          );
          await acsSubmit
            .evaluate((el) => el.click())
            .catch((err) => {
              console.log(`⚠ Native JS click failed: ${err.message}`);
            });

          if (
            !(await waitForSubmissionToTakeEffect(page, urlBeforeAcs, 30000))
          ) {
            throw new Error(
              `Clicked ACS 'Submit' but the page never left "${urlBeforeAcs}".`,
            );
          }
        }
      } else {
        console.log(
          "No ACS challenge appeared — card went straight through to the return page",
        );
      }

      console.log(`✓ MyFatoorah payment submitted — now at "${page.url()}"`);

      // urlBeforePay is only referenced in the log — the Pay Now click is not
      // URL-checked, because the ACS poll above is the real progress signal and
      // covers both the redirect and the in-place cases.
      if (page.url() === urlBeforePay) {
        console.log(
          "⚠ Top-level URL never changed across the whole flow — confirm the success check doesn't rely on it",
        );
      }
    },
  },

  PayU: {
    fillCardDetails: async (page) => {
      console.log(
        "Filling PayU checkout (hosted page, hash-routed, no iframe)...",
      );

      // URL is https://apitest.payu.in/public/#/<txn-hash>/paymentoptions —
      // the hash segment is per-transaction, so only the fixed prefix matches.
      await waitForUrlPrefix(page, "https://apitest.payu.in/public/");

      const CARD_NUMBER = "5123456789012346"; // PayU test Mastercard
      const CARD_CVV = "123";
      const CARD_HOLDER = "Token Tutorial";
      // Same convention as the other gateways: fixed month, current year + 3.
      // #cardExpiry is a single MM/YY field (maxlength="5"), not two selects.
      const EXPIRY_MONTH = "02";
      const EXPIRY_YY = String((new Date().getFullYear() + 3) % 100).padStart(
        2,
        "0",
      );

      // ---- Step 0: PayU opens on the payment-method list, not the card form.
      // The L1 tile has no id/data-testid, so match on its label text.
      const cardsOption = page
        .locator("div.l1Item", { hasText: "Cards (Credit/Debit)" })
        .first();
      await cardsOption.waitFor({ state: "visible", timeout: 30000 });
      await cardsOption.click();
      console.log('✓ Selected "Cards (Credit/Debit)" payment method');

      // Card fields are type="tel" with live formatting, so pressSequentially
      // rather than fill() — same reasoning as PayWay/Omise/iyzico.
      const numberInput = page.locator("#cardNumber");
      await numberInput.waitFor({ state: "visible", timeout: 30000 });
      await numberInput.click();
      await numberInput.pressSequentially(CARD_NUMBER, { delay: 50 });
      console.log(
        `✓ Card number field now contains: "${await numberInput.inputValue()}"`,
      );

      // maxlength="5" means the "/" is auto-inserted — send digits only, or the
      // separator eats one of the year characters.
      const expiryInput = page.locator("#cardExpiry");
      await expiryInput.waitFor({ state: "visible", timeout: 30000 });
      await expiryInput.click();
      await expiryInput.pressSequentially(`${EXPIRY_MONTH}${EXPIRY_YY}`, {
        delay: 50,
      });

      if (!/^\d{2}\s*\/\s*\d{2}$/.test(await expiryInput.inputValue())) {
        console.log(
          `⚠ Expiry looks unmasked ("${await expiryInput.inputValue()}") — retyping with separator...`,
        );
        await expiryInput.fill("");
        await expiryInput.pressSequentially(`${EXPIRY_MONTH}/${EXPIRY_YY}`, {
          delay: 50,
        });
      }
      console.log(
        `✓ Expiry field now contains: "${await expiryInput.inputValue()}"`,
      );

      const cvvInput = page.locator("#cardCvv");
      await cvvInput.waitFor({ state: "visible", timeout: 30000 });
      await cvvInput.click();
      await cvvInput.pressSequentially(CARD_CVV, { delay: 50 });
      // Field is class="numeric-passowrd" (sic) so the value may read back
      // masked — log length instead of the raw value.
      console.log(
        `✓ CVV field now holds ${(await cvvInput.inputValue()).length} character(s)`,
      );

      const holderInput = page.locator("#cardOwnerName");
      await holderInput.waitFor({ state: "visible", timeout: 30000 });
      await holderInput.click();
      await holderInput.pressSequentially(CARD_HOLDER, { delay: 50 });
      console.log(
        `✓ Card holder field now contains: "${await holderInput.inputValue()}"`,
      );

      // Only wait for the button to become enabled — the click itself belongs
      // to submitCardPayment (same split as PayWay).
      const proceedButton = page.locator(
        'button.common-btn[type="submit"]:not([disabled])',
      );
      await proceedButton.waitFor({ state: "visible", timeout: 30000 });
      console.log(
        `✓ Proceed button enabled: "${(await proceedButton.innerText()).trim().replace(/\s+/g, " ")}"`,
      );

      console.log("✓ All PayU fields filled");
    },

    submitCardPayment: async (page) => {
      console.log("Attempting PayU submission...");

      if (paymentAlreadyCompleted(page)) {
        console.log(
          `✓ Payment already went through — at "${page.url()}". Nothing to click.`,
        );
        return;
      }

      const OTP = "123456";

      // ---- Step 1: PROCEED on the card form ----
      const proceedButton = page.locator(
        'button.common-btn[type="submit"]:not([disabled])',
      );
      await proceedButton.waitFor({ state: "visible", timeout: 30000 });

      const urlBeforeProceed = page.url();
      await page.mouse.move(10, 10);
      await proceedButton.scrollIntoViewIfNeeded();
      await proceedButton.click();
      console.log("Clicked PayU 'PROCEED' button");

      // ---- Step 2: "Continue without saving" on the save-card prompt ----
      // In-page modal on the same hash route, so the URL doesn't change — wait
      // on the button itself rather than on navigation.
      const continueWithoutSaving = page.locator(
        'button[data-testid="closeWithoutSave"]',
      );

      try {
        await continueWithoutSaving.waitFor({
          state: "visible",
          timeout: 20000,
        });
        await continueWithoutSaving.click();
        console.log('✓ Clicked "Continue without saving"');
      } catch {
        console.log(
          "No save-card prompt appeared — continuing to the simulator",
        );
      }

      if (
        !(await waitForSubmissionToTakeEffect(page, urlBeforeProceed, 30000))
      ) {
        throw new Error(
          `Submitted the PayU card form but the page never left "${urlBeforeProceed}".`,
        );
      }
      console.log(`✓ Left the card form — now at "${page.url()}"`);

      // ---- Step 3: PayU 3DS simulator ----
      // The simulator shows two screens — an OTP form (#OTPForm, POST
      // /authenticateCard) and a "Simulate Success Response" screen — and the
      // order isn't fixed. Handle whichever is on screen and loop until neither
      // remains, so this survives either ordering.
      const otpForm = page.locator("form#OTPForm");
      const simulateSuccess = page.locator(
        'input[name="authenticate"][value="Simulate Success Response"]',
      );

      const MAX_SIMULATOR_SCREENS = 4;

      for (let screen = 1; screen <= MAX_SIMULATOR_SCREENS; screen += 1) {
        // Whichever appears first wins. Long timeout on the first pass only —
        // the simulator is slow to render after the 3DS hop.
        const timeout = screen === 1 ? 60000 : 20000;
        let handled = false;

        try {
          await Promise.race([
            otpForm.waitFor({ state: "visible", timeout }),
            simulateSuccess.waitFor({ state: "visible", timeout }),
          ]);
        } catch {
          console.log(
            `No further simulator screen after ${screen - 1} screen(s)`,
          );
          break;
        }

        const urlBeforeScreen = page.url();

        // --- "Simulate Success Response" screen ---
        if (await simulateSuccess.isVisible().catch(() => false)) {
          await simulateSuccess.scrollIntoViewIfNeeded();
          await simulateSuccess.click();
          console.log(
            `✓ [screen ${screen}] Clicked 'Simulate Success Response'`,
          );
          handled = true;
        }
        // --- #OTPForm screen ---
        else if (await otpForm.isVisible().catch(() => false)) {
          const otpInput = otpForm.locator('input[name="OTP"]');
          await otpInput.waitFor({ state: "visible", timeout: 30000 });
          await otpInput.click();
          await otpInput.fill("");
          await otpInput.pressSequentially(OTP, { delay: 50 });
          console.log(
            `✓ [screen ${screen}] OTP field holds ${(await otpInput.inputValue()).length} character(s)`,
          );

          const otpSubmit = otpForm.locator('input.otp-cmn-btn[name="Submit"]');
          await otpSubmit.waitFor({ state: "visible", timeout: 30000 });
          await otpSubmit.scrollIntoViewIfNeeded();
          await otpSubmit.click();
          console.log(`✓ [screen ${screen}] Clicked 'Submit' on #OTPForm`);

          // checkOTP() unhides #error-label when it rejects the value — that's
          // a fill problem, not a click problem, so surface it distinctly.
          const errorLabel = otpForm.locator("#error-label");
          await page.waitForTimeout(1000);
          if (await errorLabel.isVisible().catch(() => false)) {
            throw new Error(
              `checkOTP() rejected the OTP: "${(await errorLabel.innerText()).trim()}".`,
            );
          }

          handled = true;
        }

        if (!handled) break;

        // Either screen navigates; if nothing moves, the click didn't take.
        if (
          !(await waitForSubmissionToTakeEffect(page, urlBeforeScreen, 60000))
        ) {
          console.log(
            `⚠ [screen ${screen}] Page never left "${urlBeforeScreen}" — stopping simulator loop`,
          );
          break;
        }
        console.log(`✓ [screen ${screen}] Now at "${page.url()}"`);
      }

      console.log(`✓ PayU submission flow finished — at "${page.url()}"`);
    },
  },

  Conekta: {
    fillCardDetails: async (page) => {
      console.log("Filling Conekta card details (inside iframe)...");

      // Conekta mounts a zoid embedded component into #conektaIframeContainer.
      // Its iframe carries no src we can match on — the config is encoded into
      // the frame NAME, and the real content comes from pay.conekta.com — so
      // find the frame by the field it owns rather than by URL. The sibling
      // "__detect_close__" iframe is display:none, and this scan requires a
      // VISIBLE match, so it can't be picked by mistake.
      const cardFrame = await waitForFrameWithSelector(
        page,
        '[data-testid="payment-method-Card"], #cardNumber',
        45000,
      );
      console.log(`✓ Conekta iframe found: ${cardFrame.url()}`);

      // Conekta rejects the 4564... card the other gateways share — this is
      // Conekta's own documented test card (approved-payment path).
      const CARD_NUMBER = "5576041385402646";
      const CARD_NAME = "Token Tutorial";
      const CARD_CVV = "1234";
      const CARD_EXPIRY_MONTH = "02";
      const CARD_EXPIRY_YEAR = String(
        (new Date().getFullYear() + 3) % 100,
      ).padStart(2, "0");
      const CARD_EXPIRY = `${CARD_EXPIRY_MONTH}/${CARD_EXPIRY_YEAR}`;

      console.log(`Using fixed test card ending in ${CARD_NUMBER.slice(-4)}`);
      console.log(`Expiry set to ${CARD_EXPIRY} (always current year + 3)`);

      // Payment methods are an accordion — the card fields aren't rendered
      // until "Card" is selected. Guarded rather than unconditional: when Card
      // is the only enabled method Conekta expands it for us, and clicking a
      // already-open item would collapse it again.
      const cardNumberInput = cardFrame.locator("#cardNumber");

      if (!(await cardNumberInput.isVisible().catch(() => false))) {
        const cardMethodRadio = cardFrame.locator(
          '[data-testid="payment-method-Card"]',
        );
        await cardMethodRadio.waitFor({ state: "visible", timeout: 30000 });
        await cardMethodRadio.click();
        console.log("✓ Selected the 'Card' payment method");
      } else {
        console.log("ℹ 'Card' payment method is already expanded");
      }

      await cardNumberInput.waitFor({ state: "visible", timeout: 30000 });
      await cardNumberInput.click();
      await cardNumberInput.pressSequentially(CARD_NUMBER, { delay: 50 });
      await waitForFieldValue(
        page,
        cardNumberInput,
        "Card number",
        CARD_NUMBER,
      );

      // Typed WITH the slash, same as Omise: the mask swallows the separator
      // keystroke when it has already inserted one, so this is correct whether
      // or not the field auto-formats.
      const expiryInput = cardFrame.locator("#cardExpMonthYear");
      await expiryInput.waitFor({ state: "visible", timeout: 30000 });
      await expiryInput.click();
      await expiryInput.pressSequentially(CARD_EXPIRY, { delay: 50 });
      await waitForFieldValue(page, expiryInput, "Expiry", CARD_EXPIRY);

      const cvvInput = cardFrame.locator("#cardVerificationValue");
      await cvvInput.waitFor({ state: "visible", timeout: 30000 });
      await cvvInput.click();
      await cvvInput.pressSequentially(CARD_CVV, { delay: 50 });
      await waitForFieldValue(page, cvvInput, "CVV", CARD_CVV);

      const nameInput = cardFrame.locator("#cardholderName");
      await nameInput.waitFor({ state: "visible", timeout: 30000 });
      await nameInput.click();
      await nameInput.pressSequentially(CARD_NAME, { delay: 50 });
      console.log(
        `✓ Cardholder name field now contains: "${await nameInput.inputValue()}"`,
      );

      console.log("✓ All Conekta card fields filled and confirmed");
    },

    submitCardPayment: async (page) => {
      console.log("Attempting to click Conekta's pay button...");

      if (paymentAlreadyCompleted(page)) {
        console.log(
          `✓ Payment already went through — at "${page.url()}". Nothing to click.`,
        );
        return;
      }

      // Re-resolved rather than threaded through from fillCardDetails(): the
      // submit button lives in the SAME Conekta iframe as the fields, not on
      // the host page, so page.locator() would never see it. Its label carries
      // the amount ("Pay $2,600.00"), hence matching on data-testid.
      const cardFrame = await waitForFrameWithSelector(
        page,
        '[data-testid="payment-form-submit-button"]',
        30000,
      );

      const button = cardFrame.locator(
        '[data-testid="payment-form-submit-button"]',
      );
      await button.waitFor({ state: "visible", timeout: 30000 });

      const urlBeforeClick = page.url();

      await button.scrollIntoViewIfNeeded();
      await button.click();
      console.log("Clicked Conekta's pay button");

      if (await waitForSubmissionToTakeEffect(page, urlBeforeClick, 20000)) {
        console.log(
          "✓ Page left the card form after click — payment submitted",
        );
        return;
      }

      console.log(
        "⚠ Still on the card form after click — trying native JS click...",
      );
      await button
        .evaluate((el) => el.click())
        .catch((err) => {
          console.log(`⚠ Native JS click failed: ${err.message}`);
        });

      if (await waitForSubmissionToTakeEffect(page, urlBeforeClick, 20000)) {
        console.log(
          "✓ Page left the card form after JS click — payment submitted",
        );
        return;
      }

      throw new Error(
        `Clicked Conekta's pay button (both real and native JS click) but the page never left "${urlBeforeClick}".\n` +
          `Buttons present, per frame:\n${await describeSubmitButtons(page)}`,
      );
    },
  },

  MercadoPago: {
    fillCardDetails: async (page) => {
      console.log("Filling MercadoPago card details (full-page redirect)...");

      // The path carries a per-session uuid and the query a preference-id, and
      // the path changes from /payment-option-form/ to /card-form/ after step 1
      // — so only the /redirect/ prefix is matched.
      await waitForUrlPrefix(
        page,
        "https://sandbox.mercadopago.com.br/checkout/v1/redirect/",
        60000,
      );
      console.log(`✓ MercadoPago checkout reached: ${page.url()}`);

      // Fixed test card details. 4242… is a Visa BIN and the form's issuer icon
      // confirmed "Cartão Visa", so the brand resolves.
      //
      // CARD_HOLDER IS NOT COSMETIC. MercadoPago's sandbox keys the payment
      // outcome off the cardholder name: "APRO" forces approval and a realistic
      // name gets rejected. Grep for APRO to drive the negative paths.
      const CARD_NUMBER = "4242424242424242";
      const CARD_HOLDER = "APRO";
      const CARD_CVV = "123";
      const CARD_CPF = "12345678909";
      const CARD_EXPIRY_MONTH = "11";
      const CARD_EXPIRY_YEAR = String(
        (new Date().getFullYear() + 3) % 100,
      ).padStart(2, "0");

      console.log(`Using fixed test card ending in ${CARD_NUMBER.slice(-4)}`);
      console.log(
        `Cardholder name "${CARD_HOLDER}" — sandbox approval code, not a real name`,
      );
      console.log(
        `Expiry set to ${CARD_EXPIRY_MONTH}/${CARD_EXPIRY_YEAR} (always current year + 3)`,
      );

      // -----------------------------------------------------------------
      // Reads ONE named input's value from inside a secure field iframe.
      //
      // Named, not positional: every one of these frames contains all five
      // inputs, so both "the first input" and "any empty value in this frame"
      // are meaningless.
      // -----------------------------------------------------------------
      const readSecureFieldValue = async (frameName, inputId) => {
        const frame = page.frames().find((f) => f.name() === frameName);
        if (!frame) return null;
        return frame
          .evaluate((id) => {
            const el = document.getElementById(id);
            return el ? el.value : null;
          }, inputId)
          .catch(() => null);
      };

      // Full frame dump, for failure paths only.
      const dumpSecureFrame = async (frameName) => {
        const frame = page.frames().find((f) => f.name() === frameName);
        if (!frame) {
          return `(no frame named "${frameName}"; frames: ${JSON.stringify(
            page.frames().map((f) => ({ name: f.name(), url: f.url() })),
          )})`;
        }
        const contents = await frame
          .evaluate(() =>
            Array.from(document.querySelectorAll("input")).map((el) => ({
              id: el.id || null,
              value: el.value || "",
              visible: !!(el.offsetWidth || el.offsetHeight),
            })),
          )
          .catch((e) => ({ error: e.message }));
        return JSON.stringify(contents);
      };

      // -----------------------------------------------------------------
      // Fills a secure field by focusing it from the OUTSIDE, then verifies the
      // one field that matters.
      // -----------------------------------------------------------------
      const fillSecureField = async (fieldName, value, label, delay) => {
        const container = page.locator(
          `[data-testid="secure-field-container-${fieldName}"] [data-testid="secure-input-container"]`,
        );

        await container.waitFor({ state: "visible", timeout: 30000 });
        await container.scrollIntoViewIfNeeded();
        await container.click();

        // Confirms focus crossed into the right iframe before typing — otherwise
        // the keystrokes land on the parent document and vanish.
        const focusedFrameName = await page.evaluate(() => {
          const el = document.activeElement;
          return el && el.tagName.toLowerCase() === "iframe"
            ? el.getAttribute("name")
            : `(not an iframe: ${el ? el.tagName.toLowerCase() : "none"})`;
        });
        console.log(
          `[focus] ${label}: document.activeElement is "${focusedFrameName}"`,
        );

        if (focusedFrameName !== fieldName) {
          console.log(
            `⚠ ${label}: focus did not land on the ${fieldName} iframe — clicking it directly`,
          );
          await page
            .locator(`#iframe-sf-${fieldName}`)
            .click({ timeout: 10000 })
            .catch((err) => {
              console.log(
                `⚠ ${label}: direct iframe click failed: ${err.message}`,
              );
            });
        }

        await page.keyboard.type(value, { delay });

        // Reads back the SPECIFIC field. The frame's own name matches the input
        // id it exposes (cardNumber / expirationDate / securityCode).
        const actual = await readSecureFieldValue(fieldName, fieldName);
        console.log(`✓ ${label} now contains: "${actual}"`);

        // Compared on digits only: MercadoPago formats as it types
        // ("4242 4242 4242 4242", "11/29"), so a literal comparison against the
        // typed string would always fail.
        const digitsTyped = value.replace(/\D/g, "");
        const digitsActual = (actual || "").replace(/\D/g, "");

        if (digitsActual !== digitsTyped) {
          const dump = await dumpSecureFrame(fieldName);
          throw new Error(
            `MercadoPago ${label}: #${fieldName} holds "${actual}" (digits "${digitsActual}") ` +
              `but "${value}" was typed.\n` +
              `  Frame inputs: ${dump}\n` +
              `  Focus reported: "${focusedFrameName}"\n` +
              `  URL: ${page.url()}\n` +
              `  Note every one of these frames contains all five inputs, so only #${fieldName} ` +
              `is meaningful here — ignore empty values on the others.`,
          );
        }
      };

      // ==================================================================
      // STEP 1 — choose "Cartão"
      // ==================================================================
      // Anchored on the row's content id rather than the andes-* classes or the
      // text "Cartão", which also appears in saved-card rows.
      const cardOptionRow = page
        .locator("button")
        .filter({ has: page.locator("#new_card_row-content") })
        .first();

      await cardOptionRow.waitFor({ state: "visible", timeout: 45000 });
      await cardOptionRow.scrollIntoViewIfNeeded();
      await cardOptionRow.click();
      console.log("✓ 'Cartão' payment option clicked");

      await page
        .locator("#iframe-sf-cardNumber")
        .waitFor({ state: "attached", timeout: 45000 });
      console.log("✓ Card form reached");

      // ==================================================================
      // STEP 2 — card fields
      // ==================================================================
      await fillSecureField("cardNumber", CARD_NUMBER, "Card number", 60);

      // Waits for the BIN lookup rather than sleeping on a fixed timer. The
      // issuer icon appearing is MercadoPago's own signal that the brand
      // resolved, and that resolution is what re-renders the form.
      console.log(
        "Waiting for the BIN lookup (issuer icon) before the next field...",
      );
      const issuerIcon = page.locator('[data-testid="sf-issuer-icon"]');
      const brandResolved = await issuerIcon
        .waitFor({ state: "visible", timeout: 20000 })
        .then(() => true)
        .catch(() => false);

      if (brandResolved) {
        console.log(
          `✓ Card brand resolved: "${await issuerIcon.getAttribute("title").catch(() => null)}"`,
        );
      } else {
        console.log(
          "⚠ Issuer icon never appeared — the BIN did not resolve, so the card number may be " +
            "outside the sandbox's accepted set. Continuing anyway.",
        );
      }

      await page.waitForTimeout(1500);

      await fillSecureField(
        "expirationDate",
        `${CARD_EXPIRY_MONTH}${CARD_EXPIRY_YEAR}`,
        "Expiry",
        80,
      );

      await fillSecureField("securityCode", CARD_CVV, "CVV", 60);

      // -- Cardholder name (main document, not iframed) ---------------------
      const holderInput = page.locator("#cardholderName");
      await holderInput.waitFor({ state: "visible", timeout: 30000 });
      await holderInput.click();
      await holderInput.pressSequentially(CARD_HOLDER, { delay: 40 });
      console.log(
        `✓ Cardholder name field now contains: "${await holderInput.inputValue()}"`,
      );

      // -- CPF (main document) ----------------------------------------------
      // The document-type dropdown already reads "CPF", so only the number is
      // entered. The field masks to 000.000.000-00, so digits only are typed.
      const cpfInput = page.locator("#cardholderIdentificationNumber");
      await cpfInput.waitFor({ state: "visible", timeout: 30000 });
      await cpfInput.click();
      await cpfInput.pressSequentially(CARD_CPF, { delay: 50 });
      console.log(`✓ CPF field now contains: "${await cpfInput.inputValue()}"`);

      // -- Validation readback ----------------------------------------------
      // Per-field error text in the parent document. The containers ship with
      // "has-error" and "Preencha este campo." while EMPTY, so an error before
      // typing is normal — only one remaining after is meaningful. The cardholder
      // name uses the andes helper rather than a secure-field error span, so it
      // is read separately.
      for (const field of ["cardNumber", "expirationDate", "securityCode"]) {
        const errorText = await page
          .locator(`[data-testid="secure-field-error-${field}"]`)
          .textContent()
          .catch(() => null);
        if (errorText && errorText.trim()) {
          console.log(
            `⚠ ${field} still reports an error: "${errorText.trim()}"`,
          );
        }
      }

      const holderError = await page
        .locator("#cardholderName-message .andes-helper__label")
        .textContent()
        .catch(() => null);
      if (holderError && /Preencha/i.test(holderError)) {
        console.log(`⚠ Cardholder name still reports: "${holderError.trim()}"`);
      }

      console.log("✓ All card fields filled");

      // ==================================================================
      // STEP 3 — Continuar
      // ==================================================================
      // Matched on the app-specific class plus the label. The id (_r_61_) is
      // React auto-generated and changes every render, and andes-button--loud is
      // a design-system modifier shared with the Pagar button — continue_button
      // is what actually distinguishes this one.
      const continueButton = page
        .locator("button.continue_button")
        .filter({ hasText: /Continuar/i })
        .first();
      await continueButton.waitFor({ state: "visible", timeout: 30000 });
      await continueButton.scrollIntoViewIfNeeded();
      await continueButton.click();
      console.log("✓ Continuar clicked");

      // Continuar and Pagar are BOTH in the DOM at once, so neither "Pagar
      // exists" nor "Continuar vanished" is a reliable signal on its own —
      // MercadoPago sometimes swaps the card step out and sometimes just
      // reveals the summary alongside it. Either outcome is accepted here and
      // neither is fatal: what matters is only that Pagar ends up clickable,
      // which submitCardPayment() enforces for itself.
      const settled = await Promise.race([
        continueButton
          .waitFor({ state: "hidden", timeout: 30000 })
          .then(() => "continuar-gone"),
        page
          .locator("button.cow-payment_summary__button.entered")
          .first()
          .waitFor({ state: "visible", timeout: 30000 })
          .then(() => "pagar-ready"),
      ]).catch(() => null);

      console.log(
        settled
          ? `✓ Payment summary reached (${settled})`
          : "⚠ Neither Continuar disappearing nor Pagar becoming ready was seen — " +
              "submitCardPayment will wait for Pagar on its own",
      );

      // No Pagar click here on purpose: submitCardPayment() runs immediately
      // after this and owns the authorising action.
      console.log("✓ Ready to click Pagar");
    },

    submitCardPayment: async (page) => {
      console.log("Clicking MercadoPago 'Pagar' button...");

      // Matched on the app-specific class plus the label, for the same reason as
      // Continuar: the id (_r_6s_) is React-generated and the andes-* classes are
      // shared. cow-payment_summary__button is unique to the summary screen's
      // pay action.
      //
      // Waited generously: this button only appears after MercadoPago has loaded
      // the payment summary, which is a fresh page render after Continuar.
      const payButton = page
        .locator("button.cow-payment_summary__button")
        .filter({ hasText: /Pagar/i })
        .first();

      const appeared = await payButton
        .waitFor({ state: "visible", timeout: 60000 })
        .then(() => true)
        .catch(() => false);

      if (!appeared) {
        // Reports what IS on the page rather than just timing out, so a changed
        // class name or a stalled card step is visible in the failure itself.
        const buttons = await page
          .locator("button")
          .evaluateAll((els) =>
            els
              .filter((el) => el.offsetWidth || el.offsetHeight)
              .map((el) => ({
                text: (el.textContent || "").trim().slice(0, 40),
                class: el.className,
                disabled: el.disabled,
              })),
          )
          .catch(() => []);

        throw new Error(
          "MercadoPago: no visible button.cow-payment_summary__button reading " +
            `"Pagar" after 60s.\n  URL: ${page.url()}\n` +
            `  Visible buttons: ${JSON.stringify(buttons)}`,
        );
      }

      await payButton.scrollIntoViewIfNeeded();

      // The summary button carries andes-button--progress while MercadoPago is
      // still settling the amount, and a click landing in that window is
      // swallowed. "entered" is the class it gains once it is ready to take one.
      await payButton
        .and(page.locator(".entered"))
        .waitFor({ state: "visible", timeout: 30000 })
        .catch(() => {
          console.log(
            "⚠ Pagar never gained the 'entered' class — clicking anyway",
          );
        });

      // Clicked up to three times. MercadoPago drops the first click when the
      // summary is still re-rendering, and the button simply stays put — no
      // error, no navigation — so a swallowed click is only detectable by the
      // page not moving. The button detaching or the URL leaving the card form
      // is what counts as the click having landed.
      const urlBefore = page.url();

      // MercadoPago answers the payment with a modal — "Ok, entendi" is its
      // dismiss button — instead of navigating. That modal appearing is itself
      // proof the click landed, so it counts alongside the button detaching and
      // the URL changing. Matched on the label: the modal's own classes are the
      // same shared andes-* set as every other button on the page.
      const acknowledgeButton = page
        .getByRole("button", { name: /Ok,?\s*entendi/i })
        .first();

      let landed = false;

      for (let attempt = 1; attempt <= 3 && !landed; attempt++) {
        await payButton.click({ timeout: 15000 }).catch((err) => {
          console.log(`⚠ Pagar click attempt ${attempt} threw: ${err.message}`);
        });
        console.log(`Pagar click attempt ${attempt} sent`);

        landed = await Promise.race([
          payButton.waitFor({ state: "hidden", timeout: 10000 }),
          page.waitForURL((url) => url.toString() !== urlBefore, {
            timeout: 10000,
          }),
          acknowledgeButton.waitFor({ state: "visible", timeout: 10000 }),
        ])
          .then(() => true)
          .catch(() => false);
      }

      if (!landed) {
        console.log(
          "⚠ Pagar was clicked but the page has not moved — the checkout may be " +
            "processing in place, or the click was swallowed. Leaving the outcome " +
            "to the thank-you-page assertion.",
        );
      }

      console.log("✓ Pagar clicked");

      // ==================================================================
      // Post-payment modal — "Ok, entendi"
      // ==================================================================
      // Optional: it does not appear on every outcome, so a miss is logged
      // rather than thrown. When it IS shown, the redirect back to the store
      // does not happen until it is dismissed — leaving it open strands the run
      // on MercadoPago and the thank-you assertion fails for the wrong reason.
      const hasModal = await acknowledgeButton
        .waitFor({ state: "visible", timeout: 15000 })
        .then(() => true)
        .catch(() => false);

      if (hasModal) {
        // The modal's message says whether this was an approval or a rejection;
        // logged before dismissing so a failed run still records the reason.
        const modalText = await page
          .locator('[role="dialog"], .andes-modal__content')
          .first()
          .innerText()
          .catch(() => null);
        if (modalText) {
          console.log(
            `MercadoPago modal says: "${modalText.replace(/\s+/g, " ").trim().slice(0, 300)}"`,
          );
        }

        await acknowledgeButton.click({ timeout: 15000 });
        console.log("✓ 'Ok, entendi' clicked");

        await acknowledgeButton
          .waitFor({ state: "hidden", timeout: 15000 })
          .catch(() => {
            console.log("⚠ The modal is still open after 'Ok, entendi'");
          });
      } else {
        console.log("No 'Ok, entendi' modal shown — continuing");
      }
    },
  },
  //8th
  Dodo: {
    fillCardDetails: async (page) => {
      console.log(
        "Filling Dodo Payments checkout (full-page redirect; step 1 is page DOM, step 2's card fields are iframed)...",
      );

      await waitForDodoCheckoutPage(page);

      // ---- Step 1: Billing details ----
      const CARD_NAME = "Token Tutorial";
      const ADDRESS_LINE = "123 Main Street";
      const CITY = "New York";
      const ZIP_CODE = "10001";
      // Free-text input, not a dropdown — Dodo takes the two-letter code.
      const STATE = "NY";

      console.log("Filling billing details (step 1)...");

      const fullNameInput = page.locator('input[name="fullName"]');
      await fullNameInput.waitFor({ state: "visible", timeout: 30000 });
      await fullNameInput.click();
      await fullNameInput.fill(CARD_NAME);
      console.log(
        `✓ Full name field now contains: "${await fullNameInput.inputValue()}"`,
      );

      // Dodo ships TWO address inputs, both labelled "Address Line":
      //   1. a combobox backed by an address-autocomplete listbox (visible by default)
      //   2. input[name="addressLine"], part of the manual form (hidden by default)
      // Matching on aria-label alone hits both and trips strict mode. Take the
      // manual path instead — it also reveals City/Zip, which don't exist on the
      // page at all while the autocomplete is in charge, and it avoids depending
      // on a third-party suggestion service returning a hit for our test address.
      const manualAddressButton = page.getByRole("button", {
        name: "Enter address manually",
      });

      if (await manualAddressButton.isVisible().catch(() => false)) {
        await manualAddressButton.click();
        console.log("✓ Switched to manual address entry");
      } else {
        console.log(
          "ℹ No 'Enter address manually' button — form is already in manual mode",
        );
      }

      const addressInput = page.locator('input[name="addressLine"]');
      await addressInput.waitFor({ state: "visible", timeout: 30000 });
      await addressInput.click();
      await addressInput.fill(ADDRESS_LINE);
      console.log(
        `✓ Address line field now contains: "${await addressInput.inputValue()}"`,
      );

      const cityInput = page.locator('input[name="city"]');
      await cityInput.waitFor({ state: "visible", timeout: 30000 });
      await cityInput.click();
      await cityInput.fill(CITY);
      console.log(
        `✓ City field now contains: "${await cityInput.inputValue()}"`,
      );

      const zipInput = page.locator('input[name="zipCode"]');
      await zipInput.waitFor({ state: "visible", timeout: 30000 });
      await zipInput.click();
      await zipInput.fill(ZIP_CODE);
      console.log(
        `✓ Zip code field now contains: "${await zipInput.inputValue()}"`,
      );

      const stateInput = page.locator('input[name="state"]');
      await stateInput.waitFor({ state: "visible", timeout: 30000 });
      await stateInput.click();
      await stateInput.fill(STATE);
      console.log(
        `✓ State field now contains: "${await stateInput.inputValue()}"`,
      );

      const continueButton = page.locator("#step1");
      await continueButton.waitFor({ state: "visible", timeout: 30000 });
      await continueButton.click();
      console.log("✓ Clicked 'Continue to Payment'");

      // ---- Step 2: Card details ----
      console.log("Filling card details (step 2)...");

      const CARD_NUMBER = "4111111111111111";
      const CARD_CVV = "847";
      const currentYear = new Date().getFullYear();
      // Raw digits only — like the card number field, this mask auto-inserts
      // the " / " separator as you type, so typing it yourself would double up.
      const CARD_EXPIRY_DIGITS = `02${String((currentYear + 3) % 100).padStart(2, "0")}`;

      // Unlike step 1, which is plain page DOM, step 2's card fields are
      // iframed — page.locator() can never see them however the selector is
      // written, which is exactly how a visibly-present "Card number" field
      // still timed out here. Resolve the owning frame once and scope all
      // three fields to it.
      const cardFrame = await waitForFrameWithSelector(
        page,
        'input.DodoCardInput[aria-label="Card number"]',
      );

      // All three card fields share class "DodoCardInput" — must disambiguate
      // by aria-label, not class.
      const cardNumberInput = cardFrame.locator(
        'input.DodoCardInput[aria-label="Card number"]',
      );
      await cardNumberInput.waitFor({ state: "visible", timeout: 30000 });
      await cardNumberInput.click();
      await cardNumberInput.pressSequentially(CARD_NUMBER, { delay: 50 });
      await waitForFieldValue(
        page,
        cardNumberInput,
        "Card number",
        CARD_NUMBER,
      );

      const expiryInput = cardFrame.locator(
        'input.DodoCardInput[aria-label="Expiry"]',
      );
      await expiryInput.waitFor({ state: "visible", timeout: 30000 });
      await expiryInput.click();
      await expiryInput.pressSequentially(CARD_EXPIRY_DIGITS, { delay: 50 });
      await waitForFieldValue(page, expiryInput, "Expiry", CARD_EXPIRY_DIGITS);

      const cvcInput = cardFrame.locator(
        'input.DodoCardInput[aria-label="Security code"]',
      );
      await cvcInput.waitFor({ state: "visible", timeout: 30000 });
      await cvcInput.click();
      await cvcInput.pressSequentially(CARD_CVV, { delay: 50 });
      await waitForFieldValue(page, cvcInput, "Security code", CARD_CVV);

      console.log(
        "✓ All Dodo Payments card fields filled and confirmed — ready to submit",
      );
    },

    submitCardPayment: async (page) => {
      console.log("Attempting to click Dodo Payments 'Pay now' button...");

      if (paymentAlreadyCompleted(page)) {
        console.log(
          `✓ Payment already went through — at "${page.url()}". Nothing to click.`,
        );
        return;
      }

      const button = page.locator("#submit");
      await button.waitFor({ state: "visible", timeout: 30000 });

      const urlBeforeClick = page.url();

      await button.scrollIntoViewIfNeeded();
      await button.click();
      console.log("Clicked 'Pay now'");

      if (await waitForSubmissionToTakeEffect(page, urlBeforeClick, 20000)) {
        console.log(
          "✓ Page left the card form after click — payment submitted",
        );
        return;
      }

      console.log(
        "⚠ Still on the card form after click — trying native JS click...",
      );
      await button
        .evaluate((el) => el.click())
        .catch((err) => {
          console.log(`⚠ Native JS click failed: ${err.message}`);
        });

      if (await waitForSubmissionToTakeEffect(page, urlBeforeClick, 20000)) {
        console.log(
          "✓ Page left the card form after JS click — payment submitted",
        );
        return;
      }

      throw new Error(
        `Clicked Dodo Payments 'Pay now' but the page never left "${urlBeforeClick}".`,
      );
    },
  },

  NinePay: {
    fillCardDetails: async (page) => {
      console.log(
        "Filling 9Pay checkout (full-page redirect, multi-step, no iframe)...",
      );

      // URL is https://sand-payment.9pay.vn/portal/<invoice-id> — the id is
      // per-order, so only the fixed prefix matches.
      await waitForUrlPrefix(page, "https://sand-payment.9pay.vn/portal/");

      // The portal page keeps rendering after the url settles — the method
      // screen's radios/labels are wired up late, so give it time to finish
      // before touching step 1. Bounded and swallowed: on a fast run the page
      // is already idle and there is nothing left to wait for.
      await page
        .waitForLoadState("networkidle", { timeout: 30000 })
        .catch(() => {});
      await page.waitForTimeout(3000);
      console.log("✓ 9Pay portal settled");

      // 9Pay's domestic (napas) flow — not an international card form, so the
      // shared test card doesn't apply. These are 9Pay's own sandbox values.
      const CARD_NUMBER = "9704000000000018";
      const CARD_HOLDER = "NGUYEN VAN A";
      // Fixed sandbox expiry, NOT the usual current-year+3 convention: napas
      // test cards are issued against a specific date and reject anything else.
      const CARD_EXPIRY = "03/07";

      // Each field is clicked to focus it before typing, and the inputs are
      // type="tel" with live formatting, so pressSequentially rather than
      // fill() — same reasoning as PayWay/Omise/iyzico/Checkout.
      const clickAndType = async (selector, label, value) => {
        const input = page.locator(selector);
        await input.waitFor({ state: "visible", timeout: 30000 });
        await input.scrollIntoViewIfNeeded();
        await input.click();
        await input.pressSequentially(value, { delay: 50 });
        return input;
      };

      // ---- Step 1: choose "Local debit card and bank account" ----
      // The radio itself is styled away; the <label for="domestic-card"> is the
      // clickable surface.
      const domesticCard = page.locator('label[for="domestic-card"]');
      await domesticCard.waitFor({ state: "visible", timeout: 60000 });
      await domesticCard.click();
      console.log("✓ Selected 'Local debit card and bank account'");

      // ---- Step 2: Continue ----
      // Both screens' Continue buttons carry .btn-payment-method-next and both
      // sit in the DOM from the start, so the bare selector is a strict-mode
      // violation. Filter to the shown one and disambiguate by document order:
      // the method screen's is the earlier, the bank screen's the later.
      const visibleContinue = page.locator(
        "button.btn-payment-method-next:visible",
      );
      const methodContinue = visibleContinue.first();
      await methodContinue.waitFor({ state: "visible", timeout: 30000 });
      await methodContinue.click();
      console.log("✓ Clicked Continue on the payment-method screen");

      // ---- Step 3: pick the bank ----
      // The bank tiles are background-image divs with no text or id — the only
      // stable handle is the image URL in the inline style attribute.
      const bankTile = page.locator(
        'div.bg-logo-bank[style*="group-1399-1636621132"]',
      );
      await bankTile.waitFor({ state: "visible", timeout: 30000 });
      await bankTile.scrollIntoViewIfNeeded();
      await bankTile.click();
      console.log("✓ Selected the bank");

      // ---- Step 4: Continue ----
      // Same markup as step 2's button. Taking the last visible one covers both
      // shapes: if the bank screen renders its own Continue it is the later in
      // the DOM, and if the method screen's button is reused there is only one.
      const bankContinue = visibleContinue.last();
      await bankContinue.waitFor({ state: "visible", timeout: 30000 });
      await bankContinue.scrollIntoViewIfNeeded();
      await bankContinue.click();
      console.log("✓ Clicked Continue on the bank-selection screen");

      // The card form swaps in without a URL change and its inputs get their
      // live formatting attached after render — typing too early loses the
      // leading digits, so settle first.
      await page.waitForTimeout(3000);
      console.log("✓ Card form settled");

      // ---- Step 5: card details ----
      const numberInput = await clickAndType(
        "#card-number",
        "card number",
        CARD_NUMBER,
      );
      console.log(
        `✓ Card number field now contains: "${await numberInput.inputValue()}"`,
      );

      const holderInput = await clickAndType(
        "#hold-name",
        "cardholder name",
        CARD_HOLDER,
      );
      console.log(
        `✓ Cardholder field now contains: "${await holderInput.inputValue()}"`,
      );

      // maxlength="7" is wider than MM/YY, so the "/" may or may not be
      // auto-inserted — type it and correct if the field doubled it up.
      const expiryInput = await clickAndType(
        "#card-expiry-date",
        "expiry date",
        CARD_EXPIRY,
      );

      if (!/^\d{2}\s*\/\s*\d{2}$/.test(await expiryInput.inputValue())) {
        console.log(
          `⚠ Expiry reads "${await expiryInput.inputValue()}" — retyping digits only...`,
        );
        await expiryInput.fill("");
        await expiryInput.click();
        await expiryInput.pressSequentially(CARD_EXPIRY.replace("/", ""), {
          delay: 50,
        });
      }
      console.log(
        `✓ Expiry field now contains: "${await expiryInput.inputValue()}"`,
      );

      // Wait only — the click belongs to submitCardPayment (same split as
      // PayWay). Distinct class from the two earlier Continue buttons, and
      // filtered the same way in case the card screen is duplicated too.
      const cardContinue = page
        .locator("button.continue-inland-payment:visible")
        .first();
      await cardContinue.waitFor({ state: "visible", timeout: 30000 });
      console.log("✓ Card-form Continue button ready");

      console.log("✓ All 9Pay fields filled");
    },

    submitCardPayment: async (page) => {
      console.log("Attempting 9Pay two-step submission...");

      if (paymentAlreadyCompleted(page)) {
        console.log(
          `✓ Payment already went through — at "${page.url()}". Nothing to click.`,
        );
        return;
      }

      // ---- Step 6: Continue on the card form ----
      const cardContinue = page
        .locator("button.continue-inland-payment:visible")
        .first();
      await cardContinue.waitFor({ state: "visible", timeout: 30000 });
      await page.mouse.move(10, 10);
      await cardContinue.scrollIntoViewIfNeeded();
      await cardContinue.click();
      console.log("✓ Clicked Continue on the card form");

      // Give the OTP screen a moment to take over before looking for its Pay
      // button — the Continue button is still in the DOM right after the click.
      await page.waitForTimeout(3000);

      // ---- Step 7: Pay on the OTP screen ----
      // The screens swap in place without a URL change, so progress is the Pay
      // button appearing rather than a navigation. Long wait: the OTP screen is
      // slow to render.
      const payButton = page.locator("#submit_otp");
      await payButton.waitFor({ state: "visible", timeout: 60000 });
      console.log("✓ OTP screen rendered");

      const urlBeforePay = page.url();
      await payButton.scrollIntoViewIfNeeded();
      await payButton.click();
      console.log("✓ Clicked 'Pay' on the OTP screen");

      if (!(await waitForSubmissionToTakeEffect(page, urlBeforePay, 60000))) {
        console.log(
          "⚠ Still on the OTP screen after click — trying native JS click...",
        );
        await payButton
          .evaluate((el) => el.click())
          .catch((err) => {
            console.log(`⚠ Native JS click failed: ${err.message}`);
          });

        if (!(await waitForSubmissionToTakeEffect(page, urlBeforePay, 30000))) {
          throw new Error(
            `Clicked 9Pay 'Pay' but the page never left "${urlBeforePay}".`,
          );
        }
      }

      console.log(`✓ 9Pay payment submitted — now at "${page.url()}"`);
    },
  },

  Khalti: {
    // Khalti sandbox test wallet credentials (public, documented by Khalti).
    // Valid only against test-pay.khalti.com — no effect on the live host.
    TEST_MOBILE: "9800000001",
    TEST_MPIN: "1111",
    TEST_OTP: "987654",

    async fillCardDetails(page, card = {}) {
      console.log(
        "[Khalti] Waiting for redirect to Khalti hosted payment page...",
      );
      await waitForUrlPrefix(page, "https://test-pay.khalti.com/");
      console.log(`[Khalti] Landed on hosted page: ${page.url()}`);

      // ---- Step 1: choose the Khalti Wallet payment method tile ----
      // MUI emotion classes (css-gs8ko etc.) are build-hashed and churn on every
      // Khalti front-end deploy. aria-label is the only stable hook here.
      const walletTile = page.locator('button[aria-label="KHALTI"]');
      console.log(
        "[Khalti] Waiting for 'Khalti Wallet' payment method tile...",
      );
      await walletTile.waitFor({ state: "visible", timeout: 60000 });
      await walletTile.scrollIntoViewIfNeeded();
      console.log("[Khalti] Clicking 'Khalti Wallet' tile...");
      await walletTile.click();

      // ---- Step 2: mobile number ----
      // NOTE: the DOM ids (_r_3_, _r_4_, _r_d_ ...) are React useId() output.
      // Position-dependent and unstable across renders — never locate by them.
      const mobileInput = page
        .locator(
          'input.MuiOutlinedInput-input[type="text"]:not([autocomplete="one-time-code"])',
        )
        .first();

      console.log("[Khalti] Waiting for mobile number field...");
      await mobileInput.waitFor({ state: "visible", timeout: 45000 });
      await mobileInput.click();

      const mobile = this.TEST_MOBILE;
      console.log(`[Khalti] Typing mobile number: ${mobile}`);
      await mobileInput.pressSequentially(mobile, { delay: 50 });

      const mobileValue = await mobileInput.inputValue();
      console.log(`[Khalti] Mobile field now reads: "${mobileValue}"`);
      if (mobileValue.replace(/\D/g, "") !== mobile) {
        throw new Error(
          `[Khalti] Mobile number failed to register. Expected "${mobile}", got "${mobileValue}"`,
        );
      }

      // ---- Step 3: MPIN ----
      // type="password" but readable via inputValue() (same as the eWAY CVV).
      // Do NOT assert toBeEditable() — Khalti inputs carry a decorative
      // aria-readonly="true" while remaining fully editable.
      const mpinInput = page.locator('input[type="password"]').first();

      console.log("[Khalti] Waiting for MPIN field...");
      await mpinInput.waitFor({ state: "visible", timeout: 30000 });
      await mpinInput.click();

      const mpin = this.TEST_MPIN;
      console.log("[Khalti] Typing MPIN (masked)...");
      await mpinInput.pressSequentially(mpin, { delay: 50 });

      const mpinValue = await mpinInput.inputValue();
      console.log(`[Khalti] MPIN field length: ${mpinValue.length}`);
      if (mpinValue !== mpin) {
        throw new Error(
          `[Khalti] MPIN failed to register. Expected ${mpin.length} chars, got ${mpinValue.length}`,
        );
      }

      console.log(
        "[Khalti] Credentials filled and validated. Ready to submit.",
      );
    },

    async submitCardPayment(page) {
      // ---- Step 4: submit mobile + MPIN ----
      // Located by exact text. The Submit and Pay buttons share the identical
      // emotion class (css-v52kj4), so class-based locating is ambiguous here.
      const submitButton = page
        .getByRole("button", { name: "Submit", exact: true })
        .first();

      console.log("[Khalti] Waiting for Submit button...");
      await submitButton.waitFor({ state: "visible", timeout: 30000 });
      await submitButton.scrollIntoViewIfNeeded();

      console.log("[Khalti] Clicking Submit (attempt 1: real mouse)...");
      const submitBox = await submitButton.boundingBox();
      if (submitBox) {
        await page.mouse.move(
          submitBox.x + submitBox.width / 2,
          submitBox.y + submitBox.height / 2,
        );
        await page.mouse.down();
        await page.mouse.up();
      } else {
        await submitButton.click();
      }

      // ---- Step 5: OTP ----
      // MuiOtpInput renders six discrete inputs. The MuiOtpInput-TextField-N
      // classes are component-generated (not emotion-hashed) and are stable.
      const otpBox = page.locator(".MuiOtpInput-Box");
      let otpVisible = await otpBox
        .waitFor({ state: "visible", timeout: 30000 })
        .then(() => true)
        .catch(() => false);

      if (!otpVisible) {
        console.log(
          "[Khalti] OTP box not visible — retrying Submit (attempt 2: native JS click)...",
        );
        await submitButton.evaluate((el) => el.click());
        otpVisible = await otpBox
          .waitFor({ state: "visible", timeout: 30000 })
          .then(() => true)
          .catch(() => false);
      }

      if (!otpVisible) {
        console.log(
          "[Khalti] OTP box still absent — retrying Submit (attempt 3: dispatched event)...",
        );
        // MUI renders type="button" outside a <form>, so requestSubmit() does not
        // apply — dispatch a bubbling click instead.
        await submitButton.evaluate((el) =>
          el.dispatchEvent(
            new MouseEvent("click", { bubbles: true, cancelable: true }),
          ),
        );
        await otpBox.waitFor({ state: "visible", timeout: 30000 });
      }

      console.log("[Khalti] OTP screen reached.");

      const otp = this.TEST_OTP;
      const otpInputs = otpBox.locator('input[autocomplete="one-time-code"]');
      const otpCount = await otpInputs.count();
      console.log(
        `[Khalti] Found ${otpCount} OTP input cells, entering ${otp.length}-digit code...`,
      );

      for (let i = 0; i < otp.length && i < otpCount; i++) {
        const cell = otpInputs.nth(i);
        await cell.waitFor({ state: "visible", timeout: 15000 });
        await cell.click();
        console.log(`[Khalti] Entering OTP digit ${i + 1}/${otp.length}...`);
        await cell.pressSequentially(otp[i], { delay: 50 });
      }

      // MuiOtpInput auto-advances focus on keypress, which can swallow digits when
      // each cell is clicked individually. Validate, then fall back to a single
      // continuous type-through if any cell came out empty.
      const readOtp = async () => {
        let v = "";
        for (let i = 0; i < otpCount; i++) {
          v += await otpInputs.nth(i).inputValue();
        }
        return v;
      };

      let entered = await readOtp();
      console.log(
        `[Khalti] OTP cells currently hold ${entered.length}/${otp.length} digits.`,
      );

      if (entered.length !== otp.length) {
        console.log(
          "[Khalti] Incomplete OTP — clearing and retyping via continuous keyboard input...",
        );
        for (let i = 0; i < otpCount; i++) {
          await otpInputs.nth(i).fill("");
        }
        await otpInputs.first().click();
        await page.keyboard.type(otp, { delay: 60 });

        entered = await readOtp();
        console.log(
          `[Khalti] After fallback, OTP cells hold ${entered.length}/${otp.length} digits.`,
        );
        if (entered.length !== otp.length) {
          throw new Error(
            `[Khalti] OTP entry failed. Expected ${otp.length} digits, got ${entered.length}`,
          );
        }
      }

      // ---- Step 6: final "Pay Rs. <amount>" confirmation ----
      // The label carries the live booking total (e.g. "Pay Rs. 800.00"), so match
      // on the prefix only — an exact-text or anchored locator will never hit it.
      const payButton = page
        .getByRole("button", { name: /^Pay\s+Rs\.?\s*[\d,]+(\.\d{2})?$/i })
        .first();

      console.log("[Khalti] Waiting for final Pay button...");
      await payButton.waitFor({ state: "visible", timeout: 60000 });
      await payButton.scrollIntoViewIfNeeded();

      const payLabel = (await payButton.textContent())?.trim();
      console.log(`[Khalti] Pay button label reads: "${payLabel}"`);

      console.log("[Khalti] Clicking Pay (attempt 1: real mouse)...");
      const payBox = await payButton.boundingBox();
      if (payBox) {
        await page.mouse.move(
          payBox.x + payBox.width / 2,
          payBox.y + payBox.height / 2,
        );
        await page.mouse.down();
        await page.mouse.up();
      } else {
        await payButton.click();
      }

      // ---- Step 7: leave the Khalti domain ----
      let redirected = await page
        .waitForURL((url) => !url.hostname.includes("khalti.com"), {
          timeout: 60000,
        })
        .then(() => true)
        .catch(() => false);

      if (!redirected) {
        console.log(
          `[Khalti] Still on Khalti after Pay click (${page.url()}) — retrying (attempt 2: native JS click)...`,
        );
        const stillThere = await payButton.isVisible().catch(() => false);
        if (stillThere) {
          await payButton.evaluate((el) => el.click());
          redirected = await page
            .waitForURL((url) => !url.hostname.includes("khalti.com"), {
              timeout: 60000,
            })
            .then(() => true)
            .catch(() => false);
        }
      }

      if (!redirected) {
        console.log(
          `[Khalti] Still on Khalti after retry (${page.url()}) — retrying (attempt 3: dispatched event)...`,
        );
        const stillThere = await payButton.isVisible().catch(() => false);
        if (stillThere) {
          await payButton.evaluate((el) =>
            el.dispatchEvent(
              new MouseEvent("click", { bubbles: true, cancelable: true }),
            ),
          );
          redirected = await page
            .waitForURL((url) => !url.hostname.includes("khalti.com"), {
              timeout: 90000,
            })
            .then(() => true)
            .catch(() => false);
        }
      }

      if (!redirected) {
        console.log(
          `[Khalti] WARNING: never left the Khalti domain. Final URL: ${page.url()}`,
        );
      }

      console.log(`[Khalti] Post-payment URL: ${page.url()}`);
    },
  },

  Getnet: {
    // Getnet Brazil sandbox test values (public, from Getnet's developer docs).
    TEST_CARD_NUMBER: "5155901222280001",
    TEST_EXPIRY_MONTH: "12",
    TEST_EXPIRY_YEAR: "2029",
    TEST_CVV: "123",
    TEST_DOCUMENT_TYPE: "CPF",
    TEST_DOCUMENT_NUMBER: "12345678909",

    async fillCardDetails(page, card = {}) {
      const cardholderName = card.name || "Token Tutorial";

      // ---- Resolve the Getnet popup iframe ----
      // Same chrome pattern as Westpac and Adyen: the card form lives in a
      // cross-origin popup iframe, so every interaction below goes through the
      // frame handle, never through `page`.
      //
      // Polled by form presence rather than URL substring — the exact Getnet
      // iframe host is unconfirmed, and matching on the form id is stable
      // regardless of which sandbox domain it is served from.
      console.log("[Getnet] Polling for the Getnet payment iframe...");

      let getnetFrame = null;
      const frameDeadline = Date.now() + 90000;

      while (Date.now() < frameDeadline) {
        for (const frame of page.frames()) {
          if (frame === page.mainFrame()) continue;
          const hasForm = await frame
            .locator("#getnet-payment-form")
            .count()
            .then((c) => c > 0)
            .catch(() => false);
          if (hasForm) {
            getnetFrame = frame;
            break;
          }
        }
        if (getnetFrame) break;
        await page.waitForTimeout(500);
      }

      if (!getnetFrame) {
        const urls = page.frames().map((f) => f.url());
        throw new Error(
          `[Getnet] Payment iframe never appeared. Frames present: ${JSON.stringify(urls)}`,
        );
      }

      console.log(`[Getnet] Payment iframe resolved: ${getnetFrame.url()}`);

      const form = getnetFrame.locator("#getnet-payment-form");
      await form.waitFor({ state: "visible", timeout: 30000 });
      console.log("[Getnet] Payment form is visible.");

      // ---- Cardholder name ----
      const nameInput = getnetFrame.locator("#cardholder-name");
      console.log("[Getnet] Waiting for cardholder name field...");
      await nameInput.waitFor({ state: "visible", timeout: 30000 });
      await nameInput.click();
      console.log(`[Getnet] Typing cardholder name: ${cardholderName}`);
      await nameInput.pressSequentially(cardholderName, { delay: 50 });

      const nameValue = await nameInput.inputValue();
      console.log(`[Getnet] Cardholder name field now reads: "${nameValue}"`);
      if (nameValue.trim() !== cardholderName) {
        throw new Error(
          `[Getnet] Cardholder name failed to register. Expected "${cardholderName}", got "${nameValue}"`,
        );
      }

      // ---- Card number ----
      // maxlength="19" allows space-formatted input, so the field may auto-format
      // as digits arrive — compare on digits only.
      const cardInput = getnetFrame.locator("#card-number");
      console.log("[Getnet] Waiting for card number field...");
      await cardInput.waitFor({ state: "visible", timeout: 30000 });
      await cardInput.click();
      console.log(`[Getnet] Typing card number: ${this.TEST_CARD_NUMBER}`);
      await cardInput.pressSequentially(this.TEST_CARD_NUMBER, { delay: 50 });

      const cardValue = await cardInput.inputValue();
      console.log(`[Getnet] Card number field now reads: "${cardValue}"`);
      if (cardValue.replace(/\D/g, "") !== this.TEST_CARD_NUMBER) {
        throw new Error(
          `[Getnet] Card number failed to register. Expected ${this.TEST_CARD_NUMBER}, got "${cardValue}"`,
        );
      }

      // ---- Expiry month ----
      const monthInput = getnetFrame.locator("#expiry-month");
      console.log("[Getnet] Waiting for expiry month field...");
      await monthInput.waitFor({ state: "visible", timeout: 30000 });
      await monthInput.click();
      console.log(`[Getnet] Typing expiry month: ${this.TEST_EXPIRY_MONTH}`);
      await monthInput.pressSequentially(this.TEST_EXPIRY_MONTH, { delay: 50 });

      const monthValue = await monthInput.inputValue();
      console.log(`[Getnet] Expiry month field now reads: "${monthValue}"`);
      if (monthValue !== this.TEST_EXPIRY_MONTH) {
        throw new Error(
          `[Getnet] Expiry month failed to register. Expected ${this.TEST_EXPIRY_MONTH}, got "${monthValue}"`,
        );
      }

      // ---- Expiry year ----
      // Four-digit year (maxlength="4"), not the two-digit form used by eWAY.
      const yearInput = getnetFrame.locator("#expiry-year");
      console.log("[Getnet] Waiting for expiry year field...");
      await yearInput.waitFor({ state: "visible", timeout: 30000 });
      await yearInput.click();
      console.log(`[Getnet] Typing expiry year: ${this.TEST_EXPIRY_YEAR}`);
      await yearInput.pressSequentially(this.TEST_EXPIRY_YEAR, { delay: 50 });

      const yearValue = await yearInput.inputValue();
      console.log(`[Getnet] Expiry year field now reads: "${yearValue}"`);
      if (yearValue !== this.TEST_EXPIRY_YEAR) {
        throw new Error(
          `[Getnet] Expiry year failed to register. Expected ${this.TEST_EXPIRY_YEAR}, got "${yearValue}"`,
        );
      }

      // Guard against a stale hardcoded expiry silently becoming a declined card.
      const currentYear = new Date().getFullYear();
      if (Number(this.TEST_EXPIRY_YEAR) <= currentYear) {
        throw new Error(
          `[Getnet] TEST_EXPIRY_YEAR (${this.TEST_EXPIRY_YEAR}) is not in the future — update the constant.`,
        );
      }

      // ---- CVV ----
      // type="password" but readable via inputValue() (same as the eWAY CVV).
      const cvvInput = getnetFrame.locator("#cvv");
      console.log("[Getnet] Waiting for CVV field...");
      await cvvInput.waitFor({ state: "visible", timeout: 30000 });
      await cvvInput.click();
      console.log("[Getnet] Typing CVV (masked)...");
      await cvvInput.pressSequentially(this.TEST_CVV, { delay: 50 });

      const cvvValue = await cvvInput.inputValue();
      console.log(`[Getnet] CVV field length: ${cvvValue.length}`);
      if (cvvValue !== this.TEST_CVV) {
        throw new Error(
          `[Getnet] CVV failed to register. Expected ${this.TEST_CVV.length} chars, got ${cvvValue.length}`,
        );
      }

      // ---- Document type (Brazilian tax ID) ----
      // CPF is the default selected option, but select it explicitly so the run is
      // deterministic if Getnet ever reorders the list. The #document-number
      // placeholder is driven by this select, so set it before typing the number.
      const documentSection = getnetFrame.locator("#document-section");
      const hasDocumentSection = await documentSection
        .isVisible()
        .catch(() => false);

      if (hasDocumentSection) {
        const documentTypeSelect = getnetFrame.locator("#document-type");
        const hasDocumentType = await documentTypeSelect
          .isVisible()
          .catch(() => false);

        if (hasDocumentType) {
          console.log(
            `[Getnet] Selecting document type: ${this.TEST_DOCUMENT_TYPE}`,
          );
          await documentTypeSelect.waitFor({
            state: "visible",
            timeout: 15000,
          });
          await documentTypeSelect.selectOption(this.TEST_DOCUMENT_TYPE);

          const documentTypeValue = await documentTypeSelect.inputValue();
          console.log(
            `[Getnet] Document type now set to: "${documentTypeValue}"`,
          );
          if (documentTypeValue !== this.TEST_DOCUMENT_TYPE) {
            throw new Error(
              `[Getnet] Document type failed to set. Expected ${this.TEST_DOCUMENT_TYPE}, got "${documentTypeValue}"`,
            );
          }
        } else {
          console.log("[Getnet] Document type select not visible — skipping.");
        }

        // ---- Document number (CPF) ----
        const documentInput = getnetFrame.locator("#document-number");
        console.log("[Getnet] Waiting for document number field...");
        await documentInput.waitFor({ state: "visible", timeout: 30000 });
        await documentInput.click();
        console.log(
          `[Getnet] Typing document number: ${this.TEST_DOCUMENT_NUMBER}`,
        );
        await documentInput.pressSequentially(this.TEST_DOCUMENT_NUMBER, {
          delay: 50,
        });

        const documentValue = await documentInput.inputValue();
        console.log(
          `[Getnet] Document number field now reads: "${documentValue}"`,
        );
        if (documentValue.replace(/\D/g, "") !== this.TEST_DOCUMENT_NUMBER) {
          throw new Error(
            `[Getnet] Document number failed to register. Expected ${this.TEST_DOCUMENT_NUMBER}, got "${documentValue}"`,
          );
        }
      } else {
        console.log(
          "[Getnet] Document section hidden — skipping ID type and number.",
        );
      }

      console.log(
        "[Getnet] All card details filled and validated. Ready to submit.",
      );
    },

    async submitCardPayment(page) {
      // Re-resolve the frame — fillCardDetails and submitCardPayment are separate
      // calls and the handle does not carry across.
      console.log(
        "[Getnet] Re-resolving the Getnet payment iframe for submit...",
      );

      let getnetFrame = null;
      const frameDeadline = Date.now() + 30000;

      while (Date.now() < frameDeadline) {
        for (const frame of page.frames()) {
          if (frame === page.mainFrame()) continue;
          const hasForm = await frame
            .locator("#getnet-payment-form")
            .count()
            .then((c) => c > 0)
            .catch(() => false);
          if (hasForm) {
            getnetFrame = frame;
            break;
          }
        }
        if (getnetFrame) break;
        await page.waitForTimeout(500);
      }

      if (!getnetFrame) {
        throw new Error(
          "[Getnet] Payment iframe not found when attempting to submit.",
        );
      }

      console.log(`[Getnet] Frame resolved for submit: ${getnetFrame.url()}`);

      // The :not([disabled]) guard mirrors the Westpac PayWay handling — cheap
      // insurance against a duplicate or pre-enabled submit button.
      const payButton = getnetFrame
        .locator("#getnet-submit-button:not([disabled])")
        .first();

      console.log("[Getnet] Waiting for Pay button to be enabled...");
      await payButton.waitFor({ state: "visible", timeout: 30000 });
      await payButton.scrollIntoViewIfNeeded();

      const startUrl = page.url();
      console.log(`[Getnet] URL before submit: ${startUrl}`);

      console.log("[Getnet] Clicking Pay (attempt 1: real mouse)...");
      const box = await payButton.boundingBox();
      if (box) {
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.down();
        await page.mouse.up();
      } else {
        await payButton.click();
      }

      const submissionTook = async (ms) => {
        // The iframe detaching is the clearest signal the payment went through.
        const detached = await page
          .waitForFunction(
            () => !document.querySelector("#getnet-payment-form"),
            null,
            { timeout: ms },
          )
          .then(() => true)
          .catch(() => false);
        if (detached) return true;
        return page.url() !== startUrl;
      };

      let submitted = await submissionTook(30000);

      if (!submitted) {
        console.log(
          "[Getnet] No effect yet — retrying (attempt 2: native JS click)...",
        );
        await payButton.evaluate((el) => el.click()).catch(() => {});
        submitted = await submissionTook(30000);
      }

      if (!submitted) {
        console.log(
          "[Getnet] Still no effect — retrying (attempt 3: requestSubmit())...",
        );
        // The form carries novalidate, so requestSubmit() will not be blocked by
        // constraint validation here.
        await getnetFrame
          .locator("#getnet-payment-form")
          .evaluate((el) => el.requestSubmit())
          .catch(() => {});
        submitted = await submissionTook(60000);
      }

      if (!submitted) {
        console.log(
          `[Getnet] WARNING: submission had no observable effect. URL still ${page.url()}`,
        );
      }

      console.log("[Getnet] Waiting for the post-payment page to settle...");
      await page.waitForLoadState("domcontentloaded").catch(() => {});
      console.log(`[Getnet] Post-payment URL: ${page.url()}`);
    },
  },

  PinPayments: {
    // Pin Payments sandbox test values.
    // NOTE: card number is Pin's documented Visa success card — confirm against
    // your test account before trusting a decline as a real failure.
    TEST_CARD_NUMBER: "4200000000000000",
    TEST_CVC: "123",
    TEST_ADDRESS_LINE1: "42 Sevenoaks St",
    TEST_ADDRESS_LINE2: "",
    TEST_CITY: "Lathlain",
    TEST_POSTCODE: "6454",
    TEST_STATE: "WA",
    TEST_COUNTRY: "Australia",

    async fillCardDetails(page, card = {}) {
      const cardholderName = card.name || "Token Tutorial";

      // House convention: month 02, year = current year + 3.
      const expiryMonth = "02";
      const expiryYearFull = String(new Date().getFullYear() + 3);
      const expiryYearShort = expiryYearFull.slice(-2);
      const expiryCombined = `${expiryMonth}${expiryYearShort}`;

      // ---- Resolve the context holding the outer Pin form ----
      // The outer #pin-payment-form may sit on the main page or inside a gateway
      // iframe, so search the main frame and all children rather than assuming.
      console.log("[PinPayments] Locating the Pin payment form...");

      let formContext = null;
      const formDeadline = Date.now() + 90000;

      while (Date.now() < formDeadline) {
        for (const frame of page.frames()) {
          const hasForm = await frame
            .locator("#pin-payment-form")
            .count()
            .then((c) => c > 0)
            .catch(() => false);
          if (hasForm) {
            formContext = frame;
            break;
          }
        }
        if (formContext) break;
        await page.waitForTimeout(500);
      }

      if (!formContext) {
        const urls = page.frames().map((f) => f.url());
        throw new Error(
          `[PinPayments] #pin-payment-form never appeared. Frames present: ${JSON.stringify(urls)}`,
        );
      }

      console.log(
        `[PinPayments] Form found in context: ${
          formContext === page.mainFrame() ? "main frame" : formContext.url()
        }`,
      );

      await formContext
        .locator("#pin-payment-form")
        .waitFor({ state: "visible", timeout: 30000 });

      // ---- Resolve the four hosted-field iframes ----
      // Each card field is its own cross-origin iframe on cdn.pinpayments.com.
      // Matched on the field_name query param rather than the frame id: the ids
      // (pin.number, pin.cvc ...) contain a dot, which CSS parses as a class
      // separator, and the instance_identifier in the URL is regenerated on every
      // page load so it can never be hardcoded.
      const resolveHostedField = async (fieldName, timeout = 60000) => {
        const deadline = Date.now() + timeout;
        while (Date.now() < deadline) {
          const match = page
            .frames()
            .find(
              (f) =>
                f.url().includes("cdn.pinpayments.com/hosted_fields_assets") &&
                f.url().includes(`field_name=${fieldName}`),
            );
          if (match) {
            console.log(
              `[PinPayments] Hosted field "${fieldName}" iframe resolved.`,
            );
            return match;
          }
          await page.waitForTimeout(500);
        }
        const urls = page
          .frames()
          .map((f) => f.url())
          .filter((u) => u.includes("pinpayments"));
        throw new Error(
          `[PinPayments] Hosted field iframe "${fieldName}" not found. Pin frames: ${JSON.stringify(urls)}`,
        );
      };

      // Hosted-field iframes render exactly one input each, with no stable id of
      // their own — .first() on the frame's input is the intended handle.
      const fillHostedField = async (
        frame,
        label,
        value,
        expectDigits = false,
      ) => {
        const input = frame.locator("input").first();
        console.log(`[PinPayments] Waiting for "${label}" hosted input...`);
        await input.waitFor({ state: "visible", timeout: 30000 });
        await input.click();
        console.log(`[PinPayments] Typing ${label}: ${value}`);
        await input.pressSequentially(value, { delay: 50 });

        const actual = await input.inputValue();
        console.log(`[PinPayments] "${label}" field now reads: "${actual}"`);

        const normalise = (s) =>
          expectDigits ? s.replace(/\D/g, "") : s.trim();
        if (normalise(actual) !== normalise(value)) {
          throw new Error(
            `[PinPayments] ${label} failed to register. Expected "${value}", got "${actual}"`,
          );
        }
      };

      const nameFrame = await resolveHostedField("name");
      const numberFrame = await resolveHostedField("number");
      const expiryFrame = await resolveHostedField("expiry");
      const cvcFrame = await resolveHostedField("cvc");

      // ---- Cardholder name ----
      await fillHostedField(nameFrame, "Cardholder Name", cardholderName);

      // ---- Card number ----
      // Pin auto-formats into 4-digit groups as digits arrive, so compare on
      // digits only.
      await fillHostedField(
        numberFrame,
        "Card Number",
        this.TEST_CARD_NUMBER,
        true,
      );

      // ---- Expiry (single combined MM/YY field) ----
      // Not separate month/year inputs like Getnet. Pin inserts the slash itself,
      // so type the four digits bare and validate on digits.
      await fillHostedField(expiryFrame, "Expiry", expiryCombined, true);
      console.log(
        `[PinPayments] Expiry resolved to ${expiryMonth}/${expiryYearShort} (${expiryYearFull}).`,
      );

      // ---- CVC ----
      await fillHostedField(cvcFrame, "CVC", this.TEST_CVC, true);

      // ---- Billing address (plain inputs on the outer form) ----
      const fillPlainField = async (
        selector,
        label,
        value,
        required = true,
      ) => {
        if (!value) {
          console.log(
            `[PinPayments] Skipping optional "${label}" (no value set).`,
          );
          return;
        }
        const input = formContext.locator(selector);
        const present = await input.isVisible().catch(() => false);
        if (!present) {
          if (required) {
            throw new Error(
              `[PinPayments] Required field "${label}" (${selector}) not visible.`,
            );
          }
          console.log(`[PinPayments] "${label}" not present — skipping.`);
          return;
        }
        await input.click();
        console.log(`[PinPayments] Typing ${label}: ${value}`);
        await input.pressSequentially(value, { delay: 50 });

        const actual = await input.inputValue();
        console.log(`[PinPayments] "${label}" field now reads: "${actual}"`);
        if (actual.trim() !== value.trim()) {
          throw new Error(
            `[PinPayments] ${label} failed to register. Expected "${value}", got "${actual}"`,
          );
        }
      };

      await fillPlainField(
        "#pin-address-line1",
        "Address line 1",
        this.TEST_ADDRESS_LINE1,
      );
      await fillPlainField(
        "#pin-address-line2",
        "Address line 2",
        this.TEST_ADDRESS_LINE2,
        false,
      );
      await fillPlainField("#pin-address-city", "City", this.TEST_CITY);
      await fillPlainField(
        "#pin-address-postcode",
        "Postcode",
        this.TEST_POSTCODE,
      );
      await fillPlainField("#pin-address-state", "State", this.TEST_STATE);
      await fillPlainField(
        "#pin-address-country",
        "Country",
        this.TEST_COUNTRY,
      );

      // ---- Check the per-field error slots before handing off to submit ----
      // Pin writes tokenisation/validation errors into these divs rather than into
      // the iframes, so they are the only readable signal that a field was rejected.
      const errorSlots = ["name", "number", "expiry", "cvc"];
      const errors = [];
      for (const slot of errorSlots) {
        const text = await formContext
          .locator(`#errors_for_${slot}`)
          .textContent()
          .catch(() => "");
        const trimmed = (text || "").trim();
        if (trimmed) {
          errors.push(`${slot}: ${trimmed}`);
        }
      }

      if (errors.length) {
        throw new Error(
          `[PinPayments] Field validation errors present: ${errors.join(" | ")}`,
        );
      }

      console.log(
        "[PinPayments] All fields filled and validated. Ready to submit.",
      );
    },

    async submitCardPayment(page) {
      // Re-resolve the form context — the handle does not carry across calls.
      console.log(
        "[PinPayments] Re-resolving the Pin payment form for submit...",
      );

      let formContext = null;
      const deadline = Date.now() + 30000;

      while (Date.now() < deadline) {
        for (const frame of page.frames()) {
          const hasForm = await frame
            .locator("#pin-payment-form")
            .count()
            .then((c) => c > 0)
            .catch(() => false);
          if (hasForm) {
            formContext = frame;
            break;
          }
        }
        if (formContext) break;
        await page.waitForTimeout(500);
      }

      if (!formContext) {
        throw new Error(
          "[PinPayments] #pin-payment-form not found when attempting to submit.",
        );
      }

      const payButton = formContext
        .locator("#pin-submit-button:not([disabled])")
        .first();

      console.log("[PinPayments] Waiting for Pay Now button to be enabled...");
      await payButton.waitFor({ state: "visible", timeout: 30000 });
      await payButton.scrollIntoViewIfNeeded();

      const startUrl = page.url();
      console.log(`[PinPayments] URL before submit: ${startUrl}`);

      console.log("[PinPayments] Clicking Pay Now (attempt 1: real mouse)...");
      const box = await payButton.boundingBox();
      if (box) {
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.down();
        await page.mouse.up();
      } else {
        await payButton.click();
      }

      const readFieldErrors = async () => {
        const found = [];
        for (const slot of ["name", "number", "expiry", "cvc"]) {
          const text = await formContext
            .locator(`#errors_for_${slot}`)
            .textContent()
            .catch(() => "");
          const trimmed = (text || "").trim();
          if (trimmed) found.push(`${slot}: ${trimmed}`);
        }
        return found;
      };

      const submissionTook = async (ms) => {
        // The form detaching is the clearest signal the charge went through.
        const detached = await page
          .waitForFunction(
            () => !document.querySelector("#pin-payment-form"),
            null,
            {
              timeout: ms,
            },
          )
          .then(() => true)
          .catch(() => false);
        if (detached) return true;
        return page.url() !== startUrl;
      };

      let submitted = await submissionTook(30000);

      if (!submitted) {
        const errs = await readFieldErrors();
        if (errs.length) {
          throw new Error(
            `[PinPayments] Submission rejected: ${errs.join(" | ")}`,
          );
        }
        console.log(
          "[PinPayments] No effect yet — retrying (attempt 2: native JS click)...",
        );
        await payButton.evaluate((el) => el.click()).catch(() => {});
        submitted = await submissionTook(30000);
      }

      if (!submitted) {
        console.log(
          "[PinPayments] Still no effect — retrying (attempt 3: requestSubmit())...",
        );
        // The form carries novalidate, so requestSubmit() will not be blocked by
        // constraint validation.
        await formContext
          .locator("#pin-payment-form")
          .evaluate((el) => el.requestSubmit())
          .catch(() => {});
        submitted = await submissionTook(60000);
      }

      if (!submitted) {
        const errs = await readFieldErrors();
        if (errs.length) {
          throw new Error(
            `[PinPayments] Submission rejected: ${errs.join(" | ")}`,
          );
        }
        console.log(
          `[PinPayments] WARNING: submission had no observable effect. URL still ${page.url()}`,
        );
      }

      console.log(
        "[PinPayments] Waiting for the post-payment page to settle...",
      );
      await page.waitForLoadState("domcontentloaded").catch(() => {});
      console.log(`[PinPayments] Post-payment URL: ${page.url()}`);
    },
  },
  //9th
  MPesa: {
    fillCardDetails: async (page) => {
      console.log("Filling M-PESA phone number (STK Push flow)...");

      // Safaricom sandbox test MSISDN, in the 07XXXXXXXX format the field's
      // placeholder and format hint both specify. The plugin normalises this to
      // 2547XXXXXXXX before calling the Daraja API.
      const PHONE_NUMBER = "0708374149";

      // The form is IFRAMED in — the failure artifact puts #phone-form under an
      // <iframe>, not in the top-level document — so page.locator() can never
      // see it however the selector is written. Resolved by CONTENT, not URL:
      // the src is per-session with no stable substring to match.
      //
      // waitForFrameWithSelector() polls on the form being VISIBLE, not merely
      // attached, which is what matters here: #phone-form is shown and hidden
      // by an inline display style, so it is in the DOM before it is usable.
      const frame = await waitForFrameWithSelector(page, "#phone-form", 45000);
      console.log("✓ M-PESA phone form is open");

      // Targeted by placeholder rather than #phone-input — the placeholder is
      // the field's visible, stable handle on this form. Scoped to the frame:
      // page.getByPlaceholder() would look in the top-level document only.
      const phoneInput = frame.getByPlaceholder("07XXXXXXXX");
      await phoneInput.waitFor({ state: "visible", timeout: 30000 });
      await phoneInput.click();
      await phoneInput.pressSequentially(PHONE_NUMBER, { delay: 50 });
      const phoneValue = await phoneInput.inputValue();
      console.log(`✓ Phone number field now contains: "${phoneValue}"`);

      if (phoneValue !== PHONE_NUMBER) {
        throw new Error(
          `M-PESA phone field reads "${phoneValue}" but "${PHONE_NUMBER}" was typed — the field ` +
            `is reformatting or truncating the input. The format hint on this form specifies ` +
            `07XXXXXXXX (10 digits).`,
        );
      }

      // #close-button is deliberately left alone — it cancels the payment.

      console.log("✓ Phone number filled — ready to trigger the STK Push");

      // No click here on purpose: submitCardPayment() runs immediately after
      // this and owns the click.
    },

    submitCardPayment: async (page) => {
      console.log("Triggering M-PESA STK Push...");

      // Re-resolved rather than carried over from fillCardDetails(): the two
      // hooks are called separately by CheckoutPage and share no state. The
      // button lives in the same iframe as the phone field, so this is not
      // optional — page.locator("#submit-button") cannot reach it.
      const frame = await waitForFrameWithSelector(
        page,
        "#submit-button",
        30000,
      );

      const submitButton = frame.locator("#submit-button");
      await submitButton.scrollIntoViewIfNeeded();
      const urlBeforeClick = page.url();
      await submitButton.click();
      console.log("✓ 'Pay with M-PESA' clicked");

      // The plugin writes STK failures into #error-message rather than
      // navigating, so a rejected push leaves the page unchanged and would
      // otherwise surface only as a downstream thank-you-page timeout.
      //
      // Polled rather than read once after a fixed settle: #error-message
      // starts empty and is filled in whenever the Daraja round-trip returns,
      // so a single read at 5s is a race the slow path loses — the error lands
      // after the read and the run reports a Thank You timeout instead of the
      // real reason. This exits the moment EITHER outcome is decided.
      const deadline = Date.now() + 90000;

      while (Date.now() < deadline) {
        const errorText = await frame
          .locator("#error-message")
          .textContent()
          .catch(() => null);

        if (errorText && errorText.trim()) {
          throw new Error(
            `M-PESA STK Push failed: "${errorText.trim()}". Common causes are a phone number ` +
              `outside the sandbox's registered test MSISDNs, or expired Daraja credentials.`,
          );
        }

        // Push accepted and the plugin has moved the booking on — hand over to
        // waitForThankYouPage(), which owns the end-of-flow assertion.
        if (paymentAlreadyCompleted(page) || page.url() !== urlBeforeClick) {
          console.log("✓ STK Push accepted — page has left the phone form");
          return;
        }

        await page.waitForTimeout(1000);
      }

      // Neither outcome inside 90s. The STK Push needs the PIN confirmed on the
      // handset, and the sandbox only auto-confirms for registered test
      // MSISDNs, so a silent stall here usually means the number isn't one.
      throw new Error(
        `M-PESA STK Push neither completed nor reported an error within 90000ms — still on ` +
          `"${page.url()}" with #error-message empty. The push was likely sent but never ` +
          `confirmed: in the sandbox only registered test MSISDNs auto-confirm the PIN prompt.`,
      );
    },
  },

  ProtectedPaymentService: {
    fillCardDetails: async (page) => {
      console.log("Waiting for the Protected Payment Service hosted form...");

      // The session id lives in a hidden input, not the URL — the path itself
      // is constant, so the whole URL is the prefix to wait on.
      await waitForUrlPrefix(
        page,
        "https://sales.protectedpaymentservices.com/paymentform/",
        45000,
      );
      console.log(`✓ PPS payment form found: ${page.url()}`);

      const CARDHOLDER_NAME = "Token Tutorial";
      const CARD_NUMBER = "4929421234600821";
      const CARD_CVV = "356";
      const CARD_EXPIRY_MONTH = "12";
      // Computed, not hard-coded, so the expiry never drifts into the past.
      // The year <select> lists two-digit values ("26".."46").
      const CARD_EXPIRY_YEAR = String((new Date().getFullYear() + 3) % 100);
      const BILLING_ADDRESS =
        "Flat 6 Primrose Rise\n347 Lavender Road\nNorthampton";
      const BILLING_POSTCODE = "NN17 8YG";

      console.log(`Using fixed test card ending in ${CARD_NUMBER.slice(-4)}`);
      console.log(
        `Expiry set to ${CARD_EXPIRY_MONTH}/${CARD_EXPIRY_YEAR} (always current year + 3)`,
      );

      // Every field is clicked before anything is typed into it: this form
      // hangs its inline validation off focus/blur, and a field that was never
      // focused is not marked as visited — leaving .form-error unset and the
      // submit rejected with no visible reason.
      const fillField = async (selector, value, label) => {
        const field = page.locator(selector);
        await field.waitFor({ state: "visible", timeout: 30000 });
        await field.click();
        await field.fill(value);
        console.log(`✓ ${label} now contains: "${await field.inputValue()}"`);
      };

      await fillField("#customerName", CARDHOLDER_NAME, "Cardholder's Name");

      // pressSequentially rather than fill(): #cardNumber is maxlength="23" and
      // groups the digits as they arrive, which is keystroke-driven.
      const cardNumberInput = page.locator("#cardNumber");
      await cardNumberInput.waitFor({ state: "visible", timeout: 30000 });
      await cardNumberInput.click();
      await cardNumberInput.pressSequentially(CARD_NUMBER, { delay: 50 });
      const cardNumberValue = await cardNumberInput.inputValue();
      console.log(`✓ Card number now contains: "${cardNumberValue}"`);

      if (cardNumberValue.replace(/\D/g, "") !== CARD_NUMBER) {
        throw new Error(
          `PPS card number field reads "${cardNumberValue}" — its digits do not match the ` +
            `${CARD_NUMBER.length} typed. The field is truncating or rejecting input.`,
        );
      }

      // Expiry is two <select>s, not a masked text input, so selectOption is
      // the only thing that fires their change handlers.
      const monthSelect = page.locator("#cardExpiryMonth");
      await monthSelect.waitFor({ state: "visible", timeout: 30000 });
      await monthSelect.click();
      await monthSelect.selectOption(CARD_EXPIRY_MONTH);

      const yearSelect = page.locator("#cardExpiryYear");
      await yearSelect.click();
      await yearSelect.selectOption(CARD_EXPIRY_YEAR);

      console.log(
        `✓ Expiry now reads: ${await monthSelect.inputValue()}/${await yearSelect.inputValue()}`,
      );

      await fillField("#cardCVV", CARD_CVV, "CVV");

      // Billing address is a <textarea>; fill() handles the newlines.
      await fillField("#customerAddress", BILLING_ADDRESS, "Billing address");
      await fillField("#customerPostcode", BILLING_POSTCODE, "Post / Zip Code");

      // Contact details are deliberately left alone: #customerEmail arrives
      // pre-filled from the booking, and the form needs only ONE of email or
      // phone. Typing into the intl-tel-input phone field would also mean
      // picking a dial code from its dropdown to satisfy its own validation.
      const emailValue = await page
        .locator("#customerEmail")
        .inputValue()
        .catch(() => "");
      console.log(`[state] Contact email on the form: "${emailValue}"`);

      if (!emailValue.trim()) {
        throw new Error(
          `PPS form has no contact email pre-filled and no phone number is supplied — the form ` +
            `requires one of the two and will reject the submit.`,
        );
      }

      // No click here on purpose: submitCardPayment() runs next and owns it.
    },

    submitCardPayment: async (page) => {
      console.log("Submitting Protected Payment Service payment...");

      // #paybttn specifically — the form carries a second submit input
      // ("Cancel Payment") in the same .form-submit block, and a text- or
      // role-based lookup can land on it.
      const payButton = page.locator("#paybttn");
      await payButton.waitFor({ state: "visible", timeout: 30000 });
      await payButton.scrollIntoViewIfNeeded();

      const urlBeforeClick = page.url();
      await payButton.click();
      console.log("✓ 'Pay Now' clicked");

      // #form-messages is the form's own error channel: it starts hidden and
      // is revealed in place on a validation or gateway rejection, WITHOUT a
      // navigation. Polled against the navigation so whichever outcome lands
      // first ends the wait — a single post-click read would race it.
      const deadline = Date.now() + 60000;

      while (Date.now() < deadline) {
        if (await waitForSubmissionToTakeEffect(page, urlBeforeClick, 1000)) {
          console.log(`✓ PPS submission took effect — now on: ${page.url()}`);
          return;
        }

        const message = page.locator("#form-messages");
        const isShowing = await message.isVisible().catch(() => false);

        if (isShowing) {
          const text = (await message.textContent().catch(() => "")) || "";

          if (text.trim()) {
            throw new Error(
              `Protected Payment Service rejected the payment: "${text.trim()}"`,
            );
          }
        }

        // Inline field errors — the form writes these into .form-error spans
        // and blocks the post entirely, so nothing navigates and #form-messages
        // can stay empty.
        const fieldErrors = await page
          .locator(".form-error")
          .allTextContents()
          .catch(() => []);
        const firstError = fieldErrors.map((t) => t.trim()).find(Boolean);

        if (firstError) {
          throw new Error(
            `Protected Payment Service form validation failed: "${firstError}". The submit was ` +
              `blocked client-side, so the card was never sent.`,
          );
        }
      }

      throw new Error(
        `Protected Payment Service form neither navigated nor reported an error within 60000ms ` +
          `of clicking #paybttn — still on "${page.url()}".\n` +
          `${await describeSubmitButtons(page)}`,
      );
    },
  },

  PayJP: {
    fillCardDetails: async (page) => {
      console.log("Waiting for the Pay.jp hosted checkout page...");

      // https://c.pay.jp/c/pay/<checkout-session-id> — the cs_test_… id is
      // per-session, so only the fixed path prefix is matched.
      await waitForUrlPrefix(page, "https://c.pay.jp/c/pay/", 45000);
      console.log(`✓ Pay.jp checkout page found: ${page.url()}`);

      // CRITICAL: the card fields are NOT in the checkout page's own DOM.
      // c.pay.jp renders only the (disabled, pre-filled) email box and the
      // 支払う button; everything card-related is iframed in from payjp.js's
      // payments widget. So page.locator("#cardNumber") can never see them,
      // however the selector is written.
      //
      // The widget's filename is per-session (payment-<hash>.html), so its
      // directory is the stable substring to match on.
      const cardFrame = await waitForFrameByUrl(
        page,
        "js.pay.jp/payments/widgets/payment-",
        45000,
      );

      // ---- Step 0: open the カード決済 ("card payment") accordion ----
      // The widget opens on a collapsed list of payment methods, and the card
      // <form> is not in the DOM at all until its row is opened — so waiting
      // for #cardNumber first would just time out.
      //
      // The row's radio is readonly and the click handler sits on the wrapping
      // div, so the whole row is clicked; the radio is only what identifies
      // which row it is. Skipped when the form is already showing, for a
      // session that offers card payment alone and opens it by default.
      const cardNumberInput = cardFrame.locator("#cardNumber");

      if (await cardNumberInput.isVisible().catch(() => false)) {
        console.log("[state] Card form is already open — no row to click");
      } else {
        const cardMethodRow = cardFrame
          .locator(
            'div.cursor-pointer:has(input[name="payment_method"][value="card"])',
          )
          .first();
        await cardMethodRow.waitFor({ state: "visible", timeout: 30000 });
        await cardMethodRow.click();
        console.log("✓ Opened the カード決済 (card payment) section");

        // The section animates open (a 300ms max-height/opacity transition),
        // and the inputs mount with it — so the wait is on the field itself,
        // not on the click returning.
        await cardNumberInput.waitFor({ state: "visible", timeout: 30000 });
      }

      const CARD_NUMBER = "4242424242424242"; // Pay.jp test Visa
      const CARD_CVC = "123";
      const CARDHOLDER_NAME = "TARO YAMADA";
      const EXPIRY_MONTH = "12";
      // Same convention as the other gateways: fixed month, current year + 3,
      // so the expiry never drifts into the past.
      const EXPIRY_YY = String((new Date().getFullYear() + 3) % 100).padStart(
        2,
        "0",
      );

      console.log(`Using Pay.jp test card ending in ${CARD_NUMBER.slice(-4)}`);
      console.log(
        `Expiry set to ${EXPIRY_MONTH}/${EXPIRY_YY} (always current year + 3)`,
      );

      // Every widget input is a controlled React input that reformats on each
      // change — the card number is regrouped into 4-digit blocks, the expiry
      // gains its "/", and both truncate to the brand's digit count — so
      // pressSequentially rather than fill(), same reasoning as Omise/PayU.
      //
      // The click first is what fires the input's onFocus, which is what marks
      // the field visited; an unvisited field keeps its error line hidden, so
      // a rejected value would show nothing at all.
      const fillWidgetField = async (selector, value, label) => {
        const field = cardFrame.locator(selector);
        await field.waitFor({ state: "visible", timeout: 30000 });
        await field.click();
        await field.pressSequentially(value, { delay: 50 });
        console.log(`✓ ${label} now contains: "${await field.inputValue()}"`);
        return field;
      };

      await fillWidgetField(
        "#cardNumber",
        CARD_NUMBER,
        "Card number (カード番号)",
      );
      const cardNumberValue = await cardNumberInput.inputValue();

      if (cardNumberValue.replace(/\D/g, "") !== CARD_NUMBER) {
        throw new Error(
          `Pay.jp card number field reads "${cardNumberValue}" — its digits do not match the ` +
            `${CARD_NUMBER.length} typed. The widget is truncating or rejecting input.`,
        );
      }

      // Digits only: the widget's own formatter inserts the "/" as soon as a
      // third digit arrives, so typing "12/30" would push the year out of the
      // 4-digit slice it keeps.
      const expiryInput = await fillWidgetField(
        "#expiry",
        `${EXPIRY_MONTH}${EXPIRY_YY}`,
        "Expiry (有効期限)",
      );
      const expiryValue = await expiryInput.inputValue();

      // The widget counts the expiry as valid only at MM/YY — 5 characters,
      // two 2-digit halves — so a short read here means keystrokes were
      // dropped and the submit would be blocked client-side.
      if (!/^\d{2}\/\d{2}$/.test(expiryValue)) {
        throw new Error(
          `Pay.jp expiry field reads "${expiryValue}", not MM/YY — the widget's formatter did ` +
            `not accept the ${EXPIRY_MONTH}${EXPIRY_YY} typed into it.`,
        );
      }

      const cvcInput = await fillWidgetField(
        "#cvc",
        CARD_CVC,
        "Security code (セキュリティコード)",
      );
      const cvcValue = await cvcInput.inputValue();

      if (cvcValue !== CARD_CVC) {
        throw new Error(
          `Pay.jp security code field holds "${cvcValue}" after typing ${CARD_CVC} — the ` +
            `field is rejecting or truncating input.`,
        );
      }

      // #name, #email and #phone are rendered only when the checkout session
      // asks for them, so each is filled when present rather than waited for —
      // a waitFor on an absent one would fail a session that never wanted it.
      const nameInput = cardFrame.locator("#name");

      if (await nameInput.isVisible().catch(() => false)) {
        await nameInput.click();
        await nameInput.pressSequentially(CARDHOLDER_NAME, { delay: 50 });
        console.log(
          `✓ Card holder (カード名義) now contains: "${await nameInput.inputValue()}"`,
        );
      } else {
        console.log(
          "[state] Widget is not asking for a card holder name — skipped",
        );
      }

      // The widget's own contact block needs ONE of email or phone. Email is
      // the one to fill: the phone field is an intl-tel-input that also wants
      // a dial code picked out of its dropdown. The value is copied from the
      // checkout page's disabled email box so the charge carries the same
      // address the booking did, rather than an invented one.
      const widgetEmail = cardFrame.locator("#email");

      if (await widgetEmail.isVisible().catch(() => false)) {
        const bookingEmail =
          (await page
            .locator('input[type="email"]')
            .first()
            .inputValue()
            .catch(() => "")) || "";

        if (!bookingEmail.trim()) {
          throw new Error(
            `Pay.jp widget is asking for a contact email but the checkout page has none ` +
              `pre-filled to copy — the widget requires an email or a phone number, and will ` +
              `block the submit without one.`,
          );
        }

        await widgetEmail.click();
        await widgetEmail.fill(bookingEmail);
        console.log(
          `✓ Contact email (メールアドレス) now contains: "${await widgetEmail.inputValue()}"`,
        );
      } else {
        console.log(
          "[state] Widget is not asking for contact details — skipped",
        );
      }

      // Blur the field typed into last so its validation actually runs: the
      // widget validates onBlur, and every earlier field was blurred by the
      // click on the next one — this one has not been left yet.
      await cardFrame
        .locator("#cvc")
        .blur()
        .catch(() => {});

      // .text-alert is the widget's error line: one <div> per rejected field,
      // rendered only once that field has been visited.
      const fieldErrors = await cardFrame
        .locator(".text-alert")
        .allTextContents()
        .catch(() => []);
      const firstError = fieldErrors.map((t) => t.trim()).find(Boolean);

      if (firstError) {
        throw new Error(
          `Pay.jp widget rejected the card details: "${firstError}". The submit is blocked ` +
            `client-side, so the card would never be sent.`,
        );
      }

      // Only waits for the checkout page's own button here — the click belongs
      // to submitCardPayment() (same split as PayWay/PayU).
      const payButton = page.locator('form#payment-form button[type="submit"]');
      await payButton.waitFor({ state: "visible", timeout: 30000 });
      console.log(
        `✓ Pay button ready: "${(await payButton.innerText().catch(() => "")).trim()}"`,
      );

      console.log("✓ All Pay.jp card fields filled");
    },

    submitCardPayment: async (page) => {
      console.log("Submitting Pay.jp payment...");

      if (paymentAlreadyCompleted(page)) {
        console.log(
          `✓ Payment already went through — at "${page.url()}". Nothing to click.`,
        );
        return;
      }

      // ---- Step 1: 支払う on the checkout page ----
      // Scoped to form#payment-form: a text lookup on "支払う" would also match
      // the 支払い方法 ("payment method") heading right above it.
      const payButton = page.locator('form#payment-form button[type="submit"]');
      await payButton.waitFor({ state: "visible", timeout: 30000 });
      await payButton.scrollIntoViewIfNeeded();

      const urlBeforeClick = page.url();
      await payButton.click();
      console.log("✓ '支払う' clicked");

      // ---- Step 2: the 3-D Secure test screen ----
      // In test mode Pay.jp sends the browser to
      // api.pay.jp/v1/tds/<charge-id>/start, which asks which outcome to
      // simulate: #success is preselected, and 実行 ("execute") submits it.
      //
      // Scanned across every frame rather than read off page.url(): that
      // screen is a full-page redirect for the redirect-type flow (the page
      // carries its own redirect_url), but payjp.js hosts the very same screen
      // in an iframe for the non-redirect flow, where the URL never changes.
      const deadline = Date.now() + 90000;
      let handled3ds = false;

      while (Date.now() < deadline && !handled3ds) {
        if (paymentAlreadyCompleted(page)) {
          console.log(
            `✓ Payment completed without a 3DS screen — now on: ${page.url()}`,
          );
          return;
        }

        for (const frame of page.frames()) {
          if (!frame.url().includes("api.pay.jp/v1/tds/")) continue;

          // The same endpoint renders 認証エラー when this session's 3DS step
          // has already been consumed ("不正な遷移です") — its only control is a
          // 戻る button that hands straight back to the failed callback, so
          // there is nothing to retry. Fail with the page's own reason.
          const errorTitle = frame.locator("p.title", {
            hasText: "認証エラー",
          });

          if (await errorTitle.isVisible().catch(() => false)) {
            const reason =
              (await frame
                .locator(".caption-box")
                .last()
                .textContent()
                .catch(() => "")) || "";

            throw new Error(
              `Pay.jp 3-D Secure returned 認証エラー (authentication error): ` +
                `"${reason.replace(/\s+/g, " ").trim()}". A checkout session's 3DS step can ` +
                `only be used once — re-run the flow from a freshly created session.`,
            );
          }

          const successRadio = frame.locator("input#success");

          if (!(await successRadio.isVisible().catch(() => false))) continue;

          // check(), not click(): the server ships this radio already checked,
          // and check() is a no-op that still asserts the state when it is —
          // so the choice is explicit either way, and survives Pay.jp changing
          // which outcome is the default.
          await successRadio.check();
          console.log(
            "✓ Selected the 'success' outcome on the 3DS test screen",
          );

          const executeButton = frame.locator(
            'input[type="submit"][value="実行"]',
          );
          await executeButton.waitFor({ state: "visible", timeout: 30000 });
          await executeButton.click();
          console.log("✓ '実行' clicked");

          handled3ds = true;
          break;
        }

        if (handled3ds) break;

        // Navigated somewhere that isn't the 3DS screen — this session was
        // never challenged, so stop looking for it and go settle.
        if (
          page.url() !== urlBeforeClick &&
          !page.url().includes("api.pay.jp/v1/tds/")
        ) {
          console.log(`[state] No 3DS screen — page moved to: ${page.url()}`);
          break;
        }

        await page.waitForTimeout(500);
      }

      // ---- Step 3: settle ----
      // waitForSubmissionToTakeEffect() deliberately isn't used here: after the
      // 3DS hop the URL already differs from urlBeforeClick, so it would report
      // success while the browser still sat on api.pay.jp. What counts is
      // leaving Pay.jp altogether — the 実行 submit redirects on through
      // PayLexer's redirect-callback to the store's return URL.
      const stillOnPayjp = () =>
        page.url().startsWith("https://c.pay.jp/") ||
        page.url().includes("api.pay.jp/v1/tds/");

      const settleDeadline = Date.now() + 90000;

      while (Date.now() < settleDeadline) {
        if (paymentAlreadyCompleted(page)) {
          console.log(`✓ Pay.jp payment completed — now on: ${page.url()}`);
          return;
        }

        if (!stillOnPayjp()) {
          console.log(
            `✓ Pay.jp submission took effect — now on: ${page.url()}`,
          );
          return;
        }

        // A gateway-side rejection (declined card, expired session) is written
        // back into the widget's own error line WITHOUT a navigation, so a
        // URL-only wait would sit out the full timeout on a charge that had
        // already failed.
        const cardFrame = page
          .frames()
          .find((f) => f.url().includes("js.pay.jp/payments/widgets/payment-"));

        if (cardFrame) {
          const errors = await cardFrame
            .locator(".text-alert")
            .allTextContents()
            .catch(() => []);
          const firstError = errors.map((t) => t.trim()).find(Boolean);

          if (firstError) {
            throw new Error(`Pay.jp rejected the payment: "${firstError}"`);
          }
        }

        await page.waitForTimeout(500);
      }

      throw new Error(
        `Pay.jp neither left its hosted pages nor reported an error within 90000ms of the ` +
          `submit — still on "${page.url()}".\n${await describeSubmitButtons(page)}`,
      );
    },
  },

  Barion: {
    fillCardDetails: async (page) => {
      console.log("Waiting for the Barion hosted payment page...");

      // https://secure.test.barion.com/Pay?Id=<payment-id> — the id is
      // per-payment, so only the fixed prefix is matched.
      //
      // Raced against the checkout's own error modal rather than waited for
      // plainly: a Barion POSKey that is missing, wrong, or a production key
      // against the sandbox is refused when the payment session is opened, and
      // the checkout then sits on "Session Error / Authentication required"
      // forever. A plain wait reports only "no navigation in 45s" for that,
      // which sends you looking at this card form — which was never reached.
      await waitForHostedRedirectOrCheckoutError(
        page,
        "https://secure.test.barion.com/Pay",
        "Barion",
        45000,
      );
      console.log(`✓ Barion payment page found: ${page.url()}`);

      // Everything lives in the page's OWN document — unlike Nets/Pay.jp there
      // is no hosted-field iframe here, so plain page.locator() calls reach the
      // inputs. The only iframes on this page belong to Google Pay / Apple Pay,
      // which this flow ignores.
      const cardForm = page.locator("form#cardPaymentForm");
      const cardNumberInput = page.locator("#CardNumber");

      // The guest card form is what the redirect lands on for a payment that
      // allows it, but Barion can also open on its wallet-login view, where the
      // card form is behind a "pay without registration" link. Waited for
      // rather than assumed: the form is only absent for a moment while the
      // page boots, so a short probe distinguishes "still loading" from "this
      // session is not offering guest card payment at all".
      try {
        await cardNumberInput.waitFor({ state: "visible", timeout: 30000 });
      } catch (err) {
        throw new Error(
          `Barion's guest card form (#CardNumber) never appeared on "${page.url()}" within 30s. ` +
            `If the page opened on the Barion Wallet login instead, this step needs to click ` +
            `through to the card form first.`,
        );
      }

      // Barion's own sandbox test card (docs: "Test cards"). Any future expiry
      // and any 3-digit CVC are accepted with it; the month is fixed and the
      // year computed as current + 3, same convention as the other gateways,
      // so the expiry never drifts into the past.
      const CARD_NUMBER = "4444888888885559";
      const CARD_CVC = "123";
      const CARDHOLDER_NAME = "Token Tutorial";
      const EXPIRY_MONTH = "12";
      const EXPIRY_YY = String((new Date().getFullYear() + 3) % 100).padStart(
        2,
        "0",
      );

      console.log(`Using Barion test card ending in ${CARD_NUMBER.slice(-4)}`);
      console.log(
        `Expiry set to ${EXPIRY_MONTH}/${EXPIRY_YY} (always current year + 3)`,
      );

      // -- Email -------------------------------------------------------------
      // The page ships this pre-filled with the booking's email address, so it
      // is only filled when Barion left it empty. Overwriting a good value with
      // an invented one would put a different address on the payment than on
      // the booking.
      const emailInput = page.locator("#EmailAddress");
      await emailInput.waitFor({ state: "visible", timeout: 30000 });
      const prefilledEmail = (await emailInput.inputValue()).trim();

      if (prefilledEmail) {
        console.log(`[state] Email pre-filled by Barion: "${prefilledEmail}"`);
      } else {
        await emailInput.click();
        await emailInput.fill("token.tutorial@example.com");
        console.log(`✓ Email now contains: "${await emailInput.inputValue()}"`);
      }

      // -- Card number -------------------------------------------------------
      // pressSequentially, not fill(): #CardNumber and #CardExpiration both
      // carry Barion's own `pg-mask` handler (data-mask-type), which regroups
      // the number into 4-digit blocks and inserts the expiry's "/" on the
      // keystroke events fill() skips. The mask is also why the readback is
      // compared on digits only — waitForFieldValue() does exactly that.
      await cardNumberInput.click();
      await cardNumberInput.pressSequentially(CARD_NUMBER, { delay: 50 });
      await waitForFieldValue(
        page,
        cardNumberInput,
        "Card number",
        CARD_NUMBER,
      );

      // -- Expiry ------------------------------------------------------------
      // Digits only (MMYY): the mask adds the separator itself as soon as the
      // third digit arrives, so typing "12/29" would push the year past the
      // 5-character maxlength.
      const expiryInput = page.locator("#CardExpiration");
      await expiryInput.waitFor({ state: "visible", timeout: 30000 });
      await expiryInput.click();
      await expiryInput.pressSequentially(`${EXPIRY_MONTH}${EXPIRY_YY}`, {
        delay: 50,
      });
      await waitForFieldValue(
        page,
        expiryInput,
        "Expiry",
        `${EXPIRY_MONTH}${EXPIRY_YY}`,
      );

      const expiryValue = await expiryInput.inputValue();

      // The form's validator only counts the expiry as complete at MM/YY, so a
      // short read here means the mask dropped keystrokes and the submit would
      // be blocked client-side.
      if (!/^\d{2}\/\d{2}$/.test(expiryValue)) {
        throw new Error(
          `Barion expiry field reads "${expiryValue}", not MM/YY — the mask did not accept the ` +
            `${EXPIRY_MONTH}${EXPIRY_YY} typed into it.`,
        );
      }

      // -- CVC ---------------------------------------------------------------
      // Unmasked (type="text" with a ^\d{3,4}$ pattern), but typed the same way
      // so a rejected keystroke shows up in the readback rather than silently.
      const cvcInput = page.locator("#CardCVC");
      await cvcInput.waitFor({ state: "visible", timeout: 30000 });
      await cvcInput.click();
      await cvcInput.pressSequentially(CARD_CVC, { delay: 50 });
      await waitForFieldValue(page, cvcInput, "Security code", CARD_CVC);

      // -- Name on card ------------------------------------------------------
      const nameInput = page.locator("#CardHolderName");
      await nameInput.waitFor({ state: "visible", timeout: 30000 });
      await nameInput.click();
      await nameInput.fill(CARDHOLDER_NAME);
      console.log(
        `✓ Name on card now contains: "${await nameInput.inputValue()}"`,
      );

      // #RegisterUser ("Save card for easier checkouts") is deliberately left
      // unchecked — ticking it expands #SaveCardContent, which then REQUIRES a
      // Barion Wallet password before the form will submit.

      // jQuery-validate writes into the field's own <span> and swaps
      // .field-validation-valid for .field-validation-error, so the error class
      // is what's polled — the spans exist either way, empty and valid, so a
      // text-only check would read blanks and report nothing.
      await nameInput.blur().catch(() => {});

      const fieldErrors = await cardForm
        .locator("span.field-validation-error")
        .allTextContents()
        .catch(() => []);
      const firstError = fieldErrors.map((t) => t.trim()).find(Boolean);

      if (firstError) {
        throw new Error(
          `Barion rejected the card details client-side: "${firstError}". The submit is blocked, ` +
            `so the card would never reach the gateway.`,
        );
      }

      // Only waited for here — the click belongs to submitCardPayment(), same
      // split as Nets/Pay.jp.
      const payButton = page.locator("#StartGuestPayment");
      await payButton.waitFor({ state: "visible", timeout: 30000 });
      console.log(
        `✓ Pay button ready: "${(await payButton.innerText().catch(() => "")).trim()}"`,
      );

      console.log("✓ All Barion card fields filled");
    },

    submitCardPayment: async (page) => {
      console.log("Submitting Barion payment...");

      if (paymentAlreadyCompleted(page)) {
        console.log(
          `✓ Payment already went through — at "${page.url()}". Nothing to click.`,
        );
        return;
      }

      // Keyed on the id rather than on the "Pay: Ft3,300" text: the same page
      // renders a Google Pay button and (when enabled) an Apple Pay one above
      // the form, both of which a text match on "Pay" would also hit.
      const payButton = page.locator("#StartGuestPayment");
      await payButton.waitFor({ state: "visible", timeout: 30000 });
      await payButton.scrollIntoViewIfNeeded();
      await payButton.click();
      console.log("✓ Barion 'Pay' clicked");

      // ---- Settle ----
      // The form posts with data-ajax="true", so a card the gateway refuses
      // comes back as text in the page WITHOUT any navigation — a URL-only wait
      // would sit out the whole timeout on a payment that had already failed.
      // Both outcomes are therefore polled together.
      //
      // On success Barion redirects out through its own 3DS step (the sandbox
      // test card clears it without a challenge screen) to PayLexer's callback
      // and on to the store's return URL — so "left secure.test.barion.com" is
      // what counts as done, not merely "url changed".
      const stillOnBarion = () =>
        page.url().startsWith("https://secure.test.barion.com/");

      const deadline = Date.now() + 90000;

      while (Date.now() < deadline) {
        if (paymentAlreadyCompleted(page)) {
          console.log(`✓ Barion payment completed — now on: ${page.url()}`);
          return;
        }

        if (!stillOnBarion()) {
          console.log(
            `✓ Barion submission took effect — now on: ${page.url()}`,
          );
          return;
        }

        // .pg-form-alert is the form-level banner (gateway refusals, expired
        // payment sessions); it ships with d-none and has that class removed
        // when there is something to say, so visibility is the tell.
        const alert = page.locator("form#cardPaymentForm .pg-form-alert");
        const alertText = (await alert
          .first()
          .isVisible()
          .catch(() => false))
          ? (
              (await alert
                .first()
                .textContent()
                .catch(() => "")) || ""
            )
              .replace(/\s+/g, " ")
              .trim()
          : "";

        if (alertText) {
          throw new Error(`Barion rejected the payment: "${alertText}"`);
        }

        const fieldErrors = await page
          .locator("form#cardPaymentForm span.field-validation-error")
          .allTextContents()
          .catch(() => []);
        const firstError = fieldErrors.map((t) => t.trim()).find(Boolean);

        if (firstError) {
          throw new Error(
            `Barion refused to submit the card form: "${firstError}"`,
          );
        }

        await page.waitForTimeout(500);
      }

      throw new Error(
        `Barion neither left its hosted pages nor reported an error within 90000ms of the ` +
          `submit — still on "${page.url()}".\n${await describeSubmitButtons(page)}`,
      );
    },
  },

  Safepay: {
    fillCardDetails: async (page) => {
      console.log("Waiting for the Safepay hosted checkout...");

      // https://sandbox.api.getsafepay.com/embedded/payment/auth?...tracker=...
      // Everything after the path is per-payment, so only the prefix is waited
      // on. Production would be api.getsafepay.com — this suite only ever runs
      // against the sandbox host.
      await waitForUrlPrefix(
        page,
        "https://sandbox.api.getsafepay.com/embedded/payment/auth",
        45000,
      );
      console.log(`✓ Safepay checkout found: ${page.url()}`);

      // Every field lives in the page's OWN document — the only iframes here
      // belong to Google Pay, which this flow ignores (the #gpay-button is
      // deliberately never touched; the card form below it is the path under
      // test).
      //
      // None of the inputs carry an id, a name or a data-testid, so each one is
      // pinned by the single attribute that makes it unique among its siblings:
      //
      //   Email        input.EmailInput-input
      //   Phone        input.PhoneNumberInput-input
      //   Card number  the only Field-input carrying a pattern ([0-9\s]{19})
      //   Expiry       the one input NOT styled as a Field-input — it is the
      //                floating-label control (.flex.h-9.w-full.bg-transparent)
      //   CVC          the only Field-input with inputmode="numeric" and no
      //                pattern, which is also the one shipping maxlength="0"
      //
      // The four remaining bare `input.Field-input` boxes are the billing
      // fields, and those DO have a <span class="Label"> beside them inside the
      // same <label class="Field-inner">, so they are anchored on their label
      // text rather than on position. (That class swings between "Label" and
      // "Label Label--resting" depending on whether the field holds a value, so
      // the class list can't be matched exactly — hence `span.Label` plus an
      // exact text match.)
      const byLabel = (labelText) =>
        page
          .locator(
            `label.Field-inner:has(span.Label:text-is("${labelText}")) input`,
          )
          .first();

      const emailInput = page.locator("input.EmailInput-input").first();
      const phoneInput = page.locator("input.PhoneNumberInput-input").first();
      const cardNumberInput = page
        .locator('input.Field-input[inputmode="numeric"][pattern]')
        .first();
      const expiryInput = page
        .locator("input.flex.h-9.w-full.bg-transparent")
        .first();
      const cvcInput = page
        .locator('input.Field-input[inputmode="numeric"]:not([pattern])')
        .first();

      // Scoped to Button--block rather than matched on "Pay" text: the same
      // page renders a Google Pay button above the form and a "Cancel payment"
      // button below it, both of which a text match would also reach.
      const payButton = page
        .locator("button.Button--primary.Button--block:has(span.Button-text)")
        .first();

      // Safepay's sandbox test card. Any future expiry and any 3-digit CVC are
      // accepted with it; the month is fixed and the year computed as
      // current + 3, the same convention as every other gateway here, so the
      // expiry never drifts into the past.
      const CARD_NUMBER = "4111111111111111";
      const CARD_CVC = "123";
      const EXPIRY_MONTH = "12";
      const EXPIRY_YY = String((new Date().getFullYear() + 3) % 100).padStart(
        2,
        "0",
      );

      // Billing address is mandatory on this form — the Pay button stays
      // disabled until first name, last name, country, street and city are all
      // non-empty. PK is selected because the payment is in PKR.
      const BILLING_FIRST_NAME = "Token";
      const BILLING_LAST_NAME = "Tutorial";
      const BILLING_COUNTRY = "PK";
      const BILLING_STREET = "Plot 123, Main Boulevard";
      const BILLING_CITY = "Karachi";

      console.log(`Using Safepay test card ending in ${CARD_NUMBER.slice(-4)}`);
      console.log(
        `Expiry set to ${EXPIRY_MONTH}/${EXPIRY_YY} (always current year + 3)`,
      );

      // Every field is CLICKED before anything is written into it. The form's
      // validator hangs off focus/blur rather than off the value alone, so a
      // field written to without ever being focused stays marked empty and
      // keeps the Pay button disabled even though it visibly holds the right
      // text.
      const clickAndFill = async (input, fieldName, value) => {
        await input.waitFor({ state: "visible", timeout: 30000 });
        await input.scrollIntoViewIfNeeded();
        await input.click();
        await input.fill(value);
        console.log(
          `✓ ${fieldName} now contains: "${await input.inputValue()}"`,
        );
      };

      // Masked fields (card number, expiry, CVC) get keystrokes instead of
      // fill(): they regroup digits and detect the card brand as you type, and
      // both behaviours hang off the key events fill() skips entirely.
      const clickAndType = async (input, fieldName, value) => {
        await input.waitFor({ state: "visible", timeout: 30000 });
        await input.scrollIntoViewIfNeeded();
        await input.click();
        await input.pressSequentially(value, { delay: 50 });
        await waitForFieldValue(page, input, fieldName, value);
      };

      // -- Email → phone → card (in that order, it is not optional) ----------
      // The form reveals itself one step at a time: only Email is on screen
      // when the page opens, the phone field appears once Email holds a valid
      // address, and the card fields appear once the phone number is in. So
      // each step both fills its field AND waits for the next one to be
      // rendered — a fill that jumped straight to the card number would be
      // waiting on an input that does not exist in the DOM yet.
      //
      // Safepay pre-fills email and phone from the order, so a pre-filled
      // value is left alone (overwriting a good value with an invented one
      // would put a different address on the payment than on the order) — but
      // the field is still clicked and committed with a Tab, because the reveal
      // hangs off the change/blur that the pre-fill alone never fires.
      await emailInput.waitFor({ state: "visible", timeout: 30000 });
      const prefilledEmail = (await emailInput.inputValue()).trim();

      if (prefilledEmail) {
        console.log(`[state] Email pre-filled by Safepay: "${prefilledEmail}"`);
      } else {
        await clickAndFill(emailInput, "Email", "token.tutorial@example.com");
      }

      await emailInput.click();
      await emailInput.press("Tab");

      try {
        await phoneInput.waitFor({ state: "visible", timeout: 30000 });
      } catch (err) {
        throw new Error(
          `Safepay never revealed the phone field within 30s of the email "${
            prefilledEmail || "token.tutorial@example.com"
          }" being entered — the form is still on its email-only step, so there is nothing to ` +
            `type a card into.`,
        );
      }
      console.log("✓ Phone field revealed");

      const prefilledPhone = (
        await phoneInput.inputValue().catch(() => "")
      ).trim();

      if (prefilledPhone) {
        console.log(`[state] Phone pre-filled by Safepay: "${prefilledPhone}"`);
      } else {
        // Typed rather than filled: the placeholder ("9841234567") is a local
        // format and the input reformats and revalidates per keystroke.
        await clickAndType(phoneInput, "Phone", "9745120125");
      }

      await phoneInput.click();
      await phoneInput.press("Tab");

      // -- Card number -------------------------------------------------------
      try {
        await cardNumberInput.waitFor({ state: "visible", timeout: 30000 });
      } catch (err) {
        throw new Error(
          `Safepay never revealed the card fields within 30s of the phone number "${
            prefilledPhone || "9745120125"
          }" being entered — the number is likely being rejected as invalid for its country ` +
            `code, which keeps the form on its contact step.`,
        );
      }
      console.log("✓ Card fields revealed");

      await clickAndType(cardNumberInput, "Card number", CARD_NUMBER);

      // -- Expiry ------------------------------------------------------------
      // Digits only (MMYY): the field inserts the "/" itself once the third
      // digit arrives, so typing "12/29" would push the year past the input's
      // own length limit. waitForFieldValue() compares digits only, so the
      // inserted separator doesn't matter to the readback.
      await clickAndType(expiryInput, "Expiry", `${EXPIRY_MONTH}${EXPIRY_YY}`);

      // -- CVC ---------------------------------------------------------------
      // The CVC input ships as maxlength="0" and only gets a real limit (3 or
      // 4) once the card number has identified the brand. Typed into too early
      // it silently accepts NOTHING — the field stays empty, the Pay button
      // stays disabled, and there is no error to explain why. So the limit is
      // polled for first.
      await cvcInput.waitFor({ state: "visible", timeout: 30000 });

      const cvcDeadline = Date.now() + 15000;
      let cvcMaxLength = "0";

      while (Date.now() < cvcDeadline) {
        cvcMaxLength =
          (await cvcInput.getAttribute("maxlength").catch(() => null)) || "";

        // An absent maxlength is fine — it only ever means "unlimited".
        if (cvcMaxLength !== "0") break;

        await page.waitForTimeout(300);
      }

      if (cvcMaxLength === "0") {
        throw new Error(
          `Safepay's CVC field is still maxlength="0" 15s after the card number was typed — ` +
            `the form never recognised the card ending ${CARD_NUMBER.slice(-4)}, so the CVC ` +
            `would be discarded keystroke by keystroke.`,
        );
      }

      await clickAndType(cvcInput, "CVC", CARD_CVC);

      // -- Billing address ---------------------------------------------------
      await clickAndFill(
        byLabel("First name"),
        "First name",
        BILLING_FIRST_NAME,
      );
      await clickAndFill(byLabel("Last name"), "Last name", BILLING_LAST_NAME);

      // The country <select> is the one billing control with a real name
      // attribute, and selectOption is the only thing that fires the change
      // handler the form's validator listens to.
      const countrySelect = page.locator(
        'select[name="billingAddress.country"]',
      );
      await countrySelect.waitFor({ state: "visible", timeout: 30000 });
      await countrySelect.selectOption(BILLING_COUNTRY);
      console.log(`✓ Country set to "${await countrySelect.inputValue()}"`);

      await clickAndFill(
        byLabel("Street address"),
        "Street address",
        BILLING_STREET,
      );
      await clickAndFill(byLabel("City"), "City", BILLING_CITY);

      // #morning ("Securely save my card information") is deliberately left
      // unchecked: saving the card registers it against the shopper's Safepay
      // profile, which changes what the NEXT run of this suite is presented
      // with (a saved-card picker instead of a blank form).

      // -- Client-side verdict -----------------------------------------------
      // Blur the last field so the form runs its validators, then read the
      // message element. <p class="text-destructive"> is on the page at all
      // times and is empty when there's nothing to say, so the TEXT is the
      // tell, not the element's presence.
      await page.locator("body").click({ position: { x: 5, y: 5 } });

      const inlineErrors = await page
        .locator("p.text-destructive")
        .allTextContents()
        .catch(() => []);
      const firstInlineError = inlineErrors.map((t) => t.trim()).find(Boolean);

      if (firstInlineError) {
        throw new Error(
          `Safepay rejected the card details client-side: "${firstInlineError}". The submit is ` +
            `blocked, so the card would never reach the gateway.`,
        );
      }

      // The Pay button ships disabled and is only enabled once every required
      // field validates, so waiting for it to become enabled is the cheapest
      // proof that the fill above actually took — and .Field--empty then names
      // what is still missing far more precisely than a timeout on the click
      // ever could.
      await payButton.waitFor({ state: "visible", timeout: 30000 });

      const enabledDeadline = Date.now() + 30000;

      while (Date.now() < enabledDeadline) {
        if (await payButton.isEnabled().catch(() => false)) break;
        await page.waitForTimeout(500);
      }

      if (!(await payButton.isEnabled().catch(() => false))) {
        const emptyLabels = await page
          .locator(".Field--empty span.Label")
          .allTextContents()
          .catch(() => []);

        throw new Error(
          `Safepay's Pay button is still disabled 30s after every field was filled. Fields the ` +
            `form still considers empty: ${
              emptyLabels
                .map((t) => t.trim())
                .filter(Boolean)
                .join(", ") || "(none reported)"
            }.`,
        );
      }

      console.log(
        `✓ Pay button ready: "${(await payButton.innerText().catch(() => "")).trim()}"`,
      );

      console.log("✓ All Safepay card fields filled");
    },

    submitCardPayment: async (page) => {
      console.log("Submitting Safepay payment...");

      if (paymentAlreadyCompleted(page)) {
        console.log(
          `✓ Payment already went through — at "${page.url()}". Nothing to click.`,
        );
        return;
      }

      // Same scoping as in fillCardDetails(): Button--block picks the wide
      // "Pay Rs.…" button, not the Google Pay button or "Cancel payment".
      const payButton = page
        .locator("button.Button--primary.Button--block:has(span.Button-text)")
        .first();
      await payButton.waitFor({ state: "visible", timeout: 30000 });
      await payButton.scrollIntoViewIfNeeded();
      await payButton.click();
      console.log("✓ Safepay 'Pay' clicked");

      // ---- Settle ----
      // The form submits over XHR, so a card the gateway refuses comes back as
      // text in the page WITHOUT any navigation — a URL-only wait would sit out
      // the whole timeout on a payment that had already failed. Both outcomes
      // are therefore polled together.
      //
      // On success Safepay runs its 3DS step and then redirects out to
      // PayLexer's /redirect-callback and on to the store's return URL — so
      // "left the getsafepay.com hosts" is what counts as done, not merely "url
      // changed", which the 3DS step alone would satisfy.
      const stillOnSafepay = () => page.url().includes("getsafepay.com");

      const deadline = Date.now() + 120000;
      let sawChallenge = false;

      while (Date.now() < deadline) {
        if (paymentAlreadyCompleted(page)) {
          console.log(`✓ Safepay payment completed — now on: ${page.url()}`);
          return;
        }

        if (!stillOnSafepay()) {
          console.log(
            `✓ Safepay submission took effect — now on: ${page.url()}`,
          );
          return;
        }

        const errorText =
          (
            await page
              .locator("p.text-destructive")
              .allTextContents()
              .catch(() => [])
          )
            .map((t) => t.replace(/\s+/g, " ").trim())
            .find(Boolean) || "";

        if (errorText) {
          throw new Error(`Safepay rejected the payment: "${errorText}"`);
        }

        // A 3DS challenge is only NOTED, never answered: the sandbox card is
        // meant to clear frictionlessly, so a challenge screen means this
        // payment wants an OTP nobody in this suite has. Recording that it
        // appeared makes the eventual timeout say so instead of blaming the
        // fill.
        if (!sawChallenge) {
          const challenge = page
            .frames()
            .find((f) => /acs|3ds|challenge|threeds/i.test(f.url()));

          if (challenge) {
            sawChallenge = true;
            console.log(
              `[state] Safepay opened a 3DS challenge frame: ${challenge.url()}`,
            );
          }
        }

        await page.waitForTimeout(500);
      }

      throw new Error(
        `Safepay neither left its hosted pages nor reported an error within 120000ms of the ` +
          `submit — still on "${page.url()}".` +
          (sawChallenge
            ? ` A 3DS challenge frame appeared and was never answered: this payment needs an OTP, ` +
              `which the sandbox test card is not supposed to ask for.`
            : "") +
          `\n${await describeSubmitButtons(page)}`,
      );
    },
  },

  //10th
  Tpay: {
    fillCardDetails: async (page) => {
      console.log("Filling Tpay card details (full-page redirect)...");

      // The query carries a per-session title and uid, so only the host prefix
      // is matched.
      await waitForUrlPrefix(page, "https://secure.sandbox.tpay.com/", 60000);
      console.log(`✓ Tpay checkout reached: ${page.url()}`);

      // VERIFY THIS CARD NUMBER against Tpay's sandbox documentation — nothing in
      // the form's markup hints at an accepted test card. If the form rejects it
      // ("Podany numer karty jest nieprawidłowy"), this constant is the first
      // thing to change.
      //
      // CVV is exactly 3 digits: #cvc is minlength=3 maxlength=3, so a 4-digit
      // Amex code would be truncated and rejected.
      //
      // Expiry MONTH stays fixed, YEAR is computed (current year + 3) so it never
      // becomes a past date.
      const CARD_NUMBER = "4242424242424242";
      const CARD_CVV = "847";
      const CARD_EXPIRY_MONTH = "02";
      const CARD_EXPIRY_YEAR = String(
        (new Date().getFullYear() + 3) % 100,
      ).padStart(2, "0");

      console.log(`Using fixed test card ending in ${CARD_NUMBER.slice(-4)}`);
      console.log(
        `Expiry set to ${CARD_EXPIRY_MONTH}/${CARD_EXPIRY_YEAR} (always current year + 3)`,
      );

      // -- Choose the card method -------------------------------------------
      // Matched on an EXACT label. a.type-belt is repeated once per payment
      // method (BLIK, bank transfers, wallets), and the class carries no
      // per-method information — the .name text is the only discriminator.
      // text-is rather than hasText so "Karta" cannot also match a longer method
      // name containing it.
      const cardMethod = page
        .locator("a.type-belt")
        .filter({ has: page.locator('.name:text-is("Karta")') })
        .first();

      await cardMethod.waitFor({ state: "visible", timeout: 45000 });
      const methodCount = await page
        .locator("a.type-belt")
        .filter({ has: page.locator('.name:text-is("Karta")') })
        .count();
      console.log(`[diag] "Karta" method rows matched: ${methodCount}`);

      await cardMethod.scrollIntoViewIfNeeded();
      await cardMethod.click();
      console.log("✓ 'Karta' payment method clicked");

      // Each field is clicked immediately before typing into it.
      // pressSequentially rather than fill() throughout: the card number groups
      // itself into blocks of four (maxlength=23 leaves room for the spaces) and
      // the expiry inserts its own separator, both driven by input events that
      // fill() does not produce.

      // -- Card number ------------------------------------------------------
      const cardNumberInput = page.locator("#cardNumber");
      await cardNumberInput.waitFor({ state: "visible", timeout: 45000 });
      await cardNumberInput.click();
      await cardNumberInput.pressSequentially(CARD_NUMBER, { delay: 50 });
      console.log(
        `✓ Card number field now contains: "${await cardNumberInput.inputValue()}"`,
      );

      // -- Expiry -----------------------------------------------------------
      // Placeholder "MM/YY" with maxlength=5 — a bare slash, NO surrounding
      // spaces, unlike Moyasar's and Paddle's spaced masks. Only the four digits
      // are typed and the result verified, because a mask that didn't fire leaves
      // "0229" in a field Tpay rejects.
      const expiryInput = page.locator("#expiryDate");
      await expiryInput.waitFor({ state: "visible", timeout: 30000 });
      await expiryInput.click();
      await expiryInput.pressSequentially(
        `${CARD_EXPIRY_MONTH}${CARD_EXPIRY_YEAR}`,
        { delay: 50 },
      );

      let expiryValue = await expiryInput.inputValue();
      if (!expiryValue.includes("/")) {
        console.log(
          `⚠ Expiry mask did not insert "/" (field reads "${expiryValue}") — retyping with the separator`,
        );
        await expiryInput.fill("");
        await expiryInput.click();
        await expiryInput.pressSequentially(
          `${CARD_EXPIRY_MONTH}/${CARD_EXPIRY_YEAR}`,
          { delay: 50 },
        );
        expiryValue = await expiryInput.inputValue();
      }
      console.log(`✓ Expiry field now contains: "${expiryValue}"`);

      // -- CVV --------------------------------------------------------------
      // Note the id is #cvc, not #cvv — the field's LABEL reads "CVV2/CVC" and
      // its wrapper class is "cvv", which makes #cvv the intuitive guess and the
      // wrong one.
      const cvvInput = page.locator("#cvc");
      await cvvInput.waitFor({ state: "visible", timeout: 30000 });
      await cvvInput.click();
      await cvvInput.pressSequentially(CARD_CVV, { delay: 50 });
      console.log(`✓ CVV field now contains: "${await cvvInput.inputValue()}"`);

      console.log("✓ All card fields filled — readback values logged above");

      // -- Validation readback ----------------------------------------------
      // Each field has a sibling .error-wrapper that ships with class "hidden"
      // and loses it when the field fails validation. So a VISIBLE error wrapper
      // after filling is a real rejection, and the messages name the field
      // ("Podany numer karty jest nieprawidłowy", "Nieprawidłowa data",
      // "Uzupełnij numer").
      const visibleErrors = await page
        .locator(".error-wrapper:not(.hidden)")
        .allTextContents()
        .catch(() => []);

      if (visibleErrors.length > 0) {
        throw new Error(
          `Tpay reports field errors after filling: ${JSON.stringify(
            visibleErrors.map((t) => t.trim()),
          )}. "Podany numer karty jest nieprawidłowy" means the card number is ` +
            `outside Tpay's accepted sandbox set — that constant needs verifying.`,
        );
      }
      console.log("✓ No field errors reported");

      // No click here on purpose: submitCardPayment() runs immediately after
      // this and owns the click plus the 3DS and return steps.
    },

    submitCardPayment: async (page) => {
      console.log("Clicking Tpay 'Zapłać' button...");

      // -- 1. Zapłać ---------------------------------------------------------
      // Targeted by id. The label sits in a nested <span class="btn-label">, so
      // #pay is both simpler and stabler than a text match against Polish copy.
      //
      // Note this <button> has NO type attribute. Inside a form that defaults to
      // type="submit"; outside one it is inert to form submission and Tpay's own
      // click handler does the work. Either way a plain click is correct — there
      // is no requestSubmit fallback to reach for.
      const payButton = page.locator("#pay");
      await payButton.waitFor({ state: "visible", timeout: 30000 });
      await payButton.scrollIntoViewIfNeeded();
      await payButton.click();
      console.log("✓ Zapłać clicked");

      // Tpay validates on submit and reveals the same .error-wrapper divs rather
      // than navigating, so this catches a rejection before the 3DS wait below
      // spends 60s on a challenge that will never arrive.
      await page.waitForTimeout(3000);
      const submitErrors = await page
        .locator(".error-wrapper:not(.hidden)")
        .allTextContents()
        .catch(() => []);
      if (submitErrors.length > 0) {
        throw new Error(
          `Tpay rejected the payment on submit: ${JSON.stringify(
            submitErrors.map((t) => t.trim()),
          )}`,
        );
      }

      // -- 2. 3DS sandbox challenge ------------------------------------------
      // Resolved across frames rather than assumed top-level: ACS challenge
      // pages are commonly iframed, and page.locator() only searches the main
      // frame, so it would silently never find the button.
      //
      // Targeted by id, NOT by its onclick href — that URL embeds a per-session
      // uuid (3ds.sandbox.tpay.com/<uuid>/challenge/accept).
      const challengeSelector = "#successful-challenge-button";
      console.log(
        "Waiting for the 3DS sandbox challenge (polling all frames)...",
      );

      let challengeCtx = null;
      const challengeDeadline = Date.now() + 60000;
      while (Date.now() < challengeDeadline && !challengeCtx) {
        for (const frame of page.frames()) {
          const count = await frame
            .locator(challengeSelector)
            .count()
            .catch(() => 0);
          if (count > 0) {
            challengeCtx = frame;
            const where =
              frame === page.mainFrame() ? "main frame" : frame.url();
            console.log(`✓ 3DS challenge button found in: ${where}`);
            break;
          }
        }
        if (!challengeCtx) await page.waitForTimeout(500);
      }

      if (!challengeCtx) {
        throw new Error(
          `Tpay 3DS challenge button (${challengeSelector}) not found in any frame within 60s.\n` +
            `  URL: ${page.url()}\n` +
            `  Frames: ${JSON.stringify(page.frames().map((f) => f.url()))}\n` +
            `  If the payment resolved without a challenge, this step needs to become ` +
            `conditional — poll briefly and skip when absent.`,
        );
      }

      const challengeButton = challengeCtx.locator(challengeSelector);
      await challengeButton.waitFor({ state: "visible", timeout: 30000 });
      await challengeButton.scrollIntoViewIfNeeded();
      await challengeButton.click();
      console.log("✓ Successful challenge clicked");

      // -- 3. Return to the shop ---------------------------------------------
      // An <a>, not a button, so clicking navigates via its href. Targeted by id
      // rather than the Polish label ("Wróć do sklepu") or the class chain, which
      // mixes generic btn classes with default-url.
      const backSelector = "#back-button";
      console.log("Waiting for the return link (polling all frames)...");

      let backCtx = null;
      const backDeadline = Date.now() + 60000;
      while (Date.now() < backDeadline && !backCtx) {
        for (const frame of page.frames()) {
          const count = await frame
            .locator(backSelector)
            .count()
            .catch(() => 0);
          if (count > 0) {
            backCtx = frame;
            const where =
              frame === page.mainFrame() ? "main frame" : frame.url();
            console.log(`✓ Return link found in: ${where}`);
            break;
          }
        }
        if (!backCtx) await page.waitForTimeout(500);
      }

      if (!backCtx) {
        throw new Error(
          `Tpay return link (${backSelector}) not found in any frame within 60s.\n` +
            `  URL: ${page.url()}\n` +
            `  Frames: ${JSON.stringify(page.frames().map((f) => f.url()))}\n` +
            `  If Tpay redirected back to the shop automatically, this step needs to become ` +
            `conditional.`,
        );
      }

      const backButton = backCtx.locator(backSelector);
      await backButton.waitFor({ state: "visible", timeout: 30000 });
      const backHref = await backButton.getAttribute("href").catch(() => null);
      console.log(`[state] Return link points at: ${backHref}`);

      await backButton.scrollIntoViewIfNeeded();
      await backButton.click();
      console.log("✓ Wróć do sklepu clicked — returning to the shop");
    },
  },

  Komoju: {
    fillCardDetails: async (page) => {
      console.log("Filling Komoju card details (full-page redirect)...");

      // The path carries a per-session id (/sessions/<id>), so only the host
      // prefix is matched.
      await waitForUrlPrefix(page, "https://komoju.com/sessions/", 60000);
      console.log(`✓ Komoju session page reached: ${page.url()}`);

      // Komoju's documented sandbox card. CVV is 3 digits even though
      // #verification allows 4 (maxlength=4, for Amex).
      //
      // Expiry MONTH stays fixed, YEAR is computed (current year + 3) so it
      // never becomes a past date.
      const CARD_NUMBER = "4111111111111111";
      const CARD_CVV = "123";
      const CARD_HOLDER = "TARO YAMADA";
      const CARD_EMAIL = "test@paylexer.com";
      const CARD_EXPIRY_MONTH = "02";
      const CARD_EXPIRY_YEAR = String(
        (new Date().getFullYear() + 3) % 100,
      ).padStart(2, "0");

      console.log(`Using fixed test card ending in ${CARD_NUMBER.slice(-4)}`);
      console.log(
        `Expiry set to ${CARD_EXPIRY_MONTH}/${CARD_EXPIRY_YEAR} (always current year + 3)`,
      );

      // -- Choose the credit-card method ------------------------------------
      // The method list is a set of <a href="#<method>"> tiles (konbini, bank
      // transfer, wallets). The href fragment is the only stable
      // discriminator: every tile shares the same generated data-v- scope
      // attribute and carries no class, and the label is Japanese
      // ("クレジットカード").
      //
      // Skipped when the card form is already on screen — Komoju renders the
      // method list only when the merchant has more than one method enabled,
      // and a hard wait here would fail on a card-only configuration.
      const cardMethod = page.locator('a[href="#credit_card"]').first();
      const numberInput = page.locator("#number");

      const methodVisible = await cardMethod.isVisible().catch(() => false);

      if (methodVisible) {
        await cardMethod.scrollIntoViewIfNeeded();
        await cardMethod.click();
        console.log("✓ 'クレジットカード' payment method clicked");
      } else {
        console.log(
          "[diag] No credit-card method tile on the page — assuming card is the only method",
        );
      }

      // Each field is clicked immediately before typing into it, and typed with
      // pressSequentially rather than fill(): the card number groups itself into
      // blocks of four (maxlength=23 leaves room for the spaces) and the expiry
      // inserts its own " / " separator, both driven by input events fill() does
      // not produce.

      // -- Email ------------------------------------------------------------
      const emailInput = page.locator("#email");
      await emailInput.waitFor({ state: "visible", timeout: 45000 });
      await emailInput.click();
      await emailInput.pressSequentially(CARD_EMAIL, { delay: 30 });
      console.log(
        `✓ Email field now contains: "${await emailInput.inputValue()}"`,
      );

      // -- Cardholder name --------------------------------------------------
      const nameInput = page.locator("#name");
      await nameInput.waitFor({ state: "visible", timeout: 30000 });
      await nameInput.click();
      await nameInput.pressSequentially(CARD_HOLDER, { delay: 30 });
      console.log(
        `✓ Cardholder field now contains: "${await nameInput.inputValue()}"`,
      );

      // -- Card number ------------------------------------------------------
      await numberInput.waitFor({ state: "visible", timeout: 30000 });
      await numberInput.click();
      await numberInput.pressSequentially(CARD_NUMBER, { delay: 50 });
      console.log(
        `✓ Card number field now contains: "${await numberInput.inputValue()}"`,
      );

      // -- Expiry -----------------------------------------------------------
      // Placeholder reads "MM / YY" but maxlength is 5, so the stored value is
      // the UNSPACED "MM/YY" — do NOT type the spaces the placeholder shows or
      // the last digits get truncated. Only the four digits are typed and the
      // result verified, because a mask that didn't fire leaves "0229" in a
      // field Komoju rejects.
      const expiryInput = page.locator("#expiration");
      await expiryInput.waitFor({ state: "visible", timeout: 30000 });
      await expiryInput.click();
      await expiryInput.pressSequentially(
        `${CARD_EXPIRY_MONTH}${CARD_EXPIRY_YEAR}`,
        { delay: 50 },
      );

      let expiryValue = await expiryInput.inputValue();
      if (!expiryValue.includes("/")) {
        console.log(
          `⚠ Expiry mask did not insert "/" (field reads "${expiryValue}") — retyping with the separator`,
        );
        await expiryInput.fill("");
        await expiryInput.click();
        await expiryInput.pressSequentially(
          `${CARD_EXPIRY_MONTH}/${CARD_EXPIRY_YEAR}`,
          { delay: 50 },
        );
        expiryValue = await expiryInput.inputValue();
      }
      console.log(`✓ Expiry field now contains: "${expiryValue}"`);

      // -- CVV --------------------------------------------------------------
      // The id is #verification, not #cvv/#cvc — the label reads
      // "セキュリティコード".
      const cvvInput = page.locator("#verification");
      await cvvInput.waitFor({ state: "visible", timeout: 30000 });
      await cvvInput.click();
      await cvvInput.pressSequentially(CARD_CVV, { delay: 50 });
      console.log(`✓ CVV field now contains: "${await cvvInput.inputValue()}"`);

      console.log("✓ All card fields filled — readback values logged above");

      // -- Validation readback ----------------------------------------------
      // Every field group ends in an EMPTY <p class="error-msg">, which is
      // present and visible in the DOM even when valid — so presence proves
      // nothing and only non-empty text is a real rejection.
      const fieldErrors = (
        await page
          .locator("p.error-msg")
          .allTextContents()
          .catch(() => [])
      )
        .map((t) => t.trim())
        .filter(Boolean);

      if (fieldErrors.length > 0) {
        throw new Error(
          `Komoju reports field errors after filling: ${JSON.stringify(
            fieldErrors,
          )}. An invalid-card-number message means CARD_NUMBER is outside ` +
            `Komoju's accepted sandbox set — that constant is the first thing to change.`,
        );
      }
      console.log("✓ No field errors reported");

      // No click here on purpose: submitCardPayment() runs immediately after
      // this and owns the submit plus any 3DS and return steps.
    },

    submitCardPayment: async (page) => {
      console.log("Submitting the Komoju payment form...");

      // -- 1. Submit ---------------------------------------------------------
      // The submit control is an <input type="submit"> whose value carries the
      // amount ("支払い ￥66"), so it is matched on type, NOT on its label.
      const payButton = page.locator('form input[type="submit"]').first();
      await payButton.waitFor({ state: "visible", timeout: 30000 });

      const payLabel = await payButton.getAttribute("value").catch(() => null);
      console.log(`[state] Submit button reads: "${payLabel}"`);

      const urlBeforeClick = page.url();
      await payButton.scrollIntoViewIfNeeded();
      await payButton.click();
      console.log("✓ Payment submitted");

      // Komoju validates on submit and fills the same <p class="error-msg">
      // nodes rather than navigating, so this catches a rejection before the
      // wait below spends its budget on a redirect that will never come.
      await page.waitForTimeout(3000);
      const submitErrors = (
        await page
          .locator("p.error-msg")
          .allTextContents()
          .catch(() => [])
      )
        .map((t) => t.trim())
        .filter(Boolean);

      if (submitErrors.length > 0) {
        throw new Error(
          `Komoju rejected the payment on submit: ${JSON.stringify(
            submitErrors,
          )}`,
        );
      }

      // -- 2. Leave the Komoju session page ----------------------------------
      // Komoju either redirects straight back to the shop or routes through a
      // 3DS challenge on its own host first. Both cases are covered by waiting
      // for the URL to stop being the session page that was submitted; the
      // shop-side assertions in the spec take it from there.
      //
      // Non-fatal on timeout: the spec's own success check is the authority on
      // whether the order completed, and throwing here would mask a payment
      // that did in fact go through on a slow sandbox.
      try {
        await page.waitForURL((url) => url.href !== urlBeforeClick, {
          timeout: 60000,
        });
        console.log(`✓ Navigated away from the session page: ${page.url()}`);
      } catch {
        console.log(
          `⚠ Still on ${page.url()} 60s after submit — no redirect observed. ` +
            `If Komoju's sandbox shows a 3DS challenge or an explicit ` +
            `"return to shop" link here, this step needs to click it.`,
        );
      }
    },
  },

  Datatrans: {
    fillCardDetails: async (page) => {
      console.log("Filling Datatrans card details (full-page redirect)...");

      // Only the host is matched, not the /upp/jsp/upStart_1.jsp path: the
      // Lightbox moves between upStart_1.jsp and other jsp steps as the method
      // is chosen, so pinning the full path would break on the first hop.
      await waitForUrlPrefix(page, "https://pay.sandbox.datatrans.com/", 60000);
      console.log(`✓ Datatrans payment page reached: ${page.url()}`);

      // Datatrans' documented sandbox Visa. The form declares
      // data-card-validation-enabled="true", so a wrong number is rejected
      // client-side before any submit.
      //
      // Expiry is PINNED to 06/28 — Datatrans' sandbox accepts this specific
      // date for the test card, so it is not derived from the current year.
      // Kept as two separate MM and YY halves because the visible #expiry field
      // is typed as bare digits ("0628") while the retry path joins them with a
      // slash; a single "06/28" constant would type "1206/28".
      //
      // NOTE: being a fixed date, this expires in June 2028 and the fill will
      // start failing then — re-pin it to whatever the sandbox accepts.
      const CARD_NUMBER = "4242424242424242";
      const CARD_CVV = "123";
      const CARD_EXPIRY_MONTH = "06";
      const CARD_EXPIRY_YEAR = "28";

      console.log(`Using fixed test card ending in ${CARD_NUMBER.slice(-4)}`);
      console.log(
        `Expiry set to ${CARD_EXPIRY_MONTH}/${CARD_EXPIRY_YEAR} (pinned Datatrans sandbox date)`,
      );

      // -- Choose the Visa method -------------------------------------------
      // The chooser renders the SAME method list TWICE — once as
      // .payment-list__column (list view, js-segment__is-on) and once as
      // .payment-list__grid (grid view, js-segment__is-off), toggled by the
      // a.js-switcher--input grid/list switch. So every method matches two
      // nodes and one of them is always hidden, which is why this is filtered
      // by :visible rather than taking .first() — the DOM-first match belongs
      // to whichever segment happens to be off.
      //
      // The row is the <a class="payment-list--link"> and it is matched on
      // data-method="VIS", the only per-brand attribute in the markup: the
      // class repeats across every method and the brand name sits in a nested
      // <p>. Note PayPal's row is a <div>, not an <a> — another reason not to
      // key on the tag.
      //
      // The <a> rather than its inner div.payment-list--text-inner: the click
      // handler is on the link, and PayPal's text wrapper even carries
      // .pointer-none, so the inner div is not reliably the click target.
      //
      // Skipped when no tile is visible: the chooser only appears when the
      // merchant has more than one method enabled, and a hard wait here would
      // fail a Visa-only configuration that lands straight on the card form.
      const cardNumberInput = page.locator("#cardNumber");

      // Every selector that has been seen to identify the Visa row, most
      // specific first. data-method is the only per-brand attribute when it is
      // present; older Lightbox templates carry the brand solely as the <p>
      // inside div.payment-list--text-inner, so that text is the fallback.
      //
      // :visible matters because the chooser renders the SAME method list
      // TWICE — once as .payment-list__column (list view) and once as
      // .payment-list__grid (grid view), toggled by a.js-switcher--input. Every
      // method therefore matches two nodes and one is always hidden, which is
      // why .first() alone would pick whichever segment happens to be off.
      //
      // The <a class="payment-list--link"> is the click target rather than its
      // inner div: the handler is on the link, and PayPal's text wrapper even
      // carries .pointer-none.
      const visaCandidates = [
        [
          "data-method",
          page.locator('a.payment-list--link[data-method="VIS"]:visible'),
        ],
        [
          "text",
          page
            .locator("a.payment-list--link:visible")
            .filter({ has: page.getByText("Visa", { exact: true }) }),
        ],
        [
          "text-loose",
          page
            .locator(".payment-list--link:visible, .payment-list__item:visible")
            .filter({ hasText: /^\s*Visa\s*$/i }),
        ],
      ];

      // waitForURL() resolves the instant the address matches, which is well
      // before the Lightbox has rendered anything — so the chooser must be
      // WAITED FOR, not probed once. Whichever screen appears first wins: a
      // merchant with a single method enabled skips the chooser entirely and
      // lands straight on the card form, so #cardNumber ends the wait too.
      let methodToClick = null;
      let matchedBy = null;
      const chooserDeadline = Date.now() + 30000;

      while (Date.now() < chooserDeadline) {
        for (const [label, locator] of visaCandidates) {
          if (
            await locator
              .first()
              .isVisible()
              .catch(() => false)
          ) {
            methodToClick = locator.first();
            matchedBy = label;
            break;
          }
        }
        if (methodToClick) break;

        // The card form rendering means there was no chooser to click.
        if (await cardNumberInput.isVisible().catch(() => false)) break;

        await page.waitForTimeout(250);
      }

      if (methodToClick) {
        console.log(`[diag] Visa row matched by: ${matchedBy}`);
        await methodToClick.scrollIntoViewIfNeeded();
        await methodToClick.click();
        console.log("✓ 'Visa' payment method clicked");
      } else if (await cardNumberInput.isVisible().catch(() => false)) {
        console.log(
          "[diag] Card form is already showing — no method chooser to click",
        );
      } else {
        // Neither screen appeared. Dumping the chooser markup here is the only
        // way to tell a renamed class from a chooser inside an iframe, so the
        // next run has something to key on instead of a bare timeout.
        const dump = await page
          .evaluate(() => {
            const rows = Array.from(
              document.querySelectorAll(
                '[class*="payment-list"], [data-method]',
              ),
            ).slice(0, 25);
            return {
              url: location.href,
              frames: Array.from(document.querySelectorAll("iframe")).map(
                (f) => f.src || "(srcdoc)",
              ),
              rows: rows.map((el) => ({
                tag: el.tagName,
                cls: el.className,
                method: el.getAttribute("data-method"),
                text: (el.textContent || "").trim().slice(0, 40),
                shown: !!el.offsetParent,
              })),
            };
          })
          .catch((err) => ({ error: String(err) }));

        console.log(
          `[diag] Neither the Visa chooser nor #cardNumber appeared within 30s.
${JSON.stringify(dump, null, 2)}`,
        );
      }

      // Each field is clicked immediately before typing into it, and typed with
      // pressSequentially rather than fill(): the card number groups itself
      // into blocks of four (maxlength=25 leaves room for the spaces) and the
      // expiry drives two hidden inputs from its own keystroke handler, neither
      // of which fill() triggers.

      // -- Card number ------------------------------------------------------
      // #cardNumber ships with an EMPTY placeholder; the visible "0000 0000
      // 0000 0000" hint comes from the matching li.form--cardicon's
      // data-placeholder, so never assert on placeholder text here.
      await cardNumberInput.waitFor({ state: "visible", timeout: 45000 });
      await cardNumberInput.click();
      await cardNumberInput.pressSequentially(CARD_NUMBER, { delay: 50 });
      console.log(
        `✓ Card number field now contains: "${await cardNumberInput.inputValue()}"`,
      );

      // The visible <li class="form--cardicon"> switches to the detected brand,
      // which is the page's own confirmation that it read the number as a Visa.
      const detectedBrand = await page
        .locator("li.form--cardicon.visible")
        .first()
        .getAttribute("data-cardname")
        .catch(() => null);
      console.log(`[state] Datatrans detected the brand as: ${detectedBrand}`);

      // -- Expiry -----------------------------------------------------------
      // #expiry has NO maxlength and an empty placeholder (the "MM/YY" hint is
      // inside an .only-ie9to11 span in the label), so nothing in the markup
      // says how wide the mask is. Only the four digits are typed.
      //
      // The real values Datatrans submits live in the two hidden inputs
      // #cardExpirationMonth / #cardExpirationYear (each maxlength=2) inside a
      // height:0 wrapper, populated by the visible field's handler — so those
      // are what get verified, not the visible text. Empty hidden inputs mean
      // the handler never fired and the payment will fail on submit.
      const expiryInput = page.locator("#expiry");
      await expiryInput.waitFor({ state: "visible", timeout: 30000 });
      await expiryInput.click();
      await expiryInput.pressSequentially(
        `${CARD_EXPIRY_MONTH}${CARD_EXPIRY_YEAR}`,
        { delay: 60 },
      );
      console.log(
        `✓ Expiry field now contains: "${await expiryInput.inputValue()}"`,
      );

      const hiddenMonth = await page
        .locator("#cardExpirationMonth")
        .inputValue()
        .catch(() => "");
      const hiddenYear = await page
        .locator("#cardExpirationYear")
        .inputValue()
        .catch(() => "");
      console.log(
        `[state] Hidden expiry inputs hold month="${hiddenMonth}" year="${hiddenYear}"`,
      );

      if (!hiddenMonth || !hiddenYear) {
        console.log(
          `⚠ Hidden expiry inputs are empty — retyping the visible field with the separator`,
        );
        await expiryInput.fill("");
        await expiryInput.click();
        await expiryInput.pressSequentially(
          `${CARD_EXPIRY_MONTH}/${CARD_EXPIRY_YEAR}`,
          { delay: 60 },
        );
        console.log(
          `[state] After retype: month="${await page
            .locator("#cardExpirationMonth")
            .inputValue()
            .catch(() => "")}" year="${await page
            .locator("#cardExpirationYear")
            .inputValue()
            .catch(() => "")}"`,
        );
      }

      // -- CVV --------------------------------------------------------------
      // data-mandatory-cvv="true", so this field cannot be skipped. Its wrapper
      // already carries hasmessage__info and renders a .message__info bubble
      // ("The security code (CVV) is usually located at the back of your
      // card.") on a perfectly valid form — that is a HINT, not an error, which
      // is why the readback below looks only at .message__error.
      const cvvInput = page.locator("#cvv");
      await cvvInput.waitFor({ state: "visible", timeout: 30000 });
      await cvvInput.click();
      await cvvInput.pressSequentially(CARD_CVV, { delay: 50 });
      console.log(`✓ CVV field now contains: "${await cvvInput.inputValue()}"`);

      console.log("✓ All card fields filled — readback values logged above");

      // -- Validation readback ----------------------------------------------
      const fieldErrors = (
        await page
          .locator(".message__error")
          .allTextContents()
          .catch(() => [])
      )
        .map((t) => t.trim())
        .filter(Boolean);

      if (fieldErrors.length > 0) {
        throw new Error(
          `Datatrans reports field errors after filling: ${JSON.stringify(
            fieldErrors,
          )}. An invalid-card message means CARD_NUMBER is outside Datatrans' ` +
            `accepted sandbox set — that constant is the first thing to change.`,
        );
      }
      console.log("✓ No field errors reported");

      // No click here on purpose: submitCardPayment() runs immediately after
      // this and owns the Pay click plus the 3DS OTP steps.
    },

    submitCardPayment: async (page) => {
      console.log("Clicking the Datatrans 'Pay' button...");

      // VERIFY THIS against the Datatrans 3DS simulator if the OTP screen
      // rejects it — nothing in #otp's markup (maxlength=10, no placeholder,
      // no hint text) names the expected value.
      const OTP = "1234";

      // -- 1. Pay ------------------------------------------------------------
      // The Pay control is an <a href="javascript:void(0)"> whose label lives
      // in nested spans and whose text swaps between Verified / Verifying / Pay
      // as .form--state divs toggle — so it is matched by its stable
      // js-form--submit hook, never by text.
      //
      // There is also a real <input type="submit" name="form--submit-real"
      // class="hidden">. That one is display:none and NOT clickable; it exists
      // for the anchor's handler to trigger, which is why the anchor is what
      // gets clicked.
      const payLink = page.locator("a.js-form--submit");
      await payLink.waitFor({ state: "visible", timeout: 30000 });
      await payLink.scrollIntoViewIfNeeded();

      const urlBeforeClick = page.url();
      await payLink.click();
      console.log("✓ Pay clicked");

      // Datatrans validates client-side and reveals .message__error rather than
      // navigating, so this catches a rejection before the OTP wait below
      // spends its full budget on a screen that will never arrive.
      await page.waitForTimeout(3000);
      const submitErrors = (
        await page
          .locator(".message__error")
          .allTextContents()
          .catch(() => [])
      )
        .map((t) => t.trim())
        .filter(Boolean);
      if (submitErrors.length > 0) {
        throw new Error(
          `Datatrans rejected the payment on submit: ${JSON.stringify(
            submitErrors,
          )}`,
        );
      }

      // -- 2. 3DS OTP screen -------------------------------------------------
      // Resolved across frames rather than assumed top-level: ACS challenge
      // pages are commonly iframed, and page.locator() only searches the main
      // frame, so it would silently never find #otp.
      const otpSelector = "#otp";
      console.log("Waiting for the 3DS OTP screen (polling all frames)...");

      // Two outcomes race here and BOTH are valid, so neither is waited for on
      // its own: a challenge 3DS shows the OTP screen, while a frictionless 3DS
      // authorises silently and redirects straight back to the shop's thank-you
      // page. Polling only for #otp would spend the whole 60s budget on a
      // challenge that is never coming; polling only for the redirect would
      // give up on the flows that do challenge.
      //
      // Leaving the Datatrans host is the frictionless signal rather than any
      // thank-you URL or text: this helper has no business knowing the shop's
      // confirmation markup, and CheckoutPage.waitForThankYouPage() — which the
      // spec calls after this — already owns that assertion.
      const DATATRANS_HOST_PREFIX = "https://pay.sandbox.datatrans.com/";

      let otpCtx = null;
      let leftDatatrans = false;
      const otpDeadline = Date.now() + 60000;

      while (Date.now() < otpDeadline && !otpCtx && !leftDatatrans) {
        for (const frame of page.frames()) {
          const count = await frame
            .locator(otpSelector)
            .count()
            .catch(() => 0);
          if (count > 0) {
            otpCtx = frame;
            const where =
              frame === page.mainFrame() ? "main frame" : frame.url();
            console.log(`✓ OTP field found in: ${where}`);
            break;
          }
        }
        if (otpCtx) break;

        // Checked AFTER the frame sweep so a challenge page that is mid-load
        // still gets one more look before the redirect check can win the race.
        if (!page.url().startsWith(DATATRANS_HOST_PREFIX)) {
          leftDatatrans = true;
          break;
        }

        await page.waitForTimeout(500);
      }

      if (!otpCtx) {
        // Non-fatal: a frictionless 3DS result skips the challenge entirely, in
        // which case the shop is already reached and the spec's own success
        // check is the authority.
        if (leftDatatrans || page.url() !== urlBeforeClick) {
          console.log(
            `⚠ No OTP screen appeared — the page moved to ${page.url()}, treating 3DS as frictionless. ` +
              `The thank-you assertion in the spec is the authority on success.`,
          );
          return;
        }
        throw new Error(
          `Datatrans OTP field (${otpSelector}) not found in any frame within 60s and the page never left ${urlBeforeClick}.\n` +
            `  Frames: ${JSON.stringify(page.frames().map((f) => f.url()))}`,
        );
      }

      // -- 3. Fill and submit the OTP ----------------------------------------
      // checkOtp() runs on keyup AND blur and is what enables #sendOtp, so the
      // value is typed key by key rather than filled — a fill() produces no
      // keyup and can leave the Pay button inert.
      const otpInput = otpCtx.locator(otpSelector);
      await otpInput.waitFor({ state: "visible", timeout: 30000 });
      await otpInput.click();
      await otpInput.fill("");
      await otpInput.pressSequentially(OTP, { delay: 80 });
      console.log(
        `✓ OTP field holds ${(await otpInput.inputValue()).length} character(s)`,
      );

      // blur so the onblur checkOtp() also fires before the click
      await otpInput.evaluate((el) => el.blur()).catch(() => {});

      const otpSubmit = otpCtx.locator("#sendOtp");
      await otpSubmit.waitFor({ state: "visible", timeout: 30000 });

      const submitDisabled = await otpSubmit.isDisabled().catch(() => false);
      console.log(`[state] #sendOtp disabled: ${submitDisabled}`);
      if (submitDisabled) {
        throw new Error(
          `Datatrans' checkOtp() left #sendOtp disabled after typing the OTP — ` +
            `the OTP constant ("${OTP}") is likely wrong for this simulator.`,
        );
      }

      await otpSubmit.scrollIntoViewIfNeeded();
      await otpSubmit.click();
      console.log("✓ Clicked 'Pay' on the OTP screen");

      // -- 4. Return to the shop ---------------------------------------------
      // Datatrans posts the 3DS result and redirects back on its own — there is
      // no return link to click. Non-fatal on timeout: the spec's success check
      // owns the verdict, and throwing here would mask a payment that did go
      // through on a slow sandbox.
      try {
        await page.waitForURL(
          (url) => !url.href.startsWith("https://pay.sandbox.datatrans.com/"),
          { timeout: 60000 },
        );
        console.log(`✓ Redirected back off Datatrans: ${page.url()}`);
      } catch {
        console.log(
          `⚠ Still on ${page.url()} 60s after the OTP submit — no redirect observed. ` +
            `If the simulator shows a further confirmation step here, this needs to click it.`,
        );
      }
    },
  },

  Paytrail: {
    fillCardDetails: async (page) => {
      console.log(
        "Opening the Paytrail method selection (full-page redirect)...",
      );

      // The path carries a per-session uuid (/pay/<uuid>), so only the prefix
      // is matched.
      await waitForUrlPrefix(page, "https://pay.paytrail.com/pay/", 60000);
      console.log(`✓ Paytrail payment page reached: ${page.url()}`);

      // Paytrail has no card form of its own — the page opens on a set of
      // tabs ("Pay now" / pay-later options), each holding a list of provider
      // buttons that POST out to the bank or card host. So there is nothing to
      // type here; this step only puts the page on the right tab.
      //
      // Matched on data-tab, not on the label: the button's text is localised
      // ("Pay now" / "Maksa heti") and its class carries a generated emotion
      // hash (css-pmphtk) that changes whenever Paytrail rebuilds its bundle.
      const payNowTab = page.locator('button[data-tab="tab-now"]');
      await payNowTab.waitFor({ state: "visible", timeout: 45000 });

      // Knockout sets disabled on the ACTIVE tab, so a disabled button here
      // means "Pay now" is already selected — clicking it would time out
      // waiting for an enabled control rather than doing nothing.
      const alreadyActive = await payNowTab.isDisabled().catch(() => false);

      if (alreadyActive) {
        console.log(
          "✓ 'Pay now' tab is already the active tab — no click needed",
        );
      } else {
        await payNowTab.scrollIntoViewIfNeeded();
        await payNowTab.click();
        console.log("✓ 'Pay now' tab clicked");
      }

      // -- 1. Open the "Card payment" accordion ------------------------------
      // Matched on the knockout binding, not on the class or the label: the
      // class is a generated emotion hash (css-pbct0) and the title is
      // localised ("Card payment" / "Korttimaksu"), while the
      // setAccordionItem.bind(this, 'creditcard') binding names the group.
      const cardAccordion = page
        .locator("button.accordion-button[data-bind*='creditcard']")
        .first();
      await cardAccordion.waitFor({ state: "visible", timeout: 45000 });
      await cardAccordion.scrollIntoViewIfNeeded();
      await cardAccordion.click();
      console.log("✓ 'Card payment' accordion opened");

      // -- 2. Pick Visa ------------------------------------------------------
      // aria-label is the only stable handle — the tile has no text, just the
      // brand logo <img>, and its class is another emotion hash.
      const visaButton = page.locator('button[aria-label="Visa"]').first();
      await visaButton.waitFor({ state: "visible", timeout: 45000 });
      await visaButton.scrollIntoViewIfNeeded();
      await visaButton.click();
      console.log("✓ Visa selected — waiting for the card form");

      // -- 3. Fill the card form ---------------------------------------------
      // Visa POSTs out to the card host, which may render the form top-level
      // or inside an iframe depending on the acquirer, so the field is located
      // by content across every frame rather than by URL.
      const CARD_NUMBER =
        process.env.PAYTRAIL_TEST_CARD_NUMBER || "4111111111111111";
      const EXPIRY = process.env.PAYTRAIL_TEST_CARD_EXPIRY || "1130";
      const CVV = process.env.PAYTRAIL_TEST_CARD_CVV || "111";

      console.log(`Using fixed test card ending in ${CARD_NUMBER.slice(-4)}`);

      const numberInput = await waitForFieldInAnyFrame(
        page,
        (frame) => frame.locator("#cardNumber, input.cc-num"),
        "Card number",
        60000,
      );
      await numberInput.click();
      // pressSequentially, not fill(): the form reformats on keystroke
      // (name="card_number_formatted"), and a single fill() lands as one input
      // event that the formatter drops.
      await numberInput.pressSequentially(CARD_NUMBER, { delay: 60 });
      console.log("✓ Card number entered");

      const typeField = async (selector, label, value) => {
        const input = await waitForFieldInAnyFrame(
          page,
          (frame) => frame.locator(selector),
          label,
          30000,
        );
        await input.click();
        await input.pressSequentially(value, { delay: 60 });
        console.log(`✓ ${label} entered`);
      };

      // Single combined MM/YY field — the slash is inserted by the formatter,
      // so only the four digits are typed.
      await typeField("#expiry, input.cc-exp", "Expiry", EXPIRY);
      await typeField("#cvv, input.cc-cvc", "Security code", CVV);
    },

    submitCardPayment: async (page) => {
      console.log("Submitting the Paytrail payment...");

      // The card host's submit button carries no id — it is the form's only
      // submit, and its label ("Pay") sits in a <span> that the loader markup
      // shares the button with.
      const payButton = await waitForFieldInAnyFrame(
        page,
        (frame) => frame.locator('button[type="submit"].btn-primary'),
        "Pay button",
        45000,
      );

      await payButton.scrollIntoViewIfNeeded();
      await payButton.click();
      console.log("✓ Clicked 'Pay' on the card form");

      // -- 3DS challenge -----------------------------------------------------
      // The sandbox ACS asks for a static code on #code (an <input
      // type="password"> whose onkeypress hooks submitEnter()). It is served in
      // its own frame, so the field is located across all of them.
      const codeInput = await waitForFieldInAnyFrame(
        page,
        (frame) => frame.locator("#code"),
        "3DS code",
        45000,
      ).catch(() => null);

      if (!codeInput) {
        console.log(
          "No 3DS code screen appeared — treating the payment as frictionless",
        );
      } else {
        const THREE_DS_CODE = process.env.PAYTRAIL_TEST_3DS_CODE || "1234";

        await codeInput.click();
        // pressSequentially so the onkeypress handler sees each key; fill()
        // would land as one input event.
        await codeInput.pressSequentially(THREE_DS_CODE, { delay: 80 });
        console.log("✓ 3DS code entered");

        const acsSubmit = await waitForFieldInAnyFrame(
          page,
          (frame) =>
            frame.locator('input.submit[type="submit"][name="submit"]'),
          "3DS submit button",
          30000,
        );

        await acsSubmit.click();
        console.log("✓ Submitted the 3DS code");
      }

      // The card host redirects back to Paytrail, which redirects on to the
      // shop's return URL. Non-fatal on timeout: the spec's success check owns
      // the verdict, and throwing here would mask a payment that did go
      // through on a slow sandbox.
      const urlBeforeReturn = page.url();

      try {
        await page.waitForURL((url) => url.href !== urlBeforeReturn, {
          timeout: 60000,
        });
        console.log(`✓ Left the card/3DS flow: ${page.url()}`);
      } catch {
        console.log(
          `⚠ Still on ${page.url()} 60s after the submit — no redirect observed.`,
        );
      }
    },
  },

  Finix: {
    // Finix Tokenization Forms: no redirect. Every field is its own iframe from
    // js.finix.com/v/1/payment-fields/index.html, and all of them share that
    // same src — the per-field config (which field it is, its placeholder) is
    // base64 in the query string, so the URL can't tell them apart. The
    // wrapper div's id on the host page (#number, #security_code, …) is the
    // only stable handle, hence frameLocator("#<id> iframe") throughout.
    async fillCardDetails(page, card = {}) {
      const CARD_NUMBER =
        process.env.FINIX_TEST_CARD_NUMBER || "4111111111111111";
      const CVC = process.env.FINIX_TEST_CARD_CVC || "123";

      // House convention: month 02, year = current year + 3. Finix inserts the
      // " / " itself, so only the four digits are typed.
      const expiryMonth = "02";
      const expiryYearShort = String(new Date().getFullYear() + 3).slice(-2);
      const EXPIRY = `${expiryMonth}${expiryYearShort}`;

      const cardholderName = card.name || "Token Tutorial";

      console.log(
        `[Finix] Using fixed test card ending in ${CARD_NUMBER.slice(-4)}`,
      );

      // ---- Resolve the context holding the outer Finix form ----
      // Same as Braintree: #finix-payment-form may sit on the main page or
      // inside a gateway iframe, so search the main frame and all children.
      let formContext = null;
      const formDeadline = Date.now() + 90000;
      while (Date.now() < formDeadline) {
        for (const frame of page.frames()) {
          const hasForm = await frame
            .locator("#finix-payment-form")
            .count()
            .then((c) => c > 0)
            .catch(() => false);
          if (hasForm) {
            formContext = frame;
            break;
          }
        }
        if (formContext) break;
        await page.waitForTimeout(500);
      }

      if (!formContext) {
        throw new Error(
          `[Finix] #finix-payment-form never appeared. Frames present: ${JSON.stringify(
            page.frames().map((f) => f.url()),
          )}`,
        );
      }

      console.log(
        `[Finix] Form found in: ${
          formContext === page.mainFrame() ? "main frame" : formContext.url()
        }`,
      );

      await formContext
        .locator("#finix-card-form")
        .waitFor({ state: "visible", timeout: 30000 });

      // ---- Let the form settle before touching it ----
      // #finix-card-form being visible only means the HOST markup is painted.
      // Every field is a separate iframe loaded from js.finix.com, and each one
      // mounts its own input and placeholder overlay after that. Typing into a
      // field whose frame hasn't finished wiring up drops the keystrokes
      // silently — the field just stays blank. Especially so straight after
      // Place Order, where the whole form is built in response to the click.
      const settleMs = Number(process.env.FINIX_FORM_SETTLE_MS || 5000);
      console.log(
        `[Finix] Form is up — waiting ${settleMs}ms for its field iframes to finish mounting...`,
      );
      await page.waitForTimeout(settleMs);

      /**
       * Clicks the field's placeholder, then types.
       *
       * The click is deliberate and lands on the WRAPPER div on the host page,
       * not on anything inside the frame. Each field renders as a placeholder
       * overlay ("hideOnFocus": true in the frame's config) sitting on top of
       * the real input, and it is the placeholder that receives the pointer
       * event and hands focus to the input — going straight for the inner
       * input skips that handoff, and Finix leaves the placeholder painted
       * over the text that follows. Clicking the wrapper also sidesteps having
       * to guess the frame's internal markup, which is unversioned bundle
       * output.
       *
       * pressSequentially, never fill(): Finix reformats on every keystroke
       * (grouping spaces on the number, the " / " on the expiry) and a single
       * fill() arrives as one input event the formatter drops.
       */
      const clickPlaceholderAndType = async (
        fieldId,
        label,
        value,
        { extraClick = false } = {},
      ) => {
        // Scoped to #finix-payment-form, not a bare `#${fieldId}`. Finix names
        // its wrappers after the raw field ("name", "number", "city",
        // "address_line1"), which are generic enough to collide with the host
        // page's own markup — and on the WooCommerce checkout the form sits in
        // the MAIN frame alongside the whole checkout, so a bare "#name" is
        // matched against every element on the page. A second match makes this
        // a strict-mode violation on the click; a wrong single match types the
        // cardholder name into some unrelated input.
        const wrapper = formContext
          .locator(`#finix-payment-form #${fieldId}`)
          .first();

        await wrapper.waitFor({ state: "visible", timeout: 45000 });
        await wrapper.scrollIntoViewIfNeeded();

        console.log(`[Finix] Clicking the "${label}" placeholder...`);
        await wrapper.click();

        if (extraClick) {
          // A second click, used on the FIRST field touched (Name). That first
          // click lands while Finix is still wiring up its iframes, so it
          // dismisses the placeholder without focus reaching the inner input —
          // the keystrokes then go nowhere and the field stays blank while
          // every field after it fills correctly. By now the form has had a
          // real interaction, so this click does hand over focus.
          await page.waitForTimeout(1000);
          console.log(`[Finix] Clicking "${label}" again before typing...`);
          await wrapper.click();
          await page.waitForTimeout(500);
        }

        console.log(`[Finix] Typing ${label}: ${value}`);
        // Keyboard, not locator.type(): focus is now inside the field's iframe
        // and the keystrokes follow it there.
        await page.keyboard.type(value, { delay: 60 });

        // Best-effort read-back. The frame is same-origin-ish enough for
        // Playwright to reach into, but the inner input carries no stable
        // selector, so a miss here is logged rather than thrown — the real
        // verdict is Finix enabling the submit button.
        const inner = formContext
          .frameLocator(`#finix-payment-form #${fieldId} iframe`)
          .locator("input")
          .first();
        const actual = await inner.inputValue().catch(() => null);
        if (actual === null) {
          console.log(`[Finix] "${label}" entered (value not readable back)`);
        } else {
          console.log(`[Finix] "${label}" now reads: "${actual}"`);
        }

        // Readable AND empty is the one case worth acting on: the field exists,
        // Playwright can see into it, and nothing landed — so the click didn't
        // hand over focus and the keystrokes went nowhere. Retry once here
        // rather than carrying on and failing later at a submit button Finix
        // keeps disabled, which says nothing about which field was missed.
        if (actual === "" && value) {
          console.log(`[Finix] "${label}" came back empty — retrying once...`);

          await wrapper.click();
          await page.waitForTimeout(500);
          await page.keyboard.type(value, { delay: 60 });

          const retried = await inner.inputValue().catch(() => null);
          console.log(
            `[Finix] "${label}" after the retry reads: "${retried ?? "(not readable)"}"`,
          );
        }
      };

      /**
       * The two dropdown fields ("options": "state" / "country" in the frame
       * config) render a native <select>. A click there opens the OS-level
       * popup, which Playwright can't drive — so these are the one exception
       * to the click-the-placeholder rule: selectOption goes straight at the
       * element. Candidates are tried in order because Finix's option values
       * differ per list (two-letter code for states, "USA" for country).
       */
      const chooseOption = async (fieldId, label, candidates) => {
        // Scoped for the same reason as clickPlaceholderAndType above.
        const wrapper = formContext
          .locator(`#finix-payment-form #${fieldId}`)
          .first();

        const select = formContext
          .frameLocator(`#finix-payment-form #${fieldId} iframe`)
          .locator("select")
          .first();

        await wrapper.scrollIntoViewIfNeeded();

        for (const candidate of candidates) {
          const picked = await select
            .selectOption(candidate, { timeout: 10000 })
            .then(() => true)
            .catch(() => false);

          if (picked) {
            console.log(
              `[Finix] "${label}" set to ${JSON.stringify(candidate)}`,
            );
            return;
          }
        }

        throw new Error(
          `[Finix] None of ${JSON.stringify(candidates)} matched an option in "${label}".`,
        );
      };

      // extraClick: Name is the first field touched, and that first click is
      // the one that gets absorbed without handing over focus — see the helper.
      await clickPlaceholderAndType("name", "Name", cardholderName, {
        extraClick: true,
      });

      // Number first so Finix can detect the brand and size the CVC field.
      await clickPlaceholderAndType("number", "Card Number", CARD_NUMBER);
      await clickPlaceholderAndType("expiration_date", "Expiration", EXPIRY);
      console.log(`[Finix] Expiry set to ${expiryMonth}/${expiryYearShort}.`);
      await clickPlaceholderAndType("security_code", "CVC", CVC);

      // ---- Billing address ----
      // All of line1, city, ZIP and state carry "errorMessage" in their config,
      // i.e. Finix treats them as required and keeps the submit button disabled
      // until they're filled. Line 2 is optional in practice but declares an
      // error message too, so it's filled as well.
      await clickPlaceholderAndType(
        "address_line1",
        "Address Line 1",
        "123 Test Street",
      );
      await clickPlaceholderAndType("address_line2", "Address Line 2", "Apt 4");
      await clickPlaceholderAndType("address_city", "City", "San Francisco");

      // #address_region is the free-text variant and is display:none whenever
      // the country has a state list; #address_state is the <select> shown in
      // its place. Only the visible one is touched.
      const stateVisible = await formContext
        .locator("#address_state")
        .isVisible()
        .catch(() => false);

      if (stateVisible) {
        await chooseOption("address_state", "State", ["CA", "California"]);
      } else {
        await clickPlaceholderAndType("address_region", "Region", "CA");
      }

      await clickPlaceholderAndType("address_postal_code", "ZIP", "94105");

      // Country already defaults to USA ("defaultOption": "USA"), so this only
      // re-asserts it — cheap, and it keeps the field from being the reason a
      // rebuild with a different default fails validation.
      await chooseOption("address_country", "Country", [
        "USA",
        "US",
        "United States",
      ]);

      // ---- Confirm Finix considers the form valid ----
      // The per-field <span class="…_validation"> elements carry Finix's own
      // error text, and the submit button stays disabled while any is set.
      const submitEnabled = await formContext
        .locator("#finix-submit-button:not([disabled])")
        .waitFor({ state: "visible", timeout: 20000 })
        .then(() => true)
        .catch(() => false);

      if (!submitEnabled) {
        const messages = await formContext
          .locator("#finix-card-form span.validation")
          .allTextContents()
          .catch(() => []);
        const errors = messages.map((m) => m.trim()).filter(Boolean);

        throw new Error(
          `[Finix] Pay Now is still disabled after filling the form.${
            errors.length ? ` Validation errors: ${errors.join("; ")}` : ""
          }`,
        );
      }

      console.log("[Finix] All fields filled and validated. Ready to submit.");
    },

    async submitCardPayment(page) {
      console.log("[Finix] Submitting the Finix payment...");

      // Re-resolve the form context — the handle does not carry across calls.
      let formContext = null;
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline) {
        for (const frame of page.frames()) {
          const hasForm = await frame
            .locator("#finix-payment-form")
            .count()
            .then((c) => c > 0)
            .catch(() => false);
          if (hasForm) {
            formContext = frame;
            break;
          }
        }
        if (formContext) break;
        await page.waitForTimeout(500);
      }

      if (!formContext) {
        throw new Error(
          "[Finix] #finix-payment-form not found when attempting to submit.",
        );
      }

      const payButton = formContext
        .locator("#finix-submit-button:not([disabled])")
        .first();

      await payButton.waitFor({ state: "visible", timeout: 30000 });
      await payButton.scrollIntoViewIfNeeded();

      const startUrl = page.url();
      console.log(`[Finix] URL before submit: ${startUrl}`);

      await payButton.click();
      console.log("[Finix] Clicked 'Pay Now'");

      // Tokenisation happens in the browser before the charge, so the first
      // sign of success is the form going away or the page navigating.
      // Non-fatal on timeout: the spec's success check owns the verdict, and
      // throwing here would mask a payment that did go through on a slow
      // sandbox.
      const settled = await Promise.race([
        page
          .waitForURL((url) => url.href !== startUrl, { timeout: 60000 })
          .then(() => "navigated")
          .catch(() => null),
        formContext
          .locator("#finix-payment-form")
          .waitFor({ state: "detached", timeout: 60000 })
          .then(() => "form detached")
          .catch(() => null),
      ]);

      if (settled) {
        console.log(`[Finix] Payment submitted (${settled}): ${page.url()}`);
      } else {
        const error = await formContext
          .locator("#finix-error-container")
          .textContent()
          .catch(() => "");

        console.log(
          `⚠ [Finix] Still on ${page.url()} 60s after the submit — no redirect observed.${
            error && error.trim() ? ` Error shown: ${error.trim()}` : ""
          }`,
        );
      }

      await page.waitForLoadState("domcontentloaded").catch(() => {});
      console.log(`[Finix] Post-payment URL: ${page.url()}`);
    },
  },

  //11th

  SSLCommerz: {
    // Full-page redirect to SSLCommerz EasyCheckout — an Angular app, so every
    // class carries an _ngcontent-cNN / ng-tns-cNN attribute that is rebuilt on
    // every release. Nothing below is matched on those, nor on the ng-* state
    // classes (ng-pristine/ng-touched change as the form is used).
    //
    // The card pane is the default tab, with the Visa/Mastercard/Amex logos
    // already active, so there's no tab to click before filling.
    fillCardDetails: async (page) => {
      console.log("Opening the SSLCommerz EasyCheckout page (redirect)...");

      // The path carries a per-session token
      // (/EasyCheckOut/testcdeb86ccc…), so only the prefix is matched.
      await waitForUrlPrefix(
        page,
        "https://sandbox.sslcommerz.com/EasyCheckOut/",
        60000,
      );
      console.log(`✓ SSLCommerz checkout reached: ${page.url()}`);

      const CARD_NUMBER =
        process.env.SSLCOMMERZ_TEST_CARD_NUMBER || "4111111111111111";
      const CVV = process.env.SSLCOMMERZ_TEST_CARD_CVV || "111";
      const CARD_NAME =
        process.env.SSLCOMMERZ_TEST_CARD_NAME || "Test Customer";

      // House convention: month 12, year = current year + 3. Cleave.js inserts
      // the "/" itself (placeholder reads MM/YY), so only four digits are typed.
      const EXPIRY =
        process.env.SSLCOMMERZ_TEST_CARD_EXPIRY ||
        `12${String(new Date().getFullYear() + 3).slice(-2)}`;

      console.log(
        `[SSLCommerz] Using test card ending in ${CARD_NUMBER.slice(-4)}, expiry ${EXPIRY.slice(0, 2)}/${EXPIRY.slice(2)}`,
      );

      /**
       * Every field here carries appcleavejs, i.e. Cleave.js reformats the
       * value on each keystroke (grouping spaces on the number, the "/" on the
       * expiry). pressSequentially, never fill(): a fill() arrives as a single
       * input event that the formatter drops, leaving the field empty or
       * half-written.
       *
       * Located across frames rather than on the page directly — the card pane
       * is top-level today, but SSLCommerz also embeds EasyCheckout in an
       * iframe on some integrations, and this costs nothing either way.
       */
      const typeField = async (buildLocator, label, value) => {
        const input = await waitForFieldInAnyFrame(
          page,
          buildLocator,
          label,
          60000,
        );

        await input.scrollIntoViewIfNeeded().catch(() => {});
        await input.click();
        await input.pressSequentially(value, { delay: 60 });

        console.log(`✓ ${label} entered`);
      };

      // Number first so the form can detect the brand and size the CVC field.
      await typeField(
        // #ccnum is the id, but [card-number] is the directive SSLCommerz's own
        // code binds to and is the more durable of the two — either resolves.
        (frame) => frame.locator("#ccnum, input[name='number'][card-number]"),
        "Card number",
        CARD_NUMBER,
      );

      await typeField(
        (frame) => frame.locator("#expiry, input[name='expiry'][card-expiry]"),
        "Expiry",
        EXPIRY,
      );

      // NOT matched on its id. The CVC input's id is literally "email"
      // (<input card-cvc id="email" name="cvc" type="password" maxlength="4">)
      // — an upstream copy-paste slip in SSLCommerz's template. Using it would
      // read as a bug here and would break the moment they fix theirs, so the
      // name and the card-cvc directive are used instead.
      await typeField(
        (frame) => frame.locator("input[name='cvc'][card-cvc]"),
        "CVC",
        CVV,
      );

      // The cardholder-name input has no id at all, so name + the card-name
      // directive is the only handle.
      await typeField(
        (frame) => frame.locator("input[name='name'][card-name]"),
        "Card holder name",
        CARD_NAME,
      );

      // "Save card & remember me" ships disabled on sandbox, so it's left
      // alone — checking it isn't possible and isn't needed to pay.
      console.log("✓ SSLCommerz card form filled");
    },

    submitCardPayment: async (page) => {
      console.log("[SSLCommerz] Submitting the payment...");

      // <button class="loading-btn js_success-animation-trigger
      // btn_full_width_active"><span class="loading-btn__text"> Pay 3,300 BDT
      // </span></button>
      //
      // Filtered on "Pay" as well as the class: EasyCheckout renders a
      // loading-btn per payment pane (cards, mobile banking, net banking), and
      // the others are in hidden tabs — so the class alone can resolve to a
      // button that isn't the one on screen. The amount is deliberately not
      // matched, since it changes with the cart and the currency.
      const payButton = await waitForFieldInAnyFrame(
        page,
        (frame) =>
          frame.locator("button.loading-btn").filter({ hasText: /pay/i }),
        "Pay button",
        45000,
      );

      const startUrl = page.url();
      console.log(`[SSLCommerz] URL before submit: ${startUrl}`);

      await payButton.scrollIntoViewIfNeeded().catch(() => {});
      await payButton.click();
      console.log("[SSLCommerz] Pay clicked");

      // The button runs a success animation before navigating, so the redirect
      // lands a beat after the click.
      await page
        .waitForURL((url) => url.href !== startUrl, { timeout: 60000 })
        .catch(() => {
          console.log(
            `⚠ [SSLCommerz] Still on ${page.url()} 60s after the submit — no redirect observed.`,
          );
        });

      await page.waitForLoadState("domcontentloaded").catch(() => {});
      console.log(`[SSLCommerz] After Pay, landed on: ${page.url()}`);

      // ---- Sandbox 3DS simulator ----
      // Sandbox doesn't authorise straight away: it interposes a stand-in for
      // the issuer's 3DS step — a single <input name="pan"> and a row of submit
      // buttons whose value attributes ARE their labels (Success / Failure /
      // Cancel). Picking "Success" is what makes this a passing payment; the
      // other two are how you'd exercise a decline.
      //
      // Conditional, and this is the one branch that isn't a failure when it
      // misses: live SSLCommerz hands off to the real issuer (or, for a
      // non-enrolled card, authorises with no interstitial at all), so a run
      // against anything but sandbox goes straight to the merchant return URL.
      const simulatorInput = await waitForFieldInAnyFrame(
        page,
        (frame) => frame.locator("input[name='pan']"),
        "sandbox 3DS simulator field",
        20000,
      ).catch(() => null);

      if (!simulatorInput) {
        console.log(
          `ℓ [SSLCommerz] No 3DS simulator page (no input[name="pan"]) — the payment either ` +
            `authorised without one or has already returned to the site. Currently on ${page.url()}.`,
        );
        return;
      }

      // Plain fill(), unlike the card form: this field has no Cleave.js
      // formatter on it, so one input event is fine.
      const OTP = process.env.SSLCOMMERZ_TEST_OTP || "111111";
      await simulatorInput.fill(OTP);
      console.log(`✓ [SSLCommerz] Simulator field filled with "${OTP}"`);

      // Matched on the value attribute, which is both the button's label and
      // the only thing distinguishing it from the Failure/Cancel submits beside
      // it — they share the type and carry no class or id.
      const successButton = await waitForFieldInAnyFrame(
        page,
        (frame) => frame.locator("input[type='submit'][value='Success']"),
        "simulator Success button",
        20000,
      );

      const simulatorUrl = page.url();

      await successButton.scrollIntoViewIfNeeded().catch(() => {});
      await successButton.click();
      console.log('✓ [SSLCommerz] "Success" clicked on the 3DS simulator');

      await page
        .waitForURL((url) => url.href !== simulatorUrl, { timeout: 60000 })
        .catch(() => {
          console.log(
            `⚠ [SSLCommerz] Still on ${page.url()} 60s after clicking Success — no redirect observed.`,
          );
        });

      await page.waitForLoadState("domcontentloaded").catch(() => {});
      console.log(`[SSLCommerz] Post-payment URL: ${page.url()}`);
    },
  },

  CostPlus: {
    // Full-page redirect to Cost+'s hosted checkout, which runs on the Ginger
    // platform (the asset paths give it away: /assets/ginger/img/...). Two
    // steps before there's anything to type: the method list, then the card
    // form it reveals.
    fillCardDetails: async (page) => {
      console.log("Opening the Cost+ hosted checkout (redirect)...");

      // The path carries a per-session uuid
      // (/pay/b60c60cf-…/select-payment-method/), so only the prefix is matched.
      await waitForUrlPrefix(page, "https://api.costplus.online/pay/", 60000);
      console.log(`✓ Cost+ payment page reached: ${page.url()}`);

      // ---- 1. Pick "Credit/debit card" from the method list ----
      // Every method on the list is an h4.regular-title, so the class alone
      // isn't enough — it's filtered on the text. Matched loosely
      // (credit.*card) rather than on the exact string: the separator varies
      // between "Credit/debit card", "Credit / debit card" and
      // "Credit and debit card" across Ginger builds and locales.
      const cardMethod = await waitForFieldInAnyFrame(
        page,
        (frame) =>
          frame
            .locator("h4.regular-title")
            .filter({ hasText: /credit.*card/i }),
        '"Credit/debit card" method',
        60000,
      );

      await cardMethod.scrollIntoViewIfNeeded().catch(() => {});
      await cardMethod.click();
      console.log('✓ "Credit/debit card" selected');

      const CARD_NUMBER =
        process.env.COSTPLUS_TEST_CARD_NUMBER || "4111111111111111";
      const CVC = process.env.COSTPLUS_TEST_CARD_CVC || "123";
      const CARD_NAME = process.env.COSTPLUS_TEST_CARD_NAME || "Test Customer";

      console.log(`[Cost+] Using test card ending in ${CARD_NUMBER.slice(-4)}`);

      // ---- 2. Cardholder name ----
      // Filled before the number: this field is the tell that the card form
      // has actually been revealed by the click above.
      const nameInput = await waitForFieldInAnyFrame(
        page,
        (frame) => frame.locator("#cardholder_name"),
        "Cardholder name",
        45000,
      );
      await nameInput.click();
      await nameInput.fill(CARD_NAME);
      console.log("✓ Cardholder name entered");

      // ---- 3. Card number ----
      // pressSequentially, not fill(): pattern="[\s\d]*" means the field
      // reformats into space-separated groups as you type, and a single fill()
      // lands as one input event the formatter drops.
      const numberInput = await waitForFieldInAnyFrame(
        page,
        (frame) => frame.locator("#pan"),
        "Card number",
        45000,
      );
      await numberInput.click();
      await numberInput.pressSequentially(CARD_NUMBER, { delay: 60 });
      console.log("✓ Card number entered");

      // ---- 4. Expiry — two native <select>s, not a typed field ----
      // Month is a fixed 01–12 list. Year is generated per session (2026–2035
      // today), so the wanted year is checked against the options actually
      // rendered and the last one is used if it has rolled out of range —
      // otherwise this entry would start failing on its own a few years on.
      const monthSelect = await waitForFieldInAnyFrame(
        page,
        (frame) => frame.locator("#expiry_month"),
        "Expiry month",
        30000,
      );
      const yearSelect = await waitForFieldInAnyFrame(
        page,
        (frame) => frame.locator("#expiry_year"),
        "Expiry year",
        30000,
      );

      const EXPIRY_MONTH = process.env.COSTPLUS_TEST_CARD_EXP_MONTH || "12";
      await monthSelect.selectOption(EXPIRY_MONTH);

      const years = await yearSelect.evaluate((el) =>
        Array.from(el.options).map((o) => o.value),
      );

      const wantedYear =
        process.env.COSTPLUS_TEST_CARD_EXP_YEAR ||
        String(new Date().getFullYear() + 3);

      const year = years.includes(wantedYear)
        ? wantedYear
        : years[years.length - 1];

      if (year !== wantedYear) {
        console.log(
          `ℓ [Cost+] ${wantedYear} isn't in the expiry-year list (${years.join(", ")}) — using ${year}.`,
        );
      }

      await yearSelect.selectOption(year);
      console.log(`✓ Expiry set to ${EXPIRY_MONTH}/${year}`);

      // ---- 5. CVC ----
      // #cvc, not the "Where can I find my CVC code?" span beside it — that
      // one opens a help modal that would sit over the submit button.
      const cvcInput = await waitForFieldInAnyFrame(
        page,
        (frame) => frame.locator("#cvc"),
        "CVC",
        30000,
      );
      await cvcInput.click();
      await cvcInput.pressSequentially(CVC, { delay: 60 });
      console.log("✓ CVC entered");

      console.log("✓ Cost+ card form filled");
    },

    submitCardPayment: async (page) => {
      console.log("[Cost+] Submitting the payment...");

      // #card-payment-submit — an id, so no text matching needed. Note it sits
      // OUTSIDE <form id="payment-form"> and is wired to it via form=
      // "payment-form", which is why it's located on its own rather than as a
      // descendant of the form.
      const payButton = await waitForFieldInAnyFrame(
        page,
        (frame) => frame.locator("#card-payment-submit"),
        "Pay button",
        45000,
      );

      const startUrl = page.url();
      console.log(`[Cost+] URL before submit: ${startUrl}`);

      await payButton.scrollIntoViewIfNeeded().catch(() => {});
      await payButton.click();
      console.log("[Cost+] Pay clicked");

      await page
        .waitForURL((url) => url.href !== startUrl, { timeout: 60000 })
        .catch(() => {
          console.log(
            `⚠ [Cost+] Still on ${page.url()} 60s after the submit — no redirect observed.`,
          );
        });

      await page.waitForLoadState("domcontentloaded").catch(() => {});
      console.log(`[Cost+] After Pay, landed on: ${page.url()}`);

      // ---- 3DS challenge ----
      // Ginger hands off to the issuer's ACS, which asks for a 6-digit code
      // and has its own Continue button.
      //
      // Located by data-testid throughout. The classes on these elements are
      // styled-components hashes (sc-hZDyAQ, sc-fqkvVR, LglmD, …) regenerated
      // on every build of theirs, so matching them would break on any release;
      // the button also has EIGHT of them and no stable one among them. The
      // visible text "Continue" is translatable, and it sits in a nested
      // <span>, so data-testid is the only durable handle here.
      //
      // Conditional: a frictionless (non-challenged) authentication skips
      // straight back to the merchant, so a missing challenge is a pass, not a
      // failure. The ACS is usually iframed, hence the all-frames scan.
      const challengeInput = await waitForFieldInAnyFrame(
        page,
        (frame) =>
          frame.locator(
            "[data-testid='3ds-code-input'], input[name='3ds-code']",
          ),
        "3DS challenge code field",
        30000,
      ).catch(() => null);

      if (!challengeInput) {
        console.log(
          `ℓ [Cost+] No 3DS challenge (no 3ds-code field) — the payment either authenticated ` +
            `frictionlessly or has already returned to the site. Currently on ${page.url()}.`,
        );
        return;
      }

      const CHALLENGE_CODE = process.env.COSTPLUS_TEST_3DS_CODE || "123456";

      await challengeInput.scrollIntoViewIfNeeded().catch(() => {});
      await challengeInput.click();
      // pressSequentially: the field is maxlength=6 and validates as it fills,
      // and the Continue button typically stays disabled until it's complete.
      await challengeInput.pressSequentially(CHALLENGE_CODE, { delay: 80 });
      console.log(`✓ [Cost+] 3DS code entered ("${CHALLENGE_CODE}")`);

      const continueButton = await waitForFieldInAnyFrame(
        page,
        (frame) => frame.locator("[data-testid='place_order_button']"),
        "3DS Continue button",
        30000,
      );

      const challengeUrl = page.url();

      await continueButton.scrollIntoViewIfNeeded().catch(() => {});
      await continueButton.click();
      console.log('✓ [Cost+] "Continue" clicked on the 3DS challenge');

      await page
        .waitForURL((url) => url.href !== challengeUrl, { timeout: 60000 })
        .catch(() => {
          console.log(
            `⚠ [Cost+] Still on ${page.url()} 60s after Continue — no redirect observed.`,
          );
        });

      await page.waitForLoadState("domcontentloaded").catch(() => {});
      console.log(`[Cost+] Post-payment URL: ${page.url()}`);
    },
  },

  BlueSnap: {
    // NOT a redirect. BlueSnap's Hosted Payment Fields render in place on the
    // WTE checkout page (…/checkout-2/?wte_id=…) after Confirm Booking, so
    // there's no URL to wait for — the card-number field appearing IS the
    // signal that the form has mounted.
    //
    // Everything is located by id. The classes here are MUI/JSS generated
    // names — root-74, input-186, detailInputLine-75, PayButton-249 — whose
    // numeric suffixes are assigned at runtime in stylesheet order, so they
    // change whenever the widget is rebuilt OR another component mounts first.
    // The ids (CC-name, CC-cardNumber, …) are BlueSnap's own and are stable.
    fillCardDetails: async (page) => {
      console.log("Waiting for the BlueSnap card form to mount...");

      const CARD_NUMBER =
        process.env.BLUESNAP_TEST_CARD_NUMBER || "5425233430109903";
      const CVV = process.env.BLUESNAP_TEST_CARD_CVV || "837";

      // 04/29 exactly, per the sandbox card BlueSnap issues — NOT the
      // month-12/year+3 convention the other gateways here compute, and
      // deliberately not derived from the current date: BlueSnap's test card is
      // tied to this specific expiry and a computed one gets declined.
      //
      // maxlength=7 on the field, i.e. "MM / YY" once BlueSnap has inserted the
      // separator itself — so only the four digits are typed.
      const EXPIRY = process.env.BLUESNAP_TEST_CARD_EXPIRY || "0429";

      console.log(
        `[BlueSnap] Using test card ending in ${CARD_NUMBER.slice(-4)}, expiry ${EXPIRY.slice(0, 2)}/${EXPIRY.slice(2)}`,
      );

      // The card-number field is the anchor: it's the last of the three card
      // inputs to become interactive, and finding it also resolves which frame
      // the form is in (in place today, but BlueSnap iframes these fields on
      // other integrations).
      const numberInput = await waitForFieldInAnyFrame(
        page,
        (frame) => frame.locator("#CC-cardNumber"),
        "BlueSnap card number",
        90000,
      );

      /**
       * Name and email arrive PRE-FILLED from the WTE booking (the run saw
       * value="Traveler1788861074071 Test1788861074071" /
       * "traveler…@example.com"), so they're only written when actually empty.
       * Overwriting them would replace the traveller details the booking was
       * made with, which is worth keeping consistent between the order and the
       * payment.
       */
      const fillIfEmpty = async (selector, label, value) => {
        const input = page.locator(selector).first();

        if (!(await input.count())) {
          console.log(`ℓ [BlueSnap] No ${label} field (${selector}) — skipped`);
          return;
        }

        const current = (await input.inputValue().catch(() => "")).trim();

        if (current) {
          console.log(`✓ [BlueSnap] ${label} already filled: "${current}"`);
          return;
        }

        await input.click();
        await input.fill(value);
        console.log(`✓ [BlueSnap] ${label} filled: ${value}`);
      };

      await fillIfEmpty("#CC-name", "Name on card", "Test Customer");
      await fillIfEmpty("#CC-email", "Email", "customer@example.com");

      // pressSequentially throughout: these are type="tel" fields that reformat
      // on each keystroke (groups on the number, " / " on the expiry), and a
      // single fill() lands as one input event the formatter drops.
      await numberInput.scrollIntoViewIfNeeded().catch(() => {});
      await numberInput.click();
      await numberInput.pressSequentially(CARD_NUMBER, { delay: 60 });
      console.log("✓ [BlueSnap] Card number entered");

      const typeField = async (selector, label, value) => {
        const input = await waitForFieldInAnyFrame(
          page,
          (frame) => frame.locator(selector),
          label,
          30000,
        );

        await input.scrollIntoViewIfNeeded().catch(() => {});
        await input.click();
        await input.pressSequentially(value, { delay: 60 });
        console.log(`✓ [BlueSnap] ${label} entered`);
      };

      await typeField("#CC-expirationDate", "Expiry", EXPIRY);
      await typeField("#CC-securityCode", "CVV", CVV);

      // Country is deliberately left as it comes (the run saw "Nepal", derived
      // from the booking's billing country). It's a MUI Autocomplete whose
      // input id is GENERATED — id="mui-85492" — so it can't be targeted by id
      // at all; #CountrySelector is the stable wrapper if it ever needs setting.
      // Not touched here because BlueSnap accepts the sandbox card regardless
      // of billing country, and changing it would diverge from the booking.
      console.log("✓ [BlueSnap] Card form filled");
    },

    submitCardPayment: async (page) => {
      console.log("[BlueSnap] Submitting the payment...");

      // #pay-button — an id, so none of the eight hashed classes on it matter.
      // The visible label is a bare "Pay" inside two nested spans, which would
      // be a poor handle even before translation.
      const payButton = await waitForFieldInAnyFrame(
        page,
        (frame) => frame.locator("#pay-button"),
        "BlueSnap Pay button",
        45000,
      );

      const startUrl = page.url();
      console.log(`[BlueSnap] URL before submit: ${startUrl}`);

      await payButton.scrollIntoViewIfNeeded().catch(() => {});
      await payButton.click();
      console.log("[BlueSnap] Pay clicked");

      // The button shows its own spinner while tokenising, then WTE completes
      // the booking server-side and redirects — so the navigation is a couple
      // of round trips after the click, not immediate.
      await page
        .waitForURL((url) => url.href !== startUrl, { timeout: 60000 })
        .catch(() => {
          console.log(
            `⚠ [BlueSnap] Still on ${page.url()} 60s after the submit — no redirect observed. ` +
              `If the form rejected a field it stays put and marks it aria-invalid="true".`,
          );
        });

      await page.waitForLoadState("domcontentloaded").catch(() => {});
      console.log(`[BlueSnap] Post-payment URL: ${page.url()}`);
    },
  },

  DPO: {
    // Full-page redirect to DPO's hosted pay page (payv2.php on
    // secure.3gdirectpay.com). Three sections to complete before paying:
    // Personal Details, the card form, and the Terms checkbox.
    //
    // IMPORTANT SCOPING NOTE, and the reason for "#card-method ..." throughout:
    // DPO renders the SAME ids in every payment pane. id="terms-approval",
    // id="ccBtnDiv", id="pincodeBtn", id="paymentBtnWarp" and id="explVerification"
    // each appear five or more times on this one page (card, mobile, PayPal,
    // xPay, USSD, bank transfer, saved-cards). That's invalid HTML, but it's
    // what ships — so a bare page.locator("#terms-approval") resolves to
    // several elements and fails Playwright's strict mode. Scoping to the card
    // pane picks the one that belongs to the flow being driven.
    fillCardDetails: async (page) => {
      console.log("Opening the DPO hosted pay page (redirect)...");

      // The query string carries a per-transaction ID (?ID=6B15FD2C-…), so only
      // the path prefix is matched.
      await waitForUrlPrefix(
        page,
        "https://secure.3gdirectpay.com/payv2.php",
        60000,
      );
      console.log(`✓ DPO pay page reached: ${page.url()}`);

      // ---- 1. Select the "Card" tab ----
      // #cerditcarAtag is DPO's own id, typo and all ("cerditcar"). It ships
      // with class "active" already, so this is usually a no-op — clicked
      // anyway because toggleFormOfPayment('creditcard') is what reveals and
      // arms the card pane's validation, and a run that lands with another tab
      // remembered would otherwise fill hidden fields.
      const cardTab = await waitForFieldInAnyFrame(
        page,
        (frame) => frame.locator("#cerditcarAtag, li#creditcard > a"),
        '"Card" payment tab',
        60000,
      );

      await cardTab.scrollIntoViewIfNeeded().catch(() => {});
      await cardTab.click();
      console.log('✓ "Card" tab selected');

      await page.waitForTimeout(1000);

      const CARD_NUMBER =
        process.env.DPO_TEST_CARD_NUMBER || "4000000000000002";
      const CVV = process.env.DPO_TEST_CARD_CVV || "123";
      const CARD_NAME = process.env.DPO_TEST_CARD_NAME || "Test Customer";

      /**
       * Fills a Personal Details input, ALWAYS overwriting whatever is there.
       *
       * Deliberately not a fill-if-empty. WTE pre-populates first and last name
       * from the booking's traveller record, and those values carry a numeric
       * suffix — "Traveler1788862563361" / "Test1788862563361" — which DPO's
       * own validateform() rejects: it tints a field
       * background:rgb(253,234,234) (pink) while invalid and keeps the Pay
       * button blocked. Both name fields arrive pink for exactly that reason,
       * so keeping the pre-filled values would stall the payment.
       *
       * pressSequentially after clearing, not fill(): validateform() runs on
       * keyup here, so the pink tint only clears on real keystrokes — a fill()
       * lands as one event and leaves the field marked invalid even once the
       * value is good.
       */
      const fillPersonalField = async (selector, label, value) => {
        const input = page.locator(selector).first();

        if (!(await input.count())) {
          console.log(`ℓ [DPO] No ${label} field (${selector}) — skipped`);
          return;
        }

        const current = (await input.inputValue().catch(() => "")).trim();

        await input.scrollIntoViewIfNeeded().catch(() => {});
        await input.click();

        if (current) {
          // fill("") clears without firing the per-character handlers, which is
          // fine for emptying — the typing below is what re-validates.
          await input.fill("");
        }

        await input.pressSequentially(value, { delay: 40 });

        console.log(
          `✓ [DPO] ${label} set to "${value}"${
            current ? ` (replaced "${current}")` : ""
          }`,
        );
      };

      /**
       * Sets one of the select2-enhanced <select>s (Country, Country Code).
       *
       * They carry class "select2-hidden-accessible", i.e. select2 has hidden
       * the real element and painted a combobox over it — so selectOption()
       * fails actionability against a hidden node. Setting .value and firing
       * `change` is what DPO's own validateform() listens for, and it also
       * nudges select2 to repaint its rendered label.
       */
      const setSelect2 = async (selector, value, label) => {
        const select = page.locator(selector).first();

        if (!(await select.count())) {
          console.log(`ℓ [DPO] No ${label} select (${selector}) — skipped`);
          return;
        }

        const applied = await select.evaluate((el, v) => {
          const match = Array.from(el.options).some((o) => o.value === v);
          if (!match) return false;

          el.value = v;
          el.dispatchEvent(new Event("change", { bubbles: true }));
          // select2 listens on jQuery's own change, which the native event
          // above doesn't always reach — poke it directly when it's present.
          if (window.jQuery) window.jQuery(el).trigger("change");
          return true;
        }, value);

        if (!applied) {
          console.log(
            `⚠ [DPO] ${label}: no option with value "${value}" — left as-is.`,
          );
          return;
        }

        console.log(`✓ [DPO] ${label} set (value="${value}")`);
      };

      // ---- 2. Personal Details ----
      // Every field is written, including the two WTE pre-fills — see
      // fillPersonalField above for why those must be replaced rather than
      // kept. Names are deliberately letters-only: digits are what DPO
      // rejects.
      await fillPersonalField("#TRANSCustFirstName", "First name", "Test");
      await fillPersonalField("#TRANSCustLastName", "Last name", "Customer");
      await fillPersonalField(
        "#TRANSemail",
        "Email",
        process.env.DPO_TEST_EMAIL || "customer@example.com",
      );
      await fillPersonalField("#TRANSCardHolderCity", "City", "San Francisco");
      await fillPersonalField("#TRANSCardHolderZIP", "ZIP", "94105");

      // DPO's country options are its OWN numeric ids, not ISO codes:
      // 230 = "United States of America" in #TRANScoid, and 202 = "United
      // States of America (+1)" in #TRANSphfID. The two lists are numbered
      // independently — the same country has a different value in each — so
      // these can't share one constant.
      await setSelect2(
        "#TRANScoid",
        process.env.DPO_TEST_COUNTRY_ID || "230",
        "Country",
      );
      await setSelect2(
        "#TRANSphfID",
        process.env.DPO_TEST_COUNTRY_CODE_ID || "202",
        "Country code",
      );

      await fillPersonalField("#TRANSphone", "Mobile", "4155550123");

      // ---- 3. Card details ----
      const typeCardField = async (selector, label, value) => {
        const input = page.locator(`#card-method ${selector}`).first();

        await input.waitFor({ state: "visible", timeout: 30000 });
        await input.scrollIntoViewIfNeeded().catch(() => {});
        await input.click();
        // pressSequentially: DPO runs validateform()/GetCardType() on keyup, so
        // the card-brand detection and the field's own validation only fire on
        // real keystrokes. A fill() lands as one event and leaves the field
        // marked invalid.
        await input.pressSequentially(value, { delay: 60 });
        console.log(`✓ [DPO] ${label} entered`);
      };

      await typeCardField(
        "#TRANScardholdername",
        "Card holder name",
        CARD_NAME,
      );
      await typeCardField("#TRANSCreditnum", "Card number", CARD_NUMBER);

      // Expiry month values are NOT zero-padded — <option value="4">April</option>
      // — so "04" would match nothing. Both forms are tried so an env override
      // written either way works.
      const monthSelect = page.locator("#card-method #TRANSexpiryM").first();
      await monthSelect.waitFor({ state: "visible", timeout: 30000 });

      const rawMonth = process.env.DPO_TEST_CARD_EXP_MONTH || "12";
      const monthCandidates = [
        ...new Set([rawMonth, String(Number(rawMonth))]),
      ];

      let monthSet = false;
      for (const candidate of monthCandidates) {
        monthSet = await monthSelect
          .selectOption(candidate, { timeout: 10000 })
          .then(() => true)
          .catch(() => false);
        if (monthSet) {
          console.log(`✓ [DPO] Expiry month set (value="${candidate}")`);
          break;
        }
      }

      if (!monthSet) {
        throw new Error(
          `[DPO] Could not set the expiry month — none of ${JSON.stringify(monthCandidates)} matched an option.`,
        );
      }

      // Year options are generated per session (2026–2036 today), so the wanted
      // year is checked against what's rendered and the last is used if it has
      // rolled out of range — otherwise this starts failing on its own later.
      const yearSelect = page.locator("#card-method #TRANSexpiryY").first();
      await yearSelect.waitFor({ state: "visible", timeout: 30000 });

      const years = await yearSelect.evaluate((el) =>
        Array.from(el.options)
          .map((o) => o.value)
          .filter(Boolean),
      );

      const wantedYear =
        process.env.DPO_TEST_CARD_EXP_YEAR ||
        String(new Date().getFullYear() + 3);

      const year = years.includes(wantedYear)
        ? wantedYear
        : years[years.length - 1];

      if (year !== wantedYear) {
        console.log(
          `ℓ [DPO] ${wantedYear} isn't in the expiry-year list (${years.join(", ")}) — using ${year}.`,
        );
      }

      await yearSelect.selectOption(year);
      console.log(`✓ [DPO] Expiry year set to ${year}`);

      await typeCardField("#TRANScvv", "CVV", CVV);

      // ---- 4. Terms & Conditions ----
      // Scoped to #card-method: see the note at the top of this entry — the
      // same id is on five other panes. DPO's Pay button carries
      // data-content="Please approve Terms and conditions" and refuses to
      // submit until this is ticked.
      const terms = page
        .locator(
          "#card-method input.terms-checkbox, #card-method #terms-approval",
        )
        .first();

      await terms.waitFor({ state: "visible", timeout: 30000 });

      if (await terms.isChecked().catch(() => false)) {
        console.log("✓ [DPO] Terms already approved");
      } else {
        await terms.scrollIntoViewIfNeeded().catch(() => {});
        await terms.check();

        if (!(await terms.isChecked().catch(() => false))) {
          // The label wraps the input, so clicking it toggles too — used as a
          // fallback for a theme/overlay swallowing the direct click.
          await terms.click({ force: true }).catch(() => {});
        }

        if (!(await terms.isChecked().catch(() => false))) {
          throw new Error(
            "[DPO] Could not tick the Terms & Conditions checkbox — the Pay button will refuse to submit without it.",
          );
        }

        console.log("✓ [DPO] Terms & Conditions approved");
      }

      console.log("✓ DPO card form filled");
    },

    submitCardPayment: async (page) => {
      console.log("[DPO] Submitting the payment...");

      // #creditCardBtn is the card pane's Pay button — NOT #mobileBtn,
      // #payPalBtn, #xpayPayBtn, #ussdBtn or #bankTransferBtn, which are the
      // other panes' equivalents and all carry the same payBtnClass.
      const payButton = page.locator("#card-method #creditCardBtn").first();

      await payButton.waitFor({ state: "visible", timeout: 45000 });

      const startUrl = page.url();
      console.log(`[DPO] URL before submit: ${startUrl}`);

      await payButton.scrollIntoViewIfNeeded().catch(() => {});
      await payButton.click();
      console.log("[DPO] Pay clicked");

      await page
        .waitForURL((url) => url.href !== startUrl, { timeout: 60000 })
        .catch(() => {
          console.log(
            `⚠ [DPO] Still on ${page.url()} 60s after the submit — no redirect observed.`,
          );
        });

      await page.waitForLoadState("domcontentloaded").catch(() => {});
      console.log(`[DPO] After Pay, landed on: ${page.url()}`);

      // ---- Optional SMS / PIN verification ----
      // DPO can interpose a one-time PIN step, and when it does the input has
      // NO id — it's <input class="form-control customToolTip pin"> inside the
      // pane's .smsVerify block, with a #pincodeBtn Submit beside it (that id
      // is duplicated per pane too, hence the scoping).
      //
      // Conditional: most sandbox transactions skip it entirely, so a miss is
      // a pass rather than a failure.
      const pinInput = page
        .locator("#card-method .smsVerify input.pin")
        .first();

      const needsPin = await pinInput
        .waitFor({ state: "visible", timeout: 15000 })
        .then(() => true)
        .catch(() => false);

      if (!needsPin) {
        console.log(
          `ℓ [DPO] No SMS/PIN verification step — nothing more to do here. Currently on ${page.url()}.`,
        );
        return;
      }

      const PIN = process.env.DPO_TEST_PIN || "123456";

      await pinInput.click();
      await pinInput.pressSequentially(PIN, { delay: 80 });
      console.log(`✓ [DPO] Verification PIN entered ("${PIN}")`);

      const pinButton = page.locator("#card-method #pincodeBtn").first();
      const pinUrl = page.url();

      await pinButton.scrollIntoViewIfNeeded().catch(() => {});
      await pinButton.click();
      console.log("✓ [DPO] PIN submitted");

      await page
        .waitForURL((url) => url.href !== pinUrl, { timeout: 60000 })
        .catch(() => {
          console.log(
            `⚠ [DPO] Still on ${page.url()} 60s after the PIN submit — no redirect observed.`,
          );
        });

      await page.waitForLoadState("domcontentloaded").catch(() => {});
      console.log(`[DPO] Post-payment URL: ${page.url()}`);
    },
  },

  Elavon: {
    // Full-page redirect to Elavon's Converge Hosted Payment Page:
    //   https://uat.hpp.converge.eu.elavonaws.com/?pl=<per-session token>
    // The `?pl=` token is minted per transaction, so only the ORIGIN is matched.
    //
    // The HPP is a React/MUI app whose class names — sc-idHmUl eHJsjv,
    // MuiInputBase-input-hhbqMt, MuiButtonBase-root-hxBDVC — are
    // styled-components/JSS build hashes and change on every release. Nothing
    // here keys on them. What IS stable is Elavon's own `qa_*_section` ids and
    // the form field `name` attributes (paymentTypeSelector, securityCode, …),
    // so every locator below is built from those, with a label/role fallback.
    fillCardDetails: async (page) => {
      console.log("Opening the Elavon Converge hosted payment page...");

      // Origin-only match: the path is "/" and the whole identity of the
      // payment sits in the ?pl= query token.
      await waitForUrlPrefix(
        page,
        "https://uat.hpp.converge.eu.elavonaws.com/",
        60000,
      );
      console.log(`✓ Elavon HPP reached: ${page.url()}`);

      const CARD_NUMBER =
        process.env.ELAVON_TEST_CARD_NUMBER || "4124939999999990";
      const CVV = process.env.ELAVON_TEST_CARD_CVV || "123";
      const CARD_NAME = process.env.ELAVON_TEST_CARD_NAME || "Test Customer";

      // maxlength on the security code field is 4, and the expiry field takes
      // MM/YY with the slash inserted by the widget — so only digits are typed.
      const EXPIRY = process.env.ELAVON_TEST_CARD_EXPIRY || "1229";

      console.log(
        `[Elavon] Using test card ending in ${CARD_NUMBER.slice(-4)}, expiry ${EXPIRY.slice(0, 2)}/${EXPIRY.slice(2)}`,
      );

      // ---- 1. Choose "Credit/Debit Card" ----
      // The radio itself is the target, matched on name+value rather than on
      // its class (sc-idHmUl eHJsjv PrivateSwitchBase-input — two of those three
      // are generated). MUI renders the real <input> visually hidden underneath
      // the SVG, so a plain .click() can be intercepted; the wrapping <label> is
      // what a user actually hits, hence the label-first order below.
      const cardRadio = page
        .locator('input[name="paymentTypeSelector"][value="CREDITDEBIT"]')
        .first();

      await cardRadio.waitFor({ state: "attached", timeout: 60000 });

      if (await cardRadio.isChecked().catch(() => false)) {
        console.log('✓ [Elavon] "Credit/Debit Card" already selected');
      } else {
        // The pane wrapper carries entryvalue="CREDITDEBIT" and gains
        // class "is-selected" once chosen — that attribute is Elavon's own, so
        // it's a safe handle for the label inside it.
        const cardLabel = page
          .locator('[entryvalue="CREDITDEBIT"] label')
          .first();

        if (await cardLabel.count()) {
          await cardLabel.scrollIntoViewIfNeeded().catch(() => {});
          await cardLabel.click();
        } else {
          await cardRadio.click({ force: true });
        }

        if (!(await cardRadio.isChecked().catch(() => false))) {
          await cardRadio.check({ force: true }).catch(() => {});
        }

        if (!(await cardRadio.isChecked().catch(() => false))) {
          throw new Error(
            '[Elavon] Could not select the "Credit/Debit Card" payment type — ' +
              "the card fields never expand without it.",
          );
        }

        console.log('✓ [Elavon] "Credit/Debit Card" selected');
      }

      // The card fields mount only after the radio is checked (the pane goes
      // class="… is-selected"), so give React a beat to render them.
      await page.waitForTimeout(1000);

      /**
       * Types into the first of `selectors` that's actually on the page.
       *
       * Each field is addressed by its confirmed Elavon id first, then by the
       * `name` attribute as a fallback — note that the ids do NOT all follow one
       * convention (`qa_card_holder_name`, `qa_cc_section`,
       * `qa_expiryDate_section`, `qa_secCode_section`), so both handles are
       * kept. If neither resolves, the error lists every input the HPP is
       * actually showing rather than just timing out.
       *
       * pressSequentially, not fill(): these are masked inputs (digit grouping
       * on the number, "MM / YY" on the expiry) whose formatters run per
       * keystroke and drop a single bulk input event.
       */
      const typeField = async (selectors, label, value) => {
        for (const selector of selectors) {
          const input = page.locator(selector).first();

          const visible = await input
            .waitFor({ state: "visible", timeout: 5000 })
            .then(() => true)
            .catch(() => false);

          if (!visible) continue;

          await input.scrollIntoViewIfNeeded().catch(() => {});
          await input.click();
          await input.fill("").catch(() => {});
          await input.pressSequentially(value, { delay: 60 });
          console.log(`✓ [Elavon] ${label} entered (via "${selector}")`);
          return true;
        }

        const present = await page
          .locator("input:visible")
          .evaluateAll((inputs) =>
            inputs.map((i) => ({
              id: i.id || null,
              name: i.getAttribute("name"),
              type: i.type,
              maxlength: i.getAttribute("maxlength"),
            })),
          )
          .catch(() => []);

        throw new Error(
          `[Elavon] Could not find the ${label} field. Tried: ${JSON.stringify(selectors)}. ` +
            `Visible inputs on the HPP: ${JSON.stringify(present)}.`,
        );
      };

      // ---- 2. Card details ----
      // Filled in the order the HPP renders them (name → number → expiry →
      // CVV) so the masked formatters and per-field validation fire the same
      // way they do for a real customer.

      // maxlength="45", spellcheck="false" on this one.
      await typeField(
        ["#qa_card_holder_name", 'input[name="holderName"]'],
        "Name on card",
        CARD_NAME,
      );

      // The HPP masks this back to "**** **** **** 9990" once it loses focus,
      // so never assert on the field's value after filling it.
      await typeField(
        ["#qa_cc_section", 'input[name="cardNumber"]'],
        "Card number",
        CARD_NUMBER,
      );

      // Label reads "Expiration date (MM/YY)"; the widget inserts the slash, so
      // EXPIRY is four digits.
      await typeField(
        ["#qa_expiryDate_section", 'input[name="expiryDate"]'],
        "Expiry",
        EXPIRY,
      );

      // maxlength="4", inputmode="numeric".
      await typeField(
        ["#qa_secCode_section", 'input[name="securityCode"]'],
        "Security code",
        CVV,
      );

      console.log("✓ Elavon card form filled");
    },

    submitCardPayment: async (page) => {
      console.log("[Elavon] Submitting the payment...");

      // Matched by accessible name first — the button's visible label is "PAY"
      // (uppercased in CSS, so the accessible name may read "Pay"), and every
      // class on it is a generated MUI/styled-components hash. Elavon's qa_ id
      // and a scoped submit button are kept as fallbacks.
      //
      // NOT a substring :has-text("Pay"): the HPP also renders alternative
      // payment-method tiles whose text contains "Pay", and the first match in
      // DOM order would submit the wrong thing.
      const payButton = page
        .getByRole("button", { name: /^\s*pay(\s|$|\b.*)/i })
        .or(page.locator("#qa_pay_button, #qa_payButton_section"))
        .or(page.locator('form button[type="submit"]'))
        .first();

      await payButton.waitFor({ state: "visible", timeout: 45000 });

      const startUrl = page.url();
      console.log(`[Elavon] URL before submit: ${startUrl}`);

      await payButton.scrollIntoViewIfNeeded().catch(() => {});
      await payButton.click();
      console.log("[Elavon] PAY clicked");

      // ---- Elavon's own "transaction successful" screen ----
      // Elavon authorises on its own host and then PARKS on a result screen —
      // it does not bounce back to WTE on its own. The redirect only fires when
      // its Continue button is clicked, so that click is part of submitting the
      // payment, not an optional extra.
      //
      // type="button", so there is no form submit to fall back on: if this
      // button is never clicked the run sits on the HPP until the Thank You
      // assertion in the spec times out.
      const continueButton = page
        .locator("#qa_transaction_success_action")
        .or(page.getByRole("button", { name: /^\s*continue\s*$/i }))
        .first();

      // Whichever comes first wins: normally the result screen, but a
      // straight-through redirect (or a decline bouncing back with an error
      // callback) has to be honoured too rather than waited out.
      const outcome = await Promise.race([
        continueButton
          .waitFor({ state: "visible", timeout: 90000 })
          .then(() => "result-screen")
          .catch(() => null),
        page
          .waitForURL((url) => url.href !== startUrl, { timeout: 90000 })
          .then(() => "redirected")
          .catch(() => null),
      ]);

      if (outcome === "result-screen") {
        console.log('[Elavon] Result screen reached — clicking "Continue"');
      } else if (outcome === "redirected") {
        console.log(
          `[Elavon] Left the HPP without a result screen (${page.url()})`,
        );
      } else {
        console.log(
          `⚠ [Elavon] Still on ${page.url()} 90s after the submit — no result screen and no redirect. ` +
            `A rejected field keeps the HPP in place and marks it aria-invalid="true".`,
        );
      }

      // Checked even after a "redirected" outcome: the URL can change while the
      // browser is still on Elavon's host (the result screen is routed
      // client-side), in which case Continue is what actually sends it back to
      // WTE.
      if (await continueButton.isVisible().catch(() => false)) {
        const urlBeforeContinue = page.url();

        await continueButton.scrollIntoViewIfNeeded().catch(() => {});
        await continueButton.click();
        console.log("[Elavon] Continue clicked");

        // The hand-off back is a couple of round trips: Elavon redirects, WTE
        // completes the booking server-side, then it forwards to Thank You.
        const handedOff = await waitForSubmissionToTakeEffect(
          page,
          urlBeforeContinue,
          90000,
        );

        if (!handedOff) {
          console.log(
            `⚠ [Elavon] Still on ${page.url()} 90s after Continue — the redirect back to WTE never landed.`,
          );
        }
      }

      await page.waitForLoadState("domcontentloaded").catch(() => {});
      console.log(`[Elavon] Post-payment URL: ${page.url()}`);
    },
  },

  //12th

  GetPayin: {
    // Full-page redirect to GetPayin's hosted checkout:
    //   https://pay.getpayin.com/integration/checkout
    //     ?expires=..&integration_id=..&invoice_id=..&order_title=..&signature=..
    // Every one of those params is per-transaction (the signature is an HMAC
    // over the rest), so only the origin + path prefix is matched.
    //
    // Behind the "Checkout with card" launcher this is Visa Click to Pay
    // (a.k.a. SRC, "mce-and-ctp"), NOT GetPayin's own form -- hence the `v-*`
    // classes and the `billTo.*` / `paymentInformation.card.*` field names,
    // which are CyberSource's. Click to Pay normally renders in its own iframe,
    // so every field is resolved with waitForFieldInAnyFrame() rather than
    // page.locator(): that scans the flat frame list (main frame included), so
    // it keeps working whether or not Visa is iframed on a given release.
    fillCardDetails: async (page) => {
      console.log("Opening the GetPayin hosted checkout...");

      await waitForUrlPrefix(
        page,
        "https://pay.getpayin.com/integration/checkout",
        60000,
      );
      console.log(`✓ GetPayin checkout reached: ${page.url()}`);

      const CARD_NUMBER =
        process.env.GETPAYIN_TEST_CARD_NUMBER || "4111111111111111";
      // maxlength="3" on #card-security-code and the helper text reads
      // "3-digits on back of card", so this is a CVV2 -- not a 4-digit Amex CID.
      const CVV = process.env.GETPAYIN_TEST_CARD_CVV || "123";
      const FIRST_NAME = process.env.GETPAYIN_TEST_FIRST_NAME || "Test";
      const LAST_NAME = process.env.GETPAYIN_TEST_LAST_NAME || "Customer";

      // Billing address is mandatory here (aria-required="true" on country,
      // address, city and zip), so it is filled rather than skipped.
      const COUNTRY = process.env.GETPAYIN_TEST_COUNTRY || "US";
      const ADDRESS = process.env.GETPAYIN_TEST_ADDRESS || "1 Market Street";
      const CITY = process.env.GETPAYIN_TEST_CITY || "San Francisco";
      const STATE = process.env.GETPAYIN_TEST_STATE || "CA";
      const POSTAL_CODE = process.env.GETPAYIN_TEST_POSTAL_CODE || "94105";

      console.log(
        `[GetPayin] Using test card ending in ${CARD_NUMBER.slice(-4)}`,
      );

      // ---- 1. "Checkout with card" launcher ----
      // data-testid, not the class list: "v-button static-button-styles block
      // launcher-mce-and-ctp light" mixes Visa design-system utility classes in
      // with the launcher name. The aria-label is kept as a fallback because the
      // button's text sits beside an inline <svg>, so matching on text alone is
      // brittle.
      const launcher = await waitForFieldInAnyFrame(
        page,
        (frame) =>
          frame
            .locator('[data-testid="launcher-mce-and-ctp"]')
            .or(frame.getByRole("button", { name: /checkout with card/i })),
        "Checkout with card launcher",
        60000,
      );

      await launcher.scrollIntoViewIfNeeded().catch(() => {});
      await launcher.click();
      console.log('✓ [GetPayin] "Checkout with card" clicked');

      // ---- 2. Click to Pay stepper ----
      // Step 1 (contact details) arrives already complete -- the email comes
      // from the order, shown masked as "tra***@example.com" -- and step 2
      // (payment details) is the one that opens. If a release ever asks for the
      // email again, step-contact will be `step-open` instead and the card
      // number below times out with the frame dump from
      // waitForFieldInAnyFrame(); that dump is the signal to add the step here.
      const cardNumberInput = await waitForFieldInAnyFrame(
        page,
        (frame) =>
          frame
            .locator("#card-number")
            .or(frame.locator('input[name="paymentInformation.card.number"]')),
        "Card number",
        60000,
      );

      const contactSummary = await page
        .locator('[data-testid="contact-details-summary"]')
        .first()
        .textContent()
        .catch(() => null);

      if (contactSummary) {
        console.log(
          `[GetPayin] Contact step already complete: ${contactSummary.trim()}`,
        );
      }

      /**
       * Resolves one stepper field wherever it lives, then types into it.
       *
       * pressSequentially, not fill(): #card-number formats as you type and
       * drives the card-type detection that fills the hidden
       * paymentInformation.card.type, and those handlers run per keystroke.
       */
      const typeField = async (selector, label, value) => {
        const input = await waitForFieldInAnyFrame(
          page,
          (frame) => frame.locator(selector),
          label,
          30000,
        );

        await input.scrollIntoViewIfNeeded().catch(() => {});
        await input.click();
        await input.fill("").catch(() => {});
        await input.pressSequentially(value, { delay: 60 });
        console.log(`✓ [GetPayin] ${label} entered`);
      };

      // ---- 3. Card details ----
      await cardNumberInput.scrollIntoViewIfNeeded().catch(() => {});
      await cardNumberInput.click();
      await cardNumberInput.fill("").catch(() => {});
      await cardNumberInput.pressSequentially(CARD_NUMBER, { delay: 60 });
      console.log("✓ [GetPayin] Card number entered");

      // Expiry is two <select>s, not a masked text field. Month options are
      // zero-padded ("01".."12"); year options carry the FULL year as the value
      // ("2026") while displaying two digits ("26"), so selectOption() is given
      // four digits.
      const monthSelect = await waitForFieldInAnyFrame(
        page,
        (frame) => frame.locator("#card-expiry-month"),
        "Expiry month",
        30000,
      );

      const yearSelect = await waitForFieldInAnyFrame(
        page,
        (frame) => frame.locator("#card-expiry-year"),
        "Expiry year",
        30000,
      );

      const EXPIRY_MONTH = process.env.GETPAYIN_TEST_CARD_EXP_MONTH || "12";
      await monthSelect.selectOption(EXPIRY_MONTH);

      // The year list starts at the current year, so any hardcoded default goes
      // stale -- read what is actually on offer and fall back to the last one.
      const years = await yearSelect.evaluate((el) =>
        Array.from(el.options)
          .map((o) => o.value)
          .filter(Boolean),
      );

      const wantedYear =
        process.env.GETPAYIN_TEST_CARD_EXP_YEAR ||
        String(new Date().getFullYear() + 3);

      const year = years.includes(wantedYear)
        ? wantedYear
        : years[years.length - 1];

      if (year !== wantedYear) {
        console.log(
          `ℓ [GetPayin] ${wantedYear} isn't in the expiry-year list -- using ${year}.`,
        );
      }

      await yearSelect.selectOption(year);
      console.log(`✓ [GetPayin] Expiry set to ${EXPIRY_MONTH}/${year}`);

      await typeField("#card-security-code", "Security code", CVV);

      // ---- 4. Cardholder name ----
      // Note the ids: these are billTo.firstName / billTo.lastName, i.e. the
      // BILLING name -- Click to Pay has no single "name on card" field.
      await typeField("#billing-first-name", "First name", FIRST_NAME);
      await typeField("#billing-last-name", "Last name", LAST_NAME);

      // ---- 5. Billing address ----
      // Country is a <select> keyed on ISO codes, and the US option's label is
      // "USA" -- so it must be selected by VALUE ("US"), never by label.
      const countrySelect = await waitForFieldInAnyFrame(
        page,
        (frame) => frame.locator("#billing-country"),
        "Billing country",
        30000,
      );

      await countrySelect.selectOption(COUNTRY);
      console.log(`✓ [GetPayin] Country set to ${COUNTRY}`);

      await typeField("#billing-address1", "Address", ADDRESS);
      await typeField("#billing-locality", "City", CITY);

      // State/Province is aria-required="false", but CyberSource's own address
      // validation rejects a US address without one -- so it is filled when the
      // field is present and skipped, without failing, when it is not.
      const stateField = await waitForFieldInAnyFrame(
        page,
        (frame) => frame.locator("#billing-administrative-area"),
        "State/Province",
        10000,
      ).catch(() => null);

      if (stateField) {
        await stateField.click();
        await stateField.fill("").catch(() => {});
        await stateField.pressSequentially(STATE, { delay: 60 });
        console.log(`✓ [GetPayin] State/Province entered (${STATE})`);
      } else {
        console.log(
          "ℓ [GetPayin] No State/Province field on this step -- skipped",
        );
      }

      await typeField("#billing-postal-code", "Zip Code", POSTAL_CODE);

      // #billing-building-number ("Apartment, suite, floor etc") is
      // placeholder="Optional" / aria-required="false" and is deliberately left
      // blank, so the run exercises the minimal valid address.
      console.log("✓ GetPayin card and billing details filled");
    },

    submitCardPayment: async (page) => {
      console.log("[GetPayin] Submitting the payment...");

      // ---- 1. Step 2 -> step 3 ----
      // data-testid="btn" is Visa's generic id for a step's primary action, so
      // it is scoped to the submit button INSIDE the card/billing form --
      // `[data-testid="btn"]` on its own would also match the primary action of
      // any other step that happens to be mounted.
      const continueButton = await waitForFieldInAnyFrame(
        page,
        (frame) =>
          frame
            .locator('form.card-and-billing-details button[type="submit"]')
            .or(frame.locator('form button[data-testid="btn"][type="submit"]'))
            .or(frame.getByRole("button", { name: /^\s*continue\s*$/i })),
        "Continue button",
        45000,
      );

      const startUrl = page.url();
      console.log(`[GetPayin] URL before submit: ${startUrl}`);

      await continueButton.scrollIntoViewIfNeeded().catch(() => {});
      await continueButton.click();
      console.log("[GetPayin] Continue clicked (payment details submitted)");

      // ---- 2. Step 3 of 3: the review step ----
      // The review step's primary action is
      //   <button class="v-button static-button-styles"
      //           data-testid="step-review-continue-btn" type="submit">
      //     Confirm and Continue
      //   </button>
      // The name-based locators stay behind it as fallbacks in case the testid
      // is renamed. The checkout can also hand off without ever showing this
      // step, which the race below covers.
      const confirmButton = page
        .locator('button[data-testid="step-review-continue-btn"]')
        .or(
          page.getByRole("button", {
            name: /^\s*(confirm and continue|pay|pay now|confirm|complete|submit|place order)\b/i,
          }),
        )
        .first();

      const outcome = await Promise.race([
        confirmButton
          .waitFor({ state: "visible", timeout: 60000 })
          .then(() => "confirm-step")
          .catch(() => null),
        page
          .waitForURL((url) => url.href !== startUrl, { timeout: 60000 })
          .then(() => "handed-off")
          .catch(() => null),
      ]);

      if (outcome === "confirm-step") {
        const urlBeforeConfirm = page.url();

        await confirmButton.scrollIntoViewIfNeeded().catch(() => {});
        await confirmButton.click();
        console.log("[GetPayin] Final confirm clicked");

        const handedOff = await waitForSubmissionToTakeEffect(
          page,
          urlBeforeConfirm,
          90000,
        );

        if (!handedOff) {
          console.log(
            `⚠ [GetPayin] Still on ${page.url()} 90s after the confirm -- no redirect back to WTE.`,
          );
        }
      } else if (outcome === "handed-off") {
        console.log(
          `[GetPayin] Checkout handed off without a further step (${page.url()})`,
        );
      } else {
        console.log(
          `⚠ [GetPayin] Neither a confirm button nor a redirect 60s after Continue. ` +
            `A rejected field keeps the step open and marks it aria-invalid="true". ` +
            `Buttons on the page:\n${await describeSubmitButtons(page)}`,
        );
      }

      await page.waitForLoadState("domcontentloaded").catch(() => {});
      console.log(`[GetPayin] Post-payment URL: ${page.url()}`);
    },
  },

  FastSpring: {
    // FastSpring's popup storefront (popup-<FASTSPRING_POPUP_PATH> on
    // <FASTSPRING_STORE_ID>.test.onfastspring.com). It is the legacy AngularJS
    // checkout — not a hosted-fields integration: every input is a plain
    // <input> in the same document as the order summary, inside
    // <form name="form" id="orderForm">:
    //
    //   <input id="contact-email"          name="contact.email">
    //   <input id="contact-first-name"     name="contact.firstName">
    //   <input id="contact-last-name"      name="contact.lastName">
    //   <input id="card-number"            credit-card-input maxlength="23">
    //   <input id="card-expire-month-year" only-digit-input placeholder="MM / YY">
    //   <input id="card-security"          maxlength="5">
    //   <input id="contact-addressline1">  <input id="contact-city">
    //   <select id="contact.region" name="contact.region">
    //   <input id="contact-postal"         us-zip-code-input>
    //   <button type="submit" class="btn pay-button">Pay $2,200.00</button>
    //
    // The ids are Angular-template constants and are the stable handles. What
    // is NOT stable: the Bootstrap/ng classes (ng-pristine, ng-invalid-required
    // and friends are rewritten on every keystroke), the payment-option indices
    // (#payment-option-0…N are assigned by ng-repeat over whatever methods the
    // store has enabled), and the Pay button's label, which carries the order
    // total. So the card method is picked by the radio's value="card" and the
    // submit by /^Pay/ inside #orderForm, never by index or amount.
    //
    // Which sections render is store configuration: the contact block is
    // ng-if="option.requireContact", the address block
    // ng-if="showAddressField", and the state <select> only exists for
    // countries with a region list. Everything outside the card fields is
    // therefore filled only when present, and skipped without failing.
    //
    // No waitForUrlPrefix(): the popup is injected as an iframe by
    // fastspring-builder.js on some integrations and served as a full-page
    // redirect on others, so fields are resolved with waitForFieldInAnyFrame()
    // — that scans the flat frame list (main frame included) and works either
    // way.
    fillCardDetails: async (page) => {
      console.log("Waiting for the FastSpring popup checkout to mount...");

      const CARD_NUMBER =
        process.env.FASTSPRING_TEST_CARD_NUMBER || "4242424242424242";
      const CVC = process.env.FASTSPRING_TEST_CARD_CVC || "123";
      const EMAIL = process.env.FASTSPRING_TEST_EMAIL || "test@example.com";
      const FIRST_NAME = process.env.FASTSPRING_TEST_FIRST_NAME || "Token";
      const LAST_NAME = process.env.FASTSPRING_TEST_LAST_NAME || "Tutorial";
      const ADDRESS =
        process.env.FASTSPRING_TEST_ADDRESS || "1600 Amphitheatre Parkway";
      const CITY = process.env.FASTSPRING_TEST_CITY || "Mountain View";
      const STATE = process.env.FASTSPRING_TEST_STATE || "CA";
      const POSTAL_CODE = process.env.FASTSPRING_TEST_POSTAL_CODE || "94043";

      // House convention: month 02, year = current year + 3. Typed as four
      // digits only — the field is only-digit-input and Angular's own formatter
      // inserts the " / " separator.
      const expiryMonth = "02";
      const expiryYearShort = String(new Date().getFullYear() + 3).slice(-2);
      const EXPIRY = `${expiryMonth}${expiryYearShort}`;

      console.log(
        `[FastSpring] Using test card ending in ${CARD_NUMBER.slice(-4)}, expiry ${expiryMonth}/${expiryYearShort}`,
      );

      // #orderForm is the anchor: finding it resolves which frame owns the
      // checkout, and the radio below is scoped to it.
      const orderForm = await waitForFieldInAnyFrame(
        page,
        (frame) => frame.locator("#orderForm"),
        "FastSpring order form",
        90000,
      );

      // pressSequentially throughout: the card number, expiry and ZIP inputs
      // reformat on every keystroke (digit grouping, " / ", determineTax() on
      // the ZIP), and a single fill() lands as one input event those Angular
      // directives drop.
      const typeField = async (selector, label, value, { optional } = {}) => {
        const input = await waitForFieldInAnyFrame(
          page,
          (frame) => frame.locator(selector),
          label,
          optional ? 8000 : 30000,
        ).catch(() => null);

        if (!input) {
          if (optional) {
            console.log(
              `ℓ [FastSpring] No ${label} field on this storefront — skipped`,
            );
            return false;
          }

          throw new Error(
            `[FastSpring] Timed out waiting for the ${label} field (${selector})`,
          );
        }

        await input.scrollIntoViewIfNeeded().catch(() => {});
        await input.click();
        await input.fill("");
        await input.pressSequentially(value, { delay: 60 });
        console.log(`✓ [FastSpring] ${label} entered`);
        return true;
      };

      // ---- 1. Payment method ----
      // The radios are .sr-only (the visible control is the <label>'s payment
      // icon), so this is checked with force — a plain click lands on a
      // zero-size element. "card" is preselected unless the store puts another
      // method first.
      const cardRadio = orderForm
        .locator('input[name="payment-option-type"][value="card"]')
        .first();

      if (
        (await cardRadio.count()) &&
        !(await cardRadio.isChecked().catch(() => true))
      ) {
        await cardRadio.check({ force: true }).catch(() => {});
        console.log('✓ [FastSpring] "Credit / Debit Card" method selected');
      }

      // ---- 2. Contact ----
      // ng-if="option.requireContact" — present on card checkouts, absent from
      // the Apple Pay / Google Pay panes, hence optional.
      await typeField("#contact-email", "Email", EMAIL, { optional: true });
      await typeField("#contact-first-name", "First name", FIRST_NAME, {
        optional: true,
      });
      await typeField("#contact-last-name", "Last name", LAST_NAME, {
        optional: true,
      });

      // ---- 3. Card ----
      await typeField("#card-number", "Card number", CARD_NUMBER);
      await typeField("#card-expire-month-year", "Expiry", EXPIRY);
      await typeField("#card-security", "CVC", CVC);

      // ---- 4. Billing address ----
      // ng-if="showAddressField": rendered when the store forces physical
      // address collection or the order ships, so all of it is optional.
      await typeField("#contact-addressline1", "Address", ADDRESS, {
        optional: true,
      });
      await typeField("#contact-city", "City", CITY, { optional: true });

      // The state control is a <select> whose id contains a dot
      // (id="contact.region"), so it is matched on its name attribute rather
      // than an id selector. Options are keyed on the abbreviation
      // (value="CA", label="California") — select by VALUE, never by label.
      const regionSelect = await waitForFieldInAnyFrame(
        page,
        (frame) => frame.locator('select[name="contact.region"]'),
        "State/Province",
        8000,
      ).catch(() => null);

      if (regionSelect) {
        await regionSelect.selectOption(STATE).catch(async () => {
          await regionSelect.selectOption({ label: STATE }).catch(() => {});
        });
        console.log(`✓ [FastSpring] State set to ${STATE}`);
      } else {
        console.log(
          "ℓ [FastSpring] No State/Province select on this storefront — skipped",
        );
      }

      const postalFilled = await typeField(
        "#contact-postal",
        "Zip Code",
        POSTAL_CODE,
        { optional: true },
      );

      // determineTax() fires on the ZIP's ng-change and repaints both the tax
      // line and the Pay button's label; clicking mid-recalculation submits
      // against a stale total and FastSpring re-renders the popup.
      if (postalFilled) {
        await page.waitForTimeout(2000);
      }

      // #contact-company is ng-if'd in only when the store enables it and is
      // labelled "(Optional)" unless showCompanyField === 'require' — left
      // blank so the run exercises the minimal valid form.
      console.log("✓ [FastSpring] Card and billing details filled");
    },

    submitCardPayment: async (page) => {
      console.log("[FastSpring] Submitting the payment...");

      // The Pay button's label carries the order total ("Pay $2,200.00"), and
      // #orderForm also holds the "Go Back and Edit" / "Confirm" pair for the
      // confirm-info step — so it is matched on class="pay-button" +
      // type="submit" inside the form, with a /^Pay/ label as the tiebreaker,
      // never on the amount.
      const payButton = await waitForFieldInAnyFrame(
        page,
        (frame) =>
          frame
            .locator('#orderForm button.pay-button[type="submit"]')
            .filter({ hasText: /^\s*Pay\b/i })
            .or(frame.locator('#orderForm button.pay-button[type="submit"]')),
        "FastSpring Pay button",
        45000,
      );

      const startUrl = page.url();
      console.log(`[FastSpring] URL before submit: ${startUrl}`);

      await payButton.scrollIntoViewIfNeeded().catch(() => {});
      await payButton.click();
      console.log("[FastSpring] Pay clicked");

      // FastSpring tokenises, may run 3-D Secure (the popup swaps its body for
      // ng-show="processingThreeDS"), completes the order server-side, then
      // hands off to the store's return URL — several round trips after the
      // click, not an immediate navigation.
      await page
        .waitForURL((url) => url.href !== startUrl, { timeout: 90000 })
        .catch(() => {
          console.log(
            `⚠ [FastSpring] Still on ${page.url()} 90s after the submit — no redirect observed. ` +
              `A rejected field keeps the popup open and renders its message in the ` +
              `.error-message div under the input (e.g. #card-number-error).`,
          );
        });

      await page.waitForLoadState("domcontentloaded").catch(() => {});
      console.log(`[FastSpring] Post-payment URL: ${page.url()}`);
    },
  },
  //fonepay le qr open garxa so cards haru bata checkout hudaina
  MultiSafepay: {
    // MultiSafepay's hosted "connect" payment page:
    //   https://testpayv2.multisafepay.com/connect/<order token>/?lang=nl_NL
    //
    // Two steps, two templates — but both in the MAIN frame. Nothing here is
    // iframed, so no frame resolution is needed; what it does need is patience,
    // because the page is AngularJS and swaps the whole body for the card form
    // once the method is picked.
    //
    // Step 1 — the method list. Each method is a table row whose label is
    //   <td><span class="rebrand-text ng-binding">Visa</span></td>
    // The <span> is not clickable; the row (or its anchor) carries the
    // ng-click, so the label is used only to FIND the row and the click goes to
    // the nearest clickable ancestor — the same shape as the Mollie method list
    // above. Matched on an exact text node: the list also carries "Visa
    // Electron" and "V Pay" on some accounts, and a substring match would trip
    // strict mode.
    //
    // Step 2 — the card form, <form id="form-payment"> under
    // ng-card-validation="ST_VISA":
    //
    //   <input id="credit-card"   name="number" ng-card-number maxlength="30">
    //   <input id="field-extvar2" name="holder" data-field_id="holdername">
    //   <select name="expiry-month" ng-card-expiry-month>
    //   <select name="expiry-year"  ng-card-expiry-year>
    //   <input id="field-extvar4" name="cvc"    data-field_id="cvv">
    //   <input type="submit" value="Bevestig" class="btn btn-blue">
    //
    // Fields are keyed on their `name` attributes, not the ids: "field-extvar2"
    // and "field-extvar4" are positional template slots (extvar2/extvar4 =
    // "extra variable 2/4") and shift if MultiSafepay adds or reorders an
    // optional field, whereas name="holder"/name="cvc" are what the POST is
    // built from. The ng-* classes (ng-pristine, ng-invalid-required and
    // friends) are rewritten on every keystroke and are never selectors.
    //
    // The two expiry <select>s are the trap. Angular's ng-value serialises the
    // bound expression into the DOM, so the rendered values are NOT "02" and
    // "2029" but Angular's typed forms — value="number:2" for February and
    // value="string:29" for 2029 — and the visible labels are localised by the
    // ?lang= parameter ("02 - feb." under nl_NL). Neither the raw value nor the
    // label is safe on its own, so each select is set by a fallback chain
    // (Angular-typed value, then label, then position) and the result logged.
    //
    // Likewise the submit: value="Bevestig" is Dutch, and the same form holds a
    // "Terug" (back) control. They are separated by TYPE — submit vs button —
    // never by label.
    fillCardDetails: async (page) => {
      console.log("Filling MultiSafepay hosted-page card details...");

      await waitForUrlPrefix(
        page,
        "https://testpayv2.multisafepay.com/connect/",
        60000,
      );

      const CARD_NUMBER =
        process.env.MULTISAFEPAY_TEST_CARD_NUMBER || "4111111111111111";
      const CARD_CVC = process.env.MULTISAFEPAY_TEST_CARD_CVC || "123";
      const CARD_HOLDER =
        process.env.MULTISAFEPAY_TEST_CARD_HOLDER || "Token Tutorial";
      const METHOD = process.env.MULTISAFEPAY_TEST_METHOD || "Visa";

      // House convention: month 02, year = current year + 3.
      const EXPIRY_MONTH = "02";
      const expiryYearFull = String(new Date().getFullYear() + 3);
      const EXPIRY_YEAR_SHORT = expiryYearFull.slice(-2);

      console.log(
        `[MultiSafepay] Using test card ending in ${CARD_NUMBER.slice(-4)}, expiry ${EXPIRY_MONTH}/${EXPIRY_YEAR_SHORT}`,
      );

      // -- 1. Pick the payment method ------------------------------------
      const methodLabel = page
        .locator(`td span.rebrand-text:text-is("${METHOD}")`)
        .first();

      await methodLabel.waitFor({ state: "visible", timeout: 60000 });
      console.log(`✓ [MultiSafepay] "${METHOD}" method row located`);

      // Nearest activating ancestor: the row is usually an <a>, or a <tr> with
      // ng-click. A click on the span itself can be swallowed rather than
      // bubbling, so the ancestor is preferred and the span is the fallback.
      const clickable = methodLabel.locator(
        "xpath=ancestor-or-self::*[self::a or self::button or self::label or self::tr][1]",
      );

      if ((await clickable.count().catch(() => 0)) > 0) {
        const tag = await clickable
          .first()
          .evaluate((el) => el.tagName.toLowerCase());
        console.log(`[MultiSafepay] Clicking <${tag}> ancestor of the row`);
        await clickable
          .first()
          .scrollIntoViewIfNeeded()
          .catch(() => {});
        await clickable.first().click();
      } else {
        console.log(
          "[MultiSafepay] No clickable ancestor — clicking the label span itself",
        );
        await methodLabel.scrollIntoViewIfNeeded().catch(() => {});
        await methodLabel.click();
      }

      await page.waitForLoadState("domcontentloaded").catch(() => {});

      // -- 2. Wait for the card form -------------------------------------
      // Anchored on the number input rather than the form: <div gateway-form>
      // and #form-payment exist before the card template is compiled into them.
      const cardForm = page.locator("#form-payment");
      const numberInput = cardForm.locator('input[name="number"]');

      await numberInput
        .waitFor({ state: "visible", timeout: 45000 })
        .catch(async (err) => {
          // The row click may not have registered — Angular can swallow the
          // first click while the method list is still binding. Retried once
          // against the span directly before giving up.
          console.log(
            `⚠ [MultiSafepay] Card form not visible (${err.message}) — retrying the method click`,
          );
          await methodLabel.click({ force: true }).catch(() => {});
          await page.waitForLoadState("domcontentloaded").catch(() => {});
          await numberInput.waitFor({ state: "visible", timeout: 30000 });
        });

      console.log(`✓ [MultiSafepay] Card form reached: ${page.url()}`);

      // -- 3. Card number -------------------------------------------------
      // pressSequentially, not fill(): ng-card-number groups the digits and
      // detects the brand as you type, off input events that a single fill()
      // does not produce.
      await numberInput.click();
      await numberInput.fill("");
      await numberInput.pressSequentially(CARD_NUMBER, { delay: 60 });
      console.log(
        `✓ [MultiSafepay] Card number filled — value="${await numberInput.inputValue()}"`,
      );

      // -- 4. Cardholder --------------------------------------------------
      // The holder block is ng-if'd on the method, so it is filled only when
      // present and skipped without failing.
      const holderInput = cardForm.locator('input[name="holder"]');

      if ((await holderInput.count().catch(() => 0)) > 0) {
        await holderInput.click();
        await holderInput.fill(CARD_HOLDER);
        console.log(`✓ [MultiSafepay] Cardholder set to "${CARD_HOLDER}"`);
      } else {
        console.log(
          "ℓ [MultiSafepay] No cardholder field on this method — skipped",
        );
      }

      // -- 5. Expiry ------------------------------------------------------
      // selectOption() throws when NO option matches, so each candidate form is
      // tried in turn and the first that sticks wins. Order matters: the
      // Angular-typed value is the most specific, the label next, and position
      // last (index 0 is the "----" placeholder, so month N sits at index N).
      const selectWithFallback = async (select, label, candidates) => {
        for (const candidate of candidates) {
          const chosen = await select
            .selectOption(candidate.option)
            .then(() => true)
            .catch(() => false);

          if (chosen) {
            const value = await select.inputValue().catch(() => "(unreadable)");
            console.log(
              `✓ [MultiSafepay] ${label} selected via ${candidate.how} — value="${value}"`,
            );
            return;
          }

          console.log(
            `[MultiSafepay] ${label}: ${candidate.how} did not match — trying the next form`,
          );
        }

        const options = await select
          .locator("option")
          .evaluateAll((els) =>
            els.map((el) => ({ value: el.value, text: el.textContent.trim() })),
          )
          .catch(() => "(unreadable)");

        throw new Error(
          `[MultiSafepay] Could not select ${label}. Options present: ${JSON.stringify(options)}`,
        );
      };

      const monthSelect = cardForm.locator('select[name="expiry-month"]');
      await monthSelect.waitFor({ state: "visible", timeout: 30000 });

      await selectWithFallback(monthSelect, "Expiry month", [
        // number:2 — ng-value="02" bound as a number, so no leading zero.
        { how: 'value "number:2"', option: `number:${Number(EXPIRY_MONTH)}` },
        { how: 'value "02"', option: EXPIRY_MONTH },
        // Labels are localised ("02 - feb." under nl_NL, "02 - Feb" under
        // en_US), so matched on the leading digits only.
        {
          how: "label starting 02",
          option: { label: new RegExp(`^${EXPIRY_MONTH}\\b`) },
        },
        { how: "index", option: { index: Number(EXPIRY_MONTH) } },
      ]);

      const yearSelect = cardForm.locator('select[name="expiry-year"]');
      await yearSelect.waitFor({ state: "visible", timeout: 30000 });

      await selectWithFallback(yearSelect, "Expiry year", [
        // string:29 — ng-value="year.value", the two-digit year as a string.
        // The LABEL is the four-digit year, and that one is not localised.
        { how: 'value "string:29"', option: `string:${EXPIRY_YEAR_SHORT}` },
        { how: 'value "29"', option: EXPIRY_YEAR_SHORT },
        { how: `label "${expiryYearFull}"`, option: { label: expiryYearFull } },
        { how: 'value "2029"', option: expiryYearFull },
      ]);

      // -- 6. CVC ---------------------------------------------------------
      const cvcInput = cardForm.locator('input[name="cvc"]');
      await cvcInput.waitFor({ state: "visible", timeout: 30000 });
      await cvcInput.click();
      await cvcInput.fill("");
      await cvcInput.pressSequentially(CARD_CVC, { delay: 60 });
      console.log("✓ [MultiSafepay] CVC filled");

      console.log("✓ [MultiSafepay] Card details filled");
    },

    submitCardPayment: async (page) => {
      console.log("[MultiSafepay] Submitting the payment...");

      // input[type="submit"] inside #form-payment. The sibling "Terug" (back)
      // control is input[type="button"], so the type alone separates them — the
      // "Bevestig" label is language-dependent and is not used as a selector.
      const submitButton = page
        .locator('#form-payment input[type="submit"]')
        .first();

      await submitButton.waitFor({ state: "visible", timeout: 45000 });

      const startUrl = page.url();
      console.log(`[MultiSafepay] URL before submit: ${startUrl}`);

      await submitButton.scrollIntoViewIfNeeded().catch(() => {});
      await submitButton.click();
      console.log("[MultiSafepay] Confirm clicked");

      // ng-submit="paymentForm.$valid && confirm($event)" — an invalid field
      // means the handler never runs and there is NO navigation at all, just
      // the .help-block message under the offending input unhiding. So a
      // missing redirect is reported with those messages rather than as a bare
      // timeout.
      await page
        .waitForURL((url) => url.href !== startUrl, { timeout: 90000 })
        .catch(async () => {
          const messages = await page
            .locator("#form-payment p.help-block:visible span:visible")
            .allInnerTexts()
            .catch(() => []);

          const shown = messages.map((m) => m.trim()).filter(Boolean);

          console.log(
            `⚠ [MultiSafepay] Still on ${page.url()} 90s after the submit — no redirect observed.` +
              (shown.length
                ? ` Validation messages showing: ${JSON.stringify(shown)}`
                : " No validation message is visible, so the form was accepted and the gateway is still processing."),
          );
        });

      await page.waitForLoadState("domcontentloaded").catch(() => {});
      console.log(`[MultiSafepay] Post-payment URL: ${page.url()}`);
    },
  },

  Pesapal: {
    // Pesapal's sandbox iframe checkout:
    //   https://cybqa.pesapal.com/pesapaliframe/PesapalIframe3/Index?OrderTrackingId=<uuid>
    //
    // Named "PesapalIframe" because that is exactly how merchants embed it — on
    // some integrations it is an <iframe> inside the store page, on others a
    // full-page redirect. So the checkout is resolved with
    // waitForFrameByUrl("cybqa.pesapal.com") rather than waitForUrlPrefix():
    // page.frames() is a FLAT list that includes the main frame, so the same
    // lookup works either way, and every locator below is scoped to the frame
    // it returns.
    //
    // The page is one long jQuery/Foundation document — no hosted fields, no
    // nested frames of its own. Three parts, all in that one frame:
    //
    //   1. The method radios:
    //        <input class="paym pm0 btn-pcards" id="pcards" name="paym"
    //               type="radio" value="pcards">
    //      Checked with force: the radio itself is styled away behind its
    //      payment-icon label, so a plain click can land on a zero-size box.
    //      Selecting it unhides <div id="instpcards" class="pinstr">, which
    //      holds everything else.
    //
    //   2. Billing details (#firstname … #postalcode). Pesapal PREFILLS some of
    //      these from the order — #firstname arrives as "NA" and #emailaddress
    //      as the buyer address — so every field is cleared before typing
    //      rather than appended to.
    //
    //   3. Card details (#CardNumber, #expiryMonth, #expiryYear, #cvv) plus the
    //      #acceptterms checkbox, which is `required` — the form will not
    //      submit without it.
    //
    // Two traps worth naming:
    //
    // * #CountryCodeId carries class="chosen", i.e. jQuery Chosen replaces the
    //   native <select> with a div and hides the real control. selectOption()
    //   needs a visible element and fails there, so it falls back to setting
    //   .value in the page and firing change + chosen:updated — Pesapal's own
    //   handlers listen on change to swap #countryCodePrefix and to fetch the
    //   state list into #statecodeHolder.
    // * #statecodeHolder is EMPTY in the markup: the state <select> is injected
    //   by that change handler, and only for countries that have one (US, CA,
    //   …). It is therefore filled opportunistically and skipped without
    //   failing.
    //
    // The card panel also boots Cardinal Commerce (songbird.js) for 3-D Secure,
    // so after submit the flow can bounce through an ACS challenge before
    // returning — hence the long post-submit URL wait.
    fillCardDetails: async (page) => {
      console.log("Filling Pesapal hosted-iframe checkout...");

      const CARD_NUMBER =
        // Pesapal sandbox Visa, "No Authorization" row of its test-card list.
        // 4242… is a Stripe number and is declined here.
        process.env.PESAPAL_TEST_CARD_NUMBER || "4761739001010010";
      const CVV = process.env.PESAPAL_TEST_CARD_CVC || "123";
      const FIRST_NAME = process.env.PESAPAL_TEST_FIRST_NAME || "Token";
      const LAST_NAME = process.env.PESAPAL_TEST_LAST_NAME || "Tutorial";
      const EMAIL = process.env.PESAPAL_TEST_EMAIL || "test@example.com";
      const COUNTRY = process.env.PESAPAL_TEST_COUNTRY || "US";
      const STATE = process.env.PESAPAL_TEST_STATE || "CA";
      const PHONE = process.env.PESAPAL_TEST_PHONE || "6505551234";
      const ADDRESS =
        process.env.PESAPAL_TEST_ADDRESS || "1600 Amphitheatre Parkway";
      const CITY = process.env.PESAPAL_TEST_CITY || "Mountain View";
      const POSTAL_CODE = process.env.PESAPAL_TEST_POSTAL_CODE || "94043";

      // NOT the house 02/current+3 convention. Pesapal's sandbox only approves
      // the cards on its own test list (linked from the iframe as "a list of
      // test card details"), and each is published WITH a fixed expiry of
      // 07/28 — a card from that list with any other expiry comes back
      // "Payment Failed". Both selects carry plain values ("07", "2028"), so
      // no Angular-style typed values here.
      const EXPIRY_MONTH = process.env.PESAPAL_TEST_EXPIRY_MONTH || "07";
      const EXPIRY_YEAR = process.env.PESAPAL_TEST_EXPIRY_YEAR || "2028";

      console.log(
        `[Pesapal] Using test card ending in ${CARD_NUMBER.slice(-4)}, expiry ${EXPIRY_MONTH}/${EXPIRY_YEAR}`,
      );

      // -- 0. Resolve the checkout frame ---------------------------------
      const frame = await waitForFrameByUrl(page, "cybqa.pesapal.com", 90000);
      console.log(`✓ [Pesapal] Checkout frame: ${frame.url()}`);

      // waitForFrameByUrl() matches the moment the navigation COMMITS, so the
      // URL is already cybqa.pesapal.com while the document is still blank and
      // the jQuery handlers are unbound. Clicking #pcards then does nothing:
      // the radio flips, but the handler that unhides #instpcards is not
      // attached yet, so the panel wait times out on a page that looks fine.
      //
      // So the frame is given its load states first, then a fixed settle —
      // Pesapal pulls songbird.js (Cardinal) and Chosen after DOMContentLoaded,
      // and both rebind controls when they arrive. PESAPAL_REDIRECT_SETTLE_MS
      // widens it on a slow sandbox.
      await frame.waitForLoadState("domcontentloaded").catch(() => {});
      await frame.waitForLoadState("load").catch(() => {});

      const settleMs = Number(process.env.PESAPAL_REDIRECT_SETTLE_MS || 5000);
      console.log(
        `[Pesapal] Letting the checkout settle for ${settleMs}ms after the redirect...`,
      );
      await page.waitForTimeout(settleMs);

      // -- 1. Choose "Card" -----------------------------------------------
      // The method list is a <ul> of radio + label pairs:
      //   <li>
      //     <div class="float-left"><input id="pcards" name="paym" type="radio"
      //          class="paym pm0 btn-pcards" value="pcards" required></div>
      //     <label class="float-left" for="pcards">
      //       …visa.png / mastercard.png / amex.png…
      //     </label>
      //   </li>
      //
      // The LABEL is the real control: the radio is styled down to nothing
      // behind those brand images, and Pesapal's jQuery binds the panel-opening
      // handler to the label's click, so check({force:true}) on the input can
      // set .checked without ever unhiding #instpcards. The label is clicked
      // first, and the radio's own check() is only the fallback for when the
      // label is missing or covered.
      const cardRadio = frame.locator("#pcards");
      await cardRadio.waitFor({ state: "attached", timeout: 60000 });

      const cardLabel = frame.locator('label[for="pcards"]');

      if (await cardRadio.isChecked().catch(() => false)) {
        console.log("ℓ [Pesapal] Card method already selected");
      } else if (await cardLabel.isVisible().catch(() => false)) {
        await cardLabel.scrollIntoViewIfNeeded().catch(() => {});
        await cardLabel.click();
        console.log('✓ [Pesapal] Clicked the card-brands label[for="pcards"]');
      } else {
        console.log(
          '[Pesapal] No visible label[for="pcards"] — falling back to checking the radio itself',
        );
        await cardRadio.check({ force: true });
      }

      // The panel is toggled by that handler's jQuery show(), so it is waited
      // on rather than assumed — everything below lives inside it. A click that
      // landed on the images but not the label leaves the radio checked and the
      // panel shut, so the retry goes through the radio's check() (which fires
      // change, the other event Pesapal binds) before giving up.
      const panel = frame.locator("#instpcards");

      await panel
        .waitFor({ state: "visible", timeout: 30000 })
        .catch(async (err) => {
          console.log(
            `⚠ [Pesapal] Card panel still hidden (${err.message}) — retrying via the radio`,
          );

          await cardRadio.check({ force: true }).catch(() => {});
          await cardRadio.dispatchEvent("change").catch(() => {});
          await panel.waitFor({ state: "visible", timeout: 30000 });
        });

      console.log("✓ [Pesapal] Card details panel open");

      // Clear-then-type: Pesapal prefills #firstname ("NA") and #emailaddress
      // from the order, so fill("") first or the value is appended to.
      const typeField = async (selector, label, value, { optional } = {}) => {
        const input = frame.locator(selector);

        const present = await input
          .waitFor({ state: "visible", timeout: optional ? 8000 : 30000 })
          .then(() => true)
          .catch(() => false);

        if (!present) {
          if (optional) {
            console.log(`ℓ [Pesapal] No ${label} field rendered — skipped`);
            return false;
          }

          throw new Error(
            `[Pesapal] Timed out waiting for the ${label} field (${selector})`,
          );
        }

        await input.scrollIntoViewIfNeeded().catch(() => {});
        await input.click();
        await input.fill("");
        await input.pressSequentially(value, { delay: 50 });
        console.log(`✓ [Pesapal] ${label} entered`);
        return true;
      };

      // selectOption() requires a VISIBLE control, which a Chosen-managed
      // select is not — so a failure falls back to setting the value in the
      // page and firing the events Pesapal's own handlers listen for.
      const selectField = async (selector, label, value, { optional } = {}) => {
        const select = frame.locator(selector);

        const present = await select
          .waitFor({ state: "attached", timeout: optional ? 8000 : 30000 })
          .then(() => true)
          .catch(() => false);

        if (!present) {
          if (optional) {
            console.log(`ℓ [Pesapal] No ${label} select rendered — skipped`);
            return false;
          }

          throw new Error(
            `[Pesapal] Timed out waiting for the ${label} select (${selector})`,
          );
        }

        const picked = await select
          .selectOption(value)
          .then(() => true)
          .catch(() => false);

        if (!picked) {
          console.log(
            `[Pesapal] ${label}: selectOption() did not take (hidden behind Chosen?) — setting the value directly`,
          );

          await select.evaluate((el, v) => {
            el.value = v;
            el.dispatchEvent(new Event("change", { bubbles: true }));

            if (window.jQuery) {
              window.jQuery(el).trigger("change").trigger("chosen:updated");
            }
          }, value);
        }

        const applied = await select.inputValue().catch(() => "(unreadable)");

        if (applied !== value) {
          const options = await select
            .locator("option")
            .evaluateAll((els) => els.map((el) => el.value))
            .catch(() => "(unreadable)");

          throw new Error(
            `[Pesapal] ${label} did not take "${value}" (reads "${applied}"). Options present: ${JSON.stringify(options)}`,
          );
        }

        console.log(`✓ [Pesapal] ${label} set to "${applied}"`);
        return true;
      };

      // -- 2. Billing details ---------------------------------------------
      await typeField("#firstname", "First name", FIRST_NAME);
      await typeField("#lastname", "Last name", LAST_NAME);
      await typeField("#emailaddress", "Email", EMAIL);

      // The country change repaints #countryCodePrefix and fetches the state
      // list, so it goes before the phone and state fields.
      await selectField("#CountryCodeId", "Country", COUNTRY);
      await page.waitForTimeout(1500);

      // #countryCodePrefix is disabled and set by that handler — never typed
      // into, so the number goes in WITHOUT its dialling code.
      await typeField("#cphonenumber", "Phone number", PHONE);
      await typeField("#line1", "Address line 1", ADDRESS);
      await typeField("#cityname", "City", CITY);
      await typeField("#postalcode", "Postal code", POSTAL_CODE);

      // Injected into the empty #statecodeHolder only for countries with a
      // region list — matched through the container rather than by id, because
      // the injected control's own id varies with the country.
      await selectField("#statecodeHolder select", "State", STATE, {
        optional: true,
      });

      // -- 3. Card ---------------------------------------------------------
      await typeField("#CardNumber", "Card number", CARD_NUMBER);
      await selectField("#expiryMonth", "Expiry month", EXPIRY_MONTH);
      await selectField("#expiryYear", "Expiry year", EXPIRY_YEAR);
      await typeField("#cvv", "CVV", CVV);

      // -- 4. Terms ---------------------------------------------------------
      // required="" — the form will not submit without it. Forced for the same
      // reason as the radio: the visible control is the styled label. Matched
      // by id, never by name: a sibling
      // <input type="hidden" name="acceptterms" value="false"> shares the name.
      const terms = frame.locator("#acceptterms");
      await terms.waitFor({ state: "attached", timeout: 30000 });

      if (!(await terms.isChecked().catch(() => false))) {
        await terms.check({ force: true });
        console.log("✓ [Pesapal] Terms and conditions accepted");
      }

      console.log("✓ [Pesapal] Billing and card details filled");
    },

    submitCardPayment: async (page) => {
      console.log("[Pesapal] Submitting the payment...");

      const frame = await waitForFrameByUrl(page, "cybqa.pesapal.com", 45000);

      // The submit control is labelled "Proceed" and sits OUTSIDE #instpcards —
      // one shared button below the whole method list, not one per panel — so
      // the page-level candidate is the one that matches today. The narrower
      // in-panel candidates are kept ahead of it: they are the right target if
      // Pesapal moves the button into the card panel, and each miss costs a
      // single isVisible() check.
      // Candidates are tried in order of specificity — a real submit inside the
      // open card panel first, then the page-level one — and whichever matches
      // is logged, so a Pesapal template change surfaces as a named control
      // rather than a bare timeout.
      const candidates = [
        {
          how: "submit control inside #instpcards",
          locator: frame.locator(
            '#instpcards button[type="submit"], #instpcards input[type="submit"]',
          ),
        },
        {
          how: "button labelled Pay/Confirm inside #instpcards",
          locator: frame
            .locator("#instpcards button, #instpcards a.button")
            .filter({ hasText: /\b(pay|proceed|confirm|submit|continue)\b/i }),
        },
        {
          how: "page-level submit control",
          locator: frame.locator('button[type="submit"], input[type="submit"]'),
        },
      ];

      let payButton = null;
      let how = null;

      for (const candidate of candidates) {
        const visible = await candidate.locator
          .first()
          .isVisible()
          .catch(() => false);

        if (visible) {
          payButton = candidate.locator.first();
          how = candidate.how;
          break;
        }

        console.log(
          `[Pesapal] No match for the ${candidate.how} — trying the next`,
        );
      }

      if (!payButton) {
        const controls = await frame
          .locator('button, input[type="submit"], input[type="button"]')
          .evaluateAll((els) =>
            els.map((el) => ({
              tag: el.tagName.toLowerCase(),
              id: el.id,
              type: el.type,
              label: (el.value || el.textContent || "").trim().slice(0, 40),
            })),
          )
          .catch(() => "(unreadable)");

        throw new Error(
          `[Pesapal] No submit control found. Controls present: ${JSON.stringify(controls)}`,
        );
      }

      const label = await payButton
        .evaluate((el) => (el.value || el.textContent || "").trim())
        .catch(() => "(unreadable)");

      console.log(`[Pesapal] Submitting via the ${how} — label "${label}"`);

      const startUrl = page.url();
      console.log(`[Pesapal] URL before submit: ${startUrl}`);

      await payButton.scrollIntoViewIfNeeded().catch(() => {});
      await payButton.click();
      console.log("[Pesapal] Pay clicked");

      // Client-side validation unhides the .invalid-data spans
      // (#invalid-card-number, #invalid-card-expiry-date, #invalid-cvv) and
      // stops the POST dead — no navigation at all. And even on success there
      // is no single redirect: Cardinal may run a 3-D Secure challenge first,
      // so this waits for ANY URL change and reports the validation messages
      // when none comes.
      await page
        .waitForURL((url) => url.href !== startUrl, { timeout: 120000 })
        .catch(async () => {
          const messages = await frame
            .locator(
              ".invalid-data:visible, .validation-summary-errors:visible",
            )
            .allInnerTexts()
            .catch(() => []);

          const shown = messages.map((m) => m.trim()).filter(Boolean);

          console.log(
            `⚠ [Pesapal] Still on ${page.url()} 120s after the submit — no redirect observed.` +
              (shown.length
                ? ` Validation messages showing: ${JSON.stringify(shown)}`
                : " No validation message is visible, so the form was accepted and Pesapal (or the 3-D Secure step) is still processing."),
          );
        });

      await page.waitForLoadState("domcontentloaded").catch(() => {});
      console.log(`[Pesapal] Post-payment URL: ${page.url()}`);
    },
  },
  // Niubiz (VisaNet Peru) hosted secure-form checkout.
  //
  // Niubiz does not drop you straight onto a card form. Its "j-secure-form"
  // renders inside an iframe over the merchant page and can open on a
  // payment-method chooser first: you pick "Credit and debit card"
  // (#payment-tarjeta) and press Continue (#payment-continue) before the card
  // fields (#number, #expiry, #cvc, #name, #lastname, #email) appear. That
  // extra step is why a naive fill "doesn't redirect" -- the card inputs are
  // not on screen yet. This handler resolves the Niubiz frame, takes the
  // chooser step when it is present (and quietly skips it when the form opened
  // straight onto the card fields), fills the card, then submits.
  //
  // The test card is Niubiz-sandbox-specific -- a Stripe-style 4111... will not
  // authorize. Set the real sandbox card via NIUBIZ_TEST_* in .env; the
  // defaults below are placeholders to verify.
  Niubiz: {
    fillCardDetails: async (page) => {
      console.log("Filling Niubiz hosted secure-form checkout...");

      const CARD_NUMBER =
        process.env.NIUBIZ_TEST_CARD_NUMBER || "4474918215215480";
      const CVV = process.env.NIUBIZ_TEST_CARD_CVC || "123";
      const FIRST_NAME = process.env.NIUBIZ_TEST_FIRST_NAME || "Token";
      const LAST_NAME = process.env.NIUBIZ_TEST_LAST_NAME || "Tutorial";
      const EMAIL = process.env.NIUBIZ_TEST_EMAIL || "test@example.com";
      const CITY = process.env.NIUBIZ_TEST_CITY || "Lima";
      const COUNTRY = process.env.NIUBIZ_TEST_COUNTRY || "Peru";

      // #expiry is a single MM/YY field. Default to a comfortably future date;
      // override with the expiry Niubiz publishes for the sandbox card.
      const EXPIRY_MONTH = process.env.NIUBIZ_TEST_EXPIRY_MONTH || "12";
      const EXPIRY_YEAR =
        process.env.NIUBIZ_TEST_EXPIRY_YEAR ||
        String(new Date().getFullYear() + 3).slice(-2);
      const EXPIRY = `${EXPIRY_MONTH}/${EXPIRY_YEAR}`;

      console.log(
        `[Niubiz] Using test card ending in ${CARD_NUMBER.slice(-4)}, expiry ${EXPIRY}`,
      );

      // -- 0. Resolve the Niubiz form frame -------------------------------
      // The secure form is iframed from Niubiz, so the fields live in a child
      // frame, not the merchant page. Match on presence (count > 0), not
      // visibility: #number exists in the DOM even while the method chooser is
      // the visible view, and the main frame is scanned too in case a profile
      // renders the form inline.
      const resolveFrame = async (marker, timeout = 90000) => {
        const deadline = Date.now() + timeout;
        while (Date.now() < deadline) {
          for (const frame of page.frames()) {
            const count = await frame
              .locator(marker)
              .count()
              .catch(() => 0);
            if (count > 0) {
              const where =
                frame === page.mainFrame() ? "main frame" : frame.url();
              console.log(`[Niubiz] "${marker}" found in: ${where}`);
              return frame;
            }
          }
          await page.waitForTimeout(500);
        }
        return null;
      };

      const frame = await resolveFrame("#number");
      if (!frame) {
        throw new Error(
          "[Niubiz] Timed out waiting for the secure form (no frame contained #number). " +
            `Frames present:\n${page
              .frames()
              .map((f) => `  - ${f.url()}`)
              .join("\n")}`,
        );
      }

      await frame.waitForLoadState("domcontentloaded").catch(() => {});

      // -- 1. Payment-method chooser (only when it is the open view) ------
      // #payment-tarjeta is the "Credit and debit card" radio; #payment-continue
      // moves from the chooser to the card form. When Niubiz opened straight
      // onto the card fields, neither is visible and this whole step is skipped.
      const cardRadio = frame.locator("#payment-tarjeta");
      const continueBtn = frame.locator("#payment-continue");

      const chooserVisible = await cardRadio.isVisible().catch(() => false);

      if (chooserVisible) {
        console.log(
          '[Niubiz] Method chooser is open -- selecting "Credit and debit card"',
        );
        await cardRadio.scrollIntoViewIfNeeded().catch(() => {});
        await cardRadio.check({ force: true }).catch(async () => {
          // The radio is styled behind a label; click the label if check() is
          // swallowed.
          await frame
            .locator("label:has(#payment-tarjeta)")
            .click()
            .catch(() => {});
        });
        console.log("Card method selected");

        if (await continueBtn.isVisible().catch(() => false)) {
          await continueBtn.scrollIntoViewIfNeeded().catch(() => {});
          await continueBtn.click();
          console.log("Clicked Continue");
        }

        // The card form is toggled in by Niubiz's own handler; wait for the
        // number field to actually surface before typing.
        await frame
          .locator("#number")
          .waitFor({ state: "visible", timeout: 30000 });
      } else {
        console.log("[Niubiz] No method chooser -- card form already open");
        await frame
          .locator("#number")
          .waitFor({ state: "visible", timeout: 30000 });
      }

      // -- 2. Fill the card fields ----------------------------------------
      // pressSequentially, not fill(): Niubiz runs keyup handlers (card-brand
      // detection on #number, MM/YY masking on #expiry) that a single fill()
      // value would bypass, leaving the field visually set but internally
      // unvalidated.
      const typeField = async (selector, label, value, { optional } = {}) => {
        const input = frame.locator(selector);

        const present = await input
          .waitFor({ state: "visible", timeout: optional ? 6000 : 30000 })
          .then(() => true)
          .catch(() => false);

        if (!present) {
          if (optional) {
            console.log(`[Niubiz] No ${label} field rendered -- skipped`);
            return false;
          }
          throw new Error(
            `[Niubiz] Timed out waiting for the ${label} field (${selector})`,
          );
        }

        await input.scrollIntoViewIfNeeded().catch(() => {});
        await input.click();
        await input.fill("");
        await input.pressSequentially(value, { delay: 50 });
        console.log(`[Niubiz] ${label} filled`);
        return true;
      };

      await typeField("#number", "card number", CARD_NUMBER);
      await typeField("#expiry", "expiry", EXPIRY);
      await typeField("#cvc", "CVV", CVV);
      await typeField("#name", "first name", FIRST_NAME);
      await typeField("#lastname", "last name", LAST_NAME);
      await typeField("#email", "email", EMAIL, { optional: true });

      // International billing address. For cross-border card payments (e.g. the
      // USD flow) Niubiz shows the #international block with #city / #country
      // REQUIRED, and leaves them flagged invalid until filled -- an otherwise
      // complete form then never submits and "doesn't redirect". Optional here
      // because a domestic (PEN) profile hides the block entirely.
      await typeField("#city", "city", CITY, { optional: true });
      await typeField("#country", "country", COUNTRY, { optional: true });

      console.log("Niubiz card details filled");
    },

    submitCardPayment: async (page) => {
      console.log("Submitting Niubiz card payment...");

      // Re-resolve the frame: submitCardPayment runs as its own step, so it
      // cannot rely on a frame handle from fillCardDetails.
      const findFrame = async (marker, timeout = 30000) => {
        const deadline = Date.now() + timeout;
        while (Date.now() < deadline) {
          for (const frame of page.frames()) {
            if (
              (await frame
                .locator(marker)
                .count()
                .catch(() => 0)) > 0
            ) {
              return frame;
            }
          }
          await page.waitForTimeout(500);
        }
        return null;
      };

      const frame =
        (await findFrame("button.j-secure-form-submit")) || page.mainFrame();

      const startUrl = page.url();

      // The "Pay US$..." button carries j-secure-form-submit; the chooser's
      // Continue button (j-secure-form-payment-method) is a different control.
      const payButton = frame.locator("button.j-secure-form-submit");
      await payButton.waitFor({ state: "visible", timeout: 30000 });
      await payButton.scrollIntoViewIfNeeded().catch(() => {});
      await payButton.click();
      console.log("Niubiz Pay button clicked");

      // Niubiz processes then redirects the MERCHANT page (the parent), and may
      // run a 3-D Secure challenge first, so there is no single guaranteed
      // redirect URL -- wait for any navigation away from the checkout and
      // report if none comes rather than failing hard.
      await page
        .waitForURL((url) => url.href !== startUrl, { timeout: 120000 })
        .then(() => console.log(`[Niubiz] Post-payment URL: ${page.url()}`))
        .catch(() =>
          console.log(
            `[Niubiz] Still on ${page.url()} 120s after submit -- no redirect observed. ` +
              "If the card was rejected, set the correct NIUBIZ_TEST_CARD_NUMBER / " +
              "NIUBIZ_TEST_EXPIRY_* / NIUBIZ_TEST_CARD_CVC in .env.",
          ),
        );

      await page.waitForLoadState("domcontentloaded").catch(() => {});
    },
  },
  // Shift4's hosted checkout page:
  //   https://pay.shift4.com/chcs_<checkout session token>
  //
  // Two layers. "Customer details" and "Card details > Cardholder name" are
  // ordinary main-frame inputs (#input_email, #input_billingName), while the
  // card NUMBER, EXPIRY and CVC are Shift4 Components -- each one its own
  // iframe served from js.dev.shift4.com/.../frames/shift4/component.html, so
  // page.locator() can never see them.
  //
  // The three component iframes are told apart by their `title` attribute
  // ("number", "expiry", "cvc") rather than by their `name`
  // (__privateShift4Frame0/1/2) or their src. The names are allocated in frame
  // CREATION order, which is not the visual order and shifts if Shift4 adds a
  // component (postal code, for one, is optional per account); the src is a
  // single base64 blob carrying a per-session referrer, so nothing in it is
  // stable across runs. The title is what the component is.
  //
  // Inside a component frame the real input sits among Input--fake decoys and
  // aria-hidden probes, and the first input in DOM order is one of the decoys
  // -- see typeIntoComponent() below for how it is picked out, and for why the
  // fields are fill()ed rather than clicked and typed into.
  // Beside every iframe the form also carries
  //   <input class="__privateShift4Input" aria-hidden="true" opacity:0>
  // which is a focus-proxy decoy: filling it does nothing and it is invisible
  // to the tokeniser. Scoping to the frame is what keeps it out of reach.
  //
  // CRITICAL: none of this is in the top-level page. pay.shift4.com only hosts
  // a shell; the whole form -- email, cardholder, the component iframes and
  // the Pay button -- is iframed in from
  // js.<env>.shift4.com/checkout/component.html (it is that page that the
  // component frames name as their `referrer`). So page.locator("#input_email")
  // matches NOTHING however long it waits, and a run that submits anyway gets
  // back exactly what the empty form reports: "This field must not be empty."
  // under Email with every Shift4Component still marked --empty.
  //
  // The form frame is resolved by CONTENT (whichever frame owns #input_email)
  // rather than by URL: the checkout bundle is served from js.dev.shift4.com in
  // sandbox and js.shift4.com in production, and page.frames() is flat, so the
  // same scan finds it at either host -- and still works if Shift4 ever stops
  // iframing and the fields land in the main frame after all.
  Shift4: {
    fillCardDetails: async (page) => {
      console.log("Filling Shift4 hosted checkout card details...");

      await waitForHostedRedirectOrCheckoutError(
        page,
        "https://pay.shift4.com/",
        "Shift4",
        60000,
      );

      const CARD_NUMBER =
        process.env.SHIFT4_TEST_CARD_NUMBER || "4242424242424242";
      const CARD_CVC = process.env.SHIFT4_TEST_CARD_CVC || "123";
      const CARD_HOLDER =
        process.env.SHIFT4_TEST_CARD_HOLDER || "Token Tutorial";
      const EMAIL = process.env.SHIFT4_TEST_EMAIL || "test@example.com";

      // Hardcoded, not derived from the clock: a fixed date is what the run
      // can be reasoned about later, and the sandbox does not care how far out
      // it is as long as it is in the future. Bump the year when it stops
      // being one. The expiry component masks what it is given into "02 / 29",
      // so the four digits go in unseparated and the mask does the rest.
      const EXPIRY = "0229"; // 02 / 29

      console.log(
        `[Shift4] Using test card ending in ${CARD_NUMBER.slice(-4)}, expiry ${EXPIRY.slice(0, 2)}/${EXPIRY.slice(2)}`,
      );

      // -- 0. Resolve the checkout form frame ------------------------------
      // Everything below is scoped to this frame. #input_email is the anchor
      // because it is the first field the form renders and it is never
      // conditional, unlike the cardholder block.
      const formFrame = await waitForFrameWithSelector(
        page,
        "#input_email",
        60000,
      );
      console.log(`✓ [Shift4] Checkout form frame: ${formFrame.url()}`);

      // -- 1. Customer details ---------------------------------------------
      // Rendered above the card block as a plain controlled React input, so
      // fill() is enough here.
      const emailInput = formFrame.locator("#input_email");
      await emailInput.waitFor({ state: "visible", timeout: 60000 });
      await emailInput.click();
      await emailInput.fill(EMAIL);
      console.log(`✓ [Shift4] Email set to "${EMAIL}"`);

      // -- 2. Cardholder name ----------------------------------------------
      const holderInput = formFrame.locator("#input_billingName");
      await holderInput.waitFor({ state: "visible", timeout: 30000 });
      await holderInput.click();
      await holderInput.fill(CARD_HOLDER);
      console.log(`✓ [Shift4] Cardholder set to "${CARD_HOLDER}"`);

      // -- 3. The three Shift4 Components ----------------------------------
      // fill(), not clicks and not page.keyboard. Established by running it:
      //
      //   [Shift4] number: focused=false before typing
      //   ⚠ number still reads "" after click + keyboard
      //   ⚠ number still reads "" after pressSequentially
      //   ✓ number filled via fill — value="4242 4242 4242 4242"
      //
      // Two things came out of that. The component never takes focus from a
      // click (focused=false), so page.keyboard.type() sends the digits to
      // whatever IS focused -- the cardholder box, which is how the card
      // number ended up inside the name field. And fill() is accepted: the
      // value came back masked and grouped ("4242 4242 4242 4242"), which is
      // the component's own formatter having run, so it did see the input.
      //
      // Clicking is worse than useless here: the field container sits over the
      // iframe and takes the pointer events itself
      // ("<div class=shift4__field__container> intercepts pointer events"), so
      // a click can only ever time out. Nothing below clicks or uses the
      // page-level keyboard.
      const typeIntoComponent = async (title, value) => {
        // Nested one level deeper: the component iframes are children of the
        // form frame, not of the page.
        const frame = formFrame.frameLocator(`iframe[title="${title}"]`);

        // A component frame holds several inputs and only one is real. The
        // decoys are class="Input--fake" -- autofill bait, one before the real
        // input and one after -- plus, in the number frame, a few aria-hidden
        // probes the formatter measures text with.
        //
        // Matched by ACCESSIBLE NAME, which is the only thing that identifies
        // the real one. Filtering on [disabled] was the earlier attempt and it
        // does not hold: the fakes are disabled in the number frame but NOT in
        // the expiry frame, where `input:not([disabled])` picked
        // <input class="Input--fake"> and sat on it until the timeout.
        //
        // The names are regexes, not exact strings: the CVC field renames
        // itself after the brand ("Card verification code for unknown" before
        // a number is typed, "... for visa" after). The class filter is kept
        // behind an .or() so a renamed label degrades to the old behaviour
        // instead of failing outright.
        const NAMES = {
          number: /card number/i,
          expiry: /expiry|expiration/i,
          cvc: /verification code|cvc|cvv|security code/i,
        };

        const input = frame
          .getByRole("textbox", { name: NAMES[title] })
          .or(
            frame.locator(
              'input:not([class*="Input--fake"]):not([aria-hidden="true"])',
            ),
          )
          .first();

        await input.waitFor({ state: "visible", timeout: 45000 });

        // Whether the field kept the digits, whatever the mask did with them:
        // the expiry renders "0229" as "02 / 29" and the number groups itself
        // in fours, so only the digits can be compared.
        const digitsOf = (text) => (text || "").replace(/\D/g, "");
        const wanted = digitsOf(value);

        const held = async () => {
          const shown = await input.inputValue().catch(() => "");
          return { shown, ok: digitsOf(shown) === wanted };
        };

        // fill() first because it is the one that works. pressSequentially()
        // is kept as the fallback for a component that ever stops accepting a
        // one-shot value -- it also addresses the element directly, so like
        // fill() it cannot end up typing into a different field.
        const attempts = [
          { how: "fill", run: () => input.fill(value) },
          {
            how: "pressSequentially",
            run: async () => {
              await input.focus().catch(() => {});
              await input.fill("").catch(() => {});
              await input.pressSequentially(value, { delay: 80 });
            },
          },
        ];

        for (const attempt of attempts) {
          await attempt.run();

          // The components echo the value back asynchronously (each posts its
          // state to the parent), so the field is re-read for a moment rather
          // than once, or a slow echo reads as a failed attempt.
          let state = await held();

          for (let i = 0; i < 6 && !state.ok; i += 1) {
            await page.waitForTimeout(300);
            state = await held();
          }

          if (state.ok) {
            console.log(
              `✓ [Shift4] ${title} filled via ${attempt.how} — value="${state.shown}"`,
            );
            return;
          }

          console.log(
            `⚠ [Shift4] ${title} still reads "${state.shown}" after ${attempt.how}`,
          );
        }

        throw new Error(
          `[Shift4] Could not get "${value}" into the ${title} component — it still ` +
            `reads empty after both fill() and pressSequentially(). The input being ` +
            `written to is not the one the component reads: check what ` +
            `iframe[title="${title}"] now calls its field, since it is matched on the ` +
            `accessible name (${NAMES[title]}) with the Input--fake filter behind it.`,
        );
      };

      await typeIntoComponent("number", CARD_NUMBER);
      await typeIntoComponent("expiry", EXPIRY);
      await typeIntoComponent("cvc", CARD_CVC);

      // The cardholder box is re-read because it is what collected the stray
      // digits when the components were being typed into with the page
      // keyboard. Nothing types blind any more, so this should never fire --
      // but it costs one read, and the alternative is a run that pays with
      // "Token Tutorial4242424242424242" as the name on the card.
      const holderNow = await holderInput.inputValue().catch(() => CARD_HOLDER);

      if (holderNow !== CARD_HOLDER) {
        console.log(
          `⚠ [Shift4] Cardholder had become "${holderNow}" — restoring "${CARD_HOLDER}"`,
        );
        await holderInput.fill(CARD_HOLDER);
      }

      // The components mark themselves valid asynchronously (each posts its
      // state back to the parent), and clicking Pay before that lands is what
      // produces the spurious "CVC is required." -- so give the page a beat to
      // settle rather than racing straight into submitCardPayment().
      await page.waitForTimeout(1000);

      // Any field Shift4 has already rejected renders its reason in
      // p.shift4__field__error under the offending box. Surfaced here, while
      // the form is still on screen, rather than being discovered as a silent
      // non-navigation after the Pay click.
      const errors = await formFrame
        .locator("p.shift4__field__error:visible")
        .allInnerTexts()
        .catch(() => []);

      if (errors.length > 0) {
        console.log(
          `⚠ [Shift4] Field errors showing before submit: ${errors.join(" | ")}`,
        );
      }

      console.log("✓ [Shift4] Card details filled");
    },

    submitCardPayment: async (page) => {
      console.log("[Shift4] Submitting the payment...");

      // <button type="submit" id="pay">Pay 3300.00 USD</button> -- matched on
      // the id, never on the label: the label carries the amount and currency
      // and so differs on every run.
      //
      // It sits in the same iframed form as the fields (see the note above the
      // gateway), so the frame is resolved again here rather than being carried
      // over: submitCardPayment() is called as its own step and the frame
      // object from fillCardDetails() is not in scope -- and re-resolving also
      // survives the form frame being re-created between the two.
      const formFrame = await waitForFrameWithSelector(
        page,
        "button#pay",
        45000,
      );
      const payButton = formFrame.locator("button#pay").first();
      await payButton.waitFor({ state: "visible", timeout: 45000 });

      const startUrl = page.url();
      console.log(`[Shift4] URL before submit: ${startUrl}`);

      await payButton.scrollIntoViewIfNeeded().catch(() => {});
      await payButton.click();
      console.log("[Shift4] Pay clicked");

      // Shift4 tokenises in the components, charges, and may run a 3-D Secure
      // challenge before handing back to the return URL -- several round trips
      // after the click, not one navigation. A rejected field instead keeps the
      // page put and only unhides its .shift4__field__error text, so a missing
      // redirect is reported with those messages rather than as a bare timeout.
      await page
        .waitForURL((url) => url.href !== startUrl, { timeout: 120000 })
        .then(() => console.log(`[Shift4] Post-payment URL: ${page.url()}`))
        .catch(async () => {
          const messages = await formFrame
            .locator("p.shift4__field__error:visible")
            .allInnerTexts()
            .catch(() => []);

          console.log(
            `⚠ [Shift4] Still on ${page.url()} 120s after submit — no redirect observed.` +
              (messages.length > 0
                ? ` The form is reporting: ${messages.join(" | ")}`
                : " No field error is showing, so the charge itself was likely declined."),
          );
        });

      await page.waitForLoadState("domcontentloaded").catch(() => {});
    },
  },
};
