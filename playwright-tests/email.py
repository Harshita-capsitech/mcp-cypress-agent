"""
ActingOffice Email activity simulator (robust waits + compose/reply)

Updated as requested:
- Recipients must be selected ONLY from the dropdown list (NO typing).
- Click row chevron to open list, then click recipient by visible text (name).
- CC/BCC only if user provides --compose-cc / --compose-bcc.
- Does NOT remove existing CC chips (UI defaults stay).
"""

import os
import re
import time
import argparse
from datetime import datetime
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright, expect


def parse_args():
    p = argparse.ArgumentParser(description="ActingOffice Email activity simulator")

    p.add_argument("--login-url", required=True, help="Full Accounts login URL (include full returnUrl)")
    p.add_argument("--app-base", default="http://localhost:5000", help="App base URL after login")
    p.add_argument("--username", help="Login username/email (or set AO_UAT_USER env var)")
    p.add_argument("--password", help="Login password (or set AO_UAT_PASS env var)")

    p.add_argument("--per-url-seconds", type=int, default=60, help="Active time per page")
    p.add_argument("--headless", action="store_true", help="Run headless")
    p.add_argument("--show-console", action="store_true", help="Print browser console logs")

    p.add_argument("--user-selector", default='input[name="email"], input[name="username"], input[type="email"], #Username, input[name="Username"]')
    p.add_argument("--pass-selector", default='input[name="password"], input[type="password"], #Password, input[name="Password"]')
    p.add_argument("--submit-selector", default='button[type="submit"], button[name="login"], input[type="submit"], button:has-text("Log in")')

    p.add_argument("--email-route", default="/admin/emails")

    p.add_argument("--compose-to", default=None, help="Recipient display name from allowed list")
    p.add_argument("--compose-cc", default=None, help="Optional CC display name from list")
    p.add_argument("--compose-bcc", default=None, help="Optional BCC display name from list")

    p.add_argument("--compose-subject", default="Playwright Email E2E")
    p.add_argument("--compose-body", default="Hello, this is an automated Playwright email test.")

    p.add_argument("--stub-practice-config", action="store_true", help="(ignored) legacy/compat flag")
    p.add_argument("--manual-login", action="store_true", help="Open login URL and wait until redirected to app host")
    p.add_argument("--debug", action="store_true", help="Save debug screenshots")
    return p.parse_args()


def human(sec: int) -> str:
    m, s = divmod(int(sec), 60)
    return f"{m:02d}:{s:02d}"


def wait_for_host(page, host_regex: re.Pattern, timeout_ms: int = 180_000):
    start = time.time()
    while True:
        cur = page.url or ""
        host = urlparse(cur).netloc if cur else ""
        if host_regex.search(host):
            return
        if (time.time() - start) * 1000 > timeout_ms:
            raise TimeoutError(f"Timed out waiting for host match. Last URL: {cur}")
        page.wait_for_timeout(300)


def do_login(page, args, app_host_regex: re.Pattern):
    page.goto(args.login_url, wait_until="domcontentloaded")
    page.wait_for_timeout(800)

    if args.manual_login:
        print("Manual login enabled. Please complete login in the opened browser...")
        wait_for_host(page, app_host_regex, timeout_ms=180_000)
        page.wait_for_timeout(1500)
        return

    user_input = page.locator(args.user_selector).first
    expect(user_input).to_be_visible(timeout=60_000)
    user_input.fill(args.username)

    pass_input = page.locator(args.pass_selector).first
    expect(pass_input).to_be_visible(timeout=60_000)
    pass_input.fill(args.password)

    submit = page.locator(args.submit_selector).first
    expect(submit).to_be_enabled(timeout=60_000)

    submit.click(no_wait_after=True)
    wait_for_host(page, app_host_regex, timeout_ms=180_000)
    page.wait_for_timeout(1500)


def click_text(page, pattern: str, timeout_ms: int = 8000) -> bool:
    loc = page.get_by_text(re.compile(pattern, re.I)).first
    try:
        loc.wait_for(state="visible", timeout=timeout_ms)
        loc.click()
        return True
    except Exception:
        return False


def click_first(page, selector: str, timeout_ms: int = 5000) -> bool:
    loc = page.locator(selector).first
    try:
        loc.wait_for(state="visible", timeout=timeout_ms)
        loc.click()
        return True
    except Exception:
        return False


def open_inbox(page):
    click_text(page, r"^inbox$", 8000)
    page.wait_for_timeout(800)


def open_first_mail(page) -> bool:
    rows = page.locator('[role="listitem"], [role="row"]')
    if rows.count() > 0:
        rows.first.click()
        page.wait_for_timeout(1000)
        return True

    if click_text(page, r"test mail|re:", 3000):
        page.wait_for_timeout(1000)
        return True

    return False


