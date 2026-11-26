"""Dedicated publisher login; Zotero verifies article identity before import."""
import json
import os
import re
import sys
import time
from pathlib import Path
from urllib.parse import unquote, urlparse

PUBLISHER_HOSTS = {"sciencedirect.com", "www.sciencedirect.com", "linkinghub.elsevier.com"}
ARTICLE_PII = re.compile(r"^/(?:science/article(?:/abs)?|retrieve)/pii/([A-Z0-9]{17})(?:/|$)", re.I)
ASSET_PII = re.compile(r"(?:^|/)1-s2\.0-([A-Z0-9]{17})(?:[/.-]|$)", re.I)
PRIMARY_PDF = '#pdfLink, a[data-testid="pdf-link"], button[data-testid="pdf-link"]'


def publisher_pii(url, *, allow_assets=False):
    try:
        parts = urlparse(url)
        if parts.scheme != "https" or parts.port not in (None, 443) or parts.username or parts.password:
            return ""
        if parts.hostname in PUBLISHER_HOSTS:
            match = ARTICLE_PII.search(parts.path)
        elif allow_assets and parts.hostname == "pdf.sciencedirectassets.com":
            match = ASSET_PII.search(parts.path)
        else:
            return ""
        return match.group(1).upper() if match else ""
    except ValueError:
        return ""


