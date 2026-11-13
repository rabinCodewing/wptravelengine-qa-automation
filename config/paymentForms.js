// config/paymentForms.js — which payment form a gateway's run uses.
//
// The one place that answers "how does this gateway pay?", for the checkout
// page objects (pages/*CheckoutPage.js), the UI server and the sweep script.
//
//   1. Hand-written code in config/gatewayPaymentForms.js       "code"
//   2. A recipe with steps in data/gateways.json → paymentForms  "recipe"
//   3. Neither: the card form is found and filled on its own    "auto"
//      (config/paymentAuto.js)
//
// So a gateway added from the UI — a definition, keys and a currency, nothing
// else — checks out and pays end to end. A recipe is only needed when the
// guess is wrong, and code only for what a recipe cannot express.
//
// Code wins over a recipe, so adding one never changes how an existing
// gateway runs — unless the recipe says "useInsteadOfCode": true, which is how
// a gateway is moved off its code and tried side by side first. The same flag
// with "auto": true runs a coded gateway through auto-detection instead.
//
// A recipe entry WITHOUT steps still matters: its "card" is the test card
// auto-detection uses, and "noCardForm": true turns payment off for a gateway
// that has nothing to fill (the run passes straight through after checkout,
// as every form-less gateway used to). "successUrl" on an entry is where the
// gateway lands after paying instead of the store's Thank You page; reaching
// it passes the run (successUrlFor()).
//
// Read fresh on every call: a recipe saved from the UI is picked up by the
// next run without restarting anything.

const fs = require("fs");
const path = require("path");
const gatewayPaymentForms = require("./gatewayPaymentForms");
const gatewayConfigs = require("./gatewayConfigs");
const gatewayStore = require("./gatewayStore");
const { recipeForm, envCard, envPrefix } = require("./paymentRecipes");
const { autoForm } = require("./paymentAuto");

// Shared, committed payment forms: sandbox test cards and recipes the whole
// team uses. config/paymentform.json.
const SHARED_FILE = path.join(__dirname, "paymentform.json");

function sharedForms() {
  try {
    const parsed = JSON.parse(fs.readFileSync(SHARED_FILE, "utf8"));
    // Keys starting with "_" are notes, not gateways.
    return Object.fromEntries(Object.entries(parsed).filter(([name]) => !name.startsWith("_")));
  } catch (error) {
    if (error.code !== "ENOENT") console.warn(`⚠ Could not read ${SHARED_FILE}: ${error.message}`);
    return {};
  }
}

/**
 * Every gateway's payment form: config/paymentform.json (shared), with
 * data/gateways.json → paymentForms (local) over it — field by field, and the
 * card merged too, so a local test card can sit on top of shared steps.
 */
function savedRecipes() {
  const shared = sharedForms();
  const local = gatewayStore.load().paymentForms || {};
  const merged = { ...shared };
  for (const [name, form] of Object.entries(local)) {
    const base = shared[name] || {};
    merged[name] = { ...base, ...form, card: { ...(base.card || {}), ...(form.card || {}) } };
  }
  return merged;
}

function recipeOf(name, recipes) {
  const recipe = recipes[name];
  return recipe && typeof recipe === "object" ? recipe : null;
}

const hasSteps = (recipe) =>
  Boolean(recipe && ((Array.isArray(recipe.fill) && recipe.fill.length) || (Array.isArray(recipe.submit) && recipe.submit.length)));

/** "code" | "recipe" | "auto" | null (no card entry) — how this gateway pays. */
function paymentFormSource(name, recipes = savedRecipes()) {
  const code = Boolean(gatewayPaymentForms[name]);
  const recipe = recipeOf(name, recipes);
  const overrideCode = Boolean(recipe?.useInsteadOfCode);

  if (code && !overrideCode) return "code";
  if (recipe?.noCardForm) return null;
  if (hasSteps(recipe) && !recipe.auto) return "recipe";
  return "auto";
}

