describe("Email section E2E", () => {
  it("logs in and opens Email section", () => {
    cy.visit("/admin");

    // Wait until redirect happens (either stays on localhost or goes to accountsdev)
    cy.location("origin", { timeout: 60000 }).then((origin) => {
      if (origin.includes("accountsdev.actingoffice.com")) {
        cy.origin("https://accountsdev.actingoffice.com", () => {
          const user = Cypress.env("EMAIL_USER");
          const pass = Cypress.env("EMAIL_PASS");

          // Username (label-based)
          cy.contains("label", "Username", { timeout: 30000 })
            .parent()
            .find("input")
            .first()
            .clear()
            .type(user);

          // Password (label-based)
          cy.contains("label", "Password", { timeout: 30000 })
            .parent()
            .find("input")
            .first()
            .clear()
            .type(pass, { log: false });

          // Submit
          cy.contains("button", "Log in", { timeout: 30000 }).click();
        });
      }
    });

    // Back to your app after successful login
    cy.location("origin", { timeout: 90000 }).should("eq", "http://localhost:5000");

    // Navigate to Email section (update label if different)
    cy.contains("Email", { matchCase: false, timeout: 30000 }).click();

    // Validate inbox/email list (update to match your UI)
    cy.contains("Inbox", { matchCase: false, timeout: 30000 }).should("be.visible");
  });
});
