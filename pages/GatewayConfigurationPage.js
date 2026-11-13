const { expect } = require("@playwright/test");
const { credentialEnvKey } = require("../config/credentialKeys");

/**
 * Describes a credential without printing it.
 *
 * Logs from these runs are not private — they reach the terminal, the run's
 * output directory, ReportPortal, and the UI's log endpoint. What a reader
 * actually needs from a credential line is "is it there, and is it the one I
 * think", which the length and last four characters answer. Short values are
 * masked completely, since four characters of a six-character secret is most of
 * it.
 */
/** Enough of a key to tell two apart on a run card: its last 4, never more. */
function keyTail(value) {
  if (!value) return "empty";
  return value.length <= 8 ? `${value.length} chars` : `…${value.slice(-4)}`;
}

function describeSecret(value) {
  if (!value) return "NOT FOUND";
  if (value.length <= 8) return `set (${value.length} chars)`;
  return `set (${value.length} chars, ends …${value.slice(-4)})`;
}

class GatewayConfigurationPage {
  constructor(page) {
    this.page = page;
  }

  /**
   * Clicks "Verify connection" straight away, without touching the credential
   * fields, to find out whether the credentials already saved on the gateway
   * still work.
   *
   * NON-FATAL by design — it returns a boolean instead of asserting. Only a
   * success message counts as verified. An error message, a missing or
   * disabled button (fresh gateway with nothing saved yet), or no result at
   * all all return false, and the caller then clears the existing credentials
   * and refills them from .env.
   */
  async tryVerifyExistingConnection(expectedMessage) {
    console.log("Trying Verify connection with the existing credentials...");

    const verifyButton = this.page.getByRole("button", {
      name: /Verify connection/i,
    });

    try {
      await verifyButton.waitFor({
        state: "visible",
        timeout: 10000,
      });

      await verifyButton.scrollIntoViewIfNeeded();

      if (!(await verifyButton.isEnabled())) {
        console.log(
          "ℹ Verify connection is disabled — no usable saved credentials. Will fill from .env.",
        );

        return false;
      }

      await verifyButton.click();

      console.log("✓ Verify connection clicked — waiting for result...");
    } catch (e) {
      console.log(
        "ℹ Verify connection button not available — treating as unverified. Will fill from .env.",
      );

      return false;
    }

    const successMessage = this.page.locator("p.text-green-600");
    const errorMessage = this.page
      .locator("p.text-red-600, p.text-red-500, p.text-destructive")
      .first();

    // Race success against error so a failed verification is picked up as
    // soon as the error renders, instead of burning the full success timeout
    // on every gateway whose saved credentials are stale.
    const outcome = await Promise.race([
      successMessage
        .waitFor({ state: "visible", timeout: 30000 })
        .then(() => "success")
        .catch(() => "timeout"),
      errorMessage
        .waitFor({ state: "visible", timeout: 30000 })
        .then(() => "error")
        .catch(() => "timeout"),
    ]);

    if (outcome === "success") {
      const actualMessage = (await successMessage.textContent()).trim();

      // A green message that doesn't match the gateway's expected text isn't
      // a pass — fall through to the refill path rather than moving on with
      // credentials we haven't actually confirmed.
      if (expectedMessage && !actualMessage.includes(expectedMessage)) {
        console.log(
          `⚠ Verified message "${actualMessage}" does not contain "${expectedMessage}" — will refill from .env.`,
        );

        return false;
      }

      console.log(`✓ Existing credentials verified: "${actualMessage}"`);

      return true;
    }

    if (outcome === "error") {
      const actualMessage = (await errorMessage.textContent()).trim();

      console.log(
        `⚠ Verify connection failed: "${actualMessage}" — clearing existing credentials and refilling from .env.`,
      );
    } else {
      console.log(
        "⚠ No verification result within timeout — clearing existing credentials and refilling from .env.",
      );
    }

    return false;
  }

