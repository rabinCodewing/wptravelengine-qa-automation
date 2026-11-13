// tests/accommodation.spec.js
//
// WP Travel Engine — Accommodation add-on (wptravelengine-accommodation).
//
//   npm run test:accommodation                      headed (watchable)
//   PW_HEADLESS=1 npm run test:accommodation        headless, much faster
//   ACCOMMODATION_CLEANUP=1 npm run test:accommodation
//                                                   also deletes the QA trips,
//                                                   rooms and upgrades at the end
//
// What it covers, in order:
//   1. Extension      — the add-on is installed, licensed and active (activates
//                       the plugin if it is off), and Settings › Extensions ›
//                       Accommodation › Enable is switched ON (turned on if off).
//   2. Settings UI    — title/description, pricing format and its conditional
//                       shared-room fields, Mandatory For, room type CRUD,
//                       room upgrade CRUD. Each save is checked through REST.
//   3. Trip editor UI — per-trip room price/description/included/enable and a
//                       room upgrade with its price and room types, saved and
//                       read back through REST.
//   4. Frontend       — one dedicated trip per feature (config/accommodationData.js):
//                       per-room pricing, per-traveler pricing, room upgrades,
//                       included in package, shared rooms, mandatory for adults,
//                       room visibility (disabled / capacity), and the step
//                       disappearing when the extension is disabled.
//   5. Stripe checkout — every trip booked and paid with the Stripe test card
//                       (WPTE Stripe add-on), then the booking is read back via
//                       REST: trip, travellers, accommodation lines, total and
//                       the completed Stripe payment.
//
// Fixtures (global rooms/upgrades, the per-feature trips and their trip-level
// accommodation config) are built through the WPTE REST API in beforeAll, so
// the frontend tests don't depend on the slow trip editor.
//
// Serial on purpose: pricing format, shared rooms and Mandatory For are
// site-wide settings, so scenarios would trample each other in parallel.
// Sections 1-4 do not submit payment (checkout asserted up to Tour Details);
// section 5 does, with Stripe in test mode.

const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env"), quiet: true });

const { test, expect } = require("@playwright/test");
const WPLoginPage = require("../pages/WPLoginPage");
const WpteExtensionsPage = require("../pages/WpteExtensionsPage");
const AccommodationSettingsPage = require("../pages/AccommodationSettingsPage");
const TripAccommodationPage = require("../pages/TripAccommodationPage");
const { AccommodationBookingPage } = require("../pages/AccommodationBookingPage");
const { WpteApi } = require("../config/wpteApi");
const { resolveAuthFile, hasSavedSession } = require("../config/session");
const { startLiveFrames } = require("./support/liveFrames");
const { PREFIX, ADULT_PRICE, ROOMS, UPGRADES, BASE_GLOBAL, TRIPS, CHECKOUTS, STRIPE_TEST_CARD } = require("../config/accommodationData");
const { WpteStripeCheckoutPage } = require("../pages/WpteStripeCheckoutPage");

const BASE = (process.env.FRONTEND_URL || "").replace(/\/$/, "");
const ADDON_SLUG = "wptravelengine-accommodation";
const CLEANUP = process.env.ACCOMMODATION_CLEANUP === "1";

test.describe.configure({ mode: "serial" });
// The trip editor's save alone can take 20-30s on the test host, and headed
// runs add a 1s slowMo to every action.
test.setTimeout(8 * 60 * 1000);

/** State shared by the whole serial suite. */
const ctx = {
  context: null,
  page: null,
  api: null,
  categories: [], // [{ label, value }]
  roomIds: {}, // room_type → id
  upgradeIds: {}, // name → id
  trips: {}, // scenario key → { id, link, title }
  fixturesReady: false,
  originalGlobal: null,
};

const categoryId = (label) => {
  const found = ctx.categories.find((c) => c.label === label);
  if (!found) throw new Error(`No traveler category "${label}" on this site (have: ${ctx.categories.map((c) => c.label).join(", ")})`);
  return found.value;
};

/** Opens wp-admin; logs in with WP_USERNAME/WP_PASSWORD when the saved session has expired. */
async function ensureWpAdmin(page) {
  await page.goto(`${BASE}/wp-admin/`);
  if (/wp-login\.php/i.test(page.url())) {
    if (!process.env.WP_USERNAME || !process.env.WP_PASSWORD) {
      throw new Error("wp-admin needs a login and WP_USERNAME / WP_PASSWORD are not set in .env (or run `npm run auth`).");
    }
    console.log("ℹ Saved WordPress session expired — logging in for this run");
    await new WPLoginPage(page).login(process.env.WP_USERNAME, process.env.WP_PASSWORD);
  }
}

/** Global settings a scenario needs, on top of BASE_GLOBAL. */
async function applyGlobal(scenario) {
  const global = { ...BASE_GLOBAL, ...(scenario.global || {}) };
  global.mandatory_for = (global.mandatory_for || []).map((label) => categoryId(label));
  return ctx.api.updateAccommodationSettings(global);
}

