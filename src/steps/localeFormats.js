// A small library of common target-file locale-suffix naming conventions.
const LOCALE_FORMATS = [
  {
    id: 1,
    label: "Language only",
    baseSeparator: "_",
    langCase: "lower",
    includeRegion: false,
    example: "app_en.json"
  },
  {
    id: 2,
    label: "Language_REGION (underscore, underscore)",
    baseSeparator: "_",
    langCase: "lower",
    includeRegion: true,
    regionSeparator: "_",
    regionCase: "upper",
    example: "app_en_US.json"
  },
  {
    id: 3,
    label: "Language-REGION (underscore, hyphen)",
    baseSeparator: "_",
    langCase: "lower",
    includeRegion: true,
    regionSeparator: "-",
    regionCase: "upper",
    example: "app_en-US.json"
  },
  {
    id: 4,
    label: "BCP 47 / web standard (dot, hyphen)",
    baseSeparator: ".",
    langCase: "lower",
    includeRegion: true,
    regionSeparator: "-",
    regionCase: "upper",
    example: "app.en-US.json",
    recommended: true,
    note: "The IETF/CLDR/Unicode standard — lang lowercase, region uppercase, hyphen-joined, dot before the locale."
  },
  {
    id: 5,
    label: "Language only, dot separator",
    baseSeparator: ".",
    langCase: "lower",
    includeRegion: false,
    example: "app.en.json"
  },
  {
    id: 6,
    label: "Remove locale suffix entirely (revert to base name)",
    stripOnly: true,
    example: "app.json",
    note: "Strips any recognizable locale tag and leaves the plain base filename — useful for undoing a previous rename or resetting before applying a different format."
  }
];

function buildFileName(basename, ext, lang, region, format) {
  if (format.stripOnly) return `${basename}.${ext}`;
  let localePart = format.langCase === "upper" ? lang.toUpperCase() : lang.toLowerCase();
  if (format.includeRegion && region) {
    const regionPart = format.regionCase === "upper" ? region.toUpperCase() : region.toLowerCase();
    localePart += format.regionSeparator + regionPart;
  }
  return `${basename}${format.baseSeparator}${localePart}.${ext}`;
}

function getFormatById(id) {
  return LOCALE_FORMATS.find((f) => f.id === Number(id));
}

module.exports = { LOCALE_FORMATS, buildFileName, getFormatById };
