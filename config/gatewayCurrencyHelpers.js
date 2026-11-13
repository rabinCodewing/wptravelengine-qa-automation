// config/gatewayCurrencyHelpers.js
//
// Currency-lookup helpers built on top of config/gatewayConfigs.js.
// Lives in the same folder as gatewayConfigs.js so the require path stays flat.

const gatewayConfigs = require("./gatewayConfigs.js");

/**
 * Returns all gateway names that support a given ISO-4217 currency code.
 * Gateways with an empty `currencies` array (not yet confirmed) are excluded.
 *
 * @param {string} currency - e.g. "USD", "EUR", "NGN"
 * @returns {string[]} matching gateway names
 */
function getGatewaysForCurrency(currency) {
  const target = currency.toUpperCase();
  return Object.entries(gatewayConfigs)
    .filter(
      ([, cfg]) =>
        Array.isArray(cfg.currencies) && cfg.currencies.includes(target),
    )
    .map(([name]) => name);
}

/**
 * Checks whether a specific gateway supports a given currency.
 *
 * @param {string} gatewayName
 * @param {string} currency
 * @returns {boolean}
 */
function gatewaySupportsCurrency(gatewayName, currency) {
  const cfg = gatewayConfigs[gatewayName];
  if (!cfg || !Array.isArray(cfg.currencies)) return false;
  return cfg.currencies.includes(currency.toUpperCase());
}

/**
 * Returns a map of currency -> [gateways] for every currency currently
 * covered in the config. Useful for a coverage dashboard or a quick
 * console check of which currencies have zero supporting gateways.
 *
 * @returns {Record<string, string[]>}
 */
function getCurrencyToGatewaysMap() {
  const map = {};
  for (const [name, cfg] of Object.entries(gatewayConfigs)) {
    if (!Array.isArray(cfg.currencies)) continue;
    for (const currency of cfg.currencies) {
      if (!map[currency]) map[currency] = [];
      map[currency].push(name);
    }
  }
  return map;
}

/**
 * Returns gateway names that still need currency confirmation
 * (i.e. `currencies` is an empty array in gatewayConfigs.js).
 *
 * @returns {string[]}
 */
function getGatewaysMissingCurrencyInfo() {
  return Object.entries(gatewayConfigs)
    .filter(
      ([, cfg]) => Array.isArray(cfg.currencies) && cfg.currencies.length === 0,
    )
    .map(([name]) => name);
}

module.exports = {
  getGatewaysForCurrency,
  gatewaySupportsCurrency,
  getCurrencyToGatewaysMap,
  getGatewaysMissingCurrencyInfo,
};
