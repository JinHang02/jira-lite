// Application state, shared by reference between modules, plus localStorage-backed preferences.

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
  lastSync: 0,              // start time of the last successful list sync (full or delta)
  lastFull: 0,              // start time of the last successful full reload
  signedOut: false,         // the sign-in screen is up; no more requests or auto-refresh

  // ---- preferences (persisted) ----
  who: "mine",              // "mine" | "all" | accountId
  showDone: false,
  collapsed: new Set(),     // collapsed status-group names
  view: "list",             // "list" | "board"
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

/** Restores persisted preferences into `state`. */
export function loadPrefs() {
  state.who = recall("who") || "mine";
  state.showDone = recall("showDone") === "1";
  state.view = recall("view") === "board" ? "board" : "list";
  try { state.collapsed = new Set(JSON.parse(recall("collapsed") || "[]")); } catch (e) { /* keep default */ }
}

/** The issue with this key from the list or from issues opened elsewhere. */
export function issueByKey(key) {
  return state.issues.find((i) => i.key === key) || state.known.get(key) || null;
}
