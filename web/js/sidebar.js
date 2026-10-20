// Sidebar: workspace, My/All issues, the collapsible People section, the signed-in user (OAuth)
// and the shortcuts help button. Also owns the "whose issues" selection and collapsing the
// sidebar (a slide-in drawer on narrow screens).
import { state, store } from "./state.js";
import { $, el, icon, ICONS } from "./dom.js";
import { avatar, NAV_ICONS } from "./icons.js";
import { visiblePeople, pushRecent, PEOPLE_LIMIT } from "./people.js";
import { toggleHelp } from "./help.js";
import { actions } from "./actions.js";
import { oauthMode, signOut } from "./auth.js";

const NARROW = "(max-width: 760px)";
let peopleFilter = "";    // the People filter box (not persisted)
let showAllPeople = false;

/** Header title for the current selection. */
export function whoLabel() {
  if (state.who === "mine") return "My issues";
  if (state.who === "all") return "All issues";
  const p = state.people.find((u) => u.accountId === state.who);
  return p ? p.displayName : "Issues";
}

const nav = (value, label, ico) => el("button", {
  class: "nav" + (state.who === value ? " on" : ""), "aria-current": state.who === value ? "page" : null, onclick: () => setWho(value),
}, ico, el("span", {}, label));
const personNav = (u) => nav(u.accountId, u.displayName, avatar(u));

export function renderSide() {
  const { cfg, people } = state;
  const scroll = el("div", { class: "side-scroll" },
    nav("mine", "My issues", icon(16, NAV_ICONS.mine, "")),
    nav("all", "All issues", icon(16, NAV_ICONS.all, "")),
    people.length ? peopleSection() : null);
  const help = el("button", { class: "helpbtn", title: "Keyboard shortcuts (?)", "aria-label": "Keyboard shortcuts", onclick: toggleHelp }, "?");
  const me = oauthMode() && state.me ? userFooter(state.me) : null;
  $("#side").replaceChildren(
    el("div", { class: "ws" }, el("span", { class: "logo" }, cfg.project.slice(0, 2)), el("span", {}, "Jira · " + cfg.project)),
    scroll,
    el("div", { class: "side-foot" + (me ? " with-me" : "") }, me, help));
}

/** "People" header (collapsible), filter box, up to PEOPLE_LIMIT people and "Show all (N)". */
function peopleSection() {
  const open = state.peopleOpen;
  const head = el("button", { class: "side-h" + (open ? "" : " closed"), "aria-expanded": String(open), onclick: togglePeople },
    el("span", {}, "People"), icon(16, ICONS.chev, "chev"));
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

/** Switches to "mine", "all" or a person's accountId and reloads the list. */
export function setWho(value) {
  state.who = value;
  store("who", value);
  if (value !== "mine" && value !== "all") {
    state.recentPeople = pushRecent(state.recentPeople, value);
    store("recentPeople", JSON.stringify(state.recentPeople));
  }
  setDrawer(false);
  renderSide();
  $("#title").textContent = whoLabel();
  state.issues = [];
  state.loaded = false;
  state.loadError = "";
  actions.renderMain();
  actions.loadList();
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

/** Binds the header's sidebar toggle and the drawer's backdrop. */
export function bindSidebar() {
  $("#sideBtn").addEventListener("click", toggleSidebar);
  $("#scrim").addEventListener("click", closeDrawer);
  matchMedia(NARROW).addEventListener("change", () => setDrawer(false));
  applySide();
}
