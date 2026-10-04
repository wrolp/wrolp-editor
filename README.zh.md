# WROLP Editor

一款 Windows 本地文本编辑器。

技术栈：Tauri v2 + React + TypeScript，编辑区用 Monaco Editor。

## 功能一览

| 模块 | 行为 |
| --- | --- |
| 多标签 | 单窗口多文件；标签脏标记、已打开文件下拉列表、标签右键菜单 |
| 编辑 | Monaco：按扩展名高亮、minimap、每个文件独立 model、切回标签还原光标 |
| 保存 | `Ctrl+S` 写回文件并清除该草稿；未落盘过的 `Untitled-N` 走另存为 |
| 草稿 | 编辑后约 500ms 防抖落盘；切标签、关标签、窗口失焦时立即冲刷 |
| 恢复 | 打开文件时把磁盘内容与草稿比对，不一致就弹「恢复草稿 / 丢弃」 |
| 侧边栏 | 资源管理器目录树（子目录懒加载 + 刷新按钮）与最近打开的历史列表。拖动分隔条可调宽（180–640 px，双击复位），宽度会持久化 |
| 单实例 | 再次启动时把路径交给已运行的窗口，新增标签并聚焦 |
| 设置 | 右键菜单开关、编辑器字号、minimap、界面语言；即时生效并持久化。右键菜单页还会显示当前注册表实际启动的命令，指向别的构建或当前是 debug 构建时给出警告 |
| 语言 | 默认英文，可在设置里下拉切换成中文。所有文案（含 Rust 侧返回的报错）都走同一张 key 表 |
| 工作空间 | 一个工作空间 = 一个侧栏目录 + 其中打开的标签。切换工作空间是在同一窗口里换掉整组上下文；标签顺序与光标位置在下次启动时还原 |
| 移动 / 复制标签 | 标签右键菜单可把标签归到另一个工作空间。改的是「标签挂在哪个工作空间」，磁盘上的文件不动 |

## 快捷键

| 按键 | 作用 |
| --- | --- |
| `Ctrl+S` | 保存（未命名标签走另存为） |
| `Ctrl+O` | 打开文件（可多选） |
| `Ctrl+N` | 新建未命名标签 |
| `Ctrl+W` | 关闭当前标签（其草稿保留） |
| `Ctrl+B` | 切换侧边栏 |

在标签条上滚动滚轮可横向滚动。

## 开始使用

### 环境要求

- Windows 10/11，带 WebView2 运行时（近年的 Windows 已内置）
- Rust 的 MSVC 工具链（`x86_64-pc-windows-msvc`）+ Visual Studio 的 C++ 生成工具工作负载
- Node.js `^20.19` 或 `>=22.12`（Vite 8 的要求）与 npm

### 开发

```bash
npm install
npm run tauri dev
```

debug 构建加载的是 Vite 在 `localhost:1420` 提供的页面。若右键菜单那条注册表指向 `target/debug/wrolp-editor.exe`，只有在 dev server 运行时右键才能打开文件，否则窗口会显示「拒绝连接」页面。日常使用请把菜单指向安装版（设置页会显示当前注册的实际命令）。

### 打安装包

```bash
npm run tauri build
# -> src-tauri/target/release/bundle/nsis/WROLP Editor_<version>_x64-setup.exe
```

只配置了 NSIS 目标（`bundle.targets: ["nsis"]`）。

### 脚本

| 脚本 | 用途 |
| --- | --- |
| `npm run dev` | 在 1420 端口起 Vite dev server（供 `tauri dev` 使用） |
| `npm run build` | 先做类型检查，再产出 `dist/` 生产包 |
| `npm run tauri` | Tauri CLI 透传（`dev`、`build`、`icon` 等） |

## 数据存放位置

全部在应用配置目录下 —— Windows 上是 `%APPDATA%\com.wrolp.editor`：

```
wrolp/
├── drafts/<sha256>.draft     每个文件一份草稿
└── state/
    ├── history.json          最近打开，新的在前，最多 50 条
    ├── settings.json         fontSize、minimap、sidebarVisible、sidebarView、sidebarWidth、language、restoreSession
    └── workspaces.json       工作空间：侧栏目录、标签与光标位置
```

