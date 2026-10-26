// Entry point: wires the modules together, checks the sign-in (OAuth mode), restores preferences,
// loads data, starts auto-refresh.
import * as jira from "./api.js";
import { state, loadPrefs, unstash } from "./state.js";
import { $, toast } from "./dom.js";
import { wire } from "./actions.js";
import { renderSide, updateTitle, setWho, setEpic, applySavedView, saveView, loadEpics, bindSidebar } from "./sidebar.js";
import { loadList, renderMain, reconcile, setView, toggleDone, untickDone, refresh, autoRefresh, bindHeader } from "./views.js";
import { loadStatuses } from "./board.js";
import { openIssue, closeDetail, loadDetail } from "./detail.js";
import { openCreate } from "./create.js";
import { priorities } from "./meta.js";
import { installKeyboard } from "./keyboard.js";
import { bindResize } from "./resize.js";
import { showAllStatuses, applyDetailMode } from "./display.js";
import { oauthMode, showSignIn, requireLogin } from "./auth.js";
import { REFRESH_MS } from "./sync.js";

async function loadPeople() {
  try {
    const users = await jira.getAssignable(state.cfg.project);
    state.people = users.filter((u) => u.accountType === "atlassian").sort((a, b) => a.displayName.localeCompare(b.displayName));
    renderSide();
    updateTitle();
  } catch (e) {
    toast("Couldn't load people: " + e.message, true);
  }
}

/** The signed-in user: /auth/me already gave it in OAuth mode; the shared token's user otherwise. */
function loadMe() {
  if (state.me) return;
  jira.getMyself().then((u) => { state.me = u; }).catch(() => {});
}

function startApp() {
  loadPrefs();
  applyDetailMode();
  bindHeader();
  bindResize();
  $("#dscrim").addEventListener("click", closeDetail);  // dialog mode: a click outside closes it
  bindSidebar();
  installKeyboard();
  // Every minute, a delta sync (see views.syncList); a full reload every 10 minutes or on r.
  setInterval(() => { if (!document.hidden) autoRefresh(); }, REFRESH_MS);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && Date.now() - state.lastSync > REFRESH_MS) autoRefresh();
  });
  renderSide();
  $("#q").value = state.filter;  // a saved view's filter, when one is active
  setView(state.view);
  updateTitle();
  loadList();
  loadEpics();
  // Statuses only shape the board's columns; re-render once they arrive if the board is showing.
  loadStatuses().then(() => { if (state.view === "board") renderMain(); });
  loadPeople();
  loadMe();
  priorities().then((p) => { state.priorities = p; }).catch(() => {});
  // After a sign-in round trip, reopen the issue that was open when the session ended.
  const back = unstash("returnTo");
  const key = hashKey() || back;
  if (key) openIssue(key);
  // A pasted link or Back/Forward changes the hash while the app is open: follow it.
  // (openIssue/closeDetail use replaceState, which doesn't fire hashchange, so this can't loop.)
  window.addEventListener("hashchange", () => {
    const k = hashKey();
    if (k && k !== state.current) openIssue(k);
    else if (!k && state.current) closeDetail();
  });
}

/** The issue key in the URL hash ("#BA-12"), or "" when the hash isn't one. */
function hashKey() {
  let h = "";
  try { h = decodeURIComponent(location.hash.slice(1)); } catch (e) { return ""; }
  return /^[A-Z][A-Z0-9_]*-\d+$/i.test(h) ? h.toUpperCase() : "";
}

async function init() {
  wire({
    openIssue, closeDetail, loadDetail, loadList, renderMain, openCreate, setWho, setView, toggleDone, refresh,
    setEpic, applySavedView, saveView, loadEpics, showAllStatuses, untickDone, reconcile,
  });
  jira.setLoginHandler(requireLogin);
  try { state.cfg = { ...state.cfg, ...(await jira.getConfig()) }; } catch (e) { /* keep defaults */ }
  if (state.cfg.auth !== "oauth") state.cfg.auth = "token";
  document.title = "jira-lite";
  if (oauthMode()) {
    let me;
    try { me = await jira.getAuthMe(); } catch (e) { me = undefined; /* unknown: let the Jira calls decide */ }
    if (me === null) return showSignIn();
    if (me && me.accountId) state.me = { accountId: me.accountId, displayName: me.displayName || "Me" };
  }
  startApp();
}

init();
