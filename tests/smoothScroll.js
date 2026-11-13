// tests/smoothScroll.js
//
// Smooth scrolling, so a watched run visibly scrolls down to whatever it is
// about to click or fill instead of jumping there. Playwright already scrolls
// each target into view before acting on it; this just makes that scroll
// animate.
//
// PW_SMOOTH_SCROLL=0 restores instant scrolling — the switch to reach for if a
// click ever starts failing with the element "outside of the viewport"
// mid-scroll.

/**
 * Registered on the page's context, so it applies to every page the run opens
 * — the WordPress tab, the PayLexer tab, gateway popups — and survives every
 * navigation.
 */
async function installSmoothScroll(page) {
  if (process.env.PW_SMOOTH_SCROLL === "0") return;

  await page.context().addInitScript(() => {
    const apply = () => {
      document.documentElement.style.scrollBehavior = "smooth";
    };

    if (document.documentElement) {
      apply();
    } else {
      document.addEventListener("DOMContentLoaded", apply, { once: true });
    }
  });
}

/**
 * Smooth-scrolls an element to the middle of the screen and waits for the
 * scroll to land, so a watched run SHOWS where it found something. Playwright
 * only scrolls for actions (click/fill/check); a read like waitFor(),
 * isChecked() or textContent() never moves the page, so a gateway or product
 * found far down a list was found invisibly. Call it right after finding one.
 *
 * Best effort: purely visual, so a failure here never fails the run.
 */
async function revealElement(locator) {
  try {
    await locator.evaluate((el) =>
      el.scrollIntoView({ behavior: "smooth", block: "center" }),
    );
    // Long enough for a smooth scroll down a long settings page to land.
    await locator.page().waitForTimeout(800);
  } catch (e) {
    // Purely visual — carry on.
  }
}

module.exports = { installSmoothScroll, revealElement };
