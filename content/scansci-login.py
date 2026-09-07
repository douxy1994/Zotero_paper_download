"""Dedicated publisher login. Only a verified PDF closes the window automatically."""
import json
import os
import re
import sys
import time
from pathlib import Path
from urllib.parse import unquote, urlparse, urljoin


LOGIN_CONTROLS = r"""
(() => {
  function mount() {
    if (!document.body || document.getElementById('sf-login-controls')) return;
    const box=document.createElement('div'); box.id='sf-login-controls';
    box.style='position:fixed;bottom:16px;right:16px;z-index:2147483647;background:white;color:black;padding:14px;border:2px solid #2877c9;border-radius:8px;font:14px system-ui';
    const status=document.createElement('span'); status.textContent='登录完成后点击保存；自动检测本篇 PDF 中。';box.appendChild(status);
    for(const [text,action] of [['已登录，保存并重试','done'],['取消登录','cancel']]) {
      const b=document.createElement('button'); b.type='button'; b.textContent=text; b.dataset.sfAction=action; b.style='margin:6px;padding:8px';
      b.addEventListener('click', event => {
        event.preventDefault(); event.stopPropagation();
        document.documentElement.setAttribute('data-sf-action', action);
        status.textContent=action==='done'?'已收到，正在保存会话…':'已收到，正在关闭…';
        for(const button of box.querySelectorAll('button')) button.disabled=true;
      }); box.appendChild(b);
    }
    document.body.appendChild(box);
  }
  if(document.readyState==='loading') window.addEventListener('DOMContentLoaded',mount,{once:true}); else mount();
})();
"""


def pdf_candidates(page, target, expected_doi=""):
    doi = re.search(r'10\.\d{4,9}/[^?#\s]+', unquote(expected_doi or target), re.I)
    expected = doi.group().lower() if doi else ""
    # PII must be a complete 17-character Elsevier identifier. Never accept a prefix.
    initial_pii = re.search(r'/pii/([A-Z0-9]{17})(?:[/?#]|$)', target, re.I)
    pii = initial_pii.group(1).upper() if initial_pii else ""
    if not pii and expected:
        try:
            article_doi = page.locator('meta[name="citation_doi"]').get_attribute('content') or ""
            current = re.search(r'/pii/([A-Z0-9]{17})(?:[/?#]|$)', page.url, re.I)
            if article_doi.lower().strip() == expected and current:
                pii = current.group(1).upper()
        except Exception:
            pass
    links = page.locator('a[href]').evaluate_all('(els) => els.map(a => a.href)')
    candidates=[]
    for u in links:
        decoded=unquote(u).lower()
        if urlparse(u).scheme != 'https' or not re.search(r'pdf|download',decoded):
            continue
        if (expected and expected in decoded) or (pii and re.search(r'/pii/' + re.escape(pii.lower()) + r'(?:[/?#]|$)',decoded)):
            candidates.append(u)
    # ScienceDirect often exposes a button instead of an anchor for the PDF.
    if pii:
        candidates.append('https://www.sciencedirect.com/science/article/pii/' + pii + '/pdfft?isDTMRedir=true&download=true')
    return list(dict.fromkeys(candidates))[:3]


