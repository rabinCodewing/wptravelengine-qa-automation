// config/paymentAuto.js — pays on a card form nobody described.
//
// The last resort of config/paymentForms.js: a gateway with no code in
// gatewayPaymentForms.js and no recipe steps still gets its card form found,
// filled and submitted — so a gateway added from the UI can be run end to end
// without anyone writing anything.
//
// How it finds things, in every frame of every open page (hosted checkouts put
// each card field in its own iframe, and some open the form in a popup):
//
//   card number   autocomplete="cc-number", then name/id/placeholder/label
//                 like "card number", "cardnumber", "1234 1234 1234 1234"
//   expiry        cc-exp (one field, "MM / YY"), or cc-exp-month + cc-exp-year
//                 (inputs or dropdowns)
//   CVC           cc-csc, then "cvc", "cvv", "security code", "card code"
//   card choice   a "Pay with Debit Card" / "Card" option on the gateway's page,
//                 clicked when no card form shows yet (Kora); never on the store
//   name / email / postal — filled only when empty (the booking pre-fills them)
//   mobile number — filled only when empty, and only one in the card form's
//                 own form/dialog (Arca's "Pay by card" modal asks for one)
//
// Then the pay button ("Pay", "Pay now", "Submit payment", "Confirm", …), and
// after it a 3-D Secure / OTP page if one appears (test code from the card,
// or the simulator's "Complete"/"Authenticate" button).
//
// Everything it detected is logged, so a run that fails here says what it saw
// — and that log is the starting point for a recipe if the guess was wrong.
// Each action is also printed as a recipe step (##AUTO## lines, collected by
// scripts/uiServer.js), so a run that paid can be saved as a recipe from its
// report page and stop guessing.
//
// The card: a recipe's "card" when the gateway has one without steps, else
// <PREFIX>_TEST_CARD_NUMBER / _TEST_CARD_EXPIRY / _TEST_CARD_CVV from the
// environment (the convention the code entries already read), else the
// defaults in config/paymentRecipes.js (Visa 4242…, 02/<year+3>, 123).

const { cardFor, envCard, envPrefix } = require("./paymentRecipes");

const FIND_TIMEOUT = 90000;
const SETTLE_TIMEOUT = 60000;
// How long the ACS simulator's Submit page may take to go away after the click.
const ACS_WAIT = 60000;
const POLL_MS = 500;

// Candidate locators per field, most specific first. Each is tried in every
// frame; the first VISIBLE, enabled match wins.
const FIELDS = {
  number: [
    'input[autocomplete="cc-number"]',
    'input[data-elements-stable-field-name="cardNumber"]',
    'input[name="cardnumber"]',
    'input[name*="card_number" i]',
    'input[name*="cardNumber" i]',
    'input[name*="card-number" i]',
    'input[id*="cardnumber" i]',
    'input[id*="card-number" i]',
    'input[id*="card_number" i]',
    'input[name="number"]',
    'input[name="pan"]',
    // Test ids, which many hosted forms carry when the field has no label
    // (ReservePay: data-testid="credit-card-form-card-number-input").
    'input[data-testid*="card-number" i]',
    'input[data-testid*="cardnumber" i]',
    'input[data-testid*="card_number" i]',
    'input[placeholder*="card number" i]',
    'input[placeholder*="1234 1234" i]',
    'input[placeholder*="0000 0000" i]',
    'input[placeholder*="•••• ••••" i]',
    'input[aria-label*="card number" i]',
    { label: /card ?number|card no\.?|número de tarjeta|numéro de carte/i },
  ],
  expiry: [
    'input[autocomplete="cc-exp"]',
    'input[data-elements-stable-field-name="cardExpiry"]',
    'input[name="exp-date"]',
    'input[name*="expiry" i]:not([name*="month" i]):not([name*="year" i])',
    'input[name*="expiration" i]:not([name*="month" i]):not([name*="year" i])',
    'input[id*="expiry" i]:not([id*="month" i]):not([id*="year" i])',
    'input[id*="expiration" i]:not([id*="month" i]):not([id*="year" i])',
    'input[data-testid*="expir" i]:not([data-testid*="month" i]):not([data-testid*="year" i])',
    'input[placeholder*="MM / YY" i]',
    'input[placeholder*="MM/YY" i]',
    'input[placeholder*="MM / YYYY" i]',
    'input[placeholder*="MM/YYYY" i]',
    'input[aria-label*="expir" i]:not([aria-label*="month" i]):not([aria-label*="year" i])',
    // Not "Expiry month" / "Expiry year": those are halves (Arca), and typing
    // MMYY into the month box leaves the year empty.
    { label: /^(?!.*\b(month|year)\b).*(expir|valid (thru|until)|mm ?\/ ?yy)/i },
  ],
  expMonth: [
    '[autocomplete="cc-exp-month"]',
    'select[name*="month" i]',
    'select[id*="month" i]',
    'input[name*="exp_month" i]',
    'input[name*="expMonth" i]',
    'input[name*="expiry_month" i]',
    'input[placeholder="MM"]',
    { label: /^\s*((exp\w*|valid)\.?\s*)?month\s*$|^\s*MM\s*$/i },
  ],
  expYear: [
    '[autocomplete="cc-exp-year"]',
    'select[name*="year" i]',
    'select[id*="year" i]',
    'input[name*="exp_year" i]',
    'input[name*="expYear" i]',
    'input[name*="expiry_year" i]',
    'input[placeholder="YY"]',
    'input[placeholder="YYYY"]',
    { label: /^\s*((exp\w*|valid)\.?\s*)?year\s*$|^\s*YY(YY)?\s*$/i },
  ],
  cvc: [
    'input[autocomplete="cc-csc"]',
    'input[data-elements-stable-field-name="cardCvc"]',
    'input[name="cvc"]',
    'input[name*="cvc" i]',
    'input[name*="cvv" i]',
    'input[name*="csc" i]',
    'input[name*="securityCode" i]',
    'input[name*="security_code" i]',
    'input[id*="cvc" i]',
    'input[id*="cvv" i]',
    'input[id*="securitycode" i]',
    'input[id*="security-code" i]',
    'input[data-testid*="cvv" i]',
    'input[data-testid*="cvc" i]',
    'input[data-testid*="security-code" i]',
    'input[placeholder*="CVC" i]',
    'input[placeholder*="CVV" i]',
    'input[placeholder*="security code" i]',
    'input[aria-label*="security code" i]',
    { label: /cvc|cvv|csc|security code|card code|cvn/i },
  ],
  name: [
    'input[autocomplete="cc-name"]',
    'input[name*="cardholder" i]',
    'input[name*="card_holder" i]',
    'input[name*="holderName" i]',
    'input[name*="name_on_card" i]',
    'input[id*="cardholder" i]',
    'input[data-testid*="card" i][data-testid*="name" i]',
    'input[data-testid*="holder" i]',
    'input[placeholder*="name on card" i]',
    'input[placeholder*="cardholder" i]',
    { label: /name on (the )?card|card ?holder/i },
  ],
  email: ['input[type="email"]', 'input[autocomplete="email"]'],
  postal: ['input[autocomplete="postal-code"]', 'input[name*="postal" i]', 'input[name*="zip" i]'],
  phone: [
    'input[autocomplete="tel"]',
    'input[autocomplete="tel-national"]',
    'input[name*="mobile" i]',
    'input[name*="phone" i]',
    'input[name*="msisdn" i]',
    'input[id*="mobile" i]',
    'input[id*="phone" i]',
    'input[data-testid*="mobile" i]',
    'input[data-testid*="phone" i]',
    'input[type="tel"]',
    'input[placeholder*="mobile" i]',
    'input[placeholder*="phone" i]',
    { label: /mobile|phone|msisdn|cell ?number/i },
  ],
};

