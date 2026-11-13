// config/paymentRecipes.js — runs a payment-form recipe.
//
// A recipe is a gateway's card-entry flow written as data instead of code: the
// same job a gatewayPaymentForms.js entry does, for gateways simple enough not
// to need code. Recipes live in data/gateways.json ("paymentForms"), so they
// can be written and changed without touching the repo; config/paymentForms.js
// decides when one is used.
//
//   {
//     "card":   { "number": "5425233430109903", "expiry": "0429", "cvc": "837" },
//     "fill":   [ { "type": "#CC-cardNumber", "value": "{card.number}", "timeout": 90000 },
//                 { "fill": "#CC-name", "value": "{card.name}", "ifEmpty": true, "optional": true },
//                 … ],
//     "submit": [ { "click": "#pay-button" },
//                 { "expect": "navigation", "timeout": 60000 } ]
//   }
//
// "fill" runs where fillCardDetails() would, "submit" where submitCardPayment()
// would — the checkout page objects call the two at different moments.
//
// ── Steps ────────────────────────────────────────────────────────────────────
//   waitForUrl  "prefix or part of the URL"     the page (or a popup) reaches it
//   waitFor     target                          target becomes visible
//   fill        target + value                  set the value in one go
//   type        target + value                  type it key by key (formatting fields)
//   select      target + value                  pick an option, by value or label
//   check       target                          tick a checkbox
//   click       target                          click it
//   press       "Enter" (+ optional target)     press a key
//   wait        milliseconds                    a fixed pause
//   expect      "navigation" | "url" | "text" | "hidden"   check it worked
//
// Any step also takes:
//   timeout   ms to wait for its target (default 30000)
//   optional  true → a failure is logged and the recipe carries on
//   ifEmpty   true → fill/type only when the field is empty (pre-filled stays)
//   frame     "part of an iframe URL" → only look in frames whose URL has it
//   label     a name for the log line
//
// ── Targets ──────────────────────────────────────────────────────────────────
// A string is a CSS/Playwright selector ("#CC-cardNumber", "text=Pay").
// An object picks by what a person sees:
//   { "label": "Card number" }  { "placeholder": "MM / YY" }
//   { "role": "button", "name": "Pay" }  { "text": "Pay now" }  { "css": "…" }
// Every frame is searched (main page first), because hosted checkouts put card
// fields in iframes; the first VISIBLE match wins.
//
// ── Values ───────────────────────────────────────────────────────────────────
// Plain text, or placeholders:
//   {card.number} {card.expiry} {card.expMonth} {card.expYear} {card.expYY}
//   {card.cvc} {card.name} {card.email} {card.postal} {card.otp}
//   {card.number1}…{card.number4} — the number's groups of four
//   {env.NAME}  — a value from the run's environment (a test phone, a PIN…)
// The recipe's "card" sets them; anything it leaves out falls back to
// DEFAULT_CARD below.

// A Visa test number most sandboxes accept; expiry per the house convention
// (month 02, current year + 3).
const YEAR = new Date().getFullYear() + 3;
const DEFAULT_CARD = {
  number: "4242424242424242",
  expMonth: "02",
  expYear: String(YEAR),
  expYY: String(YEAR).slice(-2),
  cvc: "123",
  name: "Test User",
  email: "customer@example.com",
  postal: "10001",
  otp: "123456",
};

const DEFAULT_TIMEOUT = 30000;
const POLL_MS = 400;

const STEP_KINDS = [
  "waitForUrl",
  "waitFor",
  "fill",
  "type",
  "select",
  "check",
  "click",
  "press",
  "wait",
  "expect",
];
const NEEDS_TARGET = new Set(["waitFor", "fill", "type", "select", "check", "click"]);
const NEEDS_VALUE = new Set(["fill", "type", "select"]);
const EXPECTATIONS = new Set(["navigation", "url", "text", "hidden"]);

function kindOf(step) {
  return STEP_KINDS.find((kind) => step && Object.prototype.hasOwnProperty.call(step, kind)) || null;
}

