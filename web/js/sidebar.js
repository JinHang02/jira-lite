// Sidebar: workspace, My/All issues, saved Views, open Epics, the collapsible People section, the
// signed-in user (OAuth) and the shortcuts help button. Also owns what the main view shows
// (whose issues, an epic's children or a saved view), the header title, and collapsing the
// sidebar (a slide-in drawer on narrow screens).
import * as jira from "./api.js";
import { state, store } from "./state.js";
import { $, el, icon, ICONS, toast } from "./dom.js";
import { avatar, NAV_ICONS, logo } from "./icons.js";
import { visiblePeople, pushRecent, PEOPLE_LIMIT } from "./people.js";
import { epicsJql, epicChildrenJql, chunk, epicProgress, epicEntries, visibleEpics, ringDash, EPIC_LIMIT } from "./epics.js";
import { addView, renameView, deleteView, applyView, serializeViews } from "./savedviews.js";
import { openMenu } from "./menu.js";
import { toggleHelp } from "./help.js";
import { actions } from "./actions.js";
import { oauthMode, signOut } from "./auth.js";
import { withWrites } from "./edits.js";

const NARROW = "(max-width: 760px)";
const VIEW_ICON = '<path d="M8 2.25l5.75 3L8 8.25l-5.75-3z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="M2.25 8.25L8 11.25l5.75-3M2.25 10.75L8 13.75l5.75-3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>';
const DOTS = '<circle cx="3" cy="7" r="1.1" fill="currentColor"/><circle cx="7" cy="7" r="1.1" fill="currentColor"/><circle cx="11" cy="7" r="1.1" fill="currentColor"/>';
const RING_R = 5.25;
const RING_C = 2 * Math.PI * RING_R;
let peopleFilter = "";    // the People filter box (not persisted)
let showAllPeople = false;
let showAllEpics = false;
let renaming = null;      // {id, draft}: the saved view being renamed inline
let epicsSeq = 0;

// ---- what the main view shows ----

/** Header title for "mine" / "all" / a person. */
export function whoLabel() {
  if (state.who === "mine") return "My issues";
  if (state.who === "all") return "All issues";
  const p = state.people.find((u) => u.accountId === state.who);
  return p ? p.displayName : "Issues";
}

const activeSaved = () => state.savedViews.find((v) => v.id === state.activeView) || null;

/** The epic's name, or its key until the name is known. */
export const epicName = (key) => (state.epicInfo.get(key) || {}).summary || key;

/** Header title: the saved view's name, the epic's name, or whose issues. */
export function titleLabel() {
  const v = activeSaved();
  if (v) return v.name;
  if (state.epic) return epicName(state.epic);
  return whoLabel();
}

/** Sets the header title and shows the "Open epic" link while an epic is shown. */
export function updateTitle() {
  const t = $("#title");
  const person = state.people.find((u) => u.accountId === state.who);
  const glyph = state.epic || activeSaved() ? null
    : state.who === "mine" || state.who === "all" ? icon(16, NAV_ICONS[state.who], "ticon-nav") : avatar(person || { displayName: whoLabel(), accountId: state.who });
  t.replaceChildren(...[glyph, el("span", { class: "tlabel" }, titleLabel()), icon(12, ICONS.chev, "tchev")].filter(Boolean));
  const link = $("#epicLink");
  if (!link) return;
  link.hidden = !state.epic;
  link.title = state.epic ? "Open " + state.epic + " · " + epicName(state.epic) : "";
}

/** The title's menu: My issues, All issues and everyone (with avatars, searchable); picking one shows their issues. */
export function whoMenu(anchor) {
  const { me } = state;
  const people = [...state.people].sort((a, b) => a.displayName.localeCompare(b.displayName));
  const cur = state.epic || activeSaved() ? null : state.who;
  const items = [
    { id: "mine", label: "My issues", icon: icon(16, NAV_ICONS.mine, ""), current: cur === "mine" },
    { id: "all", label: "All issues", icon: icon(16, NAV_ICONS.all, ""), current: cur === "all" },
    ...people.map((u) => ({ id: u.accountId, label: u.displayName + (me && u.accountId === me.accountId ? " (me)" : ""), icon: avatar(u), current: cur === u.accountId })),
  ];
  openMenu(anchor, "Show issues of", items, (it) => { if (!it.current) setWho(it.id); }, { search: true });
}

