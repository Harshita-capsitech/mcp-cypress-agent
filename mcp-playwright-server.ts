import { chromium, type Browser, type BrowserContext, type Page, type Locator } from "playwright";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

const APP_BASE = process.env.APP_BASE ?? "http://localhost:5000";
const EMAIL_ROUTE = process.env.EMAIL_ROUTE ?? "/admin/emails";
const TARGET_AFTER_LOGIN = `${APP_BASE.replace(/\/$/, "")}${EMAIL_ROUTE}`;
const LOGIN_URL = process.env.LOGIN_URL ?? "https://accountsdev.actingoffice.com/login";

type State = {
  browser?: Browser;
  context?: BrowserContext;
  page?: Page;
  loggedIn?: boolean;
  bootstrapped?: boolean;
};

const state: State = {};

function escapeRegex(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function ensureBrowser() {
  if (state.browser && state.context && state.page) return;
  state.browser = await chromium.launch({ headless: false });
  state.context = await state.browser.newContext({ ignoreHTTPSErrors: true });
  state.page = await state.context.newPage();
}

async function getPage(): Promise<Page> {
  await ensureBrowser();
  if (!state.page) throw new Error("Page not initialized");
  return state.page;
}

async function bootstrap() {
  if (state.bootstrapped) return;
  const page = await getPage();
  await page.goto(TARGET_AFTER_LOGIN, { waitUntil: "domcontentloaded" }).catch(async () => {
    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });
  });
  state.bootstrapped = true;
}

async function waitForUrlStartsWith(page: Page, target: string, timeoutMs = 180000) {
  const re = new RegExp("^" + escapeRegex(target));
  await page.waitForURL(re, { timeout: timeoutMs });
}

async function openComposeLeftNav(page: Page) {
  const sidebar = page.locator("nav, aside, [role='navigation'], .ms-Nav, .sidebar, .leftNav").first();

  if ((await sidebar.count()) > 0) {
    const compose = sidebar.getByText(/^compose$/i).first();
    if (await compose.isVisible().catch(() => false)) {
      await compose.click({ force: true });
      await page.waitForTimeout(900);
      return true;
    }
  }

  const anyCompose = page.getByText(/^compose$/i).first();
  if (await anyCompose.isVisible().catch(() => false)) {
    await anyCompose.click({ force: true });
    await page.waitForTimeout(900);
    return true;
  }

  const btn = page.locator('button:has-text("Compose")').first();
  if (await btn.isVisible().catch(() => false)) {
    await btn.click({ force: true });
    await page.waitForTimeout(900);
    return true;
  }

  return false;
}

async function getComposeScope(page: Page): Promise<Locator> {
  const dlg = page.locator('[role="dialog"]:has(button:has-text("Send"))').first();
  if ((await dlg.count()) > 0) return dlg;

  const any = page.locator('div:has(button:has-text("Send"))').first();
  if ((await any.count()) > 0) return any;

  return page.locator("body");
}

async function ensureComposeOpen(page: Page): Promise<Locator> {
  const scope = await getComposeScope(page);

  const sendBtn = scope.locator('button:has-text("Send")').first();
  const toLabel = scope.getByText(/^to$/i).first();

  const ok =
    (await sendBtn.isVisible().catch(() => false)) &&
    (await toLabel.isVisible().catch(() => false));

  if (!ok) {
    throw new Error("Compose panel is not open. Run open_compose first (or compose couldn't open it).");
  }

  return scope;
}

/**
 * Open dropdown for a given recipient field by clicking RIGHT EDGE of input (chevron area).
 * Returns bounding box of the input for geometry-based suggestion clicking.
 */
async function openDropdownByInputChevron(
  scope: Locator,
  field: "to" | "cc" | "bcc"
): Promise<{ x: number; y: number; width: number; height: number }> {
  const page = scope.page();

  // reveal bcc field only if requested
  if (field === "bcc") {
    const bccBtn = scope.getByText(/^bcc$/i).first();
    if (await bccBtn.isVisible().catch(() => false)) {
      await bccBtn.click({ force: true });
      await page.waitForTimeout(200);
    }
  }

  const label = scope.getByText(new RegExp(`^${field}$`, "i")).first();
  await label.waitFor({ state: "visible", timeout: 8000 });

  const input = label.locator("xpath=following::input[1]").first();
  await input.waitFor({ state: "visible", timeout: 8000 });
  await input.click({ force: true });
  await page.waitForTimeout(100);

  const box = await input.boundingBox();
  if (!box) throw new Error(`Could not get bounding box for ${field} input`);

  // click chevron area at right edge
  await page.mouse.click(box.x + box.width - 10, box.y + box.height / 2);
  await page.waitForTimeout(200);

  return box;
}

/**
 * Try to detect Fluent UI dropdown container; may not always be detectable.
 */
