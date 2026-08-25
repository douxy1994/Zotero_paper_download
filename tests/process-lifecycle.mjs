import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

let nextProcess;
function processFixture({ exitValue = 0, runError = null } = {}) {
  return {
    exitValue,
    killed: 0,
    observer: null,
    init() {},
    kill() { this.killed++; },
    runwAsync(_args, _length, observer) {
      if (runError) throw runError;
      this.observer = observer;
    },
  };
}

const context = {
  Zotero: {
    File: { pathToFile: () => ({ exists: () => true, isExecutable: () => true }) },
    Promise: {
      defer() {
        let resolve, reject;
        const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
        return { promise, resolve, reject };
      },
    },
    debug: () => {},
    getMainWindows: () => [],
  },
  Cc: new Proxy({}, {
    get: () => ({ createInstance: () => nextProcess }),
  }),
  Ci: { nsIProcess: {} },
  Services: {},
  PathUtils: {},
  IOUtils: {},
  setTimeout,
  clearTimeout,
};
vm.createContext(context);
vm.runInContext(
  fs.readFileSync("skill-fulltext-downloader.js", "utf8")
    + "\nthis.plugin = SkillFulltextDownloader;",
  context,
);
const plugin = context.plugin;

// Normal completion clears the active process and its cancel callback.
nextProcess = processFixture();
let promise = plugin._runProcess("/bin/zsh", ["-lc", "true"], 1000);
assert.equal(plugin.activeProcess, nextProcess);
assert.equal(typeof plugin.activeProcessCancel, "function");
nextProcess.observer.observe(null, "process-finished");
await promise;
assert.equal(plugin.activeProcess, null);
assert.equal(plugin.activeProcessCancel, null);

// Abnormal completion clears state and preserves the process error.
nextProcess = processFixture();
promise = plugin._runProcess("/bin/zsh", ["-lc", "false"], 1000);
nextProcess.observer.observe(null, "process-failed");
await assert.rejects(promise, /进程异常: process-failed/);
assert.equal(plugin.activeProcess, null);
assert.equal(plugin.activeProcessCancel, null);

// A synchronous launch failure also clears state.
nextProcess = processFixture({ runError: new Error("launch failed") });
promise = plugin._runProcess("/bin/zsh", [], 1000);
await assert.rejects(promise, /launch failed/);
assert.equal(plugin.activeProcess, null);
assert.equal(plugin.activeProcessCancel, null);

// User cancellation kills the active process even when no dialog is present.
plugin.cancelled = false;
plugin.dialog = null;
nextProcess = processFixture();
promise = plugin._runProcess("/bin/zsh", ["-lc", "sleep 1"], 1000);
plugin._cancel();
await assert.rejects(promise, /下载已取消/);
assert.equal(plugin.cancelled, true);
assert.equal(nextProcess.killed, 1);
assert.equal(plugin.activeProcess, null);
assert.equal(plugin.activeProcessCancel, null);

// Timeout kills the process and clears state.
plugin.cancelled = false;
nextProcess = processFixture();
promise = plugin._runProcess("/bin/zsh", ["-lc", "sleep 1"], 10);
await assert.rejects(promise, /下载超时 \(0秒\)/);
assert.equal(nextProcess.killed, 1);
assert.equal(plugin.activeProcess, null);
assert.equal(plugin.activeProcessCancel, null);

// The full-mode budget is 1080 seconds and cancellation never starts fallback.
let calls = [];
plugin.cancelled = false;
plugin._runProcess = async (_command, _args, timeout) => { calls.push(timeout); return true; };
plugin._hasFile = async () => true;
await plugin._runPaperFetch("Q", "/out", "/full.json", "/full.out", "/full.err", "/fallback.json", "/fallback.out", "/fallback.err");
assert.deepEqual(calls, [1080000]);

calls = [];
plugin.cancelled = true;
plugin._runProcess = async (_command, _args, timeout) => {
  calls.push(timeout);
  throw new Error("下载已取消");
};
await assert.rejects(
  plugin._runPaperFetch("Q", "/out", "/full.json", "/full.out", "/full.err", "/fallback.json", "/fallback.out", "/fallback.err"),
  /下载已取消/,
);
assert.deepEqual(calls, [1080000]);

// Cancellation also bypasses the delayed attachment wait and Zotero OA fallback.
plugin.cancelled = true;
plugin._findExistingPDFAttachment = async () => null;
plugin._runPaperFetch = async () => { throw new Error("下载已取消"); };
let delayedWaits = 0;
let oaFallbacks = 0;
plugin._waitForExistingPDFAttachment = async () => { delayedWaits++; return null; };
plugin._tryZoteroAvailableFile = async () => { oaFallbacks++; return null; };
context.Services.dirsvc = { get: () => ({ path: "/tmp" }) };
context.PathUtils.join = (...parts) => parts.join("/");
context.IOUtils.makeDirectory = async () => {};
const item = {
  id: 1,
  key: "ITEMKEY",
  getAttachments: () => [],
  getField: field => field === "DOI" ? "10.0000/example" : "",
};
await assert.rejects(plugin._one(item), /下载已取消/);
assert.equal(delayedWaits, 0);
assert.equal(oaFallbacks, 0);

console.log("PASS normal, abnormal, and launch-error paths clear active process state");
console.log("PASS cancel kills active process and rejects without a dialog");
console.log("PASS timeout kills active process and clears references");
console.log("PASS full-mode timeout is 1080000 ms");
console.log("PASS cancellation does not start fallback mode");
console.log("PASS cancellation bypasses delayed attachment and Zotero OA fallbacks");
