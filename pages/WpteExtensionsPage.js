// pages/WpteExtensionsPage.js
//
// WP Travel Engine › Extensions (edit.php?post_type=booking&page=extensions)
// and the matching row on Plugins, for checking that an add-on is installed,
// licensed and active — and activating it when it isn't.
//
// A card is `.plugin-card-<slug>`. An active add-on shows a disabled "Active"
// button in `.action-links`; an inactive one shows only "View Details".

const { expect } = require("@playwright/test");

class WpteExtensionsPage {
  constructor(page, baseUrl) {
    this.page = page;
    this.base = baseUrl.replace(/\/$/, "");
  }

  card(slug) {
    return this.page.locator(`.plugin-card-${slug}`);
  }

  async open() {
    await this.page.goto(`${this.base}/wp-admin/edit.php?post_type=booking&page=extensions`);
    await this.page.locator(".wpte-addon__card").first().waitFor({ timeout: 60000 });
  }

  /** { found, active, licenseStatus, version } for an add-on card. */
  async status(slug) {
    const card = this.card(slug);
    if (!(await card.count())) return { found: false, active: false, licenseStatus: null, version: null };
    const active = await card.locator(".action-links button", { hasText: "Active" }).count();
    return {
      found: true,
      active: active > 0,
      licenseStatus: await card.getAttribute("data-license-status"),
      version: (await card.locator(".wpte-addon__version span").innerText().catch(() => "")).trim(),
    };
  }

  /** Activates the plugin from Plugins when its row says "Activate". */
  async activatePlugin(slug) {
    await this.page.goto(`${this.base}/wp-admin/plugins.php`);
    const row = this.page.locator(`tr[data-slug="${slug}"]`).first();
    await expect(row, `Plugin "${slug}" is not installed on this site`).toHaveCount(1);
    if (await row.evaluate((tr) => tr.classList.contains("active"))) return false;
    await row.locator(".row-actions .activate a").click();
    await expect(this.page.locator(`tr[data-slug="${slug}"].active`)).toHaveCount(1, { timeout: 60000 });
    return true;
  }

  /** Activates the add-on's license from its card when it isn't valid yet. */
  async activateLicense(slug, licenseKey) {
    const card = this.card(slug);
    const input = card.locator("input.wptravelengine_license_key");
    if (await card.locator("[data-license-edit-trigger]").isVisible().catch(() => false)) {
      await card.locator("[data-license-edit-trigger]").click();
    }
    await input.fill(licenseKey);
    await card.locator("button.activate-license").click();
    await expect(card).toHaveAttribute("data-license-status", "valid", { timeout: 60000 });
  }
}

module.exports = WpteExtensionsPage;
