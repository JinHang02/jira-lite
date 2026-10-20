// Entry point: wires the modules together, checks the sign-in (OAuth mode), restores preferences,
// loads data, starts auto-refresh.
import * as jira from "./api.js";
import { state, loadPrefs, unstash } from "./state.js";
import { $, toast } from "./dom.js";
import { wire } from "./actions.js";
import { renderSide, whoLabel, setWho, bindSidebar } from "./sidebar.js";
import { loadList, syncList, renderMain, setView, toggleDone, refresh, autoRefresh, bindHeader } from "./views.js";
import { loadStatuses } from "./board.js";
import { openIssue, closeDetail, loadDetail } from "./detail.js";
import { openCreate } from "./create.js";
import { loadPriorities } from "./meta.js";
import { installKeyboard } from "./keyboard.js";
import { oauthMode, showSignIn, requireLogin } from "./auth.js";
import { REFRESH_MS } from "./sync.js";

async function loadPeople() {
  try {
    const users = await jira.getAssignable(state.cfg.project);
    state.people = users.filter((u) => u.accountType === "atlassian").sort((a, b) => a.displayName.localeCompare(b.displayName));
    renderSide();
    $("#title").textContent = whoLabel();
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
  bindHeader();
  bindSidebar();
  installKeyboard();
  // Every minute, a delta sync (see views.syncList); a full reload every 10 minutes or on r.
  setInterval(() => { if (!document.hidden) autoRefresh(); }, REFRESH_MS);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && Date.now() - state.lastSync > REFRESH_MS) autoRefresh();
  });
  renderSide();
  setView(state.view);
  $("#title").textContent = whoLabel();
  loadList();
  // Statuses only shape the board's columns; re-render once they arrive if the board is showing.
  loadStatuses().then(() => { if (state.view === "board") renderMain(); });
  loadPeople();
  loadMe();
  loadPriorities().then((p) => { state.priorities = p; }).catch(() => {});
  // After a sign-in round trip, reopen the issue that was open when the session ended.
  const back = unstash("returnTo");
  const key = location.hash.length > 1 ? decodeURIComponent(location.hash.slice(1)) : back;
  if (key) openIssue(key);
}

async function init() {
  wire({ openIssue, closeDetail, loadDetail, loadList, renderMain, openCreate, setWho, setView, toggleDone, refresh, sync: syncList });
  jira.setLoginHandler(requireLogin);
  try { state.cfg = { ...state.cfg, ...(await jira.getConfig()) }; } catch (e) { /* keep defaults */ }
  if (state.cfg.auth !== "oauth") state.cfg.auth = "token";
  document.title = "jira-lite · " + state.cfg.project;
  if (oauthMode()) {
    let me;
    try { me = await jira.getAuthMe(); } catch (e) { me = undefined; /* unknown: let the Jira calls decide */ }
    if (me === null) return showSignIn();
    if (me && me.accountId) state.me = { accountId: me.accountId, displayName: me.displayName || "Me" };
  }
  startApp();
}

init();
