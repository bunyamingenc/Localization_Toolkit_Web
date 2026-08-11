const path = require("path");

const ENCODING_MAP = {
  "UTF-8": "UTF-8", "UTF-16 LE": "UTF-16LE", "UTF-16 BE": "UTF-16BE",
  "UTF-32 LE": "UTF-32LE", "UTF-32 BE": "UTF-32BE",
  "ISO-8859-1": "ISO-8859-1", "ISO-8859-15": "ISO-8859-15",
  "Windows-1252": "windows-1252", "Shift_JIS": "Shift_JIS",
  "EUC-JP": "EUC-JP", "unknown": "UTF-8"
};
function toRainbowEncoding(label) { return ENCODING_MAP[label] || "UTF-8"; }

function xmlAttr(str) {
  return (str || "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const FILTER_MAP = {
  ".html": "okf_html", ".htm": "okf_html",
  ".xml": "okf_xml", ".resx": "okf_xml",
  ".xlf": "okf_xliff", ".xliff": "okf_xliff",
  ".json": "okf_json",
  ".properties": "okf_properties",
  ".po": "okf_po",
  ".ts": "okf_ts",
  ".rc": "okf_winres",
  ".txt": "okf_plaintext", ".js": "okf_plaintext"
};

/**
 * Splits error files into three groups, matching the desktop app's Rainbow
 * fileSets: encoding-only, EOL/BOM-only, and both.
 */
function groupFiles(errorFiles) {
  const encodingOnly = [], eolOnly = [], both = [];
  for (const f of errorFiles) {
    const checks = (f.issues || []).map(i => i.check);
    const hasEnc = checks.includes("encoding_mismatch");
    const hasEol = checks.some(c => c === "eol_mismatch" || c === "mixed_line_endings" || c === "bom_mismatch");
    if (hasEnc && hasEol) both.push(f);
    else if (hasEnc) encodingOnly.push(f);
    else eolOnly.push(f);
  }
  return { encodingOnly, eolOnly, both };
}

function fileEntries(files) {
  return files.map(f => {
    const ext = path.extname(f.file).toLowerCase();
    const filter = FILTER_MAP[ext] || "okf_plaintext";
    const rel = f.file.replace(/\\/g, "/");
    return `<fi fs="${filter}" fo="" se="" te="">${xmlAttr(rel)}</fi>`;
  }).join("");
}

/**
 * Builds a Rainbow .rnb v4 project. Since this runs on a server with no
 * local Rainbow installation, localRoot is wherever the USER plans to
 * extract the downloaded output files on their own machine — the .rnb
 * references that path, so it only becomes valid once they've actually
 * extracted the zip there.
 */
function buildRnb(errorFiles, targetEncoding, localRoot, sourceLanguage, targetLanguage) {
  const tgtEnc = toRainbowEncoding(targetEncoding || "UTF-8");
  const root = (localRoot || "C:/LocProject/output").replace(/\\/g, "/").replace(/\/$/, "");
  const outRoot = root + "/rainbow-out";
  const srcLang = (sourceLanguage || "en") + (sourceLanguage && sourceLanguage.includes("-") ? "" : "-US");
  const tgtLang = targetLanguage || "fr-FR";
  const { encodingOnly, eolOnly, both } = groupFiles(errorFiles);

  const set1 = fileEntries(encodingOnly);
  const set2 = fileEntries(eolOnly);
  const set3 = fileEntries(both);

  return `<?xml version="1.0" encoding="UTF-8"?>\r\n<rainbowProject version="4"><fileSet id="1"><root useCustom="1">${xmlAttr(root)}</root>${set1}</fileSet><fileSet id="2"><root useCustom="1">${xmlAttr(root)}</root>${set2}</fileSet><fileSet id="3"><root useCustom="1">${xmlAttr(root)}</root>${set3}</fileSet><output><root use="1">${xmlAttr(outRoot)}</root><subFolder use="0"></subFolder><extension use="1" style="0">.out</extension><replace use="0" oldText="" newText=""></replace><prefix use="0"></prefix><suffix use="0"></suffix></output><options sourceLanguage="${xmlAttr(srcLang)}" sourceEncoding="UTF-8" targetLanguage="${xmlAttr(tgtLang)}" targetEncoding="${xmlAttr(tgtEnc)}"></options><parametersFolder useCustom="1">${xmlAttr(root)}</parametersFolder><utilities xml:spaces="preserve"></utilities></rainbowProject>`;
}

/**
 * @param {Array} errorFiles     the `issues` array from output-qa's result,
 *                                filtered to files that have at least one error
 * @param {string} targetEncoding
 * @param {string} localRoot     where the USER intends to extract the downloaded
 *                                output files on their own machine
 */
async function run(errorFiles, targetEncoding, localRoot, sourceLanguage, targetLanguage) {
  if (!errorFiles || errorFiles.length === 0) {
    return { skipped: true, reason: "no_errors" };
  }

  const groups = groupFiles(errorFiles);
  const rnbContent = buildRnb(errorFiles, targetEncoding, localRoot, sourceLanguage, targetLanguage);

  return {
    rnb_content: rnbContent,
    target_encoding: targetEncoding || "UTF-8",
    local_root: localRoot,
    file_count: errorFiles.length,
    groups: {
      encoding_only: groups.encodingOnly,
      eol_only: groups.eolOnly,
      both: groups.both
    }
  };
}

module.exports = { run };
