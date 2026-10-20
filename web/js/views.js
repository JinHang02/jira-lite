// The main pane: loads the issue list and renders it as list or board (or a skeleton / empty
// state); the header's controls.
import * as jira from "./api.js";
import { state, store } from "./state.js";
import { $, el, icon, ICONS, toast, typingIn } from "./dom.js";
import { buildJql, deltaJql, matchesView } from "./jql.js";
import { filterIssues, sortIssues } from "./issues.js";
import { syncPlan, deltaMinutes, mergeDelta, sinceLabel, REFRESH_MS } from "./sync.js";
import { renderList } from "./list.js";
import { renderBoard } from "./board.js";
import { toggleDisplay } from "./display.js";
import { isMac } from "./help.js";
import { activeMenu } from "./menu.js";
import { syncSelection } from "./selection.js";
import { actions } from "./actions.js";

const DELTA_PAGE = 100;
let listSeq = 0;      // bumped by every full load; a delta is dropped if one started meanwhile
let deltaSeq = 0;     // bumped by every delta; only the newest is applied
let fullLoad = null;  // the in-flight full load, if any

/** The current view's filters, as matchesView takes them. */
const viewFilter = () => ({ who: state.who, meId: state.me ? state.me.accountId : null, showDone: state.showDone, epic: state.epic });

/** Reloads the list (up to 500 issues) and re-renders. Older in-flight loads are discarded. */
export function loadList() {
  const p = fullReload();
  fullLoad = p;
  $("#refresh").classList.add("spin");
  p.finally(() => {
    if (fullLoad !== p) return;
    fullLoad = null;
    $("#refresh").classList.remove("spin");
  });
  return p;
}

async function fullReload() {
  const seq = ++listSeq;
  const { cfg, who, showDone, epic } = state;
  const started = Date.now();
  try {
    const out = await jira.searchAll(buildJql({ project: cfg.project, who, showDone, epic }));
    if (seq !== listSeq) return;  // a newer load started meanwhile
    state.issues = out;
    state.loaded = true;
    state.loadError = "";
    state.lastSync = state.lastFull = started;
    renderMain();
  } catch (e) {
    if (seq !== listSeq) return;
    toast("Couldn't load tickets: " + e.message, true);
    if (!state.loaded && !e.loginRequired) {
      state.loadError = e.message;
      renderMain();
    }
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
  const plan = syncPlan({ now, lastFull: state.lastFull, lastSync: state.lastSync, canDelta: !!view.epic || view.who !== "mine" || !!view.meId });
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
    return page.issues || [];
  } catch (e) {
    if (dseq === deltaSeq && !e.loginRequired) toast("Couldn't refresh tickets: " + e.message, true);
    return [];
  }
}

/** Re-renders the current view from state.issues, the filter and the Display options. */
export function renderMain() {
  const list = filterIssues(state.issues, state.filter);
  const n = state.issues.length;
  const filtering = !!state.filter.trim();
  $("#count").textContent = !state.loaded ? "" : filtering ? list.length + " / " + n : n ? String(n) : "";
  $(".qwrap").classList.toggle("active", filtering);
  const box = state.view === "board" ? $("#board") : $("#list");
  box.classList.toggle("is-empty", !state.loaded || !list.length);
  if (!state.loaded) {
    state.visible = [];
    box.replaceChildren(state.loadError ? errorState(state.loadError) : skeleton());
  } else if (!list.length) {
    state.visible = [];
    box.replaceChildren(emptyState(filtering));
  }
  let keys = [];
  if (state.loaded && list.length) {
    const sorted = sortIssues(list, state.ordering);
    keys = sorted.map((i) => i.key);
    if (state.view === "board") renderBoard(sorted);
    else renderList(sorted);
  }
  if (state.cursor && !state.visible.includes(state.cursor)) state.cursor = null;
  syncSelection(keys);
}

/** Placeholder rows while the first load is in flight (keeps the layout from jumping). */
function skeleton() {
  const widths = [62, 48, 71, 55, 66, 40, 58, 50];
  return el("div", { class: "skeleton", "aria-busy": "true", "aria-label": "Loading issues" },
    widths.map((w) => el("div", { class: "skel-row" }, el("span", { class: "skel dot" }), el("span", { class: "skel key" }),
      el("span", { class: "skel", style: "width:" + w + "%" }))));
}

const SEARCH_ICON = '<circle cx="14" cy="14" r="8.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M20.5 20.5L27 27" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>';
const INBOX_ICON = '<rect x="4" y="6" width="24" height="20" rx="5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M4 18h7l2 3h6l2-3h7" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>';

