const fs = require("fs");
const path = require("path");
const chardet = require("chardet");

const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".ico", ".webp", ".bmp", ".tiff",
  ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".mp4", ".mp3", ".wav", ".ogg", ".avi", ".mov",
  ".zip", ".tar", ".gz", ".rar", ".exe", ".dll",
  ".pdf", ".db", ".sqlite", ".node"
]);

const BOMS = [
  { label: "UTF-32-BE", bytes: [0x00, 0x00, 0xfe, 0xff] },
  { label: "UTF-32-LE", bytes: [0xff, 0xfe, 0x00, 0x00] },
  { label: "UTF-8", bytes: [0xef, 0xbb, 0xbf] },
  { label: "UTF-16-BE", bytes: [0xfe, 0xff] },
  { label: "UTF-16-LE", bytes: [0xff, 0xfe] },
];

function detectBom(buffer) {
  for (const { label, bytes } of BOMS) {
    if (buffer.length >= bytes.length && bytes.every((b, i) => buffer[i] === b)) return label;
  }
  return null;
}

function detectEolFromText(text) {
  let crlf = 0, lf = 0, cr = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\r") { if (text[i + 1] === "\n") { crlf++; i++; } else cr++; }
    else if (text[i] === "\n") lf++;
  }
  const styles = [crlf > 0, lf > 0, cr > 0].filter(Boolean).length;
  if (styles > 1) return "mixed";
  if (crlf > 0) return "CRLF";
  if (lf > 0) return "LF";
  if (cr > 0) return "CR";
  return "none";
}

/** Same UTF-8-vs-ISO-8859-1 fix from the desktop app. */
function detectFile(filePath) {
  const buffer = fs.readFileSync(filePath);
  const bom = detectBom(buffer);
  const chardetResult = chardet.detect(buffer) || "unknown";
  const norm = chardetResult.toLowerCase().replace(/[^a-z0-9]/g, "");
  const isSingleByte = ["iso88591", "iso885915", "windows1252", "ascii"].includes(norm);

  let encoding = chardetResult;
  if (!bom && isSingleByte) {
    try { if (!buffer.toString("utf8").includes("\uFFFD")) encoding = "UTF-8"; } catch {}
  }

  const text = buffer.toString("utf-8");
  return { encoding, bom, eol: detectEolFromText(text) };
}

/**
 * Runs encoding QA over a folder. Same signature shape as the desktop
 * version — just takes a plain folder path, which in this API is a
 * scratch directory populated from the uploaded zip, not a user's Desktop.
 */
async function run(folderPath) {
  const files = [];
  let skippedBinary = 0;
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      const ext = path.extname(full).toLowerCase();
      if (BINARY_EXTENSIONS.has(ext)) { skippedBinary++; continue; }
      files.push(full);
    }
  })(folderPath);

  const results = files.map((f) => ({
    file: path.relative(folderPath, f),
    ...detectFile(f),
  }));

  const byExtension = {};
  for (const r of results) {
    const ext = path.extname(r.file).toLowerCase() || "(none)";
    if (!byExtension[ext]) byExtension[ext] = { count: 0, encodings: {}, eols: {} };
    byExtension[ext].count++;
    byExtension[ext].encodings[r.encoding] = (byExtension[ext].encodings[r.encoding] || 0) + 1;
    byExtension[ext].eols[r.eol] = (byExtension[ext].eols[r.eol] || 0) + 1;
  }

  return { file_count: results.length, skipped_binary: skippedBinary, files: results, by_extension: byExtension };
}

module.exports = { run, detectFile };
