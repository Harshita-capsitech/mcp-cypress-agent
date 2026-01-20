// mcp-playwright-server.ts (COMPLETE UPDATED - forward body OPTIONAL)
import path from "node:path";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
  type Locator,
} from "playwright";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

const APP_BASE = process.env.APP_BASE ?? "http://localhost:5000";
const EMAIL_ROUTE = process.env.EMAIL_ROUTE ?? "/admin/emails";
const TARGET_AFTER_LOGIN = `${APP_BASE.replace(/\/$/, "")}${EMAIL_ROUTE}`;
const LOGIN_URL =
  process.env.LOGIN_URL ?? "https://accountsdev.actingoffice.com/login";

const HEADLESS = process.env.HEADLESS !== "false";
const PROXY_SERVER = process.env.PROXY_SERVER;

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
    process.platform === "linux"
      ? ["--no-sandbox", "--disable-setuid-sandbox"]
      : [];

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

  await safeGoto(page, TARGET_AFTER_LOGIN).catch(async () => {
    await safeGoto(page, LOGIN_URL);
  });

  state.bootstrapped = true;
}

async function waitForUrlStartsWith(
  page: Page,
  target: string,
  timeoutMs = 180000
) {
  const re = new RegExp("^" + escapeRegex(target));
  await page.waitForURL(re, { timeout: timeoutMs });
}

// ---------------- Compose ----------------
async function openComposeLeftNav(page: Page) {
  const sidebar = page
    .locator("nav, aside, [role='navigation'], .ms-Nav, .sidebar, .leftNav")
    .first();

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
  const dlg = page
    .locator('[role="dialog"]:has(button:has-text("Send"))')
    .first();
  if ((await dlg.count()) > 0) return dlg;

  const any = page.locator('div:has(button:has-text("Send"))').first();
  if ((await any.count()) > 0) return any;

  return page.locator("body");
}

async function ensureComposeOpen(page: Page): Promise<Locator> {
  const scope = await getComposeScope(page);
  await scope
    .getByText(/^to$/i)
    .first()
    .waitFor({ state: "visible", timeout: 15000 });
  await scope
    .locator('button:has-text("Send")')
    .first()
    .waitFor({ state: "visible", timeout: 15000 });
  return scope;
}

async function clearCcChips(scope: Locator) {
  const page = scope.page();
  const ccLabel = scope.getByText(/^cc$/i).first();
  if (!(await ccLabel.isVisible().catch(() => false))) return;

  const ccRow = ccLabel
    .locator("xpath=ancestor::div[2]")
    .first()
    .or(ccLabel.locator("xpath=ancestor::div[3]").first());

  const removeBtns = ccRow.locator(
    'button[aria-label*="remove" i], button[title*="remove" i], button:has-text("×"), i[data-icon-name="Cancel"], i[data-icon-name="ChromeClose"]'
  );

  while ((await removeBtns.count()) > 0) {
    await removeBtns.nth(0).click({ force: true }).catch(() => {});
    await page.waitForTimeout(100);
  }
}

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
  await label.waitFor({ state: "visible", timeout: 15000 });

  const input = label.locator("xpath=following::input[1]").first();
  await input.waitFor({ state: "visible", timeout: 15000 });
  await input.click({ force: true });
  await page.waitForTimeout(100);

  const box = await input.boundingBox();
  if (!box) throw new Error(`Could not get bounding box for ${field} input`);

  await page.mouse.click(box.x + box.width - 10, box.y + box.height / 2);
  await page.waitForTimeout(200);

  return box;
}

