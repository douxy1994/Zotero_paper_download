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
  lastScanSciError: "",

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
    if (this.isRunning) return;
    var self = this;
    self.isRunning = true;
    self.cancelled = false;
    self.completed = 0;
    var dlg;
    try {
      dlg = Zotero.getMainWindow().openDialog(
        "chrome://skill-fulltext/content/progress.xhtml", "skill-fulltext-dialog",
        "chrome,centerscreen,resizable=yes,width=660,height=460,dialog=no"
      );
      self.dialog = dlg;
    } catch (e) { self.isRunning = false; throw e; }
    var started = false;
    var start = function () {
      if (started || dlg.closed) return;
      if (!dlg.document.getElementById("sf-root")) return;
      started = true;
      dlg.removeEventListener("load", start);
      try {
        self._buildDialog(dlg, items);
        self._process(items, 0);
      } catch (e) {
        self.isRunning = false;
        Zotero.logError(e);
        var status = dlg.document.getElementById("sf-status");
        if (status) status.textContent = "初始化失败：" + e.message;
      }
    };
    dlg.addEventListener("load", start);
    dlg.addEventListener("unload", function (event) {
      if (!started || event.target !== dlg.document) return;
      if (self.dialog === dlg) {
        if (self.isRunning) self._cancel();
        self.dialog = null;
      }
    });
    if (dlg.document.readyState === "complete") start();
  },

  _buildDialog: function (dlg, items) {
    var doc = dlg.document;
    var self = this;
    var create = function (tag) { return doc.createElementNS("http://www.w3.org/1999/xhtml", tag); };
    var list = doc.getElementById("sf-list");
    list.replaceChildren();
    items.forEach(function (item, i) {
      var row = create("div"); row.className = "item";
      var icon = create("span"); icon.id = "sf-icon-" + i; icon.textContent = "⏳";
      var title = create("span"); title.className = "title";
      title.textContent = item.getField("title") || "Untitled";
      title.title = title.textContent;
      var status = create("span"); status.id = "sf-status-" + i; status.textContent = "等待中";
      row.append(icon, title, status); list.appendChild(row);
    });
    doc.getElementById("sf-cancel").addEventListener("click", function () { self._cancel(); });
    doc.getElementById("sf-close").addEventListener("click", function () { dlg.close(); });
    self._updateProgress(0, items.length);
  },

  _cancel: function () {
    this.cancelled = true;
    if (this.activeProcessCancel) this.activeProcessCancel();
    var dlg = this.dialog;
    if (!dlg) return;
    var btn = dlg.document.getElementById("sf-cancel");
    if (btn) { btn.disabled = true; btn.textContent = "正在取消…"; }
  },

  _updateItem: function (i, state, msg) {
    var dlg = this.dialog;
    if (!dlg || dlg.closed) return;
    var icon = dlg.document.getElementById("sf-icon-" + i);
    var status = dlg.document.getElementById("sf-status-" + i);
    if (!icon || !status) return;
    icon.textContent = {downloading:"↻", success:"✓", error:"✗"}[state] || "⏳";
    status.textContent = msg || {downloading:"下载中",success:"完成",error:"失败"}[state];
    status.title = status.textContent;
    status.className = state;
  },

  _updateProgress: function (done, total) {
    this.completed = done;
    var dlg = this.dialog;
    if (!dlg || dlg.closed) return;
    var doc = dlg.document;
    doc.getElementById("sf-progress").max = total || 1;
    doc.getElementById("sf-progress").value = done;
    doc.getElementById("sf-progress-label").textContent = done + " / " + total;
    doc.getElementById("sf-status").textContent = "已处理 " + done + " / " + total;
  },

  _finishDialog: function () {
    var dlg = this.dialog;
    if (!dlg || dlg.closed) return;
    dlg.document.getElementById("sf-cancel").disabled = true;
    dlg.document.getElementById("sf-close").disabled = false;
    dlg.document.getElementById("sf-status").textContent = this.cancelled ? "任务已取消" : "处理结束（逐项结果见列表）";
  },

  _process: function (items, i) {
    var self = this;
    if (self.cancelled || i >= items.length) {
      self._updateProgress(i, items.length);
      self.isRunning = false;
      self._finishDialog();
      return;
    }
    self.currentItemIndex = i;
    self._updateItem(i, "downloading");
    self._updateProgress(i, items.length);
    self._one(items[i]).then(function () {
      self._updateItem(i, "success");
      self._process(items, i + 1);
    }, function (err) {
      self._updateItem(i, "error", self.cancelled ? "已取消" : err.message || String(err));
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
        var validation = contentType === "application/pdf"
          ? self._validatePDFIdentity(file, item)
          : Promise.resolve(true);
        return validation.then(function () {
        return Zotero.Attachments.importFromFile({
          file: file, parentItemID: item.id, title: title,
          fileBaseName: Zotero.Attachments.getFileBaseNameFromItem(item, { attachmentTitle: title }),
          contentType: contentType
        });
        });
      }).catch(function (fetchErr) {
        if (self.cancelled) throw fetchErr;
        // Zotero may still be finishing its own OA attachment download after
        // paper-fetch exits. Observe that state before starting another request.
        return self._tryScanSci(item, query, workDir).catch(function (error) {
          if (self.cancelled) throw error;
          self.lastScanSciError = error.message || String(error);
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
            throw new Error(self.lastScanSciError || detail || fetchErr.message || "\u672A\u627E\u5230\u53EF\u7528\u5168\u6587");
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
    var loginHelper = "";
    if (args[0] === "login") {
      loginHelper = PathUtils.join(session, "scansci-login.py");
      var helperScope = {};
      Services.scriptloader.loadSubScript("chrome://skill-fulltext/content/scansci-login-source.js", helperScope);
      await IOUtils.writeUTF8(loginHelper, helperScope.ScanSciLoginSource);
      await IOUtils.setPermissions(loginHelper, 384);
    }
    var log = PathUtils.join(workDir, args[0] === "login" ? "scansci-login.log" : "scansci.log");
    // Positional arguments prevent DOI/URL shell interpolation. umask protects cookies.
    var script = [
      'set -eu; umask 077',
      'export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"',
      'export SCANSCI_PDF_DATA_DIR="$1"; LOG="$2"; HELPER="$3"; shift 3',
      'BIN="$(command -v scansci-pdf || true)"',
      '[ -n "$BIN" ] || { echo "ScanSci CLI missing" >"$LOG"; exit 127; }',
      'if [ -n "$HELPER" ]; then PY="$(head -n 1 "$BIN")"; PY="${PY:2}"; [ -x "$PY" ] || { echo "ScanSci interpreter unavailable" >"$LOG"; exit 127; }; shift; exec "$PY" "$HELPER" "$1" "$2" "${3:-}" >"$LOG" 2>&1; fi',
      'exec "$BIN" "$@" >"$LOG" 2>&1'
    ].join("\n");
    await this._runProcess("/bin/zsh", ["-lc", script, "skill-scansci", session, log, loginHelper].concat(args), 1080000);
  },

  _tryScanSci: async function (item, query, workDir) {
    if (this.cancelled) return null;
    this.lastScanSciError = "";
    var dir = PathUtils.join(workDir, "scansci");
    await IOUtils.makeDirectory(dir, { createAncestors: true });
    var args = ["get", query, "--output", dir, "--strategy", "legal_only", "--no-bibtex"];
    // Elsevier get() in current ScanSci truncates PII. Use the dedicated
    // browser path once rather than opening the broken upstream browser first.
    var elsevier = /^10\.1016\//i.test((item.getField("DOI") || "").trim());
    try {
      if (elsevier) await IOUtils.writeUTF8(PathUtils.join(dir, "scansci.log"), "login_required: use complete Elsevier PII");
      else await this._scanSciCommand(args, dir);
    }
    catch (e) { if (this.cancelled) return null; }
    var file = await this._pickAttachmentFile(dir);
    if (!file) {
      var logPath = PathUtils.join(dir, "scansci.log");
      var log = await IOUtils.exists(logPath) ? await IOUtils.readUTF8(logPath) : "";
      if (/paywall|login_required|not.entitled|需要登录|机构登录|scansci-pdf login/i.test(log)) {
        var accepted = Services.prompt.confirm(Zotero.getMainWindow(), "ScanSci 登录",
          "该文献可能需要出版社或机构登录。打开专用浏览器登录并在本机记住会话？账号和支付操作由你完成。检测到本篇 PDF 后自动关闭；也可点击网页右下角“已登录，保存并重试”。点击取消使用 Zotero 保底下载。");
        if (accepted && !this.cancelled) {
          var url = (item.getField("url") || "").trim();
          var doi = (item.getField("DOI") || "").trim();
          // Preserve a complete ScienceDirect PII from the Zotero record.
          if (!/^https:\/\//i.test(url) && doi) url = "https://doi.org/" + doi;
          if (/^https:\/\//i.test(url)) {
            try {
              this._updateItem(this.currentItemIndex, "downloading", "等待登录，检测全文后自动继续");
              var loginPDF = PathUtils.join(dir, "verified-login.pdf");
              await this._scanSciCommand(["login", url, loginPDF, doi], dir);
              if (this.cancelled) return null;
              this._updateItem(this.currentItemIndex, "downloading", "登录完成，验证全文");
              if (await IOUtils.exists(loginPDF)) file = loginPDF;
              else {
                throw new Error("登录窗口结束但没有返回本篇 PDF");
              }
              if (!file) this.lastScanSciError = "登录会话已保存，但 ScanSci 仍未取得本篇全文；已尝试 Zotero 保底";
            } catch (e) {
              if (this.cancelled) return null;
              var logFile = PathUtils.join(dir, "scansci-login.log");
              var diagnostic = await IOUtils.exists(logFile) ? await IOUtils.readUTF8(logFile) : "";
              var stage = diagnostic.match(/login_failed_stage=([a-z_]+)/);
              this.lastScanSciError = "ScanSci 登录助手失败" + (stage ? "（" + stage[1] + "）" : "") + "，这与 Elsevier API Key 配置无关";
            }
          }
        }
      }
    }
    if (this.cancelled || !file || !file.toLowerCase().endsWith(".pdf")) return null;
    await this._validatePDFIdentity(file, item);
    var existing = await this._findExistingPDFAttachment(item);
    if (existing) return existing;
    return Zotero.Attachments.importFromFile({
      file: file, parentItemID: item.id, title: "ScanSci 全文", contentType: "application/pdf"
    });
  },

  _validatePDFIdentity: async function (file, item) {
    var header = await IOUtils.read(file, { maxBytes: 5 });
    if (String.fromCharCode.apply(null, header) !== "%PDF-") {
      throw new Error("\u4E0B\u8F7D\u7ED3\u679C\u4E0D\u662F PDF");
    }
    if (!Zotero.PDFWorker || !Zotero.PDFWorker._query) {
      throw new Error("PDF \u8EAB\u4EFD\u9A8C\u8BC1\u4E0D\u53EF\u7528");
    }
    var raw = await IOUtils.read(file);
    var buffer = new Uint8Array(raw).buffer;
    var result;
    try {
      if (Zotero.PDFWorker._init) Zotero.PDFWorker._init();
      result = await Zotero.PDFWorker._query(
        "pdf.getFulltext", { buf: buffer, maxPages: 3 }, [buffer]
      );
    } catch (e) {
      throw new Error("PDF \u6587\u672C\u63D0\u53D6\u5931\u8D25: " + (e.message || String(e)));
    }
    var text = String(result && result.text || "").slice(0, 30000).toLowerCase();
    if (!text.trim()) throw new Error("PDF \u524D\u4E09\u9875\u6CA1\u6709\u53EF\u9A8C\u8BC1\u6587\u672C");

    var doi = String(item.getField("DOI") || "").trim().toLowerCase()
      .replace(/^https?:\/\/(?:dx\.)?doi\.org\//, "");
    if (doi && text.indexOf(doi) !== -1) return true;

    var normalize = function (value) {
      return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    };
    var stop = new Set(["the", "and", "for", "with", "from", "into", "this", "that", "river"]);
    var tokens = Array.from(new Set(normalize(item.getField("title")).split(" ").filter(function (token) {
      return token.length >= 4 && !stop.has(token);
    })));
    var normalizedText = " " + normalize(text) + " ";
    var matched = tokens.filter(function (token) {
      return normalizedText.indexOf(" " + token + " ") !== -1;
    }).length;
    var score = tokens.length ? matched / tokens.length : 0;
    if (tokens.length >= 4 && score >= 0.7) return true;

    var found = text.match(/10\.\d{4,9}\/[-._;()/:a-z0-9]+/i);
    if (found) {
      throw new Error("PDF DOI \u4E0D\u5339\u914D: " + found[0].replace(/[.,;]+$/, ""));
    }
    throw new Error("PDF \u9898\u540D\u5339\u914D\u5EA6\u4E0D\u8DB3 (" + Math.round(score * 100) + "%)");
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