/** Fetches an epic's summary for the title when the sidebar doesn't list it (closed, or > 50). */
function ensureEpicInfo(key) {
  if (!key || state.epicInfo.has(key)) return;
  jira.getIssue(key, ["summary"]).then((i) => {
    state.epicInfo.set(key, { key, summary: i.fields.summary });
    updateTitle();
  }).catch(() => {});
}

/** Empties the list (skeleton), re-renders the chrome and reloads for the new selection. */
function reload() {
  state.selected = new Set();
  state.selAnchor = null;
  state.issues = [];
  state.loaded = false;
  state.loadError = "";
  setDrawer(false);
  renderSide();
  updateTitle();
  actions.renderMain();
  actions.loadList();
}

/** Navigating away from a saved view: its free-text filter goes with it. */
function leaveSaved() {
  if (state.activeView && state.filter) {
    state.filter = "";
    $("#q").value = "";
  }
  state.activeView = null;
  store("activeView", "");
}

/** Switches to "mine", "all" or a person's accountId and reloads the list. */
export function setWho(value) {
  state.who = value;
  store("who", value);
  state.epic = null;
  store("epic", "");
  leaveSaved();
  if (value !== "mine" && value !== "all") {
    state.recentPeople = pushRecent(state.recentPeople, value);
    store("recentPeople", JSON.stringify(state.recentPeople));
  }
  reload();
}

/** Shows an epic's children (any assignee) and reloads the list. */
export function setEpic(key) {
  state.epic = key;
  store("epic", key);
  leaveSaved();
  ensureEpicInfo(key);
  reload();
}

/** Applies a saved view: its selection, Display options, filter and list/board, then reloads. */
export function applySavedView(id) {
  const v = state.savedViews.find((x) => x.id === id);
  if (!v) return;
  const s = applyView(v);
  state.activeView = v.id;
  store("activeView", v.id);
  Object.assign(state, { who: s.who, epic: s.epic, showDone: s.showDone, grouping: s.grouping, ordering: s.ordering, filter: s.filter });
  store("who", s.who);
  store("epic", s.epic || "");
  store("showDone", s.showDone ? "1" : "0");
  if (s.showDone) actions.untickDone(false);
  store("grouping", s.grouping);
  store("ordering", s.ordering);
  $("#q").value = s.filter;
  ensureEpicInfo(s.epic);
  state.view = s.view;  // setView (inside reload's render) would render the old list first
  reload();
  actions.setView(s.view);
}

// ---- saved views ----

function persistViews() {
  store("savedViews", serializeViews(state.savedViews));
}

/** Saves the current settings as a new view (name made unique) and makes it the active one. */
export function saveView(name) {
  const { views, view } = addView(state.savedViews, state, name);
  state.savedViews = views;
  persistViews();
  state.activeView = view.id;
  store("activeView", view.id);
  if (!state.viewsOpen) toggleViews();
  renderSide();
  updateTitle();
  toast("Saved view “" + view.name + "”");
}

function commitRename(id, name) {
  const before = state.savedViews;
  state.savedViews = renameView(before, id, name);
  if (state.savedViews !== before) persistViews();
  renderSide();
  updateTitle();
  const b = $('#side .nav[data-view="' + CSS.escape(id) + '"]');
  if (b) b.focus({ preventScroll: true });
}

function removeView(id) {
  const v = state.savedViews.find((x) => x.id === id);
  state.savedViews = deleteView(state.savedViews, id);
  persistViews();
  if (state.activeView === id) {
    leaveSaved();
    actions.renderMain();
  }
  renderSide();
  updateTitle();
  if (v) toast("Deleted view “" + v.name + "”");
}

function toggleViews() {
  state.viewsOpen = !state.viewsOpen;
  store("viewsOpen", state.viewsOpen ? "1" : "0");
  renderSide();
}

// ---- epics ----

/**
 * Loads the project's open epics (one search, at most 50) and their children's progress (one
 * `parent in (...)` search per 50 epics, status and parent only), then re-renders the sidebar.
 */
