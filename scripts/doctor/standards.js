// scripts/doctor/standards.js
//
// Ties the scanner and the manual checklist to the seven kinds of security
// testing, a threat model for WP Travel Engine, and two audit standards
// (OWASP Top 10 2021, PCI DSS 4.0 for payment pages).
//
// Every threat / audit control lists the scan rules and checklist items that
// test it. evaluate() turns the latest scan findings + checklist results into
// a status for each:
//   found       a scan finding is open, or a manual test failed
//   pass        every linked manual test passed and no scan finding is open
//   partial     some tests done, none failed
//   untested    nothing run yet

// ── The seven kinds of security testing ─────────────────────────────────────
const TYPES = [
  { id: "vuln-scan", name: "Vulnerability scanning", what: "Automated sweeps for known issues and misconfigurations.", where: "Automated scan → site probe, library check (OSV.dev).", rules: "site,deps" },
  { id: "pentest", name: "Penetration testing", what: "A person actively tries to break in and chains weaknesses together.", where: "Manual tests → pen-test areas. Black-box: site probe only. Grey-box: also a Subscriber account (logged-in probe). White-box: plus the code scan and code review.", checks: "pentest" },
  { id: "code-review", name: "Security code review", what: "A person reads the code looking for logic flaws tools miss.", where: "Automated scan → code scan gives the leads; Manual tests → Code review (white-box) for the read-through.", checks: "review", rules: "code" },
  { id: "fuzz", name: "Fuzz testing", what: "Malformed input to find crashes and unexpected behaviour.", where: "Automated scan → tick “Fuzz the API”: malformed values to every WP Travel Engine API parameter.", rules: "fuzz" },
  { id: "threat-model", name: "Risk assessment / threat modeling", what: "What could go wrong and which risks matter most.", where: "Threat model tab: WP Travel Engine threats ranked by risk, each linked to the checks that test it." },
  { id: "audit", name: "Security auditing", what: "Checks against a standard such as OWASP or PCI DSS.", where: "Audit tab: OWASP Top 10 and PCI DSS controls with pass/fail from scans and manual tests." },
  { id: "config", name: "Configuration testing", what: "Headers, TLS, file permissions, debug mode.", where: "Automated scan → site probe (headers, HTTPS, TLS, cookies, exposed files, debug, XML-RPC); Manual tests → Server & site configuration.", rules: "config", checks: "config" },
];

const CONFIG_RULES = ["security-headers", "server-version", "no-https", "no-https-redirect", "tls-cert", "tls-old-protocol", "cookie-flags", "xmlrpc-enabled", "wp-readme", "debug-log-exposed", "env-exposed", "config-backup-exposed", "git-exposed", "dir-listing", "phpinfo-exposed", "error-log-exposed", "php-error-disclosure", "version-disclosure"];

