#!/usr/bin/env node

const { z } = require("zod");
const { execa } = require("execa");

// ✅ Correct MCP server class + transport for .tool()
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");

const server = new McpServer({
  name: "mcp-cypress-agent",
  version: "1.0.0",
});

// Tool: Open Cypress UI (visible)
server.tool(
  "cypress.open",
  {
    projectDir: z.string().default(process.cwd()),
    browser: z.string().default("chrome"),
  },
  async ({ projectDir, browser }) => {
    // Don't await; keep UI open
    execa("npx", ["cypress", "open", "--browser", browser], {
      cwd: projectDir,
      stdio: "inherit",
      windowsHide: false,
      shell: true,
    });

    return {
      content: [{ type: "text", text: "✅ Cypress UI launched." }],
    };
  }
);

// Tool: Run Cypress headed (visible browser)
server.tool(
  "cypress.runHeaded",
  {
    projectDir: z.string().default(process.cwd()),
    spec: z.string().optional(), // e.g. cypress/e2e/admin_smoke.cy.js
    browser: z.string().default("chrome"),
  },
  async ({ projectDir, spec, browser }) => {
    const args = ["cypress", "run", "--headed", "--browser", browser];
    if (spec) args.push("--spec", spec);

    const res = await execa("npx", args, {
      cwd: projectDir,
      all: true,
      windowsHide: false,
      shell: true,
    });

    return {
      content: [
        { type: "text", text: "✅ Cypress headed run finished." },
        { type: "text", text: (res.all || "").slice(-8000) },
      ],
    };
  }
);

// Tool: Run Cypress headless
server.tool(
  "cypress.run",
  {
    projectDir: z.string().default(process.cwd()),
    spec: z.string().optional(),
  },
  async ({ projectDir, spec }) => {
    const args = ["cypress", "run"];
    if (spec) args.push("--spec", spec);

    const res = await execa("npx", args, {
      cwd: projectDir,
      all: true,
      shell: true,
    });

    return {
      content: [
        { type: "text", text: "✅ Cypress run finished." },
        { type: "text", text: (res.all || "").slice(-8000) },
      ],
    };
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
