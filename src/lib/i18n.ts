// Minimal in-module i18n: a flat key table per language plus placeholder substitution.
// Backend commands return stable error codes ("code" or "code:detail") that are mapped here,
// so error text shown in the UI follows the selected language.

export type Lang = "en" | "zh";

type Table = Record<string, string>;

const EN: Table = {
  "app.name": "WROLP Editor",
  "app.empty": "Open a file with the button above, or pick one from the Explorer sidebar,\nor right-click a file and choose \"Open with WROLP\".",
  "app.loading": "Loading editor…",
  "app.tipMenu": "Tip: add \"Open with WROLP\" to the file context menu from Settings.",
  "app.tipStaleMenu": "The context menu launches a different build. Re-enable it in Settings.",

  "tab.empty": "No open files",
  "tab.settings": "Settings",
  "tab.close": "Close",
  "tab.untitled": "Untitled-{n}",

  "title.toggleSidebar": "Toggle sidebar (Ctrl+B)",
  "title.openFiles": "Open files",
  "title.newFile": "New file (Ctrl+N)",
  "title.open": "Open (Ctrl+O)",
  "title.settings": "Settings",
  "title.minimize": "Minimize",
  "title.maximize": "Maximize",
  "title.menuReveal": "Reveal in Explorer",
  "title.menuCopy": "Copy path",
  "title.menuSidebar": "Show folder in sidebar",
  "title.copied": "Path copied: {path}",
  "title.copyFailed": "Copy failed",

  "side.explorer": "Explorer",
  "side.history": "History",
  "side.openFolder": "Open folder…",
  "side.refresh": "Refresh",
  "side.loading": "Loading…",
  "side.noFolder": "No folder open",
  "side.noHistory": "No recently opened files",
  "side.removeHistory": "Remove from history",
  "side.resizeHint": "Drag to resize, double-click to reset",

  "status.noFile": "No file open",
  "status.saved": "Saved",
  "status.dirty": "● Unsaved",
  "status.cursor": "Ln {line} · Col {column}",

  "menu.saved": "Saved {name}",
  "menu.draftRestored": "Draft restored",
  "menu.draftDiscarded": "Draft discarded",
  "menu.added": "Context menu added: {value}",
  "menu.removed": "Context menu removed",

  "dialog.title": "Unsaved draft found",
  "dialog.body": "\"{name}\" has edits that were never saved (draft updated {time}).",
  "dialog.more": "{count} more file(s) waiting.",
  "dialog.ask": "Restore the edits from the last session?",
  "dialog.restore": "Restore draft",
  "dialog.discard": "Discard and open file",

  "settings.nav": "Settings",
  "settings.catContext": "Context menu",
  "settings.catGeneral": "General",
  "settings.catAbout": "About",
  "settings.contextHeading": "Explorer context menu",
  "settings.contextAdd": "Add to the context menu",
  "settings.contextDesc": "Shows \"Open with WROLP\" when right-clicking a file in Explorer",
  "settings.contextBusy": "Writing to the registry…",
  "settings.contextInstalled": "Installed at HKCU\\Software\\Classes\\*\\shell\\WROLP Editor",
  "settings.contextMissing": "Not installed. Writes to HKCU for the current user, no administrator rights needed.",
  "settings.currentlyLaunches": "Currently launches",
  "settings.warnStale": "That entry points at a different build than the one running now. Switch the box off and on again to repoint it at this executable.",
  "settings.warnDebug": "This is a debug build: it loads the Vite dev server, so the context menu only opens files while `npm run tauri dev` is running.",
  "settings.generalHeading": "General",
  "settings.language": "Language",
  "settings.languageDesc": "Interface language, saved with the other settings",
  "settings.fontSize": "Editor font size",
  "settings.minimap": "Show minimap",
  "settings.persisted": "Changes apply immediately and are stored in <app data>/wrolp/state/settings.json.",
  "settings.aboutHeading": "About WROLP Editor",
  "settings.version": "Version {version}",
  "settings.aboutLine": "A lightweight local text editor built on Tauri v2 + Monaco Editor.",
  "settings.draftLine": "Unsaved edits go to wrolp/drafts/<sha256>.draft and are offered back the next time the same file is opened.",
  "settings.restoreSession": "Reopen tabs from last time",
  "settings.restoreSessionDesc": "Each workspace keeps its own tabs; startup restores the one you left open",

  "ws.chip": "Workspaces",
  "ws.new": "New workspace from folder…",
  "ws.rename": "Rename",
  "ws.renameHint": "Workspace name",
  "ws.clear": "Close workspace (keep it in the list)",
  "ws.remove": "Remove from list",
  "ws.currentTabs": "{n} tabs",
  "ws.noTabs": "no tabs",
  "ws.noWorkspace": "No workspace",
  "ws.switched": "Opened workspace {name}",
  "ws.skipped": "Skipped {n} unavailable file(s) while restoring",
  "ws.created": "New workspace: {name}",
  "ws.removed": "Removed {name} from the list (files and drafts untouched)",
  "ws.cleared": "Workspace {name} closed",
  "ws.moveTitle": "Move tab to workspace",
  "ws.copyTitle": "Copy tab to workspace",
  "ws.moveAllTitle": "Move all tabs to workspace",
  "ws.back": "Back",
  "ws.noOther": "No other workspace yet",
  "ws.moved": "Moved {name} to {ws}",
  "ws.copied": "Copied {name} to {ws}",
  "ws.movedCount": "Moved {n} tabs to {ws}",
  "ws.alreadyThere": "{ws} already has {name} open",

  "draft.summaryTitle": "{n} files have unsaved drafts",
  "draft.summaryDesc": "Drafts are the text that never made it to disk.",
  "draft.restoreAll": "Restore all",
  "draft.discardAll": "Discard all",
  "draft.reviewEach": "Review individually",

  "dialog.allFiles": "All files",

  "err.path_empty": "Empty file path",
  "err.path_unresolvable": "Cannot resolve the file path",
  "err.file_access": "Cannot access the file: {detail}",
  "err.file_not_file": "Not a file",
  "err.file_too_large": "File too large ({detail} MB); this editor does not support it yet",
  "err.file_read": "Read failed: {detail}",
  "err.file_not_utf8": "Only UTF-8 text files are supported",
  "err.file_write": "Write failed: {detail}",
  "err.dir_create": "Cannot create the directory: {detail}",
  "err.dir_read": "Cannot read the directory: {detail}",
  "err.not_a_directory": "Not a directory",
  "err.state_parse": "Cannot read the saved state: {detail}",
  "err.state_read": "Cannot read the saved state: {detail}",
  "err.state_write": "Cannot write the saved state: {detail}",
  "err.draft_read": "Cannot read the draft: {detail}",
  "err.draft_corrupt": "The draft was corrupt and has been discarded: {detail}",
  "err.draft_write": "Cannot write the draft: {detail}",
  "err.draft_replace": "Cannot replace the draft: {detail}",
  "err.draft_delete": "Cannot delete the draft: {detail}",
  "err.menu_windows_only": "The context menu integration is Windows-only",
};

