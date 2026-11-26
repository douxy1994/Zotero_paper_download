import fs from 'node:fs'; import vm from 'node:vm'; import assert from 'node:assert/strict';
const c={URL,Zotero:{getMainWindow:()=>null,Attachments:{importFromFile:async x=>x},debug:()=>{}},PathUtils:{join:(...p)=>p.join('/')},IOUtils:{makeDirectory:async()=>{},read:async()=>new Uint8Array([37,80,68,70,45]),exists:async()=>false},Services:{prompt:{confirm:()=>false},dirsvc:{get:()=>({ path: "/tmp", normalize() {} })}},Ci:{nsIFile:{}}};
vm.createContext(c); vm.runInContext(fs.readFileSync('skill-fulltext-downloader.js','utf8')+';this.p=SkillFulltextDownloader',c); const p=c.p;
const validatePDFIdentity=p._validatePDFIdentity;
const originalScan=p._tryScanSci;
let calls=[]; p._scanSciCommand=async a=>calls.push(a);p._pickAttachmentFile=async()=>'/work/scansci/paper.pdf';p._findExistingPDFAttachment=async()=>null;
// Download-chain tests isolate routing; identity checks are tested separately below.
p._validatePDFIdentity=async()=>true;
const item={id:9,getField:()=>''};let a=await p._tryScanSci(item,'10.1/a','/work');assert.equal(a.parentItemID,9);assert.equal(calls[0][0],'get');assert.ok(calls[0].includes('legal_only'));
p._pickAttachmentFile=async()=>null; assert.equal(await p._tryScanSci(item,'q','/work'),null);
p.cancelled=true; let n=calls.length;assert.equal(await p._tryScanSci(item,'q','/work'),null);assert.equal(calls.length,n);
console.log('PASS ScanSci PDF import, explicit strategy, missing PDF, cancellation');
p.cancelled=false; c.IOUtils.exists=async()=>true;c.IOUtils.readUTF8=async()=> 'login_required';c.Services.prompt.confirm=()=>true;
let picks=0;p._pickAttachmentFile=async()=>++picks===1?null:'/w/a.pdf';calls=[];
await p._tryScanSci({id:9,getField:f=>f==='DOI'?'10.1/a':''},'10.1/a','/w');assert.equal(calls.length,2);assert.equal(calls[1][0],'login');
p._scanSciSessionDir=()=>'/private-session';let removed;c.IOUtils.remove=async path=>removed=path;p.isRunning=false;p.activeProcess=null;await p._clearScanSciSession();assert.equal(removed,'/private-session');
console.log('PASS login consent -> login -> retry; clear is scoped to private session');

const target={getField:f=>f==='DOI'?'10.1007/s10346-021-01717-2':f==='title'?'Landslides and fluvial response to landsliding induced by the 1933 Diexi earthquake, Minjiang River, eastern Tibetan Plateau':''};
c.Zotero.PDFWorker={_query:async()=>({text:'Nat. Hazards Earth Syst. Sci. doi:10.5194/nhess-14-2069-2014 Palaeoclimate and palaeoseismic events discovered in Diexi barrier lake on the Minjiang River'})};
await assert.rejects(validatePDFIdentity.call(p,'/wrong.pdf',target),/PDF DOI 不匹配: 10.5194\/nhess-14-2069-2014/);
c.Zotero.PDFWorker._query=async()=>({text:'Landslides and fluvial response to landsliding induced by the 1933 Diexi earthquake, Minjiang River, eastern Tibetan Plateau doi:10.1007/s10346-021-01717-2'});
assert.equal(await validatePDFIdentity.call(p,'/correct.pdf',target),true);
c.Zotero.PDFWorker._query=async()=>({text:'Landslides and fluvial response to landsliding induced by the 1933 Diexi earthquake, Minjiang River, eastern Tibetan Plateau'});
assert.equal(await validatePDFIdentity.call(p,'/title-only.pdf',target),true);
console.log('PASS wrong DOI rejected; expected DOI and strong title match accepted');

