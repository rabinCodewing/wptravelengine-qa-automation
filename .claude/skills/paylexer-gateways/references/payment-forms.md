# How a gateway pays: auto-detect, recipe, code

The three ways a run fills and submits a gateway's payment form, in the order
`config/paymentForms.js` tries them, and how to write each.

## Contents
- Part A: Which one a run uses
- Part B: Auto-detect (no setup)
- Part C: Recipes (steps as data)
- Part D: Code (patterns, helpers, skeleton, house rules)

---

# Part A: Which one a run uses

| The gateway has… | The run uses |
| --- | --- |
| code in `config/gatewayPaymentForms.js` | the code |
| code, and a recipe with `"useInsteadOfCode": true` | the recipe (to try a recipe in place of code) |
| … plus `"auto": true` | auto-detect (to try auto-detect in place of code) |
| a recipe with `fill`/`submit` steps, no code | the recipe |
| neither, or a recipe with only a `card` | auto-detect, paying with that card |
| a recipe with `"noCardForm": true` | no card entry: the flow continues straight after Place Order |

Recipes live in `data/gateways.json` (git-ignored, written by the UI's
Credentials tab) under `paymentForms.<GatewayName>`. Each run reads the file
when it starts, so edits need no restart. The run's setup steps show which
method paid: **Payment form: recipe** or **Payment form: auto-detected**
(code shows nothing extra).

## The test card, for recipes and auto-detect

First found wins:
1. `paymentForms.<Name>.card` in `data/gateways.json`: `{ "number", "expiry" (MMYY or MM/YY), "cvc", "name", "email", "postal", "phone", "otp" }`
2. `<PREFIX>_TEST_CARD_NUMBER`, `_TEST_CARD_EXPIRY`, `_TEST_CARD_CVV` in the environment (`.env`). PREFIX is the gateway name upper-cased: `BLUESNAP_`. Code entries read the same names.
3. Defaults: Visa `4242424242424242`, expiry 02 / current year + 3, CVC `123`, OTP `123456`.

The run logs which source it used. Most sandboxes approve only their own
documented cards, so set 1 or 2 for every new gateway.

---

# Part B: Auto-detect

`config/paymentAuto.js`. It runs for any gateway without code or recipe steps.

**Where it looks:** every frame of the payment page and of pages opened after
it (popups, hosted-checkout tabs). Nested and cross-origin iframes are
included. Tabs that were already open (wp-admin, PayLexer) are never searched.

**What it fills.** Only visible, enabled inputs and selects: never radios,
checkboxes or hidden fields. Each field is tried precise-first: autofill hints,
then ids and names, then placeholder and aria text, then the visible label.

| Field | Matched by (precise → loose) |
| --- | --- |
| card number | `autocomplete="cc-number"`, Stripe's `data-elements-stable-field-name`, name/id containing `cardnumber` / `card_number` / `card-number`, `name="number"`/`"pan"`, placeholder "card number" / "1234 1234", label "Card number" |
| expiry | one field (`cc-exp`, name/id `expiry`/`expiration`, placeholder `MM / YY`), or month + year fields (`cc-exp-month`/`-year`, selects named `month`/`year`) |
| CVC | `cc-csc`, name/id containing `cvc`/`cvv`/`csc`/`securityCode`, placeholder "CVC"/"CVV", label "Security code" |
| name / email / postal | filled **only when empty** (the booking pre-fills them) |
| mobile number | filled **only when empty**, and only in the card form's own form/dialog (Arca's modal). Value: `card.phone`, or `<PREFIX>_TEST_PHONE`, else the field's placeholder example, else 4155550123 |

**How it types:** key by key, so formatting fields work. A one-field expiry
gets `MMYY`, and is retyped as `MM/YY` if the field kept no separator its
placeholder asks for.

**Timing:** waits up to 90s for the card number, since hosted forms mount late
inside iframes. "CVC only" mode (pre-filled test pages like Fatora) kicks in
only after 30s, and only for a CVC matched by id/name/autofill hint with no
card-number field attached anywhere.