// Used when neither the gateway's card nor the field's placeholder gives one.
const DEFAULT_PHONE = "4155550123";

const PAY_BUTTON = /^\s*(pay|pay now|pay securely|submit payment|make payment|complete payment|confirm payment|confirm|pay \S+|complete (order|purchase|booking)|place order|authori[sz]e|process payment|continue to pay|continue payment|submit|proceed)\b/i;
const NOT_PAY = /cancel|back|return|change|edit|apply|coupon|remove|close|login|sign in|register/i;

// 3-D Secure simulators: an OTP/password box, or a "make it succeed" button.
const OTP_FIELDS = [
  'input[autocomplete="one-time-code"]',
  'input[name*="otp" i]',
  'input[id*="otp" i]',
  'input[name*="challengeDataEntry" i]',
  'input[name="password"]',
  'input[name*="code" i]:not([name*="postal" i]):not([name*="zip" i]):not([name*="promo" i]):not([name*="coupon" i]):not([name*="security" i])',
  'input[placeholder*="code" i]',
];
const CHALLENGE_BUTTON = /^\s*(complete( authentication)?|authenticate|authori[sz]e|submit|confirm|continue|verify|success|approve|ok)\b/i;

function log(gateway, message) {
  console.log(`[${gateway} auto] ${message}`);
}

// Pages that were already open when the payment step began — the wp-admin and
// PayLexer tabs the run used earlier. Never searched: their forms are not the
// card form, and scanning them made every pass slow (a "CVV" label regex once
// matched a radio button on one of them).
const pagesBefore = new WeakMap();

function scopeTo(page) {
  pagesBefore.set(page, new Set(page.context().pages().filter((p) => p !== page)));
}

/**
 * Every frame of the payment page and of any page opened since (a popup or
 * hosted-checkout tab), newest page first. Nested and cross-origin iframes are
 * included — Playwright lists them flat.
 */
function allFrames(page, filter = null) {
  const before = pagesBefore.get(page) || new Set();
  const pages = page
    .context()
    .pages()
    .filter((p) => !p.isClosed() && !before.has(p))
    .reverse();
  const frames = pages.flatMap((p) => p.frames());
  return filter ? frames.filter(filter) : frames;
}

const CHALLENGE_URL = /3ds|acs|challenge|authenticat|threeds|secure|otp|verif/i;

// Fields a card value can go into. A label regex also matches radios and
// checkboxes ("Pay by card", "Save card"); those are never a card field.
const NOT_TYPEABLE = new Set(["radio", "checkbox", "hidden", "submit", "button", "image", "file", "range", "color", "reset"]);

/**
 * The candidates in tiers, each tier ONE query per frame: the precise
 * selectors (autocomplete hints, ids, names) joined into one selector list,
 * then the looser ones, then labels. Joining is what keeps a pass fast — one
 * round trip per frame per tier instead of one per selector.
 */
