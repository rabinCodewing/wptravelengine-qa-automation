// config/wpteApi.js
//
// A thin client for the WP Travel Engine REST API, used by the Accommodation
// suite to build and check its fixtures without clicking through wp-admin.
//
// Requests go through `page.request`, so they carry the browser context's
// WordPress cookies. WordPress REST still needs a nonce for a cookie-authed
// write, which every wp-admin page exposes as `wpApiSettings.nonce` — so the
// client is initialised from an open wp-admin page.
//
// Endpoints (all observed on WPTE 6.x):
//   GET/POST /wptravelengine/v2/settings            global settings (partial POST)
//   GET/POST /wptravelengine/v2/trips/{id}           trip meta: packages, accommodation…
//   GET      /wptravelengine/v2/trips/{id}/accommodation?date=YYYY-MM-DD
//                                                    what the booking modal reads
//   POST/DELETE /wp/v2/trip[/{id}]                   the trip post itself

class WpteApi {
  constructor(page, baseUrl) {
    this.page = page;
    this.base = baseUrl.replace(/\/$/, "");
    this.nonce = null;
  }

  /** Reads the REST nonce from wp-admin. Opens a light wp-admin page if needed. */
  async init() {
    if (!/\/wp-admin\//.test(this.page.url())) {
      await this.page.goto(`${this.base}/wp-admin/edit.php?post_type=trip`);
    }
    this.nonce = await this.page.evaluate(() => window.wpApiSettings?.nonce || null);
    if (!this.nonce) {
      throw new Error("Could not read wpApiSettings.nonce from wp-admin — is the session logged in?");
    }
    return this;
  }

  async call(method, path, data) {
    const url = `${this.base}/wp-json${path}`;
    const send = () =>
      this.page.request.fetch(url, {
        method,
        headers: { "X-WP-Nonce": this.nonce, "Content-Type": "application/json" },
        data: data === undefined ? undefined : JSON.stringify(data),
        // The test host can take well over 30s on a trip save.
        timeout: 120000,
      });
    let response;
    try {
      response = await send();
    } catch (error) {
      if (!/Timeout/i.test(error.message)) throw error;
      console.log(`ℹ ${method} ${path} timed out — retrying once`);
      response = await send();
    }
    const text = await response.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    if (!response.ok()) {
      throw new Error(`${method} ${path} → ${response.status()}: ${String(text).slice(0, 400)}`);
    }
    return body;
  }

  // ── Global settings ────────────────────────────────────────────────────────

  async getSettings() {
    return this.call("GET", "/wptravelengine/v2/settings");
  }

  async getAccommodationSettings() {
    return (await this.getSettings()).accommodation;
  }

  /** Partial update: only the keys passed are changed. */
  async updateAccommodationSettings(partial) {
    const saved = await this.call("POST", "/wptravelengine/v2/settings", { accommodation: partial });
    return saved.accommodation;
  }

  /**
   * Makes sure every room definition exists globally (matched by room_type)
   * with the given fields, leaving every other room alone. Returns
   * { [room_type]: id }.
   */
  async ensureGlobalRooms(definitions) {
    const current = (await this.getAccommodationSettings()).rooms || [];
    const rooms = current.map((room) => ({ ...room, _changed: false }));

    for (const def of definitions) {
      const existing = rooms.find((room) => room.room_type === def.room_type);
      const wanted = {
        description: "",
        short_description: "",
        images: [],
        enable: true,
        allow_shared_booking: false,
        ...def,
      };
      if (existing) Object.assign(existing, wanted, { _changed: true });
      else rooms.push({ id: null, ...wanted, _changed: true });
    }

    const saved = await this.updateAccommodationSettings({ rooms });
    return Object.fromEntries((saved.rooms || []).map((room) => [room.room_type, room.id]));
  }

  /** Same as ensureGlobalRooms, for upgrades (matched by name). Returns { [name]: id }. */
  async ensureGlobalUpgrades(definitions) {
    const current = (await this.getAccommodationSettings()).upgrades || [];
    const upgrades = current.map((upgrade) => ({ ...upgrade, _changed: false }));

    for (const def of definitions) {
      const existing = upgrades.find((upgrade) => upgrade.name === def.name);
      const wanted = { description: "", images: [], ...def };
      if (existing) Object.assign(existing, wanted, { _changed: true });
      else upgrades.push({ id: null, ...wanted, _changed: true });
    }

    const saved = await this.updateAccommodationSettings({ upgrades });
    return Object.fromEntries((saved.upgrades || []).map((upgrade) => [upgrade.name, upgrade.id]));
  }

  /** Drops global rooms/upgrades whose name starts with `prefix`. */
  async removeGlobalByPrefix(prefix) {
    const settings = await this.getAccommodationSettings();
    const rooms = (settings.rooms || []).filter((room) => !String(room.room_type).startsWith(prefix));
    const upgrades = (settings.upgrades || []).filter((upgrade) => !String(upgrade.name).startsWith(prefix));
    return this.updateAccommodationSettings({ rooms, upgrades });
  }

  // ── Trips ──────────────────────────────────────────────────────────────────

