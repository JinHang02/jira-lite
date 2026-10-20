// Atlassian Document Format: render to DOM (text only, no innerHTML) and pure plain-text helpers.
import { el, icon, toast } from "./dom.js";

const BLOCKS = {
  paragraph: "p", bulletList: "ul", orderedList: "ol", listItem: "li", blockquote: "blockquote",
  table: "table", tableRow: "tr", tableHeader: "th", tableCell: "td", taskList: "ul", decisionList: "ul",
};

/** The URL if it is http(s) or mailto, else null. */
export function safeUrl(u) { return /^(https?:|mailto:)/i.test(u || "") ? u : null; }

const URL_RE = /\bhttps?:\/\/[^\s<>"'`]+/gi;

/** Trims sentence punctuation (and an unbalanced closing bracket) off the end of a matched URL. */
function trimUrl(u) {
  for (;;) {
    const last = u[u.length - 1];
    if (/[.,;:!?'"*]/.test(last)) u = u.slice(0, -1);
    else if (last === ")" && (u.match(/\(/g) || []).length < (u.match(/\)/g) || []).length) u = u.slice(0, -1);
    else if (last === "]" && (u.match(/\[/g) || []).length < (u.match(/\]/g) || []).length) u = u.slice(0, -1);
    else return u;
  }
}

/**
 * Splits plain text into strings and {url} parts for the http(s) URLs in it (pure; used to linkify
 * ADF text without a link mark). Adjacent text stays one string; no part is empty.
 */
export function linkifyParts(text) {
  const out = [];
  let at = 0;
  for (const m of String(text || "").matchAll(URL_RE)) {
    const url = trimUrl(m[0]);
    if (!/^https?:\/\/[^/?#]/i.test(url)) continue;
    if (m.index > at) out.push(text.slice(at, m.index));
    out.push({ url });
    at = m.index + url.length;
  }
  if (at < String(text || "").length) out.push(text.slice(at));
  return out;
}

const COPY_SVG = '<rect x="4.5" y="4.5" width="7" height="7" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M9.5 2.5h-5a2 2 0 0 0-2 2v5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>';
const FILE_SVG = '<path d="M8 1.75H4.25a1 1 0 0 0-1 1v8.5a1 1 0 0 0 1 1h5.5a1 1 0 0 0 1-1V4.5L8 1.75z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M7.75 1.75V4.75h3" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>';

/** Copies text to the clipboard and confirms with a toast. */
export async function copyText(text, label) {
  try {
    await navigator.clipboard.writeText(text);
    toast("Copied " + label);
  } catch (e) {
    toast("Couldn't copy: " + (e.message || "clipboard unavailable"), true);
  }
}

/** Text with plain http(s) URLs turned into links that open in a new tab. */
function linkified(text) {
  const parts = linkifyParts(text);
  if (parts.length === 1 && typeof parts[0] === "string" && !EMOJI_RE.test(text)) return document.createTextNode(text);
  const f = document.createDocumentFragment();
  for (const p of parts) f.append(typeof p === "string" ? withEmoji(p) : el("a", { href: p.url, target: "_blank", rel: "noopener noreferrer" }, p.url));
  return f;
}

// Emoji typed as plain text: color-emoji glyphs are wider than the text font's advance and
// swallow the following space, so they get a span with room (see .adf .emoji).
// Only characters drawn as colour emoji (not ©, ®, ™ or arrows typed as text).
const EMOJI_RE = /\p{Emoji_Presentation}|\p{Extended_Pictographic}️/u;
const EMOJI_RUN = /((?:\p{Emoji_Presentation}|\p{Extended_Pictographic}️)(?:‍\p{Extended_Pictographic}️?)*)/u;

function withEmoji(s) {
  if (!EMOJI_RE.test(s)) return s;
  const f = document.createDocumentFragment();
  s.split(EMOJI_RUN).forEach((piece, i) => { if (piece) f.append(i % 2 ? el("span", { class: "emoji" }, piece) : piece); });
  return f;
}

/** A code block with a language label and a copy button. */
function codeBlock(node) {
  const text = (node.content || []).map((n) => n.text || "").join("");
  const lang = (node.attrs || {}).language;
  const copy = el("button", { class: "copy", type: "button", title: "Copy code", "aria-label": "Copy code" }, icon(14, COPY_SVG, ""));
  copy.addEventListener("click", () => copyText(text, "code"));
  return el("div", { class: "codeblock" }, lang ? el("span", { class: "lang" }, lang) : null, copy, el("pre", {}, el("code", {}, text)));
}

/** "[file] name · open in Jira" chip for media, which the proxy can't show inline. */
function mediaChip(a, opts) {
  const name = a.alt || a.name || "Attachment";
  const kids = [icon(14, FILE_SVG, ""), el("span", { class: "attname" }, name), el("span", { class: "attvia" }, "open in Jira")];
  return opts.jiraUrl
    ? el("a", { class: "att", href: opts.jiraUrl, target: "_blank", rel: "noopener", title: name + " — attachments open in Jira" }, kids)
    : el("span", { class: "att", title: name + " — attachments open in Jira" }, kids);
}

/**
 * Renders an ADF node (usually a doc) to DOM nodes. `opts.jiraUrl` (the issue in Jira) is where
 * attachment chips link to.
 */
export function renderAdf(node, opts = {}) {
  if (!node) return document.createTextNode("");
  const kids = () => (node.content || []).map((n) => renderAdf(n, opts));
  const a = node.attrs || {};
  switch (node.type) {
    case "doc": return el("div", { class: "adf" }, kids());
    case "text": {
      const marks = node.marks || [];
      const plain = marks.some((m) => m.type === "link" || m.type === "code");  // no auto-links inside links or code
      let out = plain ? document.createTextNode(node.text || "") : linkified(node.text || "");
      for (const m of marks) {
        const tag = { strong: "b", em: "i", code: "code", strike: "s", underline: "u" }[m.type];
        if (tag) out = el(tag, {}, out);
        else if (m.type === "link" && safeUrl(m.attrs && m.attrs.href)) {
          out = el("a", { href: m.attrs.href, target: "_blank", rel: "noopener" }, out);
        }
      }
      return out;
    }
    case "heading": return el("h" + Math.min(Math.max(a.level || 3, 3), 6), {}, kids());
    case "codeBlock": return codeBlock(node);
    case "hardBreak": return el("br");
    case "rule": return el("hr");
    case "panel": return el("div", { class: "panel" }, kids());
    case "expand": case "nestedExpand": return el("details", {}, el("summary", {}, a.title || "More"), kids());
    case "taskItem": case "decisionItem": return el("li", {}, a.state === "DONE" || a.state === "DECIDED" ? "☑ " : "☐ ", kids());
    case "mention": return el("span", { class: "mention" }, a.text || "@someone");
    case "emoji": return el("span", { class: "emoji", title: a.shortName || null }, a.text || a.shortName || "");
    case "status": return el("code", {}, a.text || "");
    case "date": return document.createTextNode(new Date(Number(a.timestamp)).toLocaleDateString());
    case "inlineCard": case "blockCard": case "embedCard":
      return safeUrl(a.url) ? el("a", { href: a.url, target: "_blank", rel: "noopener" }, a.url) : document.createTextNode("");
    case "mediaSingle": case "mediaGroup": return el("div", { class: "atts" }, kids());
    case "media": case "mediaInline": return mediaChip(a, opts);
    case "table": return el("div", { class: "tablewrap" }, el("table", {}, el("tbody", {}, kids())));
  }
  if (BLOCKS[node.type]) return el(BLOCKS[node.type], {}, kids());
  return el("span", {}, kids());  // unknown node: keep its text
}

/** Plain text -> ADF doc: blank lines split paragraphs, single newlines become hard breaks. */
export function textToAdf(text) {
  return {
    type: "doc", version: 1,
    content: text.trim().split(/\n\s*\n/).map((para) => {
      const content = [];
      para.split("\n").forEach((line, i) => {
        if (i) content.push({ type: "hardBreak" });
        if (line) content.push({ type: "text", text: line });
      });
      return { type: "paragraph", content };
    }),
  };
}

/** True if editing this doc as plain text loses nothing (no formatting, lists, code, media...). */
export function plainSafe(doc) {
  const ok = (n) => ["doc", "paragraph", "hardBreak"].includes(n.type) ? (n.content || []).every(ok)
    : n.type === "text" && !(n.marks || []).length;
  return !doc || ok(doc);
}

/** Inverse of textToAdf for plainSafe docs. */
export function adfToText(doc) {
  if (!doc) return "";
  return (doc.content || []).map((p) => (p.content || []).map((n) => n.type === "hardBreak" ? "\n" : n.text || "").join("")).join("\n\n");
}
