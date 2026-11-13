// tests/liveView.js
//
// A `test` that looks exactly like Playwright's, plus:
//   - a JPEG of whatever the browser is showing, rewritten to
//     <output dir>/live.jpg a few times a second (below), and
//   - the network calls that failed, attached to a failed test
//     (the networkWatch fixture; see tests/networkWatch.js), and
//   - the browser's JavaScript errors, attached the same way
//     (the consoleWatch fixture; see tests/consoleWatch.js).
//
// scripts/uiServer.js serves that file and the run card polls it, which is the
// "mini browser" in the UI. It is the only way to watch a HEADLESS run — and
// headless is the mode a sweep has to use, because a headed Firefox that loses
// OS focus makes every click hang until the action timeout (see the PW_HEADLESS
// note in playwright.config.js).
//
// ── Off unless asked for ─────────────────────────────────────────────────────
// The whole fixture is inert unless PW_LIVE_VIEW=1, which only the UI server
// sets. `npm run test:both` and `npm run test:all` therefore behave exactly as
// before — no screenshot traffic on a 120-run sweep nobody is watching.
//
// ── Why it follows the newest page ───────────────────────────────────────────
// The flow does not stay on one tab: checkout.submitPayment() hands back the
// page the card form is on, which for several gateways is a popup the hosted
// checkout opened. Capturing the test's original `page` would show the WordPress
// checkout frozen behind it for the whole payment step — exactly the part you
// opened the live view to watch. So each frame captures the most recently opened
// page in the context, which is the one being driven.

const fs = require("fs");
const path = require("path");

const base = require("@playwright/test");
const { installSmoothScroll } = require("./smoothScroll");
const { watchNetwork } = require("./networkWatch");
const { watchConsole } = require("./consoleWatch");

// ~6 frames/second. A viewport JPEG takes 40-200ms in Firefox, so this is
// about as often as one can be taken without frames queueing; the server
// pushes each to the viewer as it lands (streamLiveView() in uiServer.js).
const FRAME_INTERVAL_MS = 150;

// A frame that cannot be taken within this is one where the page is
// mid-navigation; skip it and try again. It was 5s, which froze the view for
// up to five seconds on every page load.
const FRAME_TIMEOUT_MS = 1500;

/**
 * The page a frame should show: the newest open page in the context.
 *
 * Falls back to the test's own page when the newest one has just closed —
 * between a popup closing and the flow returning to the parent there is a
 * moment where the last entry is not usable.
 */
function pageToCapture(page) {
  const open = page.context().pages().filter((candidate) => !candidate.isClosed());
  return open.length ? open[open.length - 1] : page;
}

const test = base.test.extend({
  // Every failed network call while the test runs (tests/networkWatch.js),
  // attached to a FAILED test as "failed-requests" — which API broke. The
  // dashboard reporter reads the attachment; a passing test attaches nothing.
  // Auto-used, so it wraps every test without the spec asking for it.
  networkWatch: [
    async ({ context }, use, testInfo) => {
      const watch = watchNetwork(context);
      await use(watch);
      const failed = await watch.stop().catch(() => []);
      if (testInfo.status !== testInfo.expectedStatus && failed.length) {
        await testInfo
          .attach("failed-requests", { body: JSON.stringify(failed), contentType: "application/json" })
          .catch(() => {});
      }
    },
    { auto: true },
  ],

  // The JavaScript errors the browser reported (tests/consoleWatch.js),
  // attached to a FAILED test as "console-errors" — the page's own code
  // breaking, which leaves every network call green. Same rules as above.
  consoleWatch: [
    async ({ context }, use, testInfo) => {
      const watch = watchConsole(context);
      await use(watch);
      const errors = watch.stop();
      if (testInfo.status !== testInfo.expectedStatus && errors.length) {
        await testInfo
          .attach("console-errors", { body: JSON.stringify(errors), contentType: "application/json" })
          .catch(() => {});
      }
    },
    { auto: true },
  ],

  page: async ({ page }, use, testInfo) => {
    // Smooth scrolling, so the run visibly scrolls to what it acts on. Off
    // with PW_SMOOTH_SCROLL=0 (see tests/smoothScroll.js).
    await installSmoothScroll(page);

    if (process.env.PW_LIVE_VIEW !== "1") {
      await use(page);
      return;
    }

    // testInfo.outputDir is this test's own folder INSIDE the --output root the
    // UI server passed (test-results/<gateway>-<platform>). The frame goes in
    // the root itself, because that is the path the server knows a run by — it
    // has no way to guess the per-test folder, whose name is a hash of the test
    // title.
    const runDir = path.dirname(testInfo.outputDir);
    const target = path.join(runDir, "live.jpg");
    // Written beside it and renamed, since rename is atomic: writing straight to
    // live.jpg lets the server serve a half-written file, which the browser
    // renders as a torn or broken image.
    const staging = path.join(runDir, ".live.jpg.tmp");

    fs.mkdirSync(runDir, { recursive: true });

    let stopped = false;
    // A frame can take longer than the interval while the page is busy. Without
    // this the ticks would stack up into a queue of screenshots that only grows.
    let capturing = false;

    const captureFrame = async () => {
      if (stopped || capturing) return;
      capturing = true;

      try {
        const buffer = await pageToCapture(page).screenshot({
          type: "jpeg",
          quality: 50,
          timeout: FRAME_TIMEOUT_MS,
          // Viewport only. A full-page capture of a WordPress checkout is a tall
          // strip that is unreadable in a card, and it costs far more to take.
          fullPage: false,
          // One image pixel per CSS pixel. "device" doubles both sides on a
          // high-DPI screen: four times the pixels to encode, write and send,
          // and about four times slower to take.
          scale: "css",
          // Playwright hides the caret for stable comparisons; here the point is
          // to watch typing happen, so it stays.
          caret: "initial",
        });

        if (stopped) return;

        fs.writeFileSync(staging, buffer);
        fs.renameSync(staging, target);
      } catch {
        // Every failure here is expected and none of them is the test's problem:
        // the page is navigating, the popup closed mid-frame, the context is
        // tearing down. The next tick either succeeds or the run is over.
      } finally {
        capturing = false;
      }
    };

    const timer = setInterval(captureFrame, FRAME_INTERVAL_MS);
    // So a stuck frame can never hold the Node process open past the test.
    timer.unref();

    try {
      await use(page);
    } finally {
      stopped = true;
      clearInterval(timer);

      // The live feed is not an artifact of the run — leaving it behind would
      // put a stray "screenshot" in the card next to the real failure shot, and
      // it would be whatever frame happened to be last rather than the failure.
      // scripts/uiServer.js also filters the name, for the case where this
      // teardown never runs because the run was killed from the UI.
      for (const file of [staging, target]) {
        try {
          fs.rmSync(file, { force: true });
        } catch {
          // Best effort — a leftover frame is cosmetic, and failing a run over
          // one would be the worse outcome.
        }
      }
    }
  },
});

module.exports = { test, expect: base.expect };
