# Skill Fulltext Downloader for Zotero

将 [paperfetch](https://github.com/douxy1994/paperfetch) 的论文全文抓取能力集成到 Zotero，实现一键下载全文并自动导入为题录附件。

## ✨ 功能特性

- **右键菜单集成**：在 Zotero 题录列表中右键即可看到「skill下载全文」菜单项，带图标
- **批量下载**：支持同时选中多个题录批量下载
- **进度弹窗**：居中弹窗显示下载进度，包含进度条、每条题录状态（⏳等待 / 🔄下载中 / ✅完成 / ❌失败）、可取消
- **自动导入附件**：下载完成后自动将 PDF（优先）或 Markdown 全文导入为对应题录的子附件；若 Zotero 已下载 OA PDF，则直接识别现有附件，避免把成功下载误报为失败
- **智能查询**：按 DOI → URL → 标题 的优先级构造查询
- **两步降级策略**：先尝试完整模式（含浏览器，可能拿到 PDF），失败后自动降级到无浏览器模式（快速拿 Markdown）
- **深色模式**：弹窗跟随系统主题自动切换深色/浅色
- **中英双语**：菜单和界面支持中文和英文

## 🔧 系统要求

| 组件 | 要求 |
|------|------|
| Zotero | 9.0+（兼容 7/8 bootstrapped 插件结构） |
| paper-fetch CLI | 已安装并在 PATH 中，或位于 `/opt/homebrew/bin/paper-fetch`；兼容 4.x / 5.x，建议 ≥ 5.3（4.0 起浏览器后端仅支持 Camoufox，旧版 CloakBrowser 已移除；5.2 起新增 Taylor & Francis Online provider） |
| 操作系统 | macOS / Linux（需要 zsh） |

### 安装 paper-fetch

**离线安装（推荐）：**

从 [paperfetch Releases](https://github.com/douxy1994/paperfetch/releases) 下载对应平台的安装包。

**在线安装：**

```bash
pip install paper-fetch-skill
```

详见 [paperfetch](https://github.com/douxy1994/paperfetch) 文档。

## 📥 安装插件

### 方式一：直接下载 XPI

1. 从 [Releases](../../releases) 下载最新的 `.xpi` 文件
2. 打开 Zotero → 工具 → 插件
3. 点击齿轮图标 ⚙️ → 「Install Add-on From File...」
4. 选择下载的 `.xpi` 文件
5. 重启 Zotero

### 方式二：从源码构建

```bash
git clone https://github.com/douxy1994/Zotero_paper_download.git
cd Zotero_paper_download
zip -r skill-fulltext-zotero.xpi . -x "*.DS_Store" "*.git*"
```

然后在 Zotero 中安装生成的 `skill-fulltext-zotero.xpi`。

### 自动更新

从 `0.6.1` 起，插件通过 Zotero 内置的附加组件更新器自动更新。插件清单使用固定的
`main/updates.json` 地址检查新版本，匹配后由 Zotero 下载对应 Release 中的 XPI，并按
SHA-256 校验。首次安装 `0.6.1` 后，后续版本无需再手动下载 XPI；请在 Zotero 的
「工具 → 插件 → 齿轮」中保持「自动更新附加组件」启用。

维护者发布新版本时运行 `scripts/build-release.sh`。脚本会读取 `manifest.json` 的版本号、
构建最小 XPI，并原子更新 `updates.json` 中对应版本的下载链接和 SHA-256；随后发布同版本
GitHub Release，并把 XPI、`updates.json` 与源码一并提交。

## 🚀 使用方法

1. 在 Zotero 中选中一个或多个题录
2. 右键 → 点击「skill下载全文」
3. 弹窗出现，显示下载进度
4. 下载完成后，PDF/Markdown 会自动添加为题录的子附件

### 查询策略

插件按以下优先级构造 paper-fetch 查询：

1. **DOI**（最精确，推荐）
2. **URL**（题录的 URL 字段）
3. **标题**（最后手段，可能产生歧义）

### 下载策略

插件采用两步降级策略：

| 步骤 | 模式 | 超时 | 说明 |
|------|------|------|------|
| 1 | 完整模式 (`fetch --artifact-mode markdown-assets --asset-profile body`) | 180秒 | 尝试通过浏览器获取 PDF 和正文图片资源（Camoufox 首次运行需下载浏览器运行时，故放宽超时）|
| 2 | 降级模式 (`fetch --artifact-mode none`) | 60秒 | 跳过浏览器，快速获取 Markdown 全文 |

### 下载结果

| 文件类型 | 说明 |
|----------|------|
| PDF | 优先导入（当浏览器链路成功时） |
| Markdown | 备选导入（paper-fetch 的 AI 友好 Markdown 全文） |

> **注意**：paper-fetch 能否获取全文取决于论文的开放获取状态和 provider 配置。开放获取论文（如 MDPI、arXiv）通常能成功下载；付费墙论文可能只能获取摘要或元数据。浏览器链路（Camoufox）的稳定性可能影响 PDF 获取。

## 🏗️ 项目结构

```
Zotero_paper_download/
├── manifest.json                    # 插件清单
├── bootstrap.js                     # Zotero bootstrapped 插件入口
├── skill-fulltext-downloader.js     # 主逻辑（菜单、弹窗、下载、导入）
├── locale/
│   ├── zh-CN/
│   │   └── skill-fulltext-downloader.ftl   # 中文菜单文本
│   └── en-US/
│       └── skill-fulltext-downloader.ftl   # 英文菜单文本
├── content/
│   └── icons/
│       └── icon16.svg               # 菜单图标
├── skill-fulltext-zotero.xpi        # 预构建的安装包
└── README.md
```

## ⚙️ 技术实现

### 插件架构

- **Bootstrapped 插件**：使用 Zotero 7+ 的 bootstrapped 插件结构，兼容 Zotero 9
- **菜单注册**：通过 `Zotero.MenuManager.registerMenu()` 注册右键菜单
- **进程调用**：通过 `nsIProcess` 调用本机 `paper-fetch` CLI
- **附件导入**：通过 `Zotero.Attachments.importFromFile()` 导入文件
- **进度弹窗**：使用 XUL `openDialog` 创建非阻塞的独立窗口

### 下载流程

```
选中题录 → 右键「skill下载全文」
    ↓
弹出进度窗口
    ↓
逐条处理：
  1. 提取 DOI/URL/标题
  2. 创建临时目录
  3. 调用 paper-fetch CLI（完整模式，180s 超时）
  4. 如果完整模式失败 → 降级到无浏览器模式（60s 超时）
  5. 查找生成的 PDF/Markdown（优先 PDF）
  6. 若 paper-fetch 无产物，等待并识别 Zotero 已有 OA PDF，再调用 Zotero 原生可用全文解析器
  7. 导入新文件或接受已存在的有效 PDF 附件；确无全文时显示具体诊断
  8. 更新弹窗状态
    ↓
全部完成 → 启用「关闭」按钮
```

### paper-fetch CLI 参数

| 参数 | 完整模式 | 降级模式 |
|------|----------|----------|
| `--format` | json | json |
| `--output` | result.json | result.json |
| `--output-dir` | 工作目录 | 工作目录 |
| `--save-markdown` | ✅ | ✅ |
| `--artifact-mode` | markdown-assets | none |
| `--asset-profile` | body | - |

## 📋 已知限制

1. **付费墙论文**：paper-fetch 不绕过付费墙，只能获取开放获取的全文
2. **标题歧义**：没有 DOI 的题录用标题查询时，paper-fetch 可能返回多个候选导致失败
3. **浏览器链路**：Camoufox 浏览器运行时的下载与站点验证可能影响 PDF 获取，此时自动降级为 Markdown
4. **macOS 专用**：当前使用 `/bin/zsh` 执行命令，Windows/Linux 需要适配

## 🙏 致谢

本插件的核心下载能力完全来自 [paperfetch](https://github.com/douxy1994/paperfetch)（CLI · MCP · Skill）。本插件仅负责 Zotero 右键菜单集成、进度显示和附件导入，不复制或重新实现任何下载逻辑。

paperfetch 支持 19 个出版社/平台全文 provider：arXiv、Elsevier、Springer、Wiley、Science、PNAS、IEEE、Copernicus、AMS、MDPI、Royal Society Publishing、Annual Reviews、PLOS、Frontiers、Oxford Academic、ACS、IOP、AIP 和 Taylor & Francis Online。

## 📄 许可证

MIT License

Copyright (c) 2026 douxy1994

The paper-fetch skill is licensed under its respective terms. See [paperfetch](https://github.com/douxy1994/paperfetch) for details.

---

# Skill Fulltext Downloader for Zotero (English)

Integrates the paper-fetching capability of [paperfetch](https://github.com/douxy1994/paperfetch) into Zotero, enabling one-click full-text download and automatic attachment import.

## ✨ Features

- **Context Menu Integration**: Right-click any item in Zotero to see "Skill Download Full Text" with an icon
- **Batch Download**: Select multiple items and download them all at once
- **Progress Dialog**: Centered dialog with progress bar, per-item status (⏳ pending / 🔄 downloading / ✅ success / ❌ failed), and cancel support
- **Auto Import**: Downloaded PDF (preferred) or Markdown full text is automatically imported as a child attachment; an OA PDF already downloaded by Zotero is recognized instead of being misreported as a failure
- **Smart Query**: Constructs queries in priority order: DOI → URL → Title
- **Two-Step Fallback**: First tries full mode (with browser, may get PDF), then falls back to no-browser mode (fast Markdown)
- **Dark Mode**: Dialog follows system theme (light/dark)
- **Bilingual**: Chinese and English UI

## 🔧 Requirements

| Component | Requirement |
|-----------|-------------|
| Zotero | 9.0+ (compatible with 7/8 bootstrapped plugin structure) |
| paper-fetch CLI | Installed and on PATH, or at `/opt/homebrew/bin/paper-fetch`; compatible with 4.x / 5.x, ≥ 5.3 recommended (4.0 supports only the Camoufox browser backend; the legacy CloakBrowser backend was removed; 5.2 added the Taylor & Francis Online provider) |
| OS | macOS / Linux (requires zsh) |

### Install paper-fetch

**Offline install (recommended):**

Download the appropriate installer from [paperfetch Releases](https://github.com/douxy1994/paperfetch/releases).

**Online install:**

```bash
pip install paper-fetch-skill
```

See [paperfetch](https://github.com/douxy1994/paperfetch) for details.

## 📥 Installation

### Option 1: Download XPI

1. Download the latest `.xpi` from [Releases](../../releases)
2. Open Zotero → Tools → Add-ons
3. Click the gear icon ⚙️ → "Install Add-on From File..."
4. Select the downloaded `.xpi`
5. Restart Zotero

### Option 2: Build from Source

```bash
git clone https://github.com/douxy1994/Zotero_paper_download.git
cd Zotero_paper_download
zip -r skill-fulltext-zotero.xpi . -x "*.DS_Store" "*.git*"
```

Then install the generated `skill-fulltext-zotero.xpi` in Zotero.

### Automatic Updates

Starting with `0.6.1`, the plugin uses Zotero's built-in add-on updater. Its manifest points to the
stable `main/updates.json` URL; Zotero selects a compatible version, downloads the matching Release
XPI, and verifies its SHA-256 hash. After installing `0.6.1` once, future versions no longer require
manual XPI downloads. Keep “Update Add-ons Automatically” enabled in Zotero's Add-ons gear menu.

## 🚀 Usage

1. Select one or more items in Zotero
2. Right-click → "Skill Download Full Text"
3. A progress dialog appears showing download status
4. When complete, PDF/Markdown is automatically attached to the item

### Query Strategy

The plugin constructs paper-fetch queries in this priority:

1. **DOI** (most precise, recommended)
2. **URL** (from the item's URL field)
3. **Title** (last resort, may be ambiguous)

### Download Strategy

The plugin uses a two-step fallback strategy:

| Step | Mode | Timeout | Description |
|------|------|---------|-------------|
| 1 | Full mode (`fetch --artifact-mode markdown-assets --asset-profile body`) | 180s | Attempts to get PDF and body image assets via browser (Camoufox may download its browser runtime on first run, hence the longer timeout) |
| 2 | Fallback mode (`fetch --artifact-mode none`) | 60s | Skips browser, quickly gets Markdown full text |

### Download Results

| File Type | Description |
|-----------|-------------|
| PDF | Preferred (when browser link succeeds) |
| Markdown | Fallback (paper-fetch's AI-friendly Markdown full text) |

> **Note**: paper-fetch's ability to retrieve full text depends on the paper's open access status and provider configuration. Open access papers (e.g., MDPI, arXiv) typically succeed; paywalled papers may only yield abstracts or metadata. Browser link (Camoufox) stability may affect PDF retrieval.

## 🏗️ Project Structure

```
Zotero_paper_download/
├── manifest.json                    # Plugin manifest
├── bootstrap.js                     # Zotero bootstrapped plugin entry
├── skill-fulltext-downloader.js     # Main logic (menu, dialog, download, import)
├── locale/
│   ├── zh-CN/
│   │   └── skill-fulltext-downloader.ftl   # Chinese menu text
│   └── en-US/
│       └── skill-fulltext-downloader.ftl   # English menu text
├── content/
│   └── icons/
│       └── icon16.svg               # Menu icon
├── skill-fulltext-zotero.xpi        # Pre-built package
└── README.md
```

## ⚙️ Technical Details

### Plugin Architecture

- **Bootstrapped Plugin**: Uses Zotero 7+ bootstrapped plugin structure, compatible with Zotero 9
- **Menu Registration**: Uses `Zotero.MenuManager.registerMenu()` for context menu
- **Process Execution**: Calls local `paper-fetch` CLI via `nsIProcess`
- **Attachment Import**: Uses `Zotero.Attachments.importFromFile()` to import files
- **Progress Dialog**: Uses XUL `openDialog` for a non-blocking independent window

### Download Flow

```
Select items → Right-click "Skill Download Full Text"
    ↓
Progress dialog appears
    ↓
Process each item:
  1. Extract DOI/URL/Title
  2. Create temp directory
  3. Call paper-fetch CLI (full mode, 180s timeout)
  4. If full mode fails → fallback to no-browser mode (60s timeout)
  5. Find generated PDF/Markdown (PDF preferred)
  6. Import as Zotero attachment
  7. Update dialog status
    ↓
All done → Enable "Close" button
```

### paper-fetch CLI Parameters

| Parameter | Full Mode | Fallback Mode |
|-----------|-----------|---------------|
| `--format` | json | json |
| `--output` | result.json | result.json |
| `--output-dir` | work directory | work directory |
| `--save-markdown` | ✅ | ✅ |
| `--artifact-mode` | markdown-assets | none |
| `--asset-profile` | body | - |

## 📋 Known Limitations

1. **Paywalled Papers**: paper-fetch cannot bypass paywalls; only open access full text is available
2. **Title Ambiguity**: Items without DOI may fail when title queries return multiple candidates
3. **Browser Link**: Camoufox browser runtime download and site verification may affect PDF retrieval; auto-fallback to Markdown
4. **macOS Only**: Currently uses `/bin/zsh`; Windows/Linux adaptation needed

## 🙏 Acknowledgments

The core download capability of this plugin comes entirely from [paperfetch](https://github.com/douxy1994/paperfetch) (CLI · MCP · Skill). This plugin only handles Zotero context menu integration, progress display, and attachment import. It does not replicate or re-implement any download logic.

paperfetch supports 19 publisher/platform full-text providers: arXiv, Elsevier, Springer, Wiley, Science, PNAS, IEEE, Copernicus, AMS, MDPI, Royal Society Publishing, Annual Reviews, PLOS, Frontiers, Oxford Academic, ACS, IOP, AIP, and Taylor & Francis Online.

## 📄 License

MIT License

Copyright (c) 2026 douxy1994

The paper-fetch skill is licensed under its respective terms. See [paperfetch](https://github.com/douxy1994/paperfetch) for details.