/**
 * A coded entry with the gateway's test values from the environment (.env,
 * or Credentials → Test payment) over the ones written in it — for the
 * entries that keep theirs as TEST_* properties. One that types a constant
 * inline keeps it; the Credentials tab says so.
 */
function withTestValues(name, entry) {
  const env = envCard(name);
  const overrides = {};
  const set = (props, value) => {
    for (const prop of props) if (value && prop in entry) overrides[prop] = value;
  };
  set(["TEST_CARD_NUMBER"], env.number);
  set(["TEST_CVV", "TEST_CVC"], env.cvc);
  set(["TEST_OTP"], env.otp);
  set(["TEST_MOBILE", "TEST_PHONE"], env.phone);
  const expiry = String(env.expiry || "").match(/^(\d{2})\s*\/?\s*(\d{2,4})$/);
  if (expiry) {
    if ("TEST_EXPIRY_MONTH" in entry) overrides.TEST_EXPIRY_MONTH = expiry[1];
    if ("TEST_EXPIRY_YEAR" in entry) {
      const year = expiry[2].length === 4 ? expiry[2] : `20${expiry[2]}`;
      overrides.TEST_EXPIRY_YEAR = String(entry.TEST_EXPIRY_YEAR).length === 2 ? year.slice(-2) : year;
    }
  }
  if (!Object.keys(overrides).length) return entry;
  // Methods call this.TEST_*, so they read the overrides through the prototype.
  return Object.assign(Object.create(entry), overrides);
}

/** Whether a coded entry reads its card from TEST_* properties (so the UI's values apply). */
function codeReadsTestValues(name) {
  const entry = gatewayPaymentForms[name];
  return Boolean(entry && "TEST_CARD_NUMBER" in entry);
}

/**
 * The payment form for a gateway — { fillCardDetails, submitCardPayment } —
 * or null when it is marked as having no card form.
 */
function paymentFormFor(name) {
  const recipes = savedRecipes();
  const source = paymentFormSource(name, recipes);
  if (source === "code") return withTestValues(name, gatewayPaymentForms[name]);
  if (source === "recipe") {
    const recipe = recipeOf(name, recipes);
    return recipeForm(name, { ...recipe, card: { ...(recipe.card || {}), ...envCard(name) } });
  }
  if (source === "auto") return autoForm(name, recipeOf(name, recipes) || {});
  return null;
}

/**
 * Where the gateway sends the shopper after paying, when that is NOT the
 * store's Thank You page (Galaxy Pay's sandbox redirects to its own demo
 * merchant). Reaching a URL that starts with it passes the run. Null for every
 * gateway that returns to the store.
 *
 * <GATEWAY>_SUCCESS_URL (Credentials → After payment, or .env) first, then
 * "successUrl" on its payment form.
 */
function successUrlFor(name, env = process.env) {
  const url = env[`${envPrefix(name)}SUCCESS_URL`] || recipeOf(name, savedRecipes())?.successUrl;
  return typeof url === "string" && url.trim() ? url.trim() : null;
}

/** The payment form's own "successUrl" — what an empty <GATEWAY>_SUCCESS_URL falls back to. */
function formSuccessUrl(name) {
  const url = recipeOf(name, savedRecipes())?.successUrl;
  return typeof url === "string" && url.trim() ? url.trim() : "";
}

function hasPaymentForm(name) {
  return paymentFormSource(name) !== null;
}

/**
 * Every gateway a run can be started for: anything with a definition
 * (config/gatewayConfigs.js, built in or added from the UI) — auto-detection
 * means none of them needs a payment form written first — plus anything with
 * code or a recipe.
 */
function gatewaysWithPaymentForm() {
  return [
    ...new Set([...Object.keys(gatewayConfigs), ...Object.keys(gatewayPaymentForms), ...Object.keys(savedRecipes())]),
  ];
}

module.exports = {
  paymentFormFor,
  paymentFormSource,
  hasPaymentForm,
  gatewaysWithPaymentForm,
  codeReadsTestValues,
  successUrlFor,
  formSuccessUrl,
};
