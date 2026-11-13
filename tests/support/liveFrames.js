// tests/support/liveFrames.js
//
// The runner UI's live view. While PW_LIVE_FILE is set, this rewrites a JPEG of
// what the browser is showing to that path a few times a second, plus a small
// JSON sidecar with the page URL and title. scripts/addonsUi.js serves both.
//
// Off unless PW_LIVE_FILE is set, so CLI runs pay nothing for it.
//
// It follows the newest page in the context: a flow that opens a popup (a
// gateway's hosted checkout, a "View trip" tab) shows that page, which is the
// one being driven.

const fs = require("fs");
const path = require("path");

const FRAME_MS = 350;

function startLiveFrames(context) {
  const file = process.env.PW_LIVE_FILE;
  if (!file) return () => {};

  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  const meta = file.replace(/\.jpe?g$/i, "") + ".json";
  let stopped = false;
  let busy = false;

  const tick = async () => {
    if (stopped || busy) return;
    const pages = context.pages().filter((p) => !p.isClosed());
    const page = pages[pages.length - 1];
    if (!page) return;
    busy = true;
    try {
      const buffer = await page.screenshot({ type: "jpeg", quality: 55, timeout: 2000, animations: "allow", caret: "initial" });
      // Write-then-rename so the server never serves half a JPEG.
      fs.writeFileSync(tmp, buffer);
      fs.renameSync(tmp, file);
      fs.writeFileSync(meta, JSON.stringify({ url: page.url(), title: await page.title().catch(() => ""), at: Date.now() }));
    } catch {
      // Navigation in progress, page closing… the next frame will do.
    } finally {
      busy = false;
    }
  };

  const timer = setInterval(tick, FRAME_MS);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

module.exports = { startLiveFrames };
