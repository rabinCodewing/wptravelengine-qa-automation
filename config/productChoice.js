// config/productChoice.js
//
// Which trip a run books, and what to try next when it can't.
//
// Candidates, in order (candidates()):
//   1. the gateway's own `trip` from gatewayConfigs.js — some gateways only
//      work against one trip's price or currency;
//   2. WTE_TRIPS from .env (a JSON array, or one name per line / comma);
//   3. null — the first priced trip on the /trip archive.
//
// openProduct() in config/currencyPlatforms.js is used as it is. Ported from
// paylexer-playwright and trimmed to WP Travel Engine.

const LIST_ENV = { wte: "WTE_TRIPS" };

function listFromEnv(platformKey = "wte", env = process.env) {
  const raw = env[LIST_ENV[platformKey]];
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map((name) => String(name).trim()).filter(Boolean) : [];
  } catch {
    // Not JSON: one name per line or comma, for a hand-written .env.
    return String(raw).split(/[\n,]/).map((name) => name.trim()).filter(Boolean);
  }
}

/**
 * The trips to try, in order. null means "the first priced trip".
 *
 * @param {string} platformKey  "wte"
 * @param {string} [gatewayProduct]  the gateway's own `trip`, when it has one
 */
function candidates(platformKey, gatewayProduct, env = process.env) {
  const names = [gatewayProduct, ...listFromEnv(platformKey, env)].filter(Boolean);

  const unique = [];
  for (const name of names) {
    if (!unique.some((seen) => seen.toLowerCase() === name.toLowerCase())) unique.push(name);
  }
  unique.push(null);
  return unique;
}

const label = (name) => (name === null ? "the first priced listing" : `"${name}"`);

/**
 * Tries the candidates from `start` until one opens. Returns openProduct()'s
 * result plus { product, index, tried }.
 */
async function openWithFallback(platform, platformKey, page, list, start = 0) {
  const tried = [];
  for (let index = start; index < list.length; index += 1) {
    const name = list[index];
    if (list.length > 1) console.log(`Product ${index + 1} of ${list.length}: ${label(name)}`);
    try {
      // strict: a named trip that isn't there throws (WPTE would otherwise
      // quietly book the first priced trip), so the next candidate gets a turn.
      const result = await platform.openProduct(page, name ?? undefined, { strict: name !== null });
      if (index > 0) console.log(`✓ Using ${label(name)} after ${index} product(s) could not be used`);
      return { ...result, product: name, index, tried };
    } catch (error) {
      const reason = String(error.message || error).split("\n")[0].slice(0, 200);
      tried.push(`${label(name)}: ${reason}`);
      if (index === list.length - 1) {
        throw new Error(
          list.length > 1
            ? `No trip could be used on ${platformKey}. Tried — ${tried.join(" | ")}`
            : error.message,
        );
      }
      console.log(`⚠ ${label(name)} could not be used (${reason}) — trying the next product`);
    }
  }
  throw new Error(`No product left to try on ${platformKey}.`);
}

module.exports = { candidates, openWithFallback, listFromEnv, label };
