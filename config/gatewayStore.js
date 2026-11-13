// config/gatewayStore.js
//
// What the UI's Credentials tab saves: gateways added from the UI, and
// credential values typed into it. One JSON file, data/gateways.json:
//
//   {
//     "gateways":    { "Acme": { displayName, slug, fields, currencies, ... } },
//     "credentials": { "ACME_API_KEY": "sk_...", "STRIPE_SECRET_KEY": "..." },
//     "overrides":   { "Stripe": { currencies: [...], defaultCurrency: "EUR" } },
//     "paymentForms": { "Acme": { card: {...}, fill: [...], submit: [...] } }
//   }
//
// "paymentForms" holds payment-form recipes: a gateway's card-entry steps as
// data, run by config/paymentRecipes.js (see config/paymentForms.js for when a
// recipe is used instead of code).
//
// "overrides" changes a BUILT-IN gateway's currencies without touching
// config/gatewayConfigs.js; dropping the entry goes back to what that file says.
//
// ── How each half reaches a run ──────────────────────────────────────────────
// Gateways: config/gatewayConfigs.js merges them in when it is required, so the
// spec (a separate `playwright test` process) sees a UI-added gateway exactly
// like one written into that file. Built-in entries win on a name clash, and
// the UI refuses to create one anyway.
//
// Credentials: NOT merged into process.env here. scripts/uiServer.js adds them
// to each run's spawn environment, over .env, so a value saved in the UI wins
// for UI runs and a CLI run (`npm run test:both`) still reads .env alone.
//
// ── Why a file, not the results database ─────────────────────────────────────
// gatewayConfigs.js is required synchronously at module load, in every test
// process. PostgreSQL is async and not always there (the SQLite fallback);
// a file is readable from both, the same way .env is.
//
// Plain text on disk, like .env — written 0600, kept out of git and out of the
// Docker image, and mounted as a volume so it survives a rebuild.

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const STORE_FILE = process.env.GATEWAY_STORE_FILE
  ? path.resolve(ROOT, process.env.GATEWAY_STORE_FILE)
  : path.join(ROOT, "data", "gateways.json");

function emptyStore() {
  return { gateways: {}, credentials: {}, overrides: {}, paymentForms: {}, paylexer: null, accounts: {} };
}

function load() {
  try {
    const parsed = JSON.parse(fs.readFileSync(STORE_FILE, "utf8"));
    return {
      gateways: parsed && typeof parsed.gateways === "object" ? parsed.gateways || {} : {},
      credentials:
        parsed && typeof parsed.credentials === "object" ? parsed.credentials || {} : {},
      overrides: parsed && typeof parsed.overrides === "object" ? parsed.overrides || {} : {},
      // Kept on every load, so a save from any other part of the UI (keys,
      // currencies) writes the recipes back untouched.
      paymentForms:
        parsed && typeof parsed.paymentForms === "object" ? parsed.paymentForms || {} : {},
      // The last "Sync from PayLexer" (scripts/paylexerSync.js): each gateway's
      // status and webhook needs there. Kept on every load like the recipes.
      paylexer: parsed && typeof parsed.paylexer === "object" ? parsed.paylexer || null : null,
      // Per PayLexer account (accountKey()): its gateways' status and the
      // sandbox keys PayLexer has verified for it, from its last sync.
      accounts: parsed && typeof parsed.accounts === "object" ? parsed.accounts || {} : {},
    };
  } catch (error) {
    // No file yet is the normal first state. A corrupt one is reported but
    // does not stop a run: it just has no UI-added gateways or saved keys.
    if (error.code !== "ENOENT") {
      console.warn(`⚠ Could not read ${STORE_FILE}: ${error.message}`);
    }
    return emptyStore();
  }
}

