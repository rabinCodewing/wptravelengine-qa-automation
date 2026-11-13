/**
 * The PayLexer plugin's own screen in WP admin — the top-level "PayLexer" menu
 * item (not the older Settings > PayLexer credentials screen).
 *
 * Covers the connection (the "Active" pill, or the "Connect to PayLexer"
 * banner and its Connect Account flow) and the available-gateways list.
 */
class PaylexerPluginPage {
  constructor(page) {
    this.page = page;
  }

  /**
   * Scrolls an element to the middle of the viewport before it's acted on or
   * read. Centred rather than scrollIntoViewIfNeeded(), which can leave it under
   * WP admin's sticky top bar. Never fails the step on its own.
   */
  async scrollTo(locator) {
    await locator
      .evaluate((el) => el.scrollIntoView({ block: "center", inline: "nearest" }))
      .catch(() => locator.scrollIntoViewIfNeeded().catch(() => {}));
  }

  /**
   * WP admin (anywhere) → the top-level PayLexer menu.
   *
   * The menu label carries a pending-count bubble
   * (<div class="wp-menu-name">PayLexer <span class="awaiting-mod">1</span></div>),
   * so it's matched on a leading "PayLexer" rather than the exact text.
   */
  async open() {
    const pluginMenu = this.page
      .locator("#adminmenu div.wp-menu-name")
      .filter({ hasText: /^\s*PayLexer\b/i })
      .first();

    await pluginMenu.waitFor({ state: "visible", timeout: 30000 });
    await this.scrollTo(pluginMenu);
    await pluginMenu.click();

    await this.page
      .waitForLoadState("networkidle", { timeout: 15000 })
      .catch(() => {});

    console.log("✓ PayLexer plugin page opened");
  }

