const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const AUTH_DIR = path.resolve(__dirname, "../playwright/.auth");

// The default storage state — the one a plain .env-driven CLI run uses, with no
// UI and no environment chosen.
const DEFAULT_AUTH_FILE = path.join(AUTH_DIR, "user.json");

/**
 * A short, stable id for ONE target environment.
 *
 * Sessions must not mix. Two developers running against their own PayLexer
 * accounts and their own WordPress sites would otherwise share
 * playwright/.auth/user.json, and whoever signed in last would silently own
 * everyone's runs — the kind of failure that looks like a flaky test rather
 * than a crossed session.
 *
 * Hashed over IDENTITY only — the two URLs and the two usernames — never over
 * the passwords. A password rotation should keep you pointed at the same
 * session file rather than orphaning it, and nothing password-derived should
 * be written into a filename that ends up in a directory listing.
 */
function environmentId(parts = {}) {
  // config/environment.js passes a pre-normalised `identity` string (origins,
  // not raw URLs) so that the same deployment typed two different ways is one
  // environment. The field-by-field form is kept for any direct caller.
  const identity =
    typeof parts.identity === "string"
      ? parts.identity
      : [parts.paylexerUrl, parts.paylexerEmail, parts.wpUrl, parts.wpUsername]
          .map((value) => String(value || "").trim().toLowerCase())
          .join(String.fromCharCode(10));

  return crypto.createHash("sha256").update(identity).digest("hex").slice(0, 12);
}

/** The storage-state path for an environment id. */
function authFileFor(id) {
  return id ? path.join(AUTH_DIR, `env-${id}.json`) : DEFAULT_AUTH_FILE;
}

/**
 * Which storage state THIS process should use.
 *
 * PW_AUTH_FILE is set per child process by scripts/uiServer.js, so two runs
 * started from the UI against different environments load different sessions
 * even while running concurrently. Unset — every CLI run — means the default
 * file, so the .env workflow is completely unchanged.
 */
function resolveAuthFile() {
  return process.env.PW_AUTH_FILE
    ? path.resolve(process.env.PW_AUTH_FILE)
    : DEFAULT_AUTH_FILE;
}

// Kept as a named export because the setup and the config both refer to "the
// auth file" for the current process.
const AUTH_FILE = resolveAuthFile();

/**
 * The URL to open when the session is already authenticated.
 *
 * BASE_URL points at the sign-in page (.../signin), which is right for the
 * login setup and wrong for everything else — so this swaps the trailing
 * /signin for the dashboard. Set DASHBOARD_URL in .env to override.
 */
function dashboardUrl() {
  if (process.env.DASHBOARD_URL) return process.env.DASHBOARD_URL;

  const base = process.env.BASE_URL;
  if (!base) {
    throw new Error("BASE_URL is not set in .env — cannot resolve dashboard URL.");
  }

  return base.replace(/\/signin\/?$/i, "/dashboard");
}

/**
 * The wp-admin URL to open when the WordPress session is already authenticated.
 *
 * Built from FRONTEND_URL, the same way the specs build it. NOT from
 * WP_LOGIN_URL: that points at wp-login.php with ?loggedout=true, which logs
 * you straight back OUT — the one URL a saved session must never open.
 */
function wpAdminUrl() {
  const frontend = process.env.FRONTEND_URL;

  if (!frontend) {
    throw new Error(
      "FRONTEND_URL is not set in .env — cannot resolve the wp-admin URL.",
    );
  }

  return `${frontend.replace(/\/$/, "")}/wp-admin/`;
}

function hasSavedSession(file = resolveAuthFile()) {
  return fs.existsSync(file);
}

/**
 * A SHORT, advisory pause for the page to stop fetching.
 *
 * "networkidle" means twelve consecutive quiet network ticks, and neither of
 * these apps reliably produces them — the PayLexer dashboard polls and
 * wp-admin runs heartbeat and admin-ajax indefinitely. The wait therefore does
 * not usually succeed; it TIMES OUT, and because the failure is swallowed the
 * only visible effect is the delay. At the 60s it used to carry, two of these
 * on the sign-in path were two minutes of pure waiting on something that was
 * never going to happen.
 *
 * Kept, rather than removed, because it does settle on the pages that go
 * quiet, and a moment's grace before reading a freshly navigated page is
 * cheap. Cut to a ceiling that costs seconds when it does not: the real
 * verdict in every caller is the URL check or the element wait that follows,
 * which has its own proper timeout.
 */
