const fs = require("fs");
const path = require("path");

require("dotenv").config({
  path: path.resolve(__dirname, "../.env"),
  quiet: true,
});

const { test, expect } = require("@playwright/test");
const LoginPage = require("../pages/LoginPage");
const WPLoginPage = require("../pages/WPLoginPage");

// Where the authenticated session is parked. Every other spec picks this up
// through `storageState` in playwright.config.js, so this file is the only
// place a login actually happens.
//
// resolveAuthFile() honours PW_AUTH_FILE, so signing in from the UI for one
// environment writes THAT environment's file and leaves every other
// developer's session alone.
const { resolveAuthFile, settle } = require("../config/session");

const AUTH_FILE = resolveAuthFile();


// This file must start from a CLEAN context. Without this, the config's
// default storageState would be loaded first and the run would land on the
// dashboard instead of the sign-in form — so a stale/expired session could
// never be refreshed, which is the whole point of this file.
test.use({ storageState: { cookies: [], origins: [] } });

// Two logins, each a multi-step form.
//
// The setup project turns slowMo OFF (see playwright.config.js), so none of
// those actions carries the 1s pad a gateway run does. The timeout stays
// generous anyway: it is a ceiling for a setup that has gone wrong, not a
// budget for one that is working.
test.setTimeout(420000);

/**
 * Runs a login and, if it fails, reports what the SITE said rather than which
 * selector timed out.
 *
 * A rejected email or a wrong password does not throw a login error — the next
 * step of the form simply never appears, and Playwright reports a timeout on
 * whatever it was waiting for. The screen meanwhile is showing the actual
 * reason in plain words. This reads that and puts it in the failure, so the
 * message names the problem instead of pointing at LoginPage.js:11.
 *
 * `locate` is called only on the failure path — it is a function rather than a
 * locator so nothing is queried during a login that works.
 */
async function signIn(attempt, locate, context) {
  try {
    await attempt();
  } catch (error) {
    let reported = "";

    try {
      const candidates = await locate().all();

      for (const candidate of candidates) {
        const text = (await candidate.innerText().catch(() => "")).trim();
        // The page carries an empty alert container as well as the real one,
        // so the first NON-EMPTY match is the message.
        if (text) {
          reported = text.replace(/\s+/g, " ");
          break;
        }
      }
    } catch {
      // Reading the error is best-effort. If the page is gone or the locator
      // finds nothing, the original timeout below is still the right failure.
    }

    if (reported) {
      throw new Error(`${context}: "${reported}"`);
    }

    throw error;
  }
}

// BOTH logins, saved into ONE storage state.
//
// PayLexer is not the login these runs spend their time on. wpGatewayCheckout
// .spec.js — the spec the UI runs — opens wp-admin as its very FIRST step, and
// paymentGateway.spec.js logs into WordPress twice more in new tabs. Saving
// only the PayLexer session left every one of those in place.
//
// One file covers both because cookies are stored per ORIGIN and a browser
// context holds as many origins as you visit. app.paylexer.com and the
// WordPress host are separate entries in the same user.json, so logging into
// both here and calling storageState() once carries both forward.
//
// WPLoginPage ticks "Remember Me", which is what makes this work at all: the
// cookie WordPress issues is then persistent rather than a session cookie that
// would die with the browser and save as nothing usable.
test("authenticate and save storage state", async ({ page }) => {
  const __t0 = Date.now();
  const __log = console.log;
  console.log = (...a) => __log(`[+${String((Date.now() - __t0) / 1000).padStart(6)}s]`, ...a);

  const { EMAIL, PASSWORD, BASE_URL, WP_LOGIN_URL, WP_USERNAME, WP_PASSWORD } =
    process.env;

  // SKIP_PAYLEXER=1 in .env: WordPress-only session (WP Travel Engine add-on
  // dashboard, `npm run ui`) — no PayLexer account needed.
  const skipPaylexer = process.env.SKIP_PAYLEXER === "1";
  if (skipPaylexer) console.log("SKIP_PAYLEXER=1 — skipping the PayLexer sign-in.");

  if (!WP_LOGIN_URL || !WP_USERNAME || !WP_PASSWORD) {
    throw new Error(
      "WP_LOGIN_URL, WP_USERNAME and WP_PASSWORD must be set in .env before running the login setup.",
    );
  }

  if (!skipPaylexer) {
    if (!EMAIL || !PASSWORD) {
      throw new Error(
        "EMAIL and PASSWORD must be set in .env before running the login setup.",
      );
    }

    console.log("Opening PayLexer sign-in page...");
    await page.goto(BASE_URL);

    const loginPage = new LoginPage(page);

    console.log(`Logging in as ${EMAIL}...`);
    await signIn(
      async () => {
        await loginPage.login(EMAIL, PASSWORD);

        // INSIDE the wrapper, not after it. A rejected EMAIL fails in login()
        // itself — the password step never appears — but a rejected PASSWORD
        // does not fail there at all: every field is filled, Sign in is clicked,
        // and the form simply stays put with its reason on screen. Leaving this
        // assertion outside meant that case reported "not.toHaveURL failed"
        // while the page was plainly saying "Invalid credentials. 2 attempts
        // remaining before account lockout." — the single most important thing
        // to know, and the one thing not printed.
        //
        // Don't save on a form that merely stopped moving: saving a
        // half-authenticated state produces a user.json that looks fine and then
        // bounces every later run back to the login page with no obvious cause.
        await expect(page).not.toHaveURL(/\/signin\b/, { timeout: 60000 });
      },
      // PayLexer puts "Account doesn't exist with this email.", "Invalid
      // credentials…" and friends in a role="alert" on the form.
      () => page.getByRole("alert"),
      `PayLexer rejected the sign-in for ${EMAIL} at ${BASE_URL}`,
    );

    // Short and advisory — see settle() in config/session.js. The sign-in is
    // already proven by the assertion above; this is only a breath before the
    // URL is read.
    await settle(page);
    console.log(`✓ Logged in — landed on ${page.url()}`);
  }

  // ---- WordPress, in the SAME context so both land in one storage state ----

  console.log(`Logging into WordPress as ${WP_USERNAME}...`);
  await page.goto(WP_LOGIN_URL);

  const wpLogin = new WPLoginPage(page);
  // login() already waits for /wp-admin/ and throws if it never arrives, so a
  // failed WordPress login fails the setup here rather than saving a file that
  // is only half authenticated.
  await signIn(
    () => wpLogin.login(WP_USERNAME, WP_PASSWORD),
    // WordPress renders "The password you entered for the username … is
    // incorrect." into #login_error.
    () => page.locator("#login_error"),
    `WordPress rejected the sign-in for ${WP_USERNAME} at ${WP_LOGIN_URL}`,
  );
  console.log(`✓ WordPress login complete — landed on ${page.url()}`);

  fs.mkdirSync(path.dirname(AUTH_FILE), { recursive: true });
  await page.context().storageState({ path: AUTH_FILE });

  console.log(`✓ Session saved to ${AUTH_FILE}`);
  console.log(
    "  Gateway runs will now reuse it and skip BOTH the PayLexer and the WordPress login.",
  );
});
