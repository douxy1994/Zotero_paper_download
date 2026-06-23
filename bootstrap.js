var SkillFulltextDownloader;

function log(message) {
  Zotero.debug("SkillFulltextDownloader: " + message);
}

function install() {
  log("Installed");
}

async function startup({ id, version, rootURI }) {
  log("Starting " + version);
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
}

function uninstall() {
  log("Uninstalled");
}
