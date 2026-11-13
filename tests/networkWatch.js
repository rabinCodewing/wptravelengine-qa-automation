// tests/networkWatch.js
//
// Records the network calls that failed while a test ran, so a failed run can
// say WHICH API broke — "POST api.gateway.com/v1/close-transaction → 400" — and
// not only what the page showed afterwards.
//
// Watched on the browser CONTEXT, not one page: the payment step often happens
// in a popup or a hosted checkout tab the flow opens, and its API calls are the
// ones that matter most.
//
// What counts as failed:
//   - a response with status 4xx/5xx
//   - a request that never got one (DNS, refused, timeout, TLS…)
//   - a 2xx fetch/XHR whose JSON says it failed — {"error": true} or
//     {"success": false} at the top level. WooCommerce's add-to-cart and
//     WordPress's admin-ajax answer a refusal that way, with status 200.
//
// What is left out, because it is noise on every WordPress page:
//   - images, fonts, stylesheets, media
//   - analytics / tracking / telemetry hosts
//   - requests the browser itself abandoned (navigation cancelled them)
//
// What is never stored: request headers, request bodies, cookies. The URL keeps
// its path but masks sensitive query values, and the response excerpt (error
// responses only, a few hundred characters) has sensitive JSON fields and every
// secret value from the environment masked.

const IGNORED_TYPES = new Set(["image", "font", "stylesheet", "media", "texttrack", "manifest"]);

const IGNORED_HOSTS =
  /(^|\.)(google-analytics\.com|googletagmanager\.com|doubleclick\.net|gstatic\.com|facebook\.(com|net)|hotjar\.com|clarity\.ms|sentry\.io|segment\.(io|com)|mixpanel\.com|stats\.wp\.com|pixel\.wp\.com|intercom\.io|newrelic\.com|nr-data\.net|datadoghq\.com|cloudflareinsights\.com)$/i;

// The browser cancelled these itself — a navigation superseded them.
const ABORTED = /NS_BINDING_ABORTED|net::ERR_ABORTED|NS_ERROR_ABORT|cancelled|canceled/i;

const SENSITIVE_NAME =
  /token|secret|password|passwd|pass$|api[-_]?key|apikey|^key$|_key$|signature|^sig$|auth|session|cookie|card|cvv|cvc|^pan$|iban|otp|pin$/i;

// Env vars whose VALUES must never appear: gateway keys, passwords, tokens.
const SECRET_ENV = /(KEY|SECRET|TOKEN|PASSWORD|PASS|SIGNATURE|SALT|HASH|WEBHOOK)/i;

const MAX_RECORDS = 50;
const MAX_BODY = 600;
const BODY_TIMEOUT_MS = 3000;

function secretsFromEnv(env = process.env) {
  return Object.entries(env)
    .filter(([name, value]) => SECRET_ENV.test(name) && typeof value === "string")
    .map(([, value]) => value.trim())
    .filter((value) => value.length >= 6)
    .sort((a, b) => b.length - a.length);
}

function maskSecrets(text, secrets) {
  let out = String(text);
  for (const secret of secrets) out = out.split(secret).join("••••••");
  return out;
}

/** The URL without its fragment, with sensitive query values masked. */
function cleanUrl(raw, secrets) {
  try {
    const url = new URL(raw);
    url.hash = "";
    for (const name of [...url.searchParams.keys()]) {
      if (sensitive(name)) url.searchParams.set(name, "•••");
    }
    // searchParams encodes the mask; shown as written, it reads as masked.
    return maskSecrets(url.toString().replace(/%E2%80%A2/gi, "•"), secrets);
  } catch {
    return maskSecrets(String(raw).split("#")[0], secrets);
  }
}

// Named like a secret but never one: what an API calls its error codes.
const SAFE_NAME = /^(error|err|status|reason|result)[-_]?(key|code)$|^key[-_]?(name|type)$/i;

const sensitive = (name) => SENSITIVE_NAME.test(name) && !SAFE_NAME.test(name);

function maskJson(value) {
  if (Array.isArray(value)) return value.map(maskJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, inner]) => [key, sensitive(key) ? "•••" : maskJson(inner)]),
    );
  }
  return value;
}

/** A short, safe excerpt of an error response body. */
function cleanBody(text, contentType, secrets) {
  if (!text) return null;
  let out = text;
  if (/json/i.test(contentType || "")) {
    try {
      out = JSON.stringify(maskJson(JSON.parse(text)));
    } catch {
      // Not valid JSON after all; treated as text.
    }
  } else if (/html/i.test(contentType || "")) {
    // An HTML error page: its title / first heading says it, the markup does not.
    const title = text.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] || text.match(/<h1[^>]*>([^<]*)<\/h1>/i)?.[1];
    out = title ? title.trim() : text.replace(/<[^>]+>/g, " ");
  }
  out = maskSecrets(out.replace(/\s+/g, " ").trim(), secrets);
  return out.length > MAX_BODY ? `${out.slice(0, MAX_BODY)}…` : out || null;
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

