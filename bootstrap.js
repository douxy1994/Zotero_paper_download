var SkillFulltextDownloader;
var chromeHandle;

function log(message) {
  Zotero.debug("SkillFulltextDownloader: " + message);
}

function install() {
  log("Installed");
}

async function startup({ id, version, rootURI }) {
  log("Starting " + version);
  chromeHandle = Cc["@mozilla.org/addons/addon-manager-startup;1"].getService(Ci.amIAddonManagerStartup).registerChrome(
    Services.io.newURI(rootURI + "manifest.json"), [["content", "skill-fulltext", "content/"]]
  );
  Services.scriptloader.loadSubScript(rootURI + "skill-fulltext-downloader.js");
  SkillFulltextDownloader.init({ id, version, rootURI });
  await SkillFulltextDownloader.startup();
}

function onMainWindowLoad({ window }) {
  SkillFulltextDownloader.addToWindow(window);
}

function onMainWindowUnload({ window }) {
  SkillFulltextDownloader.removeFromWindow(window);
}

function shutdown() {
  log("Shutting down");
  SkillFulltextDownloader.shutdown();
  SkillFulltextDownloader = undefined;
  if (chromeHandle) { chromeHandle.destruct(); chromeHandle = null; }
}

function uninstall() {
  log("Uninstalled");
}