  /**
   * The PayLexer this plugin build talks to — the origin of the `appUrl` its
   * admin page is given (PAYLEXER_APP_URL, fixed when the plugin zip is built,
   * or set in wp-config.php). A Live build can only connect to and link to
   * Live; a staging build only to staging. Null if it can't be read.
   * Assumes open() has run.
   */
  async appOrigin() {
    const html = (await this.page.content().catch(() => "")).split("\\/").join("/");
    const match = html.match(/"appUrl"\s*:\s*"([^"]+)"/);
    try {
      return match ? new URL(match[1]).origin : null;
    } catch {
      return null;
    }
  }

  /**
   * Null when the plugin's PayLexer is `expectedOrigin`; otherwise a message
   * saying the two differ and what to do — for the run or the sign-in to stop
   * on, instead of timing out or landing on a PayLexer sign-in page.
   */
  async environmentMismatch(expectedOrigin) {
    const plugin = await this.appOrigin();
    if (!plugin || !expectedOrigin || plugin === expectedOrigin) return null;
    const label = (origin) => {
      const host = new URL(origin).host;
      if (host.includes("staging")) return `Staging (${host})`;
      if (host === "app.paylexer.com") return `Live (${host})`;
      return host;
    };
    return (
      `This WordPress site's PayLexer plugin is built for ${label(plugin)} and can only connect there — ` +
      `but this run is set up for ${label(expectedOrigin)}. Switch the dashboard's Environment to ` +
      `${label(plugin).split(" ")[0]} and click "Sign in to both", or use a WordPress site whose plugin is the ` +
      `${label(expectedOrigin).split(" ")[0]} build.`
    );
  }

  /**
   * Reads the connection pill on the plugin screen. Assumes open() has run.
   *
   * @returns {Promise<"active"|"disconnected">}
   */
  async getConnectionStatus(timeout = 30000) {
    // The pill is an inline-styled <span> (border-radius: 999px); matched on its
    // exact text so no other "Active" wording on the screen is picked up.
    const statusPill = this.page
      .locator("span")
      .filter({ hasText: /^\s*(Active|Disconnected)\s*$/i })
      .first();

    // A site that isn't connected shows this banner instead of a pill.
    const connectBanner = this.connectBanner();

    try {
      await statusPill
        .or(connectBanner)
        .first()
        .waitFor({ state: "visible", timeout });
    } catch (e) {
      throw new Error(
        `Could not find the connection status (Active/Disconnected pill or the "Connect to PayLexer" banner) on the PayLexer plugin page within ${timeout / 1000}s.`,
      );
    }

    if (await connectBanner.isVisible().catch(() => false)) {
      await this.scrollTo(connectBanner);
      return "disconnected";
    }

    await this.scrollTo(statusPill);

    const text = (await statusPill.textContent()).trim().toLowerCase();
    return text === "active" ? "active" : "disconnected";
  }

  /** The "Connect to PayLexer" banner shown while the site isn't connected. */
  connectBanner() {
    return this.page.locator(".pl-connect-banner").first();
  }

  /**
   * Clicks a button if it shows up within `timeout`; returns whether it did.
   * For the sign-in steps, which a still-valid PayLexer session skips.
   */
  async clickIfShown(page, locator, label, timeout) {
    try {
      await locator.waitFor({ state: "visible", timeout });
    } catch (e) {
      console.log(`ℹ "${label}" did not appear — skipping it`);
      return false;
    }

    await this.scrollTo(locator);
    await locator.click({ timeout: 10000 });
    console.log(`✓ Clicked "${label}"`);
    await page.waitForLoadState("load", { timeout: 30000 }).catch(() => {});
    return true;
  }

  /** Fills an input only when it's on screen and still empty. */
  async fillIfEmpty(locator, value, label, envName) {
    if (!(await locator.isVisible().catch(() => false))) return;
    if ((await locator.inputValue().catch(() => "")).trim()) return;

    if (!value) {
      throw new Error(
        `The PayLexer sign-in during Connect Account asks for the ${label}, and ${envName} is empty for this run. ` +
          `Set ${envName} in .env (or the UI's environment form).`,
      );
    }

    await this.scrollTo(locator);
    await locator.fill(value);
    console.log(`✓ Filled the ${label}`);
  }

  /**
   * Connects the site to PayLexer from the "Connect to PayLexer" banner:
   *   Connect Account → Continue → Sign in → tick the consent checkbox →
   *   Connect Account and Authorize → back on the plugin page, showing
   *   "Connected to PayLexer" with the Active pill.
   *
   * Connect Account may open PayLexer in a new tab or navigate this one; both
   * are handled. Continue / Sign in are skipped when they don't appear (a
   * still-valid PayLexer session). The email and password are only filled when
   * their fields are shown and empty.
   *
   * @returns {Promise<"active"|"disconnected">} the status after connecting.
   */
  async connect() {
    const banner = this.connectBanner();
    await banner.waitFor({ state: "visible", timeout: 15000 });
    await this.scrollTo(banner);

    const connectButton = banner.getByRole("button", { name: /connect account/i });
    await this.scrollTo(connectButton);

    const newTab = this.page
      .context()
      .waitForEvent("page", { timeout: 15000 })
      .catch(() => null);

    await connectButton.click({ timeout: 10000 });
    console.log('✓ Clicked "Connect Account"');

    const authPage = (await newTab) || this.page;
    await authPage.waitForLoadState("load", { timeout: 60000 }).catch(() => {});
    console.log(`PayLexer authorization opened at ${authPage.url()}`);

    // ---- Continue (email step) ----
    await authPage
      .locator("#email")
      .waitFor({ state: "visible", timeout: 10000 })
      .catch(() => {});
    await this.fillIfEmpty(authPage.locator("#email"), process.env.EMAIL, "email", "EMAIL");
    await this.clickIfShown(
      authPage,
      authPage.locator('button[type="submit"]', { hasText: /^\s*Continue\s*$/ }),
      "Continue",
      20000,
    );

    // ---- Sign in ----
    // PayLexer's Connect sign-in asks for the password as well now. Filled
    // only when its field is shown and empty; the value is never logged.
    // The VISIBLE box, found by what it shows ("Please enter your password" /
    // label "Password"). A bare input[type=password].first() can land on a
    // hidden duplicate the form keeps for autofill, and a hidden field is
    // skipped silently, so Sign in went off with the password empty.
    const password = authPage
      .getByPlaceholder(/password/i)
      .or(authPage.getByLabel(/^password$/i))
      .or(authPage.locator('input[type="password"]:visible'))
      .first();
    const passwordShown = await password
      .waitFor({ state: "visible", timeout: 10000 })
      .then(() => true)
      .catch(() => false);

    if (passwordShown) {
      await this.fillIfEmpty(password, process.env.PASSWORD, "password", "PASSWORD");
    } else {
      console.log("ℹ No password field on the PayLexer sign-in — continuing without one");
    }
    await this.clickIfShown(
      authPage,
      authPage.locator('button[type="submit"]', { hasText: /^\s*Sign in\s*$/ }),
      "Sign in",
      20000,
    );

    // ---- Consent checkbox ----
    const consent = authPage
      .locator('button[role="checkbox"][data-slot="checkbox"]')
      .first();
    await consent.waitFor({ state: "visible", timeout: 60000 });
    await this.scrollTo(consent);

    if ((await consent.getAttribute("aria-checked")) !== "true") {
      await consent.click({ timeout: 10000 });
    }

    if ((await consent.getAttribute("aria-checked")) !== "true") {
      throw new Error(
        "Clicked the consent checkbox on the PayLexer authorization page, but it is still unchecked.",
      );
    }
    console.log("✓ Consent checkbox ticked");

    // ---- Connect Account and Authorize ----
    const authorize = authPage.getByRole("button", {
      name: /connect account and authorize/i,
    });
    await authorize.waitFor({ state: "visible", timeout: 30000 });
    await this.scrollTo(authorize);
    await authorize.click({ timeout: 15000 });
    console.log('✓ Clicked "Connect Account and Authorize"');

    // ---- Back on the plugin page ----
    // The redirect runs through PayLexer and back into WP admin. A popup
    // usually closes itself; if it doesn't, it's closed here.
    if (authPage !== this.page) {
      await authPage.waitForEvent("close", { timeout: 60000 }).catch(() => {});
      if (!authPage.isClosed()) await authPage.close().catch(() => {});
      await this.page.bringToFront();
      await this.page.reload().catch(() => {});
    }

    const connectedCard = this.page
      .locator(".pl-card")
      .filter({ hasText: /Connected to PayLexer/i })
      .first();

    try {
      await connectedCard.waitFor({ state: "visible", timeout: 90000 });
    } catch (e) {
      // Landed somewhere other than the plugin page — walk back in and read it.
      console.log(
        `ℹ "Connected to PayLexer" not shown after authorizing (at ${this.page.url()}) — reopening the plugin page`,
      );
      await this.open().catch(() => {});
    }

    await this.page
      .waitForLoadState("networkidle", { timeout: 15000 })
      .catch(() => {});
    await this.scrollTo(connectedCard);

    const status = await this.getConnectionStatus(30000);
    console.log(`Connection status after Connect Account: "${status}"`);
    return status;
  }

  /**
   * The gateway's card in the plugin's available-gateways list.
   * Real markup: <a|div class="pl-gwl-card" data-name="Adyen">…
   *
   * Matched on data-name case-insensitively, falling back to the visible
   * .pl-gwl-name text, for a card whose data-name differs in spelling.
   */
  gatewayCard(gatewayName) {
    const cards = this.page.locator(".pl-gwl-card");

    const byDataName = this.page.locator(
      `.pl-gwl-card[data-name="${gatewayName}" i]`,
    );

    const byName = cards.filter({
      has: this.page.locator(".pl-gwl-name", {
        hasText: new RegExp(
          `^\\s*${gatewayName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`,
          "i",
        ),
      }),
    });

    return byDataName.or(byName).first();
  }

  /** Every card's data-name, for logging when a gateway can't be found. */
  async listGatewayNames() {
    return this.page
      .locator(".pl-gwl-card")
      .evaluateAll((cards) => cards.map((c) => c.getAttribute("data-name")))
      .catch((err) => `<unreadable: ${err.message}>`);
  }

  /**
   * Reads the gateway's badge in the plugin's gateway list.
   *
   * @returns {Promise<{state: "missing"|"needs-attention"|"configured"|"added", label: string, detail: string|null}>}
   *   "missing"         — no card for this gateway at all.
   *   "needs-attention" — not configured in PayLexer (card links to Configure).
   *   "configured"      — configured in PayLexer but not added to this site;
   *                       the card has an "Add" button.
   *   "added"           — any other badge (e.g. Sandbox / Live): already on the site.
   */
  async readGatewayState(gatewayName, timeout = 15000) {
    // Plugin v2's cards (assets/admin-app/components/GatewayCard.jsx in the
    // plugin):
    //
    //   div.pl-gwl-card--pending, "Configured" + an Add button
    //                                   → set up in PayLexer, not on this site: "configured"
    //   "Needs Attention"               → on the site, keys failed verification: "needs-attention"
    //   "Live" and/or "Sandbox"         → on the site and verified: "added"
    //   no badge, or "Recommended"      → never set up in PayLexer: "not-configured"
    //   div[role=button] (not a link)   → the SITE isn't connected to PayLexer: "site-not-connected"
    //
    // Badge-less cards are the common case (most gateways are never set up),
    // so nothing here waits on an element that may not exist — every read is
    // a count() or an attribute of an element known to be there.
    const card = this.gatewayCard(gatewayName);

    try {
      await card.waitFor({ state: "visible", timeout });
    } catch (e) {
      console.log(
        `ℹ "${gatewayName}" has no card in the plugin's gateway list. Cards on screen: ` +
          JSON.stringify(await this.listGatewayNames()),
      );
      return { state: "missing", label: "", detail: null };
    }

    await this.scrollTo(card);

    const shape = await card.evaluate((el) => {
      const badges = [...el.querySelectorAll(".pl-gwl-status")];
      return {
        tag: el.tagName,
        role: el.getAttribute("role"),
        pending: el.classList.contains("pl-gwl-card--pending"),
        addButton: Boolean(el.querySelector(".pl-gwl-add-btn")),
        badges: badges.map((b) => ({
          className: b.className,
          text: b.textContent.trim(),
          title: b.getAttribute("title"),
        })),
      };
    });

    const label = shape.badges.map((b) => b.text).join(" + ");
    const detail = shape.badges.map((b) => b.title).filter(Boolean).join("; ") || null;
    const has = (modifier) => shape.badges.some((b) => b.className.includes(`pl-gwl-status--${modifier}`));

    let state;
    if (shape.pending || shape.addButton) state = "configured";
    else if (has("attention") || /needs attention/i.test(label)) state = "needs-attention";
    else if (has("configured") || has("sandbox")) state = "added";
    else if (shape.tag === "DIV" && shape.role === "button") state = "site-not-connected";
    else state = "not-configured";

    return { state, label, detail };
  }

  /**
   * Opens a card's gateway on PayLexer — a "Needs Attention" card to fix its
   * keys, or a never-set-up card to enter them. The card is an
   * <a target="_blank"> to the gateway's configure page, so this opens a new
   * tab — returned once it has loaded. Same browser context, so it carries the
   * saved PayLexer session.
   */
  async openConfigure(gatewayName) {
    const card = this.gatewayCard(gatewayName);
    await card.waitFor({ state: "visible", timeout: 15000 });
    await this.scrollTo(card);

    // The "Configure"/"Edit" label is hidden until the card is hovered
    // (.pl-gwl-card:hover .pl-gwl-configure), so it is never the click
    // target: the whole card is the <a target="_blank"> to the configure page
    // (or, for an unverified account, a <button> that opens it). Hovered first
    // so a person watching sees the same thing they would.
    await card.hover({ timeout: 10000 }).catch(() => {});

    const [paylexerPage] = await Promise.all([
      this.page.waitForEvent("popup", { timeout: 30000 }),
      card.click({ timeout: 10000 }),
    ]);

    await paylexerPage.waitForLoadState("load", { timeout: 60000 }).catch(() => {});
    await paylexerPage
      .waitForLoadState("networkidle", { timeout: 15000 })
      .catch(() => {});

    console.log(
      `✓ Clicked "Configure" for "${gatewayName}" — PayLexer opened at ${paylexerPage.url()}`,
    );

    return paylexerPage;
  }

  /**
   * Clicks "Add" on a configured gateway's card. Adding installs it on the site
   * AND enables it in WP Travel Engine, so there's no separate enable step.
   * Waits for the Add button to go away as the sign the add went through.
   */
  async addGateway(gatewayName, timeout = 60000) {
    const card = this.gatewayCard(gatewayName);
    const addButton = card.locator(".pl-gwl-add-btn");

    await addButton.waitFor({ state: "visible", timeout: 15000 });
    await this.scrollTo(addButton);
    await addButton.click({ timeout: 10000 });
    console.log(`✓ Clicked "Add" for "${gatewayName}"`);

    try {
      await addButton.waitFor({ state: "detached", timeout });
    } catch (e) {
      const { label } = await this.readGatewayState(gatewayName, 5000);
      throw new Error(
        `Clicked "Add" for "${gatewayName}" on the PayLexer plugin page, but the Add button was still there after ${timeout / 1000}s ` +
          `(badge now reads "${label}"). The gateway was not added to the site.`,
      );
    }

    const { label } = await this.readGatewayState(gatewayName, 10000);
    console.log(`✓ "${gatewayName}" added to the site (badge now: "${label}")`);
  }
}

module.exports = PaylexerPluginPage;