const glacier={
  getField:f=>f==='DOI'?'10.1016/j.scib.2026.10.057':f==='title'?
    'Flood warnings face a new challenge from hidden glacier water':''
};
c.Zotero.PDFWorker._query=async (_method, data)=>{
  assert.equal(data.maxPages,1);
  return {text:'Glacial lake outburst floods threaten Asia’s infrastructure. DOI 10.1016/j.scib.2023.05.035. Cited article: 10.1016/j.scib.2026.10.057'};
};
await assert.rejects(validatePDFIdentity.call(p,'/wrong.pdf',glacier),/2023\.05\.035/);
c.Zotero.PDFWorker._query=async()=>({
  text:'Flood warnings face a new challenge from hidden glacier water. DOI 10.1016/\n j.scib.2026.10.057'
});
assert.equal(await validatePDFIdentity.call(p,'/correct.pdf',glacier),true);
console.log('PASS Elsevier first-page identity excludes a cited DOI and accepts a wrapped publication DOI');

// A mismatched PDF from Paper-fetch must be rejected before import and continue to ScanSci.
p.cancelled=false;
p._findExistingPDFAttachment=async()=>null;
p._runPaperFetch=async()=>'/wrong-paper-fetch.pdf';
p._validatePDFIdentity=async()=>{throw new Error('PDF DOI 不匹配: 10.5194/wrong');};
let scanFallbacks=0;
p._tryScanSci=async()=>{scanFallbacks++;return {source:'scansci'};};
const routed=await p._one({id:10,key:'ITEM',getAttachments:()=>[],getField:f=>f==='DOI'?'10.1007/expected':''});
assert.equal(routed.source,'scansci');
assert.equal(scanFallbacks,1);
console.log('PASS mismatched Paper-fetch PDF continues to ScanSci');

// Login failure must not fall back to a stale Paper-fetch API-key message.
p._pickAttachmentFile=async()=>null;
c.IOUtils.writeUTF8=async()=>{};
c.IOUtils.readUTF8=async path=>path.endsWith('scansci-login.log')?'login_browser_ready\nlogin_failed_stage=save_session':'login_required';
p._scanSciCommand=async args=>{if(args[0]==='login'){assert.equal(args[1],'https://linkinghub.elsevier.com/retrieve/pii/S0169555X22000708');throw Error('exit 1');}};
await originalScan.call(p,{id:1,getField:f=>f==='url'?'https://linkinghub.elsevier.com/retrieve/pii/S0169555X22000708':f==='DOI'?'10.1016/j.geomorph.2022.108177':''},'query','/w');
assert.match(p.lastScanSciError,/save_session/);
console.log('PASS exact Elsevier landing URL retained and login-stage failure reported');

const articleURL='https://linkinghub.elsevier.com/retrieve/pii/S0169555X22000708';
const elsevierItem={id:1,getField:f=>f==='url'?articleURL:f==='DOI'?'10.1016/j.geomorph.2022.108177':''};
const shown=[];
const opened=[];
c.Services.prompt.confirm=(_parent,title,body)=>{
  shown.push({title,body});
  return true;
};
c.Zotero.launchURL=()=>{throw new Error('external browser must never be used as a download path');};
p._tryNativeElsevier=async (item, dir, consent)=>{
  opened.push({url:item.getField('url'),consent});
  return dir+'/elsevier-native.pdf';
};
p._validatePDFIdentity=async()=>true;
let loginDiagnostic='login_failed_stage=launch\n';
c.IOUtils.readUTF8=async path=>path.endsWith('scansci-login.log')?loginDiagnostic:'login_required';
const automatic=await originalScan.call(p,elsevierItem,'query','/w');
assert.deepEqual(opened,[{url:articleURL,consent:true}]);
assert.equal(automatic.file,'/w/scansci/elsevier-native.pdf');

loginDiagnostic='login_browser_ready\nlogin_exit=2\n';
await originalScan.call(p,elsevierItem,'query','/w');
assert.match(p.lastScanSciError,/已取消或关闭/);
loginDiagnostic='login_browser_ready\nlogin_exit=3\n';
await originalScan.call(p,elsevierItem,'query','/w');
assert.match(p.lastScanSciError,/等待超时.*机构访问权限/);
assert.deepEqual(opened,[{url:articleURL,consent:true}]);
assert.deepEqual(shown.map(x=>x.title),['ScanSci 登录','ScanSci 登录','ScanSci 登录']);
console.log('PASS failed ScanSci browser starts an automatic native route and imports; cancellation and timeout do not');
