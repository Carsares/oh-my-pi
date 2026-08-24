#!/usr/bin/env node
/**
 * Migrates safe, user-facing wording to Picot's i18n layer.
 *
 * Default mode is a dry run. Pass --write to update files and locale JSON.
 *
 * What this script migrates automatically:
 * - HTML attributes: placeholder/title/aria-label/alt -> data-i18n-* attributes
 * - Simple HTML text-only elements -> data-i18n attributes
 * - Simple JS DOM assignments, e.g. el.textContent = "Retry" -> t("actions.retry")
 * - Simple JS setAttribute("aria-label", "...") -> setAttribute("aria-label", t("..."))
 *
 * It intentionally skips template literals, concatenation, tests, generated files,
 * vendor files, and strings that look like selectors, URLs, paths, MIME types,
 * commands, storage keys, CSS classes, or protocol values.
 */

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const PUBLIC_DIR = path.join(ROOT, "public");
const EN_LOCALE = path.join(PUBLIC_DIR, "locales", "en.json");
const ZH_LOCALE = path.join(PUBLIC_DIR, "locales", "zh.json");

const args = new Set(process.argv.slice(2));
const WRITE = args.has("--write");
const VERBOSE = args.has("--verbose") || args.has("-v");

const HTML_ATTRIBUTE_TARGETS = new Map([
  ["placeholder", "data-i18n-ph"],
  ["title", "data-i18n-title"],
  ["aria-label", "data-i18n-aria-label"],
  ["alt", "data-i18n-alt"],
]);

const JS_PROPERTY_TARGETS = new Set(["textContent", "title", "placeholder"]);
const JS_ATTRIBUTE_TARGETS = new Set(["aria-label", "title", "placeholder", "alt"]);
const HTML_TEXT_TAG_BLOCKLIST = new Set([
  "script",
  "style",
  "svg",
  "path",
  "line",
  "circle",
  "polyline",
  "polygon",
  "rect",
  "meta",
  "link",
  "base",
  "html",
  "body",
]);
const TEXT_SKIPLIST = new Set(["Picot", "Pi", "Esc", "⌘K", "⌘N"]);

const localeEn = readJson(EN_LOCALE);
const localeZh = readJson(ZH_LOCALE);
const existingEnglishToKey = buildUniqueValueIndex(localeEn);
const existingEnglishToZh = buildEnglishToTranslationIndex(localeEn, localeZh);
const pendingKeys = new Set(flattenKeys(localeEn));
const stats = {
  htmlAttributes: 0,
  htmlText: 0,
  jsAssignments: 0,
  jsImports: 0,
  newKeys: 0,
  zhFallbacks: [],
  changedFiles: new Set(),
};

main();

function main() {
  const htmlFiles = walk(PUBLIC_DIR, (file) => file.endsWith(".html"));
  const jsFiles = walk(PUBLIC_DIR, (file) => file.endsWith(".js") && shouldVisitJs(file));

  for (const file of htmlFiles) migrateHtmlFile(file);
  for (const file of jsFiles) migrateJsFile(file);

  if (stats.newKeys > 0) {
    writeIfChanged(EN_LOCALE, `${JSON.stringify(localeEn, null, 2)}\n`);
    writeIfChanged(ZH_LOCALE, `${JSON.stringify(localeZh, null, 2)}\n`);
  }

  printSummary();
}

function migrateHtmlFile(file) {
  const original = fs.readFileSync(file, "utf8");
  let next = migrateHtmlAttributes(original, file);
  next = migrateHtmlTextNodes(next, file);
  writeIfChanged(file, next);
}

