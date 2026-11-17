// tests/activityTour.spec.js
//
// WP Travel Engine — Activity Tour Booking add-on (wptravelengine-activity-tour-booking).
//
//   npx playwright test tests/activityTour.spec.js --project=firefox
//   PW_HEADLESS=1 …                                headless, much faster
//   ACTIVITY_TOUR_CLEANUP=1 …                      also deletes the QA trips at the end
//
// The add-on turns a trip into a SINGLE-DAY activity: "Duration Type" Single
// Day / Activity (duration in hours + minutes), its own React booking modal
// (package → travellers → date → time slot → Book Now) and per-departure time
// slots stored by Fixed Starting Dates (a required dependency).
//
// What it covers, in order:
//   1. Extension        add-on + Fixed Starting Dates active; one QA trip per
//                       feature built over REST (config/activityTourData.js).
//   2. Trip editor UI   Duration Type switches the duration fields; hours and
//                       minutes save and read back through REST.
//   3. Trip page & REST trip_type/unit/minutes over REST; the trip title shows
//                       "N Hours M Minutes" (single) or "N Days" (multi).
//   4. Frontend booking modal only on single-day trips; travellers & categories,
//                       sale price, packages (+ details), per-group pricing,
//                       minimum travellers, calendar prices, time slots and
//                       per-slot seats, limited seats, cart request contents.
//   5. Known bugs       confirmed QA Report findings (AT-001/002/004/013/014),
//                       written as test.fail(): they pass while the bug is
//                       there and turn red once it is fixed.
//   6. Stripe checkout  every bookable trip booked and PAID with the Stripe
//                       test card, then the booking is read back over REST.
//                       Runs last: it leaves real bookings behind.
//
// Serial: sections share the fixtures and the single wp-admin page.

const path = require("path");
const fs = require("fs");
require("dotenv").config({ path: path.resolve(__dirname, "../.env"), quiet: true });

const { test, expect } = require("@playwright/test");
const WPLoginPage = require("../pages/WPLoginPage");
const WpteExtensionsPage = require("../pages/WpteExtensionsPage");
const ActivityTourTripPage = require("../pages/ActivityTourTripPage");
const ActivityTourBookingPage = require("../pages/ActivityTourBookingPage");
const { WpteStripeCheckoutPage } = require("../pages/WpteStripeCheckoutPage");
const { WpteApi } = require("../config/wpteApi");
const { resolveAuthFile, hasSavedSession } = require("../config/session");
const { startLiveFrames } = require("./support/liveFrames");
const { PREFIX, TRIPS, DEPARTURES, CHECKOUTS, STRIPE_TEST_CARD } = require("../config/activityTourData");

const BASE = (process.env.FRONTEND_URL || "").replace(/\/$/, "");
const ADDON_SLUG = "wptravelengine-activity-tour-booking";
const FSD_SLUG = "wp-travel-engine-trip-fixed-starting-dates";
const CLEANUP = process.env.ACTIVITY_TOUR_CLEANUP === "1";
const DATA_DIR = path.resolve(__dirname, "../data/addons/wptravelengine-activity-tour");

test.describe.configure({ mode: "serial" });
// Trip saves alone can take 20-30s on the test host; headed runs add slowMo.
test.setTimeout(8 * 60 * 1000);

const ctx = {
  context: null,
  page: null,
  api: null,
  categories: {}, // label → id
  trips: {}, // key → { id, link, title }
  fixturesReady: false,
};

const WEEKDAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
const ymd = (d) => d.toISOString().slice(0, 10);
const plusDays = (n) => {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + n);
  return d;
};
const decode = (s) => String(s).replace(/&#8211;/g, "–").replace(/&amp;/g, "&").trim();

/** Opens wp-admin; logs in with WP_USERNAME/WP_PASSWORD when the saved session has expired. */
async function ensureWpAdmin(page) {
  await page.goto(`${BASE}/wp-admin/edit.php?post_type=trip`);
  if (/wp-login\.php/i.test(page.url())) {
    const { WP_USERNAME, WP_PASSWORD } = process.env;
    expect(WP_USERNAME && WP_PASSWORD, "WP_USERNAME / WP_PASSWORD must be set in .env (or run `npm run auth`)").toBeTruthy();
    console.log("ℹ Saved WordPress session expired — logging in for this run");
    await new WPLoginPage(page).login(WP_USERNAME, WP_PASSWORD);
    await page.goto(`${BASE}/wp-admin/edit.php?post_type=trip`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

/** The site's traveller categories (label → id), read off any trip's package. */
async function discoverCategories() {
  for (const t of (await ctx.api.findTrips("")).slice(0, 15)) {
    const trip = await ctx.api.getTrip(t.id).catch(() => null);
    for (const c of trip?.packages?.[0]?.traveler_categories || []) ctx.categories[c.label] = Number(c.id);
    if (ctx.categories.Adult) break;
  }
  expect(ctx.categories.Adult, "an 'Adult' traveller category on this site").toBeTruthy();
}

/** REST package payload for a definition; every site category is listed, unused ones without a price. */
function packagePayload(def, index, existing) {
  const days = Object.fromEntries(WEEKDAYS.slice(1).concat("SU").map((d) => [d, []]));
  const primaryLabel = def.categories[0].label;
  const traveler_categories = Object.entries(ctx.categories).map(([label, id]) => {
    const want = def.categories.find((c) => c.label === label);
    const perGroup = want?.pricing_type === "per-group";
    return {
      id,
      label,
      price: want ? want.price : "",
      age_group: "",
      pricing_type: perGroup ? { value: "per-group", label: "Group", description: "" } : { value: "per-person", label: "Person", description: "" },
      sale_price: want?.sale_price ?? "",
      has_sale: want?.sale_price !== undefined,
      has_group_pricing: false,
      group_pricing: [],
      min_pax: want?.min_pax ?? (label === primaryLabel ? 1 : 0),
      max_pax: "",
      description: "",
      is_primary: label === primaryLabel,
      is_min_required: false,
    };
  });
  return {
    ...(existing?.id ? { id: existing.id } : {}),
    name: def.name,
    description: def.description || "",
    is_primary: index === 0,
    min_pax: 1,
    traveler_categories,
    time_slots_enable: false,
    time_slots: days,
    enable_week_days: Object.fromEntries(Object.keys(days).map((d) => [d, false])),
    dates: [],
  };
}

/** True when the trip's packages already match the definition. */
function packagesMatch(current, defs) {
  if (!current || current.length !== defs.length) return false;
  return defs.every((def, i) => {
    const pkg = current[i];
    if (!pkg || pkg.name !== def.name || Boolean(pkg.is_primary) !== (i === 0)) return false;
    return def.categories.every((want, ci) => {
      const have = (pkg.traveler_categories || []).find((c) => c.label === want.label);
      return (
        have &&
        Number(have.price) === Number(want.price) &&
        String(have.sale_price ?? "") === String(want.sale_price ?? "") &&
        (have.pricing_type?.value || "per-person") === (want.pricing_type || "per-person") &&
        Number(have.min_pax) === Number(want.min_pax ?? (ci === 0 ? 1 : 0))
      );
    }) && (pkg.traveler_categories || []).every((c) => def.categories.some((w) => w.label === c.label) || c.price === "" || c.price === null);
  });
}

function durationPayload(def) {
  return def.trip_type === "single"
    ? { period: def.duration.hours, unit: "hours", minutes: def.duration.minutes || 0 }
    : { period: def.duration.days, unit: "days", nights: def.duration.nights ?? def.duration.days - 1 };
}

/** Departures already on the trip that satisfy the definition? */
function departuresPresent(dates, key) {
  const entries = Object.entries(dates?.[0]?.dates || {});
  if (!entries.length) return false;
  if (key === "timeSlots") {
    const hasSlot = (hhmm) => entries.some(([, d]) => (d.times || []).some((t) => String(t.from).endsWith(`T${hhmm}`)));
    return hasSlot("09:00") && hasSlot("13:00") && hasSlot("14:00");
  }
  if (key === "limitedSeats") return entries.every(([, d]) => Number(d.seats) === 2);
  return true;
}

/** Creates the definition's departures through Fixed Starting Dates (existing dates are skipped). */
async function createDepartures(tripId, packageId, key) {
  for (const dep of DEPARTURES[key]) {
    const res = await ctx.api.call("POST", "/wptravelengine/v1/trip-dates/create", {
      trip_id: tripId,
      package_id: packageId,
      start_date: ymd(plusDays(1)),
      end_date: ymd(plusDays(dep.weekdays.length ? 63 : 60)),
      weekdays: dep.weekdays,
      seats: dep.seats,
      times: dep.times,
      availability_label: "guaranteed",
    });
    console.log(`  departures (${key}): ${res.created?.length || 0} created, ${res.skipped?.length || 0} already there`);
  }
}

/** Builds or reuses one QA trip; returns { id, link, title }. */
async function upsertActivityTrip(def) {
  const existing = (await ctx.api.findTrips(def.title)).find((t) => decode(t.title?.raw ?? t.title?.rendered) === def.title);
  const id = existing ? existing.id : (await ctx.api.call("POST", "/wp/v2/trip", { title: def.title, status: "publish", content: `${def.title} — automated Activity Tour fixture. ${def.feature}` })).id;
  if (existing && existing.status !== "publish") await ctx.api.call("POST", `/wp/v2/trip/${id}`, { status: "publish" });

  let trip = await ctx.api.getTrip(id);
  const wantDuration = durationPayload(def);
  const durationOk =
    trip.trip_type === def.trip_type &&
    trip.duration?.unit === wantDuration.unit &&
    Number(trip.duration?.period) === wantDuration.period &&
    (def.trip_type !== "single" || Number(trip.duration?.minutes) === wantDuration.minutes);
  const pkgsOk = packagesMatch(trip.packages, def.packages);

  if (!pkgsOk) {
    const packages = def.packages.map((p, i) => packagePayload(p, i, (trip.packages || []).find((x) => x.name === p.name) || (i === 0 ? trip.packages?.[0] : null)));
    await ctx.api.updateTrip(id, { trip_type: def.trip_type, duration: wantDuration, packages });
  } else if (!durationOk) {
    await ctx.api.updateTrip(id, { trip_type: def.trip_type, duration: wantDuration });
  }
  trip = await ctx.api.getTrip(id);

  if (def.departures) {
    const dates = await ctx.api.call("GET", `/wptravelengine/v2/trips/${id}/dates`);
    if (!pkgsOk || !departuresPresent(dates, def.departures)) await createDepartures(id, trip.packages[0].id, def.departures);
  }
  return { id, link: trip.link, title: def.title, packages: trip.packages };
}

async function ensureFixtures() {
  if (ctx.fixturesReady) return ctx.trips;
  if (!Object.keys(ctx.categories).length) await discoverCategories();
  for (const [key, def] of Object.entries(TRIPS)) {
    ctx.trips[key] = await upsertActivityTrip(def);
    console.log(`✓ fixture trip: ${def.title} (#${ctx.trips[key].id})`);
  }
  ctx.fixturesReady = true;
  writeJson("fixtures.json", {
    kind: "Trips",
    items: Object.entries(ctx.trips).map(([key, t]) => ({
      key,
      id: t.id,
      title: t.title.replace(`${PREFIX} - `, ""),
      note: TRIPS[key].feature,
      tag: TRIPS[key].trip_type === "single" ? "Single Day" : "Multi Day",
      link: t.link,
      editUrl: `${BASE}/wp-admin/post.php?post=${t.id}&action=edit`,
    })),
  });
  return ctx.trips;
}

function writeJson(name, body) {
  const out = path.join(DATA_DIR, name);
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(out, JSON.stringify({ site: BASE, updatedAt: new Date().toISOString(), ...body }, null, 2));
  } catch (error) {
    console.log(`ℹ Could not write ${out}: ${error.message}`);
  }
}

/** First departure date of a trip (optionally on a JS weekday) from the dates API. */
async function firstDate(key, weekday) {
  const dates = await ctx.api.call("GET", `/wptravelengine/v2/trips/${ctx.trips[key].id}/dates`);
  const keys = Object.keys(dates?.[0]?.dates || {}).filter((d) => d > ymd(plusDays(0))).sort();
  const pick = weekday === undefined ? keys[0] : keys.find((d) => new Date(`${d}T00:00:00Z`).getUTCDay() === weekday);
  expect(pick, `a departure for ${key}${weekday !== undefined ? ` on ${WEEKDAYS[weekday]}` : ""}`).toBeTruthy();
  return pick;
}

/** A booking modal on the shared logged-in page, opened on a fixture trip. */
async function openModal(key) {
  const booking = new ActivityTourBookingPage(ctx.page, BASE);
  await booking.open(ctx.trips[key].link);
  await booking.openModal();
  return booking;
}

async function tripTitle(link) {
  const page = await ctx.context.newPage();
  try {
    await page.goto(link, { waitUntil: "domcontentloaded" });
    return (await page.locator(".entry-header").first().innerText()).replace(/\s+/g, " ").trim();
  } finally {
    await page.close();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Setup / teardown
// ─────────────────────────────────────────────────────────────────────────────

test.beforeAll(async ({ browser }, testInfo) => {
  testInfo.setTimeout(3 * 60 * 1000);
  expect(BASE, "FRONTEND_URL must be set in .env").toBeTruthy();
  const authFile = resolveAuthFile();
  ctx.context = await browser.newContext({
    storageState: hasSavedSession(authFile) ? authFile : undefined,
    viewport: { width: 1400, height: 1000 },
  });
  ctx.page = await ctx.context.newPage();
  ctx.stopLive = startLiveFrames(ctx.context);
  await ensureWpAdmin(ctx.page);
  ctx.api = await new WpteApi(ctx.page, BASE).init();
});

test.afterAll(async ({}, testInfo) => {
  testInfo.setTimeout(3 * 60 * 1000);
  try {
    if (ctx.api && CLEANUP) {
      for (const trip of Object.values(ctx.trips)) await ctx.api.deleteTrip(trip.id).catch(() => {});
      console.log("✓ Cleanup: QA activity trips removed");
    } else if (Object.keys(ctx.trips).length) {
      console.log("ℹ QA activity trips kept (set ACTIVITY_TOUR_CLEANUP=1 to delete):");
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
  test("Activity Tour add-on is installed and active", async () => {
    const extensions = new WpteExtensionsPage(ctx.page, BASE);
    await extensions.open();
    let status = await extensions.status(ADDON_SLUG);
    expect(status.found, "Activity Tour card is missing from WP Travel Engine › Extensions").toBe(true);
    console.log(`Activity Tour: active=${status.active} license=${status.licenseStatus} version=${status.version}`);
    if (!status.active) {
      await extensions.activatePlugin(ADDON_SLUG);
      await extensions.open();
      status = await extensions.status(ADDON_SLUG);
    }
    expect(status.active, "Activity Tour should show as Active").toBe(true);
  });

  test("Fixed Starting Dates (required dependency) is active", async () => {
    const plugins = await ctx.api.call("GET", "/wp/v2/plugins?per_page=100");
    const fsd = plugins.find((p) => p.plugin.startsWith(`${FSD_SLUG}/`));
    expect(fsd, "Fixed Starting Dates plugin is not installed").toBeTruthy();
    console.log(`Fixed Starting Dates ${fsd.version}: ${fsd.status}`);
    if (fsd.status !== "active") await ctx.api.call("POST", `/wp/v2/plugins/${fsd.plugin}`, { status: "active" });
    const after = (await ctx.api.call("GET", "/wp/v2/plugins?per_page=100")).find((p) => p.plugin === fsd.plugin);
    expect(after.status, "Fixed Starting Dates should be active").toBe("active");
  });

  test("Fixtures: one activity trip per feature (built via REST)", async () => {
    await ensureFixtures();
    expect(Object.keys(ctx.trips).sort()).toEqual(Object.keys(TRIPS).sort());
    for (const [key, trip] of Object.entries(ctx.trips)) expect(trip.id, `trip ${key} id`).toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Trip editor UI — Duration Type
// ─────────────────────────────────────────────────────────────────────────────
test.describe("2. Trip editor UI", () => {
  test.beforeAll(async () => {
    await ensureFixtures();
  });

  test("Duration Type switches between Day(s) and Hour(s) + Minute(s) fields", async () => {
    const editor = new ActivityTourTripPage(ctx.page, BASE);
    await editor.open(ctx.trips.multiControl.id);
    await expect(editor.durationTypeControl.getByRole("button", { name: "Multi Day", exact: true })).toBeVisible();
    await editor.setDurationType("single");
    await expect(editor.suffixInput("Hour(s)")).toBeVisible();
    await expect(editor.suffixInput("Minute(s)")).toBeVisible();
    await editor.setDurationType("multi");
    await expect(editor.suffixInput("Minute(s)")).toBeHidden();
    // Leave without saving: the multi-day control must stay multi-day.
    await ctx.page.goto(`${BASE}/wp-admin/edit.php?post_type=trip`);
  });

  test("Single Day / Activity: hours and minutes save and persist", async () => {
    const trip = ctx.trips.withMinutes;
    const editor = new ActivityTourTripPage(ctx.page, BASE);
    await editor.open(trip.id);
    await editor.setDurationType("single");
    await editor.setDuration({ hours: 3, minutes: 45 });
    await editor.save();
    try {
      const saved = await ctx.api.getTrip(trip.id);
      expect(saved.trip_type).toBe("single");
      expect(saved.duration.unit).toBe("hours");
      expect(Number(saved.duration.period)).toBe(3);
      expect(Number(saved.duration.minutes)).toBe(45);
    } finally {
      await ctx.api.updateTrip(trip.id, { trip_type: "single", duration: durationPayload(TRIPS.withMinutes) });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Trip page & REST — trip type and duration
// ─────────────────────────────────────────────────────────────────────────────
test.describe("3. Trip page & REST", () => {
  test.beforeAll(async () => {
    await ensureFixtures();
  });

  test("single-day trips report trip_type=single, unit=hours and their minutes", async () => {
    for (const [key, def] of Object.entries(TRIPS).filter(([, d]) => d.trip_type === "single")) {
      const trip = await ctx.api.getTrip(ctx.trips[key].id);
      expect(trip.trip_type, `${def.title} trip_type`).toBe("single");
      expect(trip.duration.unit, `${def.title} unit`).toBe("hours");
      expect(Number(trip.duration.period), `${def.title} hours`).toBe(def.duration.hours);
      expect(Number(trip.duration.minutes), `${def.title} minutes`).toBe(def.duration.minutes);
    }
  });

  test("the multi-day control reports trip_type=multi in days", async () => {
    const trip = await ctx.api.getTrip(ctx.trips.multiControl.id);
    expect(trip.trip_type).toBe("multi");
    expect(trip.duration.unit).toBe("days");
  });

  test("trip title shows hours and minutes for an activity, days for a multi-day trip", async () => {
    expect(await tripTitle(ctx.trips.withMinutes.link)).toMatch(/2\s*Hours\s*30\s*Minutes/);
    expect(await tripTitle(ctx.trips.basic.link)).toMatch(/4\s*Hours/);
    expect(await tripTitle(ctx.trips.basic.link)).not.toMatch(/Minute/);
    expect(await tripTitle(ctx.trips.multiControl.link)).toMatch(/3\s*Days/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Frontend booking modal
// ─────────────────────────────────────────────────────────────────────────────
test.describe("4. Frontend booking", () => {
  test.beforeAll(async () => {
    await ensureFixtures();
  });

  test("single-day trip opens the Activity booking modal", async () => {
    const booking = await openModal("basic");
    await expect(booking.modal).toBeVisible();
    expect(await booking.categoryLabels()).toEqual(["Adult"]);
    expect(await booking.count("Adult")).toBe(1);
  });

  test("multi-day control does NOT use the Activity modal", async () => {
    const booking = new ActivityTourBookingPage(ctx.page, BASE);
    await booking.open(ctx.trips.multiControl.link);
    await ctx.page.waitForLoadState("load");
    expect(await booking.hasActivityModal()).toBe(false);
  });

  test("Book Now stays disabled until a date is chosen; total follows travellers", async () => {
    const booking = await openModal("basic");
    await expect(booking.bookNow).toBeDisabled();
    await booking.chooseDate();
    await expect(booking.bookNow).toBeEnabled();
    expect(await booking.total()).toBe(1000);
    await booking.setTravellers("Adult", 3);
    expect(await booking.total()).toBe(3000);
    // Adult's minimum is 1, so − can't take it to zero.
    await booking.setTravellers("Adult", 1);
    await expect(booking.minus("Adult")).toBeDisabled();
    expect(await booking.total()).toBe(1000);
  });

  test("calendar shows each day's price for the chosen travellers", async () => {
    const booking = await openModal("basic");
    await booking.setTravellers("Adult", 2);
    // Inline calendar renders compact prices: 2 × $1000 → "$2K".
    await expect.poll(() => booking.calendarPrices()).toContainEqual(expect.stringMatching(/2K/));
  });

  test("Adult and Child categories are priced separately", async () => {
    const booking = await openModal("travellers");
    expect(await booking.categoryLabels()).toEqual(["Adult", "Child"]);
    expect(await booking.unitPrice("Adult")).toBe(1000);
    expect(await booking.unitPrice("Child")).toBe(500);
    await booking.setTravellers("Adult", 2);
    await booking.setTravellers("Child", 1);
    await booking.chooseDate();
    expect(await booking.total()).toBe(2500);
  });

  test("sale price is charged instead of the regular price", async () => {
    const booking = await openModal("salePrice");
    expect(await booking.unitPrice("Adult")).toBe(800);
    await booking.chooseDate();
    expect(await booking.total()).toBe(800);
  });

  test("packages: both listed, switching changes the price, details open the description", async () => {
    const booking = await openModal("packages");
    await expect(booking.modal.getByText("Select a Package:")).toBeVisible();
    await expect(booking.modal.getByText("QA Standard", { exact: true })).toBeVisible();
    await expect(booking.modal.getByText("QA Premium", { exact: true })).toBeVisible();
    expect(await booking.unitPrice("Adult")).toBe(1000);
    await booking.selectPackage("QA Premium");
    expect(await booking.unitPrice("Adult")).toBe(1800);
    await booking.chooseDate();
    expect(await booking.total()).toBe(1800);

    await booking.modal.getByRole("button", { name: "Details" }).click();
    const details = ctx.page.locator(".wpte-package-details");
    await expect(details).toContainText("Premium includes lunch and a private guide.");
    await details.locator("button").first().click();
    await expect(details).toBeHidden();
  });

  test("per-group pricing: the total stays the same for any group size", async () => {
    const booking = await openModal("groupPricing");
    await expect(booking.categoryRow("Adult").locator(".category__price")).toContainText("Group");
    await booking.chooseDate();
    expect(await booking.total()).toBe(5000);
    await booking.setTravellers("Adult", 4);
    expect(await booking.total()).toBe(5000);
  });

  test("minimum travellers: counter starts at the minimum and can't go below it", async () => {
    const booking = await openModal("minTravellers");
    expect(await booking.count("Adult")).toBe(2);
    expect(await booking.minimumText("Adult")).toMatch(/Minimum:\s*2/);
    await expect(booking.minus("Adult")).toBeDisabled();
    await booking.setTravellers("Adult", 3);
    await booking.minus("Adult").click();
    expect(await booking.count("Adult")).toBe(2);
    await booking.chooseDate();
    expect(await booking.total()).toBe(1400);
  });

  test("time slots: each departure lists its own times; Book Now needs a time", async () => {
    const monday = await firstDate("timeSlots", 1);
    const tuesday = await firstDate("timeSlots", 2);
    const booking = await openModal("timeSlots");
    const dates = await booking.availableDates();
    expect(dates, "only the configured Monday/Tuesday departures are bookable").toContain(monday);
    expect(dates.every((d) => [1, 2].includes(new Date(`${d}T00:00:00Z`).getUTCDay()))).toBe(true);

    await booking.chooseDate(monday);
    expect(await booking.timeOptions()).toEqual(["9:00 am", "1:00 pm"]);
    await expect(booking.bookNow, "Book Now needs a time slot").toBeDisabled();
    await booking.chooseTime("09:00");
    await expect(booking.bookNow).toBeEnabled();

    // Re-open fresh for Tuesday (switching dates in place is bug AT-001).
    const again = await openModal("timeSlots");
    await again.chooseDate(tuesday);
    expect(await again.timeOptions()).toEqual(["2:00 pm"]);
  });

  test("per-slot seats: a slot with too few seats drops out of the list", async () => {
    const monday = await firstDate("timeSlots", 1);
    const booking = await openModal("timeSlots");
    await booking.chooseDate(monday);
    expect(await booking.timeOptions()).toContain("9:00 am");
    await booking.setTravellers("Adult", 4); // 09:00 has 3 seats
    await expect.poll(() => booking.timeOptions()).toEqual(["1:00 pm"]);
  });

  test("limited seats: more travellers than seats shows 'No seats available.'", async () => {
    const booking = await openModal("limitedSeats");
    await booking.setTravellers("Adult", 2);
    expect((await booking.availableDates()).length).toBeGreaterThan(0);
    await booking.setTravellers("Adult", 3);
    await expect.poll(() => booking.warningText()).toContain("No seats available.");
    await expect(booking.dateInput).toHaveCount(0);
    await expect(booking.bookNow).toBeDisabled();
  });

  test("Book Now sends the chosen package, travellers, date and time to the cart", async () => {
    const monday = await firstDate("timeSlots", 1);
    const booking = await openModal("timeSlots");
    await booking.setTravellers("Adult", 2);
    await booking.chooseDate(monday);
    await booking.chooseTime("13:00");
    const [request] = await Promise.all([
      ctx.page.waitForRequest(/action=wte_add_trip_to_cart/),
      booking.goToCheckout(),
    ]);
    const cart = request.postDataJSON();
    expect(Number(cart.tripID)).toBe(ctx.trips.timeSlots.id);
    expect(Number(cart.packageID)).toBe(Number(ctx.trips.timeSlots.packages[0].id));
    expect(cart.tripDate).toBe(monday);
    expect(cart.tripTime).toBe(`${monday}T13:00`);
    expect(cart.timeRange).toEqual([`${monday}T13:00`, `${monday}T16:00`]);
    expect(Number(cart.traveler)).toBe(2);
    expect(Number(cart.cartTotal)).toBe(3000);
    expect(ctx.page.url()).toMatch(/checkout/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Known bugs — confirmed QA Report findings. Each asserts the CORRECT
//    behaviour inside test.fail(): passes while the bug is present, turns red
//    when it is fixed (then drop the test.fail line).
// ─────────────────────────────────────────────────────────────────────────────
test.describe("5. Known bugs (QA Report)", () => {
  test.beforeAll(async () => {
    await ensureFixtures();
  });

  test("AT-001: changing the date clears the chosen time slot", async () => {
    test.fail(true, "AT-001 open: the old time slot stays selected and Book Now stays enabled");
    const monday = await firstDate("timeSlots", 1);
    const tuesday = await firstDate("timeSlots", 2);
    const booking = await openModal("timeSlots");
    await booking.chooseDate(monday);
    await booking.chooseTime("09:00");
    await booking.chooseDate(tuesday);
    await expect(booking.bookNow, "no valid time selected for the new date").toBeDisabled({ timeout: 5000 });
  });

  test("AT-002: a failed add-to-cart shows an error and frees the button", async () => {
    test.fail(true, "AT-002 open: the button spins forever and no error is shown");
    await ctx.page.route(/action=wte_add_trip_to_cart/, (r) => r.fulfill({ status: 500, body: "QA stub" }));
    try {
      const booking = await openModal("basic");
      await booking.chooseDate();
      await booking.bookNow.click();
      await expect(booking.bookNow, "button usable again after the error").toBeEnabled({ timeout: 8000 });
      await expect(booking.modal).toContainText(/error|try again|failed/i);
    } finally {
      await ctx.page.unroute(/action=wte_add_trip_to_cart/);
    }
  });

  test("AT-004: a departure clicked in the dates list keeps its date for visitors west of UTC", async ({ browser }) => {
    test.fail(true, "AT-004 open: the timestamp is formatted in the visitor's timezone");
    const context = await browser.newContext({ timezoneId: "America/New_York" });
    try {
      const page = await context.newPage();
      await page.goto(ctx.trips.timeSlots.link);
      const btn = page.locator(".wte-fsd__booknow-btn").first();
      await btn.waitFor({ state: "visible", timeout: 30000 });
      const expected = new Date(Number(await btn.getAttribute("data-info")) * 1000).toISOString().slice(0, 10);
      await btn.click();
      const booking = new ActivityTourBookingPage(page, BASE);
      await expect(booking.modal).toBeVisible({ timeout: 30000 });
      await expect.poll(() => booking.selectedDate(), { timeout: 8000 }).toBe(expected);
    } finally {
      await context.close();
    }
  });

  test("AT-013: switching back to Multi Day restores the duration unit to days", async () => {
    test.fail(true, "AT-013 open: the unit stays 'hours' after Single → Multi");
    const id = ctx.trips.multiControl.id;
    try {
      await ctx.api.updateTrip(id, { trip_type: "single" });
      await ctx.api.updateTrip(id, { trip_type: "multi" });
      expect((await ctx.api.getTrip(id)).duration.unit).toBe("days");
    } finally {
      await ctx.api.updateTrip(id, { trip_type: "multi", duration: durationPayload(TRIPS.multiControl) });
    }
  });

  test("AT-014: duration minutes outside 0–59 are rejected or normalised", async () => {
    test.fail(true, "AT-014 open: 90 is saved as-is");
    const id = ctx.trips.withMinutes.id;
    try {
      await ctx.api.updateTrip(id, { duration: { minutes: 90 } }).catch(() => {});
      const minutes = Number((await ctx.api.getTrip(id)).duration.minutes);
      expect(minutes).toBeLessThanOrEqual(59);
    } finally {
      await ctx.api.updateTrip(id, { trip_type: "single", duration: durationPayload(TRIPS.withMinutes) });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Stripe checkout — every bookable trip paid for real (Stripe test mode),
//    then the booking is read back. Runs last: it leaves real bookings behind.
// ─────────────────────────────────────────────────────────────────────────────
test.describe("6. Stripe checkout", () => {
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
    for (const r of rows) console.log(`   ${r.bookingId ? `#${r.bookingId}` : "(no booking)"}  ${r.trip}  ${r.date || ""} ${r.time || ""}  $${r.total ?? "-"}  ${r.verified ? "✓ verified" : `✘ ${r.error}`}`);
    writeJson("bookings.json", { kind: "Bookings", items: rows });
  });

  for (const [key, plan] of Object.entries(CHECKOUTS)) {
    const name = TRIPS[key].title.replace(`${PREFIX} - `, "");

    test(`${name}: paid with Stripe, booking matches the activity`, async () => {
      const trip = ctx.trips[key];
      current = { key, trip: name, tripId: trip.id, bookingId: null, travellers: plan.expect.travellers, total: null, expectedTotal: plan.expect.total, payment: null, verified: false };
      rows.push(current);
      const rec = current;

      // ── book ──
      const date = await firstDate(key, plan.weekday);
      const booking = new ActivityTourBookingPage(ctx.page, BASE);
      await booking.open(trip.link);
      await booking.openModal();
      await booking.selectPackage(plan.package);
      for (const [label, qty] of Object.entries(plan.travellers)) await booking.setTravellers(label, qty);
      await booking.chooseDate(date);
      if (plan.time) await booking.chooseTime(plan.time);
      expect(await booking.total(), "modal total").toBe(plan.expect.total);
      Object.assign(rec, { date, time: plan.time || null });
      await booking.goToCheckout();

      // ── pay ──
      const { bookingId } = await new WpteStripeCheckoutPage(ctx.page).pay(STRIPE_TEST_CARD);
      rec.bookingId = bookingId;
      rec.editUrl = `${BASE}/wp-admin/post.php?post=${bookingId}&action=edit`;
      console.log(`✓ ${name}: paid, booking #${bookingId}`);

      // ── read the stored booking (WPTE 6.9 booking schema) ──
      const saved = await ctx.api.getBooking(bookingId);
      const booked = saved.booked_trips?.[0] || {};
      const payment = (saved.payments || []).find((p) => (p.gateway || p.payment_gateway) === "stripe_payment");
      const categoryLines = (booked.line_items || []).find((g) => g.id === "price_category")?.items || [];
      Object.assign(rec, {
        travellers: Number(booked.travelers_count),
        total: Number(saved.total_amount),
        status: saved.booking_status,
        start: booked.start_datetime,
        package: booked.package?.label,
        lines: categoryLines.map((l) => ({ label: l.label, quantity: l.quantity, price: l.price, total: l.total })),
        payment: payment ? { status: payment.status, amount: Number(payment.paid_amount ?? payment.amount), gateway: payment.gateway, transaction: payment.transaction_id } : null,
        paidAmount: Number(saved.total_paid_amount),
        dueAmount: Number(saved.total_due_amount),
      });
      console.log(`  booking #${bookingId}: ${rec.package} · ${rec.start} · ${rec.lines.map((l) => `${l.label} ${l.quantity}×${l.price}=${l.total}`).join(", ")} · paid ${rec.paidAmount}, due ${rec.dueAmount}`);

      // ── verify ──
      expect(saved.booked_trips, "one trip on the booking").toHaveLength(1);
      expect(Number(booked.id), "booked trip").toBe(Number(trip.id));
      expect(booked.package?.label, "booked package").toBe(plan.package || TRIPS[key].packages[0].name);
      expect(Number(booked.travelers_count), "travellers").toBe(plan.expect.travellers);
      expect(String(booked.start_datetime), "departure date").toMatch(new RegExp(`^${date}`));
      if (plan.time) expect(String(booked.start_datetime), "time slot").toBe(`${date}T${plan.time}`);
      for (const [label, qty] of Object.entries(plan.travellers)) {
        if (!qty) continue;
        expect(categoryLines.find((l) => l.label === label)?.quantity, `${label} quantity on the booking`).toBe(qty);
      }
      expect(categoryLines.reduce((s, l) => s + Number(l.total), 0), "traveller lines add up to the total").toBeCloseTo(plan.expect.total, 2);
      expect(Number(saved.total_amount), "booking total").toBeCloseTo(plan.expect.total, 2);
      expect(payment, "Stripe payment on the booking").toBeTruthy();
      expect(payment.status, "Stripe payment status").toBe("success");
      expect(String(payment.transaction_id), "Stripe PaymentIntent id").toMatch(/^pi_/);
      expect(Number(payment.paid_amount), "Stripe payment amount").toBeCloseTo(plan.expect.total, 2);
      expect(Number(saved.total_paid_amount), "booking fully paid").toBeCloseTo(plan.expect.total, 2);
      expect(Number(saved.total_due_amount), "nothing left to pay").toBe(0);
    });
  }
});
