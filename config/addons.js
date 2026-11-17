// config/addons.js
//
// Every WP Travel Engine add-on the QA runner (npm run ui) knows about.
// The list mirrors WP Travel Engine › Extensions on the test site.
//
// An add-on with a `spec` is automated: the runner lists its tests, runs them
// and keeps its results. Without a `spec` it still shows in the index, as
// coverage still to write.
//
// To automate another add-on:
//   1. write tests/<slug>.spec.js — group tests with test.describe("1. Area")…
//      so the runner can show them as feature groups;
//   2. set `spec` (and optionally `fixtures`) on its entry below.
//
// `fixtures` is a JSON file the spec writes listing what it built on the site
// (trips, rooms…) as { updatedAt, site, items: [{ title, note, tag, link, editUrl, id }] }.

const ADDONS = [
  {
    slug: "wptravelengine-accommodation",
    name: "Accommodation",
    group: "Booking & pricing",
    description: "Offer lodging with your tours: room types, upgrades, per-room or per-traveller pricing.",
    spec: "tests/accommodation.spec.js",
    fixtures: "data/addons/wptravelengine-accommodation/fixtures.json",
    // Bookings the Stripe checkout section paid for, written when it finishes.
    bookings: "data/addons/wptravelengine-accommodation/bookings.json",
    // Source repo the QA Report tab reads and re-scans.
    repo: "https://github.com/Codewing-Solutions/wptravelengine-accommodation.git",
    // Where the "File issue" button files this add-on's findings (each add-on
    // has its own repo). Falls back to the global target in data/doctor/github.json.
    bugRepo: "Codewing-Solutions/wptravelengine-accommodation",
    report: "data/addons/wptravelengine-accommodation/qa-report.json",
    // Env var the spec reads to delete what it built when the run ends.
    cleanupEnv: "ACCOMMODATION_CLEANUP",
  },

  // ── Booking & pricing ──────────────────────────────────────────────────
  { slug: "wp-travel-engine-trip-fixed-starting-dates", name: "Trip Fixed Starting Dates", group: "Booking & pricing", description: "Fixed departure dates with seats left per date." },
  { slug: "wp-travel-engine-group-discount", name: "Group Discount", group: "Booking & pricing", description: "Discounts for larger groups." },
  { slug: "wte-extra-services", name: "Extra Services", group: "Booking & pricing", description: "Airport pick-up, hotel drop-off and other paid extras." },
  { slug: "wptravelengine-resource-management", name: "Resource Management", group: "Booking & pricing", description: "Capacity limits for accommodation and extra services." },
  { slug: "wptravelengine-price-on-request", name: "Price On Request", group: "Booking & pricing", description: "Trips without a fixed price that collect enquiries." },
  { slug: "wptravelengine-private-trips", name: "Private Trips", group: "Booking & pricing", description: "Hidden trips reachable only by a private link." },
  { slug: "wptravelengine-waitlist", name: "Waitlist", group: "Booking & pricing", description: "Let travellers join a waitlist for full departures." },
  { slug: "wptravelengine-conditional-price", name: "Conditional Price", group: "Booking & pricing", description: "Different prices for specific dates." },
  {
    slug: "wptravelengine-activity-tour",
    name: "Activity Tour",
    group: "Booking & pricing",
    description: "Single-day and activity-based tours with time slots.",
    spec: "tests/activityTour.spec.js",
    fixtures: "data/addons/wptravelengine-activity-tour/fixtures.json",
    bookings: "data/addons/wptravelengine-activity-tour/bookings.json",
    // Source repo (QA Report tab reads/scans it) and where findings file to.
    repo: "https://github.com/Codewing-Solutions/wptravelengine-activity-tour-booking.git",
    bugRepo: "Codewing-Solutions/wptravelengine-activity-tour-booking",
    report: "data/addons/wptravelengine-activity-tour/qa-report.json",
    cleanupEnv: "ACTIVITY_TOUR_CLEANUP",
  },
  { slug: "wptravelengine-pickup-points", name: "Pickup Points", group: "Booking & pricing", description: "Let travellers choose where they are picked up." },
  { slug: "wptravelengine-booking-fee", name: "Booking Fee", group: "Booking & pricing", description: "Add a booking fee at checkout." },
  { slug: "wptravelengine-custom-booking-link", name: "Custom Booking Link", group: "Booking & pricing", description: "Replace the booking button with any URL." },
  { slug: "wptravelengine-travel-insurance", name: "Travel Insurance", group: "Booking & pricing", description: "Offer travel insurance during booking." },

  // ── Payments ───────────────────────────────────────────────────────────
  { slug: "wptravelengine-partial-payment", name: "Partial Payment", group: "Payments", description: "Take a deposit now, the rest later." },
  { slug: "wptravelengine-installment-payments", name: "Installment Payments", group: "Payments", description: "Split trip costs into scheduled payments." },
  { slug: "wte-woocommerce-payments", name: "WooCommerce Payments", group: "Payments", description: "Pay for trips through WooCommerce gateways." },
  { slug: "wte-stripe-payment-gateway", name: "Stripe Payment Gateway", group: "Payments", description: "Card payments through Stripe." },
  { slug: "wte-paypal-express", name: "PayPal Express Checkout", group: "Payments", description: "PayPal Express Checkout." },
  { slug: "wte-razorpay", name: "Razorpay Payment Gateway", group: "Payments", description: "Razorpay payments." },
  { slug: "wte-payu-money", name: "PayU Money Payment Gateway", group: "Payments", description: "PayU Money payments." },
  { slug: "wte-payu-biz", name: "PayU Biz Payment Gateway", group: "Payments", description: "PayU Biz payments." },
  { slug: "wte-midtrans", name: "Midtrans Payment Gateway", group: "Payments", description: "Midtrans payments." },
  { slug: "wte-payhere", name: "PayHere Payment Gateway", group: "Payments", description: "PayHere payments." },
  { slug: "wte-himalayan-bank", name: "Himalayan Bank Payment Gateway", group: "Payments", description: "Himalayan Bank payments." },
  { slug: "wte-payfast", name: "PayFast Payment Gateway", group: "Payments", description: "PayFast payments." },
  { slug: "wte-authorize-net", name: "Authorize.net Payment Gateway", group: "Payments", description: "Authorize.net payments." },

  // ── Trip content ───────────────────────────────────────────────────────
  { slug: "wte-advanced-itinerary", name: "Advanced Itinerary Builder", group: "Trip content", description: "Rich day-by-day itinerary details." },
  { slug: "wptravelengine-trip-reviews", name: "Trip Reviews", group: "Trip content", description: "Collect and show traveller reviews." },
  { slug: "wptravelengine-file-downloads", name: "File Downloads", group: "Trip content", description: "Brochures, maps and guides to download." },
  { slug: "wptravelengine-itinerary-downloader", name: "Itinerary Downloader", group: "Trip content", description: "Download a trip's itinerary as a PDF." },
  { slug: "wptravelengine-weather-forecast", name: "Trip Weather Forecast", group: "Trip content", description: "Weather forecast on the trip page." },
  { slug: "wptravelengine-fsd-countdown", name: "Fixed Starting Dates Countdown", group: "Trip content", description: "Countdown to the next departure." },
  { slug: "wptravelengine-legal-documents", name: "Legal Documents", group: "Trip content", description: "Documents travellers accept when booking." },
  { slug: "wptravelengine-form-editor", name: "Form Editor", group: "Trip content", description: "Customise booking, traveller and enquiry forms." },
  { slug: "wptravelengine-trips-embedder", name: "Trips Embedder", group: "Trip content", description: "Embed trips on other websites." },

  // ── Marketing & conversion ─────────────────────────────────────────────
  { slug: "wptravelengine-social-proof", name: "Social Proof", group: "Marketing & conversion", description: "Recent-booking notifications." },
  { slug: "wptravelengine-currency-converter", name: "Currency Converter", group: "Marketing & conversion", description: "Show prices in the traveller's currency." },
  { slug: "wptravelengine-ga4", name: "GA4 eCommerce Tracking", group: "Marketing & conversion", description: "Send booking data to Google Analytics 4." },
  { slug: "wptravelengine-advanced-analytics", name: "Advanced Analytics", group: "Marketing & conversion", description: "Deeper booking and revenue reports." },
  { slug: "wptravelengine-user-history", name: "User History", group: "Marketing & conversion", description: "Track what visitors viewed before booking." },

  // ── Emails ─────────────────────────────────────────────────────────────
  { slug: "wptravelengine-email-automator", name: "Advanced Email Automator", group: "Emails", description: "Scheduled emails before and after trips." },
  { slug: "wptravelengine-per-trip-emails", name: "Per Trip Emails", group: "Emails", description: "Different emails for each trip." },
  { slug: "wptravelengine-email-customizer", name: "Email Customizer", group: "Emails", description: "Design the booking emails." },

  // ── Integrations ───────────────────────────────────────────────────────
  { slug: "wptravelengine-webhooks", name: "Webhooks and API", group: "Integrations", description: "Connect bookings to other tools." },
  { slug: "wptravelengine-zapier", name: "Zapier", group: "Integrations", description: "Send bookings to Zapier." },
  { slug: "wptravelengine-slicewp", name: "SliceWP Integration", group: "Integrations", description: "Affiliate commissions with SliceWP." },
  { slug: "wptravelengine-wetravel", name: "WeTravel Integration", group: "Integrations", description: "Sync with WeTravel." },
];

const GROUP_ORDER = ["Booking & pricing", "Payments", "Trip content", "Marketing & conversion", "Emails", "Integrations"];

module.exports = { ADDONS, GROUP_ORDER };
