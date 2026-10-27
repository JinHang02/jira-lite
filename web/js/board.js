// Board view: one column per project status (see status.boardColumns); drag a card to transition it.
// Empty columns are hidden unless Display › Show empty columns is on. Display › Grouping other than
// status splits the board into collapsible swimlanes (one per assignee, priority or component).
import * as jira from "./api.js";
import { state, store, issueByKey } from "./state.js";
import { $, el, icon, ICONS, toast } from "./dom.js";
import { statusKind, boardColumns, boardLanes, uniqueStatuses } from "./status.js";
import { statusIcon, prioIcon, avatar, subBadge, groupIcon } from "./icons.js";
import { groupIssues } from "./issues.js";
import { labelPills, dueChip } from "./chips.js";
import { transition } from "./edits.js";
import { setCursor } from "./cursor.js";
import { selBox, clickSelect, bindSelect } from "./selection.js";
import { typeBadge, typeKind, parentHint } from "./typeicons.js";
import { actions } from "./actions.js";

// A drag in progress: re-rendering would replace the dragged card and the columns under the
// pointer (the drop would be lost), so renders wait until it ends.
let dragging = false;
let heldRender = false;
const dragEnded = () => {
  if (!dragging) return;
  dragging = false;
  if (heldRender) { heldRender = false; actions.renderMain(); }
};

/** Renders `list` (already filtered and ordered) as status columns into #board. */
export function renderBoard(list) {
  if (dragging) { heldRender = true; return; }
  const all = boardColumns(state.statuses, list, { showDone: state.showDone });
  const ticked = all.filter((c) => !state.hiddenStatuses.has(String(c.status.id)));
  const cols = state.boardEmpty ? ticked : ticked.filter((c) => c.items.length);
  const swim = !["status", "none"].includes(state.grouping);
  const board = $("#board");
  board.classList.toggle("swim", swim);
  if (swim) return renderLanes(board, cols, list);
  state.visible = cols.flatMap((c) => c.items.map((i) => i.key));
  board.replaceChildren(...cols.map(column));
}

/** Swimlanes: a sticky row of column headers, then per group a header and a row of cells. */
function renderLanes(board, cols, list) {
  const lanes = boardLanes(cols, groupIssues(list, state.grouping));
  state.visible = [];
  const head = el("div", { class: "swimhead" }, cols.map((c) => el("div", { class: "colh", "data-kind": statusKind(c.status) },
    statusIcon(c.status), el("span", { class: "cname" }, c.status.name), el("span", { class: "gcount" }, c.items.length))));
  const rows = lanes.map((g) => {
    const closed = state.collapsed.has(g.key);
    if (!closed) state.visible.push(...g.cells.flatMap((c) => c.items.map((i) => i.key)));
    const toggle = () => {
      if (state.collapsed.has(g.key)) state.collapsed.delete(g.key);
      else state.collapsed.add(g.key);
      store("collapsed", JSON.stringify([...state.collapsed]));
      actions.renderMain();
    };
    const h = el("div", { class: "swimh" + (closed ? " closed" : ""), role: "button", tabindex: "0", "aria-expanded": String(!closed), "data-g": g.key,
      onclick: toggle, onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); toggle(); } } },
      icon(16, ICONS.chev, "chev"), groupIcon(g), el("span", { class: "swimname" }, g.label), el("span", { class: "gcount" }, g.items.length));
    return el("section", { class: "swimlane" }, h, closed ? null : el("div", { class: "swimrow" }, g.cells.map(cell)));
  });
  board.replaceChildren(head, ...rows);
}

/** One swimlane's column: a drop target like a whole column. */
function cell({ status, items }) {
  const c = el("div", { class: "swimcell", "data-kind": statusKind(status), "data-status": String(status.id) }, items.map(card));
  dropTarget(c, status);
  return c;
}

function dropTarget(box, status) {
  box.addEventListener("dragover", (e) => { e.preventDefault(); box.classList.add("drop"); });
  box.addEventListener("dragleave", (e) => { if (!box.contains(e.relatedTarget)) box.classList.remove("drop"); });
  box.addEventListener("drop", (e) => {
    e.preventDefault();
    box.classList.remove("drop");
    const key = e.dataTransfer.getData("text/plain");
    dragEnded();  // dragend fires after drop; show the move (moveToStatus re-renders) at once
    if (key) moveToStatus(key, status);
  });
}

function column({ status, items }) {
  const col = el("div", { class: "col" + (items.length ? "" : " empty"), "data-kind": statusKind(status), "data-status": String(status.id) },
    el("div", { class: "colh" }, statusIcon(status), el("span", { class: "cname" }, status.name), el("span", { class: "gcount" }, items.length)),
    el("div", { class: "cards" }, items.map(card)));
  dropTarget(col, status);
  return col;
}

function card(i) {
  const f = i.fields;
  const c = el("div", {
    class: "tcard" + (i.key === state.current ? " open" : "") + (i.key === state.cursor ? " cur" : "") + (state.selected.has(i.key) ? " sel" : ""), draggable: "true",
    "data-key": i.key, onclick: (e) => { if (!clickSelect(e, i.key)) actions.openIssue(i.key); }, onmouseenter: () => setCursor(i.key),
  },
    el("div", { class: "top" }, typeBadge(f.issuetype), el("span", { class: typeKind(f.issuetype) === "epic" ? "epic" : null }, i.key),
      el("span", { class: "spacer" }), prioIcon(f.priority), selBox(i.key)),
    el("div", { class: "t" }, f.summary),
    parentHint(f, state.epic, actions.openIssue),
    el("div", { class: "bot" }, state.showSubProgress ? subBadge(i, state.epics) : null, labelPills(f.labels), dueChip(i),
      el("span", { class: "spacer" }), avatar(f.assignee)));
  c.addEventListener("dragstart", (e) => { e.dataTransfer.setData("text/plain", i.key); e.dataTransfer.effectAllowed = "move"; c.classList.add("dragging"); dragging = true; });
  c.addEventListener("dragend", () => { c.classList.remove("dragging"); dragEnded(); });
  bindSelect(c, i.key);
  return c;
}

/** Transitions `key` to `status`, if the workflow has a transition leading straight there. */
export async function moveToStatus(key, status) {
  const i = issueByKey(key);
  if (!i || String(i.fields.status.id) === String(status.id)) return;
  let trans;
  try {
    trans = await jira.getTransitions(key);
  } catch (e) {
    return toast("Couldn't load statuses for " + key + ": " + e.message, true);
  }
  const t = trans.find((x) => String(x.to.id) === String(status.id));
  if (!t) return toast(key + " can't move from " + i.fields.status.name + " to " + status.name + " directly in this workflow.", true);
  return transition(key, { id: t.id, label: t.to.name, to: t.to });
}

/** Loads the project's statuses (the board's columns). Failure leaves the board showing only statuses seen on issues. */
export async function loadStatuses() {
  try {
    state.statuses = uniqueStatuses(await jira.getProjectStatuses(state.cfg.project));
  } catch (e) {
    state.statuses = [];
  }
}
