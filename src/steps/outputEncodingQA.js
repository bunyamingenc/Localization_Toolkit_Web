const fs = require("fs");
const path = require("path");
const { detectFile } = require("./encodingQA");

const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".ico", ".webp", ".bmp", ".tiff",
  ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".mp4", ".mp3", ".wav", ".ogg", ".avi", ".mov",
  ".zip", ".tar", ".gz", ".rar", ".exe", ".dll",
  ".pdf", ".db", ".sqlite", ".node"
]);

function stripLocaleSuffix(nameNoExt) {
  return nameNoExt.replace(/[._-]([a-z]{2,3}([_-][a-zA-Z]{2,4})?)$/i, "");
}

function buildSourceFileMap(sourceFolder) {
  const map = {};
  if (!sourceFolder || !fs.existsSync(sourceFolder)) return map;
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        const ext = path.extname(full).toLowerCase();
        if (BINARY_EXTENSIONS.has(ext)) continue;
        try {
          const detected = detectFile(full);
          map[path.relative(sourceFolder, full).toLowerCase().replace(/\\/g, "/")] = detected;
        } catch { /* unreadable — skip */ }
      }
    }
  })(sourceFolder);
  return map;
}

function findSourceMatch(outputRel, sourceMap) {
  outputRel = outputRel.replace(/\\/g, "/");

  const variants = [outputRel];
  const firstSlash = outputRel.indexOf("/");
  if (firstSlash !== -1) variants.push(outputRel.substring(firstSlash + 1));

  for (const rel of variants) {
    const dir = rel.includes("/") ? rel.substring(0, rel.lastIndexOf("/")) : ".";
    const ext = path.extname(rel);
    const nameNoExt = path.basename(rel, ext);
    const strippedBase = stripLocaleSuffix(nameNoExt);

    const candidates = [];
    if (strippedBase !== nameNoExt) {
      candidates.push((dir === "." ? "" : dir + "/") + strippedBase + ext);
    }
    candidates.push((dir === "." ? "" : dir + "/") + nameNoExt + ext);

    for (const candidate of candidates) {
      const key = candidate.toLowerCase();
      if (sourceMap[key]) return { sourceKey: candidate, sourceInfo: sourceMap[key] };
    }
  }
  return null;
}

const ASCII_COMPATIBLE = new Set(["ascii", "utf8", "iso88591", "windows1252", "iso885915"]);

function normaliseEncoding(label) {
  return (label || "unknown").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function compareDetected(output, source) {
  const issues = [];

  const outEnc = normaliseEncoding(output.encoding);
  const srcEnc = normaliseEncoding(source.encoding);
  const bothAsciiCompatible = ASCII_COMPATIBLE.has(outEnc) && ASCII_COMPATIBLE.has(srcEnc);

  if (outEnc !== srcEnc && !bothAsciiCompatible) {
    const srcLabel = ASCII_COMPATIBLE.has(srcEnc) ? `${source.encoding} (ASCII-compatible)` : source.encoding;
    issues.push({ severity: "error", check: "encoding_mismatch", detail: `Output is ${output.encoding}, source is ${srcLabel}` });
  }

  if (output.eol === "mixed") {
    issues.push({ severity: "error", check: "mixed_line_endings", detail: "File contains more than one line-ending style" });
  } else if (output.eol !== "none" && output.eol !== source.eol) {
    issues.push({ severity: "error", check: "eol_mismatch", detail: `Output is ${output.eol}, source is ${source.eol}` });
  }

  const outBom = output.bom ?? null;
  const srcBom = source.bom ?? null;
  if (outBom !== srcBom) {
    issues.push({ severity: "error", check: "bom_mismatch", detail: `Output BOM: "${outBom ?? "none"}", source BOM: "${srcBom ?? "none"}"` });
  }

  return issues;
}

/**
 * @param {string} outputFolder  folder containing the files to check
 * @param {string|null} sourceFolder  folder containing the source baseline (optional)
 */
async function run(outputFolder, sourceFolder) {
  if (!outputFolder || !fs.existsSync(outputFolder)) {
    return { skipped: true, reason: "no_output_folder" };
  }

  const sourceMap = buildSourceFileMap(sourceFolder);
  const hasPerFileComparison = Object.keys(sourceMap).length > 0;

  const files = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else files.push(full);
    }
  })(outputFolder);

  let errorCount = 0, warningCount = 0;
  const issues = [];
  const clean = [];
  let skippedBinary = 0, noSourceMatch = 0;

  for (const filePath of files) {
    const ext = path.extname(filePath).toLowerCase();
    if (BINARY_EXTENSIONS.has(ext)) { skippedBinary++; continue; }

    let detected;
    try { detected = detectFile(filePath); }
    catch (err) {
      issues.push({ file: path.relative(outputFolder, filePath), issues: [{ severity: "error", check: "read_failed", detail: err.message }] });
      errorCount++;
      continue;
    }

    const outputRel = path.relative(outputFolder, filePath).replace(/\\/g, "/");
    const fileIssues = [];
    let comparedTo = null;
    let sourceEncoding = null, sourceEol = null, sourceBom = null;

    if (hasPerFileComparison) {
      const match = findSourceMatch(outputRel, sourceMap);
      if (match) {
        comparedTo = match.sourceKey;
        sourceEncoding = match.sourceInfo.encoding;
        sourceEol = match.sourceInfo.eol;
        sourceBom = match.sourceInfo.bom ?? null;
        fileIssues.push(...compareDetected(detected, match.sourceInfo));
      } else {
        noSourceMatch++;
        if (detected.eol === "mixed") {
          fileIssues.push({ severity: "error", check: "mixed_line_endings", detail: "File contains more than one line-ending style" });
        }
      }
    } else {
      if (detected.eol === "mixed") {
        fileIssues.push({ severity: "error", check: "mixed_line_endings", detail: "File contains more than one line-ending style" });
      }
    }

    for (const invisible of (detected.invisibles || [])) {
      fileIssues.push({ severity: "warning", check: invisible, detail: `Found ${invisible.replace(/_/g, " ")}` });
    }

    if (fileIssues.length > 0) {
      errorCount += fileIssues.filter((i) => i.severity === "error").length;
      warningCount += fileIssues.filter((i) => i.severity === "warning").length;
      issues.push({
        file: outputRel, encoding: detected.encoding, eol: detected.eol, bom: detected.bom ?? null,
        comparedTo, sourceEncoding, sourceEol, sourceBom, issues: fileIssues
      });
    } else {
      clean.push({ encoding: detected.encoding, eol: detected.eol, file: outputRel });
    }
  }

  const totalScanned = issues.length + clean.length;
  const passed = errorCount === 0;

  return {
    output_folder: outputFolder,
    source_folder: sourceFolder || null,
    comparison_mode: hasPerFileComparison ? "per_file" : "structural_only",
    files_scanned: totalScanned,
    skipped_binary: skippedBinary,
    no_source_match: noSourceMatch,
    errors: errorCount,
    warnings: warningCount,
    passed,
    issues,
    clean,
    clean_count: clean.length
  };
}

module.exports = { run };