def reply_actions(page):
    for label in ["Reply", "Reply all", "Forward"]:
        if click_text(page, rf"^{label}$", 1500):
            page.wait_for_timeout(600)
            page.keyboard.press("Escape")
            page.wait_for_timeout(400)


def open_compose_leftnav(page, debug=False) -> bool:
    sidebar = page.locator("nav, aside, [role='navigation'], .ms-Nav, .sidebar, .leftNav").first
    try:
        if sidebar.count() > 0:
            loc = sidebar.get_by_text(re.compile(r"^compose$", re.I)).first
            loc.wait_for(state="visible", timeout=8000)
            loc.click(force=True)
            page.wait_for_timeout(1200)
            if debug:
                page.screenshot(path="compose_open.png", full_page=True)
            return True
    except Exception:
        pass

    if click_first(page, 'button:has-text("Compose")', 3000):
        page.wait_for_timeout(1200)
        if debug:
            page.screenshot(path="compose_open.png", full_page=True)
        return True

    if debug:
        page.screenshot(path="compose_not_found.png", full_page=True)
    print("⚠️ Compose not found/clickable.")
    return False


def get_compose_scope(page):
    dlg_send = page.locator('[role="dialog"]:has(button:has-text("Send"))').first
    if dlg_send.count() > 0:
        return dlg_send

    scope2 = page.locator('div:has(button:has-text("Send"))').first
    if scope2.count() > 0:
        return scope2

    return page.locator("body")


def ensure_compose_open(page, debug=False):
    scope = get_compose_scope(page)
    try:
        scope.get_by_text(re.compile(r"^to$", re.I)).first.wait_for(state="visible", timeout=8000)
        scope.locator('button:has-text("Send")').first.wait_for(state="visible", timeout=8000)
        return scope
    except Exception:
        if debug:
            page.screenshot(path="compose_not_open.png", full_page=True)
        raise RuntimeError("Compose panel is not open (otherwise it clicks email list).")


def wait_for_suggestion_panel(page, timeout_ms=8000) -> bool:
    candidates = [
        page.locator('[role="listbox"]').first,
        page.locator('.ms-Suggestions').first,
        page.locator('.ms-Suggestions-container').first,
        page.locator('.ms-Callout').first,
    ]
    start = time.time()
    while (time.time() - start) * 1000 < timeout_ms:
        for c in candidates:
            try:
                if c.count() > 0 and c.is_visible():
                    return True
            except Exception:
                pass
        page.wait_for_timeout(150)
    return False


def click_row_dropdown(page, scope, field: str, debug=False) -> bool:
    """
    Click the row dropdown chevron for To/Cc/Bcc row.
    We try multiple ancestor depths; the last button in that row is usually the chevron.
    """
    field = field.lower().strip()
    try:
        label = scope.get_by_text(re.compile(rf"^{field}$", re.I)).first
        label.wait_for(state="visible", timeout=8000)

        for level in [1, 2, 3, 4, 5, 6]:
            row = label.locator(f"xpath=ancestor::div[{level}]")
            if row.count() == 0:
                continue

            btn = row.locator("button").last
            if btn.count() > 0 and btn.is_visible():
                btn.click(force=True)
                page.wait_for_timeout(200)
                return True
    except Exception:
        pass

    if debug:
        page.screenshot(path=f"{field}_chevron_not_found.png", full_page=True)
    return False


def open_recipient_list(page, scope, field: str, debug=False) -> bool:
    field = field.lower().strip()

    if field == "bcc":
        try:
            bcc_btn = scope.get_by_text(re.compile(r"^bcc$", re.I)).first
            if bcc_btn.count() > 0 and bcc_btn.is_visible():
                bcc_btn.click(force=True)
                page.wait_for_timeout(300)
        except Exception:
            if debug:
                page.screenshot(path="bcc_button_click_failed.png", full_page=True)

    click_row_dropdown(page, scope, field, debug=debug)

    ok = wait_for_suggestion_panel(page, timeout_ms=8000)
    if not ok and debug:
        page.screenshot(path=f"{field}_dropdown_not_open.png", full_page=True)
    return ok


def select_recipient_from_list(page, value: str, debug=False) -> bool:
    """
    STRICT: select ONLY from list. NO typing.
    Tries exact match first; then contains match (for items like ' <email>').
    """
    value = (value or "").strip()
    if not value:
        return False

    exact_re = re.compile(rf"^\s*{re.escape(value)}\s*$", re.I)
    contains_re = re.compile(re.escape(value), re.I)

    try:
        listbox = page.locator('[role="listbox"]').first
        if listbox.count() > 0 and listbox.is_visible():
            opt = listbox.get_by_text(exact_re).first
            if opt.count() == 0:
                opt = listbox.get_by_text(contains_re).first

            if opt.count() > 0:
                opt.wait_for(state="visible", timeout=8000)
                opt.click(force=True)
                page.wait_for_timeout(250)
                return True
    except Exception:
        pass

    if debug:
        page.screenshot(path="recipient_value_not_found.png", full_page=True)
    return False