function tiersOf(candidates) {
  const css = candidates.filter((c) => typeof c === "string");
  const strong = css.filter((c) => /autocomplete|data-elements|data-testid|\[id|\[name/.test(c));
  const weak = css.filter((c) => !strong.includes(c));
  const labels = candidates.filter((c) => typeof c === "object" && c.label);
  return [
    ...(strong.length ? [{ css: strong.join(", "), how: "id/name", strength: "strong" }] : []),
    ...(weak.length ? [{ css: weak.join(", "), how: "placeholder/aria", strength: "weak" }] : []),
    ...labels.map((c) => ({ label: c.label, how: `label ${c.label}`, strength: "weak" })),
  ];
}

async function describeMatch(field) {
  return field
    .evaluate((el) => ({
      tag: el.tagName,
      type: (el.getAttribute("type") || "").toLowerCase(),
      id: el.id || "",
      name: el.getAttribute("name") || "",
    }))
    .catch(() => null);
}

/**
 * The first visible, enabled, typeable match for the candidates, searched tier
 * by tier across the payment page's frames. `strongOnly` skips placeholder
 * and label matches.
 */
async function findField(page, candidates, { exclude = [], frameFilter = null, strongOnly = false, accept = null } = {}) {
  for (const tier of tiersOf(candidates)) {
    if (strongOnly && tier.strength !== "strong") continue;
    for (const frame of allFrames(page, frameFilter)) {
      const locator = tier.css ? frame.locator(tier.css) : frame.getByLabel(tier.label);
      const count = await locator.count().catch(() => 0);
      for (let i = 0; i < Math.min(count, 6); i += 1) {
        const field = locator.nth(i);
        if (!(await field.isVisible().catch(() => false))) continue;
        if (!(await field.isEnabled().catch(() => false))) continue;
        const info = await describeMatch(field);
        if (!info || !["INPUT", "SELECT", "TEXTAREA"].includes(info.tag) || NOT_TYPEABLE.has(info.type)) continue;
        // The same element must not be claimed by two fields.
        const handle = await field.elementHandle().catch(() => null);
        if (handle && exclude.length) {
          let same = false;
          for (const other of exclude) {
            if (await handle.evaluate((a, b) => a === b, other).catch(() => false)) same = true;
          }
          if (same) continue;
        }
        if (accept && !(await accept({ field, frame, handle }))) continue;
        const named = info.id ? `#${info.id}` : info.name ? `[name="${info.name}"]` : info.tag.toLowerCase();
        return { field, frame, handle, how: `${named} (${tier.how})`, strength: tier.strength };
      }
    }
  }
  return null;
}

/** One action as a recipe step, for scripts/uiServer.js to collect. */
function recordStep(list, step) {
  console.log(`##AUTO## ${JSON.stringify({ list, step })}`);
}

/** The frame hint a recipe step needs: the iframe's host, or nothing for the page. */
function frameHint(frame) {
  if (!frame || frame === frame.page().mainFrame()) return undefined;
  try {
    return new URL(frame.url()).host || undefined;
  } catch {
    return undefined;
  }
}

/**
 * A recipe target for a found field: its id, its name, else its label or
 * placeholder as a person would see them.
 */
async function targetOf(found) {
  const info = await found.field
    .evaluate((el) => ({
      id: el.id || "",
      name: el.getAttribute("name") || "",
      tag: el.tagName.toLowerCase(),
      placeholder: el.getAttribute("placeholder") || "",
      aria: el.getAttribute("aria-label") || "",
      label: (el.labels && el.labels[0] ? el.labels[0].innerText : "").trim(),
    }))
    .catch(() => null);
  if (!info) return null;
  // Generated ids (":r1:", "input-38f2a") change between page loads.
  const stableId = info.id && /^[A-Za-z][\w-]*$/.test(info.id) && !/\d{3,}|[a-f0-9]{6,}/i.test(info.id);
  if (stableId) return `#${info.id}`;
  if (info.name) return `${info.tag}[name="${info.name}"]`;
  if (info.label) return { label: info.label };
  if (info.placeholder) return { placeholder: info.placeholder };
  if (info.aria) return { label: info.aria };
  return null;
}

/** Records typing into a found field, if it can be targeted again. */
async function recordField(list, found, kind, value, extra = {}) {
  const target = await targetOf(found);
  if (!target) return;
  const frame = frameHint(found.frame);
  recordStep(list, { [kind]: target, value, ...extra, ...(frame ? { frame } : {}) });
}

/**
 * Records a click on a button found by its text. `exact` for a short name
 * like "Pay", which would otherwise also match "Pay with Debit Card".
 */
function recordClick(list, text, frame, extra = {}, exact = false) {
  const hint = frameHint(frame);
  const target = { role: "button", name: text, ...(exact ? { exact: true } : {}) };
  recordStep(list, { click: target, ...extra, ...(hint ? { frame: hint } : {}) });
}

function where(found) {
  const url = found.frame.url();
  const isMain = found.frame === found.frame.page().mainFrame();
  return `${found.how}${isMain ? "" : ` in frame ${url.slice(0, 80)}`}`;
}

const digits = (value) => String(value || "").replace(/\D/g, "");

/** Types `value` key by key — formatting fields ignore a pasted value. */
async function typeInto(found, value) {
  const { field } = found;
  await field.scrollIntoViewIfNeeded().catch(() => {});
  await field.click().catch(() => {});
  await field.fill("").catch(() => {});
  await field.pressSequentially(String(value), { delay: 60 });
}

/**
 * A single expiry field: MMYY typed, and if the field kept the digits without
 * a separator its placeholder asks for, retyped with one.
 */
async function fillExpiry(found, card) {
  const placeholder = (await found.field.getAttribute("placeholder").catch(() => "")) || "";
  const fourDigitYear = /yyyy/i.test(placeholder);
  const year = fourDigitYear ? card.expYear : card.expYY;
  const yearName = fourDigitYear ? "{card.expYear}" : "{card.expYY}";
  await typeInto(found, `${card.expMonth}${year}`);
  const value = await found.field.inputValue().catch(() => "");
  if (/\//.test(placeholder) && !/\//.test(value) && digits(value).length) {
    await typeInto(found, `${card.expMonth}/${year}`);
    return `{card.expMonth}/${yearName}`;
  }
  return `{card.expMonth}${yearName}`;
}

/** A month or year field that may be a <select> with any of several option styles. */
async function fillPart(found, candidates) {
  const tag = await found.field.evaluate((el) => el.tagName).catch(() => "INPUT");
  if (tag === "SELECT") {
    for (const value of candidates) {
      const ok = await found.field
        .selectOption(value)
        .then(() => true)
        .catch(() => found.field.selectOption({ label: value }).then(() => true).catch(() => false));
      if (ok) return value;
    }
    throw new Error(`none of ${candidates.join(", ")} is an option`);
  }
  // A box sized for 2 characters ("YY", maxlength 2) gets the short form —
  // typing 2029 into it keeps "20".
  const { maxLength, placeholder } = await found.field
    .evaluate((el) => ({ maxLength: el.maxLength, placeholder: el.getAttribute("placeholder") || "" }))
    .catch(() => ({ maxLength: -1, placeholder: "" }));
  const room = maxLength > 0 ? maxLength : /^\s*[A-Za-z]{2}\s*$/.test(placeholder) ? 2 : Infinity;
  const value = candidates.find((candidate) => String(candidate).length <= room) || candidates[0];
  await typeInto(found, value);
  return value;
}

/**
 * Polls for a field until `timeout`. `orElse` ends the wait early when an
 * alternative is already there (a month dropdown instead of one expiry box).
 */
async function waitForField(page, candidates, claimed, timeout, orElse = null) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const found = await findField(page, candidates, { exclude: claimed });
    if (found) return found;
    if (orElse && (await orElse())) return null;
    if (Date.now() >= deadline) return null;
    await page.waitForTimeout(POLL_MS);
  }
}

