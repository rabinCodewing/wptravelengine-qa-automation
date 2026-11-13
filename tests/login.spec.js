require("dotenv").config({ quiet: true });

const { test } = require("@playwright/test");
const LoginPage = require("../pages/LoginPage");

// This spec exercises the login form itself, so it must start signed OUT —
// otherwise the config's default storageState drops it on the dashboard and
// the email field it fills is never on screen. Note this does NOT save a
// session; tests/login.setup.js is what writes playwright/.auth/user.json.
test.use({ storageState: { cookies: [], origins: [] } });

test("User should login successfully", async ({ page }) => {
  await page.goto("/");

  const loginPage = new LoginPage(page);

  await loginPage.login(process.env.EMAIL, process.env.PASSWORD);
});
