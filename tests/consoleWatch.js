// tests/consoleWatch.js
//
// Records the JavaScript errors the browser reported while a test ran: console
// errors (console.error, a script the page logged as failing) and uncaught page
// errors (an exception nothing caught, a rejected promise nobody handled).
//
// The companion of tests/networkWatch.js. A failed API call says which server
// refused; a console error says the page's own code broke — a gateway SDK that
// threw while mounting its card iframe, a plugin script with a typo, a CSP
// block on the hosted checkout. Those failures leave every network call green
// and the only trace of them is here.
//
// Watched on the browser CONTEXT, like the network: the payment step often runs
// in a popup or a hosted checkout tab, and its errors are the ones that matter.
//
// What is left out, because it is noise on every WordPress page:
//   - warnings, info, debug — errors only
//   - "Failed to load resource" lines (the network watch already has the call)
//   - analytics / tracking scripts, browser-extension and devtools chatter
//
// The same message repeated (a script throwing in a loop) is one record with a
// count, so fifty copies of one error cannot push the others out.
//
// What is never stored: anything matching an environment secret. The text and
// the source URL are masked the same way the network watch masks its URLs.

const { cleanUrl, maskSecrets, secretsFromEnv } = require("./networkWatch");

const MAX_RECORDS = 30;
const MAX_TEXT = 500;
const MAX_STACK = 800;

const NOISE =
  /Failed to load resource|favicon\.ico|Download the React DevTools|JQMIGRATE|google-analytics|googletagmanager|doubleclick|facebook\.net|hotjar|clarity\.ms|moz-extension:|chrome-extension:|Content-Security-Policy: The page’s settings observed|downloadable font/i;

function clip(text, max) {
  const out = String(text || "").replace(/\s+$/g, "");
  return out.length > max ? `${out.slice(0, max)}…` : out;
}

// Frames from the automation itself, not the page: Firefox's Juggler driver
// and the evaluate() wrapper Playwright injects.
const DRIVER_FRAME = /chrome:\/\/juggler|debugger eval code|__playwright/;

function pageStack(stack) {
  return String(stack)
    .split("\n")
    .filter((line) => !DRIVER_FRAME.test(line))
    .join("\n");
}

function pageUrl(page, secrets) {
  try {
    return page ? cleanUrl(page.url(), secrets) : null;
  } catch {
    return null;
  }
}

/**
 * Starts watching a browser context. Never throws, never slows the page:
 * every handler swallows its own errors.
 *
 * @returns {{ stop: () => object[] }} stop() ends the watch and returns the
 *          errors, oldest first.
 */
function watchConsole(context, { secrets = secretsFromEnv() } = {}) {
  const started = Date.now();
  const records = [];
  const byKey = new Map();

  const add = (record) => {
    if (NOISE.test(record.text) || NOISE.test(record.source || "")) return;
    const key = `${record.kind}\n${record.text}\n${record.source || ""}`;
    const seen = byKey.get(key);
    if (seen) {
      seen.count += 1;
      return;
    }
    if (records.length >= MAX_RECORDS) return;
    record.count = 1;
    byKey.set(key, record);
    records.push(record);
  };

  const onConsole = (message) => {
    try {
      if (message.type() !== "error") return;
      const location = message.location() || {};
      add({
        at: Date.now() - started,
        kind: "console",
        text: clip(maskSecrets(message.text(), secrets), MAX_TEXT),
        source: location.url
          ? `${cleanUrl(location.url, secrets)}${location.lineNumber ? `:${location.lineNumber}` : ""}`
          : null,
        page: pageUrl(message.page(), secrets),
      });
    } catch {
      // A message from a page that is closing: nothing to record.
    }
  };

  const onPageError = (webError) => {
    try {
      const error = webError.error();
      const name = error?.name && error.name !== "Error" ? `${error.name}: ` : "";
      add({
        at: Date.now() - started,
        kind: "uncaught",
        text: clip(maskSecrets(`${name}${error?.message || String(error)}`, secrets), MAX_TEXT),
        // Where it threw is the stack's first frame, so no separate source.
        source: null,
        stack: error?.stack ? clip(maskSecrets(pageStack(error.stack), secrets), MAX_STACK) : null,
        page: pageUrl(webError.page(), secrets),
      });
    } catch {
      // As above.
    }
  };

  context.on("console", onConsole);
  context.on("weberror", onPageError);

  return {
    stop() {
      context.off("console", onConsole);
      context.off("weberror", onPageError);
      return records;
    },
  };
}

module.exports = { watchConsole };
