// config/currencyPlatforms.js
//
// The WP Travel Engine currency screen and trip archive, driven by
// pages/CurrencySettingsPage.js. Ported from paylexer-playwright, which keeps
// one entry per platform (WooCommerce, EDD, FluentCart, Tutor LMS too); this
// project automates WP Travel Engine only, so only `wte` is here.
//
// `navigate(page)` — land on WPTE Settings > Currency > General.
// `getCurrentCurrencyText` / `selectCurrency` — WPTE's custom dropdown.
// `saveButtonName` — accessible name of the save button (getByRole match).
// `successText` — regex matched against the post-save confirmation text.
// `openProduct(page, preferredName, { strict })` — open a priced trip.

// Scrolls a found element into view so a watched run shows it.
const { revealElement } = require("../tests/smoothScroll");
function getCurrencyDisplayName(currencyCode) {
  try {
    return new Intl.DisplayNames(["en"], { type: "currency" }).of(currencyCode);
  } catch (err) {
    throw new Error(
      `Could not resolve a display name for currency code "${currencyCode}" via Intl.DisplayNames: ${err.message}`,
    );
  }
}

/**
 * The site under test, trailing slash stripped. Every platform's
 * openProduct() builds its archive URL from this, so the missing-env error
 * reads the same wherever it's hit.
 */
function frontendUrl() {
  const url = process.env.FRONTEND_URL;

  if (!url) {
    throw new Error(
      "FRONTEND_URL is not set. Add it to your .env file, e.g. FRONTEND_URL=https://your-test-site.example.com",
    );
  }

  return url.replace(/\/$/, "");
}

/** Escapes regex metacharacters so product titles are matched literally. */
function escapeForRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