const SETTLE_TIMEOUT = 5000;

function settle(page, timeout = SETTLE_TIMEOUT) {
  return page.waitForLoadState("networkidle", { timeout }).catch(() => {});
}

/**
 * Opens the PayLexer dashboard on an already-authenticated page — no
 * LoginPage.login() call anywhere in the gateway flows.
 *
 * If the saved session has expired the app redirects straight back to
 * /signin. That is checked explicitly rather than left to fail twenty actions
 * later on a missing sidebar item, because "element not found" gives no hint
 * that the real problem is a stale user.json.
 */
async function openDashboard(page) {
  const authFile = resolveAuthFile();

  if (!hasSavedSession(authFile)) {
    throw new Error(
      `No saved session at ${authFile}.\n` +
        "Run the login setup once first:\n" +
        "  npx playwright test tests/login.setup.js --project=setup",
    );
  }

  await page.goto(dashboardUrl());
  await settle(page);

  if (/\/signin\b/i.test(page.url())) {
    throw new Error(
      "The saved session has expired — PayLexer redirected back to the sign-in page.\n" +
        "Refresh it with:\n" +
        "  npx playwright test tests/login.setup.js --project=setup",
    );
  }
}

/**
 * Opens wp-admin on an already-authenticated page — no WPLoginPage.login()
 * in the gateway flows either.
 *
 * WordPress is the login these runs actually spend time on: the PayLexer one
 * happens once per run, but wpGatewayCheckout.spec.js opens wp-admin as its
 * FIRST step and paymentGateway.spec.js logs in twice more in new tabs. The
 * setup ticks "Remember Me", so the cookie WordPress issues is persistent and
 * survives in user.json rather than dying with the browser.
 *
 * An expired WordPress session bounces to wp-login.php, which is checked here
 * for the same reason the PayLexer one is: the alternative is a confusing
 * failure on a wp-admin menu item that was never going to render.
 */
async function openWpAdmin(page) {
  const authFile = resolveAuthFile();

  if (!hasSavedSession(authFile)) {
    throw new Error(
      `No saved session at ${authFile}.\n` +
        "Run the login setup once first:\n" +
        "  npx playwright test tests/login.setup.js --project=setup",
    );
  }

  await page.goto(wpAdminUrl());
  await settle(page);

  if (/wp-login\.php/i.test(page.url())) {
    throw new Error(
      "The saved WordPress session has expired — wp-admin redirected to wp-login.php.\n" +
        "Refresh it with:\n" +
        "  npx playwright test tests/login.setup.js --project=setup",
    );
  }
}