/** The card a recipe runs with: its own values over the defaults. */
function cardFor(recipe) {
  const card = { ...DEFAULT_CARD, ...(recipe.card || {}) };
  // An "expiry" given as MMYY / MM/YY / MM/YYYY also sets the month and year.
  const match = String(recipe.card?.expiry || "").match(/^(\d{2})\s*\/?\s*(\d{2,4})$/);
  if (match) {
    card.expMonth = match[1];
    card.expYY = match[2].slice(-2);
    card.expYear = match[2].length === 4 ? match[2] : `20${match[2]}`;
  }
  // expiry as typed into a single MMYY field, unless the recipe says otherwise.
  if (!recipe.card?.expiry) card.expiry = `${card.expMonth}${card.expYY}`;
  return card;
}

// A gateway's test values from the environment: .env, or the Credentials
// tab's "Test payment" section (saved keys reach a run as environment
// variables). <PREFIX>_ is the gateway name upper-cased, as for its keys.
const TEST_VALUE_KEYS = {
  number: ["TEST_CARD_NUMBER"],
  expiry: ["TEST_CARD_EXPIRY"],
  cvc: ["TEST_CARD_CVV", "TEST_CARD_CVC", "TEST_CVC"],
  phone: ["TEST_PHONE"],
  otp: ["TEST_OTP"],
};

function envPrefix(gatewayName) {
  return `${String(gatewayName).toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_`;
}

/** { number, expiry, cvc, phone, otp } — only the ones that are set. */
function envCard(gatewayName, env = process.env) {
  const prefix = envPrefix(gatewayName);
  const card = {};
  for (const [field, names] of Object.entries(TEST_VALUE_KEYS)) {
    const value = names.map((name) => env[`${prefix}${name}`]).find(Boolean);
    if (value) card[field] = value;
  }
  return card;
}

/**
 * "{card.cvc}" → "837"; "{env.X}" → process.env.X. Unknown names stay visible.
 * {card.number1}…{card.number4} are the card number's groups of four, for a
 * form with a box per group (ChillPay).
 */
function resolveValue(value, card) {
  return String(value ?? "").replace(/\{(card|env)\.([A-Za-z0-9_]+)\}/g, (match, scope, name) => {
    const group = scope === "card" && name.match(/^number([1-4])$/);
    if (group) return String(card.number || "").replace(/\D/g, "").slice((group[1] - 1) * 4, group[1] * 4);
    if (scope === "card") return card[name] !== undefined ? String(card[name]) : match;
    return process.env[name] !== undefined ? process.env[name] : match;
  });
}

/** How a step's target reads in a log line. */
function describeTarget(target) {
  if (!target) return "";
  if (typeof target === "string") return target;
  if (target.label) return `label "${target.label}"`;
  if (target.placeholder) return `placeholder "${target.placeholder}"`;
  if (target.role) return `${target.role}${target.name ? ` "${target.name}"` : ""}`;
  if (target.text) return `text "${target.text}"`;
  if (target.css) return target.css;
  return JSON.stringify(target);
}

function describeStep(step) {
  const kind = kindOf(step);
  if (step.label) return `${kind} ${step.label}`;
  if (NEEDS_TARGET.has(kind)) return `${kind} ${describeTarget(step[kind])}`;
  return `${kind} ${typeof step[kind] === "object" ? JSON.stringify(step[kind]) : step[kind]}`;
}

/** A Locator for `target` inside one frame. */
function locate(frame, target) {
  if (typeof target === "string") return frame.locator(target);
  if (target.label) return frame.getByLabel(target.label, { exact: Boolean(target.exact) });
  if (target.placeholder) return frame.getByPlaceholder(target.placeholder, { exact: Boolean(target.exact) });
  if (target.role) return frame.getByRole(target.role, target.name ? { name: target.name, exact: Boolean(target.exact) } : {});
  if (target.text) return frame.getByText(target.text, { exact: Boolean(target.exact) });
  if (target.css) return frame.locator(target.css);
  throw new Error(`unrecognised target ${JSON.stringify(target)}`);
}

