// Application state, shared by reference between modules, plus localStorage-backed preferences.
import { GROUPINGS, ORDERINGS } from "./issues.js";
import { parseViews } from "./savedviews.js";

export const state = {
  /** Server config from /config. */
  cfg: { project: "BA", site: "" },

  // ---- data loaded from Jira ----
  me: null,                 // the signed-in Jira user
  people: [],               // assignable users, sorted by name
  priorities: [],           // [{id, name}]
  issueTypes: [],           // from createmeta
  statuses: [],             // the project's statuses, de-duplicated (board columns)
  issues: [],               // the current list
  known: new Map(),         // key -> issue, for issues opened outside the list (children, search hits)

  // ---- view state ----
  visible: [],              // keys shown, in order (for j/k)
  current: null,            // key of the issue open in the detail panel
  cursor: null,             // key of the row/card highlighted by keyboard or mouse
  busy: false,              // a write is in flight; skip auto-refresh
  loaded: false,            // the current list has loaded at least once (until then: a skeleton)
  loadError: "",            // why the last full load failed while nothing was loaded
  lastSync: 0,              // start time of the last successful list sync (full or delta)
  lastFull: 0,              // start time of the last successful full reload
  signedOut: false,         // the sign-in screen is up; no more requests or auto-refresh
  selected: new Set(),      // keys multi-selected for bulk edits (x, shift+click, ⌘A)
  selAnchor: null,          // where a shift-range starts
  selBase: new Set(),       // the selection a shift-range extends
  epics: [],                // sidebar epics: [{key, summary, status, done, total}]
  epicsState: "",           // "" (not loaded) | "loading" | "ok" | "error"
  epicInfo: new Map(),      // epic key -> {key, summary}, also for epics not in the sidebar

  // ---- preferences (persisted) ----
  who: "mine",              // "mine" | "all" | accountId
  showDone: false,          // Display › Show completed
  collapsed: new Set(),     // collapsed list groups (status name, or "assignee:…" / "priority:…")
  view: "list",             // "list" | "board"
  grouping: "status",       // Display › Grouping (list only), one of GROUPINGS
  ordering: "updated",      // Display › Ordering (within groups and board columns), one of ORDERINGS
  showSubProgress: true,    // Display › Show sub-issue progress
  boardEmpty: false,        // show the board's empty columns
  sideHidden: false,        // sidebar collapsed (wide screens)
  peopleOpen: true,         // sidebar People section expanded
  recentPeople: [],         // accountIds picked in the sidebar, most recent first
  epic: null,               // an epic's key: the main view shows its children (overrides who)
  epicsOpen: true,          // sidebar Epics section expanded
  viewsOpen: true,          // sidebar Views section expanded
  savedViews: [],           // saved views (see savedviews.js)
  activeView: null,         // id of the saved view last applied, until another view is picked
  hiddenStatuses: new Set(), // status ids unticked in Display › Statuses (hidden in list and board)
  detailWidth: 0,           // the detail panel's width in px when resized by hand (0: default)
  filter: "",               // free-text filter (not persisted)
};

const PREFIX = "jl.";

/** Writes a preference; storage may be unavailable (private mode), which is ignored. */
export function store(k, v) {
  try { localStorage.setItem(PREFIX + k, v); } catch (e) { /* storage unavailable */ }
}

/** Reads a preference, or null. */
export function recall(k) {
  try { return localStorage.getItem(PREFIX + k); } catch (e) { return null; }
}

/**
 * Per-tab scratch storage (sessionStorage) for drafts that must survive the sign-in round trip
 * to Atlassian. `stash(k, null)` removes; `unstash(k)` reads and removes. Failures are ignored.
 */
export function stash(k, v) {
  try {
    if (v == null) sessionStorage.removeItem(PREFIX + k);
    else sessionStorage.setItem(PREFIX + k, v);
  } catch (e) { /* storage unavailable */ }
}

export function unstash(k) {
  try {
    const v = sessionStorage.getItem(PREFIX + k);
    sessionStorage.removeItem(PREFIX + k);
    return v;
  } catch (e) { return null; }
}

/** Parses a stored JSON array, or returns []. */
function recallList(k) {
  try {
    const v = JSON.parse(recall(k) || "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch (e) { return []; }
}

/** Restores persisted preferences into `state`. */
export function loadPrefs() {
  const oneOf = (v, allowed) => (allowed.includes(v) ? v : allowed[0]);
  state.who = recall("who") || "mine";
  state.showDone = recall("showDone") === "1";
  state.view = recall("view") === "board" ? "board" : "list";
  state.collapsed = new Set(recallList("collapsed"));
  state.grouping = oneOf(recall("grouping"), GROUPINGS);
  state.ordering = oneOf(recall("ordering"), ORDERINGS);
  state.showSubProgress = recall("subProgress") !== "0";
  state.boardEmpty = recall("boardEmpty") === "1";
  state.sideHidden = recall("sideHidden") === "1";
  state.peopleOpen = recall("peopleOpen") !== "0";
  state.recentPeople = recallList("recentPeople");
  state.epic = recall("epic") || null;
  state.epicsOpen = recall("epicsOpen") !== "0";
  state.viewsOpen = recall("viewsOpen") !== "0";
  state.detailWidth = Number(recall("detailWidth")) || 0;
  state.hiddenStatuses = new Set(recallList("hiddenStatuses"));
  state.savedViews = parseViews(recall("savedViews"));
  const active = state.savedViews.find((v) => v.id === recall("activeView"));
  state.activeView = active ? active.id : null;
  if (active) state.filter = active.filter;
}

/** The issue with this key from the list or from issues opened elsewhere. */
export function issueByKey(key) {
  return state.issues.find((i) => i.key === key) || state.known.get(key) || null;
}
