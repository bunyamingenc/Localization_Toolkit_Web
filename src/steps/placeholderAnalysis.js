const fs = require("fs");
const path = require("path");

const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".ico", ".webp", ".bmp", ".tiff",
  ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".mp4", ".mp3", ".wav", ".ogg", ".avi", ".mov",
  ".zip", ".tar", ".gz", ".rar", ".exe", ".dll",
  ".pdf", ".db", ".sqlite", ".node"
]);

const PLACEHOLDER_PATTERNS = [
  {
    id: "printf_positional",
    label: "Printf positional (%1, %2, %1$s …)",
    regex: /%\d+(\$[a-zA-Z])?/g,
    trados: "%\\d+(\\$[a-zA-Z])?",
    description: "Numbered printf arguments common in Android strings, PHP, and older i18n libs."
  },
  {
    id: "printf_typed",
    label: "Printf typed (%s, %d, %f, %02d …)",
    regex: /%(?:\d+\$)?[-+ #0]*\d*(?:\.\d+)?[bcdeEfFgGiosuxX%]/g,
    trados: "%(?:\\d+\\$)?[-+ #0]*\\d*(?:\\.\\d+)?[bcdeEfFgGiosuxX%]",
    description: "C-style format specifiers — %s, %d, %02d, %.2f, etc."
  },
  {
    id: "curly_named",
    label: "Named placeholders ({name}, {count} …)",
    regex: /\{[a-zA-Z_][a-zA-Z0-9_]*\}/g,
    trados: "\\{[a-zA-Z_][a-zA-Z0-9_]*\\}",
    description: "Python .format(), ICU simple, Django, many JS libs."
  },
  {
    id: "curly_indexed",
    label: "Indexed placeholders ({0}, {1} …)",
    regex: /\{\d+\}/g,
    trados: "\\{\\d+\\}",
    description: ".NET String.Format and similar."
  },
  {
    id: "curly_icu",
    label: "ICU MessageFormat ({count, plural, …})",
    regex: /\{[a-zA-Z_][a-zA-Z0-9_]*,\s*(plural|select|selectordinal|number|date|time)[^}]*\}/g,
    trados: "\\{[a-zA-Z_][a-zA-Z0-9_]*,\\s*(plural|select|selectordinal|number|date|time)[^}]*\\}",
    description: "Full ICU plural/select blocks — Trados should lock the whole construct."
  },
  {
    id: "double_curly",
    label: "Mustache / Angular ({{variable}})",
    regex: /\{\{[^}]+\}\}/g,
    trados: "\\{\\{[^}]+\\}\\}",
    description: "Handlebars, Mustache, Angular interpolation."
  },
  {
    id: "dollar_brace",
    label: "Template literals (${expr})",
    regex: /\$\{[^}]+\}/g,
    trados: "\\$\\{[^}]+\\}",
    description: "JavaScript template literals and some shell strings."
  },
  {
    id: "dollar_var",
    label: "Dollar variables ($variable, $1)",
    regex: /\$[a-zA-Z_]\w*|\$\d+/g,
    trados: "\\$[a-zA-Z_]\\w*|\\$\\d+",
    description: "PHP variables, shell variables, Ruby interpolation."
  },
  {
    id: "hash_brace",
    label: "Hash placeholder (#{var})",
    regex: /#\{[^}]+\}/g,
    trados: "#\\{[^}]+\\}",
    description: "Ruby string interpolation."
  },
  {
    id: "html_tags",
    label: "Inline HTML tags (<b>, <br/>, <span …>)",
    regex: /<\/?(b|i|u|em|strong|span|br|a|img|abbr|cite|code|kbd|mark|s|small|sub|sup|var|wbr)(\s[^>]*)?\/?>/gi,
    trados: "<\\/?(b|i|u|em|strong|span|br|a|img|abbr|cite|code|kbd|mark|s|small|sub|sup|var|wbr)(\\s[^>]*)?\\/>",
    description: "Inline markup that should be kept as tags in Trados, not translated."
  },
  {
    id: "xml_entity",
    label: "XML / HTML entities (&amp;, &#160;)",
    regex: /&[a-zA-Z][a-zA-Z0-9]*;|&#\d+;|&#x[0-9a-fA-F]+;/g,
    trados: "&[a-zA-Z][a-zA-Z0-9]*;|&#\\d+;|&#x[0-9a-fA-F]+;",
    description: "Character references — should be locked, not transliterated."
  },
  {
    id: "angle_placeholder",
    label: "Angle-bracket placeholders (<FIRST_NAME>)",
    regex: /<[A-Z][A-Z0-9_]+>/g,
    trados: "<[A-Z][A-Z0-9_]+>",
    description: "Screaming-snake-case tokens in angle brackets."
  },
  {
    id: "square_bracket",
    label: "Square-bracket placeholders ([NAME], [0])",
    regex: /\[[A-Z][A-Z0-9_]*\]|\[\d+\]/g,
    trados: "\\[[A-Z][A-Z0-9_]*\\]|\\[\\d+\\]",
    description: "Old-style substitution tokens found in some CMS exports."
  },
  {
    id: "url",
    label: "URLs (https://…)",
    regex: /https?:\/\/[^\s"'<>)]+/g,
    trados: "https?:\\/\\/[^\\s\"'<>)]+",
    description: "Absolute URLs that must not be translated."
  },
];

