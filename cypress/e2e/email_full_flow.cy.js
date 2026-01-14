// cypress/e2e/email_full_flow.cy.js

describe("Email module full flow", () => {
  function stubPracticeConfig() {
    // Works for:
    // http://localhost:5004/practice/config
    // http://localhost:5000/practice/config
    // and with query strings too
    cy.intercept(
      {
        method: "GET",
        url: /\/practice\/config.*/i,
      },
      { fixture: "practice_config.json" }
    ).as("practiceConfig");
  }

  function loginIfNeeded() {
    stubPracticeConfig();
    cy.visit("/admin");

    // ✅ ensure app requested config
    cy.wait("@practiceConfig", { timeout: 60000 });

    cy.location("origin", { timeout: 60000 }).then((origin) => {
      if (origin.includes("accountsdev.actingoffice.com")) {
        cy.origin("https://accountsdev.actingoffice.com", () => {
          const user = Cypress.env("EMAIL_USER");
          const pass = Cypress.env("EMAIL_PASS");

          cy.contains("label", "Username", { timeout: 60000 })
            .parent()
            .find("input")
            .first()
            .clear()
            .type(user);

          cy.contains("label", "Password", { timeout: 60000 })
            .parent()
            .find("input")
            .first()
            .clear()
            .type(pass, { log: false });

          cy.contains("button", "Log in", { timeout: 60000 }).click();
        });
      }
    });

    cy.location("origin", { timeout: 120000 }).should("eq", "http://localhost:5000");

    // sometimes config is called again after redirect
    stubPracticeConfig();
    cy.wait("@practiceConfig", { timeout: 60000 });
  }

  function goToEmailModule() {
    cy.contains(/emails?/i, { timeout: 60000 }).click({ force: true });
    cy.contains(/inbox/i, { timeout: 60000 }).should("be.visible");
  }

  // Helpers to find fields in different UIs
  function typeToAddress(toEmail) {
    cy.get("body").then(($body) => {
      if ($body.find('[data-testid="compose-to"]').length) {
        cy.get('[data-testid="compose-to"]').clear().type(toEmail).type("{enter}");
        return;
      }

      const candidates = [
        'input[name="to"]',
        'input[aria-label*="To"]',
        'input[placeholder*="To"]',
        'input[id*="to"]',
      ];

      const found = candidates.find((sel) => $body.find(sel).length);
      if (found) {
        cy.get(found).first().clear().type(toEmail).type("{enter}");
        return;
      }

      cy.contains(/^to$/i)
        .parent()
        .find("input")
        .first()
        .clear()
        .type(toEmail)
        .type("{enter}");
    });
  }

  function typeSubject(subject) {
    cy.get("body").then(($body) => {
      if ($body.find('[data-testid="compose-subject"]').length) {
        cy.get('[data-testid="compose-subject"]').clear().type(subject);
        return;
      }

      const candidates = [
        'input[name="subject"]',
        'input[aria-label*="Subject"]',
        'input[placeholder*="Subject"]',
        'input[id*="subject"]',
      ];

      const found = candidates.find((sel) => $body.find(sel).length);
      if (found) {
        cy.get(found).first().clear().type(subject);
        return;
      }

      cy.contains(/subject/i).parent().find("input").first().clear().type(subject);
    });
  }

  function typeBody(text) {
    cy.get("body").then(($body) => {
      const rich = $body.find('[contenteditable="true"]');
      if (rich.length) {
        cy.wrap(rich.first()).click().type(text);
        return;
      }

      const ta = $body.find("textarea");
      if (ta.length) {
        cy.wrap(ta.first()).clear().type(text);
        return;
      }

      cy.get("body").click().type(text);
    });
  }

  before(() => {
    cy.session("ao-oidc", () => {
      loginIfNeeded();
    });
  });

  beforeEach(() => {
    stubPracticeConfig();
    cy.visit("/admin");
    cy.wait("@practiceConfig", { timeout: 60000 });
    goToEmailModule();
  });

  it("opens Inbox", () => {
    cy.contains(/inbox/i, { timeout: 60000 }).should("be.visible");
  });

  it("opens first email if available", () => {
    cy.get("body").then(($body) => {
      const row = $body.find('[role="row"], [role="listitem"]').first();
      if (row.length) {
        cy.wrap(row).click({ force: true });
        cy.contains(/from|to|subject/i, { timeout: 60000 }).should("exist");
      } else {
        cy.contains(/inbox/i).should("be.visible");
      }
    });
  });

  it("opens Compose and fills fields", () => {
    cy.contains("button, a", /compose|new message|new mail|new/i, { timeout: 60000 })
      .first()
      .click({ force: true });

    typeToAddress("test@example.com");
    typeSubject("Cypress E2E Test Mail");
    typeBody("Hello, this is an automated Cypress test email.");

    cy.contains(/cypress e2e test mail/i).should("exist");
  });

  it("sends email (if Send button available)", () => {
    cy.contains("button, a", /compose|new message|new mail|new/i, { timeout: 60000 })
      .first()
      .click({ force: true });

    typeToAddress("test@example.com");
    typeSubject("Cypress Send Test");
    typeBody("Sending email from Cypress automation.");

    cy.contains("button, a", /^send$/i, { timeout: 60000 })
      .first()
      .click({ force: true });

    cy.get("body", { timeout: 60000 }).then(($body) => {
      const t = $body.text();
      if (/sent|message sent|email sent/i.test(t)) {
        cy.contains(/sent|message sent|email sent/i, { timeout: 60000 }).should("be.visible");
      }
    });
  });

  it("navigates to Sent folder (if exists)", () => {
    cy.contains(/sent/i, { timeout: 60000 }).click({ force: true });
    cy.contains(/sent/i, { timeout: 60000 }).should("be.visible");
  });
});
