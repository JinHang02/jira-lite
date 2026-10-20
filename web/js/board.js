// Board view: one column per project status (see status.boardColumns); drag a card to transition it.
import * as jira from "./api.js";
import { state, issueByKey } from "./state.js";
import { $, el, toast } from "./dom.js";
import { statusKind, boardColumns, uniqueStatuses } from "./status.js";
import { statusIcon, prioIcon, avatar, subBadge } from "./icons.js";
import { transition } from "./edits.js";
import { setCursor } from "./cursor.js";
import { actions } from "./actions.js";

export function renderBoard(list) {
  const cols = boardColumns(state.statuses, list, { showDone: state.showDone });
  state.visible = cols.flatMap((c) => c.items.map((i) => i.key));
  const els = cols.map(({ status, items }) => {
    const col = el("div", { class: "col", "data-kind": statusKind(status), "data-status": String(status.id) },
      el("div", { class: "colh" }, statusIcon(status), el("span", {}, status.name), el("span", { class: "gcount" }, items.length)),
      el("div", { class: "cards" }, items.map(card)));
    col.addEventListener("dragover", (e) => { e.preventDefault(); col.classList.add("drop"); });
    col.addEventListener("dragleave", (e) => { if (!col.contains(e.relatedTarget)) col.classList.remove("drop"); });
    col.addEventListener("drop", (e) => {
      e.preventDefault();
      col.classList.remove("drop");
      const key = e.dataTransfer.getData("text/plain");
      if (key) moveToStatus(key, status);
    });
    return col;
  });
  if (!state.showDone) {
    els.push(el("div", { class: "col ghost" }, el("span", {}, "Done is hidden"), el("button", { class: "btn", onclick: () => actions.toggleDone() }, "Show done")));
  }
  $("#board").replaceChildren(...els);
}

function card(i) {
  const f = i.fields;
  const c = el("div", {
    class: "tcard" + (i.key === state.current ? " open" : "") + (i.key === state.cursor ? " cur" : ""), draggable: "true",
    "data-key": i.key, onclick: () => actions.openIssue(i.key), onmouseenter: () => setCursor(i.key),
  },
    el("div", { class: "top" }, el("span", {}, i.key), el("span", { class: "spacer" }), prioIcon(f.priority)),
    el("div", { class: "t" }, f.summary),
    el("div", { class: "bot" }, subBadge(f), el("span", { class: "spacer" }), avatar(f.assignee)));
  c.addEventListener("dragstart", (e) => { e.dataTransfer.setData("text/plain", i.key); e.dataTransfer.effectAllowed = "move"; c.classList.add("dragging"); });
  c.addEventListener("dragend", () => c.classList.remove("dragging"));
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
  return transition(key, { id: t.id, label: t.to.name });
}

/** Loads the project's statuses (the board's columns). Failure leaves the board showing only statuses seen on issues. */
export async function loadStatuses() {
  try {
    state.statuses = uniqueStatuses(await jira.getProjectStatuses(state.cfg.project));
  } catch (e) {
    state.statuses = [];
  }
}