// ── OWASP Top 10 (2021) ─────────────────────────────────────────────────────
const OWASP = [
  { id: "A01", name: "Broken access control", rules: ["ajax-missing-capability", "ajax-missing-nonce", "ajax-nopriv-writes", "ajax-dynamic-hook", "rest-missing-permission", "rest-public-route", "rest-any-logged-in", "idor", "privilege-escalation", "open-redirect", "option-from-request", "path-traversal", "lowpriv-admin-screen", "lowpriv-rest", "lowpriv-private-records", "anon-private-records", "rest-anon-data"], checks: ["idor-booking", "idor-invoice", "idor-profile", "role-subscriber-admin", "role-ajax", "role-register", "role-draft", "csrf-settings", "csrf-booking", "data-api", "cr-authz"] },
  { id: "A02", name: "Cryptographic failures", rules: ["hardcoded-secret", "weak-random", "weak-password-hash", "no-https", "no-https-redirect", "rest-leaks-secret", "tls-cert", "tls-old-protocol", "cookie-flags", "js-secret-storage"], checks: ["pay-keys", "auth-cookies", "data-emails", "auth-guest-booking", "cr-secrets"] },
  { id: "A03", name: "Injection (SQL, XSS…)", rules: ["sql-injection", "sql-unprepared", "xss-echo-request", "stored-xss-meta", "shortcode-xss", "dom-xss", "js-eval", "reflected-xss", "csv-injection", "file-inclusion", "code-exec", "mass-extract", "fuzz-db-error"], checks: ["xss-traveller", "xss-enquiry", "xss-review", "xss-search", "xss-admin", "csv-injection", "email-header", "cr-sql", "cr-output", "cr-input"] },
  { id: "A04", name: "Insecure design (business logic)", rules: ["client-trusted-price", "booking-status-from-request", "unrestricted-upload", "fuzz-slow"], checks: ["price-cart", "price-negative", "price-huge", "price-package", "price-date", "price-capacity", "price-currency", "price-deposit", "price-extras", "coupon-reuse", "coupon-expired", "coupon-guess", "coupon-stack", "upload-php", "upload-size", "cr-money", "cr-logic"] },
  { id: "A05", name: "Security misconfiguration", rules: ["security-headers", "server-version", "debug-log-exposed", "env-exposed", "config-backup-exposed", "git-exposed", "dir-listing", "phpinfo-exposed", "error-log-exposed", "php-error-disclosure", "direct-file-access", "debug-leftover", "wp-readme", "phpcs-security-suppressed", "fuzz-server-error", "fuzz-php-error"], checks: ["cfg-debug", "cfg-headers", "cfg-files", "cfg-backups", "data-errors", "data-uninstall"] },
  { id: "A06", name: "Vulnerable and outdated components", rules: ["vulnerable-dependency", "version-disclosure"], checks: ["cfg-versions", "cr-deps"] },
  { id: "A07", name: "Identification and authentication failures", rules: ["user-enumeration", "author-enumeration", "xmlrpc-enabled"], checks: ["auth-bruteforce", "auth-enum", "auth-reset", "auth-logout", "auth-cookies", "auth-guest-booking", "pci-admin-2fa"] },
  { id: "A08", name: "Software and data integrity failures", rules: ["webhook-no-signature", "unsafe-unserialize"], checks: ["pay-skip", "pay-return", "pay-webhook", "pay-replay", "pay-amount", "upload-import", "cr-webhooks"] },
  { id: "A09", name: "Security logging and monitoring failures", rules: ["log-sensitive"], checks: ["log-auth", "log-payments", "log-no-secrets", "log-alerts"] },
  { id: "A10", name: "Server-side request forgery", rules: ["ssrf"], checks: ["ssrf-urls"] },
];

// ── PCI DSS 4.0: the parts a WordPress booking site with a gateway owns ─────
const PCI = [
  { id: "Req 3/4", name: "Card data isn't stored or sent through the site", rules: [], checks: ["pci-card-iframe", "log-no-secrets", "data-emails"] },
  { id: "Req 4.2", name: "Strong TLS on every page that handles payment", rules: ["no-https", "no-https-redirect", "tls-cert", "tls-old-protocol", "cookie-flags"], checks: ["cfg-headers"] },
  { id: "Req 6.2", name: "Secure coding (no injection, access-control or integrity flaws)", rules: ["sql-injection", "xss-echo-request", "client-trusted-price", "webhook-no-signature", "idor", "ajax-missing-capability"], checks: ["cr-money", "cr-webhooks", "cr-authz"] },
  { id: "Req 6.3", name: "Known vulnerabilities patched", rules: ["vulnerable-dependency", "version-disclosure"], checks: ["cfg-versions"] },
  { id: "Req 6.4.3", name: "Payment page scripts authorised and inventoried", rules: ["security-headers"], checks: ["pci-scripts"] },
  { id: "Req 7", name: "Access limited to need-to-know", rules: ["lowpriv-admin-screen", "lowpriv-rest", "anon-private-records", "lowpriv-private-records"], checks: ["role-subscriber-admin", "role-ajax", "idor-booking"] },
  { id: "Req 8", name: "Strong authentication for admin access", rules: ["xmlrpc-enabled"], checks: ["pci-admin-2fa", "auth-bruteforce", "auth-reset"] },
  { id: "Req 10", name: "Security events logged", rules: [], checks: ["log-auth", "log-payments"] },
  { id: "Req 11.6.1", name: "Unauthorised payment page changes detected", rules: [], checks: ["pci-tamper"] },
];