async function tryGetSuggestionsContainer(
  page: Page,
  timeoutMs = 1200
): Promise<Locator | null> {
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
  timeoutMs = 12000
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

      const below = box.y > inputBox.y + inputBox.height - 2;
      const nearX =
        box.x >= inputBox.x - 40 &&
        box.x <= inputBox.x + inputBox.width + 800;

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

async function pickRecipient(
  scope: Locator,
  field: "to" | "cc" | "bcc",
  value: string
) {
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
      .locator(
        '[role="option"], .ms-Suggestions-item, .ms-Suggestions-itemButton, li, div'
      )
      .filter({ hasText: new RegExp(escapeRegex(value), "i") })
      .first();

    if (await row.isVisible().catch(() => false)) {
      await row.click({ force: true });
      await page.waitForTimeout(200);
    } else {
      await clickSuggestionBelowInput(page, value, inputBox);
    }
  } else {
    await clickSuggestionBelowInput(page, value, inputBox);
  }

  await page.keyboard.press("Tab");
  await page.waitForTimeout(150);
}

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

  if (!ccValue) await clearCcChips(scope);

  await pickRecipient(scope, "to", toValue);
  if (ccValue) await pickRecipient(scope, "cc", ccValue);
  if (bccValue) await pickRecipient(scope, "bcc", bccValue);

  const subj = scope
    .locator(
      'input[placeholder="Add a subject"], input[placeholder="Subject"], input[placeholder*="subject" i]'
    )
    .first();

  await subj.click({ force: true }).catch(() => {});
  await subj.fill(subject).catch(async () => {
    await page.keyboard.type(subject, { delay: 15 });
  });

  await page.waitForTimeout(150);

  const editable = scope.locator('[contenteditable="true"]').first();
  if (await editable.isVisible().catch(() => false)) {
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
  if (await btn.isVisible().catch(() => false)) {
    await btn.click({ force: true });
    await page.waitForTimeout(1200);
    return true;
  }
  return false;
}

// ---------------- Inbox open_email (ROBUST) ----------------
async function waitForInboxToLoad(page: Page, timeoutMs = 20000) {
  const timeMarker = page
    .getByText(/\b\d{1,2}:\d{2}\s?(am|pm)\b/i)
    .first();
  const dateMarker = page.getByText(/\b\d{1,2}\/\d{1,2}\/\d{4}\b/).first();
  const todayHdr = page.getByText(/^today$/i).first();
  const ydayHdr = page.getByText(/^yesterday$/i).first();

  await Promise.race([
    timeMarker.waitFor({ state: "visible", timeout: timeoutMs }).catch(() => {}),
    dateMarker.waitFor({ state: "visible", timeout: timeoutMs }).catch(() => {}),
    todayHdr.waitFor({ state: "visible", timeout: timeoutMs }).catch(() => {}),
    ydayHdr.waitFor({ state: "visible", timeout: timeoutMs }).catch(() => {}),
  ]);

  await page.waitForTimeout(800);
}

async function gotoInbox(page: Page) {
  const inbox = page.getByText(/^inbox$/i).first();
  if (await inbox.isVisible().catch(() => false)) {
    await inbox.click({ force: true });
    await page.waitForTimeout(800);
  }
  await waitForInboxToLoad(page, 20000);
}