function analyzeText(text, ext) {
  const results = [];
  for (const pat of PLACEHOLDER_PATTERNS) {
    if (pat.id === "html_tags" && ![".html", ".htm", ".xml", ".resx", ".xliff", ".xlf"].includes(ext)) continue;

    const rx = new RegExp(pat.regex.source, "g");
    const matches = [];
    const seen = new Set();
    let m;
    while ((m = rx.exec(text)) !== null) {
      if (!seen.has(m[0])) {
        seen.add(m[0]);
        matches.push(m[0]);
        if (seen.size >= 30) break;
      }
      if (m.index === rx.lastIndex) rx.lastIndex++;
    }
    if (matches.length > 0) {
      results.push({ patternId: pat.id, label: pat.label, trados: pat.trados, description: pat.description, matches });
    }
  }
  return results;
}

async function run(folderPath) {
  const files = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || entry.name === "project.yaml") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      const ext = path.extname(full).toLowerCase();
      if (BINARY_EXTENSIONS.has(ext)) continue;
      files.push(full);
    }
  })(folderPath);

  const byExt = {};

  for (const filePath of files) {
    const ext = path.extname(filePath).toLowerCase();
    let text;
    try { text = fs.readFileSync(filePath, "utf8"); } catch { continue; }

    const relPath = path.relative(folderPath, filePath).replace(/\\/g, "/");
    const hits = analyzeText(text, ext);

    for (const hit of hits) {
      if (!byExt[ext]) byExt[ext] = {};
      if (!byExt[ext][hit.patternId]) {
        byExt[ext][hit.patternId] = {
          patternId: hit.patternId, label: hit.label, trados: hit.trados,
          description: hit.description, count: 0, files: [], examples: []
        };
      }
      const entry = byExt[ext][hit.patternId];
      entry.count += hit.matches.length;
      if (!entry.files.includes(relPath)) entry.files.push(relPath);
      for (const val of hit.matches) {
        if (entry.examples.length < 30 && !entry.examples.includes(val)) entry.examples.push(val);
      }
    }
  }

  const totalPatterns = Object.values(byExt).reduce((s, p) => s + Object.keys(p).length, 0);

  return {
    files_scanned: files.length,
    total_patterns: totalPatterns,
    by_extension: byExt
  };
}

module.exports = { run, PLACEHOLDER_PATTERNS, BINARY_EXTENSIONS };