// ── Threat model: WP Travel Engine booking site (STRIDE) ────────────────────
// likelihood and impact on a 1–3 scale; risk = likelihood × impact.
const THREATS = [
  { id: "T1", title: "Traveller pays less than the real price", stride: "Tampering", actor: "Customer", asset: "Revenue / booking totals", entry: "Add-to-cart & checkout requests", likelihood: 3, impact: 3, rules: ["client-trusted-price"], checks: ["price-cart", "price-negative", "price-package", "price-deposit", "price-extras", "price-currency", "cr-money"] },
  { id: "T2", title: "Unpaid booking marked as paid", stride: "Spoofing", actor: "Anyone", asset: "Payment status", entry: "Gateway webhooks / return URLs", likelihood: 2, impact: 3, rules: ["webhook-no-signature", "booking-status-from-request"], checks: ["pay-skip", "pay-return", "pay-webhook", "pay-replay", "pay-amount", "cr-webhooks"] },
  { id: "T3", title: "Customer sees other customers' bookings / personal data", stride: "Information disclosure", actor: "Customer", asset: "Traveller PII (names, passports, phones)", entry: "Booking/dashboard URLs, REST API", likelihood: 3, impact: 3, rules: ["idor", "rest-anon-data", "anon-private-records", "lowpriv-private-records", "lowpriv-rest"], checks: ["idor-booking", "idor-invoice", "idor-profile", "data-api", "auth-guest-booking"] },
  { id: "T4", title: "Gateway secret keys leaked", stride: "Information disclosure", actor: "Anyone", asset: "Gateway API keys", entry: "REST settings, page source, code", likelihood: 2, impact: 3, rules: ["rest-leaks-secret", "hardcoded-secret", "env-exposed", "config-backup-exposed", "git-exposed"], checks: ["pay-keys", "cr-secrets"] },
  { id: "T5", title: "Low-permission user gets admin powers", stride: "Elevation of privilege", actor: "Customer / Subscriber", asset: "Site & settings", entry: "admin-ajax, REST, registration", likelihood: 2, impact: 3, rules: ["ajax-missing-capability", "rest-missing-permission", "rest-any-logged-in", "privilege-escalation", "option-from-request", "lowpriv-admin-screen"], checks: ["role-subscriber-admin", "role-ajax", "role-register", "cr-authz"] },
  { id: "T6", title: "Script injected through booking/enquiry forms runs for admins", stride: "Elevation of privilege", actor: "Anyone", asset: "Admin sessions", entry: "Traveller fields, enquiries, reviews", likelihood: 3, impact: 3, rules: ["stored-xss-meta", "xss-echo-request", "reflected-xss", "dom-xss", "shortcode-xss"], checks: ["xss-traveller", "xss-enquiry", "xss-review", "xss-search", "xss-admin", "cr-output", "cr-input"] },
  { id: "T7", title: "Admin tricked into changing settings (CSRF)", stride: "Tampering", actor: "External site", asset: "Settings, bookings", entry: "Admin forms / AJAX", likelihood: 2, impact: 2, rules: ["ajax-missing-nonce"], checks: ["csrf-settings", "csrf-booking"] },
  { id: "T8", title: "Database read or changed through injection", stride: "Tampering", actor: "Anyone", asset: "Whole database", entry: "Search, filters, API params", likelihood: 1, impact: 3, rules: ["sql-injection", "sql-unprepared", "fuzz-db-error"], checks: ["cr-sql"] },
  { id: "T9", title: "Server taken over through uploads or file access", stride: "Elevation of privilege", actor: "Anyone / Customer", asset: "Server", entry: "Upload fields, file params", likelihood: 1, impact: 3, rules: ["unrestricted-upload", "path-traversal", "file-inclusion", "code-exec", "unsafe-unserialize"], checks: ["upload-php", "upload-import"] },
  { id: "T10", title: "Overbooking / coupon abuse", stride: "Tampering", actor: "Customer", asset: "Capacity, discounts", entry: "Booking flow", likelihood: 2, impact: 2, rules: [], checks: ["price-capacity", "price-huge", "price-date", "coupon-reuse", "coupon-expired", "coupon-stack", "coupon-guess", "cr-logic"] },
  { id: "T11", title: "Admin account taken over by password guessing", stride: "Spoofing", actor: "Anyone", asset: "Admin accounts", entry: "wp-login, XML-RPC", likelihood: 2, impact: 3, rules: ["user-enumeration", "author-enumeration", "xmlrpc-enabled"], checks: ["auth-bruteforce", "auth-enum", "auth-reset", "pci-admin-2fa"] },
  { id: "T12", title: "Checkout data intercepted or page tampered with", stride: "Information disclosure", actor: "Network attacker / 3rd-party script", asset: "Card & traveller data in transit", entry: "HTTP, scripts on checkout", likelihood: 1, impact: 3, rules: ["no-https", "no-https-redirect", "tls-cert", "tls-old-protocol", "security-headers"], checks: ["pci-card-iframe", "pci-scripts", "pci-tamper", "auth-cookies"] },
  { id: "T13", title: "Site details leak and help attackers", stride: "Information disclosure", actor: "Anyone", asset: "Paths, versions, logs", entry: "Public files, errors", likelihood: 3, impact: 1, rules: ["debug-log-exposed", "php-error-disclosure", "dir-listing", "version-disclosure", "server-version", "phpinfo-exposed", "error-log-exposed"], checks: ["cfg-debug", "data-errors", "cfg-backups"] },
  { id: "T14", title: "Attack goes unnoticed", stride: "Repudiation", actor: "Any attacker", asset: "Ability to respond", entry: "—", likelihood: 2, impact: 2, rules: ["log-sensitive"], checks: ["log-auth", "log-payments", "log-alerts"] },
  { id: "T15", title: "Spam / denial of service through forms or API", stride: "Denial of service", actor: "Bots", asset: "Availability, inbox", entry: "Enquiry form, API", likelihood: 2, impact: 1, rules: ["fuzz-slow", "fuzz-server-error"], checks: ["cfg-rate"] },
];