function migrateHtmlAttributes(content, file) {
  return content.replace(/<([A-Za-z][\w:-]*)([^<>]*?)>/g, (full, tag, attrs) => {
    if (full.startsWith("</") || full.startsWith("<!")) return full;
    if (HTML_TEXT_TAG_BLOCKLIST.has(tag.toLowerCase())) return full;

    let nextAttrs = attrs;
    let changed = false;
    for (const [attr, dataAttr] of HTML_ATTRIBUTE_TARGETS) {
      if (hasAttribute(nextAttrs, dataAttr)) continue;
      const value = getAttributeValue(nextAttrs, attr);
      if (!isMigratableText(value)) continue;

      const key = keyForText(value, file, attr);
      nextAttrs = addAttributeAfter(nextAttrs, attr, `${dataAttr}="${escapeAttribute(key)}"`);
      stats.htmlAttributes += 1;
      changed = true;
    }

    return changed ? `<${tag}${nextAttrs}>` : full;
  });
}

function migrateHtmlTextNodes(content, file) {
  return content.replace(
    /<([A-Za-z][\w:-]*)([^<>]*?)>([^<>]*?[A-Za-z][^<>]*?)<\/\1>/g,
    (full, tag, attrs, text) => {
      if (HTML_TEXT_TAG_BLOCKLIST.has(tag.toLowerCase())) return full;
      if (hasAttribute(attrs, "data-i18n")) return full;
      if (!isMigratableText(decodeHtml(text))) return full;
      if (text.trim() !== decodeHtml(text).trim()) return full;

      const key = keyForText(decodeHtml(text), file, "text");
      stats.htmlText += 1;
      return `<${tag}${attrs} data-i18n="${escapeAttribute(key)}">${text}</${tag}>`;
    },
  );
}

