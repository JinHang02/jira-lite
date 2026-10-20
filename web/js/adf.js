// Atlassian Document Format: render to DOM (text only, no innerHTML) and pure plain-text helpers.
import { el } from "./dom.js";

const BLOCKS = {
  paragraph: "p", bulletList: "ul", orderedList: "ol", listItem: "li", blockquote: "blockquote",
  table: "table", tableRow: "tr", tableHeader: "th", tableCell: "td", taskList: "ul", decisionList: "ul",
};

/** The URL if it is http(s) or mailto, else null. */
export function safeUrl(u) { return /^(https?:|mailto:)/i.test(u || "") ? u : null; }

/** Renders an ADF node (usually a doc) to DOM nodes. */
export function renderAdf(node) {
  if (!node) return document.createTextNode("");
  const kids = () => (node.content || []).map(renderAdf);
  const a = node.attrs || {};
  switch (node.type) {
    case "doc": return el("div", { class: "adf" }, kids());
    case "text": {
      let out = document.createTextNode(node.text || "");
      for (const m of node.marks || []) {
        const tag = { strong: "b", em: "i", code: "code", strike: "s", underline: "u" }[m.type];
        if (tag) out = el(tag, {}, out);
        else if (m.type === "link" && safeUrl(m.attrs && m.attrs.href)) {
          out = el("a", { href: m.attrs.href, target: "_blank", rel: "noopener" }, out);
        }
      }
      return out;
    }
    case "heading": return el("h" + Math.min(Math.max(a.level || 3, 3), 6), {}, kids());
    case "codeBlock": return el("pre", {}, el("code", {}, kids()));
    case "hardBreak": return el("br");
    case "rule": return el("hr");
    case "panel": return el("div", { class: "panel" }, kids());
    case "expand": case "nestedExpand": return el("details", {}, el("summary", {}, a.title || "More"), kids());
    case "taskItem": case "decisionItem": return el("li", {}, a.state === "DONE" || a.state === "DECIDED" ? "☑ " : "☐ ", kids());
    case "mention": return el("span", { class: "mention" }, a.text || "@someone");
    case "emoji": return document.createTextNode(a.text || a.shortName || "");
    case "status": return el("code", {}, a.text || "");
    case "date": return document.createTextNode(new Date(Number(a.timestamp)).toLocaleDateString());
    case "inlineCard": case "blockCard": case "embedCard":
      return safeUrl(a.url) ? el("a", { href: a.url, target: "_blank", rel: "noopener" }, a.url) : document.createTextNode("");
    case "mediaSingle": case "mediaGroup": case "media": case "mediaInline":
      return el("span", { class: "att" }, "[attachment: open in Jira] ");
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