const ZH: Table = {
  "app.name": "WROLP 编辑器",
  "app.empty": "点右上角「打开」选择文件，或从左侧资源管理器里选，\n也可以在文件管理器中右键「用 WROLP 打开」",
  "app.loading": "编辑器加载中…",
  "app.tipMenu": "提示：可在设置里把「用 WROLP 打开」加到右键菜单。",
  "app.tipStaleMenu": "右键菜单指向的是另一个构建，请在设置里重新开关一次。",

  "tab.empty": "没有打开的文件",
  "tab.settings": "设置",
  "tab.close": "关闭",
  "tab.untitled": "未命名-{n}",

  "title.toggleSidebar": "切换侧边栏 (Ctrl+B)",
  "title.openFiles": "已打开的文件",
  "title.newFile": "新建文件 (Ctrl+N)",
  "title.open": "打开 (Ctrl+O)",
  "title.settings": "设置",
  "title.minimize": "最小化",
  "title.maximize": "最大化",
  "title.menuReveal": "在资源管理器中显示",
  "title.menuCopy": "复制路径",
  "title.menuSidebar": "在侧边栏显示所在目录",
  "title.copied": "已复制路径：{path}",
  "title.copyFailed": "复制失败",

  "side.explorer": "资源管理器",
  "side.history": "历史",
  "side.openFolder": "打开文件夹…",
  "side.refresh": "刷新",
  "side.loading": "加载中…",
  "side.noFolder": "尚未打开文件夹",
  "side.noHistory": "暂无打开记录",
  "side.removeHistory": "从历史中移除",
  "side.resizeHint": "拖动调整宽度，双击复位",

  "status.noFile": "未打开文件",
  "status.saved": "已保存",
  "status.dirty": "● 未保存",
  "status.cursor": "第 {line} 行 · 第 {column} 列",

  "menu.saved": "已保存 {name}",
  "menu.draftRestored": "已恢复草稿",
  "menu.draftDiscarded": "已丢弃草稿",
  "menu.added": "已添加右键菜单：{value}",
  "menu.removed": "已移除右键菜单",

  "dialog.title": "发现未保存的草稿",
  "dialog.body": "「{name}」有上次未保存的编辑（草稿更新于 {time}）。",
  "dialog.more": "还有 {count} 个文件待处理。",
  "dialog.ask": "要恢复上次未保存的编辑吗？",
  "dialog.restore": "恢复草稿",
  "dialog.discard": "丢弃并打开原文件",

  "settings.nav": "设置",
  "settings.catContext": "右键菜单",
  "settings.catGeneral": "常规",
  "settings.catAbout": "关于",
  "settings.contextHeading": "资源管理器右键菜单",
  "settings.contextAdd": "添加到右键菜单",
  "settings.contextDesc": "在 Windows 资源管理器右键菜单中显示「用 WROLP 打开」",
  "settings.contextBusy": "正在写入注册表…",
  "settings.contextInstalled": "已安装于 HKCU\\Software\\Classes\\*\\shell\\WROLP Editor",
  "settings.contextMissing": "未安装。写入当前用户注册表 HKCU，无需管理员权限。",
  "settings.currentlyLaunches": "当前启动的是",
  "settings.warnStale": "该项指向的是另一个构建，而不是当前运行的这个。把开关关掉再打开即可重指向本程序。",
  "settings.warnDebug": "这是 debug 构建：它加载 Vite dev server，所以只有 `npm run tauri dev` 在跑时右键菜单才能打开文件。",
  "settings.generalHeading": "常规",
  "settings.language": "界面语言",
  "settings.languageDesc": "界面显示语言，与其他设置一起保存",
  "settings.fontSize": "编辑器字号",
  "settings.minimap": "显示缩略图（minimap）",
  "settings.persisted": "修改立即生效，并写入 <应用数据目录>/wrolp/state/settings.json。",
  "settings.aboutHeading": "关于 WROLP 编辑器",
  "settings.version": "版本 {version}",
  "settings.aboutLine": "基于 Tauri v2 + Monaco Editor 的轻量本地文本编辑器。",
  "settings.draftLine": "未保存的编辑会写入 wrolp/drafts/<sha256>.draft，下次打开同一文件时提示恢复。",
  "settings.restoreSession": "启动时重新打开上次的标签",
  "settings.restoreSessionDesc": "每个工作空间各自记住标签，启动时恢复上次停用的那一个",

  "ws.chip": "工作空间",
  "ws.new": "从文件夹新建工作空间…",
  "ws.rename": "重命名",
  "ws.renameHint": "工作空间名称",
  "ws.clear": "关闭工作空间（仍留在列表里）",
  "ws.remove": "从列表移除",
  "ws.currentTabs": "{n} 个标签",
  "ws.noTabs": "无标签",
  "ws.noWorkspace": "未使用工作空间",
  "ws.switched": "已打开工作空间 {name}",
  "ws.skipped": "恢复时跳过了 {n} 个不可用文件",
  "ws.created": "已新建工作空间：{name}",
  "ws.removed": "已从列表移除 {name}（文件与草稿未动）",
  "ws.cleared": "已关闭工作空间 {name}",
  "ws.moveTitle": "把标签移到工作空间",
  "ws.copyTitle": "把标签复制到工作空间",
  "ws.moveAllTitle": "把所有标签移到工作空间",
  "ws.back": "返回",
  "ws.noOther": "还没有其他工作空间",
  "ws.moved": "已把 {name} 移到 {ws}",
  "ws.copied": "已把 {name} 复制到 {ws}",
  "ws.movedCount": "已把 {n} 个标签移到 {ws}",
  "ws.alreadyThere": "{ws} 已打开 {name}",

  "draft.summaryTitle": "{n} 个文件有未保存的草稿",
  "draft.summaryDesc": "草稿就是没写回磁盘的那部分内容。",
  "draft.restoreAll": "全部恢复",
  "draft.discardAll": "全部丢弃",
  "draft.reviewEach": "逐个查看",

  "dialog.allFiles": "所有文件",

  "err.path_empty": "文件路径为空",
  "err.path_unresolvable": "无法解析文件路径",
  "err.file_access": "无法访问文件：{detail}",
  "err.file_not_file": "目标不是文件",
  "err.file_too_large": "文件过大（{detail} MB），本编辑器暂不支持",
  "err.file_read": "读取失败：{detail}",
  "err.file_not_utf8": "仅支持 UTF-8 文本文件",
  "err.file_write": "写入失败：{detail}",
  "err.dir_create": "创建目录失败：{detail}",
  "err.dir_read": "读取目录失败：{detail}",
  "err.not_a_directory": "目标不是目录",
  "err.state_parse": "读取本地配置失败：{detail}",
  "err.state_read": "读取本地配置失败：{detail}",
  "err.state_write": "写入本地配置失败：{detail}",
  "err.draft_read": "读取草稿失败：{detail}",
  "err.draft_corrupt": "草稿已损坏并已清除：{detail}",
  "err.draft_write": "写入草稿失败：{detail}",
  "err.draft_replace": "替换草稿失败：{detail}",
  "err.draft_delete": "删除草稿失败：{detail}",
  "err.menu_windows_only": "右键菜单集成目前仅支持 Windows",
};

