// config/credentialKeys.js
//
// The .env variable a gateway credential field is read from:
//
//   credentialEnvKey("Stripe", "Publishable Key")  ->  STRIPE_PUBLIC_KEY
//
// One definition, used by the run that fills the field
// (pages/GatewayConfigurationPage.js) and by the UI's Credentials tab, so the
// tab can never name a variable the run does not actually read.

function credentialEnvKey(gatewayName, fieldName) {
  const gatewayPrefix = gatewayName.toUpperCase().replace(/[^A-Z0-9]+/g, "_");

  const fieldKey = fieldName
    .toUpperCase()
    .replace("PUBLISHABLE", "PUBLIC")
    .replace(/\s+/g, "_")
    .replace(/[^A-Z0-9_]/g, "");

  return `${gatewayPrefix}_${fieldKey}`;
}

module.exports = { credentialEnvKey };
