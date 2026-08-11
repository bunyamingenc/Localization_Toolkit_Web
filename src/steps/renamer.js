const fs = require("fs");
const path = require("path");
const { getFormatById, buildFileName } = require("./localeFormats");

const ASSET_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".svg", ".ico", ".webp", ".bmp", ".tiff",
  ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".mp4", ".mp3", ".wav", ".ogg", ".avi", ".mov",
  ".pdf", ".zip", ".tar", ".gz", ".rar",
  ".exe", ".dll", ".so", ".dylib",
  ".sdlxliff", ".xliff", ".xlf"
]);

function escapeRegExp(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

function parseLocale(str) {
  const [lang, region] = str.split(/[-_]/);
  return { lang: lang || str, region: region || null };
}

function localeVariants({ lang, region }) {
  const variants = [];
  if (region) variants.push(`${lang}_${region}`, `${lang}-${region}`, `${lang}${region}`);
  variants.push(lang);
  return variants;
}

function tryStripToken(nameNoExt, variant) {
  const re = new RegExp(`([_.\\-])${escapeRegExp(variant)}(?![a-zA-Z0-9])`, "i");
  const match = nameNoExt.match(re);
  if (!match) return null;
  return nameNoExt.slice(0, match.index) + nameNoExt.slice(match.index + match[0].length);
}

function stripKnownLocaleSuffix(nameNoExt, candidates) {
  for (const c of candidates) {
    for (const variant of localeVariants(c).filter((v) => v.includes("-") || v.includes("_") || (c.region && v === `${c.lang}${c.region}`))) {
      const stripped = tryStripToken(nameNoExt, variant);
      if (stripped !== null) return stripped;
    }
  }
  const langCounts = {};
  for (const c of candidates) langCounts[c.lang] = (langCounts[c.lang] || 0) + 1;
  for (const c of candidates) {
    if (langCounts[c.lang] !== 1) continue;
    const stripped = tryStripToken(nameNoExt, c.lang);
    if (stripped !== null) return stripped;
  }
  return null;
}

function walkFiles(dir, fileList = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, fileList);
    else fileList.push(full);
  }
  return fileList;
}

/**
 * Runs the renamer over a folder containing locale subfolders.
 *
 * @param {string} rootPath      folder containing locale subfolders (en/, tr/, ...)
 * @param {object} options
 *   formatId            (number)  — id from LOCALE_FORMATS
 *   skipAssets          (bool)    — default true
 *   excludeLocales      (string[])— locale folder names to leave untouched
 *   sourceLocale        (string)  — optional, helps strip stale suffixes
 *   locales             (string[])— optional, helps strip stale suffixes
 *   dryRun              (bool)    — true = plan only, false = actually rename on disk
 */
async function run(rootPath, options = {}) {
  if (!rootPath || !fs.existsSync(rootPath)) {
    return { skipped: true, reason: "no_target_folder" };
  }

  const format = getFormatById(options.formatId);
  if (!format) {
    return { skipped: true, reason: "invalid_format" };
  }

  const skipAssets = options.skipAssets !== false;
  const excludedLocales = new Set((options.excludeLocales || []).map((l) => l.toLowerCase()));

  const extraVocab = [];
  if (options.sourceLocale) extraVocab.push(parseLocale(options.sourceLocale));
  for (const loc of options.locales || []) extraVocab.push(parseLocale(loc));

  const subfolders = fs.readdirSync(rootPath, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith(".") && !excludedLocales.has(e.name.toLowerCase()));

  if (subfolders.length === 0) {
    return { skipped: true, reason: "no_locale_folders" };
  }

  const byLocale = {};
  const skippedAssets = [];
  let totalPlanned = 0;

  for (const folder of subfolders) {
    const locale = parseLocale(folder.name);
    const folderPath = path.join(rootPath, folder.name);
    const candidates = [locale, ...extraVocab];

    const entries = [];
    for (const filePath of walkFiles(folderPath)) {
      const ext = path.extname(filePath).toLowerCase();
      if (skipAssets && ASSET_EXTENSIONS.has(ext)) {
        skippedAssets.push(path.relative(rootPath, filePath));
        continue;
      }

      const nameNoExt = path.basename(filePath, path.extname(filePath));
      const stripped = stripKnownLocaleSuffix(nameNoExt, candidates);
      const base = stripped !== null ? stripped : nameNoExt;
      const newFileName = buildFileName(base, ext.slice(1), locale.lang, locale.region, format);

      if (newFileName === path.basename(filePath)) continue;

      entries.push({
        from: path.relative(rootPath, filePath),
        to: path.relative(rootPath, path.join(path.dirname(filePath), newFileName))
      });
    }
    byLocale[folder.name] = entries;
    totalPlanned += entries.length;
  }

  const dryRun = options.dryRun !== false; // default true — safe by default
  const resultBase = {
    root_folder: rootPath,
    format_id: format.id,
    format_label: format.label,
    skip_assets: skipAssets,
    excluded_locales: [...excludedLocales],
    by_locale: byLocale,
    skipped_assets: skippedAssets,
    total_planned: totalPlanned
  };

  if (dryRun) {
    return { dry_run: true, ...resultBase };
  }

  let renamed = 0, errors = [];
  for (const name of Object.keys(byLocale)) {
    for (const entry of byLocale[name]) {
      try {
        fs.renameSync(path.join(rootPath, entry.from), path.join(rootPath, entry.to));
        renamed++;
      } catch (err) {
        errors.push({ file: entry.from, error: err.message });
      }
    }
  }

  return { dry_run: false, ...resultBase, renamed, errors };
}

module.exports = { run };
