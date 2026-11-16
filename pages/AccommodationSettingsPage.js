// pages/AccommodationSettingsPage.js
//
// WP Travel Engine › Settings › Extensions › Accommodation
// (class-wp-travel-engine-admin.php#accommodation).
//
// The settings screen is a React form. Inputs carry their setting path as
// `name` only for the simple fields (accommodation.enable / .title); the
// tables (room types, upgrades) and the multi-select have no names, so they
// are located by their column headers and by position in the row.
//
// Field rules (from the add-on's own field config):
//   Enable                         always
//   Title, Description, Pricing Format, Mandatory For,
//   Room Types, Room Upgrades      when Enable is on
//   Allow Shared Room Bookings     when Pricing Format = Per Traveler
//   Shared Occupancy Notice        when Allow Shared Room Bookings is on

const { expect } = require("@playwright/test");

class AccommodationSettingsPage {
  constructor(page, baseUrl) {
    this.page = page;
    this.base = baseUrl.replace(/\/$/, "");

    this.enableInput = page.locator('input[name="accommodation.enable"]');
    this.form = page.locator("form").filter({ has: this.enableInput });
    this.titleInput = page.locator('input[name="accommodation.title"]');
    this.saveButton = this.form.getByRole("button", { name: "Save Settings" });
  }

  /**
   * The innermost .wpte-form-control holding a label. Some fields sit inside
   * a group wrapper that is itself a .wpte-form-control, hence .last().
   */
  control(label) {
    return this.form.locator(".wpte-form-control").filter({ has: this.page.getByText(label, { exact: true }) }).last();
  }

  get descriptionInput() {
    return this.control("Description").locator("textarea").first();
  }
  get sharedSwitch() {
    return this.control("Allow Shared Room Bookings").locator('input[type="checkbox"]');
  }
  get sharedNoticeInput() {
    return this.control("Shared Occupancy Notice").locator("textarea");
  }
  get mandatoryControl() {
    return this.control("Mandatory For");
  }
  get roomsTable() {
    return this.form.locator("table").filter({ has: this.page.locator("th", { hasText: "Room Type" }) });
  }
  get upgradesTable() {
    return this.form.locator("table").filter({ has: this.page.locator("th", { hasText: "Upgrade Name" }) });
  }

  async open() {
    await this.page.goto(`${this.base}/wp-admin/edit.php?post_type=booking&page=class-wp-travel-engine-admin.php#accommodation`);
    await this.enableInput.waitFor({ state: "attached", timeout: 60000 });
  }

