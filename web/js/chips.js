// Small metadata chips shared by list rows and board cards: label pills and the due date.
import { el, icon } from "./dom.js";
import { dueInfo, labelHue, isDone } from "./issues.js";

const MAX_LABELS = 2;
const CAL = '<rect x="1.75" y="2.75" width="8.5" height="7.5" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M1.75 5.25h8.5M4 1.5v2M8 1.5v2" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>';

/** Up to two label pills plus "+N", or null when the issue has no labels. */
export function labelPills(labels) {
  const list = labels || [];
  if (!list.length) return null;
  const pill = (name) => el("span", { class: "pill", title: name },
    el("i", { style: "--h:" + labelHue(name) }), el("span", {}, name));
  const rest = list.slice(MAX_LABELS);
  return el("span", { class: "labels" }, list.slice(0, MAX_LABELS).map(pill),
    rest.length ? el("span", { class: "pill more", title: rest.join(", ") }, "+" + rest.length) : null);
}

/** Due date chip (red when overdue, amber within two days), or null when there is none. */
export function dueChip(issue) {
  const f = issue.fields;
  const d = dueInfo(f.duedate, { done: isDone(issue) });
  if (!d) return null;
  const when = d.days < 0 ? "Overdue · due " : "Due ";
  return el("span", { class: "due" + (d.level ? " " + d.level : ""), title: when + new Date(f.duedate + "T00:00").toLocaleDateString() },
    icon(12, CAL, ""), d.label);
}