async function fillIfEmpty(found, value) {
  const current = (await found.field.inputValue().catch(() => "")).trim();
  if (current) return false;
  await found.field.fill(String(value));
  return true;
}

/** Whether any selector candidate exists in any frame, visible or not. */
async function anyAttached(page, candidates) {
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    for (const frame of allFrames(page)) {
      if ((await frame.locator(candidate).count().catch(() => 0)) > 0) return true;
    }
  }
  return false;
}

/**
 * Accepts a field only if it sits in the card form's own form or dialog, so a
 * phone box on the booking page behind a payment modal is left alone. A field
 * in another frame, or with no form/dialog around it, is accepted.
 */
function besideCardForm(anchor) {
  if (!anchor?.handle) return null;
  return async ({ frame, handle }) => {
    if (!handle || frame !== anchor.frame) return true;
    return handle
      .evaluate((el, card) => {
        const box = el.closest('form, dialog, [role="dialog"], [aria-modal="true"], [class*="modal" i]');
        return !box || box.contains(card);
      }, anchor.handle)
      .catch(() => true);
  };
}

/**
 * The mobile number to type: the gateway's own (card.phone, or
 * <PREFIX>_TEST_PHONE), else the example in the field's placeholder — it is in
 * the format the form validates ("+234 810 123 4567" → "+2348101234567") —
 * else a default.
 */
async function phoneFor(found, card) {
  if (card.phone) return String(card.phone);
  const placeholder = (await found.field.getAttribute("placeholder").catch(() => "")) || "";
  if (digits(placeholder).length >= 7) return `${placeholder.trim().startsWith("+") ? "+" : ""}${digits(placeholder)}`;
  return DEFAULT_PHONE;
}

// A hosted page that asks how to pay before showing the card form (Kora:
// <div class="payment-channel" role="button">Pay with Debit Card</div>).
const CARD_CHANNEL = /pay (with|by|using) (a )?(debit |credit |bank )?card|^\s*(debit |credit |bank )?cards?\s*$|^\s*(debit|credit)( \/ ?(debit|credit))? card\s*$/i;
const NOT_CARD_CHANNEL = /google|apple|paypal|samsung|saved card|bank transfer|ussd|mobile money|qr/i;
// Kora's own card choice first, by its class, then anything that looks like one.
const CHANNEL_CANDIDATES = '.payment-channel, [role="button"], button, [role="tab"], [role="radio"], [class*="channel" i], [class*="payment-method" i], [class*="payment-option" i]';

// The store's own pages: a card choice there is a WordPress payment method,
// never something auto-detect may click.
const STORE_ORIGINS = new Set(
  ["BASE_URL", "FRONTEND_URL", "WP_LOGIN_URL"]
    .map((name) => {
      try {
        return new URL(process.env[name]).origin;
      } catch {
        return null;
      }
    })
    .filter(Boolean),
);

function onStore(frame) {
  try {
    return STORE_ORIGINS.has(new URL(frame.url()).origin);
  } catch {
    return false;
  }
}

