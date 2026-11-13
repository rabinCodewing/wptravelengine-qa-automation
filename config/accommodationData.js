// config/accommodationData.js
//
// Test data for tests/accommodation.spec.js.
//
// Every room, upgrade and trip the suite creates starts with "QA " so it is
// easy to spot in wp-admin, and so cleanup (ACCOMMODATION_CLEANUP=1) can find
// exactly what the suite made and nothing else.
//
// One trip per feature: each frontend scenario books its own trip, so a
// failure points at one feature, and a trip can be opened by hand to see the
// exact setup the test used.

const PREFIX = "QA ";

// Adult price on every fixture trip's package. The expected totals below are
// derived from it, so change it in one place.
const ADULT_PRICE = 1000;

// Global room types (WP Travel Engine › Settings › Extensions › Accommodation).
// `key` is how scenarios refer to a room; the rest is sent to the API.
const ROOMS = {
  deluxe: { room_type: "QA Deluxe Room", no_of_guests: 2, short_description: "QA twin share room" },
  shared: { room_type: "QA Shared Dorm", no_of_guests: 2, short_description: "QA dorm bed", allow_shared_booking: true },
  included: { room_type: "QA Included Teahouse", no_of_guests: 2, short_description: "QA teahouse lodging" },
  family: { room_type: "QA Family Suite", no_of_guests: 4, short_description: "QA suite for four" },
  closed: { room_type: "QA Closed Room", no_of_guests: 2, short_description: "QA disabled on the trip" },
};

// Global room upgrades.
const UPGRADES = {
  lakeView: { name: "QA Lake View", hotel_name: "QA Hotel Barahi" },
};

// Global settings each scenario needs on top of `enable: true`. Applied
// before the scenario runs — pricing format, sharing and mandatory-for are
// site-wide, which is why the suite runs serially.
const BASE_GLOBAL = {
  enable: true,
  pricing_format: "per_room",
  allow_shared_room_bookings: false,
  shared_occupancy_notice: "",
  mandatory_for: [],
};

// The per-feature trips. `rooms`/`upgrades` are the trip-level config
// (WP Travel Engine › Trip › Accommodation tab).
const TRIPS = {
  perRoom: {
    title: "QA Accommodation - Per Room Pricing",
    feature: "Room price charged per room; total and checkout include it.",
    global: { pricing_format: "per_room" },
    rooms: [{ room: "deluxe", price: 150 }],
  },
  perTraveler: {
    title: "QA Accommodation - Per Traveler Pricing",
    feature: "Travellers split the room price (room price ÷ guests).",
    global: { pricing_format: "per_traveler" },
    rooms: [{ room: "deluxe", price: 40 }],
  },
  upgrades: {
    title: "QA Accommodation - Room Upgrades",
    feature: "Upgrade listed under its room and adds its price.",
    global: { pricing_format: "per_room" },
    rooms: [{ room: "deluxe", price: 150 }],
    upgrades: [{ upgrade: "lakeView", price: 50, rooms: ["deluxe"] }],
  },
  included: {
    title: "QA Accommodation - Included in Package",
    feature: 'Room shows "Included in Package" and adds nothing.',
    global: { pricing_format: "per_room" },
    rooms: [{ room: "included", price: 0, included_in_package: true }],
  },
  shared: {
    title: "QA Accommodation - Shared Rooms",
    feature: "One traveller books a single spot; Shared tag and notice.",
    global: {
      pricing_format: "per_traveler",
      allow_shared_room_bookings: true,
      shared_occupancy_notice: "QA notice: you will share this room with another traveler.",
    },
    rooms: [{ room: "shared", price: 35, allow_shared_booking: true }],
  },
  mandatory: {
    title: "QA Accommodation - Mandatory For Adults",
    feature: "Checkout blocked until every adult has a room.",
    global: { pricing_format: "per_traveler", mandatory_for: ["Adult"] },
    rooms: [{ room: "deluxe", price: 40 }],
  },
  visibility: {
    title: "QA Accommodation - Room Visibility",
    feature: "Disabled rooms hidden; rooms need enough travellers to fill them.",
    global: { pricing_format: "per_room" },
    rooms: [
      { room: "deluxe", price: 150 },
      { room: "family", price: 300 },
      { room: "closed", price: 99, enable: false },
    ],
  },
  adminEditor: {
    // Configured through the trip editor UI rather than the API.
    title: "QA Accommodation - Trip Editor",
    feature: "Trip-level room price, details, included flag and upgrade set in the editor.",
    global: { pricing_format: "per_room" },
    rooms: [],
  },
};

// Section 5 of the suite: a real Stripe (test-mode) payment on every trip,
// then the booking is read back through /wptravelengine/v2/bookings/{id}.
//   adults      travellers booked (Adult category)
//   select      rooms picked: [room key, option label]
//   upgrades    upgrades picked: [room key, upgrade key, option label]
//   trip        trip-level accommodation forced before booking (only for the
//               editor trip, whose rooms section 3 sets through the UI)
//   expect      accommodation lines on the booking ({ label, total }) and the
//               booking total. Lines are checked on label + line total, so
//               per-traveler splits don't depend on how quantity is counted.
const CHECKOUTS = {
  perRoom: {
    adults: 2,
    select: [["deluxe", "1 Room (2 people)"]],
    expect: { lines: [{ label: "QA Deluxe Room", total: 150 }], total: 2 * ADULT_PRICE + 150 },
  },
  perTraveler: {
    adults: 2,
    select: [["deluxe", "2 Travellers"]],
    expect: { lines: [{ label: "QA Deluxe Room", total: 40 }], total: 2 * ADULT_PRICE + 40 },
  },
  upgrades: {
    adults: 2,
    select: [["deluxe", "1 Room (2 people)"]],
    upgrades: [["deluxe", "lakeView", "1 Room"]],
    expect: {
      lines: [
        { label: "QA Deluxe Room", total: 150 },
        { label: "QA Lake View", total: 50 },
      ],
      total: 2 * ADULT_PRICE + 200,
    },
  },
  included: {
    adults: 2,
    select: [["included", "1 Room (2 people)"]],
    expect: { lines: [{ label: "QA Included Teahouse", total: 0 }], total: 2 * ADULT_PRICE },
  },
  shared: {
    adults: 1,
    select: [["shared", "1 Traveller"]],
    expect: { lines: [{ label: "QA Shared Dorm", total: 17.5 }], total: ADULT_PRICE + 17.5 },
  },
  mandatory: {
    adults: 2,
    select: [["deluxe", "2 Travellers"]],
    expect: { lines: [{ label: "QA Deluxe Room", total: 40 }], total: 2 * ADULT_PRICE + 40 },
  },
  visibility: {
    adults: 4,
    select: [["family", "1 Room (4 people)"]],
    expect: { lines: [{ label: "QA Family Suite", total: 300 }], total: 4 * ADULT_PRICE + 300 },
  },
  adminEditor: {
    adults: 2,
    trip: { rooms: [{ room: "deluxe", price: 175 }] },
    select: [["deluxe", "1 Room (2 people)"]],
    expect: { lines: [{ label: "QA Deluxe Room", total: 175 }], total: 2 * ADULT_PRICE + 175 },
  },
};

// Stripe's documented always-approve Visa (no 3-D Secure).
const STRIPE_TEST_CARD = { number: "4242424242424242", expiry: "12 / 34", cvc: "123", postalCode: "44600" };

module.exports = { PREFIX, ADULT_PRICE, ROOMS, UPGRADES, BASE_GLOBAL, TRIPS, CHECKOUTS, STRIPE_TEST_CARD };