async function tryGetSuggestionsContainer(page: Page, timeoutMs = 1200): Promise<Locator | null> {
  const candidates = [
    page.locator(".ms-Callout").first(),
    page.locator(".ms-Suggestions").first(),
    page.locator(".ms-Suggestions-container").first(),
  ];

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    for (const c of candidates) {
      if (await c.isVisible().catch(() => false)) return c;
    }
    await page.waitForTimeout(100);
  }
  return null;
}

/**
 * Click the visible suggestion BELOW the input (dropdown area) by geometry.
 */
async function clickSuggestionBelowInput(
  page: Page,
  value: string,
  inputBox: { x: number; y: number; width: number; height: number },
  timeoutMs = 8000
) {
  const re = new RegExp(escapeRegex(value), "i");
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const matches = page.getByText(re);
    const n = await matches.count();

    for (let i = 0; i < n; i++) {
      const el = matches.nth(i);
      if (!(await el.isVisible().catch(() => false))) continue;

      const box = await el.boundingBox().catch(() => null);
      if (!box) continue;

      // dropdown is below the input
      const below = box.y > (inputBox.y + inputBox.height - 2);
      // dropdown is near input x-range
      const nearX = box.x >= (inputBox.x - 30) && box.x <= (inputBox.x + inputBox.width + 400);

      if (below && nearX) {
        await el.scrollIntoViewIfNeeded().catch(() => {});
        await el.click({ force: true });
        await page.waitForTimeout(200);
        return;
      }
    }

    await page.waitForTimeout(150);
  }

  throw new Error(`Suggestion '${value}' did not appear below input`);
}

/**
 * Select recipient from dropdown:
 * - open dropdown
 * - type 2–4 chars to filter
 * - click suggestion row (container-based if possible else geometry)
 */
async function pickRecipient(scope: Locator, field: "to" | "cc" | "bcc", value: string) {
  const page = scope.page();

  const inputBox = await openDropdownByInputChevron(scope, field);

  // filter/search by 2–4 chars (not full)
  const filterText = value.trim().slice(0, 4);
  if (filterText.length > 0) {
    await page.keyboard.type(filterText, { delay: 30 });
    await page.waitForTimeout(250);
  }

  // 1) try container-based click
  const container = await tryGetSuggestionsContainer(page, 1200);
  if (container) {
    const row = container
      .locator('[role="option"], .ms-Suggestions-item, .ms-Suggestions-itemButton, li, div')
      .filter({ hasText: new RegExp(escapeRegex(value), "i") })
      .first();

    if (await row.isVisible().catch(() => false)) {
      await row.click({ force: true });
      await page.waitForTimeout(200);
    } else {
      await clickSuggestionBelowInput(page, value, inputBox, 8000);
    }
  } else {
    await clickSuggestionBelowInput(page, value, inputBox, 8000);
  }

  // commit chip
  await page.keyboard.press("Tab");
  await page.waitForTimeout(150);
}

async function clearCcChips(scope: Locator) {
  const page = scope.page();
  const ccLabel = scope.getByText(/^cc$/i).first();
  if (!(await ccLabel.isVisible().catch(() => false))) return;

  const ccRow = ccLabel.locator("xpath=ancestor::div[2]").first();

  const removeBtns = ccRow.locator(
    'button[aria-label*="remove" i], button[title*="remove" i], button:has-text("×"), i[data-icon-name="Cancel"], i[data-icon-name="ChromeClose"]'
  );

  // click until none left
  while ((await removeBtns.count()) > 0) {
    await removeBtns.nth(0).click({ force: true }).catch(() => {});
    await page.waitForTimeout(100);
  }
}

async function typeCompose(
  page: Page,
  toValue: string,
  ccValue: string | undefined,
  bccValue: string | undefined,
  subject: string,
  body: string
) {
  const scope = await ensureComposeOpen(page);

  // ✅ Clear CC only if user didn’t mention cc=
  if (!ccValue) {
    await clearCcChips(scope);
  }

  await pickRecipient(scope, "to", toValue);
  if (ccValue) await pickRecipient(scope, "cc", ccValue);
  if (bccValue) await pickRecipient(scope, "bcc", bccValue);

  // Subject
  const subj = scope
    .locator('input[placeholder="Add a subject"], input[placeholder="Subject"], input[placeholder*="subject" i]')
    .first();

  if ((await subj.count()) > 0 && (await subj.isVisible().catch(() => false))) {
    await subj.click({ force: true });
    await subj.fill(subject);
  } else {
    await page.keyboard.type(subject, { delay: 15 });
  }

  await page.waitForTimeout(150);

  // Body
  const editable = scope.locator('[contenteditable="true"]').first();
  if ((await editable.count()) > 0 && (await editable.isVisible().catch(() => false))) {
    await editable.click({ force: true });
    await page.keyboard.type(body, { delay: 10 });
  } else {
    await scope.click({ position: { x: 120, y: 260 } });
    await page.keyboard.type(body, { delay: 10 });
  }
}