// A page that opens on another method (Kora opens on Bank Transfer) and lists
// the others behind this button.
const CHANGE_METHOD = /^\s*(change|switch|choose( another)?|other|select( another)?) (payment )?(method|option)s?\s*$|^\s*pay with another method\s*$/i;

/** A visible "Change payment method" button on the gateway's page. */
async function findChangeMethod(page) {
  for (const frame of allFrames(page, (f) => !onStore(f))) {
    const buttons = frame.locator('button, [role="button"], a');
    const count = Math.min(await buttons.count().catch(() => 0), 40);
    for (let i = 0; i < count; i += 1) {
      const button = buttons.nth(i);
      if (!(await button.isVisible().catch(() => false))) continue;
      const text = ((await button.innerText().catch(() => "")) || "").replace(/\s+/g, " ").trim();
      if (CHANGE_METHOD.test(text)) return { button, frame, text };
    }
  }
  return null;
}

/** A visible "Pay with card" choice on the gateway's page, with its text. */
async function findCardChannel(page) {
  for (const frame of allFrames(page, (f) => !onStore(f))) {
    const choices = frame.locator(CHANNEL_CANDIDATES);
    const count = Math.min(await choices.count().catch(() => 0), 30);
    for (let i = 0; i < count; i += 1) {
      const choice = choices.nth(i);
      if (!(await choice.isVisible().catch(() => false))) continue;
      // The first line only: Kora's choice also holds a tooltip's steps.
      const text = ((await choice.innerText().catch(() => "")) || "").split("\n").map((t) => t.trim()).find(Boolean) || "";
      if (CARD_CHANNEL.test(text) && !NOT_CARD_CHANNEL.test(text)) return { choice, frame, text };
    }
  }
  return null;
}

/** Waits for the card-number field (or a lone CVC) to appear anywhere. */
async function waitForCardForm(page, gateway, timeout = FIND_TIMEOUT) {
  const started = Date.now();
  const deadline = started + timeout;
  let channelClicks = 0;
  let lastChannelClick = 0;
  for (;;) {
    const number = await findField(page, FIELDS.number);
    if (number) return { number };
    // No card form yet: pick the card option if the gateway's page offers one.
    // Again after 5s if the form still hasn't come, up to three times.
    if (channelClicks < 3 && Date.now() - lastChannelClick > 5000) {
      const channel = await findCardChannel(page);
      if (channel) {
        channelClicks += 1;
        lastChannelClick = Date.now();
        log(gateway, `payment choice: clicking "${channel.text}"${channel.frame === channel.frame.page().mainFrame() ? "" : ` in frame ${channel.frame.url().slice(0, 80)}`}`);
        recordClick("fill", channel.text, channel.frame, { label: "payment choice" });
        // On its text, not its centre: Kora's choice carries a tooltip icon.
        const label = channel.choice.getByText(channel.text, { exact: true }).first();
        if (!(await label.click().then(() => true).catch(() => false))) {
          await channel.choice.click().catch(() => {});
        }
        continue;
      }
      // No card choice showing: the page may have opened on another method.
      const change = await findChangeMethod(page);
      if (change) {
        channelClicks += 1;
        lastChannelClick = Date.now() - 4000;
        log(gateway, `payment choice: clicking "${change.text}" to see the card option`);
        recordClick("fill", change.text, change.frame, { label: "see the card option", optional: true });
        await change.button.click().catch(() => {});
        continue;
      }
    }
    // Some hosted test pages pre-fill the card and ask only for the CVC. Only
    // once the number has had 30s, and only if NO number field exists at all:
    // hosted fields often mount the CVC first and the number last, and taking
    // the CVC alone then pays with half a card.
    if (Date.now() - started > 30000) {
      // Matched by id/name/autocomplete only — a label regex once matched a
      // radio button on another tab.
      const cvc = await findField(page, FIELDS.cvc, { strongOnly: true });
      if (cvc && !(await anyAttached(page, FIELDS.number))) return { cvc };
    }
    if (Date.now() >= deadline) return null;
    await page.waitForTimeout(POLL_MS);
  }
}

function describeFrames(page) {
  return allFrames(page)
    .map((frame) => `  - ${frame.url() || "(about:blank)"}`)
    .join("\n");
}

/**
 * Detects and fills the card form. Returns what it filled, for submit().
 */
