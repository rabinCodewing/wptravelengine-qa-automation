// scripts/doctor/payloads.js
//
// Detection payloads for the manual security tests: short, benign strings that
// REVEAL whether a weakness exists, not exploits that do damage. Paste one into
// the field/parameter a test names, then check the "look for" result.
//
// Each group has:
//   how     — how the weakness works, in plain language, so you understand what
//             you're testing instead of just pasting strings.
//   where   — which fields / parameters to try it in.
//   lookFor — what a VULNERABLE result looks like vs. a safe one.
//   items   — the payloads. `p` is copied as-is; an optional `label` is shown
//             instead when `p` is too long to display (e.g. 5,000 characters).
//
// Use them only on a site you own or are authorised to test (the QA site).
// Replace example.org / BURP-URL with your own request-catcher when noted.
// Nothing here steals data, runs commands or changes other users' records;
// the goal is a yes/no answer a QA can see and screenshot.

const GROUPS = [
  {
    id: "xss",
    title: "Cross-site scripting (XSS)",
    for: ["xss-traveller", "xss-enquiry", "xss-review", "xss-search", "xss-admin", "cr-output"],
    how: "The site stores or echoes your text back into a page without escaping it, so the browser treats your text as HTML/JavaScript instead of plain words. If a <script> or an onerror handler you typed actually runs, an attacker could run code in another user's browser — including an admin's.",
    where: "Text fields (traveller name, address, notes, enquiry message, search box) and URL parameters. After submitting, open EVERY place the value appears: the booking screen in wp-admin, the confirmation email, the thank-you page, the customer dashboard.",
    lookFor: "Safe: the payload shows as plain text (you literally see <img …> on the page). Vulnerable: an alert box pops up, or View Source shows your tag as real HTML, not escaped to &lt;img&gt;.",
    items: [
      { p: `<img src=x onerror=alert(document.domain)>`, note: "Classic probe. The image fails to load, so onerror runs. Works in most HTML contexts." },
      { p: `"><svg onload=alert(1)>`, note: "Closes an attribute (value=\"…\") first, then injects a tag. Try when your text lands inside a quoted attribute." },
      { p: `'><svg onload=alert(1)>`, note: "Same idea for single-quoted attributes (value='…')." },
      { p: `<script>alert(1)</script>`, note: "Only runs where inline scripts execute. Less common now, but still worth one try." },
      { p: `javascript:alert(1)`, note: "For fields used as a link/URL (website, href). Vulnerable if it becomes a clickable javascript: link." },
      { p: `{{constructor.constructor('alert(1)')()}}`, note: "For fields rendered by a JS framework (Angular/Vue-style template). Runs if the framework evaluates it." },
      { p: `<a href="#" onclick=alert(1)>x</a>`, note: "For rich-text fields filtered by wp_kses: a correct filter strips the onclick but keeps the link." },
    ],
  },
  {
    id: "sqli",
    title: "SQL injection (detection only)",
    for: ["cr-sql", "price-package"],
    how: "The site builds a database query by gluing your input straight into SQL text. A stray quote then breaks the query's syntax (an error), or a true/false condition you add changes which rows come back. These probes only DETECT that — they don't read or change data.",
    where: "Search boxes, filter parameters, and numeric ID parameters (trip, booking, package IDs) in URLs and requests.",
    lookFor: "Safe: a clean result or a tidy 'not found'. Vulnerable: a database/SQL error, an HTTP 500, or the ' version behaving differently from the plain value. If you see any of these, stop and report it — don't try to extract data.",
    items: [
      { p: `'`, note: "A single quote on its own. A database or SQL syntax error means your input reaches the query." },
      { p: `1'`, note: "A quote after a number — use in a numeric id parameter." },
      { p: `1' OR '1'='1`, note: "Always-true condition. If the page suddenly returns far more rows, the id is injectable." },
      { p: `1 AND 1=1`, note: "Should behave exactly like plain 1." },
      { p: `1 AND 1=2`, note: "Should return nothing if your value reaches the WHERE clause — compare with the line above." },
      { p: `1")`, note: "Closes a double-quote-and-parenthesis context that some queries use." },
    ],
  },
  {
    id: "traversal",
    title: "Path traversal & local file read",
    for: ["upload-php", "data-errors"],
    how: "A parameter names a file the server opens. By adding ../ steps you climb out of the intended folder and ask for a file somewhere else, like wp-config.php (which holds the database password).",
    where: "Any parameter that names a file, template, path, or download (file=, template=, path=, download=).",
    lookFor: "Safe: a clean 400/404 and no file contents. Vulnerable: the file's contents appear, or the traversal version errors differently from a normal file name.",
    items: [
      { p: `../../../../wp-config.php`, note: "Climbs up and asks for the WordPress config file." },
      { p: `../../../../../../etc/passwd`, note: "Classic Unix read test — harmless file, proves the climb works." },
      { p: `....//....//wp-config.php`, note: "Defeats a naive filter that deletes one '../' — what's left is still '../'." },
      { p: `%2e%2e%2f%2e%2e%2fwp-config.php`, note: "The same ../ but URL-encoded, to slip past a text filter." },
      { p: `php://filter/convert.base64-encode/resource=wp-config.php`, note: "A PHP stream wrapper that returns the file base64-encoded, if wrappers are allowed." },
    ],
  },
  {
    id: "ssrf",
    title: "Server-side request forgery (SSRF)",
    for: ["ssrf-urls"],
    how: "A feature makes the SERVER fetch a URL you supply. If it doesn't restrict where, you can make the server call itself or internal-only services it can reach but you can't — including a cloud server's secret metadata address.",
    where: "Fields where the server downloads a URL: import-from-URL, iCal/calendar feeds, remote image, a webhook target you can set.",
    lookFor: "Safe: internal and file:// addresses are refused. Vulnerable: your request-catcher gets a hit, or an internal/file URL returns content or a revealing error.",
    items: [
      { p: `https://BURP-URL/ssrf-test`, note: "Replace BURP-URL with your own webhook.site or Burp Collaborator address. A hit there proves the server fetched it." },
      { p: `http://127.0.0.1/`, note: "The server's own loopback — should be blocked." },
      { p: `http://169.254.169.254/latest/meta-data/`, note: "Cloud metadata address (AWS/GCP). Must be blocked — it can leak server credentials." },
      { p: `http://localhost:3306/`, note: "An internal-only service port (MySQL here)." },
      { p: `file:///etc/passwd`, note: "The file:// scheme should never be fetched." },
    ],
  },
  {
    id: "redirect",
    title: "Open redirect",
    for: ["pay-return"],
    how: "A parameter tells the site where to send you after an action (login, checkout return). If it isn't restricted to your own domain, an attacker sends a link that looks like your site but bounces the visitor to theirs — handy for phishing.",
    where: "redirect / return / next / url parameters (login redirect, checkout return URL).",
    lookFor: "Safe: you stay on your own domain (the external value is ignored). Vulnerable: you land on example.org.",
    items: [
      { p: `https://example.org`, note: "A plain external URL — the simplest test." },
      { p: `//example.org`, note: "No scheme. Browsers still treat it as external; a weak filter misses it." },
      { p: `/\\example.org`, note: "A slash-backslash trick that some parsers read as a host." },
      { p: `https://your-site.example.org.evil.example`, note: "Starts with your domain name but the real host is evil.example." },
    ],
  },
  {
    id: "template",
    title: "Template / expression injection",
    for: ["xss-admin", "data-errors"],
    how: "Your input is dropped into a template or email that gets evaluated, so instead of printing your text the engine runs it as an expression. A tiny sum is the giveaway: if 7*7 comes back as 49, the engine ran your input.",
    where: "Fields later rendered by a template or email engine (email subjects/bodies, PDF templates, any 'merge tag' field).",
    lookFor: "Safe: you see the literal text, e.g. {{7*7}}. Vulnerable: you see 49 — the maths was evaluated.",
    items: [
      { p: `{{7*7}}`, note: "Handlebars / Twig / Angular style." },
      { p: `\${7*7}`, note: "Template-literal / expression-language style (the ${…} form)." },
      { p: `<%= 7*7 %>`, note: "ERB / underscore template style." },
      { p: `#{7*7}`, note: "Ruby-ish and some PHP templaters." },
    ],
  },
  {
    id: "csv",
    title: "CSV / formula injection",
    for: ["csv-injection"],
    how: "Exports write your text straight into a cell. If the cell starts with = + - or @, Excel and Google Sheets treat it as a formula and run it when an admin opens the file — so your input becomes code on their computer.",
    where: "Any field that ends up in a CSV export (traveller name, enquiry message). Submit it, then export bookings/enquiries and open the file in Excel or Google Sheets.",
    lookFor: "Safe: the cell shows the text exactly, starting with =. Vulnerable: a live link or a computed number appears instead.",
    items: [
      { p: `=HYPERLINK("https://example.org","click")`, note: "Becomes a clickable link in the cell if run." },
      { p: `=1+1`, note: "Shows 2 instead of the text =1+1." },
      { p: `@SUM(1+1)`, note: "An @-prefixed formula — another trigger character." },
      { p: `+1+1`, note: "A + prefix also starts a formula." },
      { p: `-1+1`, note: "A - prefix too." },
    ],
  },
  {
    id: "email",
    title: "Email header injection",
    for: ["email-header"],
    how: "Your input is put into an email header (To, From, Subject). A newline character lets you add your OWN headers — like a hidden Bcc that quietly copies every message to you.",
    where: "Email and name fields on enquiry and booking forms.",
    lookFor: "Safe: the newline is rejected or stripped and no extra header takes effect. Vulnerable: an extra recipient gets a copy, or the subject/headers change.",
    items: [
      { p: `test@example.com%0ABcc:you@example.com`, note: "%0A is an encoded newline, then a Bcc header. Change you@example.com to an inbox you control." },
      { p: `test@example.com\nBcc:you@example.com`, note: "A raw newline version — send it through a proxy or a raw request, not a normal form field." },
      { p: `test@example.com%0D%0ASubject:injected`, note: "%0D%0A is a full CRLF line break, then a new Subject header." },
    ],
  },
  {
    id: "boundaries",
    title: "Boundaries & malformed values",
    for: ["price-negative", "price-huge", "cr-logic", "upload-size"],
    how: "Prices and totals should be decided by the server, not trusted from the browser. Sending odd numbers — negative, zero, fractional, enormous — tests whether the server re-checks them or just accepts what you send.",
    where: "Quantity, traveller count, price and date fields. Edit and resend the add-to-cart / checkout request with these values (DevTools → Network → Edit and Resend, or a proxy).",
    lookFor: "Safe: the server rejects them; the total never goes negative or drops, and impossible dates are refused. Vulnerable: the total changes to match your value, or the booking is accepted.",
    items: [
      { p: `-1`, note: "Negative quantity or price — can it make the total smaller?" },
      { p: `0`, note: "Zero travellers/quantity — a free or broken booking?" },
      { p: `0.5`, note: "A fractional count where only whole numbers make sense." },
      { p: `99999999999`, note: "A huge quantity — overbooking, or a number that overflows." },
      { p: `1e309`, note: "Beyond the floating-point range; becomes Infinity in some code." },
      { p: `2026-13-45`, note: "An impossible date (month 13, day 45)." },
      { p: "A".repeat(5000), label: "A … (5,000 ‘A’ characters)", note: "Copy gives the full 5,000-character string — tests how the field handles very long input." },
    ],
  },
];

module.exports = { PAYLOADS: GROUPS };