function migrateJsFile(file) {
  const original = fs.readFileSync(file, "utf8");
  let next = original;
  let needsTImport = false;

  next = next.replace(
    /(?<![\w$])(\w+(?:\.[\w$]+)?)\.(textContent|title|placeholder)\s*=\s*(["'])([^"'\\]*(?:\\.[^"'\\]*)*)\3/g,
    (full, receiver, property, _quote, rawValue) => {
      if (!JS_PROPERTY_TARGETS.has(property)) return full;
      if (looksLikeLocaleKey(rawValue) || !isMigratableText(unescapeJs(rawValue))) return full;
      const key = keyForText(unescapeJs(rawValue), file, property);
      needsTImport = true;
      stats.jsAssignments += 1;
      return `${receiver}.${property} = t("${key}")`;
    },
  );

  next = next.replace(
    /\.setAttribute\(\s*(["'])(aria-label|title|placeholder|alt)\1\s*,\s*(["'])([^"'\\]*(?:\\.[^"'\\]*)*)\3\s*\)/g,
    (full, quote, attr, _valueQuote, rawValue) => {
      if (!JS_ATTRIBUTE_TARGETS.has(attr)) return full;
      if (looksLikeLocaleKey(rawValue) || !isMigratableText(unescapeJs(rawValue))) return full;
      const key = keyForText(unescapeJs(rawValue), file, attr);
      needsTImport = true;
      stats.jsAssignments += 1;
      return `.setAttribute(${quote}${attr}${quote}, t("${key}"))`;
    },
  );

  if (needsTImport) next = ensureTImport(next, file);
  writeIfChanged(file, next);
}

function shouldVisitJs(file) {
  const rel = toPosix(path.relative(PUBLIC_DIR, file));
  if (rel === "i18n.js") return false;
  if (rel.endsWith(".test.js")) return false;
  if (rel.startsWith("vendor/")) return false;
  if (rel.startsWith("locales/")) return false;
  return true;
}

function keyForText(text, file, context) {
  const normalized = normalizeText(text);
  const existingKey = existingEnglishToKey.get(normalized);
  if (existingKey) return existingKey;

  const rel = toPosix(path.relative(PUBLIC_DIR, file));
  const namespace = `migrated.${slugPath(rel)}.${slugText(context)}`;
  let key = `${namespace}.${slugText(normalized)}`;
  let suffix = 2;
  while (pendingKeys.has(key)) {
    key = `${namespace}.${slugText(normalized)}${suffix}`;
    suffix += 1;
  }

  setDotted(localeEn, key, normalized);
  setDotted(localeZh, key, existingEnglishToZh.get(normalized) ?? normalized);
  pendingKeys.add(key);
  existingEnglishToKey.set(normalized, key);
  stats.newKeys += 1;
  if (!existingEnglishToZh.has(normalized)) stats.zhFallbacks.push(key);
  return key;
}

function ensureTImport(content, file) {
  const relImport = relativeImportToI18n(file);
  const importRegex = new RegExp(
    `import\\s*\\{([^}]+)\\}\\s*from\\s*["']${escapeRegExp(relImport)}["'];`,
  );
  const existingImport = content.match(importRegex);
  if (existingImport) {
    const names = existingImport[1]
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean);
    if (names.includes("t")) return content;
    const updatedNames = [...names, "t"].sort().join(", ");
    stats.jsImports += 1;
    return content.replace(existingImport[0], `import { ${updatedNames} } from "${relImport}";`);
  }

  if (new RegExp(`from\\s*["']${escapeRegExp(relImport)}["']`).test(content)) return content;

  stats.jsImports += 1;
  const importLine = `import { t } from "${relImport}";\n`;
  const shebang = content.startsWith("#!") ? content.indexOf("\n") + 1 : 0;
  return `${content.slice(0, shebang)}${importLine}${content.slice(shebang)}`;
}

function relativeImportToI18n(file) {
  let rel = toPosix(path.relative(path.dirname(file), path.join(PUBLIC_DIR, "i18n.js")));
  if (!rel.startsWith(".")) rel = `./${rel}`;
  return rel;
}

function isMigratableText(value) {
  if (typeof value !== "string") return false;
  const text = normalizeText(value);
  if (TEXT_SKIPLIST.has(text)) return false;
  if (text.length === 0 || text.length > 120) return false;
  if (!/[A-Za-z]/.test(text)) return false;
  if (/^[A-Z0-9_:-]+$/.test(text)) return false;
  if (/^[.#][\w:-]+$/.test(text)) return false;
  if (/^(https?:|wss?:|data:|\/|\.\/|\.\.\/)/i.test(text)) return false;
  if (/^[\w.-]+\/[\w.+-]+$/.test(text)) return false;
  if (/^[\w.-]+:[\w./:-]+$/.test(text)) return false;
  if (/^(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)$/i.test(text)) return false;
  if (
    /^(click|input|change|keydown|keyup|submit|mousedown|mouseup|paste|drop|dragover)$/.test(text)
  ) {
    return false;
  }
  if (/^(true|false|null|undefined|auto|hidden|button|submit|text|image)$/i.test(text))
    return false;
  if (/^[\w-]+$/.test(text) && /[-_]/.test(text)) return false;
  return true;
}

function looksLikeLocaleKey(value) {
  return /^[a-z][\w]*(?:\.[a-z][\w]*)+$/i.test(value);
}

function normalizeText(value) {
  return String(value).replace(/\s+/g, " ").trim();
}

function slugPath(relPath) {
  return relPath
    .replace(/\.[^.]+$/, "")
    .split("/")
    .map(slugText)
    .filter(Boolean)
    .join(".");
}

function slugText(value) {
  const words = String(value)
    .replace(/&[a-z]+;/gi, " ")
    .replace(/[^A-Za-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 7);
  const slug = words
    .map((word, index) => {
      const lower = word.toLowerCase();
      return index === 0 ? lower : `${lower.charAt(0).toUpperCase()}${lower.slice(1)}`;
    })
    .join("");
  return slug || "text";
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function flattenKeys(obj, prefix = "") {
  const keys = [];
  for (const [key, value] of Object.entries(obj)) {
    const dotted = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      keys.push(...flattenKeys(value, dotted));
    } else {
      keys.push(dotted);
    }
  }
  return keys;
}

function flattenValues(obj, prefix = "", out = new Map()) {
  for (const [key, value] of Object.entries(obj)) {
    const dotted = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      flattenValues(value, dotted, out);
    } else if (typeof value === "string") {
      out.set(dotted, value);
    }
  }
  return out;
}

function buildUniqueValueIndex(locale) {
  const byValue = new Map();
  const duplicates = new Set();
  for (const [key, value] of flattenValues(locale)) {
    const normalized = normalizeText(value);
    if (byValue.has(normalized)) duplicates.add(normalized);
    else byValue.set(normalized, key);
  }
  for (const duplicate of duplicates) byValue.delete(duplicate);
  return byValue;
}

function buildEnglishToTranslationIndex(en, zh) {
  const enFlat = flattenValues(en);
  const zhFlat = flattenValues(zh);
  const map = new Map();
  for (const [key, enValue] of enFlat) {
    const zhValue = zhFlat.get(key);
    if (typeof zhValue === "string") map.set(normalizeText(enValue), zhValue);
  }
  return map;
}

function setDotted(obj, dottedKey, value) {
  const parts = dottedKey.split(".");
  let current = obj;
  for (const part of parts.slice(0, -1)) {
    current[part] = current[part] && typeof current[part] === "object" ? current[part] : {};
    current = current[part];
  }
  current[parts.at(-1)] = value;
}

function walk(dir, predicate, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "vendor" || entry.name === "locales")
      continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, predicate, out);
    else if (predicate(full)) out.push(full);
  }
  return out.sort();
}

function writeIfChanged(file, content) {
  const original = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  if (original === content) return;
  stats.changedFiles.add(toPosix(path.relative(ROOT, file)));
  if (WRITE) fs.writeFileSync(file, content);
  else if (VERBOSE) console.log(`[dry-run] would update ${toPosix(path.relative(ROOT, file))}`);
}

function printSummary() {
  const mode = WRITE ? "write" : "dry-run";
  console.log(`[i18n-migrate] mode: ${mode}`);
  console.log(`[i18n-migrate] changed files: ${stats.changedFiles.size}`);
  console.log(`[i18n-migrate] html attributes: ${stats.htmlAttributes}`);
  console.log(`[i18n-migrate] html text nodes: ${stats.htmlText}`);
  console.log(`[i18n-migrate] js replacements: ${stats.jsAssignments}`);
  console.log(`[i18n-migrate] js import updates: ${stats.jsImports}`);
  console.log(`[i18n-migrate] new locale keys: ${stats.newKeys}`);
  if (stats.zhFallbacks.length > 0) {
    console.log(`[i18n-migrate] zh fallback keys needing translation: ${stats.zhFallbacks.length}`);
    for (const key of stats.zhFallbacks.slice(0, 25)) console.log(`  - ${key}`);
    if (stats.zhFallbacks.length > 25) console.log(`  ... ${stats.zhFallbacks.length - 25} more`);
  }
  if (!WRITE) console.log("[i18n-migrate] rerun with --write to apply changes");
}

function getAttributeValue(attrs, attr) {
  const match = attrs.match(new RegExp(`\\s${escapeRegExp(attr)}=(['"])(.*?)\\1`, "i"));
  return match ? decodeHtml(match[2]) : null;
}

function hasAttribute(attrs, attr) {
  return new RegExp(`\\s${escapeRegExp(attr)}(?:=|\\s|$)`, "i").test(attrs);
}

function addAttributeAfter(attrs, attr, newAttribute) {
  const regex = new RegExp(`(\\s${escapeRegExp(attr)}=(['"])(.*?)\\2)`, "i");
  return attrs.replace(regex, `$1 ${newAttribute}`);
}

function decodeHtml(value) {
  return String(value)
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function escapeAttribute(value) {
  return String(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

function unescapeJs(value) {
  return String(value)
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/\\r/g, "\r")
    .replace(/\\"/g, '"')
    .replace(/\\'/g, "'");
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function toPosix(value) {
  return value.split(path.sep).join("/");
}