/** The hostname of a URL, or null when it is unset or unparseable. */
function hostOf(url) {
  if (!url) return null;

  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** The two sites a session covers, read from the current environment. */
function DEFAULT_SITES() {
  return [
    { key: "paylexer", label: "PayLexer", host: hostOf(process.env.BASE_URL) },
    { key: "wordpress", label: "WordPress", host: hostOf(process.env.FRONTEND_URL) },
  ];
}

/**
 * Whether a stored cookie belongs to `host`.
 *
 * Cookie domains come either bare ("app.paylexer.com") or dot-prefixed
 * (".paylexer.com") for a domain cookie covering subdomains, so an equality
 * test alone would miss half of them.
 */
function cookieMatchesHost(cookie, host) {
  const domain = String(cookie.domain || "").toLowerCase();
  if (!domain) return false;

  const bare = domain.startsWith(".") ? domain.slice(1) : domain;
  return host === bare || host.endsWith(`.${bare}`);
}

/**
 * What state the saved session is in, without opening a browser.
 *
 * Returns { state, savedAt, expiresAt, cookies, detail } where state is one of:
 *   "missing" — no user.json; the login setup has never been run
 *   "expired" — every auth cookie's expiry has passed
 *   "ok"      — usable as far as can be told from disk
 *
 * The expiry check reads the cookie expiries that Playwright stores alongside
 * each cookie in the storage state. That is a real signal, not a guess about
 * age: it is the same timestamp the browser itself enforces. It is a LOWER
 * bound on trouble, though — a server can invalidate a session long before its
 * cookie lapses — so "ok" means "not provably dead", and openDashboard()
 * remains the thing that finds out for certain.
 *
 * Session cookies (expires -1) never lapse on the clock, so a state made only
 * of those is reported "ok" and left to openDashboard() to judge.
 */
/** Every configured site, all reported unusable — for the early returns. */
function blankSites(sites) {
  return (sites || DEFAULT_SITES()).map((site) => ({
    key: site.key || site.label.toLowerCase(),
    label: site.label,
    state: "missing",
    detail: "not signed in",
    expiresAt: null,
  }));
}

// ─── The PayLexer ↔ WordPress connection ─────────────────────────────────────
//
// Signing in proves two LOGINS. It does not prove that the WordPress site is
// actually wired to this PayLexer account — that is a separate thing, tested by
// "Test Connection" on the website-edit screen, and it is the one that decides
// whether a gateway run can work at all.
//
// The distinction matters because of how it FAILS. With the connection down,
// PayLexer never pushes a gateway to the site, so the gateway never appears on
// WP Travel Engine > Settings > Payments > General, and the run spends three or
// four minutes configuring the gateway in PayLexer, ticking it on the website
// and re-reading the WordPress screen before giving up. Every gateway fails the
// same way, for a reason that has nothing to do with any of them.
//
// So the verdict is recorded at sign-in, beside the session it belongs to, and
// read back by anything that is about to spend minutes assuming it is fine.
// One file per environment (the auth file already is one), so switching between
// live and staging reports that environment's connection and not the other's.
const CONNECTION_STATES = new Set(["connected", "disconnected", "unknown"]);

/** Where the connection verdict for `file`'s environment is parked. */
function connectionFileFor(file = resolveAuthFile()) {
  return file.replace(/\.json$/i, "") + ".connection.json";
}

/**
 * Records the verdict. Best-effort by design: a sign-in that cannot write this
 * has still saved a usable session, and must not fail over a status file.
 */
function writeConnection(file, state, detail = "") {
  const record = {
    state: CONNECTION_STATES.has(state) ? state : "unknown",
    detail: String(detail || ""),
    checkedAt: Date.now(),
  };

  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(connectionFileFor(file), JSON.stringify(record, null, 2));
  } catch {
    // Nothing to do about it here, and nothing that depends on it: every
    // reader below treats a missing record as "unknown".
  }

  return record;
}

/**
 * The last recorded verdict, or "unknown" when there is none — which is what a
 * session saved before this existed looks like, and is treated as "nobody has
 * checked", never as a failure.
 */
function readConnection(file = resolveAuthFile()) {
  const unknown = { state: "unknown", detail: "", checkedAt: null };

  try {
    const parsed = JSON.parse(fs.readFileSync(connectionFileFor(file), "utf8"));

    if (!parsed || !CONNECTION_STATES.has(parsed.state)) return unknown;

    // Stale once the session it belongs to has been replaced: a fresh sign-in
    // that never reached the connection step must not keep reporting the
    // previous one's verdict.
    return {
      state: parsed.state,
      detail: String(parsed.detail || ""),
      checkedAt: Number(parsed.checkedAt) || null,
    };
  } catch {
    return unknown;
  }
}

/**
 * Session status for the UI: the cookie verdict, plus the connection verdict
 * that the cookies say nothing about.
 */
function sessionStatus(file = resolveAuthFile(), sites = null) {
  return {
    ...cookieSessionStatus(file, sites),
    connection: readConnection(file),
  };
}