/** Write-then-rename, so a run reading the file never sees half of it. */
function save(store) {
  fs.mkdirSync(path.dirname(STORE_FILE), { recursive: true });
  const temp = `${STORE_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, STORE_FILE);
}

/** The UI-added gateway definitions, each marked `custom: true`. */
function customGateways(store = load()) {
  const out = {};
  for (const [name, gateway] of Object.entries(store.gateways)) {
    const synced = syncedFields(name, store);
    out[name] = {
      ...gateway,
      // PayLexer's own list once synced; else the saved one, where fields saved
      // before the form fixed bare ids are repaired on read.
      fields:
        synced ||
        (gateway.fields || []).map((field) => ({ ...field, locator: fieldLocator(field.locator, field.name) })),
      fieldsFromPaylexer: Boolean(synced),
      custom: true,
    };
  }
  return out;
}

/**
 * The credential fields on a gateway's PayLexer configure page, as the last
 * "Sync from PayLexer" read them (scripts/paylexerSync.js), shaped like a
 * gatewayConfigs field list — or null when it has none synced.
 */
function syncedFields(name, store = load()) {
  const fields = store.paylexer?.gateways?.[name]?.fields;
  if (!Array.isArray(fields) || !fields.length) return null;
  return fields.map((field) => ({
    name: field.name,
    locator: field.locator,
    ...(field.optional ? { optional: true } : {}),
    ...(field.webhook ? { webhook: true } : {}),
  }));
}

/**
 * Which PayLexer account a sync, a run or a page belongs to: its origin and
 * email, "https://app-staging.paylexer.com|you@example.com". Keys synced
 * from one account never serve another's runs. "" when either is missing.
 */
function accountKey(paylexerUrl, email) {
  let origin = "";
  try {
    origin = new URL(String(paylexerUrl || "").trim()).origin;
  } catch {}
  const who = String(email || "").trim().toLowerCase();
  return origin && who ? `${origin}|${who}` : "";
}

/** One account's synced data ({ syncedAt, account, gateways, credentials }), or null. */
function accountData(key, store = load()) {
  return (key && store.accounts?.[key]) || null;
}

/** A gateway's field list as written by hand, before any sync replaced it. */
function builtInFields(name, store = load()) {
  return originals.get(name)?.fields || store.gateways[name]?.fields || null;
}

/**
 * Re-syncs a gatewayConfigs object in place after the store changed: drops the
 * custom entries it had and adds the current ones. In place because every
 * module in the server holds the same required object.
 */
function applyCustomGateways(target, store = load()) {
  for (const [name, gateway] of Object.entries(target)) {
    if (gateway && gateway.custom) delete target[name];
  }
  applyOverrides(target, store);
  for (const [name, gateway] of Object.entries(customGateways(store))) {
    if (!target[name]) target[name] = gateway;
  }
  return target;
}

// Each built-in gateway's currencies as config/gatewayConfigs.js wrote them,
// recorded the first time an override is applied, so a reset — or a second
// apply in the same process — starts from the file and not from the last
// override.
const originals = new Map();

/** A built-in gateway's currencies before any override. */
function builtInCurrencies(name) {
  return originals.get(name) || null;
}

/**
 * Puts the saved currency overrides onto the built-in entries, in place, and
 * the credential fields from the last "Sync from PayLexer" in place of the
 * hand-written ones (PayLexer's form is what the run fills).
 */
function applyOverrides(target, store = load()) {
  for (const [name, entry] of Object.entries(target)) {
    if (!entry || entry.custom) continue;

    if (!originals.has(name)) {
      originals.set(name, {
        currencies: entry.currencies || [],
        defaultCurrency: entry.defaultCurrency || "",
        fields: entry.fields || [],
      });
    }

    const base = originals.get(name);
    const override = store.overrides[name];

    entry.currencies = override ? override.currencies : base.currencies;
    entry.defaultCurrency = override ? override.defaultCurrency : base.defaultCurrency;
    entry.currenciesOverridden = Boolean(override);

    const synced = syncedFields(name, store);
    entry.fields = synced || base.fields;
    entry.fieldsFromPaylexer = Boolean(synced);
  }
  return target;
}

/**
 * The locator PayLexer's configuration form uses for a field label. 168 of the
 * 170 built-in fields follow it: "API Key" -> #test_apiKeyTest,
 * "Merchant ID" -> #test_merchantIdTest. The UI shows it and lets it be
 * overridden for the ones that do not.
 */
function defaultLocator(fieldName) {
  const words = String(fieldName)
    .replace(/[^A-Za-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  if (!words.length) return "";

  const camel = words
    .map((word, index) => {
      const lower = word.toLowerCase();
      return index === 0 ? lower : lower[0].toUpperCase() + lower.slice(1);
    })
    .join("");

  return `#test_${camel}Test`;
}

/**
 * A field's selector as typed into the Add-gateway form, made usable. People
 * type the input's id ("test_installationIdTest") where a selector is needed
 * ("#test_installationIdTest"); as a selector a bare word means an ELEMENT of
 * that name, which never exists, and the run times out on the configure page.
 * A bare id-like word gets its "#"; anything else is kept as typed.
 */
