const { expect } = require("@playwright/test");

class WPLoginPage {
  constructor(page) {
    this.page = page;
  }

  async login(username, password) {
    console.log("Opening WP login form...");

    const usernameField = this.page.locator("#user_login");
    const passwordField = this.page.locator("#user_pass");

    await usernameField.waitFor({
      state: "visible",
      timeout: 30000,
    });

    // The clicks are best-effort, with a short timeout and a swallowed
    // failure. On wp-login.php Firefox intermittently never returns from the
    // click even though the call log reads "visible, enabled and stable" and
    // the field is already [active] — WordPress focuses #user_login itself on
    // load, so the click has nothing to do in the first place. fill() focuses
    // the field on its own, so losing the click costs nothing, whereas a
    // 30s-timeout click failed the whole run at its very first step.
    const focusField = async (field, label) => {
      await field.click({ timeout: 5000 }).catch(() => {
        console.log(`ℹ ${label} click did not settle — filling directly`);
      });
    };

    console.log("Filling username...");
    await focusField(usernameField, "Username");
    await usernameField.fill(username);
    console.log("✓ Username filled");

    console.log("Filling password...");
    await focusField(passwordField, "Password");
    await passwordField.fill(password);
    console.log("✓ Password filled");

    // Solve the dynamic Jetpack Protect math captcha
    // console.log("Reading captcha equation...");

    // const captchaLabel = this.page.locator(
    //   'label[for="jetpack_protect_answer"]',
    // );

    // await captchaLabel.waitFor({
    //   state: "visible",
    //   timeout: 15000,
    // });

    // const labelText = await captchaLabel.textContent();

    // const numbers = labelText.match(/\d+/g)?.map(Number);

    // if (!numbers || numbers.length < 2) {
    //   throw new Error(
    //     `Could not parse captcha numbers from label text: "${labelText}"`,
    //   );
    // }

    // const answer = numbers[0] + numbers[1];

    // console.log(`✓ Captcha parsed: ${numbers[0]} + ${numbers[1]} = ${answer}`);

    // const answerField = this.page.locator("#jetpack_protect_answer");

    // await answerField.click();
    // await answerField.fill(String(answer));

    // console.log(`✓ Captcha answer "${answer}" filled`);

    // Check "Remember Me"
    const rememberMe = this.page.locator("#rememberme");

    await rememberMe.waitFor({
      state: "visible",
      timeout: 10000,
    });

    const isChecked = await rememberMe.isChecked();

    if (!isChecked) {
      console.log("Checking 'Remember Me'...");
      await rememberMe.check();
      console.log("✓ 'Remember Me' checked");
    } else {
      console.log("ℹ 'Remember Me' already checked");
    }

    // Click Log In
    console.log("Clicking Log In...");

    const loginButton = this.page.locator("#wp-submit");

    await loginButton.waitFor({
      state: "visible",
      timeout: 10000,
    });

    // Just the click. The paired waitForLoadState("networkidle") that used to
    // sit here had NO timeout, so it was bounded only by the test timeout —
    // and wp-admin never goes idle on schedule: heartbeat and admin-ajax keep
    // firing, so this routinely sat there long after the page was usable.
    //
    // Nothing is lost by dropping it. The waitForURL below is the real signal
    // that the login went through, and it is the one the assertion needs.
    await loginButton.click();

    console.log("✓ Log In clicked");

    // Verify login succeeded
    console.log("Verifying login success...");

    await this.page.waitForURL(/\/wp-admin\//, {
      timeout: 30000,
    });

    console.log("✓ WP login successful — landed on /wp-admin/");
  }
}

module.exports = WPLoginPage;