function cookieSessionStatus(file = resolveAuthFile(), sites = null) {
  const AUTH_FILE = file;

  if (!fs.existsSync(AUTH_FILE)) {
    return {
      state: "missing",
      detail: "No saved session — run the login setup once.",
      savedAt: null,
      expiresAt: null,
      cookies: 0,
      sites: blankSites(sites),
    };
  }

  const savedAt = fs.statSync(AUTH_FILE).mtimeMs;

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(AUTH_FILE, "utf8"));
  } catch (error) {
    // A truncated or hand-edited user.json is unusable, and Playwright's own
    // error for it arrives at context-creation time pointing at the config.
    // Treat it as "no session" so the UI offers the button that fixes it.
    return {
      state: "missing",
      detail: `Saved session is unreadable (${error.message}) — run the login setup again.`,
      savedAt,
      expiresAt: null,
      cookies: 0,
      sites: blankSites(sites),
    };
  }

  const cookies = Array.isArray(parsed.cookies) ? parsed.cookies : [];

  if (!cookies.length) {
    return {
      state: "missing",
      detail: "Saved session holds no cookies — run the login setup again.",
      savedAt,
      expiresAt: null,
      cookies: 0,
      sites: blankSites(sites),
    };
  }

  // BOTH sites, checked separately. One user.json covers PayLexer and
  // WordPress, and a file holding only PayLexer cookies — which is exactly what
  // a user.json saved before WordPress was added to the setup looks like —
  // would otherwise report a confident green while every run still stopped at
  // wp-login.php.
  const checked = (sites || DEFAULT_SITES()).filter((site) => site.host);

  const now = Date.now();
  const missing = [];
  const expired = [];
  const expiries = [];

  // The same verdict, kept per SITE as well as aggregated. The UI shows
  // PayLexer and WordPress on their own lines, and "one of them is stale" is
  // the case a single combined state cannot express — which is exactly the
  // case worth seeing, since it names which login to look at.
  const perSite = [];

  for (const site of checked) {
    const owned = cookies.filter((cookie) => cookieMatchesHost(cookie, site.host));

    if (!owned.length) {
      missing.push(site.label);
      perSite.push({
        key: site.key || site.label.toLowerCase(),
        label: site.label,
        state: "missing",
        detail: "no cookies saved",
        expiresAt: null,
      });
      continue;
    }

    // Playwright stores `expires` in SECONDS since the epoch, -1 for a session
    // cookie. The LATEST of a site's expiries, not the earliest: a storage
    // state carries analytics and preference cookies that lapse within hours
    // while the auth cookie is good for weeks, and going by the earliest would
    // report a perfectly good session as expired most of the time.
    const dated = owned
      .map((cookie) => cookie.expires)
      .filter((expires) => typeof expires === "number" && expires > 0)
      .map((expires) => expires * 1000);

    if (!dated.length) {
      // Session cookies only — nothing to judge on, so it counts as usable and
      // openDashboard() is left to find out for certain.
      perSite.push({
        key: site.key || site.label.toLowerCase(),
        label: site.label,
        state: "ok",
        detail: "signed in",
        expiresAt: null,
      });
      continue;
    }

    const latest = Math.max(...dated);

    if (latest <= now) {
      expired.push(site.label);
      perSite.push({
        key: site.key || site.label.toLowerCase(),
        label: site.label,
        state: "expired",
        detail: "session expired",
        expiresAt: latest,
      });
    } else {
      expiries.push(latest);
      perSite.push({
        key: site.key || site.label.toLowerCase(),
        label: site.label,
        state: "ok",
        detail: "signed in",
        expiresAt: latest,
      });
    }
  }

  if (missing.length) {
    return {
      state: "missing",
      detail: `Saved session has no ${missing.join(" or ")} cookies — run the login setup again.`,
      savedAt,
      expiresAt: null,
      cookies: cookies.length,
      sites: perSite,
    };
  }

  if (expired.length) {
    return {
      state: "expired",
      detail: `The ${expired.join(" and ")} session has expired — run the login setup again.`,
      savedAt,
      expiresAt: Math.min(...expiries, now),
      cookies: cookies.length,
      sites: perSite,
    };
  }

  // The EARLIEST of the two sites' expiries, because the run needs both: the
  // whole session is only good until the first of them lapses.
  return {
    state: "ok",
    detail: "Saved session is in place for PayLexer and WordPress.",
    savedAt,
    expiresAt: expiries.length ? Math.min(...expiries) : null,
    cookies: cookies.length,
    sites: perSite,
  };
}

module.exports = {
  AUTH_DIR,
  AUTH_FILE,
  DEFAULT_AUTH_FILE,
  authFileFor,
  environmentId,
  resolveAuthFile,
  dashboardUrl,
  wpAdminUrl,
  hasSavedSession,
  settle,
  openDashboard,
  openWpAdmin,
  sessionStatus,
  connectionFileFor,
  readConnection,
  writeConnection,
};