`<sha256>` 是**规范化**路径的哈希：绝对路径、去掉 `\\?\` 前缀、分隔符统一、Windows 下再转小写。草稿内容形如：

```json
{
  "path": "d:\\notes\\a.txt",
  "content": "unsaved text",
  "cursor": 12,
  "updatedAt": "2026-10-04T01:13:36Z"
}
```

`cursor` 存的是 Monaco 的 model 偏移量，所以恢复时光标会落回原处。

### Tauri 命令

`take_startup_files`、`open_file`、`save_file`、`get_draft`、`save_draft`、`clear_draft`、
`list_dir`、`get_history`、`remove_history`、`get_settings`、`save_settings`、
`get_workspaces`、`save_workspaces`、`transfer_tabs`、
`context_menu_target`、`install_context_menu`、`uninstall_context_menu`。

文件读写**故意不用** `fs` 插件：WebView 只能调用上面这些固定命令，不把大范围磁盘 scope 暴露给前端。

## 工作空间

一个工作空间 = **一个侧栏目录 + 其中打开的标签**，标题栏上的名字就是切换器，切换发生在同一窗口内。
其他都不是按工作空间存的：侧栏宽度和界面语言是全局设置。

- **工作空间会自己出现。** 空窗口里打开第一个文件，就为它所在目录建了一个工作空间。之后从资源管理器
  右键打开的文件**并入当前工作空间**——右键不会在你脚下把整个上下文换掉。要有意换目录，用「打开文件夹…」
  或标签右键的「在侧边栏显示所在目录」。
- **记下来的东西：** 标签顺序、当前选中的标签、每个标签的光标位置（设置里「启动时重新打开上次的标签」可关）、
  侧栏视图；未命名标签还存正文——它没有草稿文件，工作空间是唯一副本。上限 32 个工作空间、每个 200 个标签、
  每个未命名标签 64 KB。
- **内容绝不存两份。** 有文件的标签只存路径与光标，未保存正文归草稿文件管，key 由路径决定。所以标签能直接
  挪到别的工作空间而不用搬草稿，草稿提示也会跟着文件走。
- **移动 / 复制标签**（标签右键菜单）只是把工作空间之间的归属改掉，**不碰磁盘上的文件**：真挪文件会让按路径
  哈希的草稿 key 变成孤儿。
- **目录里的文件被删了**：恢复时跳过它们，汇总成一条提示，并从工作空间记录里去掉。「从列表移除」也只删记录，
  文件与草稿都不动。

`workspaces.json` 整存整取（应用是单实例，只有一个写入方），落盘走临时文件 + rename。标签路径用的就是草稿
哈希前的同一套规范化形式，所以同一个文件在一个工作空间里不会出现在两条标签上。

## 界面语言

默认语言是英文，缺 key 时也回落到英文；设置 → 常规 → *界面语言* 是下拉框，因此新增语言不用改布局。

文案不写在组件里。`src/lib/i18n.ts` 每种语言一张扁平 key 表，对外只有 `t(key, params)`，用
`{placeholder}` 做替换：

```ts
{ "status.cursor": "Ln {line} · Col {column}" }        // en
{ "status.cursor": "第 {line} 行 · 第 {column} 列" }    // zh
```

Rust 侧不做翻译。命令失败时返回稳定的**错误码**，后面可用第一个 `:` 跟原始细节，例如
`file_too_large:8`、`file_read:os error 5`、`path_empty`。`translateError()` 按第一个 `:` 切开，
查 `err.<code>` 并把细节填进 `{detail}`，所以就算码没收录，也还能显示可读内容而不是空白。

新增语言的步骤：

1. 在 `src/lib/i18n.ts` 里加一张表，并注册进 `TABLES` 和 `LANGUAGES`（语言名用其自身写法作标签）。
   各表 key 集合必须一致，缺失的 key 会回落英文。
2. 其余不用动。`Settings.language` 只是个原样存储的字符串，下拉项、英文回落和错误映射会自动带上新语言。
3. 若要发布，顺手本地化应用描述（`tauri.conf.json` → `bundle.shortDescription`）；右键菜单那条文案
   故意保持英文，因为它注册一次就被所有语言共用。
