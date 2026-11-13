---
name: paylexer-gateways
description: Everything about the PayLexer payment gateways this Playwright automation drives — all 61 with code in config/gatewayPaymentForms.js plus those paid by recipes or auto-detection — in one place. Use it for any gateway scenario: adding or onboarding a new gateway; looking up how a gateway pays, its sandbox test card, payment-page URL or selectors; a gateway run failing at checkout or card entry ("didn't fill the card", "Invalid Fields", "never landed on Thank You", declined, timeout); writing or fixing a gatewayPaymentForms entry, a payment-form recipe or a gatewayConfigs entry; running one gateway, a batch or every gateway on WP Travel Engine; and reading run results, the HTML report, traces and the failing API. Use it even when the user only names a gateway (Stripe, BlueSnap, Khalti…) or says "payment", "checkout" or "card form" without saying "gateway".
---

# PayLexer gateways

One skill for every gateway scenario. Find the scenario below and follow it.
The two references hold the detail:

- **`references/gateways.md`**: all 61 gateways in one file. A summary table first (how each pays, its payment host, test card), then one section per gateway: the developers' notes from the code, test values, URLs, selectors, PayLexer name, credential fields and currencies.
- **`references/payment-forms.md`**: how a run pays and how to write each kind. Part A: which method runs. Part B: auto-detect. Part C: recipes, with the full step reference. Part D: code, with the 7 payment-page shapes, shared helpers, a skeleton and house rules.

## Where things live

