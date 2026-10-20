// List view: issues grouped by status, collapsible groups, inline status/priority/assignee buttons.
import { state, store } from "./state.js";
import { $, el, icon, ICONS } from "./dom.js";
import { statusKind, groupByStatus } from "./status.js";
import { shortDate } from "./format.js";
import { statusIcon, prioIcon, avatar, subBadge } from "./icons.js";
import { statusMenu, priorityMenu, assigneeMenu } from "./edits.js";
import { setCursor } from "./cursor.js";
import { actions } from "./actions.js";

export function renderList(list) {
  state.visible = [];
  const sections = groupByStatus(list).map((g) => {
    const name = g.status.name;
    const closed = state.collapsed.has(name);
    if (!closed) state.visible.push(...g.items.map((i) => i.key));
    return el("section", { "data-kind": statusKind(g.status) },
      el("div", { class: "gh" + (closed ? " closed" : ""), onclick: () => toggleGroup(name) },
        icon(16, ICONS.chev, "chev"), statusIcon(g.status), el("span", {}, name), el("span", { class: "gcount" }, g.items.length)),
      closed ? null : g.items.map(row));
  });
  const empty = state.filter.trim() ? "No tickets match “" + state.filter.trim() + "”." : "No tickets here.";
  $("#list").replaceChildren(...(sections.length ? sections : [el("p", { class: "empty" }, empty)]));
}

function row(i) {
  const f = i.fields;
  const btn = (title, child, onPick) => {
    const b = el("button", { class: "ibtn", title }, child);
    b.addEventListener("click", (e) => { e.stopPropagation(); onPick(b); });
    return b;
  };
  return el("div", {
    class: "row" + (i.key === state.current ? " open" : "") + (i.key === state.cursor ? " cur" : ""),
    "data-key": i.key, onclick: () => actions.openIssue(i.key), onmouseenter: () => setCursor(i.key),
  },
    btn((f.priority ? f.priority.name : "No priority") + " · change (p)", prioIcon(f.priority), (b) => priorityMenu(i.key, b)),
    el("span", { class: "rid" }, i.key),
    btn(f.status.name + " · change status (s)", statusIcon(f.status), (b) => statusMenu(i.key, b)),
    el("span", { class: "rtitle", title: f.parent ? "Parent: " + f.parent.key + " " + (f.parent.fields || {}).summary : null }, f.summary),
    el("span", { class: "rright" },
      subBadge(f),
      btn((f.assignee ? f.assignee.displayName : "Unassigned") + " · change (a)", avatar(f.assignee), (b) => assigneeMenu(i.key, b)),
      el("span", { class: "rdate", title: "Updated " + new Date(f.updated).toLocaleString() }, shortDate(f.updated))));
}

function toggleGroup(name) {
  if (state.collapsed.has(name)) state.collapsed.delete(name);
  else state.collapsed.add(name);
  store("collapsed", JSON.stringify([...state.collapsed]));
  actions.renderMain();
}
