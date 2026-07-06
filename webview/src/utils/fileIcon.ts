/**
 * Map a file path to a native VS Code codicon file glyph, or null when no
 * extension can be derived. Shared by tool-call rendering and the all-files
 * diff modal so file rows stay visually consistent.
 */
export function fileIconClass(path: string): string | null {
  const ext = path.split(".").pop()?.toLowerCase();
  if (!ext || ext === path || ext.length > 6) return null;
  const code = new Set([
    "ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs", "py", "go", "rs", "java",
    "kt", "scala", "c", "cc", "cpp", "h", "hpp", "cs", "rb", "php", "swift", "dart",
    "lua", "r", "jl", "ex", "exs", "erl", "clj", "cljs", "hs", "ml", "nim", "v", "zig",
    "sh", "bash", "zsh", "fish", "ps1", "bat", "cmd", "sql", "html", "htm", "vue",
    "svelte", "astro", "graphql", "prisma", "tf", "dockerfile",
  ]);
  const media = new Set([
    "png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "icns", "svg", "avif", "tiff",
    "mp4", "mov", "avi", "webm", "mkv", "mp3", "wav", "ogg", "flac", "aac", "m4a",
  ]);
  const archive = new Set(["zip", "tar", "gz", "tgz", "bz2", "xz", "rar", "7z", "jar", "war"]);
  if (code.has(ext)) return "codicon-file-code";
  if (media.has(ext)) return "codicon-file-media";
  if (archive.has(ext)) return "codicon-file-zip";
  if (ext === "pdf") return "codicon-file-pdf";
  if (ext === "exe" || ext === "dll" || ext === "so" || ext === "dylib" || ext === "bin" || ext === "o" || ext === "class" || ext === "wasm") return "codicon-file-binary";
  if (new Set(["md", "mdx", "txt", "json", "jsonc", "yml", "yaml", "toml", "xml", "csv", "tsv", "ini", "env", "log"]).has(ext)) return "codicon-file-text";
  return "codicon-file";
}
