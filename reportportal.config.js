// ReportPortal agent configuration.
//
// Consumed by playwright.config.js and wired in as an extra reporter alongside
// the terminal `list` reporter — it does not replace it. The ReportPortal
// reporter is only activated when RP_API_KEY is set (see playwright.config.js),
// so a normal run with no key behaves exactly as before.
//
// Every value comes from the environment (.env), so no endpoint, project name
// or API key is hardcoded here. See env.example for the variables.
require("dotenv").config({ quiet: true });

// The JS agent talks to the v2 REST API, so the endpoint must end in /api/v2.
// .env can hold either the bare host (http://localhost:8080, as in the example)
// or a full .../api/v2 URL; normalise to the full form either way.
function normaliseEndpoint(raw) {
  const base = (raw || "http://localhost:8080").replace(/\/+$/, "");
  return /\/api\/v[12]$/.test(base) ? base : `${base}/api/v2`;
}

// Launch name shown in the ReportPortal UI. This is ReportPortal's equivalent
// of the per-run neetoPlayDash "title" — it's what distinguishes one run from
// another and groups a gateway's runs into their own history/trend line.
//
// Priority:
//   1. RP_LAUNCH_TITLE — full override for one run, e.g.
//        RP_LAUNCH_TITLE="Omise card checkout" npx playwright test
//   2. RP_LAUNCH (base) + the gateway (and platform) from the same env vars the
//      tests already read, so a normal run reads e.g.
//        "PayLexer Playwright Automation — Safepay (woocommerce)"
//      scripts/runBothPlatforms.js sets PAYMENT_GATEWAY/CURRENCY_PLATFORM per
//      child process, so each platform's launch is named for its own platform.
function buildLaunchName() {
  if (process.env.RP_LAUNCH_TITLE) return process.env.RP_LAUNCH_TITLE;

  const base = process.env.RP_LAUNCH || "PayLexer Playwright Automation";
  const gateway = process.env.PAYMENT_GATEWAY;
  const platform = process.env.CURRENCY_PLATFORM;

  if (!gateway) return base;
  return platform ? `${base} — ${gateway} (${platform})` : `${base} — ${gateway}`;
}

const rpConfig = {
  apiKey: process.env.RP_API_KEY,
  endpoint: normaliseEndpoint(process.env.RP_ENDPOINT),
  project: process.env.RP_PROJECT || "paylexer-playwright",
  launch: buildLaunchName(),

  // Launch attributes and description — searchable metadata on the launch in
  // the ReportPortal UI, mirroring the run context the launch is tagged with.
  attributes: [
    { key: "gateway", value: process.env.PAYMENT_GATEWAY || "unset" },
    { key: "platform", value: process.env.CURRENCY_PLATFORM || "unset" },
    { key: "headless", value: process.env.PW_HEADLESS === "1" ? "yes" : "no" },
    { key: "framework", value: "playwright" },
  ],
  description: process.env.PAYMENT_GATEWAY
    ? `PayLexer automation for **${process.env.PAYMENT_GATEWAY}**${process.env.CURRENCY_PLATFORM ? ` on ${process.env.CURRENCY_PLATFORM}` : ""} — login → configure gateway → verify connection.`
    : "PayLexer payment-gateway automation — login → configure gateway → verify connection.",

  // Attach Playwright artifacts automatically. Screenshots captured by the
  // `screenshot: "only-on-failure"` setting in playwright.config.js arrive as
  // testInfo attachments and are uploaded without any per-test code; video and
  // trace upload only if those are enabled in the config (both off by default).
  uploadVideo: true,
  uploadTrace: true,

  // Surface expect/step tree as ReportPortal log entries.
  includeTestSteps: true,

  // Attach the last error to the test's description so a failure is readable
  // from the item view without opening the full log.
  extendTestDescriptionWithLastError: true,
};

module.exports = rpConfig;
