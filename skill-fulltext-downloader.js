var SkillFulltextDownloader = {
  id: null,
  version: null,
  rootURI: null,
  menuID: null,
  isRunning: false,
  cancelled: false,
  dialog: null,
  activeProcess: null,
  activeProcessCancel: null,

  init: function (params) {
    this.id = params.id;
    this.version = params.version;
    this.rootURI = params.rootURI;
  },

  startup: function () {
    var self = this;
    var wins = Zotero.getMainWindows();
    for (var i = 0; i < wins.length; i++) {
      if (wins[i].ZoteroPane) {
        try { wins[i].MozXULElement.insertFTLIfNeeded("skill-fulltext-downloader.ftl"); } catch (e) {}
      }
    }
    // Zotero.MenuManager was added in Zotero 8. Keep a small DOM fallback for
    // Zotero 7 while using the supported API on Zotero 8-10.
    if (!Zotero.MenuManager || !Zotero.MenuManager.registerMenu) {
      for (var j = 0; j < wins.length; j++) self.addToWindow(wins[j]);
      Zotero.debug("Skill Fulltext: registered Zotero 7 compatibility item menu");
      return;
    }
    self.menuID = Zotero.MenuManager.registerMenu({
      menuID: "skill-fulltext-download",
      pluginID: self.id,
      target: "main/library/item",
      menus: [{
        menuType: "menuitem",
        l10nID: "skill-fulltext-download-menu",
        icon: self.rootURI + "content/icons/icon16.svg",
        onShowing: function (_evt, ctx) {
          var items = ((ctx && ctx.items) || []).filter(function (i) { return i && i.isRegularItem(); });
          ctx.setVisible(items.length > 0);
          ctx.setEnabled(!self.isRunning && items.length > 0);
        },
        onCommand: function (_evt, ctx) {
          if (self.isRunning) return;
          var items = ((ctx && ctx.items) || []).filter(function (i) { return i && i.isRegularItem(); });
          if (items.length) self._doAll(items);
        }
      }, {
        menuType: "menuitem", l10nID: "skill-scansci-clear-session",
        onShowing: function (_evt, ctx) { ctx.setEnabled(!self.isRunning && !self.activeProcess); },
        onCommand: function () { self._clearScanSciSession().catch(Zotero.logError); }
      }]
    });
    Zotero.debug("Skill Fulltext: registered MenuManager item menu");
  },

  shutdown: function () {
    if (this.activeProcessCancel) this.activeProcessCancel();
    if (this.menuID && Zotero.MenuManager && Zotero.MenuManager.unregisterMenu) {
      Zotero.MenuManager.unregisterMenu(this.menuID);
      this.menuID = null;
    }
    var wins = Zotero.getMainWindows();
    for (var i = 0; i < wins.length; i++) this.removeFromWindow(wins[i]);
  },

  addToWindow: function (win) {
    try { win.MozXULElement.insertFTLIfNeeded("skill-fulltext-downloader.ftl"); } catch (e) {}
    if (Zotero.MenuManager && Zotero.MenuManager.registerMenu) return;
    if (!win || !win.document || win.document.getElementById("skill-fulltext-download-legacy")) return;

    var popup = win.document.getElementById("zotero-itemmenu");
    if (!popup) return;
    var self = this;
    var menuitem = win.document.createXULElement("menuitem");
    menuitem.id = "skill-fulltext-download-legacy";
    menuitem.setAttribute("data-l10n-id", "skill-fulltext-download-menu");
    menuitem.setAttribute("label", "Skill Download Full Text");
    menuitem.addEventListener("command", function () {
      if (self.isRunning || !win.ZoteroPane) return;
      var items = (win.ZoteroPane.getSelectedItems() || []).filter(function (item) {
        return item && item.isRegularItem();
      });
      if (items.length) self._doAll(items);
    });
    var updateState = function () {
      var items = win.ZoteroPane ? (win.ZoteroPane.getSelectedItems() || []) : [];
      var regularItems = items.filter(function (item) { return item && item.isRegularItem(); });
      menuitem.hidden = regularItems.length === 0;
      menuitem.disabled = self.isRunning || regularItems.length === 0;
    };
    popup.addEventListener("popupshowing", updateState);
    menuitem._skillFulltextPopup = popup;
    menuitem._skillFulltextUpdateState = updateState;
    popup.appendChild(menuitem);
  },

  removeFromWindow: function (win) {
    if (!win || !win.document) return;
    var menuitem = win.document.getElementById("skill-fulltext-download-legacy");
    if (!menuitem) return;
    if (menuitem._skillFulltextPopup && menuitem._skillFulltextUpdateState) {
      menuitem._skillFulltextPopup.removeEventListener(
        "popupshowing", menuitem._skillFulltextUpdateState
      );
    }
    menuitem.remove();
  },

  // ===== Progress Dialog =====

  _doAll: function (items) {
    var self = this;
    self.isRunning = true;
    self.cancelled = false;

    var win = Zotero.getMainWindow();
    self.dialog = win.openDialog(
      "about:blank", "skill-fulltext-dialog",
      "chrome,centerscreen,resizable=yes,width=520,height=420,maxwidth=520,maxheight=420,modal=no,dependent=no"
    );

    self.dialog.addEventListener("load", function () {
      self._buildDialog(self.dialog, items);
      self._process(items, 0);
    });
    if (self.dialog.document.readyState === "complete") {
      self._buildDialog(self.dialog, items);
      self._process(items, 0);
    }
  },

  _buildDialog: function (dlg, items) {
    var doc = dlg.document;
    doc.documentElement.setAttribute("xmlns", "http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul");
    doc.documentElement.innerHTML = "";

    var styleEl = doc.createElement("style");
    styleEl.textContent = [
      ":root { --bg: -moz-Dialog; --fg: -moz-DialogText; --border: ThreeDShadow; --item-bg: -moz-Field; --item-fg: -moz-FieldText; }",
      "@media (prefers-color-scheme: dark) { :root { --bg: #2d2d2d; --fg: #e0e0e0; --border: #555; --item-bg: #1e1e1e; --item-fg: #e0e0e0; } }"
    ].join("\n");
    doc.documentElement.appendChild(styleEl);

    var self = this;
    var vbox = doc.createXULElement("vbox");
    vbox.setAttribute("style", "padding:16px;font-family:-apple-system,BlinkMacSystemFont,sans-serif;font-size:13px;background:var(--bg);color:var(--fg);height:100%;box-sizing:border-box;");

    var titleEl = doc.createXULElement("label");
    titleEl.setAttribute("value", "Skill \u4E0B\u8F7D\u5168\u6587");
    titleEl.setAttribute("style", "font-size:16px;font-weight:bold;margin-bottom:12px;");
    vbox.appendChild(titleEl);

    var progRow = doc.createXULElement("hbox");
    progRow.setAttribute("style", "margin-bottom:8px;align-items:center;gap:8px;");
    var progressbar = doc.createXULElement("progressmeter");
    progressbar.setAttribute("id", "sf-progress");
    progressbar.setAttribute("mode", "determined");
    progressbar.setAttribute("value", "0");
    progressbar.setAttribute("style", "flex:1;height:22px;");
    progRow.appendChild(progressbar);
    var progressLabel = doc.createXULElement("label");
    progressLabel.setAttribute("id", "sf-progress-label");
    progressLabel.setAttribute("value", "0 / " + items.length);
    progressLabel.setAttribute("style", "min-width:60px;");
    progRow.appendChild(progressLabel);
    vbox.appendChild(progRow);

    var statusLabel = doc.createXULEment ? doc.createXULElement("label") : doc.createElement("label");
    statusLabel.setAttribute("id", "sf-status");
    statusLabel.setAttribute("value", "\u51C6\u5907\u4E0B\u8F7D...");
    statusLabel.setAttribute("style", "margin-bottom:8px;opacity:0.7;");
    vbox.appendChild(statusLabel);

    var listbox = doc.createXULElement("vbox");
    listbox.setAttribute("id", "sf-list");
    listbox.setAttribute("style", "flex:1;overflow-y:auto;max-height:280px;border:1px solid var(--border);border-radius:4px;background:var(--item-bg);color:var(--item-fg);padding:4px;");

    for (var i = 0; i < items.length; i++) {
      var row = doc.createXULElement("hbox");
      row.setAttribute("id", "sf-item-" + i);
      row.setAttribute("style", "padding:6px 8px;border-bottom:1px solid rgba(128,128,128,0.2);align-items:center;gap:8px;flex-shrink:0;");
      var icon = doc.createXULElement("label");
      icon.setAttribute("id", "sf-icon-" + i);
      icon.setAttribute("value", "\u23F3");
      icon.setAttribute("style", "min-width:20px;text-align:center;font-size:14px;");
      row.appendChild(icon);
      var itemTitle = items[i].getField("title") || "Unknown";
      if (itemTitle.length > 45) itemTitle = itemTitle.slice(0, 45) + "...";
      var label = doc.createXULElement("label");
      label.setAttribute("value", itemTitle);
      label.setAttribute("style", "flex:1;overflow:hidden;");
      label.setAttribute("crop", "end");
      label.setAttribute("tooltiptext", items[i].getField("title") || "");
      row.appendChild(label);
      var status = doc.createXULElement("label");
      status.setAttribute("id", "sf-status-" + i);
      status.setAttribute("value", "\u7B49\u5F85\u4E2D");
      status.setAttribute("style", "font-size:11px;opacity:0.6;min-width:50px;");
      row.appendChild(status);
      listbox.appendChild(row);
    }
    vbox.appendChild(listbox);

    var btnRow = doc.createXULElement("hbox");
    btnRow.setAttribute("style", "margin-top:12px;justify-content:flex-end;gap:8px;");
    var cancelBtn = doc.createXULElement("button");
    cancelBtn.setAttribute("id", "sf-cancel");
    cancelBtn.setAttribute("label", "\u53D6\u6D88");
    cancelBtn.addEventListener("command", function () { self._cancel(); });
    btnRow.appendChild(cancelBtn);
    var closeBtn = doc.createXULElement("button");
    closeBtn.setAttribute("id", "sf-close");
    closeBtn.setAttribute("label", "\u5173\u95ED");
    closeBtn.setAttribute("disabled", "true");
    closeBtn.addEventListener("command", function () { dlg.close(); });
    btnRow.appendChild(closeBtn);
    vbox.appendChild(btnRow);
    doc.documentElement.appendChild(vbox);
  },

  _cancel: function () {
    this.cancelled = true;
    if (this.activeProcessCancel) this.activeProcessCancel();
    var dlg = this.dialog;
    if (!dlg) return;
    var btn = dlg.document.getElementById("sf-cancel");
    if (btn) { btn.setAttribute("disabled", "true"); btn.setAttribute("label", "\u6B63\u5728\u53D6\u6D88..."); }
  },

  _updateItem: function (i, state, msg) {
    var dlg = this.dialog;
    if (!dlg) return;
    var icon = dlg.document.getElementById("sf-icon-" + i);
    var status = dlg.document.getElementById("sf-status-" + i);
    if (!icon || !status) return;
    if (state === "downloading") {
      icon.setAttribute("value", "\uD83D\uDD04");
      status.setAttribute("value", "\u4E0B\u8F7D\u4E2D");
      status.setAttribute("style", "font-size:11px;color:#1976d2;min-width:50px;");
    } else if (state === "success") {
      icon.setAttribute("value", "\u2705");
      status.setAttribute("value", "\u5B8C\u6210");
      status.setAttribute("style", "font-size:11px;color:#388e3c;min-width:50px;");
    } else if (state === "error") {
      icon.setAttribute("value", "\u274C");
      status.setAttribute("value", (msg || "\u5931\u8D25").slice(0, 36));
      status.setAttribute("tooltiptext", msg || "\u5931\u8D25");
      status.setAttribute("style", "font-size:11px;color:#d32f2f;min-width:50px;");
    }
  },

  _updateProgress: function (done, total) {
    var dlg = this.dialog;
    if (!dlg) return;
    var pct = total > 0 ? Math.round((done / total) * 100) : 0;
    var bar = dlg.document.getElementById("sf-progress");
    var label = dlg.document.getElementById("sf-progress-label");
    var status = dlg.document.getElementById("sf-status");
    if (bar) bar.setAttribute("value", String(pct));
    if (label) label.setAttribute("value", done + " / " + total);
    if (status) status.setAttribute("value", "\u5DF2\u4E0B\u8F7D " + done + " / " + total + " \u7BC7");
  },

  _finishDialog: function () {
    var dlg = this.dialog;
    if (!dlg) return;
    var cancelBtn = dlg.document.getElementById("sf-cancel");
    var closeBtn = dlg.document.getElementById("sf-close");
    var status = dlg.document.getElementById("sf-status");
    if (cancelBtn) { cancelBtn.setAttribute("disabled", "true"); cancelBtn.setAttribute("label", "\u5DF2\u5B8C\u6210"); }
    if (closeBtn) closeBtn.removeAttribute("disabled");
    if (status) status.setAttribute("value", "\u5168\u90E8\u5B8C\u6210\uFF01");
  },

  _process: function (items, i) {
    var self = this;
    if (self.cancelled || i >= items.length) {
      self.isRunning = false;
      self._finishDialog();
      return;
    }
    self._updateItem(i, "downloading");
    self._updateProgress(i, items.length);
    self._one(items[i]).then(function () {
      self._updateItem(i, "success");
      self._process(items, i + 1);
    }, function (err) {
      self._updateItem(i, "error", err.message || String(err));
      self._process(items, i + 1);
    });
  },

  // ===== Download Logic =====

  _one: function (item) {
    var query = (item.getField("DOI") || "").trim()
      || (item.getField("url") || "").trim()
      || (item.getField("title") || "").trim();
    if (!query) return Promise.reject(new Error("\u7F3A\u5C11DOI/URL/\u6807\u9898"));

    var tmpRoot = Services.dirsvc.get("TmpD", Ci.nsIFile).path;
    var workDir = PathUtils.join(tmpRoot, "skill-fulltext-zotero", item.key + "-" + Date.now());
    var resultJSON = PathUtils.join(workDir, "paper-fetch-result.json");
    var fallbackResultJSON = PathUtils.join(workDir, "paper-fetch-result.fallback.json");
    var stdoutLog = PathUtils.join(workDir, "paper-fetch.stdout.log");
    var stderrLog = PathUtils.join(workDir, "paper-fetch.stderr.log");
    var fallbackStdoutLog = PathUtils.join(workDir, "paper-fetch.fallback.stdout.log");
    var fallbackStderrLog = PathUtils.join(workDir, "paper-fetch.fallback.stderr.log");

    var self = this;
    return self._findExistingPDFAttachment(item).then(function (existing) {
      if (existing) return existing;

      return IOUtils.makeDirectory(workDir, { createAncestors: true }).then(function () {
        return self._runPaperFetch(
          query, workDir,
          resultJSON, stdoutLog, stderrLog,
          fallbackResultJSON, fallbackStdoutLog, fallbackStderrLog
        );
      }).then(function () {
        return self._pickAttachmentFile(workDir);
      }).then(function (file) {
        if (!file) throw new Error("paper-fetch \u672A\u751F\u6210\u53EF\u5BFC\u5165\u6587\u4EF6");
        var contentType = file.toLowerCase().endsWith(".pdf") ? "application/pdf" : "text/markdown";
        var title = contentType === "application/pdf" ? "Skill \u4E0B\u8F7D\u5168\u6587" : "Skill \u4E0B\u8F7D\u5168\u6587 (Markdown)";
        return Zotero.Attachments.importFromFile({
          file: file, parentItemID: item.id, title: title,
          fileBaseName: Zotero.Attachments.getFileBaseNameFromItem(item, { attachmentTitle: title }),
          contentType: contentType
        });
      }).catch(function (fetchErr) {
        if (self.cancelled) throw fetchErr;
        // Zotero may still be finishing its own OA attachment download after
        // paper-fetch exits. Observe that state before starting another request.
        return self._tryScanSci(item, query, workDir).catch(function (error) {
          if (self.cancelled) throw error;
          Zotero.debug("ScanSci fallback failed: " + error);
          return null;
        }).then(function (scanAttachment) {
          if (scanAttachment) return scanAttachment;
          if (self.cancelled) throw new Error("下载已取消");
          return self._waitForExistingPDFAttachment(item, 20000, 1000);
        }).then(function (existing) {
          if (existing) return existing;
          return self._tryZoteroAvailableFile(item);
        }).then(function (attachment) {
          if (attachment) return attachment;
          return self._paperFetchFailureDetail([
            fallbackResultJSON, resultJSON, fallbackStderrLog, stderrLog
          ]).then(function (detail) {
            throw new Error(detail || fetchErr.message || "\u672A\u627E\u5230\u53EF\u7528\u5168\u6587");
          });
        });
      });
    });
  },

  // ScanSci keeps its own session store, independent of the user's global config.
  _scanSciSessionDir: function () {
    return PathUtils.join(Services.dirsvc.get("ProfD", Ci.nsIFile).path, "skill-fulltext-scansci");
  },

  _scanSciCommand: async function (args, workDir) {
    if (this.cancelled) throw new Error("下载已取消");
    var session = this._scanSciSessionDir();
    await IOUtils.makeDirectory(session, { createAncestors: true, permissions: 448 });
    await IOUtils.setPermissions(session, 448);
    var configPath = PathUtils.join(session, "config.json");
    if (!(await IOUtils.exists(configPath))) {
      await IOUtils.writeUTF8(configPath, JSON.stringify({
        download_strategy: "legal_only", scihub_enabled: false,
        auto_relogin: false, progress_bar_auto: false, browser_headless: true,
        cache_dir: PathUtils.join(session, "cache")
      }));
    }
    await IOUtils.setPermissions(configPath, 384);
    var log = PathUtils.join(workDir, args[0] === "login" ? "scansci-login.log" : "scansci.log");
    // Positional arguments prevent DOI/URL shell interpolation. umask protects cookies.
    var script = [
      'set -eu; umask 077',
      'export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"',
      'export SCANSCI_PDF_DATA_DIR="$1"; LOG="$2"; shift 2',
      'BIN="$(command -v scansci-pdf || true)"',
      '[ -n "$BIN" ] || { echo "ScanSci CLI missing" >"$LOG"; exit 127; }',
      'exec "$BIN" "$@" >"$LOG" 2>&1'
    ].join("\n");
    await this._runProcess("/bin/zsh", ["-lc", script, "skill-scansci", session, log].concat(args), 1080000);
  },

  _tryScanSci: async function (item, query, workDir) {
    if (this.cancelled) return null;
    var dir = PathUtils.join(workDir, "scansci");
    await IOUtils.makeDirectory(dir, { createAncestors: true });
    var args = ["get", query, "--output", dir, "--strategy", "legal_only", "--no-bibtex"];
    try { await this._scanSciCommand(args, dir); }
    catch (e) { if (this.cancelled) return null; }
    var file = await this._pickAttachmentFile(dir);
    if (!file) {
      var logPath = PathUtils.join(dir, "scansci.log");
      var log = await IOUtils.exists(logPath) ? await IOUtils.readUTF8(logPath) : "";
      if (/paywall|login_required|not.entitled|需要登录|机构登录|scansci-pdf login/i.test(log)) {
        var accepted = Services.prompt.confirm(Zotero.getMainWindow(), "ScanSci 登录",
          "该文献可能需要出版社或机构登录。打开专用浏览器登录并在本机记住会话？账号和支付操作由你完成，关闭登录页后重试。点击取消使用 Zotero 保底下载。");
        if (accepted && !this.cancelled) {
          var url = (item.getField("url") || "").trim();
          var doi = (item.getField("DOI") || "").trim();
          if (doi) url = "https://doi.org/" + doi;
          if (/^https:\/\//i.test(url)) {
            try {
              await this._scanSciCommand(["login", "--login-type", "cookies", "--url", url], dir);
              if (!this.cancelled) await this._scanSciCommand(args, dir);
              file = await this._pickAttachmentFile(dir);
            } catch (e) { if (this.cancelled) return null; }
          }
        }
      }
    }
    if (this.cancelled || !file || !file.toLowerCase().endsWith(".pdf")) return null;
    var bytes = await IOUtils.read(file, { maxBytes: 5 });
    if (String.fromCharCode.apply(null, bytes) !== "%PDF-") return null;
    var existing = await this._findExistingPDFAttachment(item);
    if (existing) return existing;
    return Zotero.Attachments.importFromFile({
      file: file, parentItemID: item.id, title: "ScanSci 全文", contentType: "application/pdf"
    });
  },

  _clearScanSciSession: async function () {
    if (this.isRunning || this.activeProcess) return;
    if (!Services.prompt.confirm(Zotero.getMainWindow(), "清除 ScanSci 登录状态",
      "清除本插件专用的 ScanSci 会话和缓存？不影响 Zotero 附件或全局 ScanSci 配置。")) return;
    var dir = this._scanSciSessionDir();
    if (await IOUtils.exists(dir)) await IOUtils.remove(dir, { recursive: true });
  },

  _runPaperFetch: function (
    query, outputDir,
    resultJSON, stdoutLog, stderrLog,
    fallbackResultJSON, fallbackStdoutLog, fallbackStderrLog
  ) {
    var self = this;

    // Step 1: Full mode (may get PDF via browser), 1080s outer timeout.
    // paper-fetch 5.4+ may spend up to 900s preparing Camoufox on first use,
    // followed by a browser request. Older 4.x/5.x versions use the same flags.
    // Use the explicit `fetch` subcommand: the legacy root-level `--query` surface
    // is only kept for one compatibility cycle by upstream (4.x and 5.x both
    // support `fetch` with identical flags and exit-code/stdout/stderr contract).
    var fullScript = [
      "set -euo pipefail",
      "export PATH=\"/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/opt/local/bin:$PATH\"",
      "BIN=\"/opt/homebrew/bin/paper-fetch\"",
      "if [ ! -x \"$BIN\" ]; then BIN=\"$(command -v paper-fetch || true)\"; fi",
      "if [ -z \"$BIN\" ]; then echo \"paper-fetch CLI not found\" >&2; exit 127; fi",
      "\"$BIN\" fetch --query \"$1\" --format json --output \"$3\" --output-dir \"$2\" --save-markdown --artifact-mode markdown-assets --asset-profile body >\"$4\" 2>\"$5\""
    ].join("\n");

    // Step 2: Fallback (no browser, Markdown only), 60s timeout
    var fallbackScript = [
      "set -euo pipefail",
      "export PATH=\"/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/opt/local/bin:$PATH\"",
      "BIN=\"/opt/homebrew/bin/paper-fetch\"",
      "if [ ! -x \"$BIN\" ]; then BIN=\"$(command -v paper-fetch || true)\"; fi",
      "if [ -z \"$BIN\" ]; then echo \"paper-fetch CLI not found\" >&2; exit 127; fi",
      "\"$BIN\" fetch --query \"$1\" --format json --output \"$3\" --output-dir \"$2\" --save-markdown --artifact-mode none >\"$4\" 2>\"$5\""
    ].join("\n");

    return self._runProcess("/bin/zsh", [
      "-lc", fullScript, "skill-fulltext-zotero",
      query, outputDir, resultJSON, stdoutLog, stderrLog
    ], 1080000).then(function () {
      return self._hasFile(outputDir);
    }).then(function (hasFile) {
      if (hasFile) return true;
      throw new Error("\u5B8C\u6574\u6A21\u5F0F\u672A\u751F\u6210\u6587\u4EF6");
    }).catch(function (fullErr) {
      if (self.cancelled) throw fullErr;
      // Fallback: no-browser mode
      return self._runProcess("/bin/zsh", [
        "-lc", fallbackScript, "skill-fulltext-zotero",
        query, outputDir, fallbackResultJSON, fallbackStdoutLog, fallbackStderrLog
      ], 60000).then(function () {
        return self._hasFile(outputDir);
      }).then(function (hasFile) {
        if (hasFile) return true;
        throw new Error(fullErr.message);
      });
    });
  },

  _findExistingPDFAttachment: async function (item) {
    var ids = item && item.getAttachments ? item.getAttachments() : [];
    for (var id of ids) {
      try {
        var attachment = Zotero.Items.get(id);
        if (!attachment || !attachment.isAttachment()) continue;
        var contentType = attachment.attachmentContentType || attachment.getField("contentType") || "";
        if (contentType.toLowerCase() !== "application/pdf") continue;
        var path = await attachment.getFilePathAsync();
        if (!path || !(await IOUtils.exists(path))) continue;
        var stat = await IOUtils.stat(path);
        if (stat.type === "regular" && stat.size > 4) return attachment;
      } catch (e) {
        Zotero.debug("Skill Fulltext: failed to inspect existing attachment: " + e, 2);
      }
    }
    return null;
  },

  _waitForExistingPDFAttachment: async function (item, timeout, interval) {
    var deadline = Date.now() + timeout;
    do {
      var attachment = await this._findExistingPDFAttachment(item);
      if (attachment) return attachment;
      if (Date.now() >= deadline) break;
      await Zotero.Promise.delay(interval);
    } while (true);
    return null;
  },

  _tryZoteroAvailableFile: async function (item) {
    try {
      var existing = await this._findExistingPDFAttachment(item);
      if (existing) return existing;
      if (!Zotero.Attachments.addAvailableFile) return null;
      var attachment = await Zotero.Attachments.addAvailableFile(item, {
        methods: ["doi", "url", "oa"]
      });
      return attachment || await this._findExistingPDFAttachment(item);
    } catch (e) {
      Zotero.debug("Skill Fulltext: Zotero OA fallback failed: " + e, 2);
      return null;
    }
  },

  _paperFetchFailureDetail: async function (paths) {
    for (var path of paths) {
      try {
        if (!(await IOUtils.exists(path))) continue;
        var text = (await IOUtils.readUTF8(path)).trim();
        if (!text) continue;
        try {
          var payload = JSON.parse(text);
          if (payload.status === "ambiguous") return "\u6807\u9898\u6B67\u4E49\uFF0C\u8BF7\u8865\u5145 DOI";
          if (payload.reason) return String(payload.reason).slice(0, 160);
          var quality = payload.quality || {};
          var warnings = quality.warnings || [];
          if (warnings.length) {
            var warning = String(warnings[0]);
            if (warning.includes("Rejected unsafe remote URL")) {
              return "paper-fetch \u88AB\u4EE3\u7406 DNS/\u5730\u5740\u5B89\u5168\u68C0\u67E5\u62E6\u622A";
            }
            return warning.slice(0, 160);
          }
          if (quality.content_kind === "metadata_only") return "paper-fetch \u4EC5\u8FD4\u56DE\u5143\u6570\u636E\uFF0C\u672A\u83B7\u53D6\u5168\u6587";
        } catch (e) {
          return text.slice(0, 160);
        }
      } catch (e) {}
    }
    return "";
  },

  _hasFile: async function (dir) {
    var files = await this._listFilesRecursive(dir);
    return files.some(function (f) {
      var lo = f.toLowerCase();
      return lo.endsWith(".pdf") || lo.endsWith(".md");
    });
  },

  _runProcess: function (command, args, timeout) {
    var self = this;
    var file = Zotero.File.pathToFile(command);
    if (!file.exists() || !file.isExecutable()) {
      throw new Error(command + " \u4E0D\u5B58\u5728\u6216\u4E0D\u53EF\u6267\u884C");
    }
    var process = Cc["@mozilla.org/process/util;1"].createInstance(Ci.nsIProcess);
    process.init(file);
    var deferred = Zotero.Promise.defer();
    var finished = false;
    var ms = timeout || 300000;
    var timer = null;

    var cleanup = function () {
      if (timer) { clearTimeout(timer); timer = null; }
      if (self.activeProcess === process) {
        self.activeProcess = null;
        self.activeProcessCancel = null;
      }
    };
    var rejectOnce = function (error, killProcess) {
      if (finished) return;
      finished = true;
      cleanup();
      if (killProcess) {
        try { process.kill(); } catch (e) {}
      }
      deferred.reject(error);
    };

    self.activeProcess = process;
    self.activeProcessCancel = function () {
      rejectOnce(new Error("\u4E0B\u8F7D\u5DF2\u53D6\u6D88"), true);
    };
    timer = setTimeout(function () {
      rejectOnce(
        new Error("\u4E0B\u8F7D\u8D85\u65F6 (" + Math.round(ms / 1000) + "\u79D2)"),
        true
      );
    }, ms);

    try {
      process.runwAsync(args, args.length, {
        observe: function (_subject, topic) {
          if (finished) return;
          if (topic !== "process-finished") {
            rejectOnce(new Error("\u8FDB\u7A0B\u5F02\u5E38: " + topic), false);
          } else if (process.exitValue !== 0) {
            rejectOnce(new Error("paper-fetch \u9000\u51FA\u7801 " + process.exitValue), false);
          } else {
            finished = true;
            cleanup();
            deferred.resolve(true);
          }
        }
      });
    } catch (e) {
      rejectOnce(e, false);
    }

    return deferred.promise;
  },

  _pickAttachmentFile: async function (dir) {
    var files = await this._listFilesRecursive(dir);
    var pdfs = files.filter(function (f) { return f.toLowerCase().endsWith(".pdf"); });
    if (pdfs.length) return this._pickLargest(pdfs);
    var mds = files.filter(function (f) { return f.toLowerCase().endsWith(".md"); });
    if (mds.length) return this._pickLargest(mds);
    return null;
  },

  _listFilesRecursive: async function (dir) {
    var out = [];
    try {
      var children = await IOUtils.getChildren(dir);
      for (var child of children) {
        try {
          var stat = await IOUtils.stat(child);
          if (stat.type === "directory") {
            out = out.concat(await this._listFilesRecursive(child));
          } else if (stat.type === "regular") {
            out.push(child);
          }
        } catch (e) {}
      }
    } catch (e) {}
    return out;
  },

  _pickLargest: async function (files) {
    var best = null, bestSize = -1;
    for (var file of files) {
      try {
        var stat = await IOUtils.stat(file);
        if (stat.size > bestSize) { best = file; bestSize = stat.size; }
      } catch (e) {}
    }
    return best;
  }
};
