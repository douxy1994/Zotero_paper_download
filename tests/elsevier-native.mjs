import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const doi = "10.1016/j.scib.2026.10.057";
const pii = "S2095927326013289";
const article = "https://www.sciencedirect.com/science/article/pii/" + pii;
const display = article + "?signed=login-result";
const doiURL = "https://doi.org/" + doi;
const pdfURL = article + "/pdfft?download=true";
const response = (status, value = "", contentType = "", responseURL = "") => ({
  status, response: new TextEncoder().encode(value).buffer, responseURL,
  getResponseHeader: name => name === "Content-Type" ? contentType : null,
});

const requested = [];
const imported = [];
const files = new Map();
let loggedIn = false;
let openCalls = 0;
let prompts = 0;
let delayCalls = 0;
let closed = false;
let confirmed = true;
let validation = 0;
const ctx = {
  URL, TextDecoder,
  Zotero: {
    isWin: true,
    getMainWindow: () => null,
    debug: () => {},
    openInViewer: url => {
      assert.equal(url, article);
      openCalls++;
      closed = false;
      return {get closed() {return closed;}, close: () => {closed = true;},
        document: {querySelector: () => ({currentURI: {spec: loggedIn ? display : "https://auth.elsevier.com/"}})}};
    },
    Promise: {delay: async () => {delayCalls++; loggedIn = true;}},
    HTTP: {request: async (method, url, options) => {
      assert.equal(method, "GET");
      requested.push(url);
      if (url === doiURL) return response(403, "", "", article);
      assert.equal(url, pdfURL);
      assert.equal(options.headers.Referer, article);
      assert.equal(options.anon, undefined);
      return loggedIn ? response(200, "%PDF-1.4 test", "application/pdf") : response(403);
    }},
    Attachments: {importFromFile: async options => {imported.push(options); return options;}},
  },
  Services: {dirsvc: {get: () => ({ path: "/tmp", normalize() {} })}, prompt: {confirm: (_win, title) => {
    assert.equal(title, "ScienceDirect 登录"); prompts++; return confirmed;
  }}},
  Ci: {nsIFile: {}},
  PathUtils: {join: (...parts) => parts.join("/")},
  IOUtils: {makeDirectory: async () => {}, write: async (path, data) => files.set(path, Buffer.from(data))},
};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync("skill-fulltext-downloader.js", "utf8") + "\nthis.plugin=SkillFulltextDownloader;", ctx);
const p = ctx.plugin;
p._findExistingPDFAttachment = async () => null;
p._validatePDFIdentity = async (file, item) => {
  assert.equal(item.id, 19);
  assert.match(files.get(file).toString(), /^%PDF-/);
  validation++;
};
p._runProcess = () => {throw Error("Windows Elsevier must not call a POSIX shell");};
p._runPaperFetch = () => {throw Error("Windows must not call the POSIX Paper-fetch launcher");};
p._scanSciCommand = () => {throw Error("Windows Elsevier must not call the ScanSci launcher");};
p._waitForExistingPDFAttachment = () => {throw Error("publisher success should not fall back to OA");};
p._tryZoteroAvailableFile = p._waitForExistingPDFAttachment;
// Zotero records imported from PubMed may have its landing link rather than ScienceDirect.
const item = {id:19,key:"fixture",getField: field => ({
  DOI:"https://doi.org/" + doi,
  url:"https://pubmed.ncbi.nlm.nih.gov/42995098/",
  title:"Flood warnings face a new challenge from hidden glacier water",
})[field] || ""};
const result = await p._one(item);
assert.equal(result.parentItemID, 19);
assert.equal(result.contentType, "application/pdf");
assert.equal(result.title, "ScienceDirect 全文");
assert.deepEqual(requested, [doiURL, pdfURL, pdfURL]);
assert.equal(openCalls, 1);
assert.equal(prompts, 1);
assert.equal(delayCalls, 1);
assert.equal(closed, true);
assert.equal(validation, 2);
assert.equal(p.activePublisherCancel, null);
console.log("PASS Windows: DOI-only / PubMed record, silent denied, login, same-session PDF, validated import; no CLI");

requested.length = 0;
const reused = await p._one({...item, getField: field => field==="url" ? article : item.getField(field)});
assert.equal(reused.parentItemID, 19);
assert.deepEqual(requested, [pdfURL]);
assert.equal(openCalls, 1);
assert.equal(prompts, 1);
assert.equal(imported.length, 2);
console.log("PASS existing publisher access downloads without reopening login");

loggedIn = false;
const oldDelay = ctx.Zotero.Promise.delay;
ctx.Zotero.Promise.delay = async () => p._cancel();
assert.equal(await p._tryScanSci(item, doi, "/work"), null);
assert.equal(p.cancelled, true);
assert.equal(closed, true);
assert.equal(p.activePublisherCancel, null);
assert.equal(imported.length, 2);
ctx.Zotero.Promise.delay = oldDelay;
p.cancelled = false;
confirmed = false;
assert.equal(await p._tryScanSci(item, doi, "/work"), null);
assert.match(p.lastScanSciError, /已跳过 ScienceDirect 登录/);
console.log("PASS cancellation and declined login never import PDF");

assert.equal(p._elsevierPII("https://www.sciencedirect.com.evil.example/science/article/pii/" + pii), "");
assert.equal(p._elsevierPII("https://www.sciencedirect.com/science/article/pii/S20959273"), "");
assert.equal(p._elsevierPII("https://linkinghub.elsevier.com/retrieve/pii/" + pii), pii);
assert.equal(p._elsevierPII("https://www.sciencedirect.com/science/article/abs/pii/" + pii + "?via%3Dihub="), pii);
console.log("PASS full PII is required and must come from a publisher host");