  async getTrip(id) {
    return this.call("GET", `/wptravelengine/v2/trips/${id}?context=edit`);
  }

  async updateTrip(id, data) {
    return this.call("POST", `/wptravelengine/v2/trips/${id}`, data);
  }

  /** What the booking modal's Accommodation step is fed for a date. */
  async publicAccommodation(id, date) {
    return this.call("GET", `/wptravelengine/v2/trips/${id}/accommodation${date ? `?date=${date}` : ""}`);
  }

  async findTrips(search) {
    const list = await this.call(
      "GET",
      `/wp/v2/trip?search=${encodeURIComponent(search)}&status=publish,draft,private&per_page=100&context=edit`,
    );
    return Array.isArray(list) ? list : [];
  }

  /**
   * Creates a published trip with one package priced per Adult, or reuses the
   * trip with exactly this title so re-runs don't pile up duplicates.
   */
  async upsertTrip({ title, adultCategoryId, adultPrice, durationDays = 3 }) {
    const existing = (await this.findTrips(title)).find(
      (trip) => (trip.title?.raw ?? trip.title?.rendered) === title,
    );

    const id = existing
      ? existing.id
      : (await this.call("POST", "/wp/v2/trip", { title, status: "publish", content: `${title} — automated accommodation fixture.` })).id;

    const trip = await this.getTrip(id);

    // Re-runs: leave a trip alone when its package is already what we'd write.
    const current = trip.packages?.[0];
    const adult = current?.traveler_categories?.find((c) => Number(c.id) === Number(adultCategoryId));
    if (existing && trip.packages.length === 1 && current.name === "QA Standard" && Number(adult?.price) === Number(adultPrice) && !adult?.has_sale) {
      if (existing.status !== "publish") await this.call("POST", `/wp/v2/trip/${id}`, { status: "publish" });
      return { id, link: trip.link, title, accommodation: trip.accommodation };
    }

    const days = Object.fromEntries(["MO", "TU", "WE", "TH", "FR", "SA", "SU"].map((d) => [d, []]));
    const weekDays = Object.fromEntries(Object.keys(days).map((d) => [d, false]));
    const pkg = {
      ...(trip.packages?.[0]?.id ? { id: trip.packages[0].id } : {}),
      name: "QA Standard",
      description: "",
      is_primary: true,
      min_pax: 1,
      traveler_categories: [
        {
          id: adultCategoryId,
          label: "Adult",
          price: adultPrice,
          age_group: "",
          pricing_type: { value: "per-person", label: "Person", description: "" },
          sale_price: "",
          has_sale: false,
          has_group_pricing: false,
          group_pricing: [],
          min_pax: 1,
          max_pax: "",
          description: "",
          is_primary: true,
          is_min_required: false,
        },
      ],
      time_slots_enable: false,
      time_slots: days,
      enable_week_days: weekDays,
      dates: [],
    };

    await this.updateTrip(id, {
      packages: [pkg],
      duration: { period: durationDays, unit: "days", nights: Math.max(durationDays - 1, 0) },
    });
    if (existing && existing.status !== "publish") {
      await this.call("POST", `/wp/v2/trip/${id}`, { status: "publish" });
    }

    const fresh = await this.getTrip(id);
    return { id, link: fresh.link, title, accommodation: fresh.accommodation };
  }

  // ── Payments & bookings ────────────────────────────────────────────────────

  /**
   * Makes WP Travel Engine's own Stripe gateway usable: enabled, with keys.
   * Keys already on the site are kept; empty ones are filled from `keys`,
   * which must be test-mode keys.
   */
  async ensureStripe(keys = {}) {
    const settings = await this.getSettings();
    const stripe = settings.stripe || {};
    const patch = {};
    if (!stripe.publishable_key || !stripe.secret_key) {
      if (!keys.publishable_key || !keys.secret_key) {
        throw new Error("Stripe keys are empty on the site and STRIPE_PUBLISHABLE_KEY / STRIPE_SECRET_KEY are not set in .env.");
      }
      if (!/^pk_test_/.test(keys.publishable_key) || !/^sk_test_/.test(keys.secret_key)) {
        throw new Error("Refusing to set non-test Stripe keys: use pk_test_ / sk_test_ keys.");
      }
      patch.stripe = { publishable_key: keys.publishable_key, secret_key: keys.secret_key };
    }
    const gateways = settings.payment_gateways || [];
    const entry = gateways.find((g) => g.id === "stripe_payment");
    if (!entry) throw new Error("The Stripe gateway (stripe_payment) is not available. Is the WP Travel Engine Stripe add-on active?");
    if (!entry.enable) patch.payment_gateways = gateways.map((g) => (g.id === "stripe_payment" ? { ...g, enable: true } : g));
    if (Object.keys(patch).length) await this.call("POST", "/wptravelengine/v2/settings", patch);
    return Object.keys(patch);
  }

  async getBooking(id) {
    return this.call("GET", `/wptravelengine/v2/bookings/${id}?context=edit`);
  }

  async deleteTrip(id) {
    return this.call("DELETE", `/wp/v2/trip/${id}?force=true`);
  }
}

module.exports = { WpteApi };