def article_pii(page, url, expected):
    """Bind DOI-only requests to the PII on the matching publisher page."""
    known = publisher_pii(url)
    if known:
        return known
    if expected:
        current = publisher_pii(page.url)
        if current:
            try:
                doi = page.locator('meta[name="citation_doi"]').get_attribute('content', timeout=1500) or ""
            except Exception:
                return ""
            if doi.strip().lower() == expected.strip().lower():
                return current
    return ""


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
        if(action==='done') b.disabled=true;
        else for(const button of box.querySelectorAll('button')) button.disabled=true;
      }); box.appendChild(b);
    }
    document.body.appendChild(box);
  }
  if(document.readyState==='loading') window.addEventListener('DOMContentLoaded',mount,{once:true}); else mount();
})();
"""


def pdf_candidates(page, target, expected_doi="", pii=""):
    doi = re.search(r'10\.\d{4,9}/[^?#\s]+', unquote(expected_doi or target), re.I)
    expected = doi.group().lower() if doi else ""
    pii = pii or article_pii(page, target, expected)
    elsevier = bool(pii) or expected.startswith("10.1016/")
    if elsevier and (not pii or publisher_pii(page.url) != pii):
        return []
    try:
        links = page.locator('meta[name="citation_pdf_url"], a[href]').evaluate_all(
            "(els) => els.map(a => a.content ? new URL(a.content, document.baseURI).href : a.href)"
        )
    except Exception:
        links = []
    candidates = []
    for u in links:
        decoded=unquote(u).lower()
        if urlparse(u).scheme != 'https' or not re.search(r'pdf|download',decoded):
            continue
        if ((elsevier and publisher_pii(u, allow_assets=True) == pii)
                or (not elsevier and expected and expected in decoded)):
            candidates.append(u)
    # ScienceDirect often exposes a button instead of an anchor for the PDF.
    if pii:
        candidates.append('https://www.sciencedirect.com/science/article/pii/' + pii + '/pdfft?isDTMRedir=true&download=true')
    return list(dict.fromkeys(candidates))[:3]


def prepare_profile(profile):
    preferences = profile / 'Default' / 'Preferences'
    preferences.parent.mkdir(parents=True, exist_ok=True)
    try:
        prefs = json.loads(preferences.read_text(encoding='utf-8')) if preferences.exists() else {}
        if not isinstance(prefs, dict) or not isinstance(prefs.setdefault('plugins', {}), dict):
            raise ValueError('invalid Chromium preferences')
        if prefs['plugins'].get('always_open_pdf_externally') is not True:
            prefs['plugins']['always_open_pdf_externally'] = True
            preferences.write_text(json.dumps(prefs), encoding='utf-8')
    except (OSError, ValueError) as e:
        # PDF viewer preferences are optional; Chrome owns and can repair them.
        print('login_warning=preferences:' + type(e).__name__, flush=True)


def restore_cached_cookies(context, config, loader):
    try:
        # Prefer the persistent browser's own state to an older export.
        def key(cookie):
            return (cookie['name'], cookie['domain'], cookie['path'], cookie.get('partitionKey'))
        current = {key(c) for c in context.cookies()}
        missing = [c for c in loader(config) if key(c) not in current]
        if missing:
            context.add_cookies(missing)
    except Exception as e:
        print('login_warning=cookie_cache:' + type(e).__name__, flush=True)


def save_session(context, config, merge):
    try:
        merge(context.cookies(), config)
    except Exception as e:
        # Failure to export the cache should not discard a PDF or the persistent profile.
        print('login_warning=cookie_export:' + type(e).__name__, flush=True)


def run(url, output, max_wait=900, expected_doi="", verify_in_zotero=False):
    stage = "dependencies"
    context = None
    candidate_file = Path(str(output) + ".candidate")
    decision_file = Path(str(output) + ".decision")
    output = Path(output)
    bound_pii = publisher_pii(url)
    elsevier = bool(bound_pii) or expected_doi.lower().startswith("10.1016/")
    try:
        from scansci_pdf.config import load_config
        from scansci_pdf.browser_backend import launch_persistent_context
        stage = "profile"
        config = load_config()
        os.umask(0o077)
        profile = Path(os.environ['SCANSCI_PDF_DATA_DIR']) / 'login-browser'
        prepare_profile(profile)
        stage = "launch"
        context = launch_persistent_context(
            str(profile), headless=False, config=config, accept_downloads=True, timeout=30000
        )
        stage = "context"
        captured = []
        candidate_url = ""
        rejected_urls = set()
        def downloaded(download):
            nonlocal candidate_url
            if captured or candidate_file.exists():
                return
            if download.url in rejected_urls:
                return
            if elsevier and (not bound_pii or publisher_pii(download.url, allow_assets=True) != bound_pii):
                print("login_pdf_skipped_wrong_url", flush=True)
                return
            pending = output.with_suffix(".pdf.part")
            try:
                download.save_as(str(pending))
                with pending.open('rb') as pdf:
                    valid = pdf.read(5) == b'%PDF-'
                if valid:
                    if verify_in_zotero:
                        candidate_url = download.url
                        pending.replace(candidate_file)
                    else:
                        pending.replace(output)
                        captured.append(True)
            except Exception:
                pass
            finally:
                try:
                    pending.unlink(missing_ok=True)
                except OSError:
                    pass
        def watch(p):
            p.on('download', downloaded)
        context.on('page', watch)
        # Reuse one browser tab for URL probes instead of accumulating a tab
        # for every attempt. The source article stays open for SSO.
        pdf_tab = context.pages[0] if context.pages else None
        if pdf_tab is not None:
            watch(pdf_tab)
        # Keep the browser's initial tab alive if a PDF or SSO redirect closes
        # the article tab before the download and cookie export finish.
        page = context.new_page()
        # An explicit completion/cancel control also works when access cannot be inferred.
        page.add_init_script(LOGIN_CONTROLS)
        page.bring_to_front()
        print('login_browser_ready', flush=True)
        try:
            from scansci_pdf.browser_cookies import load_saved_cookies, merge_cookies
        except ImportError:
            print('login_warning=cookie_cache:ImportError', flush=True)
            merge_cookies = None
        else:
            restore_cached_cookies(context, config, load_saved_cookies)
        stage = "navigate"
        try:
            page.goto(url, wait_until='domcontentloaded', timeout=60000)
        except Exception:
            # SSO redirects can interrupt navigation; they do not prove login failure.
            print('navigation_pending', flush=True)
        deadline = time.monotonic() + max_wait
        next_click = 0
        next_probe = 0
        next_navigation = 0
        candidate_index = 0
        while time.monotonic() < deadline:
            if verify_in_zotero and candidate_file.exists() and decision_file.exists():
                verdict = decision_file.read_text(encoding="ascii").strip()
                if verdict == "accept":
                    candidate_file.replace(output)
                    captured.append(True)
                else:
                    rejected_urls.add(candidate_url)
                    candidate_file.unlink()
                    next_navigation = 0
                    print("login_pdf_rejected_by_identity; continuing", flush=True)
                decision_file.unlink()
            if captured:
                if merge_cookies:
                    save_session(context, config, merge_cookies)
                print('login_pdf_saved', flush=True)
                return 0
            if page.is_closed() and not candidate_file.exists():
                print('login_closed_before_pdf', flush=True)
                return 2
            if candidate_file.exists():
                # Keep the login context alive while Zotero checks the actual PDF.
                try:
                    page.wait_for_timeout(250)
                except Exception:
                    time.sleep(0.25)
                continue
            stage = "await_login"
            try:
                action = page.locator('html').get_attribute('data-sf-action', timeout=1500)
            except Exception:
                time.sleep(1)
                continue
            if action == 'cancel':
                return 2
            if action == 'done':
                if merge_cookies:
                    save_session(context, config, merge_cookies)
                print('login_retry_in_same_browser', flush=True)
                page.locator('html').evaluate("el => el.setAttribute('data-sf-action','downloading')")
                next_probe = 0
                next_click = 0
                next_navigation = 0
                rejected_urls.clear()
            if time.monotonic() >= next_probe:
                next_probe = time.monotonic() + 4
                try:
                    bound_pii = bound_pii or article_pii(page, url, expected_doi)
                    candidates = pdf_candidates(page, url, expected_doi, bound_pii)
                    # View PDF opens a signed assets URL in another tab. Consume
                    # that exact URL in the same context; never reconstruct its token.
                    if bound_pii and publisher_pii(page.url) == bound_pii:
                        for tab in context.pages:
                            if (urlparse(tab.url).hostname == 'pdf.sciencedirectassets.com'
                                    and publisher_pii(tab.url, allow_assets=True) == bound_pii):
                                candidates.insert(0, tab.url)
                    if time.monotonic() >= next_click and (
                            not elsevier or bool(bound_pii and publisher_pii(page.url) == bound_pii)):
                        access = page.locator('body').inner_text(timeout=1500).lower()
                        if 'full text access' in access or 'access provided by' in access or action == 'done':
                            next_click = time.monotonic() + 60
                            button = (page.locator(PRIMARY_PDF) if elsevier else
                                      page.get_by_text(re.compile(r'^(View PDF|Download PDF)$', re.I))).first
                            if button.count():
                                button.click(timeout=3000)
                                print('clicked_article_pdf', flush=True)
                except Exception:
                    continue
                candidates = [url for url in dict.fromkeys(candidates) if url not in rejected_urls]
                # One bounded probe per iteration, so UI actions are never queued
                # behind three serial network timeouts.
                # Use real browser navigation, not Node HTTP requests with a
                # different TLS/session context. PDF responses become download events.
                # PII validates a candidate; it must not disable navigation.
                if candidates and not candidate_file.exists() and not captured and time.monotonic() >= next_navigation:
                    next_navigation = time.monotonic() + 12
                    candidate = candidates[candidate_index % len(candidates)]
                    candidate_index += 1
                    if pdf_tab is None or pdf_tab.is_closed():
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
        if context is not None:
            try:
                context.close()
            except Exception:
                pass


if __name__ == '__main__':
    try:
        if sys.argv[1] == '--check':
            from scansci_pdf.browser_backend import launch_persistent_context
            from scansci_pdf.config import load_config
            print('login_helper_dependencies=PASS')
            sys.exit(0)
        code=run(sys.argv[1], sys.argv[2], expected_doi=sys.argv[3] if len(sys.argv) > 3 else "",
                 verify_in_zotero="--verify-in-zotero" in sys.argv[4:])
        print("login_exit="+str(code), flush=True)
        sys.exit(code)
    except Exception as e:
        # Do not serialize cookies or URL query parameters into diagnostics.
        print('login_failed: ' + type(e).__name__, file=sys.stderr)
        sys.exit(1)
