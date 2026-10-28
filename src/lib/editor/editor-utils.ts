/**
 * File-to-editor mapping for Monaco: language ids, preview kinds and binary
 * detection, by file name. Pure functions, no React or I/O. The extension
 * sets for media and binary come from mime.ts, the one map both backends and
 * the viewer share.
 */

import { BINARY_EXTENSIONS, extensionOf, IMAGE_EXTENSIONS } from "@/lib/files/mime";

/** File extension → Monaco language id. Unknown → "" (plaintext). */
const EXT_LANG: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  jsonc: "json",
  md: "markdown",
  mdx: "markdown",
  css: "css",
  scss: "scss",
  less: "less",
  html: "html",
  htm: "html",
  vue: "html",
  svelte: "html",
  py: "python",
  rs: "rust",
  go: "go",
  java: "java",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  cs: "csharp",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  yml: "yaml",
  yaml: "yaml",
  toml: "toml",
  ini: "ini",
  xml: "xml",
  svg: "xml",
  sql: "sql",
  php: "php",
  rb: "ruby",
  swift: "swift",
  kt: "kotlin",
  dart: "dart",
  dockerfile: "dockerfile",
  lua: "lua",
};

/** The extension of a file name, lowercased and without the dot. */
function extOf(name: string): string {
  return extensionOf(basenameOf(name)).slice(1);
}

/**
 * Extensions with no text form: the media mime.ts calls image or binary,
 * minus SVG. SVG is XML and stays editable, so it is dropped here even though
 * it is in IMAGE_EXTENSIONS.
 */
const BINARY_EXT = new Set<string>([...IMAGE_EXTENSIONS, ...BINARY_EXTENSIONS]);
BINARY_EXT.delete(".svg");

/** The video containers a browser can actually play in a <video> tag. */
const VIDEO_EXT = new Set([".mp4", ".m4v", ".webm", ".ogv", ".mov"]);

/** Monaco language id for a path. Unknown → "" (plaintext). */
export function languageFromPath(path: string): string {
  const ext = extOf(path);
  if (basenameOf(path).toLowerCase() === "dockerfile") return "dockerfile";
  return EXT_LANG[ext] ?? "";
}

/** What a rendered preview can show for a file (null = nothing). */
export type PreviewKind = "image" | "video" | "markdown" | "html";

/** Text files with a useful rendered form. SVG stays source-only on purpose. */
const PREVIEW_EXT: Record<string, PreviewKind> = {
  md: "markdown",
  mdx: "markdown",
  markdown: "markdown",
  html: "html",
  htm: "html",
};

/** Preview kind for a path. Media counts: it has no code view at all. */
export function previewKindFromPath(path: string): PreviewKind | null {
  const ext = `.${extOf(path)}`;
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  if (VIDEO_EXT.has(ext)) return "video";
  return PREVIEW_EXT[extOf(path)] ?? null;
}

/** True for files the editor cannot show as text. */
export function isBinaryFile(path: string): boolean {
  return BINARY_EXT.has(`.${extOf(path)}`);
}

/** Basename of a path. */
export function basenameOf(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}
