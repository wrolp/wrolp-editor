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
| 标签分组 | 一个分组就是**一组有名字的标签**。标题栏上的小牌在同一窗口里切换分组；标签顺序与光标位置在下次启动时还原 |
| 移动 / 复制标签 | 标签右键菜单可把标签归到另一个分组。改的是「哪个分组列着它」，磁盘上的文件不动 |
| 窗口 | 大小、位置、是否最大化都在下次启动时还原。上次所在的显示器不在了，窗口会被拉回还在用的屏幕上，并说明原因 |

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
    ├── settings.json         fontSize、minimap、sidebarVisible、sidebarView、sidebarWidth、language、
    │                         restoreSession、sidebarRoot
    ├── groups.json           标签分组：名字、标签与光标位置
    └── window.json           x、y、width、height（物理像素）与是否最大化
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
`get_groups`、`save_groups`、`transfer_tabs`、
`get_window_state`、`save_window_state`、`plan_window_placement`、
`context_menu_target`、`install_context_menu`、`uninstall_context_menu`。

文件读写**故意不用** `fs` 插件：WebView 只能调用上面这些固定命令，不把大范围磁盘 scope 暴露给前端。

## 标签分组

一个分组就是**一组有名字的标签**。标题栏上的小牌显示当前名字，切换就在那一窗口内换掉整组标签。
资源管理器显示哪个目录是另一回事：它是**全局视图设置**（`sidebarRoot`），所以两个分组可以指向同一目录，
一个分组也可以装着来自好几个目录的文件。

- **总有一个分组在用。**没有任何分组时，窗口会带出一个名为「默认分组」的组，所以标签从第一个开始就被记下来，
  不需要用户先手动新建。「新建分组…」要求输入名字，空名字和重名都被拦下——列表里两行读起来一样就没法区分。
  默认分组同样可以改名；把所有分组都移除后，下次启动会再给一个默认分组。
- **文件并进当前那个。**从资源管理器右键打开的文件加进眼前的分组；右键不会在你脚下换掉整个上下文。
  「打开文件夹…」和标签右键的「在侧边栏显示所在目录」只动侧栏，**不建组也不切组**。
- **记下来的东西：** 标签顺序、当前选中的标签、每个标签的光标位置（设置里「启动时重新打开上次的标签」可关），
  以及未命名标签的正文——它没有草稿文件，分组是唯一副本。上限 32 个分组、每个 200 个标签、每个未命名
  标签 64 KB。
- **内容绝不存两份。**有文件的标签只存路径与光标，未保存正文归草稿文件管，key 由路径决定。所以标签能直接
  挪到别的分组而不用搬草稿，草稿提示也会跟着文件走。
- **移动 / 复制标签**（标签右键菜单）只改标签挂在哪个分组下，**不碰磁盘上的文件**：真挪文件会让按路径哈希的
  草稿 key 变成孤儿。
- **文件被删了**：恢复时跳过，汇总成一条提示，并从该分组记录里去掉。「从列表移除」也只删记录，文件与草稿都不动。

`groups.json` 整存整取（应用单实例，只有一个写入方），落盘走临时文件 + rename。标签路径用的就是草稿哈希前的
同一套规范化形式，所以同一个文件在一个分组里不会出现两条。只有旧名 `workspaces.json` 而没有 `groups.json` 时，
迁移发生在**读取时**：解析旧文件、按新名写出、然后才删掉旧的——所以旧文件损坏时不会被后续保存顺手清掉。旧记录里
多带的 `root` / `autoName` / `sidebarView` 字段会被忽略、缺的字段取默认值，因此不需要额外迁移步骤。

## 窗口状态

窗口在下次打开时回到你离开时的样子：同样的大小、同样的位置、同样的是否最大化。

- **存的是物理像素。** `window.json` 记的是 `outerPosition`/`outerSize`，物理像素而非 DIP。200% 缩放下
  一个 1193×748 的窗口会被记成 2386×1495。
- **最大化时存两件事。** 处于最大化时只写标志位；最大化之前那个普通矩形被保留下来。所以取消最大化会回到
  你自己选的尺寸，而上次是最大化关闭的，这次就还是最大化。
- **显示器换了或拔了能兜住。** 保存的矩形在应用之前会先跟**当前**接着的显示器比对：只要顶部那条能碰到就算
  可达，因为无边框窗口是靠顶部拖动的。哪个屏幕都不挨着的矩形会按原尺寸钳回主屏，并提示原因。尺寸是垃圾值或
  大到不合理时回落到首次运行那次的尺寸（1180×740，与 `tauri.conf.json` 同值但在 Rust 里另写了一份——改一处
  要改两处），并按屏幕钳制。
- **写入时机：** 移动或缩放后约 600 ms 防抖，以及关窗序列里与草稿、分组一起的同步 flush。
- **首次运行**沿用 `tauri.conf.json` 里的尺寸并居中——没有存档就不给意外位置。

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

## 许可证

MIT —— 见 [LICENSE](LICENSE)。