export async function loadEpics() {
  const seq = ++epicsSeq;
  if (!state.epics.length) {
    state.epicsState = "loading";
    renderSide();
  }
  try {
    const page = await jira.searchPage(epicsJql(state.cfg.project), { fields: ["summary", "status"], maxResults: EPIC_LIMIT });
    // Search lags behind our own writes: let the fresh copies of written issues win (overlay.js).
    const openEpic = (i) => ((i.fields.issuetype || {}).hierarchyLevel === 1) && ((i.fields.status || {}).statusCategory || {}).key !== "done";
    const epics = await withWrites(page.issues || [], openEpic);
    const keys = epics.map((e) => e.key);
    let kids = [];
    const partial = new Set();  // epics whose children were cut off at the page limit
    for (const part of chunk(keys)) {
      const r = await jira.searchPages(epicChildrenJql(part), { fields: ["status", "parent"] });
      kids.push(...r.issues);
      if (r.more) part.forEach((k) => partial.add(k));
    }
    kids = await withWrites(kids, (i) => !!i.fields.parent && keys.includes(i.fields.parent.key));
    if (seq !== epicsSeq) return;
    state.epics = epicEntries(epics, epicProgress(keys, kids), partial);
    for (const e of state.epics) state.epicInfo.set(e.key, { key: e.key, summary: e.summary });
    state.epicsState = "ok";
    if (state.loaded) actions.renderMain();  // epic rows' "2/5" badges count these children
  } catch (e) {
    if (seq !== epicsSeq) return;
    state.epicsState = state.epics.length ? "ok" : "error";
  }
  renderSide();
  updateTitle();
}

function toggleEpics() {
  state.epicsOpen = !state.epicsOpen;
  store("epicsOpen", state.epicsOpen ? "1" : "0");
  renderSide();
}

/** Progress ring (done / total children), 16px. */
function ring(done, total) {
  const base = '<circle cx="8" cy="8" r="' + RING_R + '" fill="none" stroke="currentColor" stroke-width="1.6" stroke-opacity=".35"/>';
  const arc = done ? '<circle cx="8" cy="8" r="' + RING_R + '" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-dasharray="' +
    ringDash(done, total, RING_C) + '" transform="rotate(-90 8 8)"/>' : "";
  return icon(16, base + arc, "ering" + (total && done >= total ? " full" : ""));
}

// ---- rendering ----

const navOn = (who) => !state.activeView && !state.epic && state.who === who;

const nav = (value, label, ico) => el("button", {
  class: "nav" + (navOn(value) ? " on" : ""), "aria-current": navOn(value) ? "page" : null, onclick: () => setWho(value),
}, ico, el("span", {}, label));
const personNav = (u) => nav(u.accountId, u.displayName, avatar(u));

/** A collapsible section header. */
const sectionHead = (label, open, onToggle) => el("button", { class: "side-h" + (open ? "" : " closed"), "aria-expanded": String(open), onclick: onToggle },
  el("span", {}, label), icon(16, ICONS.chev, "chev"));

export function renderSide() {
  const { people } = state;
  const scroll = el("div", { class: "side-scroll" },
    nav("mine", "My issues", icon(16, NAV_ICONS.mine, "")),
    nav("all", "All issues", icon(16, NAV_ICONS.all, "")),
    viewsSection(),
    epicsSection(),
    people.length ? peopleSection() : null);
  const help = el("button", { class: "helpbtn", title: "Keyboard shortcuts (?)", "aria-label": "Keyboard shortcuts", onclick: toggleHelp }, "?");
  const me = oauthMode() && state.me ? userFooter(state.me) : null;
  const old = $("#side .side-scroll");
  const top = old ? old.scrollTop : 0;
  $("#side").replaceChildren(
    el("div", { class: "ws" }, logo(20), el("span", {}, "jira-lite")),
    scroll,
    el("div", { class: "side-foot" + (me ? " with-me" : "") }, me, help));
  scroll.scrollTop = top;
  const rename = renaming && $("#side .nav-rename");
  if (rename) rename.focus({ preventScroll: true });  // a re-render (e.g. epics refreshed) mid-rename keeps the box
}

