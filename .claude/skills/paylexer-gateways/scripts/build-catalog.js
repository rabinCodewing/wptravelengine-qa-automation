#!/usr/bin/env node
// Builds the gateway reference for the paylexer-gateways skill from the code
// itself, so the skill never drifts from config/gatewayPaymentForms.js.
//
//   node .claude/skills/paylexer-gateways/scripts/build-catalog.js
//
// Writes references/gateways.md in this script's skill: a summary table of
// every gateway (how it pays, where, test card), then one section per gateway
// with everything extracted for it.
//
// Reads config/gatewayPaymentForms.js from the working tree; if that has no
// entries (commented out, mid-edit), it reads the committed version from git
// HEAD instead and says so. Run it from the repo root after any change to the
// payment forms or gateway configs.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const SKILL = path.resolve(__dirname, "..");
const FORMS_REL = "config/gatewayPaymentForms.js";

function loadForms() {
  const working = path.join(ROOT, FORMS_REL);
  let source = fs.readFileSync(working, "utf8");
  let origin = `${FORMS_REL} (working tree)`;
  let warning = "";
  let forms = requireFrom(source);

  if (!Object.keys(forms).length) {
    source = execSync(`git show HEAD:${FORMS_REL}`, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    forms = requireFrom(source);
    origin = `${FORMS_REL} at git HEAD`;
    warning =
      `> ⚠ The working copy of ${FORMS_REL} has no active entries (commented out or mid-edit). ` +
      "Until that changes, runs do NOT use this code: every gateway pays through its recipe or " +
      "auto-detection (config/paymentForms.js). The pages below describe the committed code.";
  }
  return { forms, source, origin, warning };
}

function requireFrom(source) {
  const file = path.join(os.tmpdir(), `gpf-${process.pid}-${Date.now()}.js`);
  fs.writeFileSync(file, source);
  try {
    return require(file) || {};
  } catch {
    return {};
  } finally {
    fs.rmSync(file, { force: true });
  }
}

function loadConfigs() {
  try {
    return require(path.join(ROOT, "config", "gatewayConfigs.js"));
  } catch {
    return {};
  }
}

const uniq = (items) => [...new Set(items.filter(Boolean))];
const all = (text, regex, group = 1) => uniq([...text.matchAll(regex)].map((m) => m[group]));

/** The source lines of one entry: from "  Name: {" to the next top-level entry. */
function entrySource(source, name) {
  const lines = source.split("\n");
  const start = lines.findIndex((line) => new RegExp(`^  ${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: \\{`).test(line));
  if (start === -1) return { text: "", start: -1, lines: 0 };
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^  [A-Za-z0-9_]+: \{/.test(lines[i]) || /^};/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return { text: lines.slice(start, end).join("\n"), start: start + 1, lines: end - start };
}

/**
 * The author's notes on the gateway: the comment block that opens the entry,
 * else the first comment blocks inside it (some entries explain themselves at
 * the top of fillCardDetails instead). Capped; the page links to the source.
 */
function leadingNotes(text) {
  const lines = text.split("\n").slice(1);
  const notes = [];
  for (const line of lines) {
    const m = line.match(/^\s*\/\/ ?(.*)$/);
    if (m) notes.push(m[1]);
    else if (line.trim() === "") continue;
    else break;
  }
  if (notes.length) return notes.join("\n").trim();

  const inner = [];
  let gap = false;
  for (const line of lines) {
    const m = line.match(/^\s*\/\/ ?(.*)$/);
    if (m) {
      if (gap && inner.length) inner.push("");
      inner.push(m[1]);
      gap = false;
    } else {
      gap = true;
    }
    if (inner.length >= 40) break;
  }
  return inner.join("\n").trim();
}

function analyse(name, entry, configs) {
  const fill = typeof entry.fillCardDetails === "function" ? entry.fillCardDetails.toString() : "";
  const submit = typeof entry.submitCardPayment === "function" ? entry.submitCardPayment.toString() : "";
  const code = `${fill}\n${submit}`;

  const constants = Object.entries(entry)
    .filter(([, value]) => typeof value !== "function")
    .map(([key, value]) => `${key} = ${JSON.stringify(value)}`);

  const urls = all(code, /["'`](https?:\/\/[^"'`\s]+)["'`]/g).filter((u) => !/example\.com/.test(u));
  const selectors = uniq([
    ...all(code, /\.locator\(\s*["'`]([^"'`]{2,160})["'`]/g),
    ...all(code, /querySelector(?:All)?\(\s*["'`]([^"'`]{2,160})["'`]/g),
  ]);
  const roles = all(code, /getByRole\(\s*["'`](\w+)["'`]\s*,\s*\{\s*name:\s*([^}]{2,80})\}/g, 0).map((m) =>
    m.replace(/\s+/g, " "),
  );
  const labels = all(code, /getBy(?:Label|Placeholder|Text)\(\s*([^)]{2,80})\)/g, 0).map((m) => m.replace(/\s+/g, " "));
  // process.env.X || "default": the default IS the test value in most entries.
  const defaults = Object.fromEntries(
    [...code.matchAll(/process\.env\.([A-Z0-9_]+)\s*\|\|\s*["'`]([^"'`]+)["'`]/g)].map((m) => [m[1], m[2]]),
  );
  const env = all(code, /process\.env\.([A-Z0-9_]+)/g).map((name) =>
    defaults[name] !== undefined ? `${name} (default "${defaults[name]}")` : name,
  );
  const helpers = all(
    code,
    /\b(waitForFrameByUrl|waitForFrameWithSelector|waitForFieldInAnyFrame|findPayNowButton|waitForSubmissionToTakeEffect|describeSubmitButtons|paymentAlreadyCompleted|waitForSubmitReadyOrCompletion|waitForDodoCheckoutPage|waitForUrlPrefix|waitForHostedRedirectOrCheckoutError|waitForFieldValue|squareModalFrame|squareCardMessage)\b/g,
  );
  const testValues = uniq(
    [...code.matchAll(/\bconst\s+([A-Z][A-Z0-9_]*)\s*=\s*["'`]([^"'`\n]{1,60})["'`]/g)]
      .filter(([, n]) => /CARD|CVC|CVV|CSC|EXP|HOLDER|NAME|OTP|PIN|PHONE|MSISDN|MOBILE|EMAIL|ZIP|POSTAL|BANK|ACCOUNT/.test(n))
      .filter(([, n]) => !/KEY|SECRET|TOKEN|PASSWORD|PASS\b/.test(n))
      .map(([, n, v]) => `${n} = "${v}"`),
  );
  const cards = uniq([
    ...all(code, /["'`]((?:\d[ -]?){13,19})["'`]/g).map((c) => c.replace(/[ -]/g, "")),
    ...constants.filter((c) => /CARD_NUMBER/.test(c)).map((c) => c.split(" = ")[1].replace(/"/g, "")),
  ]).filter((c) => /^\d{13,19}$/.test(c));

  // How it pays, from what the code DOES: comments are stripped first, since
  // the notes often mention popups or 3DS a gateway does not use.
  const bare = code.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  const traits = [];
  if (/waitForUrlPrefix|waitForURL|waitForDodoCheckoutPage|waitForHostedRedirect/.test(bare) && urls.length) traits.push("redirect to hosted page");
  if (/waitForEvent\(\s*["'`](page|popup)["'`]|\.on\(\s*["'`]popup|context\(\)\.pages\(\)/.test(bare)) traits.push("popup");
  if (/waitForFrameByUrl|waitForFrameWithSelector|waitForFieldInAnyFrame|\.frames\(\)|frameLocator|contentFrame/.test(bare)) traits.push("iframe fields");
  if (/\botp\b|\b3ds\b|3-?d ?secure|threeds|challenge|\bacs\b/i.test(bare)) traits.push("3DS / OTP");
  if (/\bstk\b|\bmpin\b|wallet|msisdn|mobile money|phone number/i.test(bare)) traits.push("wallet / phone");
  if (/pressSequentially/.test(bare)) traits.push("types key by key");
  if (!traits.length) traits.push("in-place form");

  const config = configs[name] || null;
  return {
    name,
    traits,
    urls,
    selectors,
    roles,
    labels,
    env,
    helpers,
    cards,
    testValues,
    constants,
    hasSubmit: Boolean(submit),
    config: config && {
      slug: config.slug,
      displayName: config.displayName,
      fields: (config.fields || []).map((f) => f.name),
      currencies: config.currencies || (config.defaultCurrency ? [config.defaultCurrency] : []),
      defaultCurrency: config.defaultCurrency || null,
      custom: Boolean(config.custom),
    },
  };
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** GitHub-style heading anchor for "## Name". */
const anchor = (name) => name.toLowerCase().replace(/[^a-z0-9 -]/g, "").replace(/ /g, "-");

function detailPage(a, entry) {
  const list = (title, items, fmt = (x) => `\`${x}\``) =>
    items.length ? `\n#### ${title}\n\n${items.map((i) => `- ${fmt(i)}`).join("\n")}\n` : "";
  return `## ${a.name}

Source: \`config/gatewayPaymentForms.js\` line ${entry.start} (${entry.lines} lines)
How it pays: ${a.traits.join(", ")}
${a.config ? `PayLexer name: **${a.config.displayName || a.name}**${a.config.slug ? ` · slug \`${a.config.slug}\`` : ""} · currencies ${a.config.currencies.join(", ") || "?"}${a.config.defaultCurrency ? ` (default ${a.config.defaultCurrency})` : ""}
Credential fields: ${a.config.fields.join(", ") || "—"}` : "Not in config/gatewayConfigs.js."}
${entry.notes ? `\n#### Notes from the code\n\n${entry.notes.split("\n").map((l) => `> ${l}`).join("\n")}\n` : ""}${list("Test card number(s)", a.cards)}${list("Other test values in the code", a.testValues)}${a.related.length ? `\n#### Related gateways named in its notes\n\n${a.related.map((r) => `[${r}](#${anchor(r)})`).join(", ")}\n` : ""}${list("Constants on the entry", a.constants)}${list("Environment variables read", a.env)}${list("Payment-page URLs", a.urls, (u) => `${hostOf(u)} — \`${u}\``)}${list("Selectors used", a.selectors)}${list("Role / label lookups", [...a.roles, ...a.labels])}${list("Shared helpers used", a.helpers)}
${a.hasSubmit ? "" : "\nNo submitCardPayment() — fillCardDetails() also pays.\n"}`;
}

function main() {
  const { forms, source, origin, warning } = loadForms();
  const configs = loadConfigs();
  const names = Object.keys(forms).sort((x, y) => x.localeCompare(y));
  if (!names.length) {
    console.error("No gateway entries found, even at git HEAD.");
    process.exit(1);
  }

  // Earlier layouts (a page per gateway, a separate catalog) are removed so
  // only the one generated file remains.
  fs.rmSync(path.join(SKILL, "references", "gateways"), { recursive: true, force: true });
  fs.rmSync(path.join(SKILL, "references", "catalog.md"), { force: true });
  const sections = [];

  const rows = [];
  for (const name of names) {
    const entry = entrySource(source, name);
    entry.notes = leadingNotes(entry.text);
    const a = analyse(name, forms[name], configs);
    const comments = entry.text
      .split("\n")
      .filter((line) => /^\s*(\/\/|\*)/.test(line))
      .join("\n");
    a.related = names.filter(
      (other) => other !== name && other.length > 3 && new RegExp(`\\b${other}\\b`).test(comments),
    );
    sections.push(detailPage(a, entry));
    const where = uniq(a.urls.map(hostOf)).slice(0, 2).join(", ") || "on the checkout page";
    rows.push(
      `| [${name}](#${anchor(name)}) | ${a.traits.join(", ")} | ${where} | ${a.cards[0] ? `\`${a.cards[0]}\`` : "—"} | ${entry.lines} |`,
    );
  }

  const noForm = Object.keys(configs).filter((n) => !forms[n]).sort();
  const catalog = `# Every gateway

Generated by \`scripts/build-catalog.js\` from ${origin} — ${names.length} gateways with code.
Do not edit by hand; re-run the script after changing a payment form.
${warning ? `\n${warning}\n` : ""}
The table is the index: find a gateway, or the closest one to a new gateway
(same "How it pays", ideally the same payment host), and follow its link to
its section below — notes from the code, test values, URLs, selectors.

"Test card in the code" is what the code types. A generic number (Visa
4242…/4111…) may be a fallback rather than the gateway's documented sandbox
card; the gateway's section and its notes say which. When a run declines a
filled card, get the card from the gateway's sandbox docs or merchant portal.

| Gateway | How it pays | Payment page | Test card in the code | Lines |
| --- | --- | --- | --- | --- |
${rows.join("\n")}

${noForm.length ? `Defined in config/gatewayConfigs.js (or added from the UI) with no code — these pay through a recipe or auto-detection: ${noForm.join(", ")}.\n` : ""}`;

  fs.writeFileSync(path.join(SKILL, "references", "gateways.md"), `${catalog}\n---\n\n${sections.join("\n---\n\n")}`);
  console.log(`✓ ${names.length} gateways → references/gateways.md (from ${origin})`);
}

main();