const TABLES: Record<Lang, Table> = { en: EN, zh: ZH };

/**
 * Languages offered in Settings. Labels stay in their own language on purpose, and the
 * value must be a key of TABLES plus a field of the backend's Settings.language.
 */
export const LANGUAGES: { value: Lang; label: string }[] = [
  { value: "en", label: "English" },
  { value: "zh", label: "中文" },
];

let current: Lang = "en";

export function setLang(lang: string): void {
  current = lang in TABLES ? (lang as Lang) : "en";
}

export function getLang(): Lang {
  return current;
}

type Params = Record<string, string | number>;

function fill(template: string, params?: Params): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (whole, key: string) =>
    key in params ? String(params[key]) : whole
  );
}

export function t(key: string, params?: Params): string {
  const table = TABLES[current];
  return fill(table[key] ?? EN[key] ?? key, params);
}

/** Turn a backend error ("code" or "code:detail") into localized text. */
export function translateError(raw: string): string {
  const colon = raw.indexOf(":");
  const code = colon < 0 ? raw : raw.slice(0, colon);
  const detail = colon < 0 ? "" : raw.slice(colon + 1).trim();
  const template = TABLES[current][`err.${code}`] ?? EN[`err.${code}`];
  if (!template) return raw;
  return fill(template, { detail });
}
