describe("Admin smoke", () => {
  it("lands on /admin if authenticated, otherwise redirects to SSO login", () => {
    cy.visit("/admin");

    cy.location("href", { timeout: 60000 }).then((href) => {
      const ok =
        href.includes("/admin") ||
        href.includes("accountsdev.actingoffice.com/login") ||
        href.includes("accountsdev.actingoffice.com/oauth");

      expect(ok, `Unexpected final URL: ${href}`).to.eq(true);
    });
  });
});
