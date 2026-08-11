const fs = require("fs");
const path = require("path");

// Translatable resource formats — the actual strings live here
const LOC_EXTENSIONS = new Set([
  ".json", ".xml", ".yaml", ".yml", ".properties", ".po", ".pot",
  ".resx", ".strings", ".xlf", ".xliff", ".csv", ".ini", ".arb"
]);

// Human-readable content — often translatable but not a strict resource format
const CONTENT_EXTENSIONS = new Set([
  ".html", ".htm", ".md", ".markdown", ".txt", ".rtf"
]);

// Known binary/design assets — never translatable directly
const ASSET_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".ico", ".webp", ".bmp", ".tiff", ".svg",
  ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".mp4", ".mp3", ".wav", ".ogg", ".avi", ".mov",
  ".zip", ".tar", ".gz", ".rar", ".exe", ".dll",
  ".pdf", ".db", ".sqlite", ".node"
]);

async function run(folderPath) {
  const files = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      files.push(full);
    }
  })(folderPath);

  const byExtension = {};
  const locFiles = [];
  const contentFiles = [];
  const assetFiles = [];
  const unrecognizedFiles = [];

  for (const filePath of files) {
    const relPath = path.relative(folderPath, filePath).replace(/\\/g, "/");
    const ext = path.extname(filePath).toLowerCase() || "(no extension)";
    byExtension[ext] = (byExtension[ext] || 0) + 1;

    if (LOC_EXTENSIONS.has(ext)) locFiles.push(relPath);
    else if (CONTENT_EXTENSIONS.has(ext)) contentFiles.push(relPath);
    else if (ASSET_EXTENSIONS.has(ext)) assetFiles.push(relPath);
    else unrecognizedFiles.push(relPath);
  }

  return {
    total_files: files.length,
    by_extension: byExtension,
    loc_files: locFiles,
    content_files: contentFiles,
    asset_files: assetFiles,
    unrecognized_files: unrecognizedFiles
  };
}

module.exports = { run };
