import unittest,importlib.util,types,tempfile,os,sys
from pathlib import Path
from unittest.mock import patch
s=importlib.util.spec_from_file_location('h',Path(__file__).resolve().parents[1]/'content/scansci-login.py');h=importlib.util.module_from_spec(s);s.loader.exec_module(h)
class Page:
 url='https://www.sciencedirect.com/science/article/pii/S0169555X22000708'
 def locator(self,_):return self
 def get_attribute(self,*a,**k):return None
 def evaluate_all(self,_):return ['https://www.sciencedirect.com/science/article/pii/S0169555X22000708/pdfft','https://www.sciencedirect.com/science/article/pii/S0169555/pdfft']
class Test(unittest.TestCase):
 def test_complete_pii(self):
  urls=h.pdf_candidates(Page(),Page.url,'10.1016/j.geomorph.2022.108177');self.assertTrue(urls);self.assertTrue(all('S0169555X22000708' in u for u in urls))
 def flow(self,cancel):
  saved=[]
  class B:
   closed=False
   def is_connected(self):return True
   def close(self):self.closed=True
  b=B()
  class P(Page):
   def on(self,event,callback):
    if not cancel:callback(types.SimpleNamespace(save_as=lambda out:Path(out).write_bytes(b'%PDF-'+b'x'*1100)))
   def add_init_script(self,*a):pass
   def goto(self,*a,**k):pass
   def is_closed(self):return False
   def get_attribute(self,*a,**k):return 'cancel' if cancel else None
  class C:
   browser=b
   def on(self,e,fn):self.watch=fn
   def new_page(self):p=P();self.watch(p);return p
   def cookies(self):return [{'name':'test','value':'test'}]
  with tempfile.TemporaryDirectory() as d,patch.dict(os.environ,{'SCANSCI_PDF_DATA_DIR':d}),patch.dict(sys.modules,{
   'scansci_pdf.config':types.SimpleNamespace(load_config=lambda:{}),
   'scansci_pdf.browser_backend':types.SimpleNamespace(launch_persistent_context=lambda *a,**k:C()),
   'scansci_pdf.browser_cookies':types.SimpleNamespace(load_saved_cookies=lambda c:[],merge_cookies=lambda *a:saved.append(True))}):
   code=h.run(Page.url,str(Path(d)/'file.pdf'),max_wait=2)
  self.assertEqual(code,2 if cancel else 0);self.assertTrue(b.closed);self.assertEqual(bool(saved),not cancel)
 def test_download_event_closes(self):self.flow(False)
 def test_cancel_without_save(self):self.flow(True)
if __name__=='__main__':unittest.main()
