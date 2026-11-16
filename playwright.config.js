require("dotenv").config({ quiet: true });
const fs = require("fs");
const { defineConfig, devices } = require("@playwright/test");

// The authenticated WordPress session written by tests/login.setup.js.
// Loading it as the default
// storageState is what lets every spec open the dashboard / wp-admin directly
// instead of logging in again.
//
// Not wired up as `dependencies: ["setup"]`: that would re-run the login before
// every run. Run `npm run auth` once, and again whenever the session expires.
//
// Guarded by existsSync because Playwright throws at config load when the file
// is missing — on a fresh clone that would break even `--list`. Missing file
// means no storageState; config/session.js then reports the real problem.
const { resolveAuthFile } = require("./config/session");

const AUTH_FILE = resolveAuthFile();
const storageState = fs.existsSync(AUTH_FILE) ? AUTH_FILE : undefined;

module.exports = defineConfig({
  testDir: "./tests",

  // ReportPortal is opt-in: added only when RP_API_KEY is set.
  reporter: [
    ["list"],
    ["html", { open: "never" }],
    ...(process.env.RP_API_KEY
      ? [["@reportportal/agent-js-playwright", require("./reportportal.config")]]
      : []),
  ],

  use: {
    baseURL: process.env.FRONTEND_URL || process.env.BASE_URL,
    storageState,
    // Headed by default — these runs are watched. PW_HEADLESS=1 for headless
    // (use it when the desktop is in use: a headed Firefox that loses OS focus
    // makes clicks hang until the action timeout).
    headless: process.env.PW_HEADLESS === "1",
    // Full timeline of a failed run: `npx playwright show-trace <trace.zip>`.
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    // Caps any single click/fill at 30s instead of the whole test timeout.
    actionTimeout: 30000,
    launchOptions: {
      // A pad after every action so a human can follow a headed run. 0 when
      // headless; PW_SLOWMO forces a value either way.
      slowMo: process.env.PW_SLOWMO
        ? Number(process.env.PW_SLOWMO)
        : process.env.PW_HEADLESS === "1"
          ? 0
          : 1000,
    },
  },

  projects: [
    {
      name: "firefox",
      // *.setup.js is excluded so the login never rides along with a run.
      testIgnore: /.*\.setup\.js/,
      use: { ...devices["Desktop Firefox"] },
    },
    {
      // `npm run auth` — mints / refreshes playwright/.auth/user.json.
      name: "setup",
      testMatch: /.*\.setup\.js/,
      // Own output dir so the setup never wipes other runs' results.
      outputDir: "test-results/login-setup",
      use: {
        ...devices["Desktop Firefox"],
        storageState: undefined,
        launchOptions: { slowMo: 0 },
      },
    },
  ],
});