**Pay button:** a visible button reading "Pay", "Pay now", "Pay $10.00",
"Submit payment", "Confirm", "Complete order"… and not "Cancel", "Back",
"Apply coupon", "Login". "Pay…" wins over "Submit".

**After Pay:** 3-D Secure / OTP is handled only where a challenge can be: a
frame whose URL says `3ds`/`acs`/`challenge`/`authenticat`/`otp`, or a page the
flow moved to. It types the card's OTP and clicks Submit / Complete /
Authenticate, up to three rounds. It never looks at the card form itself,
whose "security code" isn't an OTP box.

**Its log** (in the run log, one line each) is the starting point for a
recipe when it guesses wrong:
```
[Acme auto] card number: #CC-cardNumber (id/name) in frame https://sandpay.bluesnap.com/…
[Acme auto] expiry: #CC-expirationDate (id/name)
[Acme auto] CVC: #CC-securityCode (id/name)
[Acme auto] pay button: "Pay"
```
**When it can't find a form** it fails with "Auto-detect found no card form
… Frames present: …". That means a recipe is needed, or the gateway pays
without a card (see `noCardForm` in Part A).

---

# Part C: Recipes

## A recipe

```json
{
  "card":   { "number": "5425233430109903", "expiry": "0429", "cvc": "837" },
  "fill":   [ steps that fill the card form ],
  "submit": [ steps that pay and check it worked ]
}
```

`fill` runs where a code entry's `fillCardDetails()` would, and `submit`
where its `submitCardPayment()` would. Steps run in order. Each waits for its
target, does one thing, and logs one line (`✓ [BlueSnap recipe] fill 4/6:
type #CC-cardNumber`).

### Steps

| Step | Example | Does |
| --- | --- | --- |
| `waitForUrl` | `{ "waitForUrl": "https://pay.example.com/checkout" }` | waits until the page, or a popup it opened, is on a URL containing this |
| `waitFor` | `{ "waitFor": "#card-number" }` | waits until the target is visible |
| `fill` | `{ "fill": "#name", "value": "{card.name}" }` | sets the value in one go |
| `type` | `{ "type": "#number", "value": "{card.number}" }` | types it key by key, for fields that format as you type |
| `select` | `{ "select": "#month", "value": "02" }` | picks an option, by value or by visible text |
| `check` | `{ "check": "#terms" }` | ticks a checkbox |
| `click` | `{ "click": "#pay-button" }` | clicks it |
| `press` | `{ "press": "Enter", "target": "#otp" }` | presses a key, on a field or the page |
| `wait` | `{ "wait": 2000 }` | pauses, in ms (prefer a `waitFor`) |
| `expect` | `{ "expect": "navigation" }` | the page left the URL it was on when the previous step started |
|  | `{ "expect": "url", "value": "order-received" }` | a page reached a URL containing this |
|  | `{ "expect": "text", "value": "Payment successful" }` | this text is visible |
|  | `{ "expect": "hidden", "target": ".spinner" }` | the target has gone |

Options on any step:

| Option | |
| --- | --- |
| `timeout` | ms to wait for the target (default 30000) |
| `optional` | `true`: if the step fails, log it and carry on |
| `ifEmpty` | `true`: fill/type only when the field is empty (keeps pre-filled booking details) |
| `frame` | only look in iframes whose URL contains this |
| `label` | a name for the log line |

Options on the whole recipe:

| Option | |
| --- | --- |
| `errorTexts` | `["Unable to Process Payment Request"]`: text of the gateway's own error page. A `waitFor` that sees one fails at once with what the page says (`USAePay said: "…Card encryption service unavailable…"`), not after its timeout |
| `retry` | `{ "when": "Card encryption service unavailable", "attempts": 2 }`: when an `errorTexts` error contains `when`, go back to the form, run `fill` again and pay again, up to `attempts` more times (`waitMs` between, default 3000). Only for errors that are the sandbox having a moment, never for a decline |

