// Minimal MCP stdio client that spawns the MCP server and calls one tool.
// Works from VS Code terminal. No Cursor needed.

const { spawn } = require("child_process");

function callTool(toolName, args = {}) {
  return new Promise((resolve, reject) => {
    // Start MCP server as a child process
    const child = spawn("node", ["mcp/server.js"], {
      cwd: process.cwd(),
      shell: true,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let buffer = "";

    child.stdout.on("data", (d) => {
      buffer += d.toString();

      // MCP over stdio is JSON messages line-by-line
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const t = line.trim();
        if (!t) continue;

        try {
          const msg = JSON.parse(t);

          // When server is ready, call tool
          if (msg.result?.tools || msg.method === "tools/list") {
            // ignore
          }

          // If we got a tool response, resolve and exit
          if (msg.result?.content) {
            resolve(msg.result);
            child.kill();
          }
        } catch {
          // ignore non-json logs
        }
      }
    });

    child.stderr.on("data", (d) => {
      // ignore or print logs
      // console.error(d.toString());
    });

    // Wait a moment, then send tool call message
    setTimeout(() => {
      const request = {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: toolName,
          arguments: args,
        },
      };

      child.stdin.write(JSON.stringify(request) + "\n");
    }, 600);

    // Timeout safety
    setTimeout(() => {
      try {
        child.kill();
      } catch {}
      reject(new Error("Tool call timed out"));
    },  300000);
  });
}

async function main() {
  const tool = process.argv[2];
  const argJson = process.argv[3] ? JSON.parse(process.argv[3]) : {};

  if (!tool) {
    console.log("Usage: node mcp-client/call.js <toolName> '<jsonArgs>'");
    process.exit(1);
  }

  const res = await callTool(tool, argJson);
  console.log(JSON.stringify(res, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
