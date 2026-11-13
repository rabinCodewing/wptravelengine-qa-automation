// pages/AccommodationBookingPage.js
//
// The traveller-facing side: the trip page's booking modal
// (Date & Time → Package Type → Accommodation), its Booking Summary, and the
// checkout's Tour Details.
//
// Accommodation step markup (wptravelengine-accommodation public.js):
//   .wte-trip-options > p                       the settings Description
//   .wte-trip-guest-wrapper                     one room card:
//       .check-in-wrapper label                 room name (+ span.wpte-tag.shared)
//       .check-in-description                   short description
//       .wpte-price.amount | "Included in Package"
//       select                                  "Select Room(s)" (per room) or
//                                               "Select Traveller(s)" (per traveler)
//       .accommodation-upgrades-toggle-button   shows the upgrade cards (nested
//                                               .wte-trip-guest-wrapper, own select)
// Summary: .wte-booking-details.accommodation li and .total-amount.

const { expect } = require("@playwright/test");

/** "$2,150.00" → 2150 */
function money(text) {
  const n = String(text).replace(/[^0-9.]/g, "");
  return n ? Number(n) : NaN;
}

class AccommodationBookingPage {
  constructor(page) {
    this.page = page;
    // The page carries an empty #wte-booking-summary as well as the modal's,
    // and the sidebar can hold a stale copy while it re-renders.
    this.summary = page
      .locator(".wte-popup-sidebar .wte-booking-summary")
      .filter({ visible: true })
      .filter({ has: page.locator(".total-amount") })
      .last();
    this.step = page.locator(".wte-trip-options");
    this.proceed = page.getByRole("button", { name: /Proceed To Checkout/i });
    this.noOptionsMessage = page.getByText("No accommodation options are available for the selected date.");
  }

  async openTrip(link) {
    await this.page.goto(link);
    await this.page.locator("button.wte-book-now", { hasText: "Check Availability" }).click();
  }

  /** Date & Time: keeps the first available date. */
  async continueFromDate() {
    await this.page.getByRole("button", { name: "Continue", exact: true }).first().click();
  }

  /** Package Type: sets the Adult count from 0. */
  async setAdults(count) {
    const plus = this.page.locator("button.next.wte-up").first();
    await plus.waitFor({ timeout: 30000 });
    for (let i = 0; i < count; i++) await plus.click();
  }

  async continueToAccommodation() {
    // The step mounts straight away with EMPTY defaults (no rooms, no
    // mandatory_for) under a loading skeleton, and only becomes real when
    // /trips/<id>/accommodation answers — which on the test host can take
    // several seconds. Reading the step before that sees an unblocked
    // Proceed button and no rooms, so wait for the response itself.
    const loaded = this.page.waitForResponse(
      (r) => /\/wptravelengine\/v2\/trips\/\d+\/accommodation/.test(r.url()) && r.ok(),
      { timeout: 120000 },
    );
    await this.page.getByRole("button", { name: "Continue", exact: true }).first().click();
    await loaded;
    // Then the intro paragraph (rooms) or, when no room fits, the "Oops!" panel.
    await this.step
      .locator(":scope > p")
      .or(this.noOptionsMessage)
      .first()
      .waitFor({ state: "visible", timeout: 30000 });
    await this.proceed.waitFor({ state: "visible", timeout: 30000 });
  }

  /** Trip page → Accommodation step with `adults` travellers. */
  async reachAccommodationStep(link, adults) {
    await this.openTrip(link);
    await this.continueFromDate();
    await this.setAdults(adults);
    await this.continueToAccommodation();
  }

  stepTabs() {
    return this.page.locator(".wte-booking-modal, .wpte-bf-booking-steps, body").locator("nav li");
  }

  /** A top-level room card (not an upgrade card nested inside one). */
  roomCard(roomType) {
    return this.step
      .locator(":scope > .wte-trip-guest-wrapper")
      .filter({ has: this.page.locator(":scope > .check-in-wrapper label", { hasText: roomType }) });
  }

  async visibleRoomNames() {
    return this.step
      .locator(":scope > .wte-trip-guest-wrapper > .check-in-wrapper > label")
      .evaluateAll((els) => els.map((e) => e.childNodes[0]?.textContent.trim()));
  }

  async roomPriceText(roomType) {
    return (await this.roomCard(roomType).locator(":scope > div").nth(1).innerText()).trim();
  }

  /** Option labels of a room's own select (first select = the room's, not an upgrade's). */
  async roomOptions(roomType) {
    return this.roomCard(roomType).locator("select").first().locator("option").allInnerTexts();
  }

  async selectRoom(roomType, optionLabel) {
    await this.roomCard(roomType).locator("select").first().selectOption({ label: optionLabel });
  }

  async openUpgrades(roomType) {
    const toggle = this.roomCard(roomType).locator(".accommodation-upgrades-toggle-button");
    await toggle.click();
    await expect(toggle).toHaveClass(/open/);
  }

  upgradeCard(roomType, upgradeName) {
    return this.roomCard(roomType)
      .locator(".wte-trip-guest-wrapper")
      .filter({ has: this.page.locator(".check-in-wrapper label", { hasText: upgradeName }) });
  }

  async selectUpgrade(roomType, upgradeName, optionLabel) {
    await this.upgradeCard(roomType, upgradeName).locator("select").selectOption({ label: optionLabel });
  }

  async summaryAccommodationLines() {
    return this.summary.locator(".wte-booking-details.accommodation li").allInnerTexts();
  }

  async summaryTotal() {
    return money(await this.summary.locator(".total-amount .wpte-price").innerText());
  }

  async goToCheckout() {
    await expect(this.proceed).toBeEnabled();
    await this.proceed.click();
    await this.page.waitForURL(/wte_id=/, { timeout: 60000 });
  }

  /** Checkout's Tour Details text, for asserting the accommodation line and total. */
  async checkoutTourDetails() {
    const details = this.page.locator("body");
    await expect(details.getByText("Tour Details")).toBeVisible({ timeout: 30000 });
    return details.innerText();
  }
}

module.exports = { AccommodationBookingPage, money };
