# Payment-form recipes

A gateway's card-entry flow written as **data** instead of code: wait for
the gateway's page, fill the card, click Pay, check it worked. One generic
engine (`config/paymentRecipes.js`) runs every recipe.

## Which form a run uses

`config/paymentForms.js` decides, per gateway, every time a run reaches the
payment step:

| The gateway has… | The run uses |
| --- | --- |
| code in `config/gatewayPaymentForms.js` | the code (as before) |
| a recipe with steps | the recipe (over code only with `"useInsteadOfCode": true`) |
| neither | **auto-detect**: the card form is found and filled on its own |
| `"noCardForm": true` | no card entry: the run passes straight through after checkout |

So **a gateway added from the UI pays with nothing written for it**: no code,
no recipe. The report shows which method paid: **Payment form: recipe** or
**Payment form: auto-detected**.

### Auto-detect

`config/paymentAuto.js` looks in every frame of every open page:
- **Card number:** by the browser's autofill hint (`cc-number`), then by
  name, id, placeholder or label ("card number", "1234 1234 …").
- **Expiry:** one MM/YY field (typed so its own formatter adds the slash),
  or month and year, which can be dropdowns.
- **CVC:** "cvc", "cvv", "security code" and similar.
- **Name, email, postal:** filled only if empty.
- **Mobile number:** filled only if empty and in the card form's own form or dialog. It uses the card's `phone`, or `<PREFIX>_TEST_PHONE` in `.env`, else the example in the field's placeholder, else 4155550123.
- **Pay button:** "Pay", "Pay now", "Submit payment", "Confirm"…, preferring
  "Pay"; "Cancel", "Back" and coupon buttons are never clicked.
- **3-D Secure:** an OTP box or a "Complete"/"Authenticate" button, but only
  in a challenge frame or a page the flow moved to, never on the card form
  itself.

Hosted fields that mount one by one are waited for: up to 90s for the card
number, then 30s each for expiry and CVC. A page with only a CVC (card
pre-filled) is accepted only when no card-number field exists at all.

Everything it found is logged (`[BlueSnap auto] card number: … in frame
sandpay.bluesnap.com`). If it fails, the log says what it saw. That's the
starting point for a recipe if the guess was wrong.

Every action is also recorded as a recipe step. A run's report page shows
them under **Auto-detect steps**, and **Save as recipe** writes them to
`data/gateways.json` → `paymentForms.<Gateway>` (its `card` is kept), so the
next runs replay them instead of searching. Check the steps first: a field
found only by a generated id is recorded by its label or placeholder instead.

### The test card

Many sandboxes only approve **their own** test card, and auto-detect can't
guess it. It uses, in order:

1. **Credentials → Test payment** in the UI (saved like a key), or
   `<GATEWAY>_TEST_CARD_NUMBER`, `_TEST_CARD_EXPIRY`, `_TEST_CARD_CVV`,
   `_TEST_PHONE`, `_TEST_OTP` in `.env`. These win, so a card typed in the UI
   is the one used.
2. `paymentForms.<Gateway>.card` in `config/paymentform.json` (shared) or
   `data/gateways.json`. A card with no steps still means auto-detect, now
   with the right card:
   ```json
   "BlueSnap": { "card": { "number": "5425233430109903", "expiry": "0429", "cvc": "837" } }
   ```
3. The default Visa `4242 4242 4242 4242`, 02/<year + 3>, CVC 123. The log
   says when it falls back to this.

Recipes read the same values (`{card.number}`, `{card.phone}`…). Hand-written
code reads them only where it keeps its card as `TEST_*` properties (Stripe,
Flutterwave, Braintree, Airwallex, Culqi, Getnet, PinPayments); the
Credentials tab says when a gateway's code ignores them.

## Where recipes live

In `data/gateways.json` (git-ignored, the file the Credentials tab already
writes), under `paymentForms`, keyed by gateway name:

```json
{
  "gateways": { … }, "credentials": { … }, "overrides": { … },
  "paymentForms": {
    "BlueSnap": { "useInsteadOfCode": true, "card": { … }, "fill": [ … ], "submit": [ … ] }
  }
}
```

Each run reads the file when it starts, so nothing needs restarting after an
edit. Until the Payment form tab exists in the UI, add or edit recipes in
that file by hand. Saving keys or currencies from the UI keeps them.

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
3. Once it passes, delete its entry in `gatewayPaymentForms.js` and drop the
   flag.

`docs/examples/bluesnap.recipe.json` is BlueSnap's 144 lines of code as a
10-step recipe.
