# Skill Fulltext Downloader for Zotero

将 [paper-fetch-skill](https://github.com/Dictation354/paper-fetch-skill) 的论文全文抓取能力集成到 Zotero，实现一键下载全文并自动导入为题录附件。

## ✨ 功能特性

- **右键菜单集成**：在 Zotero 题录列表中右键即可看到「skill下载全文」菜单项
- **批量下载**：支持同时选中多个题录批量下载，带进度弹窗
- **进度弹窗**：居中弹窗显示下载进度，包含进度条、每条题录状态（等待中 / 下载中 / 完成 / 失败）、可取消
- **自动导入附件**：下载完成后自动将 PDF（优先）或 Markdown 全文导入为对应题录的子附件
- **智能查询**：按 DOI → URL → 标题 的优先级构造查询
- **深色模式**：弹窗跟随系统主题自动切换深色/浅色
- **中英双语**：菜单和界面支持中文和英文

## 📸 截图

弹窗包含：
- 标题栏：「Skill 下载全文」
- 进度条 + 计数（如 `2 / 6`）
- 当前状态文字
- 题录列表：每行显示 ⏳/🔄/✅/❌ 图标 + 题录标题 + 状态标签
- 底部按钮：取消 / 关闭

## 🔧 系统要求

| 组件 | 要求 |
|------|------|
| Zotero | 9.0+（兼容 7/8 bootstrapped 插件结构） |
| paper-fetch CLI | 已安装并在 PATH 中，或位于 `/opt/homebrew/bin/paper-fetch` |
| 操作系统 | macOS / Linux（需要 zsh） |

### 安装 paper-fetch

```bash
pip install paper-fetch
```

详见 [paper-fetch-skill](https://github.com/Dictation354/paper-fetch-skill)。

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

### 下载结果

| 文件类型 | 说明 |
|----------|------|
| PDF | 优先导入（当 paper-fetch 获取到 PDF 时） |
| Markdown | 备选导入（paper-fetch 的 AI 友好 Markdown 全文） |

> **注意**：paper-fetch 能否获取全文取决于论文的开放获取状态。开放获取论文（如 MDPI、arXiv）通常能成功下载；付费墙论文可能只能获取摘要或元数据。

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
  3. 调用 paper-fetch CLI
  4. 查找生成的 PDF/Markdown
  5. 导入为 Zotero 附件
  6. 更新弹窗状态
    ↓
全部完成 → 启用「关闭」按钮
```

## 📋 已知限制

1. **付费墙论文**：paper-fetch 无法绕过付费墙，只能获取开放获取的全文
2. **标题歧义**：没有 DOI 的题录用标题查询时，paper-fetch 可能返回多个候选导致失败
3. **下载超时**：单篇论文下载超过 5 分钟会自动取消
4. **macOS 专用**：当前使用 `/bin/zsh` 执行命令，Windows/Linux 需要适配

## 🙏 致谢

本插件的核心下载能力完全来自 [paper-fetch-skill](https://github.com/Dictation354/paper-fetch-skill)（作者：[@Dictation354](https://github.com/Dictation354)）。本插件仅负责 Zotero 右键菜单集成、进度显示和附件导入，不复制或重新实现任何下载逻辑。

## 📄 许可证

MIT License

Copyright (c) 2026 douxy1994

The paper-fetch skill is Copyright (c) Dictation354, licensed under its respective terms. See [paper-fetch-skill](https://github.com/Dictation354/paper-fetch-skill) for details.

---

# Skill Fulltext Downloader for Zotero (English)

Integrates the paper-fetching capability of [paper-fetch-skill](https://github.com/Dictation354/paper-fetch-skill) into Zotero, enabling one-click full-text download and automatic attachment import.

## ✨ Features

- **Context Menu Integration**: Right-click any item in Zotero to see "Skill Download Full Text"
- **Batch Download**: Select multiple items and download them all at once with a progress dialog
- **Progress Dialog**: Centered dialog with progress bar, per-item status (pending / downloading / success / failed), and cancel support
- **Auto Import**: Downloaded PDF (preferred) or Markdown full text is automatically imported as a child attachment of the corresponding Zotero item
- **Smart Query**: Constructs queries in priority order: DOI → URL → Title
- **Dark Mode**: Dialog follows system theme (light/dark)
- **Bilingual**: Chinese and English UI

## 🔧 Requirements

| Component | Requirement |
|-----------|-------------|
| Zotero | 9.0+ (compatible with 7/8 bootstrapped plugin structure) |
| paper-fetch CLI | Installed and on PATH, or at `/opt/homebrew/bin/paper-fetch` |
| OS | macOS / Linux (requires zsh) |

### Install paper-fetch

```bash
pip install paper-fetch
```

See [paper-fetch-skill](https://github.com/Dictation354/paper-fetch-skill) for details.

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

### Download Results

| File Type | Description |
|-----------|-------------|
| PDF | Preferred (when paper-fetch obtains a PDF) |
| Markdown | Fallback (paper-fetch's AI-friendly Markdown full text) |

> **Note**: paper-fetch's ability to retrieve full text depends on the paper's open access status. Open access papers (e.g., MDPI, arXiv) typically succeed; paywalled papers may only yield abstracts or metadata.

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
  3. Call paper-fetch CLI
  4. Find generated PDF/Markdown
  5. Import as Zotero attachment
  6. Update dialog status
    ↓
All done → Enable "Close" button
```

## 📋 Known Limitations

1. **Paywalled Papers**: paper-fetch cannot bypass paywalls; only open access full text is available
2. **Title Ambiguity**: Items without DOI may fail when title queries return multiple candidates
3. **Download Timeout**: Individual papers exceeding 5 minutes are automatically cancelled
4. **macOS Only**: Currently uses `/bin/zsh`; Windows/Linux adaptation needed

## 🙏 Acknowledgments

The core download capability of this plugin comes entirely from [paper-fetch-skill](https://github.com/Dictation354/paper-fetch-skill) (author: [@Dictation354](https://github.com/Dictation354)). This plugin only handles Zotero context menu integration, progress display, and attachment import. It does not replicate or re-implement any download logic.

## 📄 License

MIT License

Copyright (c) 2026 douxy1994

The paper-fetch skill is Copyright (c) Dictation354, licensed under its respective terms. See [paper-fetch-skill](https://github.com/Dictation354/paper-fetch-skill) for details.
