Cypress.Commands.add("loginViaOidc", () => {
  cy.visit("/"); // or /admin or your landing

  // You will be redirected to accountsdev login
  cy.origin("https://accountsdev.actingoffice.com", () => {
    // Update selectors based on your login page HTML
    cy.get('input[name="Username"], input[name="username"], #Username', { timeout: 30000 })
      .first()
      .type(Cypress.env("EMAIL_USER"));

    cy.get('input[name="Password"], input[name="password"], #Password')
      .first()
      .type(Cypress.env("EMAIL_PASS"), { log: false });

    cy.get('button[type="submit"], input[type="submit"]').first().click();
  });

  // Back to app after redirect
  cy.location("origin", { timeout: 60000 }).should("eq", "http://localhost:5000");
});