/** Trip-level accommodation payload for a scenario (all rooms not listed stay disabled). */
function tripAccommodationPayload(scenario) {
  const rooms = (scenario.rooms || []).map((entry) => {
    const room = ROOMS[entry.room];
    return {
      id: ctx.roomIds[room.room_type],
      room_type: room.room_type,
      no_of_guests: room.no_of_guests,
      included_in_package: entry.included_in_package ?? false,
      price: entry.price,
      short_description: room.short_description || "",
      description: "",
      images: [],
      enable: entry.enable ?? true,
      allow_shared_booking: entry.allow_shared_booking ?? false,
    };
  });
  const upgrades = (scenario.upgrades || []).map((entry) => {
    const upgrade = UPGRADES[entry.upgrade];
    return {
      id: ctx.upgradeIds[upgrade.name],
      name: upgrade.name,
      hotel_name: upgrade.hotel_name,
      price: entry.price,
      room_types: (entry.rooms || []).map((key) => ctx.roomIds[ROOMS[key].room_type]),
      enable: true,
      description: "",
      short_description: "",
    };
  });
  return { rooms, upgrades };
}

/** True when every room/upgrade in `wanted` is already on the trip with the same values. */
function accommodationMatches(current, wanted) {
  if (!current) return false;
  const same = (have, want) => have && Object.entries(want).every(([k, v]) => JSON.stringify(have[k]) === JSON.stringify(v));
  const roomsOk = wanted.rooms.every((room) => same((current.rooms || []).find((r) => r.id === room.id), room));
  // Rooms enabled on the trip but not in the scenario would leak into it.
  const noExtraRooms = (current.rooms || []).every((r) => !r.enable || wanted.rooms.some((w) => w.id === r.id));
  const upgradesOk =
    (current.upgrades || []).length === wanted.upgrades.length &&
    wanted.upgrades.every((u) => same((current.upgrades || []).find((c) => c.id === u.id), u));
  return roomsOk && noExtraRooms && upgradesOk;
}

/**
 * Builds (idempotently) the global QA rooms/upgrades and one trip per feature.
 * Runs once per worker; any section calls it, so `--grep` can run a single
 * section or test on its own.
 */
async function ensureFixtures() {
  if (ctx.fixturesReady) return;
  if (!ctx.categories.length) {
    const settings = new AccommodationSettingsPage(ctx.page, BASE);
    await settings.open();
    ctx.categories = await settings.travelerCategories();
  }
  // The trip-level config only shows rooms when the extension is on.
  await ctx.api.updateAccommodationSettings({ enable: true });
  ctx.roomIds = await ctx.api.ensureGlobalRooms(Object.values(ROOMS));
  ctx.upgradeIds = await ctx.api.ensureGlobalUpgrades(Object.values(UPGRADES));

  const adultCategoryId = categoryId("Adult");
  for (const [key, scenario] of Object.entries(TRIPS)) {
    const { accommodation: current, ...trip } = await ctx.api.upsertTrip({ title: scenario.title, adultCategoryId, adultPrice: ADULT_PRICE });
    const wanted = tripAccommodationPayload(scenario);
    if (!accommodationMatches(current, wanted)) {
      await ctx.api.updateTrip(trip.id, { accommodation: wanted });
    }
    ctx.trips[key] = trip;
    console.log(`✓ fixture trip: ${scenario.title} (#${trip.id})`);
  }
  ctx.fixturesReady = true;

  writeFixturesFile();
}

/**
 * What the suite built on the site, for the runner UI's Fixtures tab
 * (path registered in config/addons.js).
 */
function writeFixturesFile() {
  const fs = require("fs");
  const out = path.resolve(__dirname, "../data/addons/wptravelengine-accommodation/fixtures.json");
  try {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const items = Object.entries(ctx.trips).map(([key, t]) => ({
      key,
      id: t.id,
      title: t.title.replace(/^QA Accommodation - /, ""),
      note: TRIPS[key]?.feature || "",
      tag: TRIPS[key]?.global?.pricing_format === "per_traveler" ? "Per Traveler" : "Per Room",
      link: t.link,
      editUrl: `${BASE}/wp-admin/post.php?post=${t.id}&action=edit`,
    }));
    fs.writeFileSync(out, JSON.stringify({ site: BASE, updatedAt: new Date().toISOString(), kind: "Trips", items }, null, 2));
  } catch (error) {
    console.log(`ℹ Could not write ${out}: ${error.message}`);
  }
}

/**
 * The Stripe checkout section's bookings, for the runner UI's Bookings tab
 * (path registered in config/addons.js). Written once the section finishes.
 */