### Targets

A string is a selector: `"#CC-cardNumber"`, `"input[name=cvc]"`,
`"text=Pay now"`. An object finds it the way a person would:

```json
{ "label": "Card number" }
{ "placeholder": "MM / YY" }
{ "role": "button", "name": "Pay" }
{ "text": "Pay now" }
```

**Every frame is searched,** main page first. Hosted checkouts put card
fields in iframes, so a recipe rarely needs to say which one. Add `frame`
only when two iframes hold look-alike fields.

### Values

Plain text, or placeholders filled from the recipe's `card`:

| Placeholder | Default |
| --- | --- |
| `{card.number}` | 4242424242424242 |
| `{card.expiry}` | MMYY, e.g. 0229 |
| `{card.expMonth}` / `{card.expYear}` / `{card.expYY}` | 02 / current year + 3 / its last two digits |
| `{card.cvc}` | 123 |
| `{card.name}` / `{card.email}` / `{card.postal}` | Test User / customer@example.com / 10001 |
| `{card.otp}` | 123456 |
| `{env.NAME}` | the run's environment variable NAME, e.g. a test phone number |

Put the gateway's own documented test card in `card`. Many sandboxes only
approve their own test numbers, or a specific expiry.

## When a recipe fails

The run fails at the step that broke, saying which step and why:

```
Recipe "BlueSnap" failed at submit 1/2: click #pay-button
#pay-button was not visible in any frame after 45000ms. Frames present:
  - https://…/checkout/
  - https://…bluesnap.com/…
```

That message is the run's error on its report page, next to the failure
screenshot and the failing API. Fix the step in `data/gateways.json` and run
the gateway again.

## Moving a gateway from code to a recipe

1. Write its recipe with `"useInsteadOfCode": true`.
2. Run it on each platform. The report shows **Payment form: recipe**.
3. Once it passes everywhere, delete its entry in `gatewayPaymentForms.js` and drop the flag.

**Worked example: BlueSnap, 144 lines of code as a recipe** (passed on
FluentCart staging, October 2026):
```json
{
  "useInsteadOfCode": true,
  "card": { "number": "5425233430109903", "expiry": "0429", "cvc": "837",
            "name": "Test Customer", "email": "customer@example.com" },
  "fill": [
    { "waitFor": "#CC-cardNumber", "timeout": 90000, "label": "card form mounted" },
    { "fill": "#CC-name", "value": "{card.name}", "ifEmpty": true, "optional": true, "timeout": 3000 },
    { "fill": "#CC-email", "value": "{card.email}", "ifEmpty": true, "optional": true, "timeout": 3000 },
    { "type": "#CC-cardNumber", "value": "{card.number}" },
    { "type": "#CC-expirationDate", "value": "{card.expiry}" },
    { "type": "#CC-securityCode", "value": "{card.cvc}" }
  ],
  "submit": [
    { "click": "#pay-button", "timeout": 45000 },
    { "expect": "navigation", "timeout": 60000, "optional": true }
  ]
}
```

**Worked example: a classic hosted HTML form, USAePay** (October 2026).
Place Order redirects the whole tab to the gateway's own "Secure Payment
Form": a plain HTML table page, no iframes, no JavaScript widgets. Every field
is an ordinary `<input name="…">`. USAePay prefixes them `UM`: `UMcard`,
`UMexpir`, `UMcvv2`, `UMname`, `UMzip`, then `UMbill*` / `UMship*` for the
addresses, with `select[name=payment_type]` for the card type and
`input[name=submitbutton]` ("Process Payment >>") to pay.

