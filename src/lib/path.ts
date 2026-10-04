const EXT_LANG: Record<string, string> = {
  txt: "plaintext",
  md: "markdown",
  markdown: "markdown",
  json: "json",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  ts: "typescript",
  tsx: "typescript",
  jsx: "javascript",
  html: "html",
  htm: "html",
  vue: "html",
  css: "css",
  scss: "scss",
  less: "less",
  xml: "xml",
  svg: "xml",
  yaml: "yaml",
  yml: "yaml",
  toml: "ini",
  ini: "ini",
  cfg: "ini",
  conf: "ini",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  bat: "bat",
  ps1: "powershell",
  py: "python",
  rs: "rust",
  go: "go",
  java: "java",
  c: "c",
  h: "c",
  cpp: "cpp",
  cs: "csharp",
  php: "php",
  sql: "sql",
  log: "plaintext",
};

export function basename(path: string): string {
  const idx = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  return idx < 0 ? path : path.slice(idx + 1);
}

export function dirname(path: string): string {
  const idx = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  return idx < 0 ? "." : path.slice(0, idx);
}

export function extOf(name: string): string {
  const base = basename(name);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot + 1).toLowerCase();
}

export function langOf(path: string): string {
  return EXT_LANG[extOf(path)] ?? "plaintext";
}

/** New, never-saved files have no real path; they are marked with this prefix. */
export function isUntitled(path: string): boolean {
  return path.startsWith("untitled://");
}

/** Monaco model URI: one-to-one with the backend-normalized path, so a file reuses its model. */
export function modelUri(path: string): string {
  if (isUntitled(path)) return path;
  const forward = path.replace(/\\/g, "/");
  return /^[a-zA-Z]:\//.test(forward) ? `file:///${forward}` : `file://${forward}`;
}

const ICON_BY_GROUP: Record<string, { cls: string; sym: string }> = {
  sh: { cls: "icon-sh", sym: "$" },
  json: { cls: "icon-json", sym: "{}" },
  list: { cls: "icon-list", sym: "≡" },
  html: { cls: "icon-html", sym: "</>" },
  css: { cls: "icon-css", sym: "#" },
  md: { cls: "icon-md", sym: "M" },
  py: { cls: "icon-py", sym: "Py" },
  file: { cls: "icon-file", sym: "▯" },
};

const EXT_GROUP: Record<string, string> = {
  sh: "sh",
  bash: "sh",
  zsh: "sh",
  bat: "sh",
  ps1: "sh",
  json: "json",
  js: "json",
  mjs: "json",
  cjs: "json",
  jsx: "json",
  ts: "json",
  tsx: "json",
  vue: "json",
  list: "list",
  txt: "list",
  log: "list",
  html: "html",
  htm: "html",
  xml: "html",
  svg: "html",
  css: "css",
  scss: "css",
  less: "css",
  md: "md",
  markdown: "md",
  py: "py",
};

export function tabIcon(name: string): { cls: string; sym: string } {
  const group = EXT_GROUP[extOf(name)] ?? "file";
  return ICON_BY_GROUP[group];
}