async function fill(page, gateway, cardSource) {
  const card = cardSource;
  scopeTo(page);
  log(gateway, `looking for a card form (test card ending ${String(card.number).slice(-4)}, from ${card.from})…`);
  if (card.from === "default") {
    log(
      gateway,
      `no sandbox card set for this gateway — using the default Visa. If it declines, set the gateway's own ` +
        `test card under "${gateway}" → card in config/paymentform.json (or ${card.envPrefix}TEST_CARD_NUMBER in .env).`,
    );
  }

  const start = await waitForCardForm(page, gateway);
  if (!start) {
    throw new Error(
      `Auto-detect found no card form for "${gateway}" within ${FIND_TIMEOUT / 1000}s — no card-number or CVC field ` +
        `in any frame. If this gateway pays somewhere other than a card form, give it a recipe ` +
        `(docs/payment-recipes.md), or mark it "noCardForm": true.\nFrames present:\n${describeFrames(page)}`,
    );
  }

  const claimed = [];
  const filled = {};

  if (start.number) {
    const number = start.number;
    log(gateway, `card number: ${where(number)}`);
    await typeInto(number, card.number);
    await recordField("fill", number, "type", "{card.number}");
    const got = digits(await number.field.inputValue().catch(() => ""));
    if (got && got !== digits(card.number)) {
      log(gateway, `⚠ the number field holds ${got.length} digit(s) after typing ${digits(card.number).length}`);
    }
    if (number.handle) claimed.push(number.handle);
    filled.number = number;
  }

  // Expiry: one field, or month + year. Hosted fields mount one by one, so
  // each is given time to appear rather than looked for once.
  const expiry = await waitForField(page, FIELDS.expiry, claimed, start.number ? 30000 : 3000, () =>
    findField(page, FIELDS.expMonth, { exclude: claimed }),
  );
  if (expiry) {
    log(gateway, `expiry: ${where(expiry)}`);
    await recordField("fill", expiry, "type", await fillExpiry(expiry, card));
    if (expiry.handle) claimed.push(expiry.handle);
  } else {
    const month = await findField(page, FIELDS.expMonth, { exclude: claimed });
    const year = await findField(page, FIELDS.expYear, { exclude: claimed });
    if (month && year) {
      const m = await fillPart(month, [card.expMonth, String(Number(card.expMonth)), new Date(2000, Number(card.expMonth) - 1).toLocaleString("en", { month: "long" }), new Date(2000, Number(card.expMonth) - 1).toLocaleString("en", { month: "short" })]);
      const y = await fillPart(year, [card.expYear, card.expYY]);
      log(gateway, `expiry: month ${m} (${where(month)}), year ${y} (${where(year)})`);
      const named = (value) =>
        ({ [card.expMonth]: "{card.expMonth}", [card.expYear]: "{card.expYear}", [card.expYY]: "{card.expYY}" })[value] || value;
      for (const [found, value] of [[month, m], [year, y]]) {
        const tag = await found.field.evaluate((el) => el.tagName).catch(() => "INPUT");
        await recordField("fill", found, tag === "SELECT" ? "select" : "type", tag === "SELECT" ? value : named(value));
      }
      claimed.push(...[month.handle, year.handle].filter(Boolean));
    } else if (start.number) {
      log(gateway, "no expiry field found — continuing (some forms ask for it later)");
    }
  }

  const cvc = start.cvc || (await waitForField(page, FIELDS.cvc, claimed, 30000));
  if (cvc) {
    log(gateway, `CVC: ${where(cvc)}`);
    await typeInto(cvc, card.cvc);
    await recordField("fill", cvc, "type", "{card.cvc}");
    if (cvc.handle) claimed.push(cvc.handle);
  } else {
    log(gateway, "no CVC field found — continuing");
  }

  for (const key of ["name", "email", "postal"]) {
    const found = await findField(page, FIELDS[key], { exclude: claimed });
    if (!found) continue;
    if (await fillIfEmpty(found, card[key]).catch(() => false)) {
      log(gateway, `${key}: filled (${where(found)})`);
      await recordField("fill", found, "fill", `{card.${key}}`, { ifEmpty: true });
    }
    if (found.handle) claimed.push(found.handle);
  }

  const phone = await findField(page, FIELDS.phone, { exclude: claimed, accept: besideCardForm(filled.number || cvc) });
  if (phone) {
    const current = (await phone.field.inputValue().catch(() => "")).trim();
    if (!digits(current)) {
      const value = await phoneFor(phone, card);
      await typeInto(phone, value);
      log(gateway, `mobile number: ${value} (${where(phone)})`);
      await recordField("fill", phone, "type", card.phone ? "{card.phone}" : value, { ifEmpty: true });
    }
    if (phone.handle) claimed.push(phone.handle);
  }

  log(gateway, "card form filled");
  return filled;
}

/** The most likely pay button: in a frame that held card fields first, then anywhere. */
async function findPayButton(page) {
  const candidates = [];
  for (const frame of allFrames(page)) {
    const buttons = frame.locator('button, input[type="submit"], input[type="button"], [role="button"], a.button, a[class*="btn"]');
    const count = Math.min(await buttons.count().catch(() => 0), 40);
    for (let i = 0; i < count; i += 1) {
      const button = buttons.nth(i);
      if (!(await button.isVisible().catch(() => false))) continue;
      const text = (
        (await button.innerText().catch(() => "")) ||
        (await button.getAttribute("value").catch(() => "")) ||
        (await button.getAttribute("aria-label").catch(() => "")) ||
        ""
      )
        .replace(/\s+/g, " ")
        .trim();
      if (!text || NOT_PAY.test(text) || !PAY_BUTTON.test(text)) continue;
      // "Pay" beats "Submit"/"Proceed"; an exact pay-word beats a sentence.
      const score = (/^\s*pay\b/i.test(text) ? 0 : 10) + Math.min(text.length, 40) / 10;
      candidates.push({ button, frame, text, score });
    }
  }
  candidates.sort((a, b) => a.score - b.score);
  return candidates[0] || null;
}

/**
 * After paying: a 3-D Secure / OTP step if one appears, up to three rounds.
 *
 * Looked for only where a challenge can be — frames whose URL says so
 * (3ds/acs/challenge…), or pages the flow has moved to since Pay was clicked —
 * never on the card form itself, whose "security code" is not an OTP box.
 */
