import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

function loadPlugin(zotero, extra = {}) {
  const context = {
    Zotero: zotero,
    Services: { dirsvc: { get: () => ({ path: "/tmp" }) } },
    Ci: { nsIFile: {} },
    Cc: {},
    PathUtils: { join: (...parts) => parts.join("/") },
    IOUtils: {},
    setTimeout,
    clearTimeout,
    ...extra,
  };
  vm.createContext(context);
  vm.runInContext(
    fs.readFileSync("skill-fulltext-downloader.js", "utf8")
      + "\nthis.plugin = SkillFulltextDownloader;",
    context,
  );
  return context.plugin;
}

// Zotero 8-10: use MenuManager and only the stable context.items property.
let registered;
const modern = loadPlugin({
  debug: () => {},
  getMainWindows: () => [],
  MenuManager: {
    registerMenu: config => { registered = config; return "registered-menu"; },
    unregisterMenu: id => assert.equal(id, "registered-menu"),
  },
});
modern.init({ id: "skill-fulltext-downloader@example.com", version: "0.7.0", rootURI: "xpi:/" });
modern.startup();
assert.equal(registered.target, "main/library/item");
const context = new Proxy({
  items: [{ isRegularItem: () => true }],
  setVisible: value => assert.equal(value, true),
  setEnabled: value => assert.equal(value, true),
}, {
  get(target, property) {
    if (property === "collectionTreeRow") throw new Error("Zotero 10 removed singular menu context");
    return target[property];
  },
});
registered.menus[0].onShowing(null, context);
modern.shutdown();

// Zotero 7: MenuManager is absent, so install and remove a legacy item-menu entry.
const listeners = new Map();
const elements = new Map();
const popup = {
  addEventListener: (type, fn) => listeners.set(type, fn),
  removeEventListener: (type, fn) => {
    assert.equal(listeners.get(type), fn);
    listeners.delete(type);
  },
  appendChild: element => elements.set(element.id, element),
};
const document = {
  getElementById: id => id === "zotero-itemmenu" ? popup : elements.get(id) || null,
  createXULElement: () => ({
    setAttribute(name, value) { this[name] = value; },
    addEventListener(type, fn) { this[type] = fn; },
    remove() { elements.delete(this.id); },
  }),
};
const selected = [{ isRegularItem: () => true }];
const win = {
  document,
  MozXULElement: { insertFTLIfNeeded: () => {} },
  ZoteroPane: { getSelectedItems: () => selected },
};
const legacy = loadPlugin({ debug: () => {}, getMainWindows: () => [win] });
legacy.init({ id: "skill-fulltext-downloader@example.com", version: "0.7.0", rootURI: "xpi:/" });
let dispatched;
legacy._doAll = items => { dispatched = items; };
legacy.startup();
const menuitem = elements.get("skill-fulltext-download-legacy");
assert.ok(menuitem, "Zotero 7 fallback menu must be installed");
listeners.get("popupshowing")();
assert.equal(menuitem.hidden, false);
assert.equal(menuitem.disabled, false);
menuitem.command();
assert.equal(dispatched.length, 1);
assert.equal(dispatched[0], selected[0]);
legacy.removeFromWindow(win);
assert.equal(elements.has("skill-fulltext-download-legacy"), false);
assert.equal(listeners.has("popupshowing"), false);

// Bootstrap must route window unloads to the now-defined cleanup hook.
assert.match(fs.readFileSync("bootstrap.js", "utf8"), /SkillFulltextDownloader\.removeFromWindow\(window\)/);
assert.equal(typeof legacy.removeFromWindow, "function");

console.log("PASS Zotero 10 MenuManager context avoids removed collectionTreeRow");
console.log("PASS Zotero 8-10 MenuManager registration and shutdown");
console.log("PASS Zotero 7 fallback menu registration, dispatch, and cleanup");
console.log("PASS bootstrap window-unload cleanup hook is implemented");