  /**
   * The site's traveler categories, [{ label, value }], read from the
   * Mandatory For field's own options in the page's settings config — the
   * category taxonomy isn't exposed over REST.
   */
  async travelerCategories() {
    const html = (await this.page.content()).replace(/&quot;/g, '"');
    const match = html.match(/"name":"accommodation\.mandatory_for","options":(\[[^\]]*\])/);
    if (!match) throw new Error("Could not find the Mandatory For options in the settings page config.");
    return JSON.parse(match[1]);
  }

  async isEnabled() {
    return this.enableInput.isChecked();
  }

  /** Clicks a switch through its visible label (the checkbox itself is hidden). */
  async setSwitch(input, on) {
    if ((await input.isChecked()) !== on) {
      await input.locator("xpath=..").click();
    }
    await expect(input).toBeChecked({ checked: on });
  }

  async setEnabled(on) {
    await this.setSwitch(this.enableInput, on);
  }

  async setPricingFormat(label) {
    await this.control("Pricing Format").getByRole("button", { name: label, exact: true }).click();
  }

  async setSharedRoomBookings(on) {
    await this.setSwitch(this.sharedSwitch, on);
  }

  /** Picks categories in the Mandatory For multi-select (options render in a portal). */
  async selectMandatoryFor(labels) {
    for (const label of labels) {
      await this.mandatoryControl.locator(".cw__custom-select__input-wrapper").click();
      await this.page.locator(".cw__select-option").filter({ hasText: new RegExp(`^${label}$`) }).first().click();
      await this.closeDropdown();
    }
  }

  /** Closes an open custom select by clicking the Mandatory For label (a neutral spot). */
  async closeDropdown() {
    await this.mandatoryControl.getByText("Mandatory For", { exact: true }).click();
  }

  mandatoryBadges() {
    return this.mandatoryControl.locator(".cw__selected-badge");
  }

  async clearMandatoryFor() {
    const cancel = this.mandatoryControl.locator("button.cw__cancel");
    while (await cancel.count()) {
      await cancel.first().click();
    }
  }

  /**
   * A room row's main <tr>, by its Room Type value. Room inputs have no name,
   * so the row is found by the value its first text input holds.
   */
  roomRow(roomType) {
    return this.roomsTable.locator("tbody > tr").filter({
      has: this.page.locator(`input[type="text"]`).and(this.page.locator(`[value="${roomType}"]`)),
    });
  }

  upgradeRow(name) {
    return this.upgradesTable.locator("tbody > tr").filter({
      has: this.page.locator(`input[type="text"]`).and(this.page.locator(`[value="${name}"]`)),
    });
  }

  async roomTypeValues() {
    return this.roomsTable.locator("tbody > tr > td:first-child input[type='text']").evaluateAll((els) => els.map((e) => e.value));
  }

  async upgradeNameValues() {
    return this.upgradesTable.locator("tbody > tr > td:first-child input[type='text']").evaluateAll((els) => els.map((e) => e.value));
  }

  /** Adds a room type row and fills it. The new row is always the last one. */
  async addRoomType({ room_type, no_of_guests, short_description, description, enable = true }) {
    await this.form.getByRole("button", { name: "Add Room Type" }).click();
    const row = this.roomsTable.locator("tbody > tr").filter({ has: this.page.locator("input[type='number']") }).last();
    await row.locator("input[type='text']").nth(0).fill(room_type);
    if (no_of_guests !== undefined) await row.locator("input[type='number']").fill(String(no_of_guests));
    if (short_description !== undefined) await row.locator("input[type='text']").nth(1).fill(short_description);
    if (description !== undefined) {
      await row.getByRole("button", { name: "Details" }).click();
      await row.locator("xpath=following-sibling::tr[1]").locator("textarea").fill(description);
    }
    if (!enable) await this.setSwitch(row.locator("input[type='checkbox']"), false);
    return row;
  }

  async deleteRoomType(roomType) {
    const row = this.roomRow(roomType);
    await row.locator("td").last().locator("button").last().click();
    await expect(this.roomRow(roomType)).toHaveCount(0);
  }

  async addUpgrade({ name, hotel_name, description }) {
    await this.form.getByRole("button", { name: "Add Upgrades" }).click();
    const row = this.upgradesTable.locator("tbody > tr").filter({ has: this.page.getByRole("button", { name: "Details" }) }).last();
    await row.locator("input[type='text']").nth(0).fill(name);
    await row.locator("input[type='text']").nth(1).fill(hotel_name);
    if (description !== undefined) {
      await row.getByRole("button", { name: "Details" }).click();
      await row.locator("xpath=following-sibling::tr[1]").locator("textarea").fill(description);
    }
    return row;
  }

  async deleteUpgrade(name) {
    const row = this.upgradeRow(name);
    await row.locator("td").last().locator("button").last().click();
    await expect(this.upgradeRow(name)).toHaveCount(0);
  }

  /** Reads the currently-saved accommodation settings over REST (cookie + nonce). */
  async currentSettings() {
    const nonce = await this.page.evaluate(() => window.wpApiSettings?.nonce || "");
    const res = await this.page.request.get(`${this.base}/wp-json/wptravelengine/v2/settings`, {
      headers: { "X-WP-Nonce": nonce },
      timeout: 60000,
    });
    expect(res.status(), "Could not read current settings").toBe(200);
    return (await res.json()).accommodation;
  }

  /**
   * Saves and returns the saved accommodation settings.
   *
   * The Save button is a react-hook-form submit that stays disabled until the
   * form is dirty. On a re-run the site often already holds the values the test
   * just set, so nothing becomes dirty and the button never enables — but the
   * desired state is already persisted. So: if the button enables, click it and
   * assert the 200; if it stays disabled (nothing to save), read the current
   * settings back instead of failing. Either way the caller gets the saved state.
   */
  async save() {
    const becameDirty = await this.saveButton
      .isEnabled()
      .then((en) => en || expect(this.saveButton).toBeEnabled({ timeout: 3000 }).then(() => true))
      .catch(() => false);

    if (!becameDirty) {
      // Nothing changed — the values already match what was set, so they're saved.
      return this.currentSettings();
    }

    const [response] = await Promise.all([
      this.page.waitForResponse(
        (r) => r.request().method() === "POST" && /\/wptravelengine\/v2\/settings/.test(r.url()),
        { timeout: 60000 },
      ),
      this.saveButton.click(),
    ]);
    expect(response.status(), "Settings save failed").toBe(200);
    return (await response.json()).accommodation;
  }
}

module.exports = AccommodationSettingsPage;
