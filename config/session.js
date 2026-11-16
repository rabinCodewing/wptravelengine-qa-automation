// config/session.js
//
// Resolves which Playwright storage-state (saved WordPress login) a process
// should use, and whether one exists. The whole suite authenticates once in
// tests/login.setup.js and every other spec reuses the file through
// `storageState` in playwright.config.js.

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
 * Sessions must not mix: two developers running against their own WordPress
 * sites would otherwise share playwright/.auth/user.json, and whoever signed in
 * last would silently own everyone's runs. Hashed over IDENTITY only — the WP
 * site URL and username — never the password, so a password rotation keeps you
 * pointed at the same session file.
 */
function environmentId(parts = {}) {
  const identity =
    typeof parts.identity === "string"
      ? parts.identity
      : [parts.wpUrl, parts.wpUsername]
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
 * PW_AUTH_FILE is set per child process by the UI server, so two runs started
 * from the UI against different environments load different sessions even while
 * running concurrently. Unset — every CLI run — means the default file.
 */
function resolveAuthFile() {
  return process.env.PW_AUTH_FILE ? path.resolve(process.env.PW_AUTH_FILE) : DEFAULT_AUTH_FILE;
}

const AUTH_FILE = resolveAuthFile();

function hasSavedSession(file = resolveAuthFile()) {
  return fs.existsSync(file);
}

/** A short, advisory pause for a freshly navigated page to stop fetching. */
function settle(page, timeout = 5000) {
  return page.waitForLoadState("networkidle", { timeout }).catch(() => {});
}

module.exports = {
  AUTH_DIR,
  AUTH_FILE,
  DEFAULT_AUTH_FILE,
  authFileFor,
  environmentId,
  resolveAuthFile,
  hasSavedSession,
  settle,
};