function writeBookingsFile(rows) {
  const fs = require("fs");
  const out = path.resolve(__dirname, "../data/addons/wptravelengine-accommodation/bookings.json");
  try {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify({ site: BASE, updatedAt: new Date().toISOString(), kind: "Bookings", items: rows }, null, 2));
  } catch (error) {
    console.log(`ℹ Could not write ${out}: ${error.message}`);
  }
}

test.beforeAll(async ({ browser }, testInfo) => {
  testInfo.setTimeout(3 * 60 * 1000);
  expect(BASE, "FRONTEND_URL must be set in .env").toBeTruthy();
  const authFile = resolveAuthFile();
  ctx.context = await browser.newContext({
    storageState: hasSavedSession(authFile) ? authFile : undefined,
    viewport: { width: 1400, height: 1000 },
  });
  ctx.page = await ctx.context.newPage();
  // Live view for the runner UI (no-op unless PW_LIVE_FILE is set).
  ctx.stopLive = startLiveFrames(ctx.context);
  await ensureWpAdmin(ctx.page);
  ctx.api = await new WpteApi(ctx.page, BASE).init();
  ctx.originalGlobal = await ctx.api.getAccommodationSettings();
});

test.afterAll(async ({}, testInfo) => {
  testInfo.setTimeout(3 * 60 * 1000);
  if (!ctx.api) {
    ctx.stopLive?.();
    return;
  }
  try {
    // Put the site-wide options back the way they were, but leave the
    // extension ENABLED — switching it on is part of what this suite is for.
    if (ctx.originalGlobal) {
      const o = ctx.originalGlobal;
      await ctx.api.updateAccommodationSettings({
        enable: true,
        title: o.title,
        description: o.description,
        pricing_format: o.pricing_format,
        allow_shared_room_bookings: o.allow_shared_room_bookings,
        shared_occupancy_notice: o.shared_occupancy_notice,
        mandatory_for: o.mandatory_for,
      });
    }
    if (CLEANUP) {
      for (const trip of Object.values(ctx.trips)) await ctx.api.deleteTrip(trip.id).catch(() => {});
      await ctx.api.removeGlobalByPrefix(PREFIX);
      console.log("✓ Cleanup: QA trips, rooms and upgrades removed");
    } else {
      console.log("ℹ QA trips kept for inspection (set ACCOMMODATION_CLEANUP=1 to delete them):");
      for (const trip of Object.values(ctx.trips)) console.log(`   ${trip.title} → ${trip.link}`);
    }
  } finally {
    ctx.stopLive?.();
    await ctx.context?.close();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. Extension
// ─────────────────────────────────────────────────────────────────────────────

test.describe("1. Extension", () => {
  test("Accommodation add-on is installed, licensed and active", async () => {
    const extensions = new WpteExtensionsPage(ctx.page, BASE);
    await extensions.open();

    let status = await extensions.status(ADDON_SLUG);
    expect(status.found, "Accommodation card is missing from WP Travel Engine › Extensions").toBe(true);
    console.log(`Accommodation card: active=${status.active} license=${status.licenseStatus} version=${status.version}`);

    if (status.licenseStatus !== "valid" && process.env.ACCOMMODATION_LICENSE_KEY) {
      await extensions.activateLicense(ADDON_SLUG, process.env.ACCOMMODATION_LICENSE_KEY);
    }
    if (!status.active) {
      console.log("Accommodation is not active — activating the plugin");
      await extensions.activatePlugin(ADDON_SLUG);
      await extensions.open();
      status = await extensions.status(ADDON_SLUG);
    }

    expect(status.active, "Accommodation should show as Active on the Extensions page").toBe(true);
    expect(status.licenseStatus, "Accommodation license should be valid (set ACCOMMODATION_LICENSE_KEY to activate it)").toBe("valid");
  });

  test("Accommodation Enable switch is turned on (Settings > Extensions)", async () => {
    const settings = new AccommodationSettingsPage(ctx.page, BASE);
    await settings.open();
    ctx.categories = await settings.travelerCategories();

    if (!(await settings.isEnabled())) {
      console.log("Accommodation Enable is OFF — switching it on");
      await settings.setEnabled(true);
      const saved = await settings.save();
      expect(saved.enable).toBe(true);
    } else {
      console.log("Accommodation Enable is already ON");
    }

    // Enabling reveals the rest of the form.
    for (const label of ["Title", "Description", "Pricing Format", "Mandatory For"]) {
      await expect(settings.control(label)).toBeVisible();
    }
    await expect(settings.roomsTable).toBeVisible();
    await expect(settings.upgradesTable).toBeVisible();
    expect((await ctx.api.getAccommodationSettings()).enable).toBe(true);
  });

  test("Fixtures: global QA rooms/upgrades and one trip per feature", async () => {
    await ensureFixtures();
    for (const room of Object.values(ROOMS)) expect(ctx.roomIds[room.room_type], `room ${room.room_type}`).toBeTruthy();
    for (const upgrade of Object.values(UPGRADES)) expect(ctx.upgradeIds[upgrade.name], `upgrade ${upgrade.name}`).toBeTruthy();
    expect(Object.keys(ctx.trips)).toEqual(Object.keys(TRIPS));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Global settings UI
// ─────────────────────────────────────────────────────────────────────────────

test.describe("2. Settings UI", () => {
  let settings;
  test.beforeAll(async ({}, testInfo) => {
    testInfo.setTimeout(5 * 60 * 1000);
    await ensureFixtures();
  });
  test.beforeEach(async () => {
    settings = new AccommodationSettingsPage(ctx.page, BASE);
    await settings.open();
  });

  test("Title and Description save and persist", async () => {
    await settings.titleInput.fill("QA Stay Options");
    await settings.descriptionInput.fill("QA: choose where you will stay on this trip.");
    const saved = await settings.save();
    expect(saved.title).toBe("QA Stay Options");
    expect(saved.description).toBe("QA: choose where you will stay on this trip.");

    await settings.open();
    await expect(settings.titleInput).toHaveValue("QA Stay Options");
    await expect(settings.descriptionInput).toHaveValue("QA: choose where you will stay on this trip.");
  });

  test("Pricing Format: Per Traveler shows shared-room options, Per Room hides them", async () => {
    await settings.setPricingFormat("Per Traveler");
    await expect(settings.control("Allow Shared Room Bookings")).toBeVisible();
    await settings.setSharedRoomBookings(false);
    await expect(settings.control("Shared Occupancy Notice")).toHaveCount(0);

    await settings.setSharedRoomBookings(true);
    await expect(settings.sharedNoticeInput).toBeVisible();
    await settings.sharedNoticeInput.fill("QA shared notice from the settings test");
    let saved = await settings.save();
    expect(saved.pricing_format).toBe("per_traveler");
    expect(saved.allow_shared_room_bookings).toBe(true);
    expect(saved.shared_occupancy_notice).toBe("QA shared notice from the settings test");

    await settings.open();
    await expect(settings.sharedSwitch).toBeChecked();
    await expect(settings.sharedNoticeInput).toHaveValue("QA shared notice from the settings test");

    await settings.setSharedRoomBookings(false);
    await expect(settings.control("Shared Occupancy Notice")).toHaveCount(0);
    await settings.setPricingFormat("Per Room");
    await expect(settings.control("Allow Shared Room Bookings")).toHaveCount(0);
    saved = await settings.save();
    expect(saved.pricing_format).toBe("per_room");
    expect(saved.allow_shared_room_bookings).toBe(false);
  });

  test("Mandatory For: lists traveler categories, selects and clears", async () => {
    await settings.mandatoryControl.locator(".cw__custom-select__input-wrapper").click();
    const options = await ctx.page.locator(".cw__select-option").allInnerTexts();
    await settings.closeDropdown();
    expect(options.map((o) => o.trim())).toEqual(ctx.categories.map((c) => c.label));

    await settings.selectMandatoryFor(["Adult"]);
    await expect(settings.mandatoryBadges()).toHaveText(["Adult"]);
    let saved = await settings.save();
    expect(saved.mandatory_for.map(Number)).toEqual([Number(categoryId("Adult"))]);

    await settings.open();
    await expect(settings.mandatoryBadges()).toHaveText(["Adult"]);
    await settings.clearMandatoryFor();
    await expect(settings.mandatoryBadges()).toHaveCount(0);
    saved = await settings.save();
    expect(saved.mandatory_for).toEqual([]);
  });

  test("Room Types: add with details, disable, then delete", async () => {
    const room = {
      room_type: "QA UI Room",
      no_of_guests: 3,
      short_description: "QA added from the settings UI",
      description: "QA long description for the UI room",
    };
    await settings.addRoomType({ ...room, enable: false });
    let saved = await settings.save();
    const created = saved.rooms.find((r) => r.room_type === room.room_type);
    expect(created, "new room type should be saved").toBeTruthy();
    expect(created).toMatchObject({
      no_of_guests: 3,
      short_description: room.short_description,
      description: room.description,
      enable: false,
    });
    expect(created.id).toBeTruthy();

    await settings.open();
    expect(await settings.roomTypeValues()).toContain(room.room_type);
    await settings.deleteRoomType(room.room_type);
    saved = await settings.save();
    expect(saved.rooms.map((r) => r.room_type)).not.toContain(room.room_type);

    await settings.open();
    expect(await settings.roomTypeValues()).not.toContain(room.room_type);
  });

  test("Room Upgrades: add with details, then delete", async () => {
    const upgrade = { name: "QA UI Upgrade", hotel_name: "QA UI Hotel", description: "QA upgrade description" };
    await settings.addUpgrade(upgrade);
    let saved = await settings.save();
    const created = saved.upgrades.find((u) => u.name === upgrade.name);
    expect(created, "new upgrade should be saved").toBeTruthy();
    expect(created).toMatchObject({ hotel_name: upgrade.hotel_name, description: upgrade.description });

    await settings.open();
    expect(await settings.upgradeNameValues()).toContain(upgrade.name);
    await settings.deleteUpgrade(upgrade.name);
    saved = await settings.save();
    expect(saved.upgrades.map((u) => u.name)).not.toContain(upgrade.name);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Trip editor UI
// ─────────────────────────────────────────────────────────────────────────────

test.describe("3. Trip editor UI", () => {
  test.beforeAll(async ({}, testInfo) => {
    testInfo.setTimeout(5 * 60 * 1000);
    await ensureFixtures();
  });
  test("Trip › Accommodation: room price, details, included flag and an upgrade persist", async () => {
    const trip = ctx.trips.adminEditor;
    const editor = new TripAccommodationPage(ctx.page, BASE);
    const deluxe = ROOMS.deluxe.room_type;
    const family = ROOMS.family.room_type;
    const lakeView = UPGRADES.lakeView.name;

    await editor.open(trip.id);
    // Every global room is listed on the trip.
    for (const room of Object.values(ROOMS)) await expect(editor.roomRow(room.room_type)).toBeVisible();

    await editor.configureRoom(deluxe, {
      price: 175,
      short_description: "QA editor short description",
      description: "QA editor long description",
      enable: true,
    });
    await editor.configureRoom(family, { price: 0, enable: true, included_in_package: true });
    await editor.addUpgrade(lakeView, { price: 60, roomTypes: [deluxe] });
    await editor.save();

    let data = (await ctx.api.getTrip(trip.id)).accommodation;
    const savedDeluxe = data.rooms.find((r) => r.room_type === deluxe);
    expect(savedDeluxe).toMatchObject({
      price: 175,
      enable: true,
      short_description: "QA editor short description",
      description: "QA editor long description",
    });
    expect(data.rooms.find((r) => r.room_type === family)).toMatchObject({ enable: true, included_in_package: true });
    const savedUpgrade = data.upgrades.find((u) => u.name === lakeView);
    expect(savedUpgrade).toMatchObject({ price: 60, enable: true });
    expect(savedUpgrade.room_types.map(Number)).toEqual([Number(ctx.roomIds[deluxe])]);

    // Reload: the editor shows what was saved.
    await editor.open(trip.id);
    await expect(editor.roomRow(deluxe).locator("input[type='number']")).toHaveValue("175");
    await expect(editor.roomRow(deluxe).locator("input[type='checkbox']")).toBeChecked();
    await expect(editor.upgradeRow(lakeView).locator("input[type='number']")).toHaveValue("60");

    // Turn the family suite off and drop the upgrade.
    await editor.configureRoom(family, { enable: false });
    await editor.removeUpgrade(lakeView);
    await editor.save();

    data = (await ctx.api.getTrip(trip.id)).accommodation;
    expect(data.rooms.find((r) => r.room_type === family).enable).toBe(false);
    expect(data.upgrades.map((u) => u.name)).not.toContain(lakeView);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Frontend — one trip per feature
// ─────────────────────────────────────────────────────────────────────────────

test.describe("4. Frontend booking", () => {
  let booking;
  test.beforeAll(async ({}, testInfo) => {
    testInfo.setTimeout(5 * 60 * 1000);
    await ensureFixtures();
  });
  test.beforeEach(async () => {
    booking = new AccommodationBookingPage(ctx.page);
  });

  test("Per Room pricing: room price is added per room and carried to checkout", async () => {
    const scenario = TRIPS.perRoom;
    const saved = await applyGlobal(scenario);
    const deluxe = ROOMS.deluxe.room_type;

    await booking.reachAccommodationStep(ctx.trips.perRoom.link, 2);

    // Tab label and intro text come from the global Title / Description.
    await expect(ctx.page.locator("nav a", { hasText: saved.title })).toBeVisible();
    await expect(booking.step.locator(":scope > p")).toHaveText(saved.description);

    expect(await booking.visibleRoomNames()).toEqual([deluxe]);
    await expect(booking.roomCard(deluxe).locator(".check-in-description")).toHaveText(ROOMS.deluxe.short_description);
    expect(await booking.roomPriceText(deluxe)).toContain("150");
    expect(await booking.roomOptions(deluxe)).toEqual(["Select Room(s)", "1 Room (2 people)"]);

    await booking.selectRoom(deluxe, "1 Room (2 people)");
    await expect(booking.summary.locator(".wte-booking-details.accommodation")).toContainText(`${deluxe}: 1 x`);
    await expect.poll(() => booking.summaryTotal()).toBe(2 * ADULT_PRICE + 150);

    await booking.goToCheckout();
    const checkout = await booking.checkoutTourDetails();
    expect(checkout).toContain("Accommodation");
    expect(checkout).toMatch(new RegExp(`${deluxe}: 1 x \\$?150`));
    expect(checkout).toMatch(/Total:\s*\$?2,?150/);
  });

  // In Per Traveler mode the trip's price is still the ROOM price; each
  // traveller pays an equal share of it (the add-on's own tooltip reads
  // "Price Per Traveler: <room price> ÷ <guests per room>").
  test("Per Traveler pricing: travellers split the room price", async () => {
    await applyGlobal(TRIPS.perTraveler);
    const deluxe = ROOMS.deluxe.room_type;

    await booking.reachAccommodationStep(ctx.trips.perTraveler.link, 2);
    // Without shared bookings a room is sold full: a 2-guest room only offers 2 travellers.
    expect(await booking.roomOptions(deluxe)).toEqual(["Select Traveller(s)", "2 Travellers"]);

    await booking.selectRoom(deluxe, "2 Travellers");
    await expect(booking.summary.locator(".wte-booking-details.accommodation")).toContainText(deluxe);
    // 2 travellers × ($40 ÷ 2 guests) = $40.
    await expect.poll(() => booking.summaryTotal()).toBe(2 * ADULT_PRICE + 40);

    await booking.goToCheckout();
    const checkout = await booking.checkoutTourDetails();
    expect(checkout).toContain(deluxe);
    expect(checkout).toMatch(/Total:\s*\$?2,?040/);
  });

  test("Room Upgrades: upgrade appears for its room and adds its price", async () => {
    await applyGlobal(TRIPS.upgrades);
    const deluxe = ROOMS.deluxe.room_type;
    const lakeView = UPGRADES.lakeView.name;

    await booking.reachAccommodationStep(ctx.trips.upgrades.link, 2);
    await booking.selectRoom(deluxe, "1 Room (2 people)");
    await expect(booking.roomCard(deluxe)).toContainText("Upgrades Options");

    await booking.openUpgrades(deluxe);
    const upgradeCard = booking.upgradeCard(deluxe, lakeView);
    await expect(upgradeCard).toBeVisible();
    await expect(upgradeCard).toContainText("+$50");

    await booking.selectUpgrade(deluxe, lakeView, "1 Room");
    await expect(booking.summary).toContainText(lakeView);
    await expect.poll(() => booking.summaryTotal()).toBe(2 * ADULT_PRICE + 150 + 50);

    await booking.goToCheckout();
    const checkout = await booking.checkoutTourDetails();
    expect(checkout).toContain(lakeView);
    expect(checkout).toMatch(/Total:\s*\$?2,?200/);
  });

  test("Included in Package: room shows the label and adds nothing to the total", async () => {
    await applyGlobal(TRIPS.included);
    const included = ROOMS.included.room_type;

    await booking.reachAccommodationStep(ctx.trips.included.link, 2);
    await expect(booking.roomCard(included)).toContainText("Included in Package");
    await expect(booking.roomCard(included).locator(".wpte-price")).toHaveCount(0);

    await booking.selectRoom(included, "1 Room (2 people)");
    await expect(booking.summary.locator(".wte-booking-details.accommodation")).toContainText(included);
    await expect.poll(() => booking.summaryTotal()).toBe(2 * ADULT_PRICE);
  });

  test("Shared rooms: a single traveller can book one spot, with the Shared tag and notice", async () => {
    const scenario = TRIPS.shared;
    await applyGlobal(scenario);
    const dorm = ROOMS.shared.room_type;

    // One traveller, two-bed room: only visible because it is shareable.
    await booking.reachAccommodationStep(ctx.trips.shared.link, 1);
    expect(await booking.visibleRoomNames()).toEqual([dorm]);
    await expect(booking.step).not.toContainText(scenario.global.shared_occupancy_notice);

    await booking.selectRoom(dorm, "1 Traveller");
    await expect(booking.roomCard(dorm).locator(".wpte-tag.shared")).toHaveText(/shared/i);
    await expect(booking.step).toContainText(scenario.global.shared_occupancy_notice);
    // One spot in a 2-guest room: $35 ÷ 2 = $17.50.
    await expect.poll(() => booking.summaryTotal()).toBe(ADULT_PRICE + 17.5);
    await expect(booking.proceed).toBeEnabled();
  });

  test("Shared rooms off: the same room is hidden for a single traveller", async () => {
    await applyGlobal({ global: { pricing_format: "per_traveler", allow_shared_room_bookings: false } });
    await booking.reachAccommodationStep(ctx.trips.shared.link, 1);
    await expect(booking.noOptionsMessage).toBeVisible();
    expect(await booking.visibleRoomNames()).toEqual([]);
    // Nothing to choose, so the traveller can still go on to checkout.
    await expect(booking.proceed).toBeEnabled();
  });

  test("Mandatory For Adults: checkout stays blocked until every adult has a room", async () => {
    await applyGlobal(TRIPS.mandatory);
    const deluxe = ROOMS.deluxe.room_type;

    await booking.reachAccommodationStep(ctx.trips.mandatory.link, 2);
    await expect(booking.proceed).toBeDisabled();

    await booking.selectRoom(deluxe, "2 Travellers");
    await expect(booking.proceed).toBeEnabled();

    await booking.selectRoom(deluxe, "Select Traveller(s)");
    await expect(booking.proceed).toBeDisabled();
  });

  test("Not mandatory: travellers can skip accommodation", async () => {
    await applyGlobal(TRIPS.perRoom);
    await booking.reachAccommodationStep(ctx.trips.perRoom.link, 2);
    await expect(booking.proceed).toBeEnabled();
    await expect.poll(() => booking.summaryTotal()).toBe(2 * ADULT_PRICE);
  });

  test("Room visibility: disabled rooms never show, rooms show only when travellers fill them", async () => {
    await applyGlobal(TRIPS.visibility);
    const { deluxe, family, closed } = ROOMS;

    await booking.reachAccommodationStep(ctx.trips.visibility.link, 2);
    let names = await booking.visibleRoomNames();
    expect(names).toContain(deluxe.room_type);
    expect(names, "4-guest suite needs at least 4 travellers").not.toContain(family.room_type);
    expect(names, "room disabled on the trip").not.toContain(closed.room_type);

    await booking.reachAccommodationStep(ctx.trips.visibility.link, 4);
    names = await booking.visibleRoomNames();
    expect(names).toEqual(expect.arrayContaining([deluxe.room_type, family.room_type]));
    expect(names).not.toContain(closed.room_type);
    // Two deluxe rooms fit four travellers.
    expect(await booking.roomOptions(deluxe.room_type)).toContain("2 Rooms (4 people)");
  });

  test("Extension disabled: the Accommodation step disappears; re-enabled it returns", async () => {
    const settings = new AccommodationSettingsPage(ctx.page, BASE);
    await applyGlobal(TRIPS.perRoom);

    await settings.open();
    await settings.setEnabled(false);
    for (const label of ["Title", "Pricing Format", "Mandatory For"]) await expect(settings.control(label)).toHaveCount(0);
    expect((await settings.save()).enable).toBe(false);

    await booking.openTrip(ctx.trips.perRoom.link);
    await booking.continueFromDate();
    await booking.setAdults(2);
    await expect(ctx.page.locator("nav a", { hasText: "Accommodation" })).toHaveCount(0);
    await expect(booking.proceed).toBeVisible();

    await settings.open();
    await settings.setEnabled(true);
    expect((await settings.save()).enable).toBe(true);

    await booking.reachAccommodationStep(ctx.trips.perRoom.link, 2);
    expect(await booking.visibleRoomNames()).toEqual([ROOMS.deluxe.room_type]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Stripe checkout — every trip paid for real (Stripe test mode), then the
//    booking is read back and checked against the accommodation chosen.
//    Runs last: it leaves real bookings behind.
// ─────────────────────────────────────────────────────────────────────────────
test.describe("5. Stripe checkout", () => {
  // One row per checkout, written to bookings.json (the runner UI's Bookings
  // tab) once the section is done, failed checkouts included.
  const rows = [];
  let current = null;

  test.beforeAll(async ({}, testInfo) => {
    testInfo.setTimeout(5 * 60 * 1000);
    await ensureFixtures();
    const changed = await ctx.api.ensureStripe({
      publishable_key: process.env.STRIPE_PUBLISHABLE_KEY,
      secret_key: process.env.STRIPE_SECRET_KEY,
    });
    if (changed.length) console.log(`✓ Stripe gateway set up on the site (${changed.join(", ")})`);
  });

  test.afterEach(async ({}, testInfo) => {
    if (!current) return;
    current.verified = testInfo.status === "passed";
    if (!current.verified) current.error = String(testInfo.error?.message || testInfo.status).replace(/\u001b\[[0-9;]*m/g, "").split("\n").find((l) => l.trim()) || testInfo.status;
    current = null;
  });

  test.afterAll(() => {
    if (!rows.length) return;
    console.log("\nStripe bookings:");
    for (const r of rows) {
      const acc = r.lines.map((l) => `${l.label} $${l.total}`).join(", ") || "(none)";
      console.log(`   ${r.bookingId ? `#${r.bookingId}` : "(no booking)"}  ${r.trip}  $${r.total ?? "-"}  ${acc}  ${r.verified ? "✓ verified" : `✘ ${r.error}`}`);
    }
    writeBookingsFile(rows);
  });

  const decode = (s) => String(s).replace(/&#8211;/g, "–").replace(/&amp;/g, "&").trim();

  for (const [key, plan] of Object.entries(CHECKOUTS)) {
    const name = TRIPS[key].title.replace(/^QA Accommodation - /, "");

    test(`${name}: paid with Stripe, booking carries the accommodation`, async () => {
      const trip = ctx.trips[key];
      current = { key, trip: name, tripId: trip.id, bookingId: null, travellers: plan.adults, lines: [], total: null, expectedTotal: plan.expect.total, payment: null, verified: false };
      rows.push(current);
      const rec = current;

      await applyGlobal(TRIPS[key]);
      if (plan.trip) await ctx.api.updateTrip(trip.id, { accommodation: tripAccommodationPayload(plan.trip) });

      // ── book ──
      const booking = new AccommodationBookingPage(ctx.page);
      await booking.reachAccommodationStep(trip.link, plan.adults);
      for (const [room, option] of plan.select) await booking.selectRoom(ROOMS[room].room_type, option);
      for (const [room, upgrade, option] of plan.upgrades || []) {
        await booking.openUpgrades(ROOMS[room].room_type);
        await booking.selectUpgrade(ROOMS[room].room_type, UPGRADES[upgrade].name, option);
      }
      await expect.poll(() => booking.summaryTotal(), { message: "Booking summary total" }).toBe(plan.expect.total);
      await booking.goToCheckout();

      // ── pay ──
      const { bookingId, thankYouText } = await new WpteStripeCheckoutPage(ctx.page).pay(STRIPE_TEST_CARD);
      rec.bookingId = bookingId;
      rec.editUrl = `${BASE}/wp-admin/post.php?post=${bookingId}&action=edit`;
      console.log(`✓ ${name}: paid, booking #${bookingId}`);

      // ── read the stored booking (recorded before asserting, so a failed
      //    check still shows what the booking holds) ──
      const saved = await ctx.api.getBooking(bookingId);
      const booked = saved.booked_trips?.[0] || {};
      // Every non-traveller line item group (accommodation, upgrades…) counts.
      const lines = Object.entries(booked.line_items || {})
        .filter(([group]) => group !== "pricing_category")
        .flatMap(([group, items]) => (items || []).map((l) => ({ group, label: decode(l.label), quantity: Number(l.quantity), price: Number(l.price), total: Number(l.total) })));
      const payment = (saved.payments || []).find((p) => p.payment_gateway === "stripe_payment");
      Object.assign(rec, {
        travellers: Number(booked.number_of_travellers),
        lines,
        total: Number(saved.total_amount),
        status: saved.booking_status,
        payment: payment ? { status: payment.status, amount: Number(payment.amount), gateway: payment.payment_gateway } : null,
        paidAmount: Number(saved.paid_amount),
      });
      console.log(`  booking #${bookingId} lines: ${lines.map((l) => `${l.label} ${l.quantity} x ${l.price} = ${l.total}`).join("; ") || "(none)"}`);

      // ── verify ──
      expect(thankYouText).toContain("Accommodation");
      for (const line of plan.expect.lines) expect(thankYouText).toContain(line.label);

      expect(saved.booked_trips, "one trip on the booking").toHaveLength(1);
      expect(Number(booked.id), "booked trip").toBe(Number(trip.id));
      expect(Number(booked.number_of_travellers), "travellers").toBe(plan.adults);

      const adult = (booked.line_items?.pricing_category || []).find((l) => l.label === "Adult");
      expect(adult, "Adult line on the booking").toBeTruthy();
      expect(Number(adult.quantity)).toBe(plan.adults);
      expect(Number(adult.total)).toBe(plan.adults * ADULT_PRICE);

      for (const want of plan.expect.lines) {
        const got = lines.filter((l) => l.label.includes(want.label));
        expect(got.length, `"${want.label}" line on booking #${bookingId}`).toBeGreaterThan(0);
        expect(got.reduce((sum, l) => sum + l.total, 0), `"${want.label}" total on booking #${bookingId}`).toBeCloseTo(want.total, 2);
      }
      const unexpected = lines.filter((l) => !plan.expect.lines.some((w) => l.label.includes(w.label)));
      expect(unexpected, "no accommodation the traveller did not choose").toEqual([]);

      expect(Number(saved.total_amount), "booking total").toBeCloseTo(plan.expect.total, 2);
      expect(payment, "Stripe payment on the booking").toBeTruthy();
      expect(payment.status, "Stripe payment status").toBe("completed");
      expect(Number(payment.amount), "Stripe payment amount").toBeCloseTo(plan.expect.total, 2);

      // paid_amount is only raised by the Stripe webhook, which can't reach a
      // local site — note it rather than fail on it.
      if (Number(saved.paid_amount) !== Number(plan.expect.total)) {
        test.info().annotations.push({ type: "note", description: `booking #${bookingId}: paid_amount is ${saved.paid_amount} (payment completed for ${payment.amount}; webhook not received)` });
      }
    });
  }
});
