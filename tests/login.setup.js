const fs = require("fs");
const path = require("path");

require("dotenv").config({
  path: path.resolve(__dirname, "../.env"),
  quiet: true,
});

const { test } = require("@playwright/test");
const WPLoginPage = require("../pages/WPLoginPage");

// Where the authenticated WordPress session is parked. Every other spec picks
// it up through `storageState` in playwright.config.js, so this file is the
// only place a login actually happens.
//
// resolveAuthFile() honours PW_AUTH_FILE, so signing in from the UI for one
// environment writes THAT environment's file and leaves every other
// developer's session alone.
const { resolveAuthFile } = require("../config/session");

const AUTH_FILE = resolveAuthFile();

// Start from a CLEAN context so a stale/expired session can always be
// refreshed — otherwise the config's default storageState would load first and
// land on wp-admin instead of the login form.
test.use({ storageState: { cookies: [], origins: [] } });

test.setTimeout(180000);

/**
 * Runs a login and, if it fails, reports what the SITE said (the #login_error
 * message) rather than which selector timed out.
 */
async function signIn(attempt, locate, context) {
  try {
    await attempt();
  } catch (error) {
    let reported = "";
    try {
      for (const candidate of await locate().all()) {
        const text = (await candidate.innerText().catch(() => "")).trim();
        if (text) {
          reported = text.replace(/\s+/g, " ");
          break;
        }
      }
    } catch {
      // best-effort — fall through to the original timeout
    }
    if (reported) throw new Error(`${context}: "${reported}"`);
    throw error;
  }
}

test("authenticate and save WordPress storage state", async ({ page }) => {
  const { WP_LOGIN_URL, WP_USERNAME, WP_PASSWORD } = process.env;

  if (!WP_LOGIN_URL || !WP_USERNAME || !WP_PASSWORD) {
    throw new Error("WP_LOGIN_URL, WP_USERNAME and WP_PASSWORD must be set in .env before running the login setup.");
  }

  console.log(`Logging into WordPress as ${WP_USERNAME}...`);
  await page.goto(WP_LOGIN_URL);

  const wpLogin = new WPLoginPage(page);
  // login() waits for /wp-admin/ and throws if it never arrives, so a failed
  // login fails the setup here rather than saving a half-authenticated file.
  await signIn(
    () => wpLogin.login(WP_USERNAME, WP_PASSWORD),
    () => page.locator("#login_error"),
    `WordPress rejected the sign-in for ${WP_USERNAME} at ${WP_LOGIN_URL}`,
  );
  console.log(`✓ WordPress login complete — landed on ${page.url()}`);

  fs.mkdirSync(path.dirname(AUTH_FILE), { recursive: true });
  await page.context().storageState({ path: AUTH_FILE });
  console.log(`✓ Session saved to ${AUTH_FILE} — runs will reuse it and skip the WordPress login.`);
});