  /**
   * `onFilled({ field, from, to })`, when given, is called after each field is
   * filled — from/to as keyTail(), so a caller can show the change without the
   * key itself.
   */
  async fillCredentials(gatewayName, fields, { onFilled } = {}) {
    if (typeof gatewayName !== "string") {
      throw new Error(
        `gatewayName must be a string. Received: ${typeof gatewayName}`,
      );
    }

    for (const field of fields) {
      const envKey = credentialEnvKey(gatewayName, field.name);
      const value = process.env[envKey];

      console.log("\n-------------------------------");
      console.log(`Field      : ${field.name}`);
      console.log(`Locator    : ${field.locator}`);
      console.log(`ENV Key    : ${envKey}`);
      // Never the value. This line used to print the live secret, and it is not
      // a private log: it goes to the terminal, into the run's output directory,
      // into ReportPortal, and into the UI's own /api/runs/:id/log — so anyone
      // who can see a run can see every key it filled. The length and last four
      // characters are enough to tell "wrong key" from "no key", which is the
      // only thing this line was ever read for.
      console.log(`ENV Value  : ${describeSecret(value)}`);

      if (!value) {
        console.log(`⚠ ${envKey} not found in .env`);
        continue;
      }

      const input = this.page.locator(field.locator);

      await input.waitFor({
        state: "visible",
        timeout: 30000,
      });

      const state = await input.evaluate((el) => ({
        domReadOnly: el.readOnly,
        disabled: el.disabled,
        currentValue: el.value,
      }));

      if (state.domReadOnly || state.disabled) {
        console.log(
          `ℹ ${field.name} is locked (readOnly=${state.domReadOnly}, disabled=${state.disabled}). Forcing it editable to overwrite.`,
        );

        await input.evaluate((el) => {
          el.readOnly = false;
          el.disabled = false;
          el.removeAttribute("readonly");
          el.removeAttribute("disabled");
        });
      } else {
        console.log(
          `ℹ ${field.name} is not locked — filling normally (e.g. new gateway setup).`,
        );
      }

      await input.click();

      if (state.currentValue) {
        // Field already has a value (existing gateway) — clear it first
        console.log(
          `ℹ ${field.name} already has a value — clearing before fill.`,
        );

        await input.fill("");

        // Some React-controlled inputs don't register a fill("") as a
        // real edit until a blur event fires (they re-assert the prior
        // value from component state otherwise). Force a blur, then
        // re-check before asserting.
        await input.blur();
        await this.page.waitForTimeout(200);

        const clearedValue = await input.inputValue();

        if (clearedValue !== "") {
          console.log(
            `⚠ ${field.name} snapped back to "${clearedValue.substring(0, 4)}..." after fill+blur — retrying with keyboard select-all + delete.`,
          );

          // Fallback: focus, select all existing text, delete via keyboard,
          // which more reliably triggers a framework's real change handlers
          // than a programmatic fill() does on stubborn controlled inputs.
          await input.click();
          await input.press("Control+A");
          await input.press("Delete");
          await input.blur();
          await this.page.waitForTimeout(200);
        }

        await expect(input).toHaveValue("", {
          timeout: 10000,
        });

        console.log(`✓ ${field.name} cleared`);
      } else {
        // Field is empty (new gateway) — nothing to clear
        console.log(
          `ℹ ${field.name} is empty — skipping clear, filling directly.`,
        );
      }

      // Fill value from .env
      await input.click();
      await input.fill(value);

      // Many form libraries (React Hook Form, Formik, etc.) only mark a
      // field as "dirty"/touched and re-evaluate whether Save should enable
      // ON BLUR, not just on value change. Without this, Save can stay
      // disabled even though the field visibly has the new value.
      await input.blur();

      // Don't assert exact match — some fields (e.g. API keys) are
      // regenerated/transformed by the backend after fill/save, so the
      // literal .env value may not persist verbatim. Just confirm the
      // field isn't left empty.
      await expect(input).not.toHaveValue("", {
        timeout: 10000,
      });

      console.log(
        `✓ ${field.name} filled (value entered, not asserting exact match)`,
      );

      onFilled?.({
        field: field.name,
        from: keyTail(state.currentValue),
        to: keyTail(value),
      });

      if (field.updateButton) {
        const updateButton = this.page.locator(field.updateButton);

        await updateButton.waitFor({
          state: "visible",
          timeout: 30000,
        });

        await updateButton.click();

        console.log(`✓ ${field.name} updated`);
      }
    }
  }

  async updateSecret() {
    console.log("Clicking Update Secret...");

    const button = this.page.getByRole("button", {
      name: "Update Secret",
    });

    await button.waitFor({
      state: "visible",
      timeout: 30000,
    });

    await button.click();

    await this.page.waitForLoadState("networkidle");

    console.log("✓ Update Secret clicked");
  }

