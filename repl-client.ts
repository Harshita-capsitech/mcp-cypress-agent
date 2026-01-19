import readline from "node:readline";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/mcp-playwright-server.js"],
});

const client = new Client(
  { name: "actingoffice-repl", version: "1.0.0" },
  { capabilities: {} }
);

function parseCompose(line: string) {
  const rest = line.replace(/^compose\s+/i, "");
  const parts = rest.split("|").map((s) => s.trim());
  return { to: parts[0] ?? "", subject: parts[1] ?? "", body: parts.slice(2).join("|") ?? "" };
}

async function main() {
  await client.connect(transport);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.setPrompt("> ");
  rl.prompt();

  rl.on("line", async (line) => {
    const cmd = line.trim();
    if (!cmd) return rl.prompt();

    try {
      if (cmd === "exit") {
        await client.callTool({ name: "close", arguments: {} });
        rl.close();
        return;
      }

      if (cmd.startsWith("open_login ")) {
        const loginUrl = cmd.replace(/^open_login\s+/i, "");
        console.log(await client.callTool({ name: "open_login", arguments: { loginUrl } }));
        return rl.prompt();
      }

      if (cmd.startsWith("login ")) {
        const [, username, password, appBase = "http://localhost:5000"] = cmd.split(/\s+/);
        console.log(
          await client.callTool({
            name: "login",
            arguments: { username, password, appBase },
          })
        );
        return rl.prompt();
      }

      if (cmd.startsWith("goto_emails")) {
        console.log(await client.callTool({ name: "goto_emails", arguments: {} }));
        return rl.prompt();
      }

      if (cmd === "open_compose") {
        console.log(await client.callTool({ name: "open_compose", arguments: {} }));
        return rl.prompt();
      }

      if (cmd.startsWith("compose ")) {
        const { to, subject, body } = parseCompose(cmd);
        console.log(await client.callTool({ name: "compose", arguments: { to, subject, body, autoSend: false } }));
        return rl.prompt();
      }

      if (cmd === "send") {
        console.log(await client.callTool({ name: "send", arguments: {} }));
        return rl.prompt();
      }

      if (cmd.startsWith("screenshot")) {
        const path = cmd.split(/\s+/)[1] ?? "mcp_debug.png";
        console.log(await client.callTool({ name: "screenshot", arguments: { path } }));
        return rl.prompt();
      }

      console.log("Unknown command. Try: open_login, login, goto_emails, open_compose, compose, send, screenshot, exit");
    } catch (e: any) {
      console.error("Error:", e?.message ?? e);
    }

    rl.prompt();
  });
}

main().catch(console.error);