function tokens(s?: string) {
  return (s ?? "")
    .trim()
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

function makeTokenLookaheadRegex(s: string) {
  const toks = tokens(s).map(escapeRegex);
  if (toks.length === 0) return null;
  return new RegExp(toks.map((t) => `(?=.*${t})`).join("") + ".*", "i");
}

async function openEmailByFilters(
  page: Page,
  opts: { subject?: string; from?: string; index?: number }
) {
  await gotoInbox(page);

  const fromVal = (opts.from ?? "").trim();
  const subjVal = (opts.subject ?? "").trim();
  const hasFilters = !!fromVal || !!subjVal;

  async function clickAndVerify(row: Locator) {
    await row.scrollIntoViewIfNeeded().catch(() => {});
    await row.click({ force: true }).catch(() => {});
    await page.waitForTimeout(700);

    const noMails = page.getByText(/no mails/i).first();
    if (await noMails.isVisible().catch(() => false)) return false;
    return true;
  }

  async function rowFromChild(child: Locator): Promise<Locator | null> {
    for (const level of [2, 3, 4, 5, 6, 7, 8, 9]) {
      const row = child.locator(`xpath=ancestor::div[${level}]`).first();
      if (!(await row.isVisible().catch(() => false))) continue;

      const box = await row.boundingBox().catch(() => null);
      if (!box) continue;
      if (box.width < 200 || box.height < 40) continue;

      return row;
    }
    return null;
  }

  if (hasFilters) {
    const fromRegex = fromVal ? makeTokenLookaheadRegex(fromVal) : null;
    const subjRegex = subjVal ? makeTokenLookaheadRegex(subjVal) : null;

    if (fromRegex) {
      const senderMatches = page.getByText(fromRegex);
      const senderCount = await senderMatches.count().catch(() => 0);

      if (senderCount === 0) {
        throw new Error(
          `No matching sender found in visible list for: ${fromVal}`
        );
      }

      for (let i = 0; i < Math.min(senderCount, 50); i++) {
        const senderEl = senderMatches.nth(i);
        const row = await rowFromChild(senderEl);
        if (!row) continue;

        if (subjRegex) {
          const subjInRow = row.getByText(subjRegex).first();
          if (!(await subjInRow.isVisible().catch(() => false))) continue;
        }

        if (await clickAndVerify(row))
          return { matched: "from/subject" as const };
      }

      throw new Error(
        "No matching email found for given from/subject. Try index= or relax filters."
      );
    }

    if (subjRegex) {
      const subjMatches = page.getByText(subjRegex);
      const sc = await subjMatches.count().catch(() => 0);

      if (sc === 0)
        throw new Error(
          `No matching subject found in visible list for: ${subjVal}`
        );

      for (let i = 0; i < Math.min(sc, 50); i++) {
        const subjEl = subjMatches.nth(i);
        const row = await rowFromChild(subjEl);
        if (!row) continue;
        if (await clickAndVerify(row)) return { matched: "subject" as const };
      }

      throw new Error(
        "No matching email found for given subject. Try index= or relax filters."
      );
    }

    throw new Error("Provide from=/subject= or index=");
  }

  if (typeof opts.index === "number") {
    const markers = page
      .getByText(/\b\d{1,2}:\d{2}\s?(am|pm)\b/i)
      .or(page.getByText(/\b\d{1,2}\/\d{1,2}\/\d{4}\b/));

    const cnt = await markers.count().catch(() => 0);
    if (cnt === 0) throw new Error("No emails detected for index mode.");

    const idx = Math.max(0, opts.index);
    const mark = markers.nth(Math.min(idx, cnt - 1));
    const row = await rowFromChild(mark);
    if (!row) throw new Error("Could not resolve row for index.");

    if (await clickAndVerify(row)) return { matched: "index" as const };
    throw new Error("Could not click email row for index.");
  }

  throw new Error("Provide from=/subject= or index=");
}

// ---------------- Reply/ReplyAll/Forward (DETAIL VIEW) ----------------
async function ensureEmailDetailOpen(page: Page, timeoutMs = 15000) {
  const replyBtn = page.locator('button:has-text("Reply")').first();
  const replyAllBtn = page.locator('button:has-text("Reply all")').first();
  const forwardBtn = page.locator('button:has-text("Forward")').first();

  await Promise.race([
    replyBtn.waitFor({ state: "visible", timeout: timeoutMs }).catch(() => {}),
    replyAllBtn.waitFor({ state: "visible", timeout: timeoutMs }).catch(() => {}),
    forwardBtn.waitFor({ state: "visible", timeout: timeoutMs }).catch(() => {}),
  ]);
}

async function clickReplyAction(
  page: Page,
  mode: "reply" | "replyAll" | "forward"
) {
  await ensureEmailDetailOpen(page, 15000).catch(() => {});

  const candidates: Locator[] =
    mode === "reply"
      ? [
          page.locator('button:has-text("Reply")').first(),
          page.locator('[role="button"]:has-text("Reply")').first(),
          page.locator('button[aria-label*="reply" i]').first(),
        ]
      : mode === "replyAll"
      ? [
          page.locator('button:has-text("Reply all")').first(),
          page.locator('[role="button"]:has-text("Reply all")').first(),
          page.locator('button[aria-label*="reply all" i]').first(),
          page.locator('button[aria-label*="replyall" i]').first(),
        ]
      : [
          page.locator('button:has-text("Forward")').first(),
          page.locator('[role="button"]:has-text("Forward")').first(),
          page.locator('button[aria-label*="forward" i]').first(),
        ];

  for (const btn of candidates) {
    if (await btn.isVisible().catch(() => false)) {
      await btn.click({ force: true });
      await page.waitForTimeout(900);
      return true;
    }
  }

  throw new Error(`Could not find '${mode}' button on email detail view.`);
}

// reply/forward composer typing
async function ensureReplyComposerOpen(page: Page): Promise<Locator> {
  return ensureComposeOpen(page);
}

async function typeBodyInComposer(page: Page, scope: Locator, body: string) {
  const editable = scope.locator('[contenteditable="true"]').first();
  if (await editable.isVisible().catch(() => false)) {
    await editable.click({ force: true });
    await page.keyboard.type(body, { delay: 10 });
    return;
  }

  await scope.click({ position: { x: 120, y: 260 } }).catch(() => {});
  await page.keyboard.type(body, { delay: 10 });
}

// ---------------- MCP server ----------------
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

const ReplyArgs = z.object({
  mode: z.enum(["reply", "replyAll", "forward"]),
});

const ReplyComposeArgs = z.object({
  body: z.string(),
  autoSend: z.boolean().default(false),
});

const ForwardComposeArgs = z.object({
  to: z.string(),
  body: z.string().optional(), // OPTIONAL
  autoSend: z.boolean().default(false),
});

const ScreenshotArgs = z.object({ path: z.string().default("mcp_debug.png") });

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "open_login",
        description: "Open emails URL to start auth flow",
        inputSchema: { type: "object", properties: {}, required: [] },
      },
      {
        name: "wait_logged_in",
        description: "Wait until emails page loads",
        inputSchema: {
          type: "object",
          properties: { timeoutMs: { type: "number" } },
          required: [],
        },
      },
      {
        name: "goto_emails",
        description: "Navigate to /admin/emails",
        inputSchema: { type: "object", properties: {}, required: [] },
      },
      {
        name: "open_email",
        description: "Open email from Inbox by subject/from OR index",
        inputSchema: {
          type: "object",
          properties: {
            subject: { type: "string" },
            from: { type: "string" },
            index: { type: "number" },
          },
          required: [],
        },
      },
      {
        name: "open_compose",
        description: "Click Compose",
        inputSchema: { type: "object", properties: {}, required: [] },
      },
      {
        name: "compose",
        description:
          "Compose mail (dropdown recipients + optional attachments). Clears CC if cc not provided.",
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
      {
        name: "send",
        description: "Click Send",
        inputSchema: { type: "object", properties: {}, required: [] },
      },
      {
        name: "reply",
        description: "Click Reply / Reply all / Forward on opened email detail view",
        inputSchema: {
          type: "object",
          properties: { mode: { type: "string", enum: ["reply", "replyAll", "forward"] } },
          required: ["mode"],
        },
      },
      {
        name: "reply_compose",
        description: "Reply with body (click Reply then type body).",
        inputSchema: {
          type: "object",
          properties: {
            body: { type: "string" },
            autoSend: { type: "boolean", default: false },
          },
          required: ["body"],
        },
      },
      {
        name: "reply_all_compose",
        description: "Reply all with body (click Reply all then type body).",
        inputSchema: {
          type: "object",
          properties: {
            body: { type: "string" },
            autoSend: { type: "boolean", default: false },
          },
          required: ["body"],
        },
      },
      {
        name: "forward_compose",
        description:
          "Forward with recipient + optional body (click Forward, pick To, optionally type body).",
        inputSchema: {
          type: "object",
          properties: {
            to: { type: "string" },
            body: { type: "string" },
            autoSend: { type: "boolean", default: false },
          },
          required: ["to"], // body NOT required
        },
      },
      {
        name: "screenshot",
        description: "Save screenshot",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string" } },
          required: [],
        },
      },
      {
        name: "close",
        description: "Close browser",
        inputSchema: { type: "object", properties: {}, required: [] },
      },
    ],
  };
});