  async saveAndVerify() {
    console.log("Looking for Save button...");

    const saveButton = this.page.getByRole("button", {
      name: /^Save$/,
    });

    // The configure screen no longer has a separate Save — Verify connection
    // saves the credentials itself. Short wait, and skipped when it's absent,
    // so a screen that still has one keeps working.
    const hasSaveButton = await saveButton
      .waitFor({ state: "visible", timeout: 2000 })
      .then(() => true)
      .catch(() => false);

    const isEnabled = hasSaveButton && (await saveButton.isEnabled());

    if (!hasSaveButton) {
      console.log("ℹ No Save button on this screen — going straight to Verify connection.");
    } else if (isEnabled) {
      await saveButton.scrollIntoViewIfNeeded();
      await Promise.all([
        this.page.waitForLoadState("networkidle"),
        saveButton.click(),
      ]);

      console.log("✓ Save completed");
    } else {
      console.log(
        "⚠ Save button disabled — skipping click, proceeding to Verify connection.",
      );
    }

    console.log("Waiting for Verify connection button...");

    const verifyButton = this.page.getByRole("button", {
      name: /Verify connection/i,
    });

    await expect(verifyButton).toBeVisible({
      timeout: 30000,
    });

    await expect(verifyButton).toBeEnabled({
      timeout: 30000,
    });

    await verifyButton.scrollIntoViewIfNeeded();
    await verifyButton.click();

    console.log("✓ Verify connection clicked");
  }

  async verifyConnection(expectedMessage) {
    console.log("Waiting for verification...");

    const message = this.page.locator("p.text-green-600");

    await message.waitFor({
      state: "visible",
      timeout: 30000,
    });

    const actualMessage = (await message.textContent()).trim();

    expect(actualMessage).toContain(expectedMessage);

    console.log("✓ Connection verified");
  }

  /** The "Save Changes" button at the foot of the current configure screen. */
  saveChangesButton() {
    return this.page.getByRole("button", { name: /^\s*Save Changes\s*$/i });
  }

  async hasSaveChanges(timeout = 5000) {
    return this.saveChangesButton()
      .first()
      .waitFor({ state: "visible", timeout })
      .then(() => true)
      .catch(() => false);
  }

  /**
   * Clicks "Save Changes" once it is enabled (it enables when there is
   * something to save — after Verify connection on a fresh gateway), then waits
   * for the save to land: a confirmation on the page, or the button going back
   * to disabled ("nothing unsaved"). Still disabled after the wait means
   * there was nothing to save — the credentials were already saved — and that
   * is not an error.
   */
  async saveChanges() {
    const button = this.saveChangesButton().first();
    await button.scrollIntoViewIfNeeded().catch(() => {});

    const enabled = await expect(button)
      .toBeEnabled({ timeout: 15000 })
      .then(() => true)
      .catch(() => false);

    if (!enabled) {
      console.log("ℹ Save Changes stayed disabled — nothing unsaved on this screen, moving on.");
      return;
    }

    await button.click();
    console.log('✓ "Save Changes" clicked');

    const confirmation = this.page
      .getByText(/(changes|settings|gateway|configuration)\s+(saved|updated)|saved successfully|updated successfully/i)
      .first();

    const outcome = await Promise.race([
      confirmation.waitFor({ state: "visible", timeout: 30000 }).then(() => "confirmed").catch(() => "timeout"),
      expect(button).toBeDisabled({ timeout: 30000 }).then(() => "settled").catch(() => "timeout"),
    ]);

    if (outcome === "timeout") {
      throw new Error(
        'Clicked "Save Changes" on the PayLexer configure page, but no confirmation appeared and the button never went ' +
          `back to disabled within 30s — the save may not have gone through (page: ${this.page.url()}).`,
      );
    }

    const text = outcome === "confirmed" ? (await confirmation.textContent().catch(() => "")).trim() : "";
    console.log(`✓ Changes saved${text ? `: "${text}"` : ""}`);
  }

  /** Whether this configure screen still has the older Display Settings panel. */
  async hasDisplaySettings(timeout = 3000) {
    return this.page
      .locator("span[style*='payment-methods-sprite.svg']")
      .first()
      .waitFor({ state: "visible", timeout })
      .then(() => true)
      .catch(() => false);
  }

  async clickPaymentMethod() {
    console.log("Clicking payment method...");

    const paymentMethod = this.page
      .locator("span[style*='payment-methods-sprite.svg']")
      .first();

    await paymentMethod.waitFor({
      state: "visible",
      timeout: 30000,
    });

    await paymentMethod.click();

    console.log("✓ Payment method clicked");
  }

  async saveDisplaySettings() {
    console.log("Clicking Save Display Settings...");

    const saveButton = this.page.getByRole("button", {
      name: "Save display settings",
    });

    await saveButton.waitFor({
      state: "visible",
      timeout: 30000,
    });

    await saveButton.click();

    console.log("✓ Save Display Settings clicked");
  }

  async verifyDisplaySettingsSaved() {
    console.log("Verifying display settings...");

    const successMessage = this.page.getByText("Display settings saved", {
      exact: true,
    });

    await successMessage.waitFor({
      state: "visible",
      timeout: 30000,
    });

    console.log("✓ Display settings saved successfully");
  }
}

module.exports = GatewayConfigurationPage;
