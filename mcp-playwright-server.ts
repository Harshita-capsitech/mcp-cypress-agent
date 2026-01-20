import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page, type Locator } from "playwright";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

const APP_BASE = process.env.APP_BASE ?? "http://localhost:5000";
const EMAIL_ROUTE = process.env.EMAIL_ROUTE ?? "/admin/emails";
const TARGET_AFTER_LOGIN = `${APP_BASE.replace(/\/$/, "")}${EMAIL_ROUTE}`;
const LOGIN_URL = process.env.LOGIN_URL ?? "https://accountsdev.actingoffice.com/login";

const HEADLESS = process.env.HEADLESS !== "false";
const PROXY_SERVER = process.env.PROXY_SERVER; // optional: http://proxy.company.com:8080

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

async function safeGoto(page: Page, url: string, tries = 3) {
  let lastErr: any;
  for (let i = 0; i < tries; i++) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
      return;
    } catch (e) {
      lastErr = e;
      await page.waitForTimeout(1000);
    }
  }
  throw lastErr;
}

async function ensureBrowser() {
  if (state.browser && state.context && state.page) return;

  const launchArgs: string[] =
    process.platform === "linux" ? ["--no-sandbox", "--disable-setuid-sandbox"] : [];

  // ✅ Use installed Chrome (best for enterprise networks)
  // If Chrome is not installed, remove channel line.
  state.browser = await chromium.launch({
    channel: "chrome",
    headless: HEADLESS,
    args: launchArgs,
    proxy: PROXY_SERVER ? { server: PROXY_SERVER } : undefined,
  });

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

  // ✅ retry navigation (prevents chrome-error://chromewebdata flake)
  await safeGoto(page, TARGET_AFTER_LOGIN).catch(async () => {
    await safeGoto(page, LOGIN_URL);
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

  await scope.getByText(/^to$/i).first().waitFor({ state: "visible", timeout: 10000 });
  await scope.locator('button:has-text("Send")').first().waitFor({ state: "visible", timeout: 10000 });

  return scope;
}

/**
 * Clear CC chips only if user didn't provide cc=
 */
async function clearCcChips(scope: Locator) {
  const page = scope.page();
  const ccLabel = scope.getByText(/^cc$/i).first();
  if (!(await ccLabel.isVisible().catch(() => false))) return;

  const ccRow =
    ccLabel.locator("xpath=ancestor::div[2]").first().or(ccLabel.locator("xpath=ancestor::div[3]").first());

  const removeBtns = ccRow.locator(
    'button[aria-label*="remove" i], button[title*="remove" i], button:has-text("×"), i[data-icon-name="Cancel"], i[data-icon-name="ChromeClose"]'
  );

  while ((await removeBtns.count()) > 0) {
    await removeBtns.nth(0).click({ force: true }).catch(() => {});
    await page.waitForTimeout(100);
  }
}

/**
 * Open dropdown by clicking right edge of input (chevron area).
 */
async function openDropdownByInputChevron(
  scope: Locator,
  field: "to" | "cc" | "bcc"
): Promise<{ x: number; y: number; width: number; height: number }> {
  const page = scope.page();

  if (field === "bcc") {
    const bccBtn = scope.getByText(/^bcc$/i).first();
    if (await bccBtn.isVisible().catch(() => false)) {
      await bccBtn.click({ force: true });
      await page.waitForTimeout(200);
    }
  }

  const label = scope.getByText(new RegExp(`^${field}$`, "i")).first();
  await label.waitFor({ state: "visible", timeout: 10000 });

  const input = label.locator("xpath=following::input[1]").first();
  await input.waitFor({ state: "visible", timeout: 10000 });
  await input.click({ force: true });
  await page.waitForTimeout(100);

  const box = await input.boundingBox();
  if (!box) throw new Error(`Could not get bounding box for ${field} input`);

  await page.mouse.click(box.x + box.width - 10, box.y + box.height / 2);
  await page.waitForTimeout(200);

  return box;
}

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

async function clickSuggestionBelowInput(
  page: Page,
  value: string,
  inputBox: { x: number; y: number; width: number; height: number },
  timeoutMs = 10000
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

      const below = box.y > (inputBox.y + inputBox.height - 2);
      const nearX = box.x >= (inputBox.x - 30) && box.x <= (inputBox.x + inputBox.width + 600);

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
 * filter (2-4 chars) + select from dropdown
 */
async function pickRecipient(scope: Locator, field: "to" | "cc" | "bcc", value: string) {
  const page = scope.page();
  const inputBox = await openDropdownByInputChevron(scope, field);

  const filterText = value.trim().slice(0, 4);
  if (filterText.length > 0) {
    await page.keyboard.type(filterText, { delay: 30 });
    await page.waitForTimeout(250);
  }

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
      await clickSuggestionBelowInput(page, value, inputBox, 10000);
    }
  } else {
    await clickSuggestionBelowInput(page, value, inputBox, 10000);
  }

  await page.keyboard.press("Tab");
  await page.waitForTimeout(150);
}

/**
 * Attachments helper (portable paths)
 */
async function addAttachments(page: Page, scope: Locator, filePaths: string[]) {
  if (!filePaths.length) return;

  const files = filePaths.map((p) => path.resolve(p));

  const fileInput = scope.locator('input[type="file"]').first();
  if ((await fileInput.count()) > 0) {
    await fileInput.setInputFiles(files);
    await page.waitForTimeout(1500);
    return;
  }

  const attachButtons = [
    scope.locator('button:has-text("Attach")').first(),
    scope.locator('button[aria-label*="attach" i]').first(),
    scope.locator('[role="button"][aria-label*="attach" i]').first(),
  ];

  for (const btn of attachButtons) {
    if (await btn.isVisible().catch(() => false)) {
      const [chooser] = await Promise.all([
        page.waitForEvent("filechooser", { timeout: 8000 }),
        btn.click({ force: true }),
      ]);
      await chooser.setFiles(files);
      await page.waitForTimeout(1500);
      return;
    }
  }

  throw new Error("Could not find file input or Attach button in compose.");
}

async function typeCompose(
  page: Page,
  toValue: string,
  ccValue: string | undefined,
  bccValue: string | undefined,
  subject: string,
  body: string,
  attachments: string[] | undefined
) {
  const scope = await ensureComposeOpen(page);

  if (!ccValue) {
    await clearCcChips(scope);
  }

  await pickRecipient(scope, "to", toValue);
  if (ccValue) await pickRecipient(scope, "cc", ccValue);
  if (bccValue) await pickRecipient(scope, "bcc", bccValue);

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

  const editable = scope.locator('[contenteditable="true"]').first();
  if ((await editable.count()) > 0 && (await editable.isVisible().catch(() => false))) {
    await editable.click({ force: true });
    await page.keyboard.type(body, { delay: 10 });
  } else {
    await scope.click({ position: { x: 120, y: 260 } });
    await page.keyboard.type(body, { delay: 10 });
  }

  if (attachments?.length) {
    await addAttachments(page, scope, attachments);
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

// Inbox load wait
async function waitForInboxToLoad(page: Page, timeoutMs = 15000) {
  const timeMarker = page.locator('text=/\\b\\d{1,2}:\\d{2}\\s?(AM|PM)\\b/i').first();
  const dateMarker = page.locator('text=/\\b\\d{2}\\/\\d{2}\\/\\d{4}\\b/').first();

  await Promise.race([
    timeMarker.waitFor({ state: "visible", timeout: timeoutMs }).catch(() => {}),
    dateMarker.waitFor({ state: "visible", timeout: timeoutMs }).catch(() => {}),
  ]);

  await page.waitForTimeout(600);
}

async function gotoInbox(page: Page) {
  const inbox = page.getByText(/^inbox$/i).first();
  if (await inbox.isVisible().catch(() => false)) {
    await inbox.click({ force: true });
    await page.waitForTimeout(800);
  }
  await waitForInboxToLoad(page, 15000);
}

async function openEmailByFilters(page: Page, opts: { subject?: string; from?: string; index?: number }) {
  await gotoInbox(page);

  const subjectRe = opts.subject ? new RegExp(escapeRegex(opts.subject), "i") : null;
  const fromRe = opts.from ? new RegExp(escapeRegex(opts.from), "i") : null;

  const markers = page.locator(
    'text=/\\b\\d{1,2}:\\d{2}\\s?(AM|PM)\\b/i, text=/\\b\\d{2}\\/\\d{2}\\/\\d{4}\\b/'
  );

  const mCount = await markers.count();
  if (mCount === 0) throw new Error("No emails found (markers=0).");

  const rowCandidates: Locator[] = [];
  const max = Math.min(mCount, 50);

  for (let i = 0; i < max; i++) {
    const mark = markers.nth(i);
    for (const level of [2, 3, 4, 5, 6]) {
      rowCandidates.push(mark.locator(`xpath=ancestor::div[${level}]`).first());
    }
  }

  async function tryClickRow(row: Locator) {
    if (!(await row.isVisible().catch(() => false))) return false;
    await row.scrollIntoViewIfNeeded().catch(() => {});
    await row.click({ force: true }).catch(() => {});
    await page.waitForTimeout(800);
    return true;
  }

  if (subjectRe && fromRe) {
    for (const r of rowCandidates) {
      const t = (await r.innerText().catch(() => "")) || "";
      if (subjectRe.test(t) && fromRe.test(t)) {
        if (await tryClickRow(r)) return { matched: "subject+from" };
      }
    }
  }

  if (subjectRe) {
    for (const r of rowCandidates) {
      const t = (await r.innerText().catch(() => "")) || "";
      if (subjectRe.test(t)) {
        if (await tryClickRow(r)) return { matched: "subject" };
      }
    }
  }

  if (fromRe) {
    for (const r of rowCandidates) {
      const t = (await r.innerText().catch(() => "")) || "";
      if (fromRe.test(t)) {
        if (await tryClickRow(r)) return { matched: "from" };
      }
    }
  }

  const idx = Math.max(0, opts.index ?? 0);
  const mark = markers.nth(Math.min(idx, max - 1));
  for (const level of [2, 3, 4, 5, 6]) {
    const row = mark.locator(`xpath=ancestor::div[${level}]`).first();
    if (await tryClickRow(row)) return { matched: "index" };
  }

  throw new Error("Could not click any inbox row.");
}

// MCP server
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
  attachments: z.array(z.string()).optional(),
  autoSend: z.boolean().default(false),
});

const OpenEmailArgs = z.object({
  subject: z.string().optional(),
  from: z.string().optional(),
  index: z.number().optional(),
});

const ScreenshotArgs = z.object({ path: z.string().default("mcp_debug.png") });

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      { name: "open_login", description: "Open emails URL to start auth flow", inputSchema: { type: "object", properties: {}, required: [] } },
      { name: "wait_logged_in", description: "Wait until emails page loads", inputSchema: { type: "object", properties: { timeoutMs: { type: "number" } }, required: [] } },
      { name: "goto_emails", description: "Navigate to /admin/emails", inputSchema: { type: "object", properties: {}, required: [] } },
      { name: "open_email", description: "Open email from Inbox by subject/from or index", inputSchema: { type: "object", properties: { subject: { type: "string" }, from: { type: "string" }, index: { type: "number" } }, required: [] } },
      { name: "open_compose", description: "Click Compose", inputSchema: { type: "object", properties: {}, required: [] } },
      {
        name: "compose",
        description: "Compose with dropdown recipients + optional attachments; clears CC if cc not provided",
        inputSchema: {
          type: "object",
          properties: {
            to: { type: "string" },
            cc: { type: "string" },
            bcc: { type: "string" },
            subject: { type: "string" },
            body: { type: "string" },
            attachments: { type: "array", items: { type: "string" } },
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
      await safeGoto(page, TARGET_AFTER_LOGIN).catch(async () => safeGoto(page, LOGIN_URL));
      return { content: [{ type: "text", text: `Opened: ${page.url()}` }] };
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
      await safeGoto(page, TARGET_AFTER_LOGIN);
      await page.waitForTimeout(1200);
      return { content: [{ type: "text", text: `Opened emails: ${page.url()}` }] };
    }

    if (name === "open_email") {
      const { subject, from, index } = OpenEmailArgs.parse(args);
      const page = await getPage();
      const res = await openEmailByFilters(page, { subject, from, index });
      return { content: [{ type: "text", text: `Opened email (${res.matched})` }] };
    }

    if (name === "open_compose") {
      const page = await getPage();
      const ok = await openComposeLeftNav(page);
      if (!ok) throw new Error("Compose not found/clickable");
      await ensureComposeOpen(page);
      return { content: [{ type: "text", text: "Compose opened" }] };
    }

    if (name === "compose") {
      const { to, cc, bcc, subject, body, attachments, autoSend } = ComposeArgs.parse(args);
      const page = await getPage();

      try {
        await ensureComposeOpen(page);
      } catch {
        const ok = await openComposeLeftNav(page);
        if (!ok) throw new Error("Compose not found/clickable");
        await ensureComposeOpen(page);
      }

      await typeCompose(page, to, cc, bcc, subject, body, attachments);

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
      const { path: out } = ScreenshotArgs.parse(args);
      const page = await getPage();
      await page.screenshot({ path: out, fullPage: true });
      return { content: [{ type: "text", text: `Saved screenshot: ${out}` }] };
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
