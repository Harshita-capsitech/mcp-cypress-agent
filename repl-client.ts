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
  return {
    to: parts[0] ?? "",
    subject: parts[1] ?? "",
    body: parts.slice(2).join("|") ?? "",
  };
}

function parseReply(line: string) {
  const rest = line.replace(/^reply\s*\|/i, "").trim();
  return { body: rest };
}

function parseReplyAll(line: string) {
  const rest = line.replace(/^reply_all\s*\|/i, "").trim();
  return { body: rest };
}

function parseForward(line: string) {
  const rest = line.replace(/^forward\s*\|/i, "").trim();
  const parts = rest.split("|").map((s) => s.trim());
  return { to: parts[0] ?? "", body: parts.slice(1).join("|") ?? "" };
}

async function main() {
  try {
    await client.connect(transport);
  } catch (e: any) {
    console.error("Failed to connect:", e?.message ?? e);
    process.exit(1);
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.setPrompt("> ");
  rl.prompt();

  rl.on("line", async (line) => {
    const cmdRaw = line.trim();
    const cmd = cmdRaw.toLowerCase();
    if (!cmdRaw) return rl.prompt();

    try {
      if (cmd === "exit") {
        await client.callTool({ name: "close", arguments: {} });
        rl.close();
        return;
      }

      if (cmd === "open_login") {
        console.log(await client.callTool({ name: "open_login", arguments: {} }));
        return rl.prompt();
      }

      if (cmd === "login") {
        console.log(await client.callTool({ name: "open_login", arguments: {} }));
        console.log(await client.callTool({ name: "wait_logged_in", arguments: {} }));
        console.log(await client.callTool({ name: "goto_emails", arguments: {} }));
        return rl.prompt();
      }

      if (cmd === "wait_logged_in") {
        console.log(await client.callTool({ name: "wait_logged_in", arguments: {} }));
        return rl.prompt();
      }

      if (cmd === "goto_emails" || cmd === "emails") {
        console.log(await client.callTool({ name: "goto_emails", arguments: {} }));
        return rl.prompt();
      }

      if (cmd === "open_email") {
        console.log(await client.callTool({ name: "open_email", arguments: { index: 0 } }));
        return rl.prompt();
      }

      if (cmd.startsWith("open_email ")) {
        const rest = cmdRaw.replace(/^open_email\s+/i, "").trim();
        const idx = Number(rest);
        if (!Number.isFinite(idx)) {
          console.log("Use: open_email <indexNumber>  (example: open_email 0)");
          return rl.prompt();
        }
        console.log(await client.callTool({ name: "open_email", arguments: { index: idx } }));
        return rl.prompt();
      }

      if (cmd === "open_compose") {
        console.log(await client.callTool({ name: "open_compose", arguments: {} }));
        return rl.prompt();
      }

      if (cmd.startsWith("compose ")) {
        const { to, subject, body } = parseCompose(cmdRaw);
        if (!to || !subject || !body) {
          console.log("Use: compose <to> | <subject> | <body>");
          return rl.prompt();
        }
        console.log(
          await client.callTool({
            name: "compose",
            arguments: { to, subject, body, autoSend: false },
          })
        );
        return rl.prompt();
      }

      if (cmd.startsWith("reply_all")) {
        const { body } = parseReplyAll(cmdRaw);
        if (!body) {
          console.log("Use: reply_all | <body>");
          return rl.prompt();
        }
        console.log(
          await client.callTool({
            name: "reply_all_compose",
            arguments: { body, autoSend: false },
          })
        );
        return rl.prompt();
      }

      if (cmd.startsWith("reply")) {
        const { body } = parseReply(cmdRaw);
        if (!body) {
          console.log("Use: reply | <body>");
          return rl.prompt();
        }
        console.log(
          await client.callTool({
            name: "reply_compose",
            arguments: { body, autoSend: false },
          })
        );
        return rl.prompt();
      }

      if (cmd.startsWith("forward")) {
        const { to, body } = parseForward(cmdRaw);
        if (!to || !body) {
          console.log("Use: forward | <to> | <body>");
          return rl.prompt();
        }
        console.log(
          await client.callTool({
            name: "forward_compose",
            arguments: { to, body, autoSend: false },
          })
        );
        return rl.prompt();
      }

      if (cmd === "send") {
        console.log(await client.callTool({ name: "send", arguments: {} }));
        return rl.prompt();
      }

      if (cmd.startsWith("screenshot")) {
        const out = cmdRaw.split(/\s+/)[1] ?? "mcp_debug.png";
        console.log(await client.callTool({ name: "screenshot", arguments: { path: out } }));
        return rl.prompt();
      }

      console.log(
        [
          "Unknown command. Try:",
          "  open_login",
          "  login",
          "  wait_logged_in",
          "  goto_emails",
          "  open_email [index]",
          "  open_compose",
          "  compose <to> | <subject> | <body>",
          "  reply | <body>",
          "  reply_all | <body>",
          "  forward | <to> | <body>",
          "  send",
          "  screenshot [file.png]",
          "  exit",
        ].join("\n")
      );
    } catch (e: any) {
      console.error("Error:", e?.message ?? e);
    }

    rl.prompt();
  });
}

main().catch(console.error);
