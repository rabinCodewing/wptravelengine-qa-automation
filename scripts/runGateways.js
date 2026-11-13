// scripts/runGateways.js
//
// Runs tests/wpGatewayCheckout.spec.js for one or many gateways on
// WP Travel Engine, one `playwright test` process per gateway:
//
//   npm run test:all -- --only Stripe,Mollie   # just these
//   npm run test:all                           # every runnable gateway
//   npm run test:all -- --skip Adyen,Square    # everything except these
//   npm run test:all -- --headed               # watch it (headless by default)
//   npm run test:all -- --verbose              # full Playwright output per run
//   npm run test:all -- --list                 # print the plan, run nothing
//
// Strictly ONE AT A TIME. Every run sets the WPTE store currency to its
// gateway's currency, and two runs on the same site at once overwrite each
// other's currency and fail falsely. Each gateway gets its own output folder,
// test-results/<gateway>-wte/, with the screenshot and trace of a failure.
//
// Credentials: .env, then any saved in data/gateways.json → "credentials"
// (the source project's dashboard store), which win — same as its UI runs.

require("dotenv").config({ quiet: true });

const path = require("path");
const { spawn } = require("child_process");

const gatewayConfigs = require("../config/gatewayConfigs");
const gatewayStore = require("../config/gatewayStore");
const { gatewaysWithPaymentForm } = require("../config/paymentForms");

const SPEC = "tests/wpGatewayCheckout.spec.js";
const PLAYWRIGHT_CLI = require.resolve("@playwright/test/cli");
const PLATFORM = "wte";

function parseList(value, flag) {
  if (!value) throw new Error(`${flag} needs a comma-separated list of gateway names.`);
  return value.split(",").map((name) => name.trim()).filter(Boolean);
}

function parseArgs(argv) {
  const args = { only: null, skip: [], headed: false, verbose: false, list: false };
  for (let i = 0; i < argv.length; i += 1) {
    const [flag, inline] = argv[i].split(/=(.*)/s, 2);
    const value = () => (inline !== undefined ? inline : argv[++i]);
    if (flag === "--only") args.only = parseList(value(), flag);
    else if (flag === "--skip") args.skip = parseList(value(), flag);
    else if (flag === "--headed") args.headed = true;
    else if (flag === "--verbose") args.verbose = true;
    else if (flag === "--list") args.list = true;
    else throw new Error(`Unknown argument "${argv[i]}". Supported: --only, --skip, --headed, --verbose, --list`);
  }
  return args;
}

function selectGateways(args) {
  const runnable = gatewaysWithPaymentForm().filter(
    (name) => gatewayConfigs[name] && gatewayConfigs[name].runs !== false,
  );
  if (args.only) {
    const unknown = args.only.filter((name) => !gatewayConfigs[name]);
    if (unknown.length) {
      throw new Error(
        `Unknown gateway(s): ${unknown.join(", ")}. Names are case-sensitive keys of config/gatewayConfigs.js — see \`npm run gateways\`.`,
      );
    }
    return args.only.filter((name) => !args.skip.includes(name));
  }
  return runnable.filter((name) => !args.skip.includes(name)).sort((a, b) => a.localeCompare(b));
}

function runOne(gatewayName, { headed, verbose }) {
  return new Promise((resolve) => {
    const outputDir = path.posix.join("test-results", `${gatewayName.toLowerCase()}-${PLATFORM}`);
    const child = spawn(
      process.execPath,
      [PLAYWRIGHT_CLI, "test", SPEC, "--project=firefox", `--output=${outputDir}`],
      {
        cwd: path.resolve(__dirname, ".."),
        env: {
          ...process.env,
          ...gatewayStore.load().credentials,
          PAYMENT_GATEWAY: gatewayName,
          CURRENCY_PLATFORM: PLATFORM,
          PW_HEADLESS: headed ? "0" : process.env.PW_HEADLESS || "1",
        },
        stdio: verbose ? ["ignore", "pipe", "pipe"] : "ignore",
      },
    );

    if (verbose) {
      const tag = `[${gatewayName}] `;
      const pipe = (stream) => (chunk) => {
        for (const line of chunk.toString().split(/\r?\n/)) if (line.trim()) stream.write(tag + line + "\n");
      };
      child.stdout.on("data", pipe(process.stdout));
      child.stderr.on("data", pipe(process.stderr));
    }

    const startedAt = Date.now();
    child.on("error", (error) => resolve({ gatewayName, code: -1, seconds: 0, outputDir, error }));
    child.on("close", (code) => {
      resolve({ gatewayName, code, seconds: Math.round((Date.now() - startedAt) / 1000), outputDir });
    });
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const gateways = selectGateways(args);

  if (!gateways.length) throw new Error("No gateways selected.");

  if (args.list) {
    console.log(`${gateways.length} gateway(s) on WP Travel Engine:\n`);
    for (const name of gateways) {
      const config = gatewayConfigs[name];
      console.log(`  ${name.padEnd(22)} ${(config.displayName || name).padEnd(26)} ${config.defaultCurrency || config.currencies?.[0] || "-"}`);
    }
    return;
  }

  console.log(`Running ${gateways.length} gateway(s) on WP Travel Engine, one at a time — ${args.headed ? "headed" : "headless"}\n`);

  const results = [];
  for (const [index, name] of gateways.entries()) {
    process.stdout.write(`[${index + 1}/${gateways.length}] ▶ ${name} ...\n`);
    const result = await runOne(name, args);
    results.push(result);
    console.log(
      `[${index + 1}/${gateways.length}] ${result.code === 0 ? "✓ PASSED" : "✗ FAILED"}  ${name.padEnd(22)} ${String(result.seconds).padStart(5)}s   ${result.outputDir}` +
        (result.error ? `  (${result.error.message})` : ""),
    );
  }

  const failed = results.filter((r) => r.code !== 0);
  console.log(`\n${results.length - failed.length} passed, ${failed.length} failed.`);
  if (failed.length) {
    console.log(`Failed: ${failed.map((r) => r.gatewayName).join(", ")}`);
    console.log("Re-run one with output: npm run test:all -- --verbose --only <Name>");
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`\n${error.message}`);
  process.exitCode = 1;
});
