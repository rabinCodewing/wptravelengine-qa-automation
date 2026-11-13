const LoginLocators = Object.freeze({
  emailField: "#email",

  continueButton: "//button[normalize-space()='Continue']",

  passwordField: "#password",

  rememberMe: "//button[@id='tAndC']",

  signInButton: "//button[@type='submit' and normalize-space()='Sign in']",
});

module.exports = { LoginLocators };
