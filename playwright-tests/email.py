# -*- coding: utf-8 -*-
"""
ActingOffice Email activity simulator (robust waits + compose/reply)
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

    p.add_argument("--compose-to", default="harshita.bhimishetty@capsitech.com")
    p.add_argument("--compose-subject", default="Playwright Email E2E")
    p.add_argument("--compose-body", default="Hello, this is an automated Playwright email test.")

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

    try:
        all_matches = page.get_by_text(re.compile(r"^compose$", re.I))
        for i in range(min(all_matches.count(), 10)):
            node = all_matches.nth(i)
            if node.is_visible():
                node.click(force=True)
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
    scope = page.locator('div:has-text("Compose email")').first
    if scope.count() > 0:
        return scope

    scope2 = page.locator('div:has(button:has-text("Send"))').first
    if scope2.count() > 0:
        return scope2

    return page.locator("body")


def focus_to_in_compose(page, scope) -> bool:
    to_input = scope.locator('input[placeholder="Search recipient"]').first
    if to_input.count() > 0 and to_input.is_visible():
        to_input.click()
        page.wait_for_timeout(150)
        return True

    try:
        to_label = scope.get_by_text(re.compile(r"^to$", re.I)).first
        if to_label.count() > 0:
            cand = to_label.locator('xpath=following::input[1]')
            if cand.count() > 0 and cand.first.is_visible():
                cand.first.click()
                page.wait_for_timeout(150)
                return True
    except Exception:
        pass

    return False


def type_compose(page, to_addr: str, subject: str, body: str, debug=False):
    scope = get_compose_scope(page)

    if debug:
        page.screenshot(path="compose_scope.png", full_page=True)

    if not focus_to_in_compose(page, scope):
        if debug:
            page.screenshot(path="to_field_not_found.png", full_page=True)
        print("⚠️ Could not focus To field inside compose.")
        return

    # ---- type email ----
    page.keyboard.press("Control+A")
    page.keyboard.type(to_addr, delay=20)
    page.wait_for_timeout(600)

    # wait loading...
    loading_any = page.get_by_text(re.compile(r"loading\.\.\.", re.I))
    try:
        if loading_any.count() > 0:
            loading_any.first.wait_for(state="hidden", timeout=15000)
    except Exception:
        pass

    # ✅ NEW: select the row that contains the email (your dropdown is plain text list)
    email_only = to_addr.strip().lower()
    try:
        row = page.get_by_text(re.compile(re.escape(email_only), re.I)).first
        row.wait_for(state="visible", timeout=8000)
        row.click()
        page.wait_for_timeout(300)
    except Exception:
        # fallback keyboard
        page.keyboard.press("ArrowDown")
        page.wait_for_timeout(150)
        page.keyboard.press("Enter")
        page.wait_for_timeout(300)

    # Commit chip by leaving field
    page.keyboard.press("Tab")
    page.wait_for_timeout(250)

    # ---- Subject ----
    subj = scope.locator('input[placeholder="Add a subject"], input[placeholder="Subject"], input[placeholder*="subject" i]')
    if subj.count() > 0 and subj.first.is_visible():
        subj.first.click(force=True)
        subj.first.fill(subject)
    else:
        page.keyboard.type(subject, delay=15)

    page.wait_for_timeout(200)

    # ---- Body ----
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
    scope = get_compose_scope(page)

    send_btn = scope.locator('button:has-text("Send")').first
    if send_btn.count() > 0 and send_btn.is_visible():
        send_btn.click()
        page.wait_for_timeout(1500)
        return True

    if click_first(page, 'button:has-text("Send")', 3000):
        page.wait_for_timeout(1500)
        return True

    if debug:
        page.screenshot(path="send_not_found.png", full_page=True)
    print("⚠️ Send not found.")
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
        type_compose(page, args.compose_to, args.compose_subject, args.compose_body, debug=args.debug)
        click_send(page, debug=args.debug)


def main():
    args = parse_args()

    args.username = args.username or os.getenv("AO_UAT_USER")
    args.password = args.password or os.getenv("AO_UAT_PASS")
    if not args.username or not args.password:
        raise SystemExit("Missing credentials. Provide --username/--password or set AO_UAT_USER/AO_UAT_PASS env vars.")

    app_host = urlparse(args.app_base).netloc
    if not app_host:
        raise SystemExit(f"Invalid --app-base: {args.app_base}")
    app_host_regex = re.compile(rf"^{re.escape(app_host)}$", re.I)

    email_url = f"{args.app_base.rstrip('/')}{args.email_route}"

    print(f"[{datetime.now().isoformat(timespec='seconds')}] Start Email activity")
    print("Email URL :", email_url)
    print("Active    :", args.per_url_seconds, f"({human(args.per_url_seconds)})")

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