def run(url, output, max_wait=900, expected_doi=""):
    stage = "launch"
    from scansci_pdf.config import load_config
    from scansci_pdf.browser_backend import launch_persistent_context
    from scansci_pdf.browser_cookies import load_saved_cookies, merge_cookies
    config = load_config()
    os.umask(0o077)
    profile = Path(os.environ['SCANSCI_PDF_DATA_DIR']) / 'login-browser'
    preferences = profile / 'Default' / 'Preferences'
    preferences.parent.mkdir(parents=True, exist_ok=True)
    prefs = json.loads(preferences.read_text()) if preferences.exists() else {}
    prefs.setdefault('plugins', {})['always_open_pdf_externally'] = True
    preferences.write_text(json.dumps(prefs))
    context = launch_persistent_context(str(profile), headless=False, config=config, accept_downloads=True)
    browser = context.browser
    try:
        stage = "context"

        cookies = load_saved_cookies(config)
        if cookies:
            context.add_cookies(cookies)
        captured = []
        def downloaded(download):
            try:
                download.save_as(output)
                if Path(output).read_bytes().startswith(b'%PDF-'):
                    captured.append(True)
            except Exception:
                pass
        def watch(p):
            p.on('download', downloaded)
        context.on('page', watch)
        page = context.new_page()
        # An explicit completion/cancel control also works when access cannot be inferred.
        page.add_init_script(LOGIN_CONTROLS)
        stage = "navigate"
        try:
            page.goto(url, wait_until='domcontentloaded', timeout=60000)
        except Exception:
            # SSO redirects can interrupt navigation; they do not prove login failure.
            print('navigation_pending', flush=True)
        deadline = time.monotonic() + max_wait
        next_click = 0
        next_probe = 0
        candidate_index = 0
        while time.monotonic() < deadline:
            if (page.is_closed() or not browser.is_connected()) and not captured:
                print('login_closed_before_pdf', flush=True)
                return 2
            if captured:
                merge_cookies(context.cookies(), config)
                print('pdf_saved_and_session_saved', flush=True)
                return 0
            stage = "await_login"
            try:
                action = page.locator('html').get_attribute('data-sf-action', timeout=1500)
            except Exception:
                time.sleep(1)
                continue
            if action == 'cancel':
                return 2
            if action == 'done':
                stage = "save_session"
                merge_cookies(context.cookies(), config)
                print('session_saved_download_in_same_browser', flush=True)
                page.locator('html').evaluate("el => el.setAttribute('data-sf-action','downloading')")
                next_probe = 0
                next_click = 0
            if time.monotonic() >= next_probe:
                next_probe = time.monotonic() + 4
                try:
                    candidates = pdf_candidates(page, url, expected_doi)
                    # View PDF opens a signed assets URL in another tab. Consume
                    # that exact URL in the same context; never reconstruct its token.
                    pii_match = re.search(r'/pii/([A-Z0-9]{17})(?:[/?#]|$)', url, re.I)
                    pii = pii_match.group(1).lower() if pii_match else ""
                    for tab in context.pages:
                        host = urlparse(tab.url).hostname or ""
                        if host.endswith('.sciencedirectassets.com') and pii and pii in tab.url.lower():
                            candidates.insert(0, tab.url)
                    if time.monotonic() >= next_click:
                        access = page.locator('body').inner_text(timeout=1500).lower()
                        if 'full text access' in access or 'access provided by' in access or action == 'done':
                            next_click = time.monotonic() + 60
                            button = page.get_by_text(re.compile(r'^(View PDF|Download PDF)$', re.I)).first
                            if button.count():
                                button.click(timeout=3000)
                                print('clicked_article_pdf', flush=True)
                except Exception:
                    continue
                # One bounded probe per iteration, so UI actions are never queued
                # behind three serial network timeouts.
                if candidates:
                    candidate = candidates[0] if any("sciencedirectassets.com" in u for u in candidates) else candidates[candidate_index % len(candidates)]
                    candidate_index += 1
                # Use real browser navigation, not Node HTTP requests with a
                # different TLS/session context. PDF responses become download events.
                if candidates and not pii and time.monotonic() >= next_click:
                    next_click = time.monotonic() + 60
                    pdf_tab = context.new_page()
                    try:
                        pdf_tab.goto(candidate, wait_until='commit', timeout=15000)
                    except Exception:
                        pass
            try:
                page.wait_for_timeout(1000)
            except Exception:
                time.sleep(1)
        print('login_timeout', flush=True)
        return 3
    except Exception:
        print('login_failed_stage=' + stage, flush=True)
        raise
    finally:
        try:
            browser.close()
        except Exception:
            pass


if __name__ == '__main__':
    try:
        if sys.argv[1] == '--check':
            from scansci_pdf.browser_backend import launch_persistent_context
            from scansci_pdf.browser_cookies import merge_cookies
            print('login_helper_dependencies=PASS')
            sys.exit(0)
        code=run(sys.argv[1], sys.argv[2], expected_doi=sys.argv[3] if len(sys.argv) > 3 else "")
        print("login_exit="+str(code), flush=True)
        sys.exit(code)
    except Exception as e:
        # Do not serialize cookies or URL query parameters into diagnostics.
        print('login_failed: ' + type(e).__name__, file=sys.stderr)
        sys.exit(1)