/**
 * findings: open findings from the latest reports ([{ rule, title, severity, report }]),
 * results: checklist results { id: { status } }.
 */
function statusFor(control, findings, results) {
  const hits = findings.filter((f) => (control.rules || []).includes(f.rule));
  const checks = (control.checks || []).map((id) => ({ id, status: results[id]?.status || "" }));
  const failed = checks.filter((c) => c.status === "fail");
  const done = checks.filter((c) => c.status);
  let status = "untested";
  if (hits.length || failed.length) status = "found";
  else if (checks.length && done.length === checks.length) status = "pass";
  else if (done.length) status = "partial";
  return { status, findings: hits.map((f) => ({ id: f.id, title: f.title, severity: f.severity, report: f.report })), checks, done: done.length, total: checks.length };
}

function evaluate({ findings, results, checklist }) {
  const titleOf = Object.fromEntries(checklist.flatMap((g) => g.items.map((i) => [i.id, i.title])));
  const withTitles = (s) => ({ ...s, checks: s.checks.map((c) => ({ ...c, title: titleOf[c.id] || c.id })) });
  const threats = THREATS.map((t) => ({ ...t, risk: t.likelihood * t.impact, ...withTitles(statusFor(t, findings, results)) })).sort((a, b) => b.risk - a.risk);
  const owasp = OWASP.map((c) => ({ ...c, ...withTitles(statusFor(c, findings, results)) }));
  const pci = PCI.map((c) => ({ ...c, ...withTitles(statusFor(c, findings, results)) }));

  // The seven testing types: how far each has got.
  const groups = (kind) => checklist.filter((g) => (kind === "pentest" ? !g.kind && !/PCI|configuration/i.test(g.area) : kind === "config" ? /configuration/i.test(g.area) : g.kind === kind)).flatMap((g) => g.items.map((i) => i.id));
  const progress = (ids) => ({ done: ids.filter((id) => results[id]?.status).length, failed: ids.filter((id) => results[id]?.status === "fail").length, total: ids.length });
  const types = TYPES.map((t) => {
    const out = { ...t };
    if (t.checks) out.manual = progress(groups(t.checks));
    if (t.id === "vuln-scan") out.findings = findings.filter((f) => !f.file).length + findings.filter((f) => f.rule === "vulnerable-dependency").length;
    if (t.id === "code-review") out.findings = findings.filter((f) => f.file && f.rule !== "vulnerable-dependency").length;
    if (t.id === "fuzz") out.findings = findings.filter((f) => f.rule.startsWith("fuzz-")).length;
    if (t.id === "config") out.findings = findings.filter((f) => CONFIG_RULES.includes(f.rule)).length;
    if (t.id === "threat-model") out.summary = { found: threats.filter((x) => x.status === "found").length, pass: threats.filter((x) => x.status === "pass").length, total: threats.length };
    if (t.id === "audit") out.summary = { found: owasp.filter((x) => x.status === "found").length, pass: owasp.filter((x) => x.status === "pass").length, total: owasp.length };
    return out;
  });
  return { types, threats, owasp, pci };
}

module.exports = { TYPES, OWASP, PCI, THREATS, evaluate };
