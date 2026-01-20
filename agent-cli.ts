// ao-email-agent.ts (COMPLETE UPDATED - forward body OPTIONAL)
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

function stripQuotes(v?: string) {
  if (!v) return v;
  const s = v.trim();
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    return s.slice(1, -1).trim();
  }
  return s;
}

function getKVLong(key: string, raw: string) {
  const re = new RegExp(
    `${key}\\s*=\\s*([^]+?)(?:\\s+[a-zA-Z_]+\\s*=|$)`,
    "i"
  );
  return stripQuotes(re.exec(raw)?.[1]?.trim());
}

function getAttachments(raw: string): string[] | undefined {
  const v = getKVLong("attach", raw) ?? getKVLong("attachments", raw);
  if (!v) return undefined;
  return v
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
}

function getBool(key: string, raw: string): boolean | undefined {
  const v = getKVLong(key, raw);
  if (!v) return undefined;
  const s = v.toLowerCase().trim();
  if (s === "true" || s === "1" || s === "yes" || s === "y") return true;
  if (s === "false" || s === "0" || s === "no" || s === "n") return false;
  return undefined;
}

async function handlePrompt(prompt: string) {
  const raw = prompt.trim();
  const p = raw.toLowerCase();

  if (p === "login") {
    await client.callTool({ name: "open_login", arguments: {} });
    await client.callTool({ name: "wait_logged_in", arguments: {} });
    return client.callTool({ name: "goto_emails", arguments: {} });
  }

  if (p === "emails" || p === "goto_emails") {
    return client.callTool({ name: "goto_emails", arguments: {} });
  }

  if (p.startsWith("open_email")) {
    const subject = getKVLong("subject", raw);
    const from =
      getKVLong("from", raw) ??
      getKVLong("name", raw) ??
      getKVLong("sender", raw);
    const idxStr = getKVLong("index", raw);
    const index = idxStr ? Number(idxStr) : undefined;

    return client.callTool({
      name: "open_email",
      arguments: { subject, from, index },
    });
  }

  if (p === "open_compose") {
    return client.callTool({ name: "open_compose", arguments: {} });
  }

  if (p.startsWith("compose")) {
    const to = getKVLong("to", raw);
    const cc = getKVLong("cc", raw);
    const bcc = getKVLong("bcc", raw);
    const subject = getKVLong("subject", raw);
    const body = getKVLong("body", raw);
    const attachments = getAttachments(raw);
    const autoSend = getBool("autosend", raw) ?? false;

    await client.callTool({ name: "open_compose", arguments: {} });

    if (!to || !subject || !body) {
      return {
        content: [
          {
            type: "text",
            text:
              'Use: compose to="name" subject="text" body="text" [cc="name"] [bcc="name"] [attach=path1;path2] [autoSend=true]',
          },
        ],
        isError: true,
      };
    }

    return client.callTool({
      name: "compose",
      arguments: { to, cc, bcc, subject, body, attachments, autoSend },
    });
  }

  // IMPORTANT: check reply_all before reply
  if (p.startsWith("reply_all") || p.startsWith("reply all") || p.startsWith("replyall")) {
    const body = getKVLong("body", raw);
    const autoSend = getBool("autosend", raw) ?? false;

    if (!body) {
      return {
        content: [{ type: "text", text: 'Use: reply_all body="text" [autoSend=true]' }],
        isError: true,
      };
    }

    return client.callTool({
      name: "reply_all_compose",
      arguments: { body, autoSend },
    });
  }

  if (p.startsWith("reply")) {
    const body = getKVLong("body", raw);
    const autoSend = getBool("autosend", raw) ?? false;

    if (!body) {
      return {
        content: [{ type: "text", text: 'Use: reply body="text" [autoSend=true]' }],
        isError: true,
      };
    }

    return client.callTool({
      name: "reply_compose",
      arguments: { body, autoSend },
    });
  }

  // forward: body OPTIONAL
  if (p.startsWith("forward")) {
    const to = getKVLong("to", raw);
    const body = getKVLong("body", raw); // optional
    const autoSend = getBool("autosend", raw) ?? false;

    if (!to) {
      return {
        content: [{ type: "text", text: 'Use: forward to="name" [body="text"] [autoSend=true]' }],
        isError: true,
      };
    }

    return client.callTool({
      name: "forward_compose",
      arguments: { to, body, autoSend },
    });
  }

  if (p === "send") {
    return client.callTool({ name: "send", arguments: {} });
  }

  if (p.startsWith("screenshot")) {
    const file = raw.split(/\s+/)[1] ?? "agent.png";
    return client.callTool({ name: "screenshot", arguments: { path: file } });
  }

  if (p === "help") {
    return {
      content: [
        {
          type: "text",
          text: [
            "Commands:",
            "  login",
            "  emails   (or goto_emails)",
            '  open_email [from="name"] [subject="text"] [index=number]',
            "  open_compose",
            '  compose to="name" subject="text" body="text" [cc="name"] [bcc="name"] [attach=path1;path2] [autoSend=true]',
            '  reply body="text" [autoSend=true]',
            '  reply_all body="text" [autoSend=true]',
            '  forward to="name" [body="text"] [autoSend=true]',
            "  send",
            "  screenshot [file.png]",
            "  exit",
          ].join("\n"),
        },
      ],
    };
  }

  return {
    content: [{ type: "text", text: "Unknown command. Type: help" }],
    isError: true,
  };
}

async function main() {
  try {
    await client.connect(transport);
  } catch (e: any) {
    console.error("Failed to connect to MCP server:", e?.message ?? e);
    process.exit(1);
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
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
