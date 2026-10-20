// The main pane: loads the issue list and renders it as list or board; header view toggles.
import * as jira from "./api.js";
import { state, store } from "./state.js";
import { $, toast, typingIn } from "./dom.js";
import { buildJql } from "./jql.js";
import { filterIssues } from "./issues.js";
import { renderList } from "./list.js";
import { renderBoard } from "./board.js";
import { activeMenu } from "./menu.js";
import { actions } from "./actions.js";

let listSeq = 0;

/** Reloads the list (up to 500 issues) and re-renders. Older in-flight loads are discarded. */
export async function loadList() {
  const seq = ++listSeq;
  const { cfg, who, showDone } = state;
  try {
    const out = await jira.searchAll(buildJql({ project: cfg.project, who, showDone }));
    if (seq !== listSeq) return;  // a newer load started meanwhile
    state.issues = out;
    renderMain();
    state.lastRefresh = Date.now();
    $("#updated").textContent = "Updated " + new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  } catch (e) {
    if (seq === listSeq) toast("Couldn't load tickets: " + e.message, true);
  }
}

/** Re-renders the current view from state.issues and the filter. */
export function renderMain() {
  const list = filterIssues(state.issues, state.filter);
  const n = state.issues.length;
  $("#count").textContent = state.filter.trim() ? list.length + " / " + n : n ? String(n) : "";
  if (state.view === "board") renderBoard(list);
  else renderList(list);
  if (state.cursor && !state.visible.includes(state.cursor)) state.cursor = null;
}

export function setView(view) {
  state.view = view;
  store("view", view);
  $("#vList").setAttribute("aria-pressed", String(view === "list"));
  $("#vBoard").setAttribute("aria-pressed", String(view === "board"));
  $("#list").hidden = view !== "list";
  $("#board").hidden = view !== "board";
  renderMain();
}

export function toggleDone() {
  state.showDone = !state.showDone;
  store("showDone", state.showDone ? "1" : "0");
  $("#showDone").setAttribute("aria-pressed", String(state.showDone));
  return loadList().then(() => {
    // Done sorts last, usually off-screen: jump to it so the toggle visibly does something.
    if (!state.showDone) return;
    if (state.view === "board") {
      const col = document.querySelector('#board .col[data-kind="done"]');
      if (col) col.scrollIntoView({ behavior: "smooth", inline: "nearest", block: "nearest" });
      return;
    }
    const done = document.querySelector('#list section[data-kind="done"]');
    const list = $("#list");
    if (done) list.scrollBy({ top: done.getBoundingClientRect().top - list.getBoundingClientRect().top, behavior: "smooth" });
  });
}

/** Reloads list and detail unless a write is in flight, a menu is open, or the user is typing in the panel. */
export function refresh() {
  if (state.busy || activeMenu()) return;
  loadList();
  const a = document.activeElement;
  if (state.current && !(typingIn(a) && a.closest("#detail"))) actions.loadDetail();
}

/** Clears the free-text filter box. */
export function clearFilter() {
  $("#q").value = "";
  state.filter = "";
  renderMain();
}

/** Binds the header controls (view toggle, show done, refresh, filter). */
export function bindHeader() {
  $("#showDone").setAttribute("aria-pressed", String(state.showDone));
  $("#showDone").addEventListener("click", toggleDone);
  $("#refresh").addEventListener("click", refresh);
  $("#newBtn").addEventListener("click", () => actions.openCreate(null));
  $("#vList").addEventListener("click", () => setView("list"));
  $("#vBoard").addEventListener("click", () => setView("board"));
  $("#q").addEventListener("input", () => { state.filter = $("#q").value; renderMain(); });
}
