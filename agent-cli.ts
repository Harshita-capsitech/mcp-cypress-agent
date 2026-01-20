import readline from "node:readline";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/mcp-playwright-server.js"],
  env: Object.fromEntries(Object.entries(process.env).filter(([, v]) => typeof v === "string")) as Record<string, string>,
});

const client = new Client({ name: "ao-email-agent", version: "1.0.0" }, { capabilities: {} });

function okText(text: string) {
  return { content: [{ type: "text", text }] };
}

function getKVLong(key: string, raw: string) {
  const re = new RegExp(`${key}\\s*=\\s*([^]+?)(?:\\s+[a-zA-Z]+\\s*=|$)`, "i");
  return re.exec(raw)?.[1]?.trim();
}

function getAttachments(raw: string): string[] | undefined {
  const v = getKVLong("attach", raw) ?? getKVLong("attachments", raw);
  if (!v) return undefined;
  return v.split(";").map(s => s.trim()).filter(Boolean);
}

async function handlePrompt(prompt: string) {
  const raw = prompt.trim();
  const p = raw.toLowerCase();

  if (p === "login") {
    await client.callTool({ name: "open_login", arguments: {} });
    const r1: any = await client.callTool({ name: "wait_logged_in", arguments: {} });
    const r2: any = await client.callTool({ name: "goto_emails", arguments: {} });
    return { content: [{ type: "text", text: "Login ok" }, ...(r1?.content ?? []), ...(r2?.content ?? [])] };
  }

  if (p === "emails") {
    return client.callTool({ name: "goto_emails", arguments: {} });
  }

  if (p.startsWith("open_email")) {
    const subject = getKVLong("subject", raw);
    const from = getKVLong("from", raw);
    const idxStr = getKVLong("index", raw);
    const index = idxStr ? Number(idxStr) : undefined;

    return client.callTool({
      name: "open_email",
      arguments: { subject, from, index },
    });
  }

  if (p.startsWith("compose")) {
    const to = getKVLong("to", raw);
    const cc = getKVLong("cc", raw);
    const bcc = getKVLong("bcc", raw);
    const subject = getKVLong("subject", raw);
    const body = getKVLong("body", raw);
    const attachments = getAttachments(raw);

    await client.callTool({ name: "open_compose", arguments: {} });

    if (!to || !subject || !body) {
      return {
        content: [
          {
            type: "text",
            text: "Use: compose to=<name> subject=<text> body=<text> [cc=<name>] [bcc=<name>] [attach=path1;path2]",
          },
        ],
        isError: true,
      };
    }

    return client.callTool({
      name: "compose",
      arguments: { to, cc, bcc, subject, body, attachments, autoSend: false },
    });
  }

  if (p === "send") {
    return client.callTool({ name: "send", arguments: {} });
  }

  if (p.startsWith("screenshot")) {
    const parts = raw.split(/\s+/);
    const path = parts[1] ?? "agent.png";
    return client.callTool({ name: "screenshot", arguments: { path } });
  }

  if (p === "help") {
    return okText(
      [
        "Commands:",
        "  login",
        "  emails",
        "  open_email [subject=<text>] [from=<text>] [index=<number>]",
        "  compose to=<name> subject=<text> body=<text> [cc=<name>] [bcc=<name>]",
        "  send",
        "  screenshot [file.png]",
        "  exit",
      ].join("\n")
    );
  }

  return okText("Unknown command. Try: login, emails, open_email, compose, send, screenshot, help");
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
