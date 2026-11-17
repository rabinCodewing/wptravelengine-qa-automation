// pages/ActivityTourTripPage.js
//
// The General tab of a trip's "WP Travel Engine - Trip Settings" meta box,
// where the Activity Tour add-on adds its "Duration Type" control.
//
// Duration Type (SELECT_BUTTON): "Multi Day" | "Single Day / Activity"
//   - Single Day/Activity → duration shows Hour(s) + Minute(s) number fields
//   - Multi Day           → duration shows the normal days/nights fields
//
// Field names (from includes/builders/trip-edit-general.php):
//   trip_type            "multi" | "single"
//   duration.period      the number (hours when single, days when multi)
//   duration.minutes     extra minutes, single only
//
// NOTE: the Duration Type / hours / minutes controls are React (SELECT_BUTTON,
// NUMBER). Selectors here are text/structure based and may need a one-time
// tweak on first run against the live site.

const { expect } = require("@playwright/test");

class ActivityTourTripPage {
  constructor(page, baseUrl) {
    this.page = page;
    this.base = baseUrl.replace(/\/$/, "");
    this.box = page.locator(".postbox").filter({ hasText: "WP Travel Engine - Trip Settings" }).first();
  }

  async open(tripId) {
    await this.page.goto(`${this.base}/wp-admin/post.php?post=${tripId}&action=edit`);
    // Dismiss the block editor's welcome guide if it pops up.
    await this.page.getByRole("dialog").getByRole("button", { name: "Close" }).click({ timeout: 2000 }).catch(() => {});
    const tab = this.page.locator('a.wpte-menu-link[href$="#wpte-general"]');
    if (await tab.count()) {
      await tab.first().click();
    } else {
      await this.box.getByRole("link", { name: /^General$/ }).first().click().catch(() => {});
    }
    await expect(this.durationTypeControl).toBeVisible({ timeout: 30000 });
  }

  /** The .wpte-form-control wrapping the "Duration Type" field. */
  get durationTypeControl() {
    return this.box.locator(".wpte-form-control").filter({ has: this.page.getByText("Duration Type", { exact: true }) }).first();
  }

  /** Clicks the Duration Type option: "single" or "multi". */
  async setDurationType(type) {
    const label = type === "single" ? "Single Day / Activity" : "Multi Day";
    await this.durationTypeControl.getByRole("button", { name: label, exact: true }).click();
    await this.page.waitForTimeout(300); // let the conditional duration fields swap in
  }

  /**
   * The number input whose suffix reads `suffix` ("Hour(s)" / "Minute(s)" / "Day(s)").
   * Hours and minutes sit in the same .wpte-form-control, each input followed
   * by its suffix span — so match the input by the span right after it.
   */
  suffixInput(suffix) {
    return this.box
      .locator(`xpath=.//input[@type='number'][following-sibling::*[1][contains(normalize-space(.), '${suffix}')]]`)
      .first();
  }

  /** Sets hours (and minutes for single-day). */
  async setDuration({ hours, minutes }) {
    if (hours !== undefined) {
      const h = this.suffixInput("Hour(s)");
      await h.fill(String(hours));
    }
    if (minutes !== undefined) {
      const m = this.suffixInput("Minute(s)");
      await m.fill(String(minutes));
    }
  }

  /**
   * Saves the trip. The block editor saves the post first, then the meta box
   * POSTs its dirty fields to /wptravelengine/v2/trips/<id>. Returns the POST body.
   */
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

module.exports = ActivityTourTripPage;
