// The main pane: loads the issue list and renders it as list or board; header view toggles.
import * as jira from "./api.js";
import { state, store } from "./state.js";
import { $, toast, typingIn } from "./dom.js";
import { buildJql, deltaJql, matchesView } from "./jql.js";
import { filterIssues } from "./issues.js";
import { syncPlan, deltaMinutes, mergeDelta } from "./sync.js";
import { renderList } from "./list.js";
import { renderBoard } from "./board.js";
import { activeMenu } from "./menu.js";
import { actions } from "./actions.js";

const DELTA_PAGE = 100;
let listSeq = 0;      // bumped by every full load; a delta is dropped if one started meanwhile
let deltaSeq = 0;     // bumped by every delta; only the newest is applied
let fullLoad = null;  // the in-flight full load, if any

const stamp = () => { $("#updated").textContent = "Updated " + new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }); };

/** The current view's filters, as matchesView takes them. */
const viewFilter = () => ({ who: state.who, meId: state.me ? state.me.accountId : null, showDone: state.showDone });

/** Reloads the list (up to 500 issues) and re-renders. Older in-flight loads are discarded. */
export function loadList() {
  const p = fullReload();
  fullLoad = p;
  p.finally(() => { if (fullLoad === p) fullLoad = null; });
  return p;
}

async function fullReload() {
  const seq = ++listSeq;
  const { cfg, who, showDone } = state;
  const started = Date.now();
  try {
    const out = await jira.searchAll(buildJql({ project: cfg.project, who, showDone }));
    if (seq !== listSeq) return;  // a newer load started meanwhile
    state.issues = out;
    renderMain();
    state.lastSync = state.lastFull = started;
    stamp();
  } catch (e) {
    if (seq === listSeq) toast("Couldn't load tickets: " + e.message, true);
  }
}

/**
 * Cheap refresh: fetches only the project's issues updated since the last sync (plus an overlap)
 * and merges them into the list, instead of reloading up to 500 issues. Falls back to a full
 * reload when due (every 10 minutes, to catch deletions), when "mine" can't be evaluated yet,
 * or when too much changed. Resolves to the issues the delta returned ([] after a full reload).
 */
export async function syncList() {
  if (fullLoad) await fullLoad;  // let a running reload land first; the delta then covers what it missed
  const now = Date.now();
  const view = viewFilter();
  const plan = syncPlan({ now, lastFull: state.lastFull, lastSync: state.lastSync, canDelta: view.who !== "mine" || !!view.meId });
  if (plan === "full") { await loadList(); return []; }
  const seq = listSeq;
  const dseq = ++deltaSeq;
  try {
    const page = await jira.searchPage(deltaJql(state.cfg.project, deltaMinutes(state.lastSync, now)), { maxResults: DELTA_PAGE });
    if (seq !== listSeq || dseq !== deltaSeq) return [];  // superseded
    if (page.nextPageToken && !page.isLast) { await loadList(); return []; }  // a burst of changes: reload
    // Filters may have changed while the request ran; such a change also starts a full load (caught above).
    const r = mergeDelta(state.issues, page.issues || [], (i) => matchesView(i, view));
    state.lastSync = now;
    if (r.changed) {
      state.issues = r.issues;
      renderMain();
    }
    stamp();
    return page.issues || [];
  } catch (e) {
    if (dseq === deltaSeq && !e.loginRequired) toast("Couldn't refresh tickets: " + e.message, true);
    return [];
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

/** True unless a write is in flight, a menu is open, or the app is signed out. */
const canRefresh = () => !state.busy && !activeMenu() && !state.signedOut;

/** Reloads the open detail panel unless the user is typing in it. */
function reloadDetail() {
  const a = document.activeElement;
  if (state.current && !(typingIn(a) && a.closest("#detail"))) actions.loadDetail();
}

/** Manual refresh (r, the header button, the palette): full reload of the list and the detail panel. */
export function refresh() {
  if (!canRefresh()) return;
  loadList();
  reloadDetail();
}

/**
 * Timed refresh: a delta sync (or the periodic full reload). The detail panel is reloaded only
 * when the open issue, or one of its children, shows up in the delta.
 */
export async function autoRefresh() {
  if (!canRefresh()) return;
  const full = state.lastFull;
  const delta = await syncList();
  const cur = state.current;
  if (!cur) return;
  const touched = delta.some((i) => i.key === cur || (i.fields && i.fields.parent && i.fields.parent.key === cur));
  if (touched || state.lastFull !== full) reloadDetail();
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
