// pages/ActivityTourBookingPage.js
//
// The Activity Tour front-end booking modal (single-day trips). It is a React
// app mounted on the trip page; a trigger button (#open-booking-modal /
// [data-trip-booking] / .wte-fsd__booknow-btn) opens it. "Book Now" POSTs
// action=wte_add_trip_to_cart and redirects to checkout.
//
// Stable DOM hooks (from src/public/js, validated on rabin.local):
//   .wpte-activity-tour-booking-modal-content   the modal
//   .category__labels / .category__label        a traveller category row
//   .category__price                            its unit price "$1,000 / Person"
//   .category__counter                          -/value/+ counter
//   .category__counter-min                      "Minimum: N"
//   input.flatpickr-input                        the date field (flatpickr)
//   .flatpickr-day … .date-price                 per-day price label
//   select.wpte-time-select                      the time-slot dropdown
//   .wpte-activity-tour-booking-warning          warning ("No seats available." …)
//   .total-amount                                 the modal total
//   button "Book Now"                            submit

const { expect } = require("@playwright/test");

/** "$1,500.00" → 1500 */
const money = (text) => Number(String(text).replace(/[^\d.-]/g, "")) || 0;

class ActivityTourBookingPage {
  constructor(page, baseUrl) {
    this.page = page;
    this.base = (baseUrl || "").replace(/\/$/, "");
    this.modal = page.locator(".wpte-activity-tour-booking-modal-content");
    this.bookNow = this.modal.getByRole("button", { name: /^Book Now$/ });
    this.timeSelect = this.modal.locator("select.wpte-time-select");
    this.dateInput = this.modal.locator("input.flatpickr-input").first();
    this.warning = this.modal.locator(".wpte-activity-tour-booking-warning");
    this.totalAmount = this.modal.locator(".total-amount");
  }

  async open(link) {
    await this.page.goto(link, { waitUntil: "domcontentloaded" });
  }

  /** Clicks the on-page trigger and waits for the modal and its data. */
  async openModal() {
    const trigger = this.page
      .locator("#open-booking-modal, [data-trip-booking] button, button:has-text('Check Availability'), button:has-text('Book Now')")
      .first();
    await trigger.waitFor({ state: "visible", timeout: 30000 });
    await trigger.click();
    await expect(this.modal).toBeVisible({ timeout: 30000 });
    // Packages/dates/services load through REST; the travellers render after.
    await expect(this.modal.locator(".category__counter").first()).toBeVisible({ timeout: 30000 });
  }

  /** True if the activity modal exists for this trip (single-day). */
  async hasActivityModal() {
    return (await this.modal.count()) > 0;
  }

  /** Picks a package by its name. */
  async selectPackage(name) {
    if (!name) return;
    await this.modal.getByText(name, { exact: true }).first().click();
    await this.page.waitForTimeout(500);
  }

  /** The row for a traveller category label (e.g. "Adult"). */
  categoryRow(label) {
    return this.modal
      .locator(".category__label")
      .filter({ hasText: new RegExp(`^\\s*${label}\\b`) })
      .locator("xpath=ancestor::*[.//*[contains(@class,'category__counter')]][1]")
      .first();
  }

  async categoryLabels() {
    return (await this.modal.locator(".category__label").allInnerTexts()).map((t) => t.trim().split(/\s+/)[0]);
  }

  async count(label) {
    return Number(await this.categoryRow(label).locator(".category__counter span").first().innerText());
  }

  async unitPrice(label) {
    return money(await this.categoryRow(label).locator(".category__price").innerText());
  }

  async minimumText(label) {
    const min = this.categoryRow(label).locator(".category__counter-min");
    return (await min.count()) ? (await min.innerText()).trim() : "";
  }

  plus(label) {
    return this.categoryRow(label).locator(".category__counter button").last();
  }

  minus(label) {
    return this.categoryRow(label).locator(".category__counter button").first();
  }

