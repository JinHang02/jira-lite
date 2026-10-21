// Markdown <-> ADF for the description editor. Lossless by construction: a block (or inline node)
// that wouldn't come back unchanged from its Markdown is shown as a "⟦n · what⟧" placeholder and
// put back as is on save. No DOM access.
//
// Syntax: # headings, **bold**, _italic_, ~~strike~~, `code`, [text](url), <url> (smart link),
// - / 1. lists (nest by indenting), - [ ] / - [x] checklists, > quotes, ``` code blocks ```, ---,
// | tables | (one line per row, a | --- | line under the header), @Name mentions, the :shortcodes: of emoji already in the description, and a line holding only
// "\" for an empty line inside a paragraph.
import { splitMentions, mentionsOf } from "./mentions.js";

const ESCAPABLE = /[!-/:-@[-`{-~⟦⟧]/;  // ASCII punctuation and the placeholder brackets
const ALNUM = /[\p{L}\p{N}]/u;
const INLINE = new Set(["text", "hardBreak", "mention", "emoji", "inlineCard", "status", "date", "mediaInline", "placeholder", "inlineExtension"]);
const MARK_ORDER = ["link", "strong", "em", "strike", "code"];  // outermost first when writing Markdown
const MARKS = { strong: "**", em: "_", strike: "~~" };
const TOKEN_LINE = /^⟦(\d+)[^⟦⟧\n]*⟧\s*$/;
const TOKEN = /^⟦(\d+)[^⟦⟧\n]*⟧/;
const MARKER = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const TASK = /^(\s*)- \[([ xX])\] ?(.*)$/;
const TABLE_SEP = /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;
const newId = () => (globalThis.crypto && crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));

// ---- ADF -> Markdown ----

/**
 * The description as Markdown: {text, kept}. `kept` holds the nodes shown as placeholders;
 * pass it back to fromMarkdown. Empty paragraphs are dropped.
 */
export function toMarkdown(doc) {
  const kept = [];
  const mentions = mentionsOf(doc);
  const parts = [];
  // Every emoji shortcode in the doc: the same text elsewhere must be escaped, or it would come
  // back as that emoji (the final parse looks codes up across the whole doc).
  shortcodes = new Set();
  const walk = (n) => {
    if (!n || typeof n !== "object") return;
    if (n.type === "emoji" && n.attrs && n.attrs.shortName) shortcodes.add(n.attrs.shortName);
    (n.content || []).forEach(walk);
  };
  walk(doc);
  for (const block of (doc && doc.content) || []) {
    if (!block || isEmptyPara(block)) continue;
    const mark = kept.length;
    const tableNext = kept.filter((k) => k.table).length;
    const md = serBlock(block, kept);
    const back = md === null ? null : parseBlocks(splitLines(md), { kept, mentions, tableNext });
    if (md !== null && sameAdf(back, [block])) parts.push(md);
    else {
      kept.length = mark;  // drop inline placeholders from the failed attempt
      parts.push(token(kept, block, false));
    }
  }
  return { text: parts.join("\n\n"), kept };
}

let shortcodes = new Set();  // set by toMarkdown for escape()

/** Lines as fromMarkdown reads them (\r\n and \r are line breaks, like in a textarea). */
const splitLines = (text) => String(text || "").replace(/\r\n?/g, "\n").split("\n");

// Placeholders are numbered among the kept nodes that aren't emoji (shown as :shortcode:) or
// table attributes (layout, width: kept for the tables written as Markdown, in order).
const numbered = (kept) => kept.filter((k) => !k.short && !k.table);

/** Adds a block node to `kept` (e.g. a just-uploaded image) and returns its placeholder line. */
export const keepBlock = (kept, node) => token(kept, node, false);

function token(kept, node, inline) {
  kept.push({ node, inline });
  const what = label(node).replace(/[⟦⟧\n|]/g, " ").trim();
  return "⟦" + numbered(kept).length + (what ? " · " + what : "") + "⟧";
}

function label(n) {
  const a = n.attrs || {};
  const media = () => {
    const m = (n.content || []).find((c) => c.type === "media");
    const alt = m && m.attrs && (m.attrs.alt || m.attrs.name);
    return alt ? "attachment: " + alt : "attachment";
  };
  const text = (s) => (s.length > 40 ? s.slice(0, 39) + "…" : s);
  switch (n.type) {
    case "mediaSingle": case "mediaGroup": return media();
    case "mediaInline": return "attachment";
    case "panel": return "panel" + (a.panelType ? ": " + a.panelType : "");
    case "expand": case "nestedExpand": return "expand" + (a.title ? ": " + a.title : "");
    case "taskList": return "checklist";
    case "decisionList": return "decisions";
    case "blockCard": case "embedCard": case "inlineCard": return a.url ? "link: " + a.url : "link";
    case "emoji": return a.shortName || a.text || "emoji";
    case "status": return "status: " + (a.text || "");
    case "mention": return a.text || "mention";
    case "text": return "formatted: " + text(n.text || "");
    case "paragraph": return "formatted text";
    case "bulletList": case "orderedList": return "list";
    default: return n.type;
  }
}

function serBlock(n, kept) {
  switch (n.type) {
    case "paragraph": return serInline(n.content, kept);
    case "heading": {
      const level = (n.attrs || {}).level;
      if (!(level >= 1 && level <= 6)) return null;
      const t = serInline(n.content, kept);
      return t === null || t.includes("\n") ? null : "#".repeat(level) + " " + t;
    }
    case "bulletList": case "orderedList": return serList(n, 0, kept);
    case "taskList": return serTasks(n, 0, kept);
    case "codeBlock": {
      const lang = (n.attrs || {}).language || "";
      const body = (n.content || []).map((c) => c.text || "").join("").replace(/\r\n?/g, "\n");
      return "```" + lang + "\n" + body + "\n```";
    }
    case "blockquote": {
      const kids = (n.content || []).map((c) => serBlock(c, kept));
      if (kids.includes(null)) return null;
      return kids.join("\n\n").split("\n").map((l) => (l ? "> " + l : ">")).join("\n");
    }
    case "rule": return "---";
    case "table": return serTable(n, kept);
  }
  return null;
}

/** A table without merged cells, row numbers or column widths, one paragraph per cell, as GFM. */
function serTable(n, kept) {
  const a = n.attrs || {};
  const rows = n.content || [];
  if (a.isNumberColumnEnabled || !rows.length || rows.some((r) => r.type !== "tableRow" || !(r.content || []).length)) return null;
  const cols = rows[0].content.length;
  const cell = (c) => {
    const ca = c.attrs || {};
    const [p, ...more] = c.content || [];
    if ((ca.colspan || 1) !== 1 || (ca.rowspan || 1) !== 1 || ca.colwidth || ca.background || more.length || !p || p.type !== "paragraph") return null;
    const t = serInline(p.content, kept, true);
    return t === null || t.includes("\n") ? null : t;
  };
  const head = rows[0].content.every((c) => c.type === "tableHeader");
  const body = head ? rows.slice(1) : rows;
  if (body.some((r) => r.content.length !== cols || r.content.some((c) => c.type !== "tableCell"))) return null;
  if (!head && rows[0].content.some((c) => c.type !== "tableCell")) return null;
  const texts = (head ? rows : [{ content: [] }, ...rows]).map((r) => r.content.map(cell));
  if (texts.some((r) => r.includes(null))) return null;
  if (!head) texts[0] = Array(cols).fill("");  // GFM needs a header line; an empty one means none
  texts.splice(1, 0, Array(cols).fill("---"));
  kept.push({ node: { type: "table", attrs: a }, table: true });
  return texts.map((cells) => "| " + cells.join(" | ") + " |").join("\n");
}

function serList(n, indent, kept) {
  const ordered = n.type === "orderedList";
  const start = ordered ? Number((n.attrs || {}).order) || 1 : 1;
  const lines = [];
  for (const [i, item] of (n.content || []).entries()) {
    const [first, ...rest] = item.content || [];
    if (item.type !== "listItem" || !first || first.type !== "paragraph" || rest.some((c) => c.type !== "bulletList" && c.type !== "orderedList")) return null;
    const marker = ordered ? start + i + "." : "-";
    const pad = " ".repeat(indent + marker.length + 1);
    let text = serInline(first.content, kept);
    if (text === null) return null;
    if (TASK.test("- " + text)) text = "\\" + text;  // not a checklist item
    text.split("\n").forEach((l, j) => lines.push(j ? pad + l : " ".repeat(indent) + marker + " " + l));
    for (const sub of rest) {
      const s = serList(sub, pad.length, kept);
      if (s === null) return null;
      lines.push(s);
    }
  }
  return lines.join("\n");
}

function serTasks(n, indent, kept) {
  const lines = [];
  for (const c of n.content || []) {
    const s = c.type === "taskList" ? serTasks(c, indent + 2, kept) : c.type === "taskItem" ? serInline(c.content, kept) : null;
    if (s === null || (c.type === "taskItem" && s.includes("\n"))) return null;
    lines.push(c.type === "taskList" ? s : " ".repeat(indent) + "- [" + ((c.attrs || {}).state === "DONE" ? "x" : " ") + "] " + s);
  }
  return lines.join("\n");
}

/** Inline nodes as one Markdown string (hard breaks are newlines), or null if a line can't be written. */
function serInline(nodes, kept, cell = false) {
  let out = "";
  for (const n of nodes || []) {
    if (n.type === "hardBreak") out += "\n";
    else if (n.type === "text") out += serText(n, kept, cell);
    else if (n.type === "mention" && /^@\S/.test((n.attrs || {}).text || "") && (n.attrs || {}).id) out += n.attrs.text;
    else if (n.type === "emoji" && /^:[\w+-]+:$/.test((n.attrs || {}).shortName || "")) {
      kept.push({ node: n, inline: true, short: n.attrs.shortName });
      out += n.attrs.shortName;
    } else if (n.type === "inlineCard" && /^https?:\/\/[^\s>]+$/i.test((n.attrs || {}).url || "") && !(n.attrs || {}).data) out += "<" + n.attrs.url + ">";
    else if (INLINE.has(n.type)) out += token(kept, n, true);
    else return null;
  }
  const lines = out.split("\n");
  return lines.map((l) => (l || lines.length === 1 ? lineEscape(l) : "\\")).join("\n");
}

function serText(n, kept, cell) {
  const marks = n.marks || [];
  const text = (n.text || "").replace(/\r\n?|\n/g, " ");  // a line break inside text renders as a space
  const code = marks.some((m) => m.type === "code");
  const link = marks.some((m) => m.type === "link");
  if (marks.some((m) => !MARK_ORDER.includes(m.type)) || (code && (text.includes("`") || (link && /[[\]]/.test(text)) || (cell && text.includes("|"))))) return token(kept, n, true);
  let out = code ? "`" + text + "`" : escape(text, link, cell);
  for (const type of [...MARK_ORDER].reverse()) {
    const m = marks.find((x) => x.type === type);
    if (!m || type === "code") continue;
    out = type === "link" ? "[" + out + "](" + ((m.attrs || {}).href || "") + ")" : MARKS[type] + out + MARKS[type];
  }
  return out;
}

/** Backslash-escapes what the inline parser would read as syntax (in link text every bracket, in a table cell every |). */
function escape(s, inLink, cell) {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i], prev = s[i - 1] || "", next = s[i + 1] || "";
    const rest = () => s.slice(i);
    if (c === "\\" && ESCAPABLE.test(next)) out += "\\\\";
    else if (c === "`" || c === "⟦") out += "\\" + c;
    else if ((c === "*" || c === "~") && (next === c || prev === c)) out += "\\" + c;
    else if (c === "_" && !(ALNUM.test(prev) && ALNUM.test(next))) out += "\\_";
    else if ((c === "[" || c === "]") && inLink) out += "\\" + c;
    else if (c === "|" && cell) out += "\\|";
    else if (c === "[" && /^\[[^\]\n]*\]\(/.test(rest())) out += "\\[";
    else if (c === "<" && /^<https?:\/\//i.test(rest())) out += "\\<";
    else if (c === ":" && shortcodes.size && shortcodes.has((/^:[\w+-]+:/.exec(rest()) || [])[0])) out += "\\:";
    else out += c;
  }
  return out;
}