Recognise the type by: the order summary at the top (amount, the order
number, "Payment for order ORD-…"), billing fields already filled from the
checkout, and the shipping block left empty. A recipe of `fill` steps by
`name` is all it needs.
```json
{
  "card": { "number": "<sandbox success card from the team sheet>", "expiry": "1229", "cvc": "123", "postal": "3000" },
  "fill": [
    { "waitFor": "input[name=\"UMcard\"]", "timeout": 90000, "label": "USAePay payment form" },
    { "select": "select[name=\"payment_type\"]", "value": "Visa", "optional": true },
    { "fill": "input[name=\"UMname\"]", "value": "{card.name}", "ifEmpty": true },
    { "fill": "input[name=\"UMzip\"]", "value": "{card.postal}", "ifEmpty": true },
    { "fill": "input[name=\"UMcard\"]", "value": "{card.number}" },
    { "fill": "input[name=\"UMexpir\"]", "value": "{card.expiry}" },
    { "fill": "input[name=\"UMcvv2\"]", "value": "{card.cvc}" },
    { "fill": "input[name=\"UMbillzip\"]", "value": "{card.postal}", "ifEmpty": true, "optional": true, "timeout": 5000 }
  ],
  "errorTexts": ["Unable to Process Payment Request"],
  "retry": { "when": "Card encryption service unavailable", "attempts": 2 },
  "submit": [
    { "click": "input[name=\"submitbutton\"]" },
    { "waitFor": "a[href*=\"redirect-callback\"]", "timeout": 60000, "label": "USAePay result page" },
    { "click": "a[href*=\"redirect-callback\"]", "label": "Continue (back to the store)" },
    { "expect": "navigation", "timeout": 60000 }
  ]
}
```
- **It doesn't return by itself:** after Process Payment, USAePay shows a result page with a **Continue** image link to PayLexer's `processor-staging.paylexer.com/redirect-callback?gateway=usaepay&orderRef=…&returnUrl=…thank-you…`. Click it by its `href` (`a[href*="redirect-callback"]`), not the image, to reach the store's thank-you page. Older hosted forms often end on a page like this.
- **`fill`, not `type`:** plain inputs don't format as you type, so set the whole value at once. Expiry is one `MMYY` box (`UMexpir`), not two selects.
- **`ifEmpty` on everything the checkout pre-fills** (name, address, email), so the run keeps the booking's own details.
- **The card's billing zip (`UMzip`) arrives empty** and is checked against the address (AVS). Give it a zip that fits the checkout's billing address: these runs bill to Melbourne, AU, so `3000`.
- **The sandbox fails now and then:** Process Payment sometimes returns "Unable to Process Payment Request: Card encryption service unavailable", on any platform, in 1 or 2 of 4 runs. Nothing on our side causes it; `errorTexts` makes it fail at once with that text, and `retry` goes back and pays again.
- **The sandbox approves only its own numbers.** The team sheet's USAePay tab lists success, declined, insufficient-funds and CVV-mismatch cards; swap `card.number` to test a failure path.
- **Same shape elsewhere:** older processors' hosted pages (Authorize.Net SIM, many bank gateways) look like this. Read the field names off the page and map them one to one.

**Pattern: a choice page before the payment, PhaJay** (October 2026). Some
gateways redirect to a page where the shopper first picks **how** to pay:
PhaJay's "PhaPay" page lists banks (JDB, LDB, BCEL, Indochina Bank) and QR
options. The recipe clicks the choice by its visible text, then carries on
with whatever that leads to:
```json
{
  "fill": [
    { "waitFor": { "text": "JDB" }, "timeout": 90000, "label": "PhaPay bank list" },
    { "click": { "text": "JDB" }, "label": "bank JDB" }
  ],
  "submit": [ { "expect": "navigation", "timeout": 30000, "optional": true } ]
}
```
PhaJay's approval then happens in its test mobile app (team sheet), the D.6
kind of payment. Confirm what the page after the choice asks for before
adding steps past it.

---

# Part D: Code

Write code only for what a recipe can't express: retries, branching on what
the page shows, reading values back to verify them. Every gateway in the
codebase is one of the shapes below. Identify the shape, then copy the closest
gateway (its section in `gateways.md` has the notes, test values, URLs and
selectors; the source line is at the top of it).

## D.1. In-place hosted fields

