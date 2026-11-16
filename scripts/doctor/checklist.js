// scripts/doctor/checklist.js
//
// The security tests a QA does by hand on a WP Travel Engine site: the parts a
// scanner can't do safely or can't judge (tampering with real bookings and
// payments, brute force, two-account access tests, emails, uploads…).
//
// Grouped by area, mapped to OWASP Top 10 (2021). Each item: what to do and
// what should happen. Results are saved per item in data/doctor/checklist.json
// from the Security page.
//
// Setup for most items: an Administrator, a Subscriber/customer account, a
// second customer account, a browser private window, and DevTools (Network
// tab → right-click a request → "Edit and Resend", or Burp/ZAP if you have it).

const CHECKLIST = [
  {
    area: "Booking & pricing tampering",
    owasp: "A04 Insecure design",
    items: [
      { id: "price-cart", title: "Change the price in the add-to-cart request", steps: ["Start a booking on a trip with a known price.", "In DevTools → Network find the add-to-cart call (admin-ajax.php?action=wte_add_trip_to_cart or the REST cart request).", "Edit and resend it with price/total/actual_price fields lowered (e.g. 1)."], expected: "Checkout total still shows the real price." },
      { id: "price-negative", title: "Negative or zero quantities", steps: ["Resend the add-to-cart request with travellers / pax / quantity set to -1, 0 and 0.5.", "Do the same for extra services and accommodation rooms."], expected: "Rejected; the total never goes down or negative." },
      { id: "price-huge", title: "Very large quantities", steps: ["Set travellers to 999999 or a room quantity above capacity."], expected: "Rejected by the server, not only blocked in the form." },
      { id: "price-package", title: "Swap the package / pricing category", steps: ["Pick a cheap package, then in the request change the package ID to an expensive one (or a child price category to adult)."], expected: "The price matches the package actually booked." },
      { id: "price-date", title: "Book a past, disabled or sold-out date", steps: ["Change the trip date in the request to yesterday, to a date not offered, and to a sold-out fixed departure."], expected: "Rejected." },
      { id: "price-capacity", title: "Overbook seats at the same time", steps: ["Find a departure with 1 seat left.", "Open two browsers and pay for it at the same time."], expected: "Only one booking succeeds." },
      { id: "price-currency", title: "Change the currency in the request", steps: ["With a currency switcher active, change the currency code in the checkout/payment request to one with a lower value."], expected: "The amount charged is converted correctly, or the change is rejected." },
      { id: "price-deposit", title: "Partial-payment / deposit abuse", steps: ["Choose partial payment, then edit the request so the deposit is 1% (or 'full' with the partial amount)."], expected: "The server recomputes the deposit from the settings." },
      { id: "price-extras", title: "Extra services / add-on prices from the browser", steps: ["Add an extra service (or room upgrade) and lower its price in the request."], expected: "The server uses the configured price." },
    ],
  },
  {
    area: "Coupons & discounts",
    owasp: "A04 Insecure design",
    items: [
      { id: "coupon-reuse", title: "Use a single-use coupon twice", steps: ["Apply a coupon limited to 1 use; complete a booking.", "Apply it again in a new booking (also try two tabs at once)."], expected: "Second use is rejected." },
      { id: "coupon-expired", title: "Expired / not-yet-valid / wrong-trip coupon", steps: ["Try an expired coupon, a future one, and one limited to a different trip."], expected: "Rejected." },
      { id: "coupon-guess", title: "Guess coupon codes", steps: ["Try 20+ wrong codes quickly."], expected: "Rate-limited or slowed down; codes are long and random." },
      { id: "coupon-stack", title: "Stack discounts", steps: ["Apply two coupons, or coupon + group discount, and edit the request to send the discount value directly."], expected: "Only allowed combinations; discount computed on the server; total never below 0." },
    ],
  },
  {
    area: "Payments & webhooks",
    owasp: "A08 Software and data integrity",
    items: [
      { id: "pay-skip", title: "Skip the payment step", steps: ["Start checkout, pick a gateway, then open the thank-you URL directly without paying."], expected: "Booking stays pending/unpaid." },
      { id: "pay-return", title: "Fake the gateway return URL", steps: ["After a real test payment, copy the return URL (with its query string).", "Start a new booking, abandon payment, and open the copied return URL with the new booking ID."], expected: "New booking stays unpaid." },
      { id: "pay-webhook", title: "Forge a webhook / IPN", steps: ["Find the gateway's webhook URL in its settings.", "Send it the gateway's success payload for an unpaid booking without a valid signature (curl/Postman)."], expected: "Rejected (400/401); booking unchanged." },
      { id: "pay-replay", title: "Replay a real webhook", steps: ["Resend a captured, valid webhook for another booking ID or a second time."], expected: "Ignored (IDs/amount checked, duplicates ignored)." },
      { id: "pay-amount", title: "Pay less at the gateway", steps: ["Where the amount is sent to the gateway in the browser (hosted page params, JS SDK), lower it before paying."], expected: "The booking isn't marked fully paid; the amount paid is compared on the server." },
      { id: "pay-keys", title: "Gateway keys not visible", steps: ["View page source of checkout and the settings REST responses as a non-admin."], expected: "Only publishable keys are visible; no secret keys anywhere outside the admin settings." },
    ],
  },
  {
    area: "Access control between users",
    owasp: "A01 Broken access control",
    items: [
      { id: "idor-booking", title: "Open another customer's booking", steps: ["Make bookings as customer A and B.", "As A, open your booking/thank-you/dashboard page, then change the booking ID (or key) in the URL/request to B's."], expected: "Access denied." },
      { id: "idor-invoice", title: "Another customer's invoice / receipt / PDF", steps: ["Change the ID in invoice, receipt or download links."], expected: "Access denied." },
      { id: "idor-profile", title: "Change another customer's details", steps: ["In the customer dashboard, update your profile and edit the request's user/customer ID to B's."], expected: "Only your own profile changes." },
      { id: "role-subscriber-admin", title: "Subscriber visits admin pages", steps: ["Logged in as a Subscriber, open WP Travel Engine admin URLs (bookings, settings, customers, enquiries)."], expected: "“Sorry, you are not allowed to access this page.” (The scanner checks this too when a test user is set.)" },
      { id: "role-ajax", title: "Subscriber runs admin AJAX actions", steps: ["As admin, record the admin-ajax requests made on WTE settings/booking screens.", "Replay them with the Subscriber's cookies (and a nonce from a page the Subscriber can open)."], expected: "Rejected with -1/403." },
      { id: "role-register", title: "Register as administrator", steps: ["On any registration form (WP, WTE customer signup), add role=administrator to the request."], expected: "Account gets the default role only." },
      { id: "role-draft", title: "Private / draft trips", steps: ["Create a draft or private trip; open its URL and book it as a visitor (also via REST /wp/v2/trip/<id>)."], expected: "Not visible or bookable." },
    ],
  },
  {
    area: "Forms & script injection (XSS)",
    owasp: "A03 Injection",
    items: [
      { id: "xss-traveller", title: "Traveller / billing fields", steps: ["Book with first name `<img src=x onerror=alert(1)>` and the same in address, notes and custom fields.", "Open the booking in wp-admin, the confirmation email, the thank-you page and the customer dashboard."], expected: "Shown as text everywhere; no alert." },
      { id: "xss-enquiry", title: "Enquiry form", steps: ["Send an enquiry with the payload in name, subject and message; open it in wp-admin and the admin email."], expected: "Shown as text." },
      { id: "xss-review", title: "Reviews / testimonials", steps: ["Submit a review with the payload; approve it; view the trip page."], expected: "Shown as text." },
      { id: "xss-search", title: "Search and filter URLs", steps: ["Put `\"><svg onload=alert(1)>` into trip search, destination and filter URL parameters."], expected: "No alert. (The scanner tries common ones.)" },
      { id: "xss-admin", title: "Admin-entered content shown to others", steps: ["As an Editor/Trip manager (not admin), put the payload in trip title, itinerary, FAQ, room names, extra service names."], expected: "Escaped on the front end and in the booking modal." },
      { id: "csv-injection", title: "CSV export formulas", steps: ["Book with name `=HYPERLINK(\"https://example.org\",\"x\")`; export bookings/enquiries to CSV and open in Excel."], expected: "Shown as text, not a live formula." },
      { id: "email-header", title: "Email header injection", steps: ["Put `test@example.com%0ABcc:you@example.com` in email fields of enquiry/booking forms."], expected: "Rejected; no extra recipients." },
    ],
  },
  {
    area: "CSRF (actions triggered from other sites)",
    owasp: "A01 Broken access control",
    items: [
      { id: "csrf-settings", title: "Change settings from another site", steps: ["As admin, save WTE settings and copy the request as a curl/HTML form.", "Remove the nonce field (_wpnonce/security/X-WP-Nonce) and submit it from a local HTML page while still logged in."], expected: "Rejected." },
      { id: "csrf-booking", title: "Booking status change without a nonce", steps: ["Repeat for booking status changes, deleting bookings, and sending emails from the booking screen."], expected: "Rejected." },
    ],
  },
  {
    area: "Login, accounts & sessions",
    owasp: "A07 Identification and authentication",
    items: [
      { id: "auth-bruteforce", title: "Password guessing", steps: ["Try 20 wrong passwords on wp-login.php and the WTE customer login."], expected: "Lockout, slowdown or CAPTCHA kicks in." },
      { id: "auth-enum", title: "Username/email discovery", steps: ["Compare the login and lost-password messages for an existing vs. non-existing email."], expected: "Same message for both (or this is accepted as low risk)." },
      { id: "auth-reset", title: "Password reset", steps: ["Request a reset; check the link expires, works once, and that changing the Host header doesn't change the link's domain."], expected: "Single-use, expiring link on the real domain." },
      { id: "auth-logout", title: "Logout really ends the session", steps: ["Log out, press Back, and replay a request with the old cookies."], expected: "Session invalid." },
      { id: "auth-cookies", title: "Cookie flags", steps: ["DevTools → Application → Cookies on the HTTPS site."], expected: "wordpress_logged_in / session cookies have Secure and HttpOnly." },
      { id: "auth-guest-booking", title: "Guest booking links", steps: ["Check links sent to guests (view booking, pay remaining) use long random keys, not just the booking ID."], expected: "Can't guess another guest's link." },
    ],
  },
  {
    area: "File uploads",
    owasp: "A04 Insecure design",
    items: [
      { id: "upload-php", title: "Upload a PHP file", steps: ["On any upload field (traveller documents, enquiry attachments, admin imports), upload test.php, test.php.jpg, test.phtml and an SVG with <script>."], expected: "Rejected, or stored so it can't run (open its URL: no PHP output, SVG doesn't run script)." },
      { id: "upload-size", title: "Huge files", steps: ["Upload a very large file."], expected: "Rejected with a size limit." },
      { id: "upload-import", title: "Trip / settings import", steps: ["Import a trip/settings file with edited content (script in titles, unexpected fields)."], expected: "Only admins can import; content is sanitised." },
    ],
  },
  {
    area: "Data exposure & privacy",
    owasp: "A02 / A05",
    items: [
      { id: "data-api", title: "REST API as a visitor", steps: ["In a private window, open /wp-json/ and browse the wptravelengine routes."], expected: "No customer, booking, payment or settings data. (The scanner checks this.)" },
      { id: "data-emails", title: "Email contents", steps: ["Check booking/enquiry emails don't include full card data, passwords or other customers' data."], expected: "Only the recipient's own data." },
      { id: "data-gdpr", title: "Export / erase personal data", steps: ["Use Tools → Export/Erase Personal Data for a customer email."], expected: "WTE booking/customer data is included and erased." },
      { id: "data-errors", title: "Error messages", steps: ["Break requests on purpose (missing fields, wrong types)."], expected: "Friendly errors; no PHP warnings, SQL or file paths." },
      { id: "data-uninstall", title: "Uninstall cleanup", steps: ["Deactivate and delete the add-on on a test site."], expected: "Optional cleanup works; no leftover public files with data." },
    ],
  },
  {
    area: "Server & site configuration",
    owasp: "A05 Security misconfiguration",
    items: [
      { id: "cfg-debug", title: "Debug mode off on live", steps: ["Check WP_DEBUG_DISPLAY is false and /wp-content/debug.log isn't downloadable."], expected: "Off / not downloadable. (The scanner checks the file.)" },
      { id: "cfg-versions", title: "Up to date", steps: ["Compare WordPress, WP Travel Engine and add-on versions with the latest releases and with WPScan / Patchstack advisories."], expected: "No known-vulnerable versions." },
      { id: "cfg-headers", title: "Security headers & HTTPS", steps: ["Run the scanner with the site ticked; review the headers finding."], expected: "HTTPS everywhere; clickjacking protection on." },
      { id: "cfg-rate", title: "Form spam / abuse", steps: ["Submit the enquiry form 30 times quickly."], expected: "CAPTCHA, honeypot or rate limiting stops it." },
      { id: "cfg-files", title: "File permissions & editors", steps: ["On the server (or ask hosting): wp-config.php is 440/400, uploads folder can't run PHP, DISALLOW_FILE_EDIT is true."], expected: "All three in place." },
      { id: "cfg-backups", title: "Backups not public", steps: ["Check backup plugin folders under /wp-content/ (updraft, ai1wm-backups, backups) can't be listed or downloaded."], expected: "403/404." },
    ],
  },
  {
    area: "Logging & monitoring",
    owasp: "A09 Logging and monitoring failures",
    items: [
      { id: "log-auth", title: "Failed logins and role changes are recorded", steps: ["Fail a login 5 times; change a user's role; check the activity/security log (plugin or server logs)."], expected: "Each event is recorded with time, user and IP." },
      { id: "log-payments", title: "Payment problems are recorded", steps: ["Send a webhook with a bad signature and abandon a payment; check WTE/gateway logs and the booking notes."], expected: "Rejected webhooks and failed payments are logged against the booking." },
      { id: "log-no-secrets", title: "Logs don't contain secrets", steps: ["Look through debug.log / gateway logs after a test payment."], expected: "No card numbers, CVV, passwords or full API keys." },
      { id: "log-alerts", title: "Someone is told", steps: ["Check whether admins get an email/Slack when bookings are marked paid by webhook, settings change, or many logins fail."], expected: "Alerts exist for the important events (or the risk is accepted)." },
    ],
  },
  {
    area: "Server-side requests (SSRF)",
    owasp: "A10 Server-side request forgery",
    items: [
      { id: "ssrf-urls", title: "Features that fetch a URL", steps: ["Find features where the server downloads a URL: import trip/settings from URL, iCal/calendar feeds, remote images, webhooks you can set.", "Give it a request-catcher URL first, then http://127.0.0.1/, http://169.254.169.254/ and file:///etc/passwd."], expected: "Internal addresses and file:// are refused." },
    ],
  },
  {
    area: "Payments compliance (PCI DSS)",
    owasp: "PCI DSS 4.0",
    items: [
      { id: "pci-card-iframe", title: "Card numbers never touch the WordPress server", steps: ["On checkout, inspect the card field: it must be inside the gateway's iframe or on the gateway's page.", "In DevTools → Network, pay with a test card and check no request to your own domain contains the card number."], expected: "Card data only goes to the gateway (SAQ A)." },
      { id: "pci-scripts", title: "Scripts on the payment page are known (req. 6.4.3)", steps: ["List every script loaded on the checkout page (DevTools → Sources).", "Check each one is expected (site, WTE, gateway) and that a CSP limits where scripts can come from."], expected: "No unknown third-party scripts; a CSP is in place." },
      { id: "pci-tamper", title: "Payment page changes are noticed (req. 11.6.1)", steps: ["Ask how the team would notice if the checkout page or its scripts were changed (file integrity monitoring, CSP reports)."], expected: "There's a way to detect it." },
      { id: "pci-admin-2fa", title: "Admin accounts use strong login (req. 8)", steps: ["Check admins and shop managers have two-factor login and unique accounts (no shared 'admin')."], expected: "2FA on, no shared accounts." },
    ],
  },
  {
    area: "Code review (white-box)",
    owasp: "Manual code review",
    kind: "review",
    items: [
      { id: "cr-entry-points", title: "List every entry point", steps: ["In the add-on, list all wp_ajax_*/wp_ajax_nopriv_*, register_rest_route, admin_post_*, shortcodes, form handlers on init/template_redirect, and WTE hooks that receive request data ($attributes, $posted_data)."], expected: "A complete list to review one by one (the code scan finds most)." },
      { id: "cr-authz", title: "Each entry point checks who's asking", steps: ["For every entry point: is there current_user_can() with the right capability, a nonce, and an ownership check on any ID?"], expected: "All three where they apply; nopriv handlers only do what visitors may do." },
      { id: "cr-money", title: "Follow the money", steps: ["Trace how price, discount, deposit, tax and total are computed from cart to booking to payment.", "Mark any value that comes from the request or the browser."], expected: "All amounts recomputed on the server from saved trip/settings data." },
      { id: "cr-sql", title: "Every SQL query", steps: ["Find every $wpdb call; check each variable goes through $wpdb->prepare() (and table/column names come from an allowlist)."], expected: "No variable concatenated into SQL." },
      { id: "cr-output", title: "Escaping in templates", steps: ["Read each template/admin view: every echo uses esc_html/esc_attr/esc_url/wp_kses at the point of output; React/JS uses text, not innerHTML."], expected: "Escaped late, on every output." },
      { id: "cr-input", title: "Sanitising on save", steps: ["Every saved setting/meta/option is sanitised with the right function for its type, including nested arrays."], expected: "Typed sanitising; no raw $_POST saved." },
      { id: "cr-webhooks", title: "Gateway callbacks", steps: ["For each payment callback: signature verified on the raw body with hash_equals, amount and currency compared with the booking, duplicate events ignored."], expected: "All three." },
      { id: "cr-logic", title: "Business-logic edge cases", steps: ["Look for state changes without checks: cancelling/refunding twice, booking after cut-off, changing a booking after payment, stock/seat counts that can go negative."], expected: "Each state change validates the current state." },
      { id: "cr-secrets", title: "Secrets & debug", steps: ["Search for API keys, test credentials, var_dump/print_r, error_log of request data, and disabled TLS verification (sslverify => false)."], expected: "None in shipped code." },
      { id: "cr-deps", title: "Third-party code", steps: ["Check bundled libraries (vendor/, assets/lib) are needed, up to date and loaded only where used (the library check helps)."], expected: "No outdated or unused bundled libraries." },
    ],
  },
];

module.exports = { CHECKLIST };