/** "Views": saved views, each with a ⋯ menu (rename inline, delete). */
function viewsSection() {
  const open = state.viewsOpen;
  const head = sectionHead("Views", open, toggleViews);
  if (!open) {
    const v = activeSaved();
    return el("div", { class: "side-sec views" }, head, v ? viewItem(v) : null);
  }
  const items = state.savedViews.map(viewItem);
  return el("div", { class: "side-sec views" }, head,
    items.length ? items : el("div", { class: "side-note" }, "Save the current view from Display."));
}

function viewItem(v) {
  if (renaming && renaming.id === v.id) return renameRow(v);
  const on = state.activeView === v.id;
  const go = el("button", { class: "nav" + (on ? " on" : ""), "aria-current": on ? "page" : null, "data-view": v.id, title: v.name, onclick: () => applySavedView(v.id) },
    icon(16, VIEW_ICON, ""), el("span", {}, v.name));
  const more = el("button", { class: "nav-more", title: "View options", "aria-label": "Options for view " + v.name, "aria-haspopup": "menu" }, icon(14, DOTS, ""));
  more.addEventListener("click", (e) => {
    e.stopPropagation();
    openMenu(more, v.name, [{ id: "rename", label: "Rename" }, { id: "delete", label: "Delete" }], (it) => {
      if (it.id === "delete") return removeView(v.id);
      renaming = { id: v.id, draft: v.name };
      renderSide();
      const input = $("#side .nav-rename");
      if (input) { input.focus(); input.select(); }
    });
  });
  return el("div", { class: "nav-item" + (on ? " on" : "") }, go, more);
}

/** The inline rename box: Enter or blur saves, Esc cancels. */
function renameRow(v) {
  const input = el("input", { class: "nav-rename", "aria-label": "View name", maxlength: "60", spellcheck: "false", autocomplete: "off" });
  input.value = renaming.draft;
  let done = false;
  const finish = (save) => {
    if (done) return;
    done = true;
    renaming = null;
    if (save) commitRename(v.id, input.value);
    else {
      renderSide();
      const b = $('#side .nav[data-view="' + CSS.escape(v.id) + '"]');
      if (b) b.focus({ preventScroll: true });
    }
  };
  input.addEventListener("input", () => { if (renaming) renaming.draft = input.value; });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); finish(true); }
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); finish(false); }
  });
  input.addEventListener("blur", () => finish(true));
  return el("div", { class: "nav-item renaming" }, icon(16, VIEW_ICON, ""), input);
}

/** "Epics": the project's open epics with a progress ring; first 8, "Show all (N)". */
function epicsSection() {
  const open = state.epicsOpen;
  const head = sectionHead("Epics", open, toggleEpics);
  if (!open) {
    const sel = state.epic && !state.activeView ? state.epics.find((e) => e.key === state.epic) : null;
    return el("div", { class: "side-sec epics" }, head, sel ? epicNav(sel) : null);
  }
  let body;
  if (state.epicsState === "loading" && !state.epics.length) body = el("div", { class: "side-note" }, "Loading…");
  else if (state.epicsState === "error") body = el("button", { class: "side-note link", onclick: () => loadEpics() }, "Couldn't load epics · Retry");
  else if (!state.epics.length) body = state.epicsState === "ok" ? el("div", { class: "side-note" }, "No open epics") : null;
  else {
    const { shown } = visibleEpics(state.epics, { selected: state.epic, showAll: showAllEpics });
    const many = state.epics.length > shown.length || showAllEpics;
    body = [shown.map(epicNav), many ? el("button", { class: "nav more", onclick: () => { showAllEpics = !showAllEpics; renderSide(); } },
      el("span", {}, showAllEpics ? "Show fewer" : "Show all (" + state.epics.length + ")")) : null];
  }
  return el("div", { class: "side-sec epics" }, head, body);
}

function epicNav(e) {
  const on = !state.activeView && state.epic === e.key;
  return el("button", {
    class: "nav epic" + (on ? " on" : ""), "aria-current": on ? "page" : null, "data-epic": e.key,
    title: e.key + " · " + e.summary + (e.total ? " — " + e.done + " of " + e.total + " done" : " — no child issues"), onclick: () => setEpic(e.key),
  }, ring(e.done, e.total), el("span", { class: "ename" }, e.summary), el("span", { class: "frac" }, e.total ? e.done + "/" + e.total + (e.more ? "+" : "") : ""));
}