/**
 * The first VISIBLE match for `target` in any frame of `page`, main frame
 * first, polled until `timeout`. Returns a Locator scoped to its frame.
 */
async function findVisible(page, target, { timeout, frameHint, errorTexts = [] }) {
  const deadline = Date.now() + timeout;

  for (;;) {
    const frames = page.frames().filter((frame) => !frameHint || frame.url().includes(frameHint));
    for (const frame of frames) {
      const locator = locate(frame, target).first();
      if (await locator.isVisible().catch(() => false)) return locator;
    }
    // The gateway's own error page: what we are waiting for will never come,
    // so fail now and say what the page says instead of timing out.
    const shown = await gatewayError(page, errorTexts);
    if (shown) throw new GatewayError(shown);
    if (Date.now() >= deadline) break;
    await page.waitForTimeout(POLL_MS);
  }

  const framesSeen = page
    .frames()
    .map((frame) => `  - ${frame.url() || "(about:blank)"}`)
    .join("\n");
  throw new Error(
    `${describeTarget(target)} was not visible in any frame after ${timeout}ms` +
      `${frameHint ? ` (frames matching "${frameHint}" only)` : ""}. Frames present:\n${framesSeen}`,
  );
}

/** A recipe's errorTexts showed up: the gateway refused, in its own words. */
class GatewayError extends Error {}

/**
 * The text around the first of `errorTexts` visible in any frame, or "".
 * The surrounding block, not the phrase itself: "Unable to Process Payment
 * Request" is the heading, the reason is the paragraph under it.
 */
async function gatewayError(page, errorTexts) {
  for (const text of errorTexts) {
    for (const frame of page.frames()) {
      const hit = frame.getByText(text).first();
      if (!(await hit.isVisible().catch(() => false))) continue;
      const body = await frame.locator("body").innerText({ timeout: 2000 }).catch(() => text);
      const flat = body.replace(/\s+/g, " ").trim();
      const at = Math.max(0, flat.indexOf(text));
      return flat.slice(at, at + 220);
    }
  }
  return "";
}

/** The page, or the newest page in its context whose URL matches. */
async function waitForUrl(page, fragment, timeout) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const open = page.context().pages().filter((p) => !p.isClosed());
    const match = [...open].reverse().find((p) => p.url().startsWith(fragment) || p.url().includes(fragment));
    if (match) return match;
    if (Date.now() >= deadline) break;
    await page.waitForTimeout(POLL_MS);
  }
  throw new Error(
    `no page reached a URL containing "${fragment}" within ${timeout}ms — now on "${page.url()}"`,
  );
}

/**
 * Errors in a recipe's shape, before anything runs — an unknown step, a
 * missing target or value. Empty when it is runnable.
 */
function validateRecipe(recipe) {
  const errors = [];
  if (!recipe || typeof recipe !== "object") return ["The recipe is not an object."];

  const lists = ["fill", "submit"].filter((name) => recipe[name] !== undefined);
  if (!lists.length) errors.push('A recipe needs a "fill" and/or a "submit" list of steps.');

  for (const name of lists) {
    if (!Array.isArray(recipe[name])) {
      errors.push(`"${name}" must be a list of steps.`);
      continue;
    }
    recipe[name].forEach((step, index) => {
      const where = `${name} step ${index + 1}`;
      const kind = kindOf(step);
      if (!kind) {
        errors.push(`${where}: no known step (${STEP_KINDS.join(", ")}).`);
        return;
      }
      if (NEEDS_TARGET.has(kind) && !step[kind]) errors.push(`${where}: "${kind}" needs a target.`);
      if (NEEDS_VALUE.has(kind) && step.value === undefined) errors.push(`${where}: "${kind}" needs a "value".`);
      if (kind === "expect" && !EXPECTATIONS.has(step.expect)) {
        errors.push(`${where}: "expect" is one of ${[...EXPECTATIONS].join(", ")}.`);
      }
      if ((step.expect === "url" || step.expect === "text") && !step.value) {
        errors.push(`${where}: expect "${step.expect}" needs a "value".`);
      }
      if (kind === "wait" && !(Number(step.wait) > 0)) errors.push(`${where}: "wait" is a number of ms.`);
    });
  }
  if (recipe.errorTexts !== undefined && !Array.isArray(recipe.errorTexts)) {
    errors.push('"errorTexts" must be a list of texts.');
  }
  if (recipe.retry !== undefined && (!recipe.retry || !recipe.retry.when)) {
    errors.push('"retry" needs a "when": the text of the error worth trying again.');
  }
  return errors;
}