async function clickSend(page: Page) {
  const scope = await ensureComposeOpen(page);
  const btn = scope.locator('button:has-text("Send")').first();
  if ((await btn.count()) > 0 && (await btn.isVisible().catch(() => false))) {
    await btn.click({ force: true });
    await page.waitForTimeout(1200);
    return true;
  }
  return false;
}

// ---------------- MCP wiring ----------------
const server = new Server(
  { name: "actingoffice-playwright", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

const WaitLoggedInArgs = z.object({ timeoutMs: z.number().optional() });

const ComposeArgs = z.object({
  to: z.string(),
  cc: z.string().optional(),
  bcc: z.string().optional(),
  subject: z.string(),
  body: z.string(),
  autoSend: z.boolean().default(false),
});

const ScreenshotArgs = z.object({ path: z.string().default("mcp_debug.png") });

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      { name: "open_login", description: "Open emails URL to start auth flow", inputSchema: { type: "object", properties: {}, required: [] } },
      { name: "wait_logged_in", description: "Wait until emails page loads", inputSchema: { type: "object", properties: { timeoutMs: { type: "number" } }, required: [] } },
      { name: "goto_emails", description: "Navigate to /admin/emails", inputSchema: { type: "object", properties: {}, required: [] } },
      { name: "open_compose", description: "Click Compose", inputSchema: { type: "object", properties: {}, required: [] } },
      {
        name: "compose",
        description: "Filter then select recipients from dropdown and fill subject/body. Clears CC if cc not provided.",
        inputSchema: {
          type: "object",
          properties: {
            to: { type: "string" },
            cc: { type: "string" },
            bcc: { type: "string" },
            subject: { type: "string" },
            body: { type: "string" },
            autoSend: { type: "boolean", default: false },
          },
          required: ["to", "subject", "body"],
        },
      },
      { name: "send", description: "Click Send", inputSchema: { type: "object", properties: {}, required: [] } },
      { name: "screenshot", description: "Save screenshot", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: [] } },
      { name: "close", description: "Close browser", inputSchema: { type: "object", properties: {}, required: [] } },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const name = req.params.name;
  const args = (req.params.arguments ?? {}) as Record<string, unknown>;

  try {
    if (name === "open_login") {
      const page = await getPage();
      await page.goto(TARGET_AFTER_LOGIN, { waitUntil: "domcontentloaded" });
      return { content: [{ type: "text", text: `Opened: ${TARGET_AFTER_LOGIN}` }] };
    }

    if (name === "wait_logged_in") {
      const { timeoutMs } = WaitLoggedInArgs.parse(args);
      const page = await getPage();
      await waitForUrlStartsWith(page, TARGET_AFTER_LOGIN, timeoutMs ?? 180000);
      state.loggedIn = true;
      return { content: [{ type: "text", text: `Logged in. URL: ${page.url()}` }] };
    }

    if (name === "goto_emails") {
      const page = await getPage();
      await page.goto(TARGET_AFTER_LOGIN, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(1200);
      return { content: [{ type: "text", text: `Opened emails: ${TARGET_AFTER_LOGIN}` }] };
    }

    if (name === "open_compose") {
      const page = await getPage();
      const ok = await openComposeLeftNav(page);
      if (!ok) throw new Error("Compose not found/clickable");
      await ensureComposeOpen(page);
      return { content: [{ type: "text", text: "Compose opened" }] };
    }

    if (name === "compose") {
      const { to, cc, bcc, subject, body, autoSend } = ComposeArgs.parse(args);
      const page = await getPage();

      try {
        await ensureComposeOpen(page);
      } catch {
        const ok = await openComposeLeftNav(page);
        if (!ok) throw new Error("Compose not found/clickable");
        await ensureComposeOpen(page);
      }

      await typeCompose(page, to, cc, bcc, subject, body);

      if (autoSend) {
        const sent = await clickSend(page);
        return { content: [{ type: "text", text: sent ? "Composed + Sent" : "Composed but Send not found" }] };
      }

      return { content: [{ type: "text", text: "Composed (not sent)" }] };
    }

    if (name === "send") {
      const page = await getPage();
      const sent = await clickSend(page);
      return { content: [{ type: "text", text: sent ? "Sent" : "Send not found" }] };
    }

    if (name === "screenshot") {
      const { path } = ScreenshotArgs.parse(args);
      const page = await getPage();
      await page.screenshot({ path, fullPage: true });
      return { content: [{ type: "text", text: `Saved screenshot: ${path}` }] };
    }

    if (name === "close") {
      await state.context?.close().catch(() => {});
      await state.browser?.close().catch(() => {});
      state.browser = undefined;
      state.context = undefined;
      state.page = undefined;
      state.loggedIn = false;
      state.bootstrapped = false;
      return { content: [{ type: "text", text: "Closed browser" }] };
    }

    throw new Error(`Unknown tool: ${name}`);
  } catch (e: any) {
    return { content: [{ type: "text", text: `Error: ${e?.message ?? String(e)}` }], isError: true };
  }
});

async function main() {
  await bootstrap();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
