import { scaffold } from "./_scaffold-helper";

export const WORD_COUNT = scaffold(
	"word_count",
	"Count words and characters in a note, or a single section. Frontmatter is stripped, fenced code is optionally excluded, and link display text is counted. When no section is given, returns a per-heading breakdown.",
	"read",
	`params:
  path:
    type: string
    description: "Path to the note relative to vault root. The '.md' extension is optional."
    path_namespace: vault
    path_resolve_as: note
  section:
    type: string
    description: "Optional heading text to scope the count to a single section (matched case-insensitively, first match wins). Empty counts the whole note."
    default: ""
  exclude_code:
    type: boolean
    description: "Exclude fenced code blocks from the count."
    default: true`,
	`const log = utils.logger("word_count");

if (!params.path || typeof params.path !== "string") {
  throw new Error("Missing required parameter: path");
}

const section = typeof params.section === "string" ? params.section.trim() : "";
const excludeCode = params.exclude_code !== false; // default true

log.debug("Counting words", { path: params.path, section, excludeCode });

const file = utils.resolveNote(params.path);
if (!file) throw new Error(\`Note not found: \${params.path}\`);
if (file.extension !== "md") {
  throw new Error(\`Path is not a Markdown note: \${params.path}\`);
}

const fullContent = await app.vault.read(file);

// Strip frontmatter — it is not note prose.
let body = fullContent;
const fmInfo = obsidian.getFrontMatterInfo(fullContent);
if (fmInfo.exists) {
  body = fullContent.slice(fmInfo.contentStart).replace(/^\\n/, "");
}

// Remove fenced code blocks (triple-backtick or ~~~) by scanning lines and
// toggling a fence flag. More robust than a single regex for language tags
// and unclosed fences.
function stripFencedCode(text) {
  const out = [];
  let fenceChar = "";
  for (const line of text.split("\\n")) {
    const m = line.match(/^\\s*(\`{3,}|~{3,})/);
    if (m) {
      const marker = m[1][0];
      if (!fenceChar) { fenceChar = marker; continue; }
      if (marker === fenceChar) { fenceChar = ""; continue; }
    }
    if (!fenceChar) out.push(line);
  }
  return out.join("\\n");
}

// Count whitespace-delimited tokens of the human-readable text. Heuristic, not
// a full Markdown parser: heading markers, list/quote bullets, and link
// decoration are removed (link display text is kept).
function countWords(text) {
  let t = excludeCode ? stripFencedCode(text) : text;
  t = t.replace(/\\[\\[([^\\]|]+)\\|([^\\]]+)\\]\\]/g, "$2"); // [[target|display]] -> display
  t = t.replace(/\\[\\[([^\\]]+)\\]\\]/g, "$1");            // [[target]] -> target
  t = t.replace(/\\[([^\\]]*)\\]\\([^)]*\\)/g, "$1");        // [text](url) -> text
  const cleaned = t.split("\\n").map((line) =>
    line
      .replace(/^\\s{0,3}#{1,6}\\s+/, "")      // heading markers
      .replace(/^\\s*>+\\s?/, "")               // blockquote markers
      .replace(/^\\s*([-*+]|\\d+\\.)\\s+/, "")  // list bullets
  ).join("\\n");
  const stripped = cleaned.replace(/[\`*_~]/g, "");
  return stripped.trim().split(/\\s+/).filter((w) => w.length > 0).length;
}

// Parse headings for section targeting / breakdown.
const lines = body.split("\\n");
const headings = [];
for (let i = 0; i < lines.length; i++) {
  const m = lines[i].match(/^(#{1,6})\\s+(.*)$/);
  if (m) headings.push({ level: m[1].length, text: m[2].trim(), line: i });
}

function sliceFor(index) {
  const start = headings[index].line;
  const level = headings[index].level;
  let end = lines.length;
  for (let j = index + 1; j < headings.length; j++) {
    if (headings[j].level <= level) { end = headings[j].line; break; }
  }
  return lines.slice(start, end).join("\\n");
}

if (section) {
  const target = section.toLowerCase();
  const idx = headings.findIndex((h) => h.text.toLowerCase() === target);
  if (idx === -1) throw new Error(\`Section not found: \${section}\`);
  const text = sliceFor(idx);
  log.info("Counted words for section", { path: file.path, section: headings[idx].text });
  return {
    path: file.path,
    section: headings[idx].text,
    word_count: countWords(text),
    char_count: text.length,
  };
}

// Whole-note count plus a per-heading breakdown (capped to avoid bloat).
const SECTION_CAP = 100;
const sections = [];
for (let i = 0; i < headings.length && sections.length < SECTION_CAP; i++) {
  const text = sliceFor(i);
  sections.push({ heading: headings[i].text, level: headings[i].level, word_count: countWords(text) });
}

const result = {
  path: file.path,
  section: null,
  word_count: countWords(body),
  char_count: body.length,
  sections,
};
if (headings.length > SECTION_CAP) result.sections_truncated = true;
log.info("Counted words", { path: file.path, words: result.word_count, sections: sections.length });
return result;`,
);