/**
 * Runs one list of steps ("fill" or "submit") on `page`.
 *
 * Returns the page the steps ended on — a waitForUrl can move to a popup, and
 * the caller keeps going on whichever page the flow is now on.
 */
async function runSteps(page, recipe, listName, gatewayName) {
  const steps = recipe[listName] || [];
  const card = cardFor(recipe);
  const tag = `[${gatewayName} recipe]`;
  let current = page;
  // The URL as the PREVIOUS step started — what "expect navigation" must see
  // the page leave. Taken before a step, not after: a click that navigates at
  // once would otherwise already be on the new page when it is recorded.
  let previousStartUrl = page.url();

  for (const [index, step] of steps.entries()) {
    const kind = kindOf(step);
    const label = `${listName} ${index + 1}/${steps.length}: ${describeStep(step)}`;
    const timeout = Number(step.timeout) || DEFAULT_TIMEOUT;
    const frameHint = step.frame || null;
    const errorTexts = recipe.errorTexts || [];
    const startUrl = current.url();

    try {
      switch (kind) {
        case "waitForUrl":
          current = await waitForUrl(current, String(step.waitForUrl), timeout);
          await current.waitForLoadState("domcontentloaded").catch(() => {});
          break;

        case "waitFor":
          await findVisible(current, step.waitFor, { timeout, frameHint, errorTexts });
          break;

        case "fill":
        case "type": {
          const field = await findVisible(current, step[kind], { timeout, frameHint });
          const value = resolveValue(step.value, card);
          if (step.ifEmpty) {
            const existing = (await field.inputValue().catch(() => "")).trim();
            if (existing) {
              console.log(`✓ ${tag} ${label} — already filled, left as is`);
              continue;
            }
          }
          await field.scrollIntoViewIfNeeded().catch(() => {});
          await field.click();
          if (kind === "fill") await field.fill(value);
          else await field.pressSequentially(value, { delay: Number(step.delay) || 60 });
          break;
        }

        case "select": {
          const field = await findVisible(current, step.select, { timeout, frameHint });
          const value = resolveValue(step.value, card);
          // By value first, then by visible label.
          await field.selectOption(value).catch(() => field.selectOption({ label: value }));
          break;
        }

        case "check": {
          const field = await findVisible(current, step.check, { timeout, frameHint });
          await field.check();
          break;
        }

        case "click": {
          const field = await findVisible(current, step.click, { timeout, frameHint });
          await field.scrollIntoViewIfNeeded().catch(() => {});
          await field.click();
          break;
        }

        case "press": {
          const key = String(step.press);
          if (step.target) {
            const field = await findVisible(current, step.target, { timeout, frameHint });
            await field.press(key);
          } else {
            await current.keyboard.press(key);
          }
          break;
        }

        case "wait":
          await current.waitForTimeout(Number(step.wait));
          break;

        case "expect":
          current = await expectOutcome(current, step, timeout, card, previousStartUrl);
          break;

        default:
          throw new Error(`unknown step ${JSON.stringify(step)}`);
      }

      console.log(`✓ ${tag} ${label}`);
    } catch (error) {
      const reason = String(error?.message || error).split("\n").slice(0, 12).join("\n");
      if (error instanceof GatewayError) {
        throw new GatewayError(`${gatewayName} said: "${error.message}" (at ${label})`);
      }
      if (step.optional) {
        console.log(`ℓ ${tag} ${label} — optional, skipped: ${reason.split("\n")[0]}`);
        continue;
      }
      throw new Error(`Recipe "${gatewayName}" failed at ${label}\n${reason}`);
    }

    previousStartUrl = startUrl;
  }

  return current;
}

