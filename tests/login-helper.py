import contextlib
import importlib.util
import io
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    'helper', Path(__file__).resolve().parents[1] / 'content/scansci-login.py'
)
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)

COOKIE = {'name': 'fixture', 'domain': 'example.test', 'path': '/', 'value': 'persistent'}


class Page:
    url = 'https://www.sciencedirect.com/science/article/pii/S0169555X22000708'

    def locator(self, _):
        return self

    def get_attribute(self, *args, **kwargs):
        return None

    def evaluate_all(self, _):
        return [self.url + '/pdfft', 'https://www.sciencedirect.com/science/article/pii/S0169555/pdfft']


class Test(unittest.TestCase):
    def test_complete_pii(self):
        urls = helper.pdf_candidates(Page(), Page.url, '10.1016/j.geomorph.2022.108177')
        self.assertTrue(urls)
        self.assertTrue(all('S0169555X22000708' in u for u in urls))

    def test_abs_landing_and_signed_url_host_and_pii(self):
        article = 'https://www.sciencedirect.com/science/article/abs/pii/S2095927326013289?via%3Dihub='
        asset = 'https://pdf.sciencedirectassets.com/fixture/1-s2.0-S2095927326013289/main.pdf?token=fixture'
        self.assertEqual(helper.publisher_pii(article), 'S2095927326013289')
        self.assertEqual(helper.publisher_pii(asset, allow_assets=True), 'S2095927326013289')
        wrong = asset.replace('S2095927326013289', 'S2095927323003687')
        self.assertNotEqual(helper.publisher_pii(wrong + '&next=' + article, allow_assets=True), 'S2095927326013289')
        self.assertEqual(helper.publisher_pii(article.replace('.com/', '.com.example/')), '')
        self.assertEqual(helper.pdf_candidates(Page(), article, '10.1016/j.scib.2026.10.057'), [])

    def flow(self, *, cancel=False, broken_profile=False, broken_cache=False,
             broken_export=False, broken_launch=False, probe_pdf=False, verify=False):
        events = []
        candidates = []

        class TestPage(Page):
            def on(self, event, callback):
                self.download = callback

            def add_init_script(self, _):
                pass

            def bring_to_front(self):
                events.append('show')

            def goto(self, url, **kwargs):
                events.append('probe_pdf' if '/pdfft' in url else 'navigate')
                if not cancel and (not probe_pdf or '/pdfft' in url):
                    if verify and not candidates:
                        self.download(types.SimpleNamespace(
                            url=url.replace('S0169555X22000708', 'S2095927323003687'),
                            save_as=lambda out: self.fail('unrelated URL should not be saved')
                        ))
                    self.download(types.SimpleNamespace(
                        url=url,
                        save_as=lambda out: Path(out).write_bytes(
                            b'%PDF-' + (b'wrong' if verify and not candidates else b'right')
                        )
                    ))

            def is_closed(self):
                return False

            def get_attribute(self, *args, **kwargs):
                return 'cancel' if cancel else None

            def inner_text(self, **kwargs):
                return 'abstract'

            def wait_for_timeout(self, _):
                if verify:
                    pending = Path(str(output) + '.candidate')
                    if pending.exists():
                        candidates.append(pending.read_bytes())
                        decision = Path(str(output) + '.decision')
                        decision.write_text('accept' if len(candidates) == 2 else 'reject')

        class Context:
            browser = None  # Playwright-compatible persistent contexts need not expose a Browser.
            pages = []

            def on(self, event, callback):
                self.watch = callback

            def new_page(self):
                page = TestPage()
                self.watch(page)
                self.pages.append(page)
                return page

            def cookies(self):
                return [COOKIE]

            def add_cookies(self, cookies):
                raise AssertionError('cached cookies must not overwrite persistent browser state')

            def close(self):
                events.append('close')

        def launch(*args, **kwargs):
            self.assertFalse(kwargs['headless'])
            if broken_launch:
                raise RuntimeError('sensitive launch detail')
            return Context()

        def cached(_):
            events.append('read_cache')
            if broken_cache:
                raise ValueError('sensitive cookie detail')
            return [dict(COOKIE, value='stale')]

        def merge(*args):
            events.append('save')
            if broken_export:
                raise OSError('sensitive cookie detail')

        output_log = io.StringIO()
        with tempfile.TemporaryDirectory() as d, contextlib.redirect_stdout(output_log), patch.dict(
            os.environ, {'SCANSCI_PDF_DATA_DIR': d}
        ), patch.dict(sys.modules, {
            'scansci_pdf.config': types.SimpleNamespace(load_config=lambda: {}),
            'scansci_pdf.browser_backend': types.SimpleNamespace(launch_persistent_context=launch),
            'scansci_pdf.browser_cookies': types.SimpleNamespace(load_saved_cookies=cached, merge_cookies=merge),
        }):
            prefs = Path(d) / 'login-browser/Default/Preferences'
            if broken_profile:
                prefs.parent.mkdir(parents=True)
                prefs.write_text('{ incomplete')
            output = Path(d) / 'file.pdf'
            if broken_launch:
                with self.assertRaises(RuntimeError):
                    helper.run(Page.url, str(output), max_wait=2)
            else:
                tick = iter(i * 0.2 for i in range(1000))
                with patch.object(helper.time, 'monotonic', side_effect=lambda: next(tick)):
                    code = helper.run(Page.url, str(output), max_wait=60, verify_in_zotero=verify)
                self.assertEqual(code, 2 if cancel else 0)
                self.assertEqual(output.exists(), not cancel)
                if verify:
                    self.assertEqual(candidates, [b'%PDF-wrong', b'%PDF-right'])
                    self.assertEqual(output.read_bytes(), b'%PDF-right')
            if broken_profile:
                self.assertEqual(prefs.read_text(), '{ incomplete')
        self.assertNotIn('sensitive', output_log.getvalue())
        return events, output_log.getvalue()

    def test_persistent_context_download_event_and_cleanup(self):
        events, log = self.flow()
        self.assertEqual(events, ['show', 'read_cache', 'navigate', 'save', 'close'])
        self.assertIn('login_browser_ready', log)

    def test_cancel_without_save(self):
        events, _ = self.flow(cancel=True)
        self.assertEqual(events, ['show', 'read_cache', 'navigate', 'close'])

    def test_complete_pii_probes_pdf_even_without_a_button(self):
        events, log = self.flow(probe_pdf=True)
        self.assertEqual(events, ['show', 'read_cache', 'navigate', 'probe_pdf', 'save', 'close'])
        self.assertIn('login_pdf_saved', log)

    def test_wrong_download_does_not_close_authenticated_window(self):
        events, log = self.flow(verify=True)
        self.assertIn('login_pdf_skipped_wrong_url', log)
        self.assertIn('login_pdf_rejected_by_identity; continuing', log)
        self.assertIn('login_pdf_saved', log)
        self.assertEqual(events[-2:], ['save', 'close'])

    def test_bad_preferences_and_cache_do_not_block_login(self):
        events, log = self.flow(broken_profile=True, broken_cache=True)
        self.assertEqual(events, ['show', 'read_cache', 'navigate', 'save', 'close'])
        self.assertIn('login_warning=preferences:JSONDecodeError', log)
        self.assertIn('login_warning=cookie_cache:ValueError', log)

    def test_cookie_export_cannot_discard_pdf(self):
        events, log = self.flow(broken_export=True)
        self.assertEqual(events[-2:], ['save', 'close'])
        self.assertIn('login_warning=cookie_export:OSError', log)
        self.assertIn('login_pdf_saved', log)

    def test_launch_failure_reports_stage_without_secrets(self):
        _, log = self.flow(broken_launch=True)
        self.assertIn('login_failed_stage=launch', log)
        self.assertNotIn('login_browser_ready', log)


if __name__ == '__main__':
    unittest.main()