async function handleChallenge(page, gateway, card, startUrl) {
  let deadline = Date.now() + SETTLE_TIMEOUT;
  const challengeFrames = (frame) => {
    if (CHALLENGE_URL.test(frame.url())) return true;
    const owner = frame.page();
    return owner !== page || owner.url() !== startUrl;
  };
  let rounds = 0;
  let quietSince = null;
  const started = Date.now();

  while (Date.now() < deadline) {
    const newest = page.context().pages().filter((p) => !p.isClosed()).at(-1) || page;
    const moved = newest.url() !== startUrl || page.url() !== startUrl;
    if (moved && /order-received|thank|success|confirmation/i.test(newest.url())) return "completed";

    // The gateway's own success screen, on the SAME URL (ReservePay replaces
    // its form with "Payment successful" and waits for "Back to …"). Nothing
    // left to wait for: the caller clicks the way back.
    if (Date.now() - started > 1500 && (await showsPaymentSuccess(page))) return "succeeded";

    if (rounds < 3) {
      // An ACS simulator's own Submit (Arca: <input id="acssubmit">), on
      // whatever page or frame it opens in — its URL needn't say "acs".
      const acs = await findAcsSubmit(page);
      if (acs) {
        rounds += 1;
        quietSince = null;
        log(gateway, `3-D Secure: clicking ACS "Submit" (#acssubmit${acs.frame === acs.frame.page().mainFrame() ? "" : ` in frame ${acs.frame.url().slice(0, 80)}`})`);
        await acs.button.click().catch(() => {});
        const acsFrame = frameHint(acs.frame);
        recordStep("submit", { click: "#acssubmit", optional: true, timeout: 60000, ...(acsFrame ? { frame: acsFrame } : {}) });
        recordStep("submit", { expect: "hidden", target: "#acssubmit", optional: true, timeout: 60000 });
        // Then wait: the simulator posts back to the gateway, which takes a
        // while to redirect to the store. Until the Submit page is gone…
        const waited = Date.now();
        await acs.button.waitFor({ state: "hidden", timeout: ACS_WAIT }).catch(() => {});
        // …and whatever replaced it has finished loading.
        const now = page.context().pages().filter((p) => !p.isClosed()).at(-1) || page;
        await now.waitForLoadState("load", { timeout: 30000 }).catch(() => {});
        await now.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
        // The redirect back to the store gets a full settle window of its own.
        deadline = Math.max(deadline, Date.now() + SETTLE_TIMEOUT);
        log(gateway, `ACS Submit done after ${Math.round((Date.now() - waited) / 1000)}s — now on ${now.url().slice(0, 100)}`);
        continue;
      }

      const otp = await findField(page, OTP_FIELDS, { frameFilter: challengeFrames });
      if (otp) {
        rounds += 1;
        quietSince = null;
        log(gateway, `3-D Secure / OTP field: ${where(otp)} — entering the test code`);
        await typeInto(otp, card.otp);
        await recordField("submit", otp, "type", "{card.otp}", { optional: true, timeout: 45000 });
        const button = await findChallengeButton(page, challengeFrames);
        if (button) {
          log(gateway, `challenge: clicking "${button.text}"`);
          recordClick("submit", button.text, null, { optional: true }, true);
          await button.button.click().catch(() => {});
        } else {
          await otp.field.press("Enter").catch(() => {});
        }
        await page.waitForTimeout(3000);
        continue;
      }

      const button = await findChallengeButton(page, (frame) => CHALLENGE_URL.test(frame.url()));
      if (button) {
        rounds += 1;
        quietSince = null;
        log(gateway, `3-D Secure: clicking "${button.text}"`);
        recordClick("submit", button.text, null, { optional: true, timeout: 45000 }, true);
        await button.button.click().catch(() => {});
        await page.waitForTimeout(3000);
        continue;
      }
    }

    // Moved on and nothing to answer for a while: the payment went through to
    // wherever the gateway sends it; the flow's own check takes it from here.
    if (moved) {
      quietSince = quietSince || Date.now();
      if (Date.now() - quietSince > 8000) return "navigated";
    }
    await page.waitForTimeout(POLL_MS * 2);
  }
  return page.url() !== startUrl ? "navigated" : "stayed";
}

// What a gateway's own page says once a payment has gone through.
const PAYMENT_SUCCESS =
  /payment (was )?(successful|succeeded|complete(d)?|approved|received)|transaction (successful|approved|complete(d)?)|thank you for your payment|paid successfully/i;

/** Whether any frame of the payment page shows a payment-success message. */
async function showsPaymentSuccess(page) {
  for (const frame of allFrames(page)) {
    const text = await frame
      .locator("body")
      .innerText({ timeout: 1000 })
      .catch(() => "");
    if (PAYMENT_SUCCESS.test(text)) return true;
  }
  return false;
}

/** A visible ACS-simulator Submit button (#acssubmit) in any frame of any open page. */
async function findAcsSubmit(page) {
  for (const frame of allFrames(page)) {
    const button = frame.locator("#acssubmit").first();
    if (await button.isVisible().catch(() => false)) return { button, frame };
  }
  return null;
}

async function findChallengeButton(page, frameFilter) {
  for (const frame of allFrames(page, frameFilter)) {
    const buttons = frame.locator('button, input[type="submit"], [role="button"]');
    const count = Math.min(await buttons.count().catch(() => 0), 20);
    for (let i = 0; i < count; i += 1) {
      const button = buttons.nth(i);
      if (!(await button.isVisible().catch(() => false))) continue;
      const text = ((await button.innerText().catch(() => "")) || (await button.getAttribute("value").catch(() => "")) || "").trim();
      if (text && CHALLENGE_BUTTON.test(text) && !/fail|cancel|decline/i.test(text)) return { button, text };
    }
  }
  return null;
}