| What | Where |
| --- | --- |
| Gateway definition: PayLexer display name, WordPress slug, credential fields (selectors on PayLexer's configure page), currencies | `config/gatewayConfigs.js` (extra gateways can also live in `data/gateways.json` → `gateways`) |
| Keys | `.env` as `<GATEWAY>_<FIELD>`; `data/gateways.json` → `credentials` wins for `npm run test:all` runs |
| How it pays | code: `config/gatewayPaymentForms.js` · recipe: `data/gateways.json` → `paymentForms.<Name>` · auto-detect: `config/paymentAuto.js` |
| Which of those a run uses | `config/paymentForms.js` (payment-forms.md Part A) |
| The checkout flow that calls it | `tests/wpGatewayCheckout.spec.js` → `pages/CheckoutPage.js` (WP Travel Engine) |
| PayLexer dashboard / plugin | `pages/DashboardPage.js`, `pages/PaymentGatewayPage.js`, `pages/GatewayConfigurationPage.js`, `pages/PaylexerPluginPage.js` |
| Runs | `scripts/runGateways.js` (`npm run test:all`), HTML report in `playwright-report/` |

---

## Scenario 1: "How does gateway X pay? What's its test card?"

Open `references/gateways.md`, find X in the table, and read its section. To
find gateways that work the same way, look for the same "How it pays" and the
same payment host in the table, plus the "Related gateways named in its notes"
links. The section's first line gives the source line in
`gatewayPaymentForms.js` if you need the code itself.

If the table's header carries a ⚠ note, the working copy of
`gatewayPaymentForms.js` has no active entries. Runs then pay through recipes
or auto-detect, not the code described.

## Scenario 2: Add a new gateway

Work up this ladder and stop at the first rung that passes. Each rung costs
more to write and maintain than the one before.

0. **Outside this repo.** The gateway is available in PayLexer (it appears in the PayLexer plugin's gateway list), and you have its **sandbox** keys. Don't do the rest by hand: the run itself lists it on the platform, configures the keys in PayLexer and adds it through the plugin.
1. **Define it.** Add an entry in `config/gatewayConfigs.js`. Elavon is a clean example:
   ```js
   Elavon: {
     slug: "elavon",                 // the payment method's id on the WordPress checkout
     displayName: "Elavon",          // exactly as PayLexer shows it
     fields: [
       { name: "Merchant Alias", locator: "#test_merchantAliasTest" },
       { name: "Secret Key", locator: "#test_secretKeyTest" },
     ],
     currencies: ["USD"],
     defaultCurrency: "USD",
     successMessage: "Connection successful.",
   },
   ```
   - **Field selectors** are the inputs on the gateway's configure page in PayLexer. Convention: "Merchant Alias" → `#test_merchantAliasTest` (`defaultLocator()` in `config/gatewayStore.js`). Inspect the page and write any selector that differs.
   - **Slug:** if it's wrong, the run fails with `No payment method on the WooCommerce checkout matched slug "…"`, and that error lists the slugs actually offered.
   - **Currencies:** ones the gateway's sandbox accepts. The run switches the store to the default currency first.
   - **Key values** go in the Credentials tab, or in `.env` as `<GATEWAY>_<FIELD>`: Moneris "Store ID" → `MONERIS_STORE_ID` (`credentialEnvKey()` in `config/credentialKeys.js`).
2. **Its sandbox test card.** Find it in the gateway's docs and set it as `paymentForms.<Name>.card` in `data/gateways.json`, or `<PREFIX>_TEST_CARD_*` in `.env` (payment-forms.md Part A). Without it the run uses Visa 4242, which most sandboxes decline.
3. **Try auto-detect.** No more setup is needed. Run the gateway (Scenario 7) and open its report.
4. **If auto-detect guessed wrong, write a recipe.** Start from the auto-detect log lines, the report screenshot and `error-context.md`. Translate the closest gateway's code (Scenario 1) into steps (payment-forms.md Part C).
5. **Write code only when a recipe can't express it** (Part D). Copy the closest gateway, and open the entry with a comment describing the page: that comment becomes its section in `gateways.md`.
6. **Verify it passes on WP Travel Engine**, then regenerate the reference (Scenario 9).

## Scenario 3: A gateway's run failed

Read before changing anything. The cause is outside the automation more often
than you'd expect.

1. **Run output**: `npm run report` opens the HTML report (error, the step it stopped at, screenshot, trace, and the `network`/`console` attachments listing the failing API calls). `grep "##STEP##"` over a `--verbose` log shows the setup trail. A gateway API 4xx with a message ("merchant not found", "Khalti MPIN has been locked") is a sandbox or account problem, not a selector problem.
2. **Screenshot:** filled fields plus an error means wrong card or format. Empty fields mean the form wasn't found, or typing didn't register.
3. **`error-context.md`** (next to the screenshot in `test-results/<gateway>-wte/…/` (or `test-results/` for a plain `npm run test:wp`)): the page's accessibility snapshot at the moment of failure, showing the real field names and which iframe holds them.
4. **The trace.** Never read it by hand: these are 100+ MB, and an agent that tries gets lost. Summarise it instead:
   ```bash
   node .claude/skills/paylexer-gateways/scripts/read-trace.js "test-results/<gateway>-wte/<test folder>/trace.zip" --grep "card|cvv|cvc|exp|pay"
   ```
   It prints what the run did (clicks, typing and where), every selector it checked with results (one that returned 0 every time looked in the wrong place), failed calls, and the frames on the page.
5. **Payment method used:** the setup steps say "Payment form: recipe" or "auto-detected"; otherwise it was code.

| Symptom | Usual cause |
| --- | --- |
| Card fields empty, then "Invalid Fields" | form mounted late in nested iframes; the search gave up or matched elsewhere |
| Fields filled, payment declined | not the gateway's own sandbox card or expiry (Scenario 4) |
| Gateway's own "Transaction Failed" with **0 failed API calls** | the gateway answered normally and said no: a non-sandbox card, or an amount the sandbox refuses (a WPTE trip priced in OMR can be thousands). The gateway's merchant portal shows the real reason under the order id |
| Field value mangled (`02 /  /`) | a formatting field: type digits key by key and let it add separators |
| Clicked the wrong button | a loose `:has-text("Pay")` matched Google Pay or PayPal; anchor on an id or stable attribute |
| Times out right after Place Order | redirected somewhere else, or the gateway's error page; the screenshot URL says which |
| WPTE "Session Error: Payment connector error: Not found merchant" | often **another gateway was paid**: check the submitted `wpte_checkout_paymnet_method` in the trace. WPTE's slow `update_cart` (fired by the billing details) re-rendered the list with the first method (Fatora) after the pick; `CheckoutPage.settleCart()` now waits it out (Oct 2026) |
| "X is not offered on the … checkout" while it is ticked and configured | the run's currency isn't one PayLexer supports for X, so the checkout hides it (USAePay was saved as AUD-only, PayLexer takes USD). Fix `currencies` / `defaultCurrency` in `config/gatewayConfigs.js` |
| Hosted page is a plain HTML form (named inputs, "Process Payment") | no code: a recipe of `fill` steps by `name`; USAePay is the worked example in payment-forms.md Part C |
| Fails in setup, before payment (wp-admin menu click, PayLexer configure) | site/plugin/PayLexer state, not the payment form; read the error's call log |
| `ENOENT … .trace` at `context().close()` | two runs of the same gateway at once deleted each other's output folder (Scenario 7) |

## Scenario 4: Set or fix a gateway's test card

Use a recipe `card` in `data/gateways.json` (`{ "number", "expiry": "MMYY", "cvc", "name", "otp" }`) or `<PREFIX>_TEST_CARD_NUMBER` / `_EXPIRY` / `_CVV` in `.env`. Code entries read the same env names, with their documented value as the default. Some sandboxes tie the card to one expiry (BlueSnap 04/29); say so in the notes.

## Scenario 5: Write, fix or test a recipe

Use payment-forms.md Part C (every step, target and placeholder, plus the
BlueSnap example). To try a recipe in place of existing code, add
`"useInsteadOfCode": true`. To try auto-detect in place of code, add
`"auto": true` as well. Remove the flag to go back.

## Scenario 6: Change a gateway's code

Follow payment-forms.md Part D, house rules especially:
- `fillCardDetails` fills; `submitCardPayment` clicks Pay and waits
- type formatting fields key by key
- use stable ids over generated classes
- keep the expiry convention
- throw errors that name the URL, frames and buttons
- never screenshot or message the PayLexer key page

## Scenario 7: Run gateways

- **One gateway:** set `PAYMENT_GATEWAY` in `.env` and `npm run test:wp` (headed), or `npm run test:all -- --only Stripe --verbose`.
- **A batch:** `npm run test:all -- --only Stripe,Mollie`.
- **Everything:** `npm run test:all` (`--skip A,B` to leave some out, `--list` to see the plan).

Runs go **one at a time**. Two runs on the same WordPress site at once overwrite
each other's store currency and fail falsely, and two runs of the same gateway
delete each other's `test-results/<gateway>-wte/` folder (`ENOENT`).

If a run lands on a sign-in page, the saved session expired: `npm run auth`.

## Scenario 8: Read results

- `npm run report`: the HTML report with screenshot, trace, and the `network`/`console` attachments of a failed run.
- **Failing API:** `tests/networkWatch.js` records 4xx/5xx and unanswered calls; the last failed API call before the failure is marked as the likely cause.

## Scenario 9: Keep this skill current

`references/gateways.md` is generated from the code. Never edit it by hand:

```bash
node .claude/skills/paylexer-gateways/scripts/build-catalog.js
```

Run it after adding or changing a payment form or gateway config. It reads
the working copy of `config/gatewayPaymentForms.js`, falls back to the
committed version when the working copy has no entries, and says so at the
top. Patterns and rules in `payment-forms.md` are hand-written: update them
when a new kind of payment page or a new lesson turns up.