async function expectOutcome(page, step, timeout, card, before) {
  switch (step.expect) {
    case "navigation": {
      // Away from where the page was when the step before this one started
      // (the click that submits); resolves at once if it already has.
      await page.waitForURL((url) => url.href !== before, { timeout });
      await page.waitForLoadState("domcontentloaded").catch(() => {});
      return page;
    }
    case "url":
      return waitForUrl(page, resolveValue(step.value, card), timeout);
    case "text":
      await findVisible(page, { text: resolveValue(step.value, card) }, { timeout, frameHint: step.frame });
      return page;
    case "hidden": {
      const deadline = Date.now() + timeout;
      for (;;) {
        let visible = false;
        for (const frame of page.frames()) {
          if (await locate(frame, step.target || step.value).first().isVisible().catch(() => false)) visible = true;
        }
        if (!visible) return page;
        if (Date.now() >= deadline) throw new Error(`${describeTarget(step.target || step.value)} still visible after ${timeout}ms`);
        await page.waitForTimeout(POLL_MS);
      }
    }
    default:
      throw new Error(`unknown expectation "${step.expect}"`);
  }
}

/**
 * A recipe as a payment-form entry: the same { fillCardDetails,
 * submitCardPayment } shape the checkout page objects call on a
 * gatewayPaymentForms.js entry, so nothing that calls them changes.
 */
function recipeForm(gatewayName, recipe) {
  const errors = validateRecipe(recipe);
  return {
    source: "recipe",
    recipe,
    async fillCardDetails(page) {
      if (errors.length) {
        throw new Error(`The payment-form recipe for "${gatewayName}" is invalid:\n  - ${errors.join("\n  - ")}`);
      }
      // A setup step (scripts/uiServer.js collects ##STEP## lines), so the run's
      // report says the payment form was a recipe, not code.
      console.log("##STEP## payment-form recipe");
      console.log(`[${gatewayName} recipe] filling the payment form (${(recipe.fill || []).length} step(s))`);
      await runSteps(page, recipe, "fill", gatewayName);
    },
    async submitCardPayment(page) {
      if (errors.length) return;
      console.log(`[${gatewayName} recipe] submitting (${(recipe.submit || []).length} step(s))`);

      // "retry": { "when": "<error text>", "attempts": 2 } — a gateway error
      // that is the sandbox having a moment (USAePay's "Card encryption
      // service unavailable") rather than a refusal: go back to the form,
      // fill it again and pay again, up to `attempts` more times.
      const retry = recipe.retry || null;
      let left = retry ? Number(retry.attempts) || 1 : 0;

      for (;;) {
        try {
          await runSteps(page, recipe, "submit", gatewayName);
          return;
        } catch (error) {
          const transient = retry && error instanceof GatewayError && error.message.includes(retry.when);
          if (!transient || left <= 0) throw error;
          left -= 1;
          console.log(`ℹ [${gatewayName} recipe] ${error.message.split("\n")[0]} — going back to pay again (${left} retr${left === 1 ? "y" : "ies"} left)`);
          await page.waitForTimeout(Number(retry.waitMs) || 3000);
          await page.goBack({ waitUntil: "domcontentloaded" }).catch(() => {});
          await runSteps(page, recipe, "fill", gatewayName);
        }
      }
    },
  };
}

module.exports = {
  DEFAULT_CARD,
  STEP_KINDS,
  TEST_VALUE_KEYS,
  envPrefix,
  envCard,
  cardFor,
  resolveValue,
  validateRecipe,
  runSteps,
  recipeForm,
};
