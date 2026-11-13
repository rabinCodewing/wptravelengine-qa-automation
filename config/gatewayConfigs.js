// this config only contains gateways that require API keys, secret keys, webhooks, etc.

require("dotenv").config({ quiet: true });

const BUILT_IN = {
  Stripe: {
    fields: [
      {
        name: "Publishable Key",
        locator: "#test_publishableKeyTest",
      },
      {
        name: "Secret Key",
        locator: "#test_secretKeyTest",
      },
      {
        name: "Webhook Secret",
        locator: "#webhookSecretTest",
      },
    ],
    currencies: [
      "USD",
      "EUR",
      "GBP",
      "AUD",
      "CAD",
      "JPY",
      "CHF",
      "CNY",
      "HKD",
      "SGD",
      "SEK",
      "NOK",
      "DKK",
      "NZD",
      "MXN",
      "BRL",
      "INR",
      "ZAR",
      "AED",
      "SAR",
      "PLN",
      "CZK",
      "HUF",
      "RON",
      "TRY",
      "THB",
      "MYR",
      "IDR",
      "PHP",
      "KRW",
    ],
    defaultCurrency: "USD",
    successMessage: "Connection successful.",
  },
  Mollie: {
    fields: [
      {
        name: "API Key",
        locator: "#test_apiKeyTest",
      },
      // PayLexer: "Webhook Secret" — the webhook section of the configure page.
      { name: "Webhook Secret", locator: "#webhookSecretTest" },
    ],
    currencies: ["USD"],
    defaultCurrency: "USD",
    successMessage: "Connection successful.",
  },
  Flutterwave: {
    fields: [
      {
        name: "Public Key",
        locator: "#test_publicKeyTest",
      },
      {
        name: "Secret Key",
        locator: "#test_secretKeyTest",
      },
      {
        // Required on PayLexer's form since it moved to Flutterwave's v3 API.
        name: "Encryption Key",
        locator: "#test_encryptionKeyTest",
      },
      {
        name: "Webhook Hash",
        locator: "#secretHashTest",
      },
    ],
    currencies: ["USD"],
    defaultCurrency: "USD",
    successMessage: "Connection successful.",
  },
  Braintree: {
    fields: [
      {
        name: "Merchant ID",
        locator: "#test_merchantIdTest",
      },
      {
        name: "Public Key",
        locator: "#test_publicKeyTest",
      },
      {
        name: "Private Key",
        locator: "#test_privateKeyTest",
      },
    ],
    currencies: ["USD"],
    defaultCurrency: "USD",
    successMessage: "Connection successful.",
  },
  Airwallex: {
    fields: [
      {
        name: "Client ID",
        locator: "#test_clientIdTest",
      },
      {
        name: "API Key",
        locator: "#test_apiKeyTest",
      },
      {
        name: "Account ID",
        locator: "#test_linkedPaymentAccountIdTest",
      },
      {
        name: "Webhook Secret",
        locator: "#webhookSecretTest",
      },
    ],
    currencies: ["USD"],
    defaultCurrency: "USD",
    successMessage: "Connection successful.",
  },
  //2nd
  Authorize: {
    fields: [
      {
        name: "API Login ID",
        locator: "#test_apiLoginIdTest",
      },
      {
        name: "Transaction Key",
        locator: "#test_transactionKeyTest",
      },
      {
        name: "Public Client Key",
        locator: "#test_publicClientKeyTest",
      },
      {
        name: "Signature Key",
        locator: "#webhookSecretTest",
      },
    ],
    currencies: ["USD"],
    defaultCurrency: "USD",
    displayName: "Authorize.Net", // exact on-screen text
    successMessage: "Connection successful.",
  },
  GoCardless: {
    fields: [
      {
        name: "Access Token",
        locator: "#test_accessTokenTest",
      },
      {
        name: "Webhook Secret",
        locator: "#webhookSecretTest",
      },
    ],
    currencies: ["USD"],
    defaultCurrency: "USD",
    successMessage: "Connection successful.",
  },
  Midtrans: {
    fields: [
      {
        name: "Server Key",
        locator: "#test_serverKeyTest",
      },
      {
        name: "Client Key",
        locator: "#test_clientKeyTest",
      },
    ],
    currencies: ["IDR"],
    defaultCurrency: "IDR",
    successMessage: "Connection successful.",
  },
  Moyasar: {
    fields: [
      {
        name: "Publishable Key",
        locator: "#test_publishableKeyTest",
      },
      {
        name: "Secret Key",
        locator: "#test_secretKeyTest",
      },
      {
        name: "Webhook Secret",
        locator: "#webhookSecretTest",
      },
    ],
    currencies: ["SAR"],
    defaultCurrency: "SAR",
    successMessage: "Connection successful.",
  },
  Paddle: {
    fields: [
      {
        name: "API Key",
        locator: "#test_apiKeyTest",
      },
      {
        name: "Client Token",
        locator: "#test_clientTokenTest",
      },
      {
        name: "Webhook Secret",
        locator: "#webhookSecretTest",
      },
    ],
    currencies: ["USD"],
    defaultCurrency: "USD",
    successMessage: "Connection successful.",
  },
  //3rd
  PayFast: {
    fields: [
      {
        name: "Merchant ID",
        locator: "#test_merchantIdTest",
      },
      {
        name: "Merchant Key",
        locator: "#test_merchantKeyTest",
      },
      {
        name: "Passphrase",
        locator: "#test_passphraseTest",
      },
    ],
    currencies: ["ZAR"],
    defaultCurrency: "ZAR",
    successMessage: "Connection successful.",
  },
  Paystack: {
    fields: [
      {
        name: "Secret Key",
        locator: "#test_publicKeyTest",
      },
      {
        name: "Public Key",
        locator: "#test_secretKeyTest",
      },
      {
        name: "Webhook Secret",
        locator: "#webhookSecretTest",
      },
    ],
    currencies: ["GHS", "NGN"],
    defaultCurrency: "GHS",
    successMessage: "Connection successful.",
  },

  Revolut: {
    fields: [
      {
        name: "Secret Key",
        locator: "#test_publicKeyTest",
      },
      {
        name: "Public Key",
        locator: "#test_secretKeyTest",
      },
    ],
    updateSecret: true,
    currencies: ["USD"],
    defaultCurrency: "USD",
    successMessage: "Connection successful.",
  },
  Square: {
    fields: [
      {
        name: "Access Token",
        locator: "#test_applicationIdTest",
      },
      {
        name: "Application ID",
        locator: "#test_accessTokenTest",
      },
      {
        name: "Location ID",
        locator: "#test_locationIdTest",
      },
      {
        name: "Webhook Secret",
        locator: "#webhookSecretTest",
      },
    ],
    currencies: ["USD"],
    defaultCurrency: "USD",
    successMessage: "Connection successful.",
  },

  Xendit: {
    fields: [
      {
        name: "Secret Key",
        locator: "#test_secretKeyTest",
      },
      {
        name: "Public Key",
        locator: "#test_publicKeyTest",
      },
      {
        name: "Webhook Token",
        locator: "#webhookSecretTest",
      },
    ],
    currencies: ["USD"],
    defaultCurrency: "USD",
    successMessage: "Connection successful.",
  },
  //4th
  Adyen: {
    fields: [
      {
        name: "API Key",
        locator: "#test_apiKeyTest",
      },
      {
        name: "Merchant Account",
        locator: "#test_merchantAccountTest",
      },
      {
        name: "Client Key",
        locator: "#test_clientKeyTest",
      },
      {
        name: "HMAC Key",
        locator: "#webhookSecretTest",
      },
    ],
    currencies: ["USD"],
    defaultCurrency: "USD",
    successMessage: "Connection successful.",
  },
  AmwalPay: {
    fields: [
      {
        name: "Merchant ID",
        locator: "#test_merchantIdTest",
      },
      {
        name: "Terminal ID",
        locator: "#test_terminalIdTest",
      },
      {
        name: "Secret Key",
        locator: "#test_secretKeyTest",
      },
    ],
    currencies: ["OMR"],
    defaultCurrency: "OMR",
    successMessage: "Connection successful.",
  },
  DOKU: {
    fields: [
      {
        name: "Client ID",
        locator: "#test_clientIdTest",
      },
      {
        name: "Secret Key",
        locator: "#test_secretKeyTest",
      },
    ],
    currencies: ["IDR"],
    defaultCurrency: "IDR",
    successMessage: "Connection successful.",
  },
  PayHere: {
    fields: [
      // All four in the order the form renders them. The names drive the .env
      // lookup in fillCredentials() (PAYHERE_ + name uppercased, spaces to
      // underscores), so "Merchant ID" must stay exactly that to reach
      // PAYHERE_MERCHANT_ID — renaming it to "Merchant Id" still works, but
      // "MerchantID" would resolve to PAYHERE_MERCHANTID and silently skip.
      {
        name: "Merchant ID",
        locator: "#test_merchantIdTest",
      },
      {
        name: "Merchant Secret",
        locator: "#test_merchantSecretTest",
      },
      {
        name: "App ID",
        locator: "#test_appIdTest",
      },
      {
        name: "App Secret",
        locator: "#test_appIdSecretTest",
      },
    ],
    currencies: ["USD"],
    defaultCurrency: "USD",
    successMessage: "Connection successful.",
  },

  //5th

  Checkout: {
    fields: [
      {
        name: "Secret Key",
        locator: "#test_secretKeyTest",
      },
      {
        name: "Public Key",
        locator: "#test_publicKeyTest",
      },
      {
        name: "Processing Channel ID",
        locator: "#test_processingChannelIdTest",
      },
      {
        name: "API Base URL",
        locator: "#test_apiBaseUrlTest",
      },
      {
        name: "Webhook Signature Key",
        locator: "#webhookSecretTest",
      },
    ],
    currencies: ["USD"],
    defaultCurrency: "USD",
    successMessage:
      "Connection successful. Your Checkout.com credentials are valid.",
    // Exact on-screen text on WP's Payments > General — differs from the object
    // key "Checkout". This is what gatewayRow() matches the row's own text on.
    displayName: "Checkout.com",
    // The row's logo alt — <img alt="Checkout.com" src=".../logo/checkout-com.svg">.
    // Read by CurrencySettingsPage.changeCurrency(), which matches img[alt="…"]
    // EXACTLY (case-sensitive), so an alt that doesn't read the same as the
    // display name has to be stated here or that lookup waits out its full 30s
    // on a row that's plainly on screen. Omit the field when the two agree —
    // callers fall back to displayName.
    logoAlt: "Checkout.com",
    slug: "checkout-com", // matches the toggle checkbox's label for="pg_checkout-com"
  },
  Culqi: {
    slug: "culqi",
    displayName: "Culqi",
    fields: [
      {
        name: "Secret Key",
        locator: "#test_secretKeyTest",
      },
      {
        name: "Public Key",
        locator: "#test_publicKeyTest",
      },
    ],
    currencies: ["USD"],
    defaultCurrency: "USD",
    successMessage: "Connection successful.",
  },
  Viva: {
    fields: [
      {
        name: "Merchant ID",
        locator: "#test_merchantIdTest",
      },
      {
        name: "API Key",
        locator: "#test_apiKeyTest",
      },
      {
        name: "Client ID",
        locator: "#test_clientIdTest",
      },
      {
        name: "Client Secret",
        locator: "#test_clientSecretTest",
      },
      {
        name: "Source Code",
        locator: "#test_sourceCodeTest",
      },
    ],
    currencies: ["GBP"],
    defaultCurrency: "GBP",
    successMessage: "Connection successful.Your viva credentials are valid.",
  },
  HitPay: {
    fields: [
      {
        name: "API Key",
        locator: "#test_apiKeyTest",
      },
      {
        name: "Webhook Salt",
        locator: "#test_eventWebhookSaltTest",
      },
    ],
    currencies: ["INR"],
    defaultCurrency: "INR",
    successMessage: "Connection successful.",
  },
  Westpac: {
    fields: [
      {
        name: "Public Key",
        locator: "#test_publishableKeyTest",
      },
      {
        name: "Secret Key",
        locator: "#test_secretKeyTest",
      },
      {
        name: "Merchant ID",
        locator: "#test_merchantIdTest",
      },
    ],
    currencies: ["AUD"],
    defaultCurrency: "AUD",
    successMessage: "Connection successful.",
    displayName: "Westpac PayWay", // exact on-screen text — differs from the object key "WestpacPayWay"
    slug: "westpac-payway", // matches the toggle checkbox's label for="pg_westpac-payway"
  },
  //6th
  Iyzico: {
    fields: [
      {
        name: "API Key",
        locator: "#test_apiKeyTest",
      },
      {
        name: "Secret Key",
        locator: "#test_secretKeyTest",
      },
      {
        name: "Webhook Secret",
        locator: "#webhookSecretTest",
      },
    ],
    currencies: ["GBP"],
    defaultCurrency: "GBP",
    successMessage: "Connection successful. Your iyzico credentials are valid.",
  },
  Omise: {
    fields: [
      {
        name: "Public Key",
        locator: "#test_publicKeyTest",
      },
      {
        name: "Secret Key",
        locator: "#test_secretKeyTest",
      },
      {
        name: "Webhook Secret",
        locator: "#webhookSecretTest",
      },
    ],
    currencies: ["JPY"],
    defaultCurrency: "JPY",
    successMessage: "Connection successful. Your Omise credentials are valid.",
  },
  SumUp: {
    fields: [
      {
        name: "API Key",
        locator: "#test_apiKeyTest",
      },
      {
        name: "Merchant Code",
        locator: "#test_merchantCodeTest",
      },
    ],
    currencies: ["USD"],
    defaultCurrency: "USD",
    successMessage: "Connection successful. Your SumUp credentials are valid.",
  },
  Eway: {
    fields: [
      {
        name: "API Key",
        locator: "#test_apiKeyTest",
      },
      {
        name: "API Password",
        locator: "#test_apiPasswordTest",
      },
    ],
    currencies: ["AUD"],
    defaultCurrency: "AUD",
    successMessage: "Connection successful. Your Eway credentials are valid.",
  },
  openpay: {
    fields: [
      {
        name: "Merchant ID",
        locator: "#test_merchantIdTest",
      },
      {
        name: "Private Key",
        locator: "#test_privateKeyTest",
      },
      {
        name: "Public Key",
        locator: "#test_publicKeyTest",
      },
      {
        name: "Region",
        locator: "#webhookBasicAuthTest",
      },
      {
        name: "Webhook Secret",
        locator: "#webhookSecretTest",
      },
    ],
    currencies: ["USD"],
    defaultCurrency: "USD",

    successMessage: "Openpay MX credentials verified successfully",
  },

  //7th
  Nets: {
    fields: [
      {
        name: "Secret Key",
        locator: "#test_secretKeyTest",
      },
    ],
    currencies: ["EUR"],
    defaultCurrency: "EUR",

    successMessage: "Connection successful. Your Nets credentials are valid.",
  },
  ToyyibPay: {
    fields: [
      {
        name: "Secret Key",
        locator: "#test_secretKeyTest",
      },
      {
        name: "Category Code",
        locator: "#test_categoryCodeTest",
      },
    ],
    currencies: ["MYR"],
    defaultCurrency: "MYR",
    successMessage:
      "Connection successful. Your ToyyibPay credentials are valid.",
  },
  MyFatoorah: {
    fields: [
      {
        name: "API Key",
        locator: "#test_apiKeyTest",
      },
      // PayLexer: "Webhook Secret" — the webhook section of the configure page.
      { name: "Webhook Secret", locator: "#webhookSecretTest" },
    ],
    currencies: ["KWD"],
    defaultCurrency: "KWD",

    successMessage:
      "Connection successful. Your MyFatoorah credentials are valid.",
  },
  PayU: {
    fields: [
      {
        name: "Merchant Key",
        locator: "#test_merchantKeyTest",
      },
      {
        name: "Salt",
        locator: "#test_saltTest",
      },
    ],
    displayName: "PayU",
    currencies: ["INR"],
    defaultCurrency: "INR",
    successMessage: "Your PayU Merchant Key and Salt are valid.",
  },
  Conekta: {
    fields: [
      {
        name: "API Key",
        locator: "#test_apiKeyTest",
      },
      {
        name: "Public Key",
        locator: "#test_publicKeyTest",
      },
      {
        name: "Webhook Secret",
        locator: "#webhookSecretTest",
      },
    ],
    currencies: ["MXN"],
    defaultCurrency: "MXN",
    successMessage: "Connection successful. Conekta credentials are valid.",
  },

  //8th
  MercadoPago: {
    fields: [
      {
        name: "Access Token",
        locator: "#test_accessTokenTest",
      },
      {
        name: "Public Key",
        locator: "#test_publicKeyTest",
      },
      // PayLexer: "Webhook Secret" — the webhook section of the configure page.
      { name: "Webhook Secret", locator: "#webhookSecretTest" },
    ],
    currencies: ["BRL"],
    defaultCurrency: "BRL",

    successMessage:
      "Connection successful. MercadoPago account LUCASMAIAST (site MLB).",
  },
  Dodo: {
    fields: [
      {
        name: "API Key",
        locator: "#test_apiKeyTest",
      },
      {
        name: "Publishable Key",
        locator: "#test_publishableKeyTest",
      },
      {
        name: "Webhook Secret",
        locator: "#webhookSecretTest",
      },
    ],
    currencies: ["USD"],
    defaultCurrency: "USD",
    successMessage:
      "Connection successful. Your Dodo Payments credentials are valid.",
    displayName: "Dodo Payments", // exact on-screen text — matches label text, used for toggleGateway() text matching since no slug exists
  },
  NinePay: {
    fields: [
      {
        name: "Merchant Key",
        locator: "#test_merchantKeyTest",
      },
      {
        name: "Secret Key",
        locator: "#test_secretKeyTest",
      },
      {
        name: "Checksum Key",
        locator: "#test_checksumKeyTest",
      },
    ],
    currencies: ["VND"],
    defaultCurrency: "VND",
    successMessage: "Connection successful. Your 9Pay credentials are valid.",
    displayName: "9Pay", // exact on-screen text
    slug: "9pay", // matches the toggle checkbox's label for="pg_9pay"
  },
  Khalti: {
    fields: [
      {
        name: "Live Secret Key",
        locator: "#test_secretKeyLive",
      },
    ],
    currencies: ["NPR"],
    defaultCurrency: "NPR",
    successMessage: "Connection successful. Your Khalti credentials are valid.",
  },
  Getnet: {
    fields: [
      {
        name: "Client ID",
        locator: "#test_clientIdTest",
      },
      {
        name: "Client Secret",
        locator: "#test_clientSecretTest",
      },
      {
        name: "Seller ID",
        locator: "#test_sellerIdTest",
      },
    ],
    currencies: ["BRL"],
    defaultCurrency: "BRL",
    successMessage: "Getnet credentials are valid.",
  },
  //9th

  PinPayments: {
    slug: "pin_payments",
    displayName: "Pin Payments",
    fields: [
      {
        name: "Secret Key",
        locator: "#test_secretKeyTest",
      },
      {
        name: "Publishable Key",
        locator: "#test_publishableKeyTest",
      },
      {
        name: "Webhook Secret",
        locator: "#webhookSecretTest",
      },
    ],
    currencies: ["USD"],
    defaultCurrency: "USD",
    successMessage: "Pin Payments credentials are valid.",
  },
  Braintree: {
    slug: "braintree",
    displayName: "Braintree",
    fields: [
      // TODO: confirm ids — the screenshot shows the labels but not the markup.
      {
        name: "Merchant ID",
        locator: "#test_merchantIdTest",
      },
      {
        name: "Public Key",
        locator: "#test_publicKeyTest",
      },
      {
        name: "Private Key",
        locator: "#test_privateKeyTest",
      },
    ],
    currencies: ["USD"],
    defaultCurrency: "USD",
    successMessage:
      "Connection successful. Your Braintree credentials are valid.",
  },
  MPesa: {
    slug: "mpesa",
    displayName: "M-Pesa",
    fields: [
      // TODO: confirm ids — screenshot shows rendered labels, not markup.
      {
        name: "Consumer Key",
        locator: "#test_consumerKeyTest",
      },
      {
        name: "Consumer Secret",
        locator: "#test_consumerSecretTest",
      },
      {
        name: "Shortcode",
        locator: "#test_shortcodeTest",
      },
      {
        name: "Passkey",
        locator: "#test_passkeyTest",
      },
    ],
    currencies: ["KES"],
    defaultCurrency: "KES",
    successMessage: "Connection successful. Your M-Pesa credentials are valid.",
  },
  Fatora: {
    slug: "fatora",
    displayName: "Fatora",
    fields: [
      {
        name: "API Key",
        locator: "#test_apiKeyTest",
      },
    ],
    currencies: ["QAR", "USD"],
    defaultCurrency: "QAR",
    successMessage: "Connection successful. Your Fatora credentials are valid.",
  },
  ProtectedPaymentService: {
    slug: "protected_payment_services",
    displayName: "Protected Payment Services",
    fields: [
      {
        name: "Merchant ID",
        locator: "#test_merchantIdTest",
      },
      {
        name: "Signing Secret",
        locator: "#test_signingSecretTest",
      },
      // The Hosted / Direct Integration URL fields (#test_hostedUrlTest,
      // #test_directUrlTest) are left out on purpose — the sandbox form ships
      // them pre-filled with the standard endpoints, so there is nothing for
      // the run to supply.
    ],
    currencies: ["USD"],
    defaultCurrency: "USD",
    successMessage:
      "Connection successful. Your Protected Payment Service credentials are valid.",
  },

  //10th

  PayJP: {
    slug: "payjp",
    displayName: "Pay.jp",
    fields: [
      {
        name: "Secret Key",
        locator: "#test_secretKeyTest",
      },
      {
        // Pay.jp's webhook field drops the "Test" suffix other gateways use.
        name: "Webhook Secret",
        locator: "#webhookSecret",
      },
    ],
    currencies: ["JPY"],
    defaultCurrency: "JPY",
    successMessage: "Connection successful. Your Pay.jp credentials are valid.",
  },
  Barion: {
    slug: "barion",
    displayName: "Barion",
    fields: [
      {
        name: "POSKey",
        locator: "#test_posKeyTest",
      },
      // The payee email field (#test_payeeEmailTest) is left out on purpose —
      // the sandbox form ships it readonly and pre-filled with the registered
      // shop email, so there is nothing for the run to supply.
    ],
    currencies: ["HUF"],
    defaultCurrency: "HUF",
    successMessage: "Connection successful. Your Barion credentials are valid.",
  },
  Safepay: {
    slug: "safepay",
    displayName: "Safepay",
    fields: [
      {
        name: "Public Key",
        locator: "#test_publicKeyTest",
      },
      {
        name: "Secret Key",
        locator: "#test_secretKeyTest",
      },
      {
        // Same as Stripe: the webhook field's id carries no "test_" prefix.
        name: "Webhook Secret",
        locator: "#webhookSecretTest",
      },
    ],
    currencies: ["PKR"],
    defaultCurrency: "PKR",
    successMessage:
      "Connection successful. Your Safepay credentials are valid.",
  },
  Tpay: {
    slug: "tpay",
    displayName: "Tpay",
    fields: [
      {
        name: "Client ID",
        locator: "#test_clientIdTest",
      },
      {
        name: "Client Secret",
        locator: "#test_clientSecretTest",
      },
      {
        // Same as Stripe: the webhook field's id carries no "test_" prefix.
        name: "Webhook Secret",
        locator: "#webhookSecretTest",
      },
    ],
    currencies: ["PLN"],
    defaultCurrency: "PLN",
    successMessage: "Connection successful. Your Tpay credentials are valid.",
  },
  Komoju: {
    slug: "komoju",
    displayName: "Komoju",
    fields: [
      {
        name: "Secret Key",
        locator: "#test_secretKeyTest",
      },
      {
        // Same as Stripe: the webhook field's id carries no "test_" prefix.
        name: "Webhook Secret",
        locator: "#webhookSecretTest",
      },
    ],
    currencies: ["JPY"],
    defaultCurrency: "JPY",
    successMessage: "Connection successful. Your Komoju credentials are valid.",
  },
  //11th
  Datatrans: {
    slug: "datatrans",
    displayName: "Datatrans",
    fields: [
      {
        // Placeholder reads "Enter Username", but the id and Datatrans' own
        // docs both call it the merchant id — the name is what derives the env
        // key, so this is DATATRANS_MERCHANT_ID, not DATATRANS_USERNAME.
        name: "Merchant ID",
        locator: "#test_merchantIdTest",
      },
      {
        name: "Password",
        locator: "#test_passwordTest",
      },
      {
        // Same as Stripe: the webhook field's id carries no "test_" prefix.
        // Labelled "Enter HMAC Key" here rather than a webhook secret, so the
        // env key is DATATRANS_HMAC_KEY.
        name: "HMAC Key",
        locator: "#webhookSecretTest",
      },
    ],
    currencies: ["CHF"],
    defaultCurrency: "CHF",
    // Book this specific trip instead of the first priced one on the archive.
    // Matched case-insensitively against the listing's link text, so the full
    // on-screen title doesn't have to be spelled out here.
    trip: "Chandol",
    successMessage:
      "Connection successful. Your Datatrans credentials are valid.",
  },
  CostPlus: {
    // Object key stays alphanumeric so the env prefix derives cleanly as
    // COSTPLUS_ — the "+" would collapse to a trailing underscore and give
    // COST__API_KEY. The on-screen name keeps the "+".
    displayName: "Cost+",
    // No `slug` yet: the toggle's label[for="pg_{slug}"] hasn't been read off
    // the settings screen, and a wrong slug hard-fails the toggle step. Add it
    // once confirmed.
    fields: [
      {
        name: "API Key",
        locator: "#test_apiKeyTest",
      },
    ],
    currencies: ["HUF"],
    defaultCurrency: "HUF",
    successMessage: "Connection successful.",
  },
  Paytrail: {
    fields: [
      {
        name: "Merchant ID",
        locator: "#test_merchantIdTest",
      },
      {
        name: "Secret Key",
        locator: "#test_secretKeyTest",
      },
    ],
    currencies: ["EUR"],
    defaultCurrency: "EUR",
    successMessage: "Connection successful.",
  },
  Finix: {
    fields: [
      {
        name: "Username",
        locator: "#test_usernameTest",
      },
      {
        name: "Password",
        locator: "#test_passwordTest",
      },
      {
        // Finix's merchant id field expects the username and password joined
        // with a colon (USotu…:dbbe…), not a separate id — kept as its own env
        // var so the pair stays copy-pasteable from the dashboard.
        name: "Merchant ID",
        locator: "#test_merchantIdTest",
      },
    ],
    currencies: ["USD"],
    defaultCurrency: "USD",
    successMessage: "Connection successful. Your Finix credentials are valid.",
  },
  SSLCommerz: {
    slug: "sslcommerz",
    displayName: "SSLCommerz",
    fields: [
      {
        name: "Store ID",
        locator: "#test_storeIdTest",
      },
      {
        // SSLCommerz's sandbox store password is the store id with an "@ssl"
        // suffix, which is how their dashboard issues it — it is NOT a
        // separately-chosen password, so the two env values look near-identical
        // on purpose.
        name: "Store Password",
        locator: "#test_storePasswordTest",
      },
    ],
    // SSLCommerz is Bangladesh-only and settles in BDT alone, so the currency
    // step has just the one option.
    currencies: ["BDT"],
    defaultCurrency: "BDT",
    // Matched with includes(), so the shared prefix is enough and this doesn't
    // depend on PayLexer's exact per-gateway wording.
    successMessage: "Connection successful.",
  },
  //12th
  BlueSnap: {
    slug: "bluesnap",
    displayName: "BlueSnap",
    fields: [
      {
        name: "API Username",
        locator: "#test_apiUsernameTest",
      },
      {
        name: "API Password",
        locator: "#test_apiPasswordTest",
      },
      {
        name: "Merchant ID",
        locator: "#test_merchantIdTest",
      },
      {
        name: "Store ID",
        locator: "#test_storeIdTest",
      },
      {
        // Note the id: #webhookSecretTest, NOT #test_webhookSecretTest. This
        // field breaks the test_<name>Test pattern the other four follow —
        // the same quirk Pay.jp's webhook field has (#webhookSecret).
        name: "Webhook Secret",
        locator: "#webhookSecretTest",
      },
    ],
    currencies: ["USD"],
    defaultCurrency: "USD",
    successMessage:
      "Connection successful. Your BlueSnap credentials are valid.",
  },

  DPO: {
    slug: "dpo",
    displayName: "DPO Pay",
    fields: [
      {
        name: "Company Token",
        locator: "#test_companyTokenTest",
      },
      {
        // DPO's "service type" is an account-level numeric service code from
        // the DPO dashboard, not a mode or a category — it identifies which
        // configured service the charge is billed against.
        name: "Service Type",
        locator: "#test_serviceTypeTest",
      },
    ],
    currencies: ["USD"],
    defaultCurrency: "USD",
    // Book this specific trip instead of the first priced one on the archive.
    // Matched case-insensitively against the listing's link text, so the full
    // on-screen title ("Chandol Base Camp Trek") doesn't have to be spelled out.
    trip: "Chandol",
    successMessage: "Connection successful.",
  },
  GetPayin: {
    slug: "getpayin",
    displayName: "GetPayin",
    fields: [
      {
        // Both tokens are 60-char opaque strings issued together from the
        // GetPayin dashboard — the auth token identifies the merchant, the hash
        // token signs the request. Neither is derived from the other, so they
        // are two separate env values despite looking alike.
        name: "Auth Token",
        locator: "#test_authTokenTest",
      },
      {
        // Rendered as type="password" behind an eye toggle, and the input
        // carries readonly="" until PayLexer hydrates it. fillCredentials()
        // already reads readOnly/disabled before typing and clears the field
        // first, so no toggle click is needed — the value goes in regardless of
        // whether the eye has been clicked.
        name: "Hash Token",
        locator: "#test_hashTokenTest",
      },
    ],
    currencies: ["USD"],
    defaultCurrency: "USD",
    successMessage:
      "Connection successful. Your GetPayin credentials are valid.",
  },
  FastSpring: {
    slug: "fastspring",
    displayName: "FastSpring",
    fields: [
      {
        // The storefront subdomain, not a numeric id — "paylexer" stands for
        // paylexer.test.onfastspring.com.
        name: "Store ID",
        locator: "#test_storeIdTest",
      },
      {
        name: "API Username",
        locator: "#test_apiUsernameTest",
      },
      {
        // type="password" behind an eye toggle. fillCredentials() strips the
        // readonly attribute and clears the field before typing, so the toggle
        // never has to be clicked.
        name: "API Password",
        locator: "#test_apiPasswordTest",
      },
      {
        // The popup storefront's path (e.g. "defaultB2B"), i.e. the suffix
        // after "popup-" in the storefront URL.
        name: "Popup Checkout Path",
        locator: "#test_popupCheckoutPathTest",
      },
      {
        // Same quirk as BlueSnap/Pay.jp: the webhook field sits outside the
        // test_<name>Test group, so it is #webhookSecretTest.
        name: "Webhook Secret",
        locator: "#webhookSecretTest",
      },
    ],
    trip: "Chandol",
    currencies: ["AUD"],
    defaultCurrency: "AUD",
    successMessage:
      "Connection successful. Your FastSpring credentials are valid.",
  },
  Fonepay: {
    slug: "fonepay",
    displayName: "Fonepay",
    fields: [
      {
        // Merchant portal login, not an API key — Fonepay authenticates the
        // merchant with username/password and signs each request with the RSA
        // key below.
        name: "Username",
        locator: "#test_usernameTest",
      },
      {
        // type="password" behind an eye toggle, and carries readonly="" until
        // PayLexer hydrates it. fillCredentials() reads readOnly/disabled and
        // clears the field before typing, so the toggle never has to be
        // clicked.
        name: "Password",
        locator: "#test_passwordTest",
      },
      {
        // 16-digit terminal id issued per merchant outlet (e.g.
        // 4271423331147924) — a numeric string, so it must stay quoted in .env
        // to keep any leading zero.
        name: "Terminal ID",
        locator: "#test_terminalIdTest",
      },
      {
        // Base64 PKCS#8 body of the merchant's RSA private key, WITHOUT the
        // -----BEGIN/END PRIVATE KEY----- armour and without newlines — one
        // long single-line value. type="password" and readonly="" like the
        // password field above.
        name: "RSA Private Key",
        locator: "#test_privateKeyTest",
      },
    ],
    // Fonepay is Nepal-only: NPR is the sole settlement currency.
    currencies: ["NPR"],
    defaultCurrency: "NPR",
    successMessage:
      "Connection successful. Your Fonepay credentials are valid.",
  },
  //13th
  MultiSafepay: {
    slug: "multisafepay",
    displayName: "MultiSafepay",
    fields: [
      {
        // Single 40-char hex site API key from the MultiSafepay dashboard
        // (Settings → Website settings). type="password" behind an eye toggle
        // and carries readonly="" until PayLexer hydrates it —
        // fillCredentials() strips both before typing, so the toggle never has
        // to be clicked.
        name: "API Key",
        locator: "#test_apiKeyTest",
      },
    ],
    currencies: ["USD"],
    defaultCurrency: "USD",
    successMessage: "Connection successful.",
  },
  Pesapal: {
    slug: "pesapal",
    displayName: "Pesapal",
    fields: [
      {
        // Sandbox consumer key from the Pesapal merchant dashboard
        // (Settings -> API Keys). Plain type="text" and NOT readonly on a
        // fresh setup, so fillCredentials() types straight into it.
        name: "Consumer Key",
        locator: "#test_consumerKeyTest",
      },
      {
        // type="password" behind an eye toggle, carrying readonly="" until
        // PayLexer hydrates it. The value is base64 and ends in "=", so it
        // must not be quote-stripped or trimmed in .env.
        name: "Consumer Secret",
        locator: "#test_consumerSecretTest",
      },
      {
        // The UUID Pesapal returns when the key/secret pair is registered
        // against a callback URL. PayLexer's own "Get IPN ID" button fills
        // this, so the input ships disabled (bg-gray-100 cursor-not-allowed +
        // readonly="") — fillCredentials() strips readonly/disabled before
        // typing, which is what lets a known IPN ID be replayed from .env
        // instead of re-registering on every run.
        name: "IPN ID",
        locator: "#test_ipnIdTest",
      },
    ],
    currencies: ["USD"],
    defaultCurrency: "USD",
    successMessage: "Connection successful.",
  },
  Elavon: {
    slug: "elavon",
    displayName: "Elavon",
    fields: [
      {
        name: "Merchant Alias",
        locator: "#test_merchantAliasTest",
      },
      {
        name: "Secret Key",
        locator: "#test_secretKeyTest",
      },
    ],
    currencies: ["USD"],
    defaultCurrency: "USD",
    successMessage: "Connection successful.",
  },
  Niubiz: {
    slug: "niubiz",
    displayName: "Niubiz",
    fields: [
      {
        name: "API Username",
        locator: "#test_usernameTest",
      },
      {
        name: "API Password",
        locator: "#test_passwordTest",
      },
      {
        name: "Merchant ID",
        locator: "#test_merchantIdTest",
      },
    ],
    currencies: ["USD"],
    defaultCurrency: "USD",
    successMessage: "Connection successful.",
  },
  Shift4: {
    slug: "shift4",
    displayName: "Shift4",
    fields: [
      {
        // Plain type="text" public key (pk_test_...) from the Shift4
        // dashboard. Carries readonly="" until PayLexer hydrates it —
        // fillCredentials() strips that before typing.
        name: "Public Key",
        locator: "#test_publicKeyTest",
      },
      {
        // Secret key (sk_test_...), type="password" behind an eye toggle and
        // readonly="" on load, so the toggle never has to be clicked.
        name: "Secret Key",
        locator: "#test_secretKeyTest",
      },
    ],
    currencies: ["USD"],
    defaultCurrency: "USD",
    successMessage: "Connection successful.",
  },
  // ── From PayLexer's gateway catalog (GET /api/v1/tenants/me/payment-gateways,
  // staging, 2026-10-26): the gateways on the team's credentials sheet that
  // had no entry yet. Each field is a test credential as PayLexer lists it, and
  // its selector is #test_<vault key>, as on the configure page. None of these
  // has paid end to end yet, so slugs, success messages and payment forms are
  // unproven until a run says otherwise. Those PayLexer could not verify yet carry
  // runs: false, which keeps it off the Runs page and out of test:all (Credentials still lists it);
  // drop the flag once its keys are in and it is ready to be run.
  AmazonPay: {
    // PayLexer "Amazon Pay" (code amazon-pay). Fields are its test credentials as
    // PayLexer's catalog lists them; the run has not paid with it yet.
    // Left at PayLexer's default (a dropdown, not filled): Marketplace Region.
    runs: false,
    slug: "amazon-pay",
    displayName: "Amazon Pay",
    fields: [
      { name: "Sandbox Public Key ID", locator: "#test_publicKeyIdTest" },
      { name: "Sandbox Private Key", locator: "#test_privateKeyTest" },
      { name: "Store ID", locator: "#test_storeId" },
      { name: "Merchant ID", locator: "#test_merchantId" },
    ],
    currencies: ["USD", "EUR", "GBP", "JPY"],
    defaultCurrency: "USD",
    successMessage: "Connection successful.",
  },
  AppotaPay: {
    // PayLexer "AppotaPay" (code appotapay). Fields are its test credentials as
    // PayLexer's catalog lists them; the run has not paid with it yet.
    runs: false,
    slug: "appotapay",
    displayName: "AppotaPay",
    fields: [
      { name: "Partner Code", locator: "#test_partnerCodeTest" },
      { name: "API Key", locator: "#test_apiKeyTest" },
      { name: "Secret Key", locator: "#test_secretKeyTest" },
    ],
    currencies: ["VND"],
    defaultCurrency: "VND",
    successMessage: "Connection successful.",
  },
  Billplz: {
    // PayLexer "Billplz" (code billplz). Fields are its test credentials as
    // PayLexer's catalog lists them; the run has not paid with it yet.
    slug: "billplz",
    displayName: "Billplz",
    fields: [
      { name: "API Secret Key", locator: "#test_secretKeyTest" },
      { name: "X Signature Key", locator: "#test_xSignatureKeyTest" },
      { name: "Collection ID", locator: "#test_collectionIdTest" },
    ],
    currencies: ["MYR"],
    defaultCurrency: "MYR",
    successMessage: "Connection successful.",
  },
  Bkash: {
    // PayLexer "bKash" (code bkash). Fields are its test credentials as
    // PayLexer's catalog lists them; the run has not paid with it yet.
    slug: "bkash",
    displayName: "bKash",
    fields: [
      { name: "Sandbox Username", locator: "#test_usernameTest" },
      { name: "Sandbox Password", locator: "#test_passwordTest" },
      { name: "Sandbox App Key", locator: "#test_appKeyTest" },
      { name: "Sandbox App Secret", locator: "#test_appSecretTest" },
    ],
    currencies: ["BDT"],
    defaultCurrency: "BDT",
    successMessage: "Connection successful.",
  },
  Chapa: {
    // PayLexer "Chapa" (code chapa). Fields are its test credentials as
    // PayLexer's catalog lists them; the run has not paid with it yet.
    slug: "chapa",
    displayName: "Chapa",
    fields: [
      { name: "Public Key", locator: "#test_publicKeyTest" },
      { name: "Secret Key", locator: "#test_secretKeyTest" },
      // PayLexer: "Webhook Secret Hash" — the webhook section of the configure page.
      { name: "Webhook Secret", locator: "#webhookSecretTest" },
    ],
    currencies: ["ETB", "USD"],
    defaultCurrency: "ETB",
    successMessage: "Connection successful.",
  },
  ChargilyPay: {
    // PayLexer "Chargily Pay" (code chargily). Fields are its test credentials as
    // PayLexer's catalog lists them; the run has not paid with it yet.
    runs: false,
    slug: "chargily",
    displayName: "Chargily Pay",
    fields: [
      { name: "Public API Key", locator: "#test_publicKeyTest" },
      { name: "Secret API Key", locator: "#test_secretKeyTest" },
    ],
    currencies: ["DZD"],
    defaultCurrency: "DZD",
    successMessage: "Connection successful.",
  },
  Dlocal: {
    // PayLexer "dLocal" (code dlocal). Fields are its test credentials as
    // PayLexer's catalog lists them; the run has not paid with it yet.
    slug: "dlocal",
    displayName: "dLocal",
    fields: [
      { name: "X-Login", locator: "#test_xLoginTest" },
      { name: "X-Trans-Key", locator: "#test_xTransKeyTest" },
      { name: "Secret Key", locator: "#test_secretKeyTest" },
    ],
    currencies: ["USD", "BRL", "MXN", "ARS", "CLP", "COP", "PEN", "UYU", "INR", "IDR", "MYR", "PHP", "THB", "VND", "ZAR", "NGN", "KES", "EGP", "TRY", "BDT"],
    defaultCurrency: "USD",
    successMessage: "Connection successful.",
  },
  Esewa: {
    // PayLexer "eSewa" (code esewa). Fields are its test credentials as
    // PayLexer's catalog lists them; the run has not paid with it yet.
    slug: "esewa",
    displayName: "eSewa",
    fields: [
      { name: "Merchant/Product Code", locator: "#test_productCodeTest" },
      { name: "Secret Key", locator: "#test_secretKeyTest" },
    ],
    currencies: ["NPR"],
    defaultCurrency: "NPR",
    successMessage: "Connection successful.",
  },
  FIUU: {
    // PayLexer "Fiuu" (code fiuu). Fields are its test credentials as
    // PayLexer's catalog lists them; the run has not paid with it yet.
    slug: "fiuu",
    displayName: "Fiuu",
    fields: [
      { name: "Merchant ID", locator: "#test_merchantIDTest" },
      { name: "Verify Key", locator: "#test_verifyKeyTest" },
      { name: "Secret Key", locator: "#test_secretKeyTest" },
      { name: "Extended vcode enabled", locator: "#test_extendedVcodeTest" },
    ],
    currencies: ["MYR", "SGD", "THB", "IDR", "PHP", "VND", "USD", "CNY", "TWD", "AUD", "HKD"],
    defaultCurrency: "MYR",
    successMessage: "Connection successful.",
  },
  GlobalPayments: {
    // PayLexer "Global Payments" (code global-payments). Fields are its test credentials as
    // PayLexer's catalog lists them; the run has not paid with it yet.
    slug: "global-payments",
    displayName: "Global Payments",
    fields: [
      { name: "App ID", locator: "#test_appIdTest" },
      { name: "App Key", locator: "#test_appKeyTest" },
    ],
    currencies: ["USD", "EUR", "GBP"],
    defaultCurrency: "USD",
    successMessage: "Connection successful.",
  },
  HimalayanBank: {
    // PayLexer "Himalayan Bank Limited" (code hbl). Fields are its test credentials as
    // PayLexer's catalog lists them; the run has not paid with it yet.
    runs: false,
    slug: "hbl",
    displayName: "Himalayan Bank Limited",
    fields: [
      { name: "Office ID", locator: "#test_officeIdTest" },
      { name: "API Key", locator: "#test_apiKeyTest" },
      { name: "Merchant Signing Private Key", locator: "#test_merchantSigningPrivateKeyTest" },
      { name: "Merchant Decryption Private Key", locator: "#test_merchantDecryptionPrivateKeyTest" },
      { name: "PACO Encryption Public Key", locator: "#test_pacoEncryptionPublicKeyTest" },
      { name: "PACO Signing Public Key", locator: "#test_pacoSigningPublicKeyTest" },
      { name: "Encryption Key ID", locator: "#test_encryptionKeyIdTest" },
    ],
    currencies: ["NPR", "USD"],
    defaultCurrency: "NPR",
    successMessage: "Connection successful.",
  },
  Interswitch: {
    // PayLexer "Interswitch" (code interswitch). Fields are its test credentials as
    // PayLexer's catalog lists them; the run has not paid with it yet.
    // Left at PayLexer's default (a dropdown, not filled): Region.
    slug: "interswitch",
    displayName: "Interswitch",
    fields: [
      { name: "Client ID", locator: "#test_clientIdTest" },
      { name: "Client Secret", locator: "#test_clientSecretTest" },
      { name: "Merchant Code", locator: "#test_merchantCodeTest" },
      { name: "Pay Item ID", locator: "#test_payItemIdTest" },
      // PayLexer: "Webhook Secret" — the webhook section of the configure page.
      { name: "Webhook Secret", locator: "#webhookSecretTest" },
    ],
    currencies: ["NGN", "KES", "UGX", "CDF", "USD"],
    defaultCurrency: "NGN",
    successMessage: "Connection successful.",
  },
  Ipaymu: {
    // PayLexer "iPaymu" (code ipaymu). Fields are its test credentials as
    // PayLexer's catalog lists them; the run has not paid with it yet.
    runs: false,
    slug: "ipaymu",
    displayName: "iPaymu",
    fields: [
      { name: "VA Number", locator: "#test_vaTest" },
      { name: "API Key", locator: "#test_apiKeyTest" },
    ],
    currencies: ["IDR"],
    defaultCurrency: "IDR",
    successMessage: "Connection successful.",
  },
  Klarna: {
    // PayLexer "Klarna" (code klarna). Fields are its test credentials as
    // PayLexer's catalog lists them; the run has not paid with it yet.
    // Left at PayLexer's default (a dropdown, not filled): Region.
    slug: "klarna",
    displayName: "Klarna",
    fields: [
      { name: "API Username", locator: "#test_apiUsernameTest" },
      { name: "API Password", locator: "#test_apiPasswordTest" },
    ],
    currencies: ["AUD", "CAD", "CHF", "CZK", "DKK", "EUR", "GBP", "HUF", "MXN", "NOK", "NZD", "PLN", "RON", "SEK", "USD"],
    defaultCurrency: "USD",
    successMessage: "Connection successful.",
  },
  Klix: {
    // PayLexer "Klix" (code klix). Fields are its test credentials as
    // PayLexer's catalog lists them; the run has not paid with it yet.
    runs: false,
    slug: "klix",
    displayName: "Klix",
    fields: [
      { name: "Test Secret Key", locator: "#test_secretKeyTest" },
      { name: "Test Brand ID", locator: "#test_brandIdTest" },
    ],
    currencies: ["EUR"],
    defaultCurrency: "EUR",
    successMessage: "Connection successful.",
  },
  LemonSqueezy: {
    // PayLexer "Lemon Squeezy" (code lemonsqueezy). Fields are its test credentials as
    // PayLexer's catalog lists them; the run has not paid with it yet.
    runs: false,
    slug: "lemonsqueezy",
    displayName: "Lemon Squeezy",
    fields: [
      { name: "API Key", locator: "#test_apiKeyTest" },
      { name: "Store ID", locator: "#test_storeIdTest" },
      { name: "Payment variant ID", locator: "#test_variantIdTest" },
      // PayLexer: "Signing Secret" — the webhook section of the configure page.
      { name: "Webhook Secret", locator: "#webhookSecretTest" },
    ],
    currencies: ["USD", "EUR", "GBP", "CAD", "AUD"],
    defaultCurrency: "USD",
    successMessage: "Connection successful.",
  },
  Maya: {
    // PayLexer "Maya" (code maya). Fields are its test credentials as
    // PayLexer's catalog lists them; the run has not paid with it yet.
    runs: false,
    slug: "maya",
    displayName: "Maya",
    fields: [
      { name: "Public Key", locator: "#test_publicKeyTest" },
      { name: "Secret Key", locator: "#test_secretKeyTest" },
    ],
    currencies: ["PHP"],
    defaultCurrency: "PHP",
    successMessage: "Connection successful.",
  },
  MTNMoMo: {
    // PayLexer "MTN MoMo" (code momo). Fields are its test credentials as
    // PayLexer's catalog lists them; the run has not paid with it yet.
    slug: "momo",
    displayName: "MTN MoMo",
    fields: [
      { name: "Subscription Key", locator: "#test_subscriptionKeyTest" },
      { name: "API User", locator: "#test_apiUserTest" },
      { name: "API Key", locator: "#test_apiKeyTest" },
    ],
    currencies: ["EUR", "UGX", "GHS", "XOF", "ZMW", "XAF", "RWF", "GNF", "CDF", "SZL", "LRD", "ZAR"],
    defaultCurrency: "EUR",
    successMessage: "Connection successful.",
  },
  Moneris: {
    // PayLexer "Moneris" (code moneris). Fields are its test credentials as
    // PayLexer's catalog lists them; the run has not paid with it yet.
    runs: false,
    slug: "moneris",
    displayName: "Moneris",
    fields: [
      { name: "Merchant ID", locator: "#test_merchantIdTest" },
      { name: "OAuth Client ID", locator: "#test_clientIdTest" },
      { name: "OAuth Client Secret", locator: "#test_clientSecretTest" },
    ],
    currencies: ["CAD", "USD"],
    defaultCurrency: "CAD",
    successMessage: "Connection successful.",
  },
  Montonio: {
    // PayLexer "Montonio" (code montonio). Fields are its test credentials as
    // PayLexer's catalog lists them; the run has not paid with it yet.
    slug: "montonio",
    displayName: "Montonio",
    fields: [
      { name: "Access Key", locator: "#test_accessKeyTest" },
      { name: "Secret Key", locator: "#test_secretKeyTest" },
    ],
    currencies: ["EUR", "PLN"],
    defaultCurrency: "EUR",
    successMessage: "Connection successful.",
  },
  NGenius: {
    // PayLexer "N-Genius Online" (code ngenius). Fields are its test credentials as
    // PayLexer's catalog lists them; the run has not paid with it yet.
    slug: "ngenius",
    displayName: "N-Genius Online",
    fields: [
      { name: "API Key", locator: "#test_apiKeyTest" },
      { name: "Outlet Reference", locator: "#test_outletRefTest" },
      // PayLexer: "Webhook Header Value" — the webhook section of the configure page.
      { name: "Webhook Secret", locator: "#webhookSecretTest" },
    ],
    currencies: ["AED"],
    defaultCurrency: "AED",
    successMessage: "Connection successful.",
  },
  Nicepay: {
    // PayLexer "NICEPAY" (code nicepay). Fields are its test credentials as
    // PayLexer's catalog lists them; the run has not paid with it yet.
    slug: "nicepay",
    displayName: "NICEPAY",
    fields: [
      { name: "Merchant ID", locator: "#test_iMid" },
      { name: "Merchant Key", locator: "#test_merchantKey" },
    ],
    currencies: ["IDR"],
    defaultCurrency: "IDR",
    successMessage: "Connection successful.",
  },
  NMI: {
    // PayLexer "NMI" (code nmi). Fields are its test credentials as
    // PayLexer's catalog lists them; the run has not paid with it yet.
    slug: "nmi",
    displayName: "NMI",
    fields: [
      { name: "Sandbox Merchant Key api", locator: "#test_securityKeyTest" },
      { name: "Sandbox Merchant Key tokenization", locator: "#test_tokenizationKeyTest" },
      // PayLexer: "Sandbox Webhook Signing Key" — the webhook section of the configure page.
      { name: "Webhook Secret", locator: "#webhookSecretTest" },
    ],
    currencies: ["USD"],
    defaultCurrency: "USD",
    successMessage: "Connection successful.",
  },
  ONVO: {
    // PayLexer "ONVO Pay" (code onvo). Fields are its test credentials as
    // PayLexer's catalog lists them; the run has not paid with it yet.
    runs: false,
    slug: "onvo",
    displayName: "ONVO Pay",
    fields: [
      { name: "Secret Key", locator: "#test_secretKeyTest" },
      { name: "Publishable Key", locator: "#test_publishableKeyTest" },
      // PayLexer: "Webhook Secret" — the webhook section of the configure page.
      { name: "Webhook Secret", locator: "#webhookSecretTest" },
    ],
    currencies: ["USD", "CRC", "GTQ", "NIO", "PAB", "PEN", "MXN", "COP", "HNL"],
    defaultCurrency: "USD",
    successMessage: "Connection successful.",
  },
  PayerMax: {
    // PayLexer "PayerMax" (code payermax). Fields are its test credentials as
    // PayLexer's catalog lists them; the run has not paid with it yet.
    runs: false,
    slug: "payermax",
    displayName: "PayerMax",
    fields: [
      { name: "Merchant ID", locator: "#test_merchantNoTest" },
      { name: "App ID", locator: "#test_appIdTest" },
      { name: "Merchant Private Key", locator: "#test_merchantPrivateKeyTest" },
      { name: "PayerMax Public Key", locator: "#test_payerMaxPublicKeyTest" },
    ],
    currencies: ["USD", "EUR", "GBP", "SAR", "AED", "KWD", "BHD", "QAR", "OMR", "EGP", "JOD", "IQD", "TRY", "SGD", "HKD", "IDR", "MYR", "THB", "PHP", "VND", "KRW", "JPY", "TWD", "INR", "PKR", "BDT", "BRL", "MXN", "COP", "CLP", "PEN", "NGN", "ZAR"],
    defaultCurrency: "USD",
    successMessage: "Connection successful.",
  },
  PayFabric: {
    // PayLexer "PayFabric" (code payfabric). Fields are its test credentials as
    // PayLexer's catalog lists them; the run has not paid with it yet.
    slug: "payfabric",
    displayName: "PayFabric",
    fields: [
      { name: "Device ID", locator: "#test_deviceIdTest" },
      { name: "Device Password", locator: "#test_devicePasswordTest" },
      { name: "Gateway Profile", locator: "#test_setupIdTest" },
    ],
    currencies: ["USD", "CAD", "AUD", "EUR", "GBP", "NZD"],
    defaultCurrency: "USD",
    successMessage: "Connection successful.",
  },
  PayHero: {
    // PayLexer "Pay Hero" (code payhero). Fields are its test credentials as
    // PayLexer's catalog lists them; the run has not paid with it yet.
    slug: "payhero",
    displayName: "Pay Hero",
    fields: [
      { name: "Basic Authorization Token", locator: "#test_basicAuthTokenTest" },
      { name: "Channel ID", locator: "#test_channelIdTest" },
    ],
    currencies: ["KES"],
    defaultCurrency: "KES",
    successMessage: "Connection successful.",
  },
  PayJustNow: {
    // PayLexer "PayJustNow" (code payjustnow). Fields are its test credentials as
    // PayLexer's catalog lists them; the run has not paid with it yet.
    runs: false,
    slug: "payjustnow",
    displayName: "PayJustNow",
    fields: [
      { name: "Merchant Account ID", locator: "#test_merchantAccountIdTest" },
      { name: "Merchant Account API Key", locator: "#test_merchantAccountApiKeyTest" },
      { name: "Signing Key", locator: "#test_secretSigningKeyTest" }, // optional
    ],
    currencies: ["ZAR"],
    defaultCurrency: "ZAR",
    successMessage: "Connection successful.",
  },
  PAYONE: {
    // PayLexer "PAYONE" (code payone). Fields are its test credentials as
    // PayLexer's catalog lists them; the run has not paid with it yet.
    runs: false,
    slug: "payone",
    displayName: "PAYONE",
    fields: [
      { name: "Merchant ID", locator: "#test_merchantIdTest" },
      { name: "API Key ID", locator: "#test_apiKeyTest" },
      { name: "Secret API Key", locator: "#test_secretKeyTest" },
      // PayLexer: "Secret Webhook Key" — the webhook section of the configure page.
      { name: "Webhook Secret", locator: "#webhookSecretTest" },
    ],
    currencies: ["EUR", "CHF", "DKK", "GBP", "NOK", "SEK", "CNY", "USD"],
    defaultCurrency: "EUR",
    successMessage: "Connection successful.",
  },
  Paysafe: {
    // PayLexer "Paysafe" (code paysafe). Fields are its test credentials as
    // PayLexer's catalog lists them; the run has not paid with it yet.
    runs: false,
    slug: "paysafe",
    displayName: "Paysafe",
    fields: [
      { name: "API Key Username", locator: "#test_apiKeyUsernameTest" },
      { name: "API Key Password", locator: "#test_apiKeyPasswordTest" },
      { name: "Public API Key", locator: "#test_publicApiKeyTest" },
      { name: "Account Number", locator: "#test_accountIdsTest" },
      // PayLexer: "Webhook Secret" — the webhook section of the configure page.
      { name: "Webhook Secret", locator: "#webhookSecretTest" },
    ],
    currencies: ["USD", "CAD", "GBP", "EUR"],
    defaultCurrency: "USD",
    successMessage: "Connection successful.",
  },
  PayTabs: {
    // PayLexer "PayTabs" (code paytabs). Fields are its test credentials as
    // PayLexer's catalog lists them; the run has not paid with it yet.
    // Left at PayLexer's default (a dropdown, not filled): Region.
    slug: "paytabs",
    displayName: "PayTabs",
    fields: [
      { name: "Profile ID", locator: "#test_profileIdTest" },
      { name: "Server Key", locator: "#test_serverKeyTest" },
    ],
    currencies: ["AED", "BHD", "EGP", "EUR", "GBP", "HKD", "IDR", "INR", "IQD", "JOD", "JPY", "KWD", "MAD", "OMR", "PKR", "QAR", "SAR", "USD"],
    // The sandbox profile takes USD (team sheet); AED fails with PayTabs'
    // "Not found merchant".
    defaultCurrency: "USD",
    successMessage: "Connection successful.",
  },
  PayUAfrica: {
    // PayLexer "PayU Africa" (code payu-mea). Fields are its test credentials as
    // PayLexer's catalog lists them; the run has not paid with it yet.
    // Left at PayLexer's default (a dropdown, not filled): Payment Methods.
    slug: "payu-mea",
    displayName: "PayU Africa",
    fields: [
      { name: "SOAP Username", locator: "#test_usernameTest" },
      { name: "SOAP Password", locator: "#test_passwordTest" },
      { name: "Safe Key", locator: "#test_safeKeyTest" },
    ],
    currencies: ["NGN", "ZAR"],
    defaultCurrency: "NGN",
    successMessage: "Connection successful.",
  },
  PayVector: {
    // PayLexer "PayVector" (code payvector). Fields are its test credentials as
    // PayLexer's catalog lists them; the run has not paid with it yet.
    // Left at PayLexer's default (a dropdown, not filled): Hash Method.
    slug: "payvector",
    displayName: "PayVector",
    fields: [
      { name: "Merchant ID", locator: "#test_merchantIdTest" },
      { name: "Gateway Account Password", locator: "#test_passwordTest" },
      { name: "Pre-Shared Key", locator: "#test_preSharedKeyTest" },
    ],
    currencies: ["GBP", "EUR", "USD", "AUD", "CAD"],
    defaultCurrency: "GBP",
    successMessage: "Connection successful.",
  },
  PGMultiPayment: {
    // PayLexer "PG Multi-Payment Service" (code pg-multi-payment-service). Fields are its test credentials as
    // PayLexer's catalog lists them; the run has not paid with it yet.
    slug: "pg-multi-payment-service",
    displayName: "PG Multi-Payment Service",
    fields: [
      { name: "Shop ID", locator: "#test_shopIdTest" },
      { name: "Shop Password", locator: "#test_shopPassTest" },
      { name: "LinkType Plus Config ID", locator: "#test_configIdTest" },
    ],
    currencies: ["JPY"],
    defaultCurrency: "JPY",
    successMessage: "Connection successful.",
  },
  PhaJay: {
    // PayLexer "PhaJay" (code phajay). Fields are its test credentials as
    // PayLexer's catalog lists them; the run has not paid with it yet.
    slug: "phajay",
    displayName: "PhaJay",
    fields: [
      { name: "Test Key", locator: "#test_secretKeyTest" },
    ],
    currencies: ["LAK", "USD"],
    defaultCurrency: "LAK",
    successMessage: "Connection successful.",
  },
  PostFinance: {
    // PayLexer "PostFinance" (code postfinance-checkout). Fields are its test credentials as
    // PayLexer's catalog lists them; the run has not paid with it yet.
    slug: "postfinance-checkout",
    displayName: "PostFinance",
    fields: [
      { name: "Space ID", locator: "#test_spaceIdTest" },
      { name: "Application User ID", locator: "#test_userIdTest" },
      { name: "Authentication Key", locator: "#test_apiSecretTest" },
    ],
    currencies: ["CHF", "EUR", "AUD", "CAD", "DKK", "GBP", "JPY", "NOK", "SEK", "USD"],
    defaultCurrency: "CHF",
    successMessage: "Connection successful.",
  },
  Quickpay: {
    // PayLexer "Quickpay" (code quickpay). Fields are its test credentials as
    // PayLexer's catalog lists them; the run has not paid with it yet.
    runs: false,
    slug: "quickpay",
    displayName: "Quickpay",
    fields: [
      { name: "API Key", locator: "#test_apiKeyTest" },
      // PayLexer files this with the webhook settings, not the keys.
      { name: "Private Key", locator: "#privateKeyTest" },
    ],
    currencies: ["DKK", "EUR", "USD", "GBP", "SEK", "NOK"],
    defaultCurrency: "DKK",
    successMessage: "Connection successful.",
  },
  Raiffeisen: {
    // PayLexer "Raiffeisen" (code raiffeisen). Fields are its test credentials as
    // PayLexer's catalog lists them; the run has not paid with it yet.
    slug: "raiffeisen",
    displayName: "Raiffeisen",
    fields: [
      { name: "API Username", locator: "#test_usernameTest" },
      { name: "API Password", locator: "#test_passwordTest" },
    ],
    currencies: ["ALL", "AUD", "BGN", "CAD", "CHF", "CZK", "DKK", "EUR", "GBP", "HUF", "ILS", "NOK", "PLN", "RON", "RSD", "SEK", "TRY", "USD"],
    defaultCurrency: "EUR",
    successMessage: "Connection successful.",
  },
  Rapyd: {
    // PayLexer "Rapyd" (code rapyd). Fields are its test credentials as
    // PayLexer's catalog lists them; the run has not paid with it yet.
    slug: "rapyd",
    displayName: "Rapyd",
    fields: [
      { name: "Access Key", locator: "#test_accessKeyTest" },
      { name: "Secret Key", locator: "#test_secretKeyTest" },
    ],
    currencies: ["USD", "EUR", "GBP", "SGD", "AUD", "CAD", "JPY", "HKD", "NZD", "CHF", "MXN", "BRL", "INR", "AED", "SAR", "ZAR", "PHP", "THB", "MYR", "IDR"],
    defaultCurrency: "USD",
    successMessage: "Connection successful.",
  },
  Razorpay: {
    // PayLexer "Razorpay" (code razorpay). Fields are its test credentials as
    // PayLexer's catalog lists them; the run has not paid with it yet.
    slug: "razorpay",
    displayName: "Razorpay",
    fields: [
      { name: "Key ID", locator: "#test_keyIdTest" },
      { name: "Key Secret", locator: "#test_keySecretTest" },
      // PayLexer: "Webhook Secret" — the webhook section of the configure page.
      { name: "Webhook Secret", locator: "#webhookSecretTest" },
    ],
    currencies: ["AED", "ALL", "AMD", "AUD", "AWG", "AZN", "BAM", "BBD", "BDT", "BGN", "BHD", "BIF", "BMD", "BND", "BOB", "BRL", "BSD", "BTN", "BWP", "BZD", "CAD", "CHF", "CLP", "CNY", "COP", "CRC", "CUP", "CVE", "CZK", "DJF", "DKK", "DOP", "DZD", "EGP", "ETB", "EUR", "FJD", "GBP", "GHS", "GIP", "GMD", "GNF", "GTQ", "GYD", "HKD", "HNL", "HRK", "HTG", "HUF", "IDR", "ILS", "INR", "IQD", "ISK", "JMD", "JOD", "JPY", "KES", "KGS", "KHR", "KMF", "KRW", "KWD", "KYD", "KZT", "LAK", "LKR", "LRD", "LSL", "MAD", "MDL", "MGA", "MKD", "MMK", "MNT", "MOP", "MUR", "MVR", "MWK", "MXN", "MYR", "MZN", "NAD", "NGN", "NIO", "NOK", "NPR", "NZD", "OMR", "PEN", "PGK", "PHP", "PKR", "PLN", "PYG", "QAR", "RON", "RSD", "RUB", "RWF", "SAR", "SCR", "SEK", "SGD", "SLL", "SOS", "SVC", "SZL", "THB", "TND", "TRY", "TTD", "TWD", "TZS", "UAH", "UGX", "USD", "UYU", "UZS", "VND", "VUV", "XAF", "XCD", "XOF", "XPF", "YER", "ZAR", "ZMW"],
    defaultCurrency: "INR",
    successMessage: "Connection successful.",
  },
  RedSys: {
    // PayLexer "Redsys" (code redsys). Fields are its test credentials as
    // PayLexer's catalog lists them; the run has not paid with it yet.
    slug: "redsys",
    displayName: "Redsys",
    fields: [
      { name: "Merchant Code", locator: "#test_merchantCodeTest" },
      { name: "Terminal Number", locator: "#test_terminalIdTest" },
      { name: "SHA-256 Merchant Key", locator: "#test_secretKeyTest" },
    ],
    currencies: ["EUR"],
    defaultCurrency: "EUR",
    successMessage: "Connection successful.",
  },
  Saferpay: {
    // PayLexer "Saferpay" (code saferpay). Fields are its test credentials as
    // PayLexer's catalog lists them; the run has not paid with it yet.
    slug: "saferpay",
    displayName: "Saferpay",
    fields: [
      { name: "Customer ID", locator: "#test_customerIdTest" },
      { name: "Terminal ID", locator: "#test_terminalIdTest" },
      { name: "API Username", locator: "#test_apiUsernameTest" },
      { name: "API Password", locator: "#test_apiPasswordTest" },
    ],
    currencies: ["CHF", "EUR", "USD", "GBP", "AUD", "CAD", "DKK", "JPY", "NOK", "SEK", "PLN", "CZK", "HUF"],
    defaultCurrency: "CHF",
    successMessage: "Connection successful.",
  },
  Squad: {
    // PayLexer "Squad" (code squad). Fields are its test credentials as
    // PayLexer's catalog lists them; the run has not paid with it yet.
    slug: "squad",
    displayName: "Squad",
    fields: [
      { name: "Secret Key", locator: "#test_secretKeyTest" },
    ],
    currencies: ["NGN", "USD"],
    defaultCurrency: "NGN",
    successMessage: "Connection successful.",
  },
  TapPayments: {
    // PayLexer "Tap Payments" (code tap-payments). Fields are its test credentials as
    // PayLexer's catalog lists them; the run has not paid with it yet.
    slug: "tap-payments",
    displayName: "Tap Payments",
    fields: [
      { name: "Secret API Key", locator: "#test_apiKeyTest" },
    ],
    currencies: ["AED", "BHD", "EUR", "GBP", "KWD", "OMR", "QAR", "SAR", "USD"],
    defaultCurrency: "AED",
    successMessage: "Connection successful.",
  },
  Tazapay: {
    // PayLexer "Tazapay" (code tazapay). Fields are its test credentials as
    // PayLexer's catalog lists them; the run has not paid with it yet.
    runs: false,
    slug: "tazapay",
    displayName: "Tazapay",
    fields: [
      { name: "API Key", locator: "#test_apiKeyTest" },
      { name: "API Secret", locator: "#test_apiSecretTest" },
      // PayLexer: "Webhook Secret Token" — the webhook section of the configure page.
      { name: "Webhook Secret", locator: "#webhookSecretTest" },
    ],
    currencies: ["AED", "AUD", "BRL", "CAD", "CHF", "CNY", "CZK", "DKK", "EGP", "EUR", "GBP", "HKD", "IDR", "ILS", "INR", "JPY", "KES", "KRW", "MXN", "MYR", "NGN", "NOK", "NPR", "NZD", "PHP", "PLN", "QAR", "SAR", "SEK", "SGD", "THB", "TRY", "USD", "VND", "ZAR"],
    defaultCurrency: "USD",
    successMessage: "Connection successful.",
  },
  TossPayments: {
    // PayLexer "Toss Payments" (code tosspayments). Fields are its test credentials as
    // PayLexer's catalog lists them; the run has not paid with it yet.
    slug: "tosspayments",
    displayName: "Toss Payments",
    fields: [
      { name: "Client Key", locator: "#test_clientKeyTest" },
      { name: "Secret Key", locator: "#test_secretKeyTest" },
    ],
    currencies: ["KRW"],
    defaultCurrency: "KRW",
    successMessage: "Connection successful.",
  },
  Transbank: {
    // PayLexer "Transbank" (code transbank). Fields are its test credentials as
    // PayLexer's catalog lists them; the run has not paid with it yet.
    slug: "transbank",
    displayName: "Transbank",
    fields: [
      { name: "Webpay Plus Commerce Code", locator: "#test_commerceCodeTest" },
      { name: "API Key Secret", locator: "#test_apiKeySecretTest" },
    ],
    currencies: ["CLP"],
    defaultCurrency: "CLP",
    successMessage: "Connection successful.",
  },
  TransFi: {
    // PayLexer "TransFi" (code transfi). Fields are its test credentials as
    // PayLexer's catalog lists them; the run has not paid with it yet.
    slug: "transfi",
    displayName: "TransFi",
    fields: [
      { name: "API Username", locator: "#test_usernameTest" },
      { name: "API Password", locator: "#test_passwordTest" },
      { name: "Merchant ID", locator: "#test_midTest" },
      // PayLexer: "Webhook Secret" — the webhook section of the configure page.
      { name: "Webhook Secret", locator: "#webhookSecretTest" },
    ],
    currencies: ["AED", "ARS", "AUD", "BDT", "BRL", "CAD", "CHF", "CLP", "CNY", "COP", "CZK", "EUR", "GHS", "HKD", "IDR", "JPY", "KES", "MXN", "MYR", "NGN", "NOK", "NZD", "PEN", "PHP", "PKR", "PLN", "SEK", "SGD", "THB", "TZS", "UGX", "USD", "VND", "XAF", "ZAR", "ZMW"],
    defaultCurrency: "USD",
    successMessage: "Connection successful.",
  },
  TropiPay: {
    // PayLexer "TropiPay" (code tropipay). Fields are its test credentials as
    // PayLexer's catalog lists them; the run has not paid with it yet.
    slug: "tropipay",
    displayName: "TropiPay",
    fields: [
      { name: "Client ID", locator: "#test_clientIdTest" },
      { name: "Client Secret", locator: "#test_clientSecretTest" },
    ],
    currencies: ["EUR", "USD", "CUP", "MXN", "COP", "ARS"],
    defaultCurrency: "EUR",
    successMessage: "Connection successful.",
  },
  UPayments: {
    // PayLexer "UPayments" (code upayments). Fields are its test credentials as
    // PayLexer's catalog lists them; the run has not paid with it yet.
    runs: false,
    slug: "upayments",
    displayName: "UPayments",
    fields: [
      { name: "API Key", locator: "#test_apiKeyTest" },
    ],
    currencies: ["KWD", "SAR", "USD", "BHD", "EUR", "OMR", "QAR", "AED", "GBP", "JOD"],
    defaultCurrency: "KWD",
    successMessage: "Connection successful.",
  },
  VNPay: {
    // PayLexer "VNPAY" (code vnpay). Fields are its test credentials as
    // PayLexer's catalog lists them; the run has not paid with it yet.
    runs: false,
    slug: "vnpay",
    displayName: "VNPAY",
    fields: [
      { name: "Terminal Code", locator: "#test_tmnCodeTest" },
      { name: "Hash Secret", locator: "#test_hashSecretTest" },
    ],
    currencies: ["VND"],
    defaultCurrency: "VND",
    successMessage: "Connection successful.",
  },
  Windcave: {
    // PayLexer "Windcave" (code windcave). Fields are its test credentials as
    // PayLexer's catalog lists them; the run has not paid with it yet.
    slug: "windcave",
    displayName: "Windcave",
    fields: [
      { name: "API Username", locator: "#test_apiUsernameLive" },
      { name: "API Key", locator: "#test_apiKeyLive" },
    ],
    currencies: ["NZD", "AUD", "USD", "GBP", "EUR", "CAD", "JPY", "SGD", "HKD", "CHF", "ZAR", "FJD"],
    defaultCurrency: "NZD",
    successMessage: "Connection successful.",
  },
  WiPay: {
    // PayLexer "WiPay" (code wipay). Fields are its test credentials as
    // PayLexer's catalog lists them; the run has not paid with it yet.
    // Left at PayLexer's default (a dropdown, not filled): Country, Fee Structure.
    slug: "wipay",
    displayName: "WiPay",
    fields: [
      { name: "Account Number", locator: "#test_accountNumberTest" },
      { name: "API Key", locator: "#test_apiKeyTest" },
      { name: "WAPI Key", locator: "#test_wapiKeyTest" }, // optional
    ],
    currencies: ["TTD", "JMD", "BBD", "GYD", "XCD", "USD"],
    defaultCurrency: "TTD",
    successMessage: "Connection successful.",
  },
  WooshPay: {
    // PayLexer "WooshPay" (code wooshpay). Fields are its test credentials as
    // PayLexer's catalog lists them; the run has not paid with it yet.
    runs: false,
    slug: "wooshpay",
    displayName: "WooshPay",
    fields: [
      { name: "Secret Key", locator: "#test_secretKeyTest" },
      // PayLexer: "Webhook Signing Secret (whsec_…)" — the webhook section of the configure page.
      { name: "Webhook Secret", locator: "#webhookSecretTest" },
    ],
    currencies: ["INR", "PKR", "BDT", "NPR", "LKR", "USD"],
    defaultCurrency: "INR",
    successMessage: "Connection successful.",
  },
  Worldline: {
    // PayLexer "Worldline" (code worldline). Fields are its test credentials as
    // PayLexer's catalog lists them; the run has not paid with it yet.
    slug: "worldline",
    displayName: "Worldline",
    fields: [
      { name: "Merchant ID", locator: "#test_merchantIdTest" },
      { name: "Payments API Passcode", locator: "#test_paymentApiPasscodeTest" },
      { name: "Hash Key", locator: "#test_hashKeyTest" },
      { name: "Recurring Billing API Passcode", locator: "#test_recurringApiPasscodeTest" },
      { name: "Reporting API Passcode", locator: "#test_reportingApiPasscodeTest" },
    ],
    currencies: ["USD", "CAD", "EUR", "GBP", "AUD", "NZD"],
    defaultCurrency: "USD",
    successMessage: "Connection successful.",
  },
};

// Gateways added from the UI (data/gateways.json, see config/gatewayStore.js),
// then the built-in ones above — which win on a name clash. Each UI-added entry
// carries `custom: true`. Currencies changed in the UI for a built-in gateway
// are applied onto its entry first (`currenciesOverridden: true`).
const gatewayStore = require("./gatewayStore");
const store = gatewayStore.load();

gatewayStore.applyOverrides(BUILT_IN, store);

module.exports = {
  ...gatewayStore.customGateways(store),
  ...BUILT_IN,
};