function fieldLocator(raw, fieldName) {
  const value = String(raw || "").trim();
  if (!value) return defaultLocator(fieldName || "");
  if (/^[A-Za-z_][\w-]*$/.test(value)) return `#${value}`;
  return value;
}

const CURRENCY = /^[A-Z]{3}$/;

/**
 * Validates a currency list and default posted from the UI, pushing any
 * problem onto `errors`. Codes are upper-cased and de-duplicated; the default
 * falls back to the first code.
 */
function normaliseCurrencies(input, errors) {
  const currencies = [
    ...new Set(
      (Array.isArray(input.currencies) ? input.currencies : String(input.currencies || "").split(/[\s,]+/))
        .map((code) => String(code).trim().toUpperCase())
        .filter(Boolean),
    ),
  ];

  const badCurrencies = currencies.filter((code) => !CURRENCY.test(code));
  if (badCurrencies.length) {
    errors.push(`Not 3-letter currency codes: ${badCurrencies.join(", ")}.`);
  }
  if (!currencies.length) errors.push("Add at least one supported currency (e.g. USD).");

  const defaultCurrency =
    String(input.defaultCurrency || "").trim().toUpperCase() || currencies[0] || "";
  if (defaultCurrency && !currencies.includes(defaultCurrency)) {
    errors.push(`Default currency ${defaultCurrency} is not in the supported list.`);
  }

  return { currencies, defaultCurrency };
}

/**
 * "Chargily Pay" → "ChargilyPay", "Cost+" → "CostPlus" (as in
 * gatewayConfigs.js): the name as a gateway key and .env prefix —
 * letters and digits, starting with a letter, at most 40. Every place that
 * takes a new gateway's name goes through this, so a space or a "+" is
 * dropped rather than refused.
 */
function cleanName(value) {
  return String(value || "")
    .replace(/\+/g, " Plus ")
    .replace(/&/g, " And ")
    .split(/[^A-Za-z0-9]+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join("")
    .replace(/^[0-9]+/, "")
    .slice(0, 40);
}

/**
 * Validates a gateway posted from the UI. Returns { errors, gateway } with the
 * gateway normalised to the shape gatewayConfigs.js entries have. The name is
 * cleaned (cleanName); the name as typed is kept as the display name when no
 * display name is given.
 */
function normaliseGateway(input, { builtInNames = [] } = {}) {
  const errors = [];
  const typed = String(input.name || "").trim();
  const name = cleanName(typed);

  if (name.length < 2) {
    errors.push(
      typed
        ? `"${typed}" leaves too little once spaces, symbols and leading digits are dropped (it becomes the .env prefix, e.g. ACME_API_KEY). Spell it out, e.g. 2C2P → TwoCTwoP.`
        : "Give the gateway a name (it becomes the .env prefix, e.g. ACME_API_KEY).",
    );
  }
  if (builtInNames.some((builtIn) => builtIn.toLowerCase() === name.toLowerCase())) {
    errors.push(`"${name}" is a built-in gateway; its credentials can be edited, but not its definition.`);
  }
  const displayName = String(input.displayName || "").trim() || typed || name;

  const fields = (Array.isArray(input.fields) ? input.fields : [])
    .map((field) => ({
      name: String(field.name || "").trim(),
      locator: fieldLocator(field.locator, field.name),
    }))
    .filter((field) => field.name);

  if (!fields.length) errors.push("Add at least one credential field (e.g. API Key).");

  const labels = new Set();
  for (const field of fields) {
    const key = field.name.toLowerCase();
    if (labels.has(key)) errors.push(`Field "${field.name}" is listed twice.`);
    labels.add(key);
  }

  const { currencies, defaultCurrency } = normaliseCurrencies(input, errors);

  const gateway = {
    displayName,
    fields,
    currencies,
    defaultCurrency,
    successMessage: String(input.successMessage || "").trim() || "Connection successful.",
  };

  const slug = String(input.slug || "").trim();
  if (slug) gateway.slug = slug;

  return { errors, name, gateway };
}

module.exports = {
  STORE_FILE,
  load,
  save,
  customGateways,
  applyCustomGateways,
  applyOverrides,
  builtInCurrencies,
  builtInFields,
  accountKey,
  accountData,
  syncedFields,
  defaultLocator,
  fieldLocator,
  normaliseCurrencies,
  normaliseGateway,
  cleanName,
};