module.exports = {
  wte: {
    label: "WP Travel Engine",
    navigate: async (page) => {
      // Currency, Payments and the rest are tabs on ONE settings screen, so
      // the WP Travel Engine > Settings hop is only worth making when we're
      // not on that screen already. A caller that has been working on another
      // tab (e.g. Payments > General) just switches tabs below instead of
      // re-navigating to Settings a second time. The Currency tab existing is
      // the tell: it only renders on the settings screen.
      const currencyTab = page.locator('span[title="Currency"].wpte-menu-link');

      let alreadyOnSettings = true;

      try {
        await currencyTab.waitFor({ state: "visible", timeout: 5000 });
      } catch (e) {
        alreadyOnSettings = false;
      }

      if (!alreadyOnSettings) {
        const wteMenu = page
          .locator("div.wp-menu-name")
          .filter({ hasText: "WP Travel Engine" });
        await wteMenu.waitFor({ state: "visible", timeout: 30000 });
        await wteMenu.click();

        const settingsLink = page.locator(
          'a[href="edit.php?post_type=booking&page=class-wp-travel-engine-admin.php"]',
        );
        await settingsLink.waitFor({ state: "visible", timeout: 30000 });
        await settingsLink.click();
      } else {
        console.log(
          "ℓ Already on the WP Travel Engine settings screen — switching tabs instead of re-opening Settings",
        );
      }

      // currencyTab is matched by title text rather than position —
      // position-based selection (nth-index across all sidebar items) proved
      // unreliable, likely due to duplicate/hidden elements in the DOM not
      // matching the visual order.
      await currencyTab.waitFor({ state: "visible", timeout: 30000 });
      await currencyTab.click();

      // The nested "General" sub-item under Currency is an <a> tag
      // (href ends in #currency-general), distinct from the UNRELATED
      // top-level "General" accordion item, which is a <span>. Matching by
      // tag + title together removes the ambiguity that caused wrong clicks.
      const currencyGeneralLink = page.locator(
        'a[title="General"].wpte-menu-link[href*="currency-general"]',
      );
      await currencyGeneralLink.waitFor({ state: "visible", timeout: 30000 });
      await currencyGeneralLink.click();
    },

    // A plugin update replaced the native <select name="currency_code">
    // with a custom react-window virtualized dropdown widget
    // (cw__custom-select) — no native <select> exists in the DOM anymore,
    // so the old currencySelector/inputValue()/selectOption() approach no
    // longer applies. These two functions replace that entirely.

    /**
     * Reads the currently-displayed currency name from the closed dropdown
     * trigger's visible text.
     */
    getCurrentCurrencyText: async (page) => {
      // .first() — there's a second field ("Currency Symbol") on the same
      // page using the identical class structure. Assuming DOM order puts
      // the actual Currency dropdown first (matches the form's field
      // order: Currency, then Currency Symbol) — flag if this picks the
      // wrong one.
      const triggerText = page
        .locator(
          ".cw__custom-select__input-wrapper .cw__custom-select__input-value .text",
        )
        .first();
      await triggerText.waitFor({ state: "visible", timeout: 30000 });
      return (await triggerText.textContent())?.trim();
    },

    /**
     * Opens the custom dropdown and selects the option matching the given
     * ISO currency code, via its mapped display name. The dropdown has a
     * real search input (type="search", placeholder="Search...") — filling
     * it directly filters the virtualized list, which is far more reliable
     * than blind keyboard type-ahead or scroll-based guessing.
     */
    selectCurrency: async (page, currencyCode) => {
      console.log(`Opening currency dropdown to select "${currencyCode}"...`);

      const trigger = page.locator(".cw__custom-select__input-wrapper").first();
      await trigger.click();

      const searchInput = page.locator(
        'input[type="search"][placeholder="Search..."]',
      );
      await searchInput.fill(currencyCode);

      const option = page.locator(".cw__select-option").first();
      await option.click();

      console.log(`✓ Selected currency for "${currencyCode}"`);
    },

    saveButtonName: "Save Settings",
    successText: /Settings updated successfully/i, // confirmed real WTE success text

    /**
     * WP Travel Engine's trip archive. Moved here from CurrencySettingsPage,
     * which used to run this block for EVERY platform — the selectors below
     * (itemprop="url", .price-holder, itemListElement) are WTE markup, so a
     * WooCommerce run was going looking for trip listings on a shop.
     *
     * @param {string} [preferredName] - open this trip instead of the first
     *   priced one. Comes from a gateway's `trip` in gatewayConfigs.js.
     * @returns {Promise<{price: number|null}>}
     */
    // `strict`: a missing named trip throws instead of falling back to the
    // first priced one, so config/productChoice.js can try its next product.
    openProduct: async (page, preferredName, { strict = false } = {}) => {
      // Appending "/trip" reaches the trip listing archive, so this is a
      // single hop: no intermediate landing on the homepage, no other site
      // visited. Works regardless of which specific trips exist.
      const tripArchiveUrl = `${frontendUrl()}/trip`;

      console.log(`Navigating directly to trip archive: ${tripArchiveUrl}`);
      await page.goto(tripArchiveUrl);
      await page
        .waitForLoadState("networkidle", { timeout: 15000 })
        .catch(() => {});
      console.log("✓ Trip archive page opened");

      // ---- Click into a PRICED trip listing on the archive page ----
      // The archive lists trips in publish order, and the first card is often
      // a free / price-less trip that can't exercise a real payment. So don't
      // just take the first link — scan the cards and pick the first trip
      // whose listing actually shows a valid (> 0) price.
      console.log("Scanning trip listings for one with a price...");

      const tripLinks = page.locator('a[itemprop="url"][href*="/trip/"]');

      const anyTripExists = await tripLinks
        .first()
        .isVisible({ timeout: 15000 })
        .catch(() => false);

      if (!anyTripExists) {
        console.log(
          `⚠ No trip listing found on ${tripArchiveUrl} — this site likely has no trips published yet. ` +
            `Log into its WP admin (WP Travel Engine > Trips > Add New) and publish at least one trip to enable checkout testing. ` +
            `Skipping trip click.`,
        );
        return { price: null };
      }

      const tripCount = await tripLinks.count();
      console.log(
        `Found ${tripCount} trip listing(s) — looking for the first one with a price...`,
      );

      // Reads a card's price, preferring the discounted/current price
      // (.actual-price) and falling back to the original (.striked-price).
      // A price-less trip omits the whole .price-holder block, so neither
      // exists — count() first means such a card is skipped instantly
      // instead of waiting on a textContent timeout. Returns a positive
      // number, or null.
      const readCardPrice = async (tripCard) => {
        const actualEl = tripCard
          .locator(".price-holder .actual-price")
          .first();

        let priceText = null;
        if (await actualEl.count()) {
          priceText = await actualEl.textContent().catch(() => null);
        } else {
          const strikedEl = tripCard
            .locator(".price-holder .striked-price")
            .first();
          if (await strikedEl.count()) {
            priceText = await strikedEl.textContent().catch(() => null);
          }
        }

        if (!priceText) return null;
        const parsed = parseFloat(priceText.replace(/[^0-9.]/g, ""));
        return !Number.isNaN(parsed) && parsed > 0 ? parsed : null;
      };

      let tripPrice = null;
      let selectedTripLink = null;

      // ---- A named trip wins over the priced-trip scan ----
      // Some gateways only settle against one particular trip (its price sits
      // inside the gateway's accepted range, or it's the only one priced in
      // the gateway's currency), so gatewayConfigs.js can name it via `trip`.
      //
      // Matched on the listing link's own text, case-insensitively and as a
      // substring: the visible title often carries extra words around the trip
      // name ("Chandol Base Camp Trek"), and the href slug isn't reliable —
      // WordPress derives it from the title at publish time and it stays put
      // through later renames.
      if (preferredName) {
        console.log(`Looking for the "${preferredName}" trip listing...`);

        const namedLink = tripLinks
          .filter({ hasText: new RegExp(preferredName, "i") })
          .first();

        if (await namedLink.count()) {
          const namedTitle = (await namedLink.textContent().catch(() => ""))
            .trim()
            .replace(/\s+/g, " ");
          const namedCard = namedLink.locator(
            "xpath=ancestor::div[@itemprop='itemListElement'][1]",
          );

          selectedTripLink = namedLink;
          tripPrice = await readCardPrice(namedCard);
          console.log(
            `✓ Selected the named trip "${namedTitle}" — price ${
              tripPrice === null ? "not listed on the card" : `$${tripPrice}`
            }`,
          );

          if (tripPrice === null) {
            console.log(
              `⚠ "${preferredName}" shows no price on its archive card. It's still the trip being ` +
                `booked, as configured — but a price-less trip can't exercise a real payment, so check ` +
                `the trip's pricing in WP admin if checkout fails.`,
            );
          }
        } else if (strict) {
          throw new Error(
            `No trip matching "${preferredName}" among the ${tripCount} listing(s) on ${tripArchiveUrl}.`,
          );
        } else {
          console.log(
            `⚠ No trip matching "${preferredName}" among the ${tripCount} listing(s) on ${tripArchiveUrl}. ` +
              `It may be unpublished, renamed, or on a later archive page — falling back to the first priced trip.`,
          );
        }
      }

      for (let i = 0; i < tripCount && !selectedTripLink; i++) {
        const link = tripLinks.nth(i);
        // Each listing card is the div[itemprop="itemListElement"] wrapper
        // that holds both the title link and the .price-holder block.
        const tripCard = link.locator(
          "xpath=ancestor::div[@itemprop='itemListElement'][1]",
        );

        const price = await readCardPrice(tripCard);
        if (price !== null) {
          selectedTripLink = link;
          tripPrice = price;
          console.log(
            `✓ Selected trip #${i + 1} of ${tripCount} — price $${tripPrice}`,
          );
          break;
        }
      }

      if (!selectedTripLink) {
        // No priced trip found — fall back to the first listing so the flow
        // can still proceed (matches the previous behaviour), but flag it.
        console.log(
          "⚠ No trip with a valid price found on the archive — falling back to the first trip listing.",
        );
        selectedTripLink = tripLinks.first();
      }

      await Promise.all([
        page
          .waitForLoadState("networkidle", { timeout: 15000 })
          .catch(() => {}),
        selectedTripLink.click(),
      ]);

      console.log("✓ Trip page opened");

      return { price: tripPrice };
    },
  },
};
