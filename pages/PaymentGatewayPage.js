const { expect } = require("@playwright/test");
const {
  PaymentGatewayLocators,
} = require("../locators/paymentGateway.locators");

class PaymentGatewayPage {
  constructor(page) {
    this.page = page;
  }

  async searchGateway(gatewayName) {
    await this.page
      .locator(PaymentGatewayLocators.searchInput)
      .fill(gatewayName);

    await expect(
      this.page.locator(`h3:has-text("${gatewayName}")`),
    ).toBeVisible();
  }

  async clickConfigure(gatewayName) {
    const gatewayCard = this.page.locator('div[data-slot="card"]').filter({
      has: this.page.locator(`h3:has-text("${gatewayName}")`),
    });

    await expect(gatewayCard).toBeVisible();

    await gatewayCard.getByRole("button", { name: "Configure" }).click();
  }
}

module.exports = PaymentGatewayPage;