/** "People" header (collapsible), filter box, up to PEOPLE_LIMIT people and "Show all (N)". */
function peopleSection() {
  const open = state.peopleOpen;
  const head = sectionHead("People", open, togglePeople);
  if (!open) {  // collapsed: still show the selected person
    const sel = state.people.find((u) => u.accountId === state.who);
    return el("div", { class: "people" }, head, sel ? personNav(sel) : null);
  }
  const many = state.people.length > PEOPLE_LIMIT;
  const list = el("div", { class: "plist-side" });
  const fill = () => {
    const { shown } = visiblePeople(state.people, { selected: state.who, recent: state.recentPeople, filter: peopleFilter, showAll: showAllPeople });
    const more = many && !peopleFilter.trim()
      ? el("button", { class: "nav more", onclick: () => { showAllPeople = !showAllPeople; renderSide(); } },
        el("span", {}, showAllPeople ? "Show fewer" : "Show all (" + state.people.length + ")"))
      : null;
    list.replaceChildren(...shown.map(personNav), ...(shown.length ? [] : [el("div", { class: "side-note" }, "No matches")]), ...(more ? [more] : []));
  };
  let filter = null;
  if (many) {
    filter = el("input", { class: "pfilter", placeholder: "Filter people…", "aria-label": "Filter people", autocomplete: "off", spellcheck: "false", value: peopleFilter });
    filter.addEventListener("input", () => { peopleFilter = filter.value; fill(); });
    filter.addEventListener("keydown", (e) => { if (e.key === "Escape" && filter.value) { e.stopPropagation(); filter.value = peopleFilter = ""; fill(); } });
  }
  fill();
  return el("div", { class: "people" }, head, filter, list);
}

function togglePeople() {
  state.peopleOpen = !state.peopleOpen;
  store("peopleOpen", state.peopleOpen ? "1" : "0");
  renderSide();
}

/** Avatar, name and "Sign out" for the signed-in Atlassian user. */
function userFooter(me) {
  return el("div", { class: "me", title: "Signed in as " + me.displayName },
    avatar(me), el("span", { class: "name" }, me.displayName),
    el("button", { class: "link", id: "signOut", onclick: signOut }, "Sign out"));
}

// ---- collapsing ----

const narrow = () => matchMedia(NARROW).matches;

/** Opens or closes the slide-in sidebar on narrow screens. */
function setDrawer(open) {
  document.body.classList.toggle("side-open", open);
  applySide();
  if (open) {
    const on = $("#side .nav.on") || $("#side .nav");
    if (on) on.focus({ preventScroll: true });
  }
}

/** Applies state.sideHidden (wide screens) to the page and the header toggle. */
export function applySide() {
  document.body.classList.toggle("side-hidden", state.sideHidden);
  const b = $("#sideBtn");
  if (b) b.setAttribute("aria-expanded", String(narrow() ? document.body.classList.contains("side-open") : !state.sideHidden));
}

/** [ or the header button: collapse/expand the sidebar (remembered), or slide it in on a phone. */
export function toggleSidebar() {
  if (narrow()) return setDrawer(!document.body.classList.contains("side-open"));
  state.sideHidden = !state.sideHidden;
  store("sideHidden", state.sideHidden ? "1" : "0");
  applySide();
}

/** Closes the narrow-screen drawer; true if it was open. */
export function closeDrawer() {
  if (!document.body.classList.contains("side-open")) return false;
  setDrawer(false);
  const b = $("#sideBtn");
  if (b) b.focus({ preventScroll: true });
  return true;
}

/** Binds the header's sidebar toggle, the drawer's backdrop and the "Open epic" link. */
export function bindSidebar() {
  $("#title").addEventListener("click", (e) => whoMenu(e.currentTarget));
  $("#sideBtn").addEventListener("click", toggleSidebar);
  $("#scrim").addEventListener("click", closeDrawer);
  $("#epicLink").addEventListener("click", () => { if (state.epic) actions.openIssue(state.epic); });
  matchMedia(NARROW).addEventListener("change", () => setDrawer(false));
  applySide();
  ensureEpicInfo(state.epic);
}
