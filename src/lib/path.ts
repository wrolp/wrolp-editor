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

/** A file-type glyph: the character to draw plus the class that colours it. */
export interface FileGlyph {
  cls: string;
  sym: string;
}

/**
 * One entry per type family, not per extension: extensions map to a family in
 * `EXT_GLYPH`, and the family owns the colour. Adding a type is therefore two
 * edits (family + extensions) rather than one per extension.
 *
 * Glyphs are one or two characters on purpose — they sit in a 16px box right
 * next to the file name, so a word would crowd it. Colour carries most of the
 * meaning; the character only has to break ties inside a family.
 */
const GLYPHS: Record<string, FileGlyph> = {
  file: { cls: "icon-file", sym: "▯" },

  // Prose and documents
  text: { cls: "icon-text", sym: "≡" },
  markdown: { cls: "icon-md", sym: "M" },
  doc: { cls: "icon-doc", sym: "W" },
  sheet: { cls: "icon-sheet", sym: "X" },
  slides: { cls: "icon-slides", sym: "◫" },
  pdf: { cls: "icon-pdf", sym: "▤" },
  license: { cls: "icon-license", sym: "©" },

  // Markup and styles
  html: { cls: "icon-html", sym: "</>" },
  css: { cls: "icon-css", sym: "#" },
  scss: { cls: "icon-scss", sym: "#" },
  xml: { cls: "icon-xml", sym: "</>" },
  svg: { cls: "icon-svg", sym: "◇" },
  vue: { cls: "icon-vue", sym: "V" },
  svelte: { cls: "icon-svelte", sym: "Sv" },

  // Structured data and config
  json: { cls: "icon-json", sym: "{}" },
  yaml: { cls: "icon-yaml", sym: "Y" },
  toml: { cls: "icon-toml", sym: "T" },
  ini: { cls: "icon-ini", sym: "≡" },
  sql: { cls: "icon-sql", sym: "DB" },

  // Shells
  shell: { cls: "icon-sh", sym: "$" },
  batch: { cls: "icon-batch", sym: "%" },
  powershell: { cls: "icon-ps", sym: "»" },

  // Code
  ts: { cls: "icon-ts", sym: "TS" },
  js: { cls: "icon-js", sym: "JS" },
  py: { cls: "icon-py", sym: "Py" },
  rs: { cls: "icon-rs", sym: "rs" },
  go: { cls: "icon-go", sym: "Go" },
  java: { cls: "icon-java", sym: "J" },
  kt: { cls: "icon-kt", sym: "Kt" },
  swift: { cls: "icon-swift", sym: "Sw" },
  c: { cls: "icon-c", sym: "C" },
  cpp: { cls: "icon-cpp", sym: "C+" },
  cs: { cls: "icon-cs", sym: "C#" },
  php: { cls: "icon-php", sym: "P" },
  rb: { cls: "icon-rb", sym: "Rb" },
  pl: { cls: "icon-pl", sym: "Pl" },
  lua: { cls: "icon-lua", sym: "Lu" },
  r: { cls: "icon-r", sym: "R" },

  // Assets and binaries
  image: { cls: "icon-image", sym: "▣" },
  font: { cls: "icon-font", sym: "F" },
  audio: { cls: "icon-audio", sym: "♪" },
  video: { cls: "icon-video", sym: "▶" },
  archive: { cls: "icon-archive", sym: "▦" },
  binary: { cls: "icon-binary", sym: "◆" },

  // Project files that carry no extension
  docker: { cls: "icon-docker", sym: "D" },
  git: { cls: "icon-git", sym: "G" },
  env: { cls: "icon-env", sym: "E" },
};

const EXT_GLYPH: Record<string, string> = {
  // Prose and documents
  txt: "text",
  text: "text",
  log: "text",
  nfo: "text",
  me: "text",
  md: "markdown",
  markdown: "markdown",
  mdown: "markdown",
  mkd: "markdown",
  mdx: "markdown",
  pdf: "pdf",
  doc: "doc",
  docx: "doc",
  dot: "doc",
  odt: "doc",
  rtf: "doc",
  xls: "sheet",
  xlsx: "sheet",
  xlsm: "sheet",
  ods: "sheet",
  csv: "sheet",
  tsv: "sheet",
  ppt: "slides",
  pptx: "slides",
  odp: "slides",

  // Markup and styles
  html: "html",
  htm: "html",
  xhtml: "html",
  css: "css",
  scss: "scss",
  sass: "scss",
  less: "scss",
  xml: "xml",
  xsd: "xml",
  dtd: "xml",
  svg: "svg",
  vue: "vue",
  svelte: "svelte",

  // Structured data and config
  json: "json",
  jsonc: "json",
  json5: "json",
  webmanifest: "json",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  ini: "ini",
  cfg: "ini",
  conf: "ini",
  config: "ini",
  properties: "ini",
  sql: "sql",
  db: "sql",
  sqlite: "sql",
  sqlite3: "sql",
  mdb: "sql",

  // Shells
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  fish: "shell",
  ksh: "shell",
  bat: "batch",
  cmd: "batch",
  ps1: "powershell",
  psm1: "powershell",
  psd1: "powershell",

  // Code
  ts: "ts",
  mts: "ts",
  cts: "ts",
  tsx: "ts",
  js: "js",
  mjs: "js",
  cjs: "js",
  jsx: "js",
  py: "py",
  pyw: "py",
  pyi: "py",
  rs: "rs",
  go: "go",
  java: "java",
  class: "java",
  jar: "java",
  kt: "kt",
  kts: "kt",
  swift: "swift",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  hxx: "cpp",
  cs: "cs",
  php: "php",
  rb: "rb",
  gemspec: "rb",
  pl: "pl",
  pm: "pl",
  lua: "lua",
  r: "r",
  rmd: "r",

  // Assets and binaries
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  bmp: "image",
  ico: "image",
  avif: "image",
  tif: "image",
  tiff: "image",
  heic: "image",
  ttf: "font",
  otf: "font",
  woff: "font",
  woff2: "font",
  eot: "font",
  mp3: "audio",
  wav: "audio",
  flac: "audio",
  m4a: "audio",
  aac: "audio",
  ogg: "audio",
  mp4: "video",
  mkv: "video",
  mov: "video",
  avi: "video",
  webm: "video",
  flv: "video",
  zip: "archive",
  rar: "archive",
  "7z": "archive",
  tar: "archive",
  gz: "archive",
  bz2: "archive",
  xz: "archive",
  tgz: "archive",
  exe: "binary",
  dll: "binary",
  bin: "binary",
  so: "binary",
  dylib: "binary",
  obj: "binary",
};

/** Extension-less files that still deserve a known face. Keyed by full name. */
const NAME_GLYPH: Record<string, string> = {
  dockerfile: "docker",
  containerfile: "docker",
  ".gitignore": "git",
  ".gitattributes": "git",
  ".gitmodules": "git",
  ".env": "env",
  license: "license",
  licence: "license",
  copying: "license",
  notice: "license",
};

/** The glyph for a file name, chosen by exact name first, then by extension. */
export function fileIcon(name: string): FileGlyph {
  const byName = NAME_GLYPH[basename(name).toLowerCase()];
  const group = byName ?? EXT_GLYPH[extOf(name)] ?? "file";
  return GLYPHS[group];
}

/** Extensions the preview treats as markdown. */
const MARKDOWN_EXT = new Set(["md", "markdown", "mdown", "mkd"]);

/** True when a path looks like markdown, which is what the preview is for. */
export function isMarkdown(path: string): boolean {
  return MARKDOWN_EXT.has(extOf(path).toLowerCase());
}