async function submit(page, gateway, card) {
  const pay = await findPayButton(page);
  if (!pay) {
    throw new Error(
      `Auto-detect filled the card form for "${gateway}" but found no pay button (looked for "Pay", "Pay now", ` +
        `"Submit payment", "Confirm", …). Give it a recipe with the button (docs/payment-recipes.md).\n` +
        `Frames present:\n${describeFrames(page)}`,
    );
  }

  const startUrl = page.url();
  log(gateway, `pay button: "${pay.text}"${pay.frame === page.mainFrame() ? "" : ` in frame ${pay.frame.url().slice(0, 80)}`}`);
  recordClick("submit", pay.text, pay.frame, { label: "pay" }, true);
  await pay.button.scrollIntoViewIfNeeded().catch(() => {});
  await pay.button.click();

  const outcome = await handleChallenge(page, gateway, card, startUrl);
  if (outcome === "stayed") {
    const shown = await formErrors(page);
    log(
      gateway,
      `⚠ still on the same page ${SETTLE_TIMEOUT / 1000}s after "${pay.text}" — the form may have rejected a field; ` +
        `the flow's own success check decides.${shown.length ? ` The form shows: ${shown.map((t) => `"${t}"`).join(", ")}` : ""}` +
        (card.from === "default" ? " (Paid with the default Visa — the gateway may need its own sandbox card.)" : ""),
    );
  } else if (outcome === "succeeded") {
    log(gateway, "the gateway shows its payment-success screen");
  } else {
    log(gateway, `payment submitted — now on ${page.url()}`);
  }

  // Last step: back to the store, if the gateway's page waits for a click.
  await returnToMerchant(page, gateway);
}

// Hosted checkouts that stop on their own "Payment successful" page and only
// go back to the store when the shopper clicks (ReservePay: "Back to …").
// Never a way back to the checkout or cart — that's a cancel.
const RETURN_BUTTON = /^\s*(back to|return to|go back to|continue to|go to|back to merchant|return to merchant)\b/i;
const NOT_RETURN = /checkout|cart|basket|payment method|cancel|edit|change|login|sign in/i;
const ARRIVED = /order-received|thank-you|thank_you|\/thank|purchase-confirmation|payment-confirmation|callback_type=success/i;

/**
 * After paying: if the gateway's own page is waiting for a "Back to …" click,
 * click it, so the flow's thank-you check gets its page. Looks for 20s; does
 * nothing when the store's own confirmation is already showing.
 */
async function returnToMerchant(page, gateway, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const pages = page.context().pages().filter((p) => !p.isClosed());
    if (pages.some((p) => ARRIVED.test(p.url()))) return;

    for (const frame of allFrames(page)) {
      const candidates = frame.locator('a, button, [role="button"], input[type="submit"]');
      const count = Math.min(await candidates.count().catch(() => 0), 40);
      for (let i = 0; i < count; i += 1) {
        const item = candidates.nth(i);
        if (!(await item.isVisible().catch(() => false))) continue;
        const text = ((await item.innerText().catch(() => "")) || (await item.getAttribute("value").catch(() => "")) || "")
          .replace(/\s+/g, " ")
          .trim();
        if (!text || text.length > 60 || !RETURN_BUTTON.test(text) || NOT_RETURN.test(text)) continue;
        log(gateway, `back to the store: clicking "${text}"`);
        recordStep("submit", { click: { text }, optional: true, timeout: 20000, label: "back to the store" });
        await item.click({ timeout: 10000 }).catch(() => {});
        await page.waitForTimeout(3000);
        return;
      }
    }
    await page.waitForTimeout(1000);
  }
}

/** Visible error messages on any frame: what a form says when it rejects a field. */
async function formErrors(page) {
  const texts = new Set();
  for (const frame of allFrames(page)) {
    const errors = frame.locator('[role="alert"], [aria-live="assertive"], .error, [class*="error" i], [class*="invalid" i]');
    const count = Math.min(await errors.count().catch(() => 0), 15);
    for (let i = 0; i < count; i += 1) {
      const item = errors.nth(i);
      if (!(await item.isVisible().catch(() => false))) continue;
      const text = (await item.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
      if (text && text.length < 200) texts.add(text);
    }
  }
  return [...texts].slice(0, 5);
}

/**
 * The card auto-detect pays with: the environment (.env, or the Credentials
 * tab's Test payment values) over the recipe's card, then the defaults.
 */
function autoCard(gatewayName, recipe = {}) {
  const fromEnv = envCard(gatewayName);
  const card = cardFor({ card: { ...(recipe.card || {}), ...fromEnv } });
  card.from = fromEnv.number
    ? "Credentials → Test payment / .env"
    : recipe.card?.number
      ? "payment forms (config/paymentform.json / data/gateways.json)"
      : "default";
  card.envPrefix = envPrefix(gatewayName);
  return card;
}

/** Auto-detect as a payment-form entry: the same shape the checkout pages call. */
function autoForm(gatewayName, recipe = {}) {
  const card = autoCard(gatewayName, recipe);
  return {
    source: "auto",
    async fillCardDetails(page) {
      console.log("##STEP## payment-form auto-detected");
      await fill(page, gatewayName, card);
    },
    async submitCardPayment(page) {
      await submit(page, gatewayName, card);
    },
  };
}

module.exports = { autoForm, autoCard, FIELDS };