function blank(ico, title, sub, buttons) {
  return el("div", { class: "empty-state" }, icon(32, ico, "eicon"), el("h3", {}, title), sub ? el("p", {}, sub) : null,
    buttons.length ? el("div", { class: "eactions" }, buttons) : null);
}

/** No issues: either nothing matches the filter, or the view itself is empty. */
function emptyState(filtering) {
  if (filtering) {
    return blank(SEARCH_ICON, "No issues match “" + state.filter.trim() + "”", "Try another word, a key like BA-12, or a name.",
      [el("button", { class: "btn", onclick: () => { clearFilter(); $("#q").focus(); } }, "Clear filter")]);
  }
  const person = state.people.find((u) => u.accountId === state.who);
  const open = state.showDone ? "" : "open ";
  const epic = state.epic && (state.epicInfo.get(state.epic) || {}).summary;
  const title = state.epic ? "No " + open + "issues in " + (epic || state.epic)
    : state.who === "mine" ? "No " + open + "issues assigned to you"
    : state.who === "all" ? "No " + open + "issues in " + state.cfg.project
      : "No " + open + "issues assigned to " + (person ? person.displayName : "this person");
  const buttons = [el("button", { class: "btn", onclick: () => actions.openCreate(null) }, icon(14, ICONS.plus, ""), "New issue")];
  if (!state.showDone) buttons.push(el("button", { class: "btn", onclick: () => actions.toggleDone() }, "Show completed"));
  return blank(INBOX_ICON, title, el("span", {}, "Press ", el("kbd", {}, "C"), " to create one."), buttons);
}

function errorState(msg) {
  return blank(INBOX_ICON, "Couldn't load issues", msg, [el("button", { class: "btn", onclick: () => loadList() }, "Try again")]);
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

/** Display › Show completed: reloads with or without Done issues. */
export function toggleDone() {
  state.showDone = !state.showDone;
  store("showDone", state.showDone ? "1" : "0");
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
  actions.loadEpics();
}

/**
 * Timed refresh: a delta sync (or the periodic full reload). The detail panel is reloaded only
 * when the open issue, or one of its children, shows up in the delta.
 */
export async function autoRefresh() {
  if (!canRefresh()) return;
  const full = state.lastFull;
  const delta = await syncList();
  const fullReloaded = state.lastFull !== full;
  // Epic progress: refresh with the periodic full reload, or when an epic or an epic's child changed.
  const parentKey = (i) => (i.fields && i.fields.parent ? i.fields.parent.key : null);
  const isEpic = (i) => state.epicInfo.has(i.key) || ((i.fields && i.fields.issuetype) || {}).hierarchyLevel === 1;
  if (fullReloaded || delta.some((i) => isEpic(i) || state.epicInfo.has(parentKey(i)))) actions.loadEpics();
  const cur = state.current;
  if (!cur) return;
  const touched = delta.some((i) => i.key === cur || parentKey(i) === cur);
  if (touched || fullReloaded) reloadDetail();
}

/** Clears the free-text filter box. */
export function clearFilter() {
  $("#q").value = "";
  state.filter = "";
  renderMain();
}

/** The refresh button's tooltip: when the list last synced, and the auto-refresh interval. */
function refreshTitle() {
  const when = sinceLabel(state.lastSync);
  return "Refresh (R)\n" + (when ? "Updated " + when + " · " : "") + "auto every " + Math.round(REFRESH_MS / 1000) + " s";
}

/** Binds the header controls (view toggle, filter, display, refresh, new issue). */
export function bindHeader() {
  const rb = $("#refresh");
  const retitle = () => { rb.title = refreshTitle(); };
  rb.addEventListener("mouseenter", retitle);
  rb.addEventListener("focus", retitle);
  rb.addEventListener("click", refresh);
  $("#displayBtn").addEventListener("click", (e) => toggleDisplay(e.currentTarget, e.detail === 0));  // detail 0: Enter/Space
  $("#newBtn").addEventListener("click", () => actions.openCreate(null));
  $("#vList").addEventListener("click", () => setView("list"));
  $("#vBoard").addEventListener("click", () => setView("board"));
  $("#q").addEventListener("input", () => { state.filter = $("#q").value; renderMain(); });
  if (!isMac()) for (const b of document.querySelectorAll("#top [title*='⌘']")) b.title = b.title.replace("⌘", "Ctrl+");
}