function ignored(request) {
  if (IGNORED_TYPES.has(request.resourceType())) return true;
  const host = hostOf(request.url());
  return !host || IGNORED_HOSTS.test(host) || request.url().startsWith("data:");
}

const withTimeout = (promise, ms) =>
  Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(null), ms).unref?.())]);

/**
 * Starts watching a browser context. Never throws, never slows a request:
 * every handler is fire-and-forget and swallows its own errors.
 *
 * @returns {{ stop: () => Promise<object[]> }} stop() ends the watch and
 *          resolves to the failed calls, oldest first.
 */
function watchNetwork(context, { secrets = secretsFromEnv() } = {}) {
  const started = Date.now();
  const records = [];
  const pending = new Set();
  let stopped = false;

  const add = (record) => {
    if (stopped || records.length >= MAX_RECORDS) return;
    records.push(record);
  };

  const base = (request) => ({
    at: Date.now() - started,
    method: request.method(),
    url: cleanUrl(request.url(), secrets),
    host: hostOf(request.url()),
    type: request.resourceType(),
    // The page the call was made from, so a popup's calls read as the popup's.
    page: (() => {
      try {
        return cleanUrl(request.frame().page().url(), secrets);
      } catch {
        return null;
      }
    })(),
  });

  // A 2xx API answer that reports a failure in its body. Read only for
  // fetch/XHR with a JSON content type, and never waited on by the page.
  const checkSoftFailure = (response) => {
    const request = response.request();
    const type = response.headers()["content-type"] || "";
    if (!["fetch", "xhr"].includes(request.resourceType()) || !/json/i.test(type) || ignored(request)) return;

    const record = { ...base(request), status: response.status(), statusText: "error in the response body", body: null };
    const read = withTimeout(response.text(), BODY_TIMEOUT_MS)
      .then((text) => {
        let json;
        try {
          json = JSON.parse(text);
        } catch {
          return;
        }
        if (!json || typeof json !== "object" || Array.isArray(json)) return;
        if (json.error !== true && json.success !== false) return;
        record.body = cleanBody(text, type, secrets);
        add(record);
      })
      .catch(() => {})
      .finally(() => pending.delete(read));
    pending.add(read);
  };

  const onResponse = (response) => {
    try {
      const status = response.status();
      if (status < 400) {
        if (status >= 200 && status < 300) checkSoftFailure(response);
        return;
      }
      if (ignored(response.request())) return;

      const record = { ...base(response.request()), status, statusText: response.statusText() || null, body: null };
      add(record);

      // The body says WHY ("merchant not found"); worth a short wait, never more.
      const type = response.headers()["content-type"] || "";
      const read = withTimeout(response.text(), BODY_TIMEOUT_MS)
        .then((text) => {
          record.body = cleanBody(text, type, secrets);
        })
        .catch(() => {})
        .finally(() => pending.delete(read));
      pending.add(read);
    } catch {
      // A response from a page that is closing: nothing to record.
    }
  };

  const onFailed = (request) => {
    try {
      const failure = request.failure()?.errorText || "failed";
      if (ABORTED.test(failure) || ignored(request)) return;
      add({ ...base(request), status: null, statusText: null, failure, body: null });
    } catch {
      // As above.
    }
  };

  context.on("response", onResponse);
  context.on("requestfailed", onFailed);

  return {
    async stop() {
      context.off("response", onResponse);
      context.off("requestfailed", onFailed);
      // Bodies still being read may yet add a record (a 200 that says it
      // failed), so the door closes only after they finish.
      await withTimeout(Promise.allSettled([...pending]), BODY_TIMEOUT_MS);
      stopped = true;
      return records;
    },
  };
}

/**
 * The call most likely to have broken the run: the LAST failed API call
 * (fetch/XHR) before the test ended — the flow acts on an API's answer
 * moments after it arrives — else the last failed page load, else the last
 * failure of any kind. Returns its index, or -1.
 */
function likelyCulprit(records) {
  const lastIndex = (test) => {
    for (let i = records.length - 1; i >= 0; i -= 1) if (test(records[i])) return i;
    return -1;
  };
  const api = lastIndex((r) => r.type === "fetch" || r.type === "xhr");
  if (api !== -1) return api;
  const document = lastIndex((r) => r.type === "document");
  if (document !== -1) return document;
  return records.length - 1;
}

module.exports = { watchNetwork, likelyCulprit, cleanUrl, cleanBody, maskSecrets, secretsFromEnv };
