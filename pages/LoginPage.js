const { LoginLocators } = require("../locators/login.locators");

// The sign-in page is a client-rendered app: #email is not in the DOM until it
// hydrates, which on a slow connection takes a while. Generous on purpose.
const FORM_TIMEOUT = 45000;

class LoginPage {
  constructor(page) {
    this.page = page;
  }

  async login(email, password) {
    await this.step("the email field", () =>
      this.page.fill(LoginLocators.emailField, email, { timeout: FORM_TIMEOUT }),
    );
    await this.step("the Continue button", () => this.page.click(LoginLocators.continueButton));
    // A rejected email stops here: the password step never appears and the
    // reason sits in a role="alert", which login.setup.js reads and reports.
    await this.step("the password step (after Continue)", () =>
      this.page.fill(LoginLocators.passwordField, password),
    );
    await this.step("the Remember me checkbox", () => this.page.click(LoginLocators.rememberMe));
    await this.step("the Sign in button", () => this.page.click(LoginLocators.signInButton));
  }

  /**
   * Runs one action and, if it fails, says which part of the form never came
   * and what the page showed instead — "page.fill: Timeout 30000ms exceeded"
   * on its own says nothing about whether the page loaded at all.
   */
  async step(what, action) {
    try {
      await action();
    } catch (error) {
      const url = this.page.url();
      const shown = await this.page
        .locator("body")
        .innerText({ timeout: 3000 })
        .then((text) => {
          const flat = text.replace(/\s+/g, " ").trim();
          return flat.length > 160 ? `${flat.slice(0, 160)}…` : flat;
        })
        .catch(() => "");

      throw new Error(
        `PayLexer sign-in page never showed ${what} at ${url || "(no page)"}. ` +
          (shown ? `The page showed: "${shown}"` : "The page was blank — it did not load."),
        { cause: error },
      );
    }
  }
}

module.exports = LoginPage;