/** Escapes a line that would otherwise start a heading, list, quote or rule. */
function lineEscape(line) {
  if (line === "\\") return "\\\\";  // a lone backslash would read as an empty line
  const num = /^(\s*\d+)([.)])(\s.*|)$/.exec(line);
  if (num) return num[1] + "\\" + num[2] + num[3];
  const m = /^(\s*)(?:#{1,6}\s|[-*+]\s|>|\||---+\s*$)/.exec(line);
  return m ? m[1] + "\\" + line.slice(m[1].length) : line;
}

// ---- Markdown -> ADF ----

/**
 * Markdown -> ADF doc. `kept` comes from toMarkdown (placeholders become those nodes again);
 * `mentions` ("@Name" -> accountId) turns those names into mention nodes.
 */
export function fromMarkdown(text, { kept = [], mentions } = {}) {
  const ctx = { kept, mentions, tableNext: 0 };
  return { type: "doc", version: 1, content: parseBlocks(isolateBlockTokens(splitLines(text), ctx), ctx) };
}

/**
 * Puts a block placeholder (an image, panel…) that shares its line with text, or is indented,
 * on a line of its own, so the kept node comes back instead of its "⟦n · …⟧" text. Code fences
 * and table rows are left alone.
 */
function isolateBlockTokens(lines, ctx) {
  const out = [];
  let fence = false;
  for (const l of lines) {
    if (isFence(l.trimStart())) fence = !fence;
    if (fence || /^\s*\|/.test(l) || !l.includes("⟦")) { out.push(l); continue; }
    // Block placeholders on this line, skipping escaped ones ("\⟦") and ones inside `code`.
    const code = [...l.matchAll(/`[^`]*`/g)].map((m) => [m.index, m.index + m[0].length]);
    const hits = [...l.matchAll(/(?<!\\)⟦(\d+)[^⟦⟧\n]*⟧/g)]
      .filter((m) => keptAt(ctx, m[1], false) && !code.some(([a, b]) => m.index >= a && m.index < b));
    if (!hits.length || (hits.length === 1 && hits[0][0] === l)) { out.push(l); continue; }
    const parts = [];
    let at = 0;
    for (const m of hits) { parts.push(l.slice(at, m.index), m[0]); at = m.index + m[0].length; }
    parts.push(l.slice(at));
    let buf = "";
    for (const [i, p] of parts.entries()) {
      if (i % 2 === 0) { buf += p; continue; }
      // A list/checklist marker with only the placeholder after it ("- ⟦1⟧"): the block replaces the item.
      if (buf.trim() && !/^\s*([-*+]|\d+[.)])(\s+\[[ xX]\])?\s*$/.test(buf)) out.push(buf.replace(/\s+$/, ""));
      out.push(p);
      buf = "";
    }
    if (buf.trim()) out.push(buf.replace(/^\s+/, ""));
  }
  return out;
}

function keptAt(ctx, n, inline) {
  const k = numbered(ctx.kept)[Number(n) - 1];
  return k && k.inline === inline ? structuredClone(k.node) : null;
}

const isFence = (l) => /^```/.test(l);
const isHeading = (l) => /^#{1,6}\s/.test(l);
const isRule = (l) => /^---+\s*$/.test(l);

const isTable = (lines, i) => /^\|/.test(lines[i]) && TABLE_SEP.test(lines[i + 1] || "");

function startsBlock(lines, i, ctx) {
  const l = lines[i];
  const t = TOKEN_LINE.exec(l);
  return isFence(l) || isHeading(l) || isRule(l) || /^>/.test(l) || MARKER.test(l) || isTable(lines, i) || !!(t && keptAt(ctx, t[1], false));
}

function parseBlocks(lines, ctx) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (!l.trim()) { i++; continue; }
    const t = TOKEN_LINE.exec(l);
    const block = t && keptAt(ctx, t[1], false);
    if (block) { out.push(block); i++; continue; }
    if (isFence(l)) {
      const lang = l.slice(3).trim();
      const body = [];
      for (i++; i < lines.length && !/^```\s*$/.test(lines[i]); i++) body.push(lines[i]);
      i++;
      const code = { type: "codeBlock" };
      if (lang) code.attrs = { language: lang };
      const s = body.join("\n");
      if (s) code.content = [{ type: "text", text: s }];
      out.push(code);
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(l);
    if (h) { out.push({ type: "heading", attrs: { level: h[1].length }, content: parseInline(h[2], ctx) }); i++; continue; }
    if (isRule(l)) { out.push({ type: "rule" }); i++; continue; }
    if (/^>/.test(l)) {
      const inner = [];
      for (; i < lines.length && /^>/.test(lines[i]); i++) inner.push(lines[i].replace(/^> ?/, ""));
      out.push(...quote(parseBlocks(inner, ctx)));
      continue;
    }
    if (isTable(lines, i)) {
      const r = parseTable(lines, i, ctx);
      if (r.node.content.length) out.push(r.node);  // header-less with every row deleted: nothing left
      i = r.next;
      continue;
    }
    const tk = TASK.exec(l);
    if (tk) {
      const r = parseTasks(lines, i, tk[1].length, ctx);
      out.push(r.node);
      i = r.next;
      continue;
    }
    const m = MARKER.exec(l);
    if (m) {
      const r = parseList(lines, i, m[1].length, ctx);
      out.push(r.node);
      i = r.next;
      continue;
    }
    const content = [];
    for (let first = true; i < lines.length && lines[i].trim() && (first || !startsBlock(lines, i, ctx)); i++, first = false) {
      if (!first) content.push({ type: "hardBreak" });
      content.push(...lineInline(lines[i], ctx));
    }
    out.push({ type: "paragraph", content });
  }
  return out;
}

// What ADF allows inside a blockquote; anything else typed after "> " ends up between quotes.
const IN_QUOTE = new Set(["paragraph", "bulletList", "orderedList", "codeBlock", "mediaSingle", "mediaGroup"]);

/** Blockquote(s) around `nodes`, split so each holds only what ADF allows; none if empty. */
function quote(nodes) {
  const out = [];
  let cur = null;
  for (const n of nodes) {
    const kids = n.type === "blockquote" ? n.content : [n];  // "> > x": no nested quotes in ADF
    for (const k of kids) {
      if (IN_QUOTE.has(k.type)) {
        if (!cur) out.push(cur = { type: "blockquote", content: [] });
        cur.content.push(k);
      } else {
        out.push(k);
        cur = null;
      }
    }
  }
  return out;
}

function parseList(lines, i, indent, ctx) {
  const ordered = /\d/.test(MARKER.exec(lines[i])[2]);
  const node = { type: ordered ? "orderedList" : "bulletList", content: [] };
  if (ordered) {
    const start = parseInt(MARKER.exec(lines[i])[2], 10);
    if (start !== 1) node.attrs = { order: start };
  }
  while (i < lines.length) {
    const m = MARKER.exec(lines[i]);
    if (!m || m[1].length !== indent || /\d/.test(m[2]) !== ordered) break;
    const para = { type: "paragraph", content: lineInline(m[3], ctx) };
    const item = { type: "listItem", content: [para] };
    node.content.push(item);
    for (i++; i < lines.length && lines[i].trim();) {
      const sub = MARKER.exec(lines[i]);
      const lead = /^\s*/.exec(lines[i])[0].length;
      if (sub && sub[1].length > indent) {
        const r = parseList(lines, i, sub[1].length, ctx);
        item.content.push(r.node);
        i = r.next;
      } else if (!sub && lead > indent && item.content.length === 1) {
        para.content.push({ type: "hardBreak" }, ...lineInline(lines[i].slice(lead), ctx));
        i++;
      } else break;
    }
    if (i < lines.length && !lines[i].trim()) break;  // a blank line ends the list
  }
  return { node, next: i };
}

function parseTasks(lines, i, indent, ctx) {
  const node = { type: "taskList", attrs: { localId: newId() }, content: [] };
  while (i < lines.length) {
    const m = TASK.exec(lines[i]);
    if (!m || m[1].length < indent) break;
    if (m[1].length > indent) {
      const r = parseTasks(lines, i, m[1].length, ctx);
      node.content.push(r.node);
      i = r.next;
      continue;
    }
    node.content.push({ type: "taskItem", attrs: { localId: newId(), state: m[2] === " " ? "TODO" : "DONE" }, content: lineInline(m[3], ctx) });
    i++;
  }
  return { node, next: i };
}

/** A table row's cells (split on unescaped |, outer pipes dropped), still Markdown. */
function splitRow(line) {
  const cells = [""];
  for (let j = 0; j < line.length; j++) {
    if (line[j] === "\\" && j + 1 < line.length) cells[cells.length - 1] += line[j] + line[++j];
    else if (line[j] === "|") cells.push("");
    else cells[cells.length - 1] += line[j];
  }
  if (/^\s*\|/.test(line)) cells.shift();
  if (cells.length > 1 && !cells[cells.length - 1].trim()) cells.pop();
  return cells.map((c) => c.trim());
}

function parseTable(lines, i, ctx) {
  const head = splitRow(lines[i]);
  const body = [];
  for (i += 2; i < lines.length && /^\|/.test(lines[i]); i++) body.push(splitRow(lines[i]));
  const rows = head.some(Boolean) ? [head, ...body] : body;
  const cols = Math.max(...rows.map((r) => r.length), 1);
  const cell = (type, text) => ({ type, attrs: {}, content: [{ type: "paragraph", content: parseInline(text || "", ctx) }] });
  const kept = ctx.kept.filter((k) => k.table)[ctx.tableNext++];
  const node = { type: "table", attrs: kept ? structuredClone(kept.node.attrs) : { isNumberColumnEnabled: false, layout: "center", localId: newId() },
    content: rows.map((r, j) => ({ type: "tableRow", content: Array.from({ length: cols }, (_, k) => cell(j === 0 && head.some(Boolean) ? "tableHeader" : "tableCell", r[k])) })) };
  return { node, next: i };
}

/** One line's inline nodes; a line holding only "\\" is an empty line (between two hard breaks). */
const lineInline = (s, ctx) => (s === "\\" ? [] : parseInline(s, ctx));

/** Index of the next unescaped `delim` at or after `from` (skipping `code`), or -1. */
function findClose(s, delim, from, test = () => true) {
  for (let j = from; j < s.length; j++) {
    if (s[j] === "\\" && ESCAPABLE.test(s[j + 1] || "")) { j++; continue; }
    if (s[j] === "`") { const k = s.indexOf("`", j + 1); if (k > j) { j = k; continue; } }
    if (s.startsWith(delim, j) && test(j)) return j;
  }
  return -1;
}

function parseInline(s, ctx, marks = []) {
  const out = [];
  let buf = "";
  const flush = () => {
    if (!buf) return;
    for (const part of ctx.mentions ? splitMentions(buf, ctx.mentions) : [buf]) {
      if (typeof part === "string") out.push(marks.length ? { type: "text", text: part, marks: marks.map((m) => ({ ...m })) } : { type: "text", text: part });
      else out.push({ type: "mention", attrs: { id: part.id, text: part.text } });
    }
    buf = "";
  };
  const wrap = (inner, mark) => out.push(...parseInline(inner, ctx, [...marks, mark]));
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    const rest = s.slice(i);
    if (c === "\\" && ESCAPABLE.test(s[i + 1] || "")) { buf += s[i + 1]; i += 2; continue; }
    if (c === "`") {
      const j = s.indexOf("`", i + 1);
      if (j > i + 1) {
        flush();
        // ADF lets code combine only with link marks (bold/italic/strike around `code` are dropped).
        out.push({ type: "text", text: s.slice(i + 1, j), marks: [...marks.filter((m) => m.type === "link"), { type: "code" }].map((m) => ({ ...m })) });
        i = j + 1;
        continue;
      }
    }
    const pair = rest.startsWith("**") ? ["**", "strong"] : rest.startsWith("~~") ? ["~~", "strike"] : null;
    if (pair) {
      const j = findClose(s, pair[0], i + 2);
      if (j > i + 2) { flush(); wrap(s.slice(i + 2, j), { type: pair[1] }); i = j + 2; continue; }
    }
    if (c === "_" && !ALNUM.test(s[i - 1] || "") && s[i + 1] && !/\s/.test(s[i + 1])) {
      const j = findClose(s, "_", i + 1, (k) => !ALNUM.test(s[k + 1] || "") && !/\s/.test(s[k - 1]));
      if (j > i + 1) { flush(); wrap(s.slice(i + 1, j), { type: "em" }); i = j + 1; continue; }
    }
    const link = /^\[((?:\\.|[^\]\\])+)\]\(([^()\s]+)\)/.exec(rest);
    if (link) { flush(); wrap(link[1], { type: "link", attrs: { href: link[2] } }); i += link[0].length; continue; }
    const card = /^<(https?:\/\/[^\s>]+)>/i.exec(rest);
    if (card) { flush(); out.push({ type: "inlineCard", attrs: { url: card[1] } }); i += card[0].length; continue; }
    const t = TOKEN.exec(rest);
    const node = t && keptAt(ctx, t[1], true);
    if (node) { flush(); out.push(node); i += t[0].length; continue; }
    const sc = c === ":" && /^:[\w+-]+:/.exec(rest);
    const emoji = sc && ctx.kept.find((k) => k.short === sc[0]);
    if (emoji) { flush(); out.push(structuredClone(emoji.node)); i += sc[0].length; continue; }
    buf += c;
    i++;
  }
  flush();
  return out;
}

// ---- comparison ----

const isEmptyPara = (n) => n && n.type === "paragraph" && !(n.content || []).length;

/**
 * A canonical copy of ADF nodes for comparison: no localId attrs or empty attrs/marks/content,
 * sorted marks, mention attrs reduced to id and text, adjacent same-mark text merged, empty
 * paragraphs dropped outside list items.
 */
export function normalizeAdf(nodes, inItem = false, inCode = false) {
  const out = [];
  for (const n of nodes || []) {
    if (!inItem && isEmptyPara(n)) continue;
    const c = { type: n.type };
    let attrs = { ...(n.attrs || {}) };
    delete attrs.localId;
    if (n.type === "mention") attrs = { id: attrs.id, text: attrs.text };
    if (n.type === "orderedList" && Number(attrs.order) === 1) delete attrs.order;
    if (n.type === "codeBlock" && !attrs.language) delete attrs.language;
    delete attrs.wrap;  // code block line wrapping: a display toggle Markdown can't carry
    if (Object.keys(attrs).length) c.attrs = attrs;
    if (n.text !== undefined) c.text = n.type === "text" && !inCode ? n.text.replace(/\r\n?|\n/g, " ") : n.text.replace(/\r\n?/g, "\n");
    const marks = (n.marks || []).map((m) => (m.attrs ? { type: m.type, attrs: m.attrs } : { type: m.type }))
      .sort((a, b) => MARK_ORDER.indexOf(a.type) - MARK_ORDER.indexOf(b.type) || a.type.localeCompare(b.type));
    if (marks.length) c.marks = marks;
    if (n.type === "tableCell" || n.type === "tableHeader") {
      if (Number(attrs.colspan) === 1) delete attrs.colspan;
      if (Number(attrs.rowspan) === 1) delete attrs.rowspan;
      if (attrs.background == null) delete attrs.background;
      if (Object.keys(attrs).length) c.attrs = attrs; else delete c.attrs;
    }
    const kids = normalizeAdf(n.content, ["listItem", "tableCell", "tableHeader"].includes(n.type), n.type === "codeBlock");
    if (kids.length) c.content = kids;
    const prev = out[out.length - 1];
    if (c.type === "text" && !c.text) continue;
    if (c.type === "text" && prev && prev.type === "text" && JSON.stringify(prev.marks) === JSON.stringify(c.marks)) prev.text += c.text;
    else out.push(c);
  }
  return out;
}

const sameAdf = (a, b) => JSON.stringify(normalizeAdf(a)) === JSON.stringify(normalizeAdf(b));
