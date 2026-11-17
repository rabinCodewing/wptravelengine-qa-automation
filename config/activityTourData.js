// config/activityTourData.js
//
// QA fixtures for the Activity Tour Booking add-on suite (tests/activityTour.spec.js).
//
// The add-on turns a trip into a SINGLE-DAY activity: duration in hours+minutes,
// its own React booking modal (package → travellers → date → time slot), and
// time slots per departure (stored by Fixed Starting Dates). Every trip below is
// built over the WPTE REST API and reused on re-runs, the same way the
// Accommodation suite builds its trips.
//
// Everything created starts with PREFIX so a cleanup run can find it.
//
// Category ids: the site's traveller categories are discovered at run time
// (Adult / Child); the definitions refer to them by label.

const PREFIX = "QA Activity";

/**
 * Departures for a trip, created through Fixed Starting Dates'
 * /wptravelengine/v1/trip-dates/create (a plain trip save ignores them).
 *   weekdays   JS day numbers (0 = Sunday … 6 = Saturday); [] = every day
 *   seats      whole-date seat limit ("" = unlimited)
 *   times      time slots; `seats` per slot ("" = unlimited)
 * Dates run from tomorrow for `days` days, so they are always in the future.
 */
const DEPARTURES = {
  timeSlots: [
    { weekdays: [1], seats: "", times: [{ from: "09:00", to: "12:00", seats: 3 }, { from: "13:00", to: "16:00", seats: "" }] },
    { weekdays: [2], seats: "", times: [{ from: "14:00", to: "17:00", seats: "" }] },
  ],
  limitedSeats: [{ weekdays: [], seats: 2, times: [] }],
};

// A traveller category. `price` "" hides the category from the modal.
const cat = (label, price, extra = {}) => ({ label, price, ...extra });

/**
 * One trip per feature. `packages` lists the trip's packages (first = primary);
 * each package lists its traveller categories by label.
 */
const TRIPS = {
  basic: {
    key: "basic",
    title: `${PREFIX} - Single Day Basic`,
    feature: "Plain single-day activity: 4 hours, open every day, Adult only.",
    trip_type: "single",
    duration: { hours: 4, minutes: 0 },
    packages: [{ name: "QA Standard", categories: [cat("Adult", 1000)] }],
  },
  withMinutes: {
    key: "withMinutes",
    title: `${PREFIX} - Hours and Minutes`,
    feature: "Hours + minutes duration (2 h 30 min) shown in the trip title.",
    trip_type: "single",
    duration: { hours: 2, minutes: 30 },
    packages: [{ name: "QA Standard", categories: [cat("Adult", 1200)] }],
  },
  timeSlots: {
    key: "timeSlots",
    title: `${PREFIX} - Time Slots`,
    feature: "Mondays 09:00 (3 seats) + 13:00, Tuesdays 14:00; a time must be picked.",
    trip_type: "single",
    duration: { hours: 3, minutes: 0 },
    packages: [{ name: "QA Standard", categories: [cat("Adult", 1500)] }],
    departures: "timeSlots",
  },
  travellers: {
    key: "travellers",
    title: `${PREFIX} - Adult and Child`,
    feature: "Two traveller categories: Adult $1000, Child $500.",
    trip_type: "single",
    duration: { hours: 5, minutes: 0 },
    packages: [{ name: "QA Standard", categories: [cat("Adult", 1000), cat("Child", 500)] }],
  },
  salePrice: {
    key: "salePrice",
    title: `${PREFIX} - Sale Price`,
    feature: "Adult $1000 on sale for $800; the modal charges the sale price.",
    trip_type: "single",
    duration: { hours: 2, minutes: 0 },
    packages: [{ name: "QA Standard", categories: [cat("Adult", 1000, { sale_price: 800 })] }],
  },
  packages: {
    key: "packages",
    title: `${PREFIX} - Packages`,
    feature: "Two packages: Standard $1000 (primary) and Premium $1800; switching changes the price.",
    trip_type: "single",
    duration: { hours: 3, minutes: 0 },
    packages: [
      { name: "QA Standard", categories: [cat("Adult", 1000)] },
      { name: "QA Premium", description: "<p>Premium includes lunch and a private guide.</p>", categories: [cat("Adult", 1800)] },
    ],
  },
  groupPricing: {
    key: "groupPricing",
    title: `${PREFIX} - Per Group Pricing`,
    feature: "Adult priced per group ($5000) — the total stays the same for any group size.",
    trip_type: "single",
    duration: { hours: 6, minutes: 0 },
    packages: [{ name: "QA Standard", categories: [cat("Adult", 5000, { pricing_type: "per-group" })] }],
  },
  minTravellers: {
    key: "minTravellers",
    title: `${PREFIX} - Minimum Travellers`,
    feature: "Adult minimum 2: the counter starts at 2, shows 'Minimum: 2' and can't go to 1.",
    trip_type: "single",
    duration: { hours: 3, minutes: 0 },
    packages: [{ name: "QA Standard", categories: [cat("Adult", 700, { min_pax: 2 })] }],
  },
  limitedSeats: {
    key: "limitedSeats",
    title: `${PREFIX} - Limited Seats`,
    feature: "Every departure has 2 seats: 3 travellers get 'No seats available.'",
    trip_type: "single",
    duration: { hours: 2, minutes: 0 },
    packages: [{ name: "QA Standard", categories: [cat("Adult", 900)] }],
    departures: "limitedSeats",
  },
  multiControl: {
    key: "multiControl",
    title: `${PREFIX} - Multi Day Control`,
    feature: "Multi-day trip (control): the activity modal must NOT apply.",
    trip_type: "multi",
    duration: { days: 3, nights: 2 },
    packages: [{ name: "QA Standard", categories: [cat("Adult", 2000)] }],
  },
};

/**
 * Stripe checkouts (section 5): what to book on each trip and what the stored
 * booking must hold. `time` is the slot's start (HH:MM); `weekday` picks the
 * first departure on that JS weekday.
 */
const CHECKOUTS = {
  basic: { travellers: { Adult: 1 }, expect: { total: 1000, travellers: 1 } },
  withMinutes: { travellers: { Adult: 2 }, expect: { total: 2400, travellers: 2 } },
  timeSlots: { travellers: { Adult: 2 }, weekday: 1, time: "13:00", expect: { total: 3000, travellers: 2 } },
  travellers: { travellers: { Adult: 2, Child: 1 }, expect: { total: 2500, travellers: 3 } },
  salePrice: { travellers: { Adult: 1 }, expect: { total: 800, travellers: 1 } },
  packages: { package: "QA Premium", travellers: { Adult: 1 }, expect: { total: 1800, travellers: 1 } },
  groupPricing: { travellers: { Adult: 3 }, expect: { total: 5000, travellers: 3 } },
  minTravellers: { travellers: {}, expect: { total: 1400, travellers: 2 } },
};

const STRIPE_TEST_CARD = { number: "4242424242424242", expiry: "12 / 34", cvc: "123", postalCode: "44600" };

module.exports = { PREFIX, TRIPS, DEPARTURES, CHECKOUTS, STRIPE_TEST_CARD };
