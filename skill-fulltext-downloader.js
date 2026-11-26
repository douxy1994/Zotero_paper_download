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
  activePublisherCancel: null,
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
    if (this.activePublisherCancel) this.activePublisherCancel();
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
    if (this.activePublisherCancel) this.activePublisherCancel();
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

    var tmp = Services.dirsvc.get("TmpD", Ci.nsIFile);
    tmp.normalize(); // CLI receipts report resolved paths (including macOS /private/var).
    var tmpRoot = tmp.path;
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

      return IOUtils.makeDirectory(workDir, { createAncestors: true, permissions: 448 }).then(function () {
        // The CLI launcher is POSIX-only. Windows can use the Zotero-native
        // publisher and OA routes without trying to spawn /bin/zsh.
        if (Zotero.isWin) throw new Error("Windows 使用 Zotero 内置下载通道");
        return self._runPaperFetch(
          query, workDir,
          resultJSON, stdoutLog, stderrLog,
          fallbackResultJSON, fallbackStdoutLog, fallbackStderrLog
        );
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
            fallbackStdoutLog, stdoutLog, fallbackResultJSON, resultJSON, fallbackStderrLog, stderrLog
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

  _scanSciCommand: async function (args, workDir, expectedItem) {
    if (this.cancelled) throw new Error("下载已取消");
    var login = args[0] === "login";
    var log = PathUtils.join(workDir, login ? "scansci-login.log" : "scansci.log");
    var session;
    var loginHelper = "";
    var stage = "profile";
    try {
      session = this._scanSciSessionDir();
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
      if (login) {
        stage = "helper";
        loginHelper = PathUtils.join(session, "scansci-login.py");
        var helperScope = {};
        Services.scriptloader.loadSubScript(this.rootURI + "content/scansci-login-source.js", helperScope, "UTF-8");
        if (typeof helperScope.ScanSciLoginSource !== "string" || !helperScope.ScanSciLoginSource) {
          throw new Error("ScanSci 登录脚本缺失");
        }
        await IOUtils.writeUTF8(loginHelper, helperScope.ScanSciLoginSource);
        await IOUtils.setPermissions(loginHelper, 384);
      }
    } catch (e) {
      if (login) {
        try { await IOUtils.writeUTF8(log, "login_failed_stage=" + stage + "\n"); } catch (_) {}
      }
      throw e;
    }
    // Positional arguments prevent DOI/URL shell interpolation. umask protects cookies.
    var script = [
      'set -eu; umask 077',
      'export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"',
      'export SCANSCI_PDF_DATA_DIR="$1"; LOG="$2"; HELPER="$3"; shift 3',
      'BIN="$(command -v scansci-pdf || true)"',
      '[ -n "$BIN" ] || { echo "ScanSci CLI missing" >"$LOG"; exit 127; }',
      'if [ -n "$HELPER" ]; then',
      '  exec >"$LOG" 2>&1',
      '  PY="$(head -n 1 "$BIN")"; PY="${PY:2}"',
      '  [ -x "$PY" ] || { echo "login_failed_stage=interpreter"; exit 127; }',
      '  shift; exec "$PY" "$HELPER" "$@"',
      'fi',
      'exec "$BIN" "$@" >"$LOG" 2>&1'
    ].join("\n");
    var verify = login && expectedItem;
    var process = this._runProcess("/bin/zsh",
      ["-lc", script, "skill-scansci", session, log, loginHelper].concat(args, verify ? ["--verify-in-zotero"] : []),
      1080000);
    if (!verify) return process;
    await this._verifyPublisherCandidates(process, args[2], expectedItem);
  },

  _verifyPublisherCandidates: async function (process, output, item) {
    var candidate = output + ".candidate";
    var decision = output + ".decision";
    var settled = false;
    // Attach a rejection handler immediately; report the actual process result below.
    var completion = process.then(() => { settled = true; }, () => { settled = true; });
    try {
      while (!settled && !this.cancelled) {
        if (await IOUtils.exists(candidate) && !(await IOUtils.exists(decision))) {
          var verdict = "accept";
          try {
            await this._validatePDFIdentity(candidate, item);
          } catch (e) {
            verdict = "reject";
            this._updateItem(this.currentItemIndex, "downloading", "已排除不匹配的 PDF，继续获取本篇全文");
          }
          if (!settled && !this.cancelled) {
            await IOUtils.writeUTF8(decision, verdict, { tmpPath: decision + ".tmp" });
          }
        }
        if (!settled && !this.cancelled) {
          await Promise.race([completion, Zotero.Promise.delay(250)]);
        }
      }
      await process;
    } finally {
      if (!settled && this.activeProcessCancel) this.activeProcessCancel();
      // Failed or cancelled candidates must not be visible as importable PDFs.
      for (var path of [candidate, decision, decision + ".tmp"]) {
        try { await IOUtils.remove(path, { ignoreAbsent: true }); } catch (_) {}
      }
    }
  },

  _readScanSciLoginLog: async function (logFile) {
    try {
      if (await IOUtils.exists(logFile)) return await IOUtils.readUTF8(logFile);
    } catch (_) {}
    return "";
  },

  _scanSciLoginFailure: function (diagnostic) {
    if (/^login_exit=2$/m.test(diagnostic)) return "已取消或关闭 ScanSci 登录窗口；已尝试 Zotero 保底";
    if (/^login_exit=3$/m.test(diagnostic)) return "ScanSci 登录等待超时，未取得本篇 PDF；请在出版社页面确认登录及机构访问权限";

    var stage = (diagnostic.match(/^login_failed_stage=([a-z_]+)$/m) || [])[1];
    if (/^ScanSci CLI missing$/m.test(diagnostic)) stage = "cli";
    var reasons = {
      cli: "未找到 ScanSci 命令", interpreter: "ScanSci 的 Python 环境不可用",
      helper: "登录脚本加载失败", dependencies: "登录依赖不可用",
      profile: "专用浏览器配置读取失败", launch: "专用浏览器启动失败",
      context: "专用浏览器初始化失败", navigate: "论文页面打开失败",
      await_login: "登录过程中浏览器运行异常", save_session: "登录会话保存失败"
    };
    var ready = /^login_browser_ready$/m.test(diagnostic);
    var message = stage && reasons[stage] ? reasons[stage] + "（" + stage + "）" :
      ready ? "ScanSci 登录窗口已启动，但未取得本篇 PDF" : "ScanSci 专用登录窗口未能启动";
    return message + "；与 Elsevier API Key 无关";
  },

  _elsevierDOI: function (item) {
    var doi = String(item.getField("DOI") || "").trim()
      .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "");
    return /^10\.1016\/[^\s?#]+$/i.test(doi) ? doi : "";
  },

  _elsevierPII: function (url) {
    try {
      var parsed = new URL(url);
      if (parsed.protocol !== "https:" || parsed.port || parsed.username || parsed.password) return "";
      var pattern = /^\/(?:science\/article(?:\/abs)?|retrieve)\/pii\/([a-z0-9]{17})(?:\/|$)/i;
      if (["www.sciencedirect.com", "sciencedirect.com", "linkinghub.elsevier.com"].includes(parsed.hostname)) {
        return (parsed.pathname.match(pattern) || [])[1]?.toUpperCase() || "";
      }
    } catch (_) {}
    return "";
  },

  _elsevierArticle: function (pii) {
    return "https://www.sciencedirect.com/science/article/pii/" + pii;
  },

  _publisherRequest: function (url, options) {
    return Zotero.HTTP.request("GET", url, options);
  },

  _getElsevierPDF: async function (pii, output, state) {
    var article = this._elsevierArticle(pii);
    var url = article + "/pdfft?download=true";
    for (var attempt = 0; attempt < 2 && !state.stopped; attempt++) {
      var response = await this._publisherRequest(url, {
        responseType: "arraybuffer", timeout: 15000, successCodes: false,
        noRetryOnThrottle: true, errorDelayMax: 0,
        headers: { Referer: article },
        cancellerReceiver: (abort) => { state.abort = abort; }
      });
      state.abort = null;
      if (state.stopped || response.status !== 200 || !response.response) return false;
      var data = new Uint8Array(response.response);
      if (data.length >= 5 && String.fromCharCode(...data.subarray(0, 5)) === "%PDF-") {
        await IOUtils.write(output, data);
        if (state.validate) {
          try { await state.validate(output); }
          catch (e) {
            await IOUtils.remove(output, { ignoreAbsent: true });
            return false;
          }
        }
        return true;
      }

      // ScienceDirect can return a PDF viewer page rather than PDF bytes.
      // Follow only an actual publisher-provided link for this exact article.
      if (attempt || data.length > 2 * 1024 * 1024 ||
          !/\btext\/html\b/i.test(response.getResponseHeader("Content-Type") || "")) return false;
      var html = new TextDecoder().decode(data);
      var doc = new DOMParser().parseFromString(html, "text/html");
      var nodes = doc.querySelectorAll('meta[name="citation_pdf_url"], iframe[src], object[data], embed[src], a[href]');
      var linked = Array.from(nodes, (node) => {
        try {
          var value = node.getAttribute("content") || node.getAttribute("src") ||
            node.getAttribute("data") || node.getAttribute("href");
          if (!value) return null;
          var link = new URL(value, response.responseURL || article);
          if (link.protocol !== "https:" || link.port || link.username || link.password || link.href === url) return null;
          var assets = link.hostname === "pdf.sciencedirectassets.com";
          var assetPath = new RegExp("(?:^|/)1-s2\\.0-" + pii + "(?:[/.\\-]|$)", "i");
          return (assets && assetPath.test(link.pathname) ||
            link.hostname === "www.sciencedirect.com" && this._elsevierPII(link.href) === pii &&
            /\/(?:pdfft|pdf)(?:\/|$)/i.test(link.pathname)) ? link.href : null;
        } catch (_) { return null; }
      }).find(Boolean);
      if (!linked) return false;
      url = linked;
    }
    return false;
  },

  _tryNativeElsevier: async function (item, dir, consent) {
    var doi = this._elsevierDOI(item);
    var pii = this._elsevierPII(item.getField("url"));
    if (!doi || !Zotero.HTTP?.request || !Zotero.openInViewer) return null;
    var startURL = pii ? this._elsevierArticle(pii) : "https://doi.org/" + doi;
    var output = PathUtils.join(dir, "elsevier-native.pdf");
    var win;
    var state = { stopped: false, abort: null, validate: (file) => this._validatePDFIdentity(file, item) };
    var stop = () => {
      state.stopped = true;
      if (state.abort) state.abort();
      if (win && !win.closed) win.close();
    };
    this.activePublisherCancel = stop;
    try {
      // Reuse the cookie jar shared by Zotero's viewer and HTTP requests.
      // No browser window is needed when access is already available.
      this._updateItem(this.currentItemIndex, "downloading", "检查 ScienceDirect 全文");
      if (!pii) {
        try {
          var landing = await this._publisherRequest(startURL, {
            timeout: 10000, successCodes: false, errorDelayMax: 0,
            cancellerReceiver: (abort) => { state.abort = abort; }
          });
          pii = this._elsevierPII(landing.responseURL);
        } catch (_) {} finally { state.abort = null; }
      }
      var probe = async () => {
        try { return await this._getElsevierPDF(pii, output, state); }
        catch (_) { return false; }
        finally { state.abort = null; }
      };
      if (pii && !state.stopped && await probe()) return output;
      if (state.stopped || this.cancelled) return null;
      if (!consent && !Services.prompt.confirm(Zotero.getMainWindow(), "ScienceDirect 登录",
        "需要出版社或机构访问权限。是否在 Zotero 内置浏览器打开论文？完成账号验证后，插件会自动重试下载并导入 PDF。")) {
        this.lastScanSciError = "已跳过 ScienceDirect 登录；已尝试 Zotero 保底";
        return null;
      }
      this._updateItem(this.currentItemIndex, "downloading", "等待 ScienceDirect 登录，完成后自动下载");
      win = Zotero.openInViewer(pii ? this._elsevierArticle(pii) : startURL);
      if (!win) throw new Error("Zotero 内置登录窗口启动失败");
      var deadline = Date.now() + 15 * 60 * 1000;
      var lastURL = "", nextProbe = 0;
      while (!this.cancelled && !state.stopped && !win.closed && Date.now() < deadline) {
        var currentURL = win.document.querySelector("browser")?.currentURI?.spec || "";
        var currentPII = this._elsevierPII(currentURL);
        if (currentPII && (!pii || currentPII === pii)) {
          pii = currentPII;
          if (currentURL !== lastURL || Date.now() >= nextProbe) {
            nextProbe = Date.now() + 10000;
            lastURL = currentURL;
            if (await probe() && !win.closed && !state.stopped && !this.cancelled) return output;
          }
        }
        if (!win.closed && !state.stopped) await Zotero.Promise.delay(1000);
      }
      if (!this.cancelled && !state.stopped) {
        this.lastScanSciError = win.closed ? "已关闭 ScienceDirect 登录窗口；已尝试 Zotero 保底" :
          "ScienceDirect 在登录等待时间内未返回可下载的 PDF；请检查机构访问权限或站点状态";
      }
      return null;
    } finally {
      stop();
      if (this.activePublisherCancel === stop) this.activePublisherCancel = null;
    }
  },

  _tryScanSci: async function (item, query, workDir) {
    if (this.cancelled) return null;
    this.lastScanSciError = "";
    var dir = PathUtils.join(workDir, "scansci");
    await IOUtils.makeDirectory(dir, { createAncestors: true });
    var args = ["get", query, "--output", dir, "--strategy", "legal_only", "--no-bibtex"];
    // Elsevier get() in current ScanSci truncates PII. Use the dedicated
    // browser path once rather than opening the broken upstream browser first.
    var elsevier = !!this._elsevierDOI(item);
    if (Zotero.isWin) {
      var nativeFile = elsevier ? await this._tryNativeElsevier(item, dir, false) : null;
      return this._importScanSciPDF(nativeFile, item, "ScienceDirect 全文");
    }
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
          "该文献可能需要出版社或机构登录。是否打开登录窗口？完成账号验证后插件会自动下载并导入 PDF。点击取消使用 Zotero 保底下载。");
        if (accepted && !this.cancelled) {
          var url = (item.getField("url") || "").trim();
          var doi = this._elsevierDOI(item) || (item.getField("DOI") || "").trim();
          // Preserve a complete ScienceDirect PII from the Zotero record.
          if ((elsevier && !this._elsevierPII(url)) || (!/^https:\/\//i.test(url) && doi)) {
            url = "https://doi.org/" + doi;
          }
          if (/^https:\/\//i.test(url)) {
            try {
              this._updateItem(this.currentItemIndex, "downloading", "等待登录，检测全文后自动继续");
              var loginPDF = PathUtils.join(dir, "verified-login.pdf");
              await this._scanSciCommand(["login", url, loginPDF, doi], dir, item);
              if (this.cancelled) return null;
              this._updateItem(this.currentItemIndex, "downloading", "登录完成，验证全文");
              if (await IOUtils.exists(loginPDF)) file = loginPDF;
              else throw new Error("登录窗口结束但没有返回本篇 PDF");
            } catch (e) {
              if (this.cancelled) return null;
              var diagnostic = await this._readScanSciLoginLog(PathUtils.join(dir, "scansci-login.log"));
              this.lastScanSciError = this._scanSciLoginFailure(diagnostic);
              if (elsevier && !/^login_browser_ready$|^login_exit=[23]$/m.test(diagnostic)) {
                var fallbackFile = await this._tryNativeElsevier(item, dir, true);
                return this._importScanSciPDF(fallbackFile, item, "ScienceDirect 全文");
              }
            }
          }
        }
      }
    }
    return this._importScanSciPDF(file, item);
  },

  _importScanSciPDF: async function (file, item, title = "ScanSci 全文") {
    if (this.cancelled || !file || !file.toLowerCase().endsWith(".pdf")) return null;
    await this._validatePDFIdentity(file, item);
    if (this.cancelled) return null;
    var existing = await this._findExistingPDFAttachment(item);
    if (existing) return existing;
    return Zotero.Attachments.importFromFile({
      file: file, parentItemID: item.id, title: title, contentType: "application/pdf"
    });
  },

  _validatePDFIdentity: async function (file, item) {
    var elsevier = !!this._elsevierDOI(item);
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
        "pdf.getFulltext", { buf: buffer, maxPages: elsevier ? 1 : 3 }, [buffer]
      );
    } catch (e) {
      throw new Error("PDF \u6587\u672C\u63D0\u53D6\u5931\u8D25: " + (e.message || String(e)));
    }
    var text = String(result && result.text || "").slice(0, 30000).toLowerCase()
      .replace(/(10\.\d{4,9})\s*\/\s*/g, "$1/");
    if (!text.trim()) throw new Error("PDF \u524D\u4E09\u9875\u6CA1\u6709\u53EF\u9A8C\u8BC1\u6587\u672C");

    var doi = String(item.getField("DOI") || "").trim().toLowerCase()
      .replace(/^https?:\/\/(?:dx\.)?doi\.org\//, "");
    var foundDOIs = (text.match(/10\.\d{4,9}\/[-._;()/:a-z0-9]+/g) || [])
      .map((value) => value.replace(/[.,;]+$/, ""));
    var hasDOI = doi && (elsevier ? foundDOIs.includes(doi) : text.indexOf(doi) !== -1);
    if (hasDOI && !elsevier) return true;

    var normalize = function (value) {
      return String(value || "").toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9]+/g, " ").trim();
    };
    var stop = new Set(["the", "and", "for", "with", "from", "into", "this", "that", "river"]);
    var tokens = Array.from(new Set(normalize(item.getField("title")).split(" ").filter(function (token) {
      return token.length >= 4 && !stop.has(token);
    })));
    // A DOI in the contents/references of another Elsevier PDF is not its
    // publication identity. Check that the expected title is at the front.
    var normalizedText = " " + normalize(elsevier ? text.slice(0, 2200) : text) + " ";
    var matched = tokens.filter(function (token) {
      return normalizedText.indexOf(" " + token + " ") !== -1;
    }).length;
    var score = tokens.length ? matched / tokens.length : 0;
    if (elsevier) {
      var exactTitle = normalize(item.getField("title"));
      if (hasDOI && (tokens.length < 4 || score >= 0.7)) return true;
      if (!foundDOIs.length && tokens.length >= 4 && normalizedText.includes(" " + exactTitle + " ")) return true;
    } else if (tokens.length >= 4 && score >= 0.7) return true;

    var found = foundDOIs.find((value) => value !== doi);
    if (found) {
      throw new Error("PDF DOI \u4E0D\u5339\u914D: " + found);
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

    var script = [
      "set -euo pipefail; umask 077",
      "export PATH=\"$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/opt/local/bin:$PATH\"",
      "BIN=\"$(command -v paper-fetch || true)\"",
      "if [ -z \"$BIN\" ]; then echo \"paper-fetch CLI not found\" >&2; exit 127; fi",
      "exec 2>\"$5\"",
      "VERSION=\"$(\"$BIN\" --version)\"; VERSION=\"${VERSION#paper-fetch }\"; MAJOR=\"${VERSION%%.*}\"",
      "if [[ \"$MAJOR\" == <-> ]] && (( MAJOR >= 8 )); then",
      "  : >\"$3.receipt-mode\"",
      // Zotero imports a single file, so keep publisher links in Markdown instead
      // of local asset links that would break when Zotero copies the attachment.
      "  exec \"$BIN\" fetch --query \"$1\" --output-dir \"$2\" --artifact-mode \"$6\" --asset-profile none --prefer-cache --overwrite >\"$4\"",
      "fi",
      "args=(--artifact-mode \"$6\")",
      "if [[ \"$6\" == markdown-assets ]]; then args+=(--asset-profile body); fi",
      "exec \"$BIN\" fetch --query \"$1\" --format json --output \"$3\" --output-dir \"$2\" --save-markdown \"${args[@]}\" >\"$4\""
    ].join("\n");

    function run(result, stdout, stderr, mode, timeout) {
      return self._runProcess("/bin/zsh", [
        "-lc", script, "skill-fulltext-zotero",
        query, outputDir, result, stdout, stderr, mode
      ], timeout).then(async function () {
        var file = await self._paperFetchAttachment(outputDir, result, stdout, query, mode);
        if (file) return file;
        throw new Error("paper-fetch 未生成可导入的全文");
      });
    }

    // Leave time for first-run browser preparation in the full mode.
    return run(resultJSON, stdoutLog, stderrLog, "markdown-assets", 1080000)
      .catch(function (error) {
        if (self.cancelled) throw error;
        return run(fallbackResultJSON, fallbackStdoutLog, fallbackStderrLog, "none", 60000);
      });
  },

  _paperFetchAttachment: async function (dir, legacyPath, receiptPath, query, mode) {
    if (!(await IOUtils.exists(legacyPath + ".receipt-mode"))) {
      return this._pickAttachmentFile(dir, [legacyPath]);
    }

    // v8 writes a receipt even for abstract-only/failed requests. Never fall
    // back to scanning arbitrary Markdown or old artifacts in this mode.
    try {
      var receipt = JSON.parse(await IOUtils.readUTF8(receiptPath));
      var acceptance = receipt.acceptance || {};
      var identity = receipt.identity || {};
      if (receipt.contract !== "paper-fetch/receipt" || receipt.schema_version !== 2 ||
          receipt.index !== 1 || receipt.query !== query || receipt.status !== "completed" ||
          receipt.error || receipt.target_satisfied !== true || receipt.truncated !== false ||
          receipt.content_kind !== "fulltext" || acceptance.has_fulltext !== true ||
          acceptance.fetch !== "ok" || (acceptance.target && acceptance.target !== "paper") ||
          !["complete", "degraded"].includes(acceptance.overall) ||
          identity.status !== "resolved" || acceptance.identity !== "resolved") return null;

      var expectedDOI = /^10\.\d{4,9}\//.test(query) ? query : identity.expected_doi || "";
      if (/^10\.\d{4,9}\/\S+$/.test(expectedDOI) &&
          String(identity.doi || "").toLowerCase() !== expectedDOI.toLowerCase()) return null;

      if (mode === "markdown-assets" && receipt.acquisition?.representation === "pdf") {
        // The provider saves the original PDF at the root separately from
        // receipt files. Prefer it only when unique; _one checks PDF identity.
        var candidates = (await IOUtils.getChildren(dir)).filter(function (file) {
          return /\.pdf$/i.test(file);
        });
        if (candidates.length === 1 && await this._isRegularNonEmpty(candidates[0])) {
          return candidates[0];
        }
      }
      var bodyPath = receipt.body_path;
      if (typeof bodyPath !== "string" || !bodyPath.startsWith(dir + "/") ||
          !/^\.paper-fetch-results\/[0-9a-f-]{36}\/1\/body\.md$/i.test(bodyPath.slice(dir.length + 1))) return null;
      return await this._isRegularNonEmpty(bodyPath) ? bodyPath : null;
    } catch (e) {
      Zotero.debug("Skill Fulltext: invalid Paper-fetch receipt: " + e, 2);
      return null;
    }
  },

  _isRegularNonEmpty: async function (file) {
    try {
      var stat = await IOUtils.stat(file);
      return stat.type === "regular" && stat.size > 0;
    } catch (e) {
      return false;
    }
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
          if (payload.contract === "paper-fetch/receipt") {
            var error = payload.error || {};
            if (error.status === "ambiguous" || payload.identity?.status === "ambiguous") return "标题歧义，请补充 DOI";
            if (error.reason) return String(error.reason).slice(0, 160);
            if (payload.content_kind === "metadata_only") return "paper-fetch 仅返回元数据，未获取全文";
            if (payload.content_kind === "abstract_only") return "paper-fetch 仅返回摘要，未获取全文";
            continue;
          }
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
          if (!path.endsWith(".stdout.log")) return text.slice(0, 160);
        }
      } catch (e) {}
    }
    return "";
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

  _pickAttachmentFile: async function (dir, resultPaths) {
    var files = await this._listFilesRecursive(dir);
    if (resultPaths) {
      // CLI JSON is an ArticleModel (4.x–7.x), not the compact MCP envelope.
      // A zero process exit can still mean metadata_only or abstract_only.
      var payload = null;
      for (var resultPath of resultPaths) {
        if (!(await IOUtils.exists(resultPath))) continue;
        try { payload = JSON.parse(await IOUtils.readUTF8(resultPath)); }
        catch (e) { return null; }
        break;
      }
      if (!payload || typeof payload !== "object") return null;
      if (payload.status && payload.status !== "ok" && payload.status !== "success") return null;
      var article = payload.article || payload;
      var quality = article.quality || payload.quality || {};
      if (quality.has_fulltext === false ||
          (quality.content_kind && quality.content_kind !== "fulltext")) return null;
      var acceptance = payload.acceptance || {};
      if (acceptance.overall === "failed" || acceptance.overall === "blocked") return null;
      // Assets can themselves be PDF files. Never attach a figure, supplement,
      // diagnostic, or ScanSci leftover as the Paper-fetch article.
      var assetPaths = (article.assets || []).reduce(function (paths, asset) {
        for (var path of [asset.path, asset.source_path]) {
          if (path) paths.push(path.startsWith("/") ? path : PathUtils.join(dir, path));
        }
        return paths;
      }, []);
      files = files.filter(function (file) {
        var relative = file.slice(dir.length + 1);
        if (assetPaths.includes(file)) return false;
        if (/(^|\/)(?:[^/]*assets|supplementary|supplements|diagnostics|scansci)(?:\/|$)/i.test(relative)) return false;
        // Saved article Markdown is a top-level CLI output; nested Markdown
        // is a provider/cache sidecar, not a standalone article attachment.
        return !file.toLowerCase().endsWith(".md") || !relative.includes("/");
      });
    }
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