The card form appears on the store's own checkout page after Place Order,
often inside one or two iframes (PayLexer's processor frame, then the
gateway's). There's no redirect to wait for: the card-number field becoming
visible is the signal.

- **Copy:** BlueSnap (ids `#CC-cardNumber`, `#CC-expirationDate`, `#CC-securityCode`, button `#pay-button`), Westpac, Eway, openpay, Conekta.
- **Watch for:** the form mounts late (BlueSnap: in `sandpay.bluesnap.com`, inside `processor-staging.paylexer.com`, on the checkout page). Wait for the number field with a long timeout (90s) across `page.frames()`.

## D.2. Full redirect to a hosted page

Place Order navigates the whole tab to the gateway's page. Wait for the stable
URL prefix (the path, not the per-session query), then fill.

- **Copy:** Fatora (`maktapp.credit/pay/MCPaymentPage`, 76 lines, the smallest entry), DOKU, Elavon, MultiSafepay, Viva, Iyzico.
- **No code needed when the hosted page is a plain HTML form** (named inputs, no iframes, one submit button): write a recipe instead. USAePay is the worked example in Part C.
- **Helper:** `waitForUrlPrefix(page, "https://host/path", 45000)`.
- **Watch for:** a gateway that shows an error page instead of its checkout. `waitForHostedRedirectOrCheckoutError` races the two, so a bad key reads as the gateway's own message, not a timeout. Barion is the example: a wrong POSKey leaves its checkout on "Session Error" forever.

## D.3. Popup or new tab

The flow (or the gateway) opens a new page. `checkout.submitPayment()` already
returns the page the card form is on; inside an entry, look across
`page.context().pages()` for the newest page.

- **Copy:** Getnet, Finix, Midtrans, Paystack.

## D.4. Every field in its own iframe

Stripe-style hosted fields: number, expiry and CVC each live in a separate
frame, and each frame often carries hidden copies of the other fields.
Resolve **each field separately**, by something the decoys don't share
(accessible name, `autocomplete`, a data attribute), not by position.

- **Copy:** Stripe, Braintree, SumUp, Adyen, Airwallex, Square.
- **Helpers:** `waitForFieldInAnyFrame(page, (frame) => frame.getByRole("textbox", { name: "CVV" }), "CVV")`, and `waitForFrameByUrl(page, "js.stripe.com")` when one frame holds them all.

## D.5. 3-D Secure / OTP after Pay

After Pay, a challenge frame or page asks for a code, or offers a
"Complete" / "Authenticate" button on the sandbox simulator.

- **Copy:** Adyen (challenge frame), Midtrans, Paystack and Revolut (OTP entry), Checkout (challenge, then wait for it to clear).
- **Watch for:** look for the challenge only in a frame whose URL says so (`3ds`, `acs`, `challenge`) or on a page the flow moved to. A broad `*code*` selector also matches the CVC (`securityCode`) and coupon boxes.

## D.6. Wallet, phone or app approval

M-Pesa STK push to a sandbox phone number, Khalti wallet and MPIN, ToyyibPay
FPX bank selection and the bank simulator it redirects to. The "payment" is
an approval outside a card form.

- **Copy:** MPesa (phone form in an iframe found by content), Khalti, ToyyibPay, and PhaJay (a bank-choice page, then approval in its test app; a recipe, Part C).
- **Watch for:** sandbox accounts lock and expire. Khalti's MPIN locked in October 2026 (the API answered `400 "Khalti MPIN has been locked"`). Read the run's **failing API** before touching code; the cause is often the test account, not the automation.

## D.7. Pre-filled hosted test page

Some sandboxes pre-fill the card and ask only for the CVC (Fatora), or need
nothing but Pay. Don't type into fields that are already filled.

- **Copy:** Fatora.

## D.8. Shared helpers in gatewayPaymentForms.js

Defined at the top of the file and used by the entries (not exported).

| Helper | Use it for |
| --- | --- |
| `waitForUrlPrefix(page, prefix, ms)` | a full redirect whose path is stable but the query is per-session |
| `waitForHostedRedirectOrCheckoutError(page, prefix, label, ms)` | the same, but the gateway's error page surfaces as its own message |
| `waitForFrameByUrl(page, "host-part", ms)` | the one iframe that holds the card fields, matched by URL |
| `waitForFrameWithSelector(page, selector, ms)` | the iframe that contains a field, when its URL has nothing stable |
| `waitForFieldInAnyFrame(page, (frame) => locator, label, ms)` | one field in whichever frame owns it (per-field iframes) |
| `waitForFieldValue(page, input, label, typed, ms)` | confirm a formatting field really kept the digits |
| `waitForSubmissionToTakeEffect(page, urlBefore, ms)` | after clicking Pay: navigated, or reached `callback_type=success` |
| `describeSubmitButtons(page)` | every frame's buttons, for an error message that explains a missing Pay button |
| `paymentAlreadyCompleted(page)` | the PayLexer success callback is already in the URL |
| `findPayNowButton` / `waitForSubmitReadyOrCompletion` | PayWay-style "Pay Now" inside nested frames |

`page.frames()` is a **flat list including nested and cross-origin frames**.
Scanning it covers every nesting level, which is why these helpers work where
`page.locator()` alone can't see a field.

## D.9. A code entry, skeleton

```js
  Acme: {
    // What the payment page is and how it behaves: redirect or in place,
    // which frames, what is pre-filled, the gateway's own test card and why.
    // These notes become the gateway's section in references/gateways.md.
    fillCardDetails: async (page) => {
      await waitForUrlPrefix(page, "https://pay.acme.test/checkout/", 45000);

      const CARD = process.env.ACME_TEST_CARD_NUMBER || "4111111111111111";
      const number = await waitForFieldInAnyFrame(
        page, (frame) => frame.locator("#card-number"), "Acme card number", 60000,
      );
      await number.click();
      await number.pressSequentially(CARD, { delay: 60 });
      // … expiry, CVC the same way. No Pay click here: submitCardPayment() owns it.
    },

    submitCardPayment: async (page) => {
      const pay = page.locator("#pay").first();
      await pay.waitFor({ state: "visible", timeout: 30000 });
      const before = page.url();
      await pay.click();
      if (!(await waitForSubmissionToTakeEffect(page, before, 60000))) {
        throw new Error(`Acme did not move after Pay — still on ${page.url()}\n${await describeSubmitButtons(page)}`);
      }
    },
  },
```

## D.10. House rules the existing code follows

- **Expiry:** month `02`, year = current year + 3, unless the sandbox ties its test card to one expiry (BlueSnap `04/29`). Say so in the notes when it does.
- **Typing:** `pressSequentially` (key by key) for fields that format as you type (card groups, `MM / YY`) or guard keystrokes. A single `fill()` arrives as one input event that formatters drop.
- **Selectors:** stable ids and the gateway's own attributes over generated class names (`input-186`, `PrimaryButton-sc-…` hashes change with every build). Never a bare `:has-text("Pay")`: Google Pay, PayPal and "Pay by bank" buttons match it too.
- **Test values:** read `<PREFIX>_TEST_CARD_NUMBER`, `_TEST_CARD_EXPIRY`, `_TEST_CARD_CVV` from the environment with the documented sandbox value as the default. Recipes and auto-detection read the same names.
- **Split of work:** `fillCardDetails` fills, `submitCardPayment` clicks Pay and waits. The checkout page objects call them at different moments.
- **Errors that explain:** throw with the URL, the frames present and the buttons found (`describeSubmitButtons`). A timeout alone tells the next person nothing.
- **Pre-filled fields:** leave name and email the booking filled in; fill only when empty.
- **Credentials on screen:** the PayLexer key page shows gateway secrets. Its steps (`reconfiguring-in-paylexer`, `paylexer-key`) are excluded from Slack screenshots and messages; keep it that way.
