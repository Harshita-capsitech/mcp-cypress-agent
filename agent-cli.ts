import readline from "node:readline";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/mcp-playwright-server.js"],
  env: Object.fromEntries(
    Object.entries(process.env).filter(([, v]) => typeof v === "string")
  ) as Record<string, string>,
});

const client = new Client(
  { name: "ao-email-agent", version: "1.0.0" },
  { capabilities: {} }
);

function okText(text: string) {
  return { content: [{ type: "text", text }] };
}

async function handlePrompt(prompt: string) {
  const raw = prompt.trim();
  const p = raw.toLowerCase();


  if (p === "login") {
    await client.callTool({ name: "open_login", arguments: {} });

    const r1: any = await client.callTool({
      name: "wait_logged_in",
      arguments: {},
    });

    const r2: any = await client.callTool({
      name: "goto_emails",
      arguments: {},
    });

    return {
      content: [
        { type: "text", text: "Login detected  Redirected to /admin/emails " },
        ...(r1?.content ?? []),
        ...(r2?.content ?? []),
      ],
    };
  }

  if (p.includes("go to emails") || p.includes("open emails") || p === "emails") {
    return client.callTool({ name: "goto_emails", arguments: {} });
  }

  if (p.startsWith("compose")) {
    const to = /to\s*=\s*([^\s]+)/i.exec(raw)?.[1];
    const subject = /subject\s*=\s*([^]+?)(?:\s+body\s*=|$)/i.exec(raw)?.[1]?.trim();
    const body = /body\s*=\s*([^]+)$/i.exec(raw)?.[1]?.trim();

    await client.callTool({ name: "open_compose", arguments: {} });

    if (!to || !subject || !body) {
      return {
        content: [
          {
            type: "text",
            text: "Missing fields. Use: compose to=<email> subject=<text> body=<text>",
          },
        ],
        isError: true,
      };
    }

    return client.callTool({
      name: "compose",
      arguments: { to, subject, body, autoSend: false },
    });
  }

  if (p === "send") {
    return client.callTool({ name: "send", arguments: {} });
  }

  if (p.startsWith("screenshot")) {
    const name = raw.split(/\s+/)[1] ?? "agent.png";
    return client.callTool({ name: "screenshot", arguments: { path: name } });
  }

  if (p === "help") {
    return okText(
      [
        "Commands:",
        "  login",
        "  emails",
        "  compose to=<email> subject=<text> body=<text>",
        "  send",
        "  screenshot [file.png]",
        "  exit",
      ].join("\n")
    );
  }

  return okText("Unknown command. Try: login, emails, compose, send, screenshot, help");
}

async function main() {
  await client.connect(transport);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.setPrompt("Agent> ");
  rl.prompt();

  rl.on("line", async (line) => {
    try {
      if (line.trim().toLowerCase() === "exit") {
        await client.callTool({ name: "close", arguments: {} });
        rl.close();
        return;
      }

      const res: any = await handlePrompt(line);
      console.log(res);
    } catch (e: any) {
      console.error("Error:", e?.message ?? e);
    }
    rl.prompt();
  });
}

main().catch(console.error);