async function ensureDetailOrOpenFirst(page: Page) {
  try {
    await ensureEmailDetailOpen(page, 2000);
  } catch {
    await openEmailByFilters(page, { index: 0 });
    await ensureEmailDetailOpen(page, 15000);
  }
}

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const name = req.params.name;
  const args = (req.params.arguments ?? {}) as Record<string, unknown>;

  try {
    if (name === "open_login") {
      const page = await getPage();
      await safeGoto(page, TARGET_AFTER_LOGIN).catch(async () =>
        safeGoto(page, LOGIN_URL)
      );
      return { content: [{ type: "text", text: `Opened: ${page.url()}` }] };
    }

    if (name === "wait_logged_in") {
      const { timeoutMs } = WaitLoggedInArgs.parse(args);
      const page = await getPage();
      await waitForUrlStartsWith(page, TARGET_AFTER_LOGIN, timeoutMs ?? 180000);
      state.loggedIn = true;
      return {
        content: [{ type: "text", text: `Logged in. URL: ${page.url()}` }],
      };
    }

    if (name === "goto_emails") {
      const page = await getPage();
      await safeGoto(page, TARGET_AFTER_LOGIN);
      await page.waitForTimeout(1200);
      return {
        content: [{ type: "text", text: `Opened emails: ${page.url()}` }],
      };
    }

    if (name === "open_email") {
      const { subject, from, index } = OpenEmailArgs.parse(args);
      const page = await getPage();
      const res = await openEmailByFilters(page, { subject, from, index });
      return {
        content: [{ type: "text", text: `Opened email (${res.matched})` }],
      };
    }

    if (name === "open_compose") {
      const page = await getPage();
      const ok = await openComposeLeftNav(page);
      if (!ok) throw new Error("Compose not found/clickable");
      await ensureComposeOpen(page);
      return { content: [{ type: "text", text: "Compose opened" }] };
    }

    if (name === "compose") {
      const { to, cc, bcc, subject, body, attachments, autoSend } =
        ComposeArgs.parse(args);
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
        return {
          content: [
            {
              type: "text",
              text: sent ? "Composed + Sent" : "Composed but Send not found",
            },
          ],
        };
      }
      return { content: [{ type: "text", text: "Composed (not sent)" }] };
    }

    if (name === "send") {
      const page = await getPage();
      const sent = await clickSend(page);
      return {
        content: [{ type: "text", text: sent ? "Sent" : "Send not found" }],
      };
    }

    if (name === "reply") {
      const { mode } = ReplyArgs.parse(args);
      const page = await getPage();
      await ensureDetailOrOpenFirst(page);
      const ok = await clickReplyAction(page, mode);
      return {
        content: [{ type: "text", text: ok ? `Clicked ${mode}` : `Failed ${mode}` }],
      };
    }

    if (name === "reply_compose") {
      const { body, autoSend } = ReplyComposeArgs.parse(args);
      const page = await getPage();
      await ensureDetailOrOpenFirst(page);

      await clickReplyAction(page, "reply");
      const scope = await ensureReplyComposerOpen(page);
      await typeBodyInComposer(page, scope, body);

      if (autoSend) {
        const sent = await clickSend(page);
        return {
          content: [
            {
              type: "text",
              text: sent ? "Reply typed + Sent" : "Reply typed but Send not found",
            },
          ],
        };
      }
      return { content: [{ type: "text", text: "Reply typed (not sent)" }] };
    }

    if (name === "reply_all_compose") {
      const { body, autoSend } = ReplyComposeArgs.parse(args);
      const page = await getPage();
      await ensureDetailOrOpenFirst(page);

      await clickReplyAction(page, "replyAll");
      const scope = await ensureReplyComposerOpen(page);
      await typeBodyInComposer(page, scope, body);

      if (autoSend) {
        const sent = await clickSend(page);
        return {
          content: [
            {
              type: "text",
              text: sent ? "Reply all typed + Sent" : "Reply all typed but Send not found",
            },
          ],
        };
      }
      return { content: [{ type: "text", text: "Reply all typed (not sent)" }] };
    }

    if (name === "forward_compose") {
      const { to, body, autoSend } = ForwardComposeArgs.parse(args);
      const page = await getPage();
      await ensureDetailOrOpenFirst(page);

      await clickReplyAction(page, "forward");
      const scope = await ensureReplyComposerOpen(page);

      await pickRecipient(scope, "to", to);

      if (body && body.trim()) {
        await typeBodyInComposer(page, scope, body);
      }

      if (autoSend) {
        const sent = await clickSend(page);
        return {
          content: [
            {
              type: "text",
              text: sent ? "Forward + Sent" : "Forward but Send not found",
            },
          ],
        };
      }
      return { content: [{ type: "text", text: "Forward ready (not sent)" }] };
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
    return {
      content: [{ type: "text", text: `Error: ${e?.message ?? String(e)}` }],
      isError: true,
    };
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