def pick_recipient(page, scope, field: str, value: str, debug=False):
    """
    NO typing. Only open list and click item from list.
    """
    if not value:
        return

    if not open_recipient_list(page, scope, field, debug=debug):
        print(f"⚠️ {field.upper()} list not opened.")
        return

    if not select_recipient_from_list(page, value, debug=debug):
        page.keyboard.press("ArrowDown")
        page.wait_for_timeout(150)
        page.keyboard.press("Enter")
        page.wait_for_timeout(250)

    page.keyboard.press("Tab")
    page.wait_for_timeout(200)


def type_compose(page, to_value: str, cc_value: str, bcc_value: str, subject: str, body: str, debug=False):
    scope = ensure_compose_open(page, debug=debug)
    if debug:
        page.screenshot(path="compose_scope.png", full_page=True)

    pick_recipient(page, scope, "to", to_value, debug=debug)

    if cc_value:
        pick_recipient(page, scope, "cc", cc_value, debug=debug)

    if bcc_value:
        pick_recipient(page, scope, "bcc", bcc_value, debug=debug)

    subj = scope.locator('input[placeholder="Add a subject"], input[placeholder="Subject"], input[placeholder*="subject" i]')
    if subj.count() > 0 and subj.first.is_visible():
        subj.first.click(force=True)
        subj.first.fill(subject)
    else:
        page.keyboard.type(subject, delay=15)

    page.wait_for_timeout(200)

    editable = scope.locator('[contenteditable="true"]').first
    if editable.count() > 0 and editable.is_visible():
        editable.click(force=True)
        page.keyboard.type(body, delay=10)
    else:
        scope.click(position={"x": 120, "y": 260})
        page.keyboard.type(body, delay=10)

    if debug:
        page.screenshot(path="compose_filled.png", full_page=True)


def click_send(page, debug=False) -> bool:
    scope = ensure_compose_open(page, debug=debug)
    btn = scope.locator('button:has-text("Send")').first
    if btn.count() > 0 and btn.is_visible():
        btn.click(force=True)
        page.wait_for_timeout(1500)
        return True

    if debug:
        page.screenshot(path="send_not_found.png", full_page=True)
    return False


def simulate_activity(page, seconds: int):
    start = time.time()
    while time.time() - start < seconds:
        page.mouse.move(400, 300)
        page.keyboard.press("Shift")
        page.wait_for_timeout(2000)


def run_email_flow(page, args):
    page.wait_for_timeout(1500)
    if args.debug:
        page.screenshot(path="emails_loaded.png", full_page=True)

    open_inbox(page)

    if open_first_mail(page):
        reply_actions(page)

    if open_compose_leftnav(page, debug=args.debug):
        type_compose(page, args.compose_to, args.compose_cc, args.compose_bcc, args.compose_subject, args.compose_body, debug=args.debug)
        click_send(page, debug=args.debug)


def main():
    args = parse_args()

    args.username = args.username or os.getenv("AO_UAT_USER")
    args.password = args.password or os.getenv("AO_UAT_PASS")
    if not args.manual_login and (not args.username or not args.password):
        raise SystemExit("Missing credentials. Provide --username/--password or set AO_UAT_USER/AO_UAT_PASS env vars, OR use --manual-login.")

    app_host = urlparse(args.app_base).netloc
    if not app_host:
        raise SystemExit(f"Invalid --app-base: {args.app_base}")
    app_host_regex = re.compile(rf"^{re.escape(app_host)}$", re.I)

    email_url = f"{args.app_base.rstrip('/')}{args.email_route}"

    print(f"[{datetime.now().isoformat(timespec='seconds')}] Start Email activity")
    print("Email URL :", email_url)
    print("Active    :", args.per_url_seconds, f"({human(args.per_url_seconds)})")
    print("ManualLogin:", args.manual_login)

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=args.headless)
        context = browser.new_context(ignore_https_errors=True)
        page = context.new_page()

        if args.show_console:
            page.on("console", lambda m: print("[BROWSER]", m.type, m.text))

        try:
            do_login(page, args, app_host_regex)

            page.goto(email_url, wait_until="domcontentloaded")
            page.wait_for_timeout(2500)

            run_email_flow(page, args)

            simulate_activity(page, args.per_url_seconds)
        finally:
            context.close()
            browser.close()

    print("Done")


if __name__ == "__main__":
    main()