  /** Clicks + / − until the category shows `qty`. */
  async setTravellers(label, qty) {
    for (let i = 0; i < 20 && (await this.count(label)) !== qty; i++) {
      const current = await this.count(label);
      const btn = current < qty ? this.plus(label) : this.minus(label);
      if (await btn.isDisabled()) break;
      await btn.click();
      await this.page.waitForTimeout(200);
    }
    expect(await this.count(label), `${label} travellers`).toBe(qty);
  }

  /** Dates the calendar lets you pick, as YYYY-MM-DD. */
  async availableDates() {
    return this.page.evaluate(() => {
      const input = document.querySelector(".wpte-activity-tour-booking-modal-content input.flatpickr-input");
      const fp = input?._flatpickr;
      if (!fp) return [];
      return (fp.config.enable || []).map((d) => (typeof d === "string" ? d : fp.formatDate(d, "Y-m-d"))).filter(Boolean).sort();
    });
  }

  /**
   * Picks a date. With no `date`, the first available one. Goes through
   * flatpickr's API (same onChange path as a click) so it works for any month.
   */
  async chooseDate(date) {
    await expect(this.dateInput).toBeAttached({ timeout: 30000 });
    const target = date || (await this.availableDates())[0];
    expect(target, "an available date in the calendar").toBeTruthy();
    await this.page.evaluate((d) => {
      document.querySelector(".wpte-activity-tour-booking-modal-content input.flatpickr-input")._flatpickr.setDate(d, true);
    }, target);
    await this.page.waitForTimeout(500);
    return target;
  }

  async selectedDate() {
    return this.page.evaluate(() => document.querySelector(".wpte-activity-tour-booking-modal-content input.flatpickr-input")?.value || "");
  }

  /** Per-day price labels the calendar shows for the next available dates. */
  async calendarPrices() {
    return this.page.locator(".wpte-activity-tour-booking-flatpickr .date-price").allInnerTexts();
  }

  async hasTimeSlots() {
    return (await this.timeSelect.count()) > 0;
  }

  /** Time options shown, as their labels ("9:00 am"). */
  async timeOptions() {
    if (!(await this.hasTimeSlots())) return [];
    return (await this.timeSelect.locator("option").evaluateAll((o) => o.filter((x) => x.value).map((x) => x.textContent.trim())));
  }

  /** Selects a slot by its start "HH:MM" (option values end in _HH:MM_HH:MM), or the first one. */
  async chooseTime(hhmm) {
    if (!(await this.hasTimeSlots())) return null;
    const values = await this.timeSelect.locator("option").evaluateAll((o) => o.map((x) => x.value).filter(Boolean));
    const value = hhmm ? values.find((v) => v.includes(`_${hhmm}_`)) : values[0];
    expect(value, `time slot ${hhmm || "(first)"} offered`).toBeTruthy();
    await this.timeSelect.selectOption(value);
    return value;
  }

  async total() {
    return money(await this.totalAmount.innerText());
  }

  async warningText() {
    return (await this.warning.count()) ? (await this.warning.innerText()).trim() : "";
  }

  /** Clicks Book Now and waits for checkout. */
  async goToCheckout() {
    await expect(this.bookNow).toBeEnabled({ timeout: 15000 });
    await Promise.all([this.page.waitForURL(/checkout/i, { timeout: 90000 }), this.bookNow.click()]);
  }

  /**
   * Full flow: open modal → package → travellers → date → time → checkout.
   * Returns { date, time } chosen.
   */
  async book({ link, package: pkg, travellers = { Adult: 1 }, date, time } = {}) {
    if (link) await this.open(link);
    await this.openModal();
    await this.selectPackage(pkg);
    for (const [label, qty] of Object.entries(travellers)) await this.setTravellers(label, qty);
    const chosenDate = await this.chooseDate(date);
    const chosenTime = await this.chooseTime(time);
    await this.goToCheckout();
    return { date: chosenDate, time: chosenTime };
  }
}

module.exports = ActivityTourBookingPage;
module.exports.money = money;
