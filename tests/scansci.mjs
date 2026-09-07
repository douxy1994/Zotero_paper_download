import fs from 'node:fs'; import vm from 'node:vm'; import assert from 'node:assert/strict';
const c={Zotero:{getMainWindow:()=>null,Attachments:{importFromFile:async x=>x},debug:()=>{}},PathUtils:{join:(...p)=>p.join('/')},IOUtils:{makeDirectory:async()=>{},read:async()=>new Uint8Array([37,80,68,70,45]),exists:async()=>false},Services:{prompt:{confirm:()=>false},dirsvc:{get:()=>({path:'/tmp'})}},Ci:{nsIFile:{}}};
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

// A mismatched PDF from Paper-fetch must be rejected before import and continue to ScanSci.
p.cancelled=false;
p._findExistingPDFAttachment=async()=>null;
p._runPaperFetch=async()=>true;
p._pickAttachmentFile=async()=>'/wrong-paper-fetch.pdf';
p._validatePDFIdentity=async()=>{throw new Error('PDF DOI 不匹配: 10.5194/wrong');};
let scanFallbacks=0;
p._tryScanSci=async()=>{scanFallbacks++;return {source:'scansci'};};
const routed=await p._one({id:10,key:'ITEM',getAttachments:()=>[],getField:f=>f==='DOI'?'10.1007/expected':''});
assert.equal(routed.source,'scansci');
assert.equal(scanFallbacks,1);
console.log('PASS mismatched Paper-fetch PDF continues to ScanSci');

// Login failure must not fall back to a stale Paper-fetch API-key message.
p._pickAttachmentFile=async()=>null;
c.IOUtils.readUTF8=async path=>path.endsWith('scansci-login.log')?'login_failed_stage=save_session':'login_required';
p._scanSciCommand=async args=>{if(args[0]==='login'){assert.equal(args[1],'https://linkinghub.elsevier.com/retrieve/pii/S0169555X22000708');throw Error('exit 1');}};
await originalScan.call(p,{id:1,getField:f=>f==='url'?'https://linkinghub.elsevier.com/retrieve/pii/S0169555X22000708':f==='DOI'?'10.1016/j.geomorph.2022.108177':''},'query','/w');
assert.match(p.lastScanSciError,/save_session/);
console.log('PASS exact Elsevier landing URL retained and login-stage failure reported');
