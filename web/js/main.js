// Entry point: wires the modules together, restores preferences, loads data, starts auto-refresh.
import * as jira from "./api.js";
import { state, loadPrefs } from "./state.js";
import { $, toast } from "./dom.js";
import { wire } from "./actions.js";
import { renderSide, whoLabel, setWho } from "./sidebar.js";
import { loadList, renderMain, setView, toggleDone, refresh, bindHeader } from "./views.js";
import { loadStatuses } from "./board.js";
import { openIssue, closeDetail, loadDetail } from "./detail.js";
import { openCreate } from "./create.js";
import { installKeyboard } from "./keyboard.js";

const REFRESH_MS = 60000;

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

async function init() {
  wire({ openIssue, closeDetail, loadDetail, loadList, renderMain, openCreate, setWho, setView, toggleDone, refresh });
  try { state.cfg = { ...state.cfg, ...(await jira.getConfig()) }; } catch (e) { /* keep defaults */ }
  document.title = "jira-lite · " + state.cfg.project;
  loadPrefs();
  bindHeader();
  installKeyboard();
  setInterval(() => { if (!document.hidden) refresh(); }, REFRESH_MS);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && Date.now() - state.lastRefresh > REFRESH_MS) refresh();
  });
  renderSide();
  setView(state.view);
  $("#title").textContent = whoLabel();
  loadList();
  // Statuses only shape the board's columns; re-render once they arrive if the board is showing.
  loadStatuses().then(() => { if (state.view === "board") renderMain(); });
  loadPeople();
  jira.getMyself().then((u) => { state.me = u; }).catch(() => {});
  jira.getPriorities().then((p) => { state.priorities = p; }).catch(() => {});
  if (location.hash.length > 1) openIssue(decodeURIComponent(location.hash.slice(1)));
}

init();
