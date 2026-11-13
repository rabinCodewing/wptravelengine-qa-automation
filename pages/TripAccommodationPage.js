// pages/TripAccommodationPage.js
//
// The Accommodation tab of a trip's "WP Travel Engine - Trip Settings" meta
// box in the block editor (post.php?post=<id>&action=edit).
//
// Room rows: Single Room | No. of Guests | Short Description | Price Per Room
//            | enable switch. "Details" opens a row under it with the long
//            description and the "Included in Package" checkbox.
// Upgrades:  picked from the "Add Upgrades" multi-select, then each row has a
//            price, an enable switch and "Room Types:" checkboxes.
//
// Saving: the editor's own Save first saves the post; once that succeeds the
// meta box POSTs its dirty fields to /wptravelengine/v2/trips/<id> and shows
// "Trip updated successfully". The post save alone can take 20s+ on this
// host, hence the long waits.

const { expect } = require("@playwright/test");

class TripAccommodationPage {
  constructor(page, baseUrl) {
    this.page = page;
    this.base = baseUrl.replace(/\/$/, "");
    this.box = page.locator(".postbox").filter({ hasText: "WP Travel Engine - Trip Settings" }).first();
  }

  async open(tripId) {
    await this.page.goto(`${this.base}/wp-admin/post.php?post=${tripId}&action=edit`);
    const tab = this.page.locator('a.wpte-menu-link[href$="#wptravelengine-accommodation"]');
    await tab.waitFor({ timeout: 90000 });
    // The block editor can open a welcome guide over everything.
    await this.page.getByRole("dialog").getByRole("button", { name: "Close" }).click({ timeout: 2000 }).catch(() => {});
    await tab.click();
    await expect(this.box.locator("th", { hasText: "Price Per Room" }).first()).toBeVisible({ timeout: 30000 });
  }

  get roomsTable() {
    return this.box.locator("table").filter({ has: this.page.locator("th", { hasText: "No. of Guests" }) });
  }
  get upgradesTable() {
    return this.box.locator("table").filter({ has: this.page.locator("th", { hasText: "Upgrade Name" }) });
  }

  roomRow(roomType) {
    return this.roomsTable.locator("tbody > tr").filter({ hasText: roomType }).first();
  }

  upgradeRow(name) {
    return this.upgradesTable.locator("tbody > tr").filter({
      has: this.page.locator(`input[readonly][value="${name}"]`),
    });
  }

  async setSwitch(input, on) {
    if ((await input.isChecked()) !== on) await input.locator("xpath=..").click();
    await expect(input).toBeChecked({ checked: on });
  }

  /** Sets any of: price, short_description, enable, description, included_in_package. */
  async configureRoom(roomType, { price, short_description, enable, description, included_in_package }) {
    const row = this.roomRow(roomType);
    await row.scrollIntoViewIfNeeded();
    if (short_description !== undefined) await row.locator("input[type='text']").fill(short_description);
    if (price !== undefined) await row.locator("input[type='number']").fill(String(price));
    if (enable !== undefined) await this.setSwitch(row.locator("input[type='checkbox']"), enable);

    if (description !== undefined || included_in_package !== undefined) {
      await row.getByRole("button", { name: "Details" }).click();
      const details = row.locator("xpath=following-sibling::tr[1]");
      if (description !== undefined) await details.locator("textarea").fill(description);
      if (included_in_package !== undefined) await details.locator("#included_in_package").setChecked(included_in_package);
      await row.getByRole("button", { name: "Details" }).click();
    }
  }

  async addUpgrade(name, { price, roomTypes = [], enable } = {}) {
    const select = this.box.locator(".cw__custom-select").filter({ has: this.page.getByText("Add Upgrades") }).first();
    if (await select.count()) await select.locator(".cw__custom-select__input-wrapper").click();
    else await this.box.getByText("Add Upgrades", { exact: true }).click();
    await this.page.locator(".cw__select-option, [class*='option']").filter({ hasText: new RegExp(`^${name}$`) }).last().click();
    // Close the dropdown on a neutral spot.
    await this.box.getByText("Room Upgrades", { exact: true }).first().click();

    const row = this.upgradeRow(name);
    await expect(row).toHaveCount(1);
    if (price !== undefined) await row.locator("input[type='number']").fill(String(price));
    if (enable !== undefined) await this.setSwitch(row.locator("input[type='checkbox']"), enable);
    const roomTypesRow = row.locator("xpath=following-sibling::tr[1]");
    for (const roomType of roomTypes) {
      await roomTypesRow.locator(".room-item").filter({ hasText: roomType }).locator("input").check();
    }
  }

  /** Removes an upgrade by its badge's × in the Add Upgrades select. */
  async removeUpgrade(name) {
    const badge = this.box.locator(".cw__selected-badge", { hasText: name }).locator("xpath=..");
    await badge.locator("button.cw__cancel").click();
    await expect(this.upgradeRow(name)).toHaveCount(0);
  }

  /** Clicks the editor's Save and waits for the trip meta POST. Returns the posted JSON. */
  async save() {
    const tripSave = this.page.waitForResponse(
      (r) => r.request().method() === "POST" && /\/wptravelengine\/v2\/trips\/\d+/.test(r.url()),
      { timeout: 180000 },
    );
    await this.page.getByRole("button", { name: /^(Save|Update|Publish)$/ }).first().click();
    const response = await tripSave;
    expect(response.status(), "Trip meta save failed").toBe(200);
    await expect(this.page.getByText("Trip updated successfully")).toBeVisible({ timeout: 30000 });
    return response.request().postDataJSON();
  }
}

module.exports = TripAccommodationPage;
