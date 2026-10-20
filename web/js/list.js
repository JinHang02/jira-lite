// List view: issues grouped per the Display options (status, assignee, priority or none),
// collapsible groups, inline status/priority/assignee buttons.
import { state, store } from "./state.js";
import { $, el, icon, ICONS } from "./dom.js";
import { statusKind } from "./status.js";
import { groupIssues } from "./issues.js";
import { shortDate } from "./format.js";
import { statusIcon, prioIcon, avatar, subBadge } from "./icons.js";
import { labelPills, dueChip } from "./chips.js";
import { statusMenu, priorityMenu, assigneeMenu } from "./edits.js";
import { setCursor } from "./cursor.js";
import { actions } from "./actions.js";

/** Renders `list` (already filtered and ordered) into #list. */
export function renderList(list) {
  state.visible = [];
  const sections = groupIssues(list, state.grouping).map((g) => {
    if (!g.key) {  // no grouping: a flat list
      state.visible.push(...g.items.map((i) => i.key));
      return el("section", { class: "flat" }, g.items.map(row));
    }
    const closed = state.collapsed.has(g.key);
    if (!closed) state.visible.push(...g.items.map((i) => i.key));
    return el("section", { "data-kind": g.status ? statusKind(g.status) : null },
      el("div", { class: "gh" + (closed ? " closed" : ""), "data-g": g.key, role: "button", tabindex: "0", "aria-expanded": String(!closed),
        onclick: () => toggleGroup(g.key), onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); toggleGroup(g.key); } } },
        icon(16, ICONS.chev, "chev"), groupIcon(g), el("span", {}, g.label), el("span", { class: "gcount" }, g.items.length)),
      closed ? null : g.items.map(row));
  });
  $("#list").replaceChildren(...sections);
}

function groupIcon(g) {
  if (g.status) return statusIcon(g.status);
  if ("assignee" in g) return avatar(g.assignee);
  if ("priority" in g) return prioIcon(g.priority);
  return null;
}

function row(i) {
  const f = i.fields;
  const btn = (title, child, onPick) => {
    const b = el("button", { class: "ibtn", title, "aria-label": title }, child);
    b.addEventListener("click", (e) => { e.stopPropagation(); onPick(b); });
    return b;
  };
  return el("div", {
    class: "row" + (i.key === state.current ? " open" : "") + (i.key === state.cursor ? " cur" : ""),
    "data-key": i.key, onclick: () => actions.openIssue(i.key), onmouseenter: () => setCursor(i.key),
  },
    btn((f.priority ? "Priority: " + f.priority.name : "No priority") + " (P)", prioIcon(f.priority), (b) => priorityMenu(i.key, b)),
    el("span", { class: "rid" }, i.key),
    btn("Status: " + f.status.name + " (S)", statusIcon(f.status), (b) => statusMenu(i.key, b)),
    el("span", { class: "rtitle", title: f.parent ? "Parent: " + f.parent.key + " " + (f.parent.fields || {}).summary : null }, f.summary),
    el("span", { class: "rright" },
      state.showSubProgress ? subBadge(f) : null,
      labelPills(f.labels),
      dueChip(i),
      btn((f.assignee ? "Assignee: " + f.assignee.displayName : "Unassigned") + " (A)", avatar(f.assignee), (b) => assigneeMenu(i.key, b)),
      el("span", { class: "rdate", title: "Updated " + new Date(f.updated).toLocaleString() }, shortDate(f.updated))));
}

function toggleGroup(key) {
  const a = document.activeElement;
  const refocus = a && a.classList.contains("gh") && a.dataset.g === key;
  if (state.collapsed.has(key)) state.collapsed.delete(key);
  else state.collapsed.add(key);
  store("collapsed", JSON.stringify([...state.collapsed]));
  actions.renderMain();
  const h = refocus && document.querySelector('#list .gh[data-g="' + CSS.escape(key) + '"]');
  if (h) h.focus();
}
