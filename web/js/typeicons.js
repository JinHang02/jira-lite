// Jira-style issue type icons (14px rounded squares), drawn locally: Jira's own icon URLs need
// the user's Jira session, which the browser doesn't have.
import { el, icon } from "./dom.js";

const GLYPH = 'fill="none" stroke="#fff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"';
const TYPES = {
  bug: '<circle cx="7" cy="7" r="2.6" fill="#fff"/>',
  story: '<path d="M4.75 3.5h4.5v7L7 8.75 4.75 10.5z" fill="#fff"/>',
  epic: '<path d="M7.9 2.75L4.5 7.6h2.4l-.8 3.65 3.4-4.85H7.1z" fill="#fff"/>',
  subtask: '<rect x="3.5" y="3.5" width="4" height="4" rx=".8" ' + GLYPH + '/><rect x="6.5" y="6.5" width="4" height="4" rx=".8" fill="#fff"/>',
  improvement: '<path d="M7 10.5v-7M4 6.25L7 3.25l3 3" ' + GLYPH + "/>",
  feature: '<path d="M7 3.5v7M3.5 7h7" ' + GLYPH + "/>",
  task: '<path d="M4 7.2l2 2 4-4.2" ' + GLYPH + "/>",
};

/** The icon family of an issue type ({name, subtask, hierarchyLevel}). */
export function typeKind(t) {
  const n = ((t && t.name) || "").toLowerCase();
  if (t && t.subtask) return "subtask";
  if (/bug|defect|incident/.test(n)) return "bug";
  if (/epic/.test(n) || (t && t.hierarchyLevel === 1)) return "epic";
  if (/story/.test(n)) return "story";
  if (/improve|enhance/.test(n)) return "improvement";
  if (/feature/.test(n)) return "feature";
  return "task";
}

/** 14px icon for an issue type; colour comes from the .ti-* classes in detail.css. */
export function typeIcon(t) {
  const k = typeKind(t);
  return icon(14, '<rect x=".5" y=".5" width="13" height="13" rx="3" fill="currentColor"/>' + TYPES[k], "ticon ti-" + k);
}

/** The type icon with the type's name as tooltip (list rows, board cards). */
export function typeBadge(t) {
  return t ? el("span", { class: "tbadge", title: t.name }, typeIcon(t)) : null;
}

/** "↳ KEY" button that opens the parent; null without a parent or when the view is that epic. */
export function parentHint(f, epicFilter, open) {
  if (!f.parent || f.parent.key === epicFilter) return null;
  const summary = (f.parent.fields || {}).summary || "";
  const b = el("button", { class: "phint", type: "button", title: "Parent: " + f.parent.key + (summary ? " · " + summary : "") },
    "↳ ", el("span", { class: "phkey" }, f.parent.key), summary ? el("span", { class: "phsum" }, summary) : null);
  b.addEventListener("click", (e) => { e.stopPropagation(); open(f.parent.key); });
  return b;
}
