// The header's Display popover: grouping, ordering, show sub-issue progress, show empty columns
// (board), which statuses to show (ticks; ticking Done/Canceled also fetches completed issues),
// and "Save view…" (the name prompt for a saved view).
import { state, store } from "./state.js";
import { $, el, icon, ICONS } from "./dom.js";
import { compareStatuses, BOARD_ORDER } from "./status.js";
import { statusIcon } from "./icons.js";
import { uniqueName } from "./savedviews.js";
import { openPopover, closeMenu, activeMenu } from "./menu.js";
import { actions } from "./actions.js";

const GROUP_LABELS = { status: "Status", assignee: "Assignee", priority: "Priority", component: "Component", none: "No grouping" };
// On the board the columns are already statuses, so "None" is the plain board; others add a row per group.
const BOARD_GROUP_LABELS = { status: "None", assignee: "Assignee", priority: "Priority", component: "Component" };
const ORDER_LABELS = { updated: "Last updated", priority: "Priority", created: "Created" };

/** Sets a Display option (grouping / ordering / showSubProgress / boardEmpty), persists it and re-renders. */
export function setDisplay(key, value) {
  state[key] = value;
  store({ grouping: "grouping", ordering: "ordering", showSubProgress: "subProgress", boardEmpty: "boardEmpty" }[key], typeof value === "boolean" ? (value ? "1" : "0") : value);
  actions.renderMain();
}

/** The project's statuses in board order (or the ones seen on issues if those didn't load). */
function allStatuses() {
  const byId = new Map();
  for (const s of state.statuses.length ? state.statuses : state.issues.map((i) => i.fields.status)) if (s && !byId.has(String(s.id))) byId.set(String(s.id), s);
  return [...byId.values()].sort((a, b) => compareStatuses(a, b, BOARD_ORDER));
}

const isDoneCat = (s) => ((s && s.statusCategory) || {}).key === "done";
const saveHidden = () => store("hiddenStatuses", JSON.stringify([...state.hiddenStatuses]));

/** Whether a status is ticked: not hidden, and for Done/Canceled-like ones only while completed issues are fetched. */
const ticked = (s) => !state.hiddenStatuses.has(String(s.id)) && (!isDoneCat(s) || state.showDone);

/**
 * Ticks one status on or off in Display › Statuses. Completed issues are only fetched while a
 * done-category status is ticked: ticking the first one fetches them (showing just that status),
 * unticking the last one stops fetching. Returns a promise when it reloads.
 */
function toggleStatus(s) {
  const id = String(s.id);
  const h = state.hiddenStatuses;
  const doneIds = allStatuses().filter(isDoneCat).map((x) => String(x.id));
  if (!isDoneCat(s)) {
    if (h.has(id)) h.delete(id);
    else h.add(id);
    saveHidden();
    return actions.renderMain();
  }
  if (ticked(s)) {
    h.add(id);
    if (doneIds.every((d) => h.has(d))) {  // no completed status left: stop fetching them
      doneIds.forEach((d) => h.delete(d));
      saveHidden();
      return actions.toggleDone(true);  // keep the ticks just set
    }
    saveHidden();
    return actions.renderMain();
  }
  h.delete(id);
  if (!state.showDone) {
    doneIds.filter((d) => d !== id).forEach((d) => h.add(d));
    saveHidden();
    return actions.toggleDone(true);
  }
  saveHidden();
  return actions.renderMain();
}

/** Shows every status again, completed ones included (Display › Statuses › Show all, the empty state's button). */
export function showAllStatuses() {
  state.hiddenStatuses.clear();
  saveHidden();
  return state.showDone ? actions.renderMain() : actions.toggleDone();
}

/** "Statuses" with a tick per status; unticked ones are hidden in the list and on the board. */
function statusTicks() {
  const rows = allStatuses().map((s) => {
    const id = String(s.id);
    const b = el("button", { class: "drow dstat", role: "menuitemcheckbox" }, el("span", { class: "dname" }, statusIcon(s), el("span", {}, s.name)), el("span", { class: "dtick" }));
    const paint = () => {
      const on = ticked(s);
      b.setAttribute("aria-checked", String(on));
      b.lastChild.replaceChildren(on ? icon(14, ICONS.check, "") : "");
    };
    b.addEventListener("click", () => { toggleStatus(s); repaint(); });
    b.paint = paint;
    paint();
    return b;
  });
  const all = el("button", { class: "link dall", type: "button" }, "Show all");
  const repaint = () => { rows.forEach((r) => r.paint()); all.hidden = allStatuses().every(ticked); };
  all.addEventListener("click", () => { showAllStatuses(); repaint(); });
  repaint();
  return [el("div", { class: "dhead" }, el("span", {}, "Statuses"), all), el("div", { class: "dstats", role: "group", "aria-label": "Statuses to show" }, rows)];
}

/** Opens the popover under `anchor`, or closes it if it's already open. `focus`: move focus into it (keyboard). */
export function toggleDisplay(anchor, focus = true) {
  const m = activeMenu();
  if (m && m.anchor === anchor) return closeMenu();
  const select = (label, key, options) => {
    const s = el("select", { class: "dsel", "aria-label": label }, Object.entries(options).map(([v, text]) => el("option", { value: v }, text)));
    s.value = state[key] in options ? state[key] : Object.keys(options)[0];  // "No grouping" shows as the board's "None"
    s.addEventListener("change", () => setDisplay(key, s.value));
    return el("label", { class: "drow" }, el("span", {}, label), s);
  };
  const toggle = (label, get, flip) => {
    const sw = el("button", { class: "drow", role: "switch", "aria-checked": String(get()) }, el("span", {}, label), el("span", { class: "switch", "aria-hidden": "true" }));
    sw.addEventListener("click", () => {
      flip();
      sw.setAttribute("aria-checked", String(get()));
    });
    return sw;
  };
  const board = state.view === "board";
  const box = openPopover(anchor, [
    select("Grouping", "grouping", board ? BOARD_GROUP_LABELS : GROUP_LABELS),
    select("Ordering", "ordering", ORDER_LABELS),
    el("div", { class: "dsep" }),
    toggle("Show sub-issue progress", () => state.showSubProgress, () => setDisplay("showSubProgress", !state.showSubProgress)),
    board ? toggle("Show empty columns", () => state.boardEmpty, () => setDisplay("boardEmpty", !state.boardEmpty)) : null,
    el("div", { class: "dsep" }),
    statusTicks(),
    el("div", { class: "dsep" }),
    el("button", { class: "drow dsave", onclick: () => promptSaveView(anchor) }, el("span", {}, "Save view…")),
  ], { label: "Display options", cls: "display", align: "end" });
  const first = focus && box.querySelector("select:not([disabled]), button");
  if (first) first.focus({ preventScroll: true });
}

/** "Board · grouped by priority · …": what a saved view of the current settings will remember. */
function describeView() {
  const person = state.people.find((u) => u.accountId === state.who);
  const scope = state.epic ? "Epic " + state.epic : state.who === "mine" ? "My issues" : state.who === "all" ? "All issues" : person ? person.displayName : "A person's issues";
  const parts = [scope, state.view === "board" ? "board" : "list"];
  if (state.grouping !== "status") parts.push(state.grouping === "none" ? "no grouping" : "by " + GROUP_LABELS[state.grouping].toLowerCase());
  parts.push("ordered by " + ORDER_LABELS[state.ordering].toLowerCase());
  if (state.showDone) parts.push("with completed");
  if (state.filter.trim()) parts.push("filter “" + state.filter.trim() + "”");
  return parts.join(" · ");
}

/**
 * The "Save view" prompt under `anchor` (the Display button): a name, prefilled with the current
 * title, and what the view will remember. Enter or Save stores it (sidebar.saveView).
 */
export function promptSaveView(anchor) {
  const input = el("input", { class: "vname", "aria-label": "View name", maxlength: "60", spellcheck: "false", autocomplete: "off" });
  input.value = uniqueName(state.savedViews, $("#title .tlabel").textContent || "My view");
  const done = (save) => {
    const name = input.value.trim();
    if (save && !name) return input.focus();
    closeMenu();
    if (save) actions.saveView(name);
    if (anchor.isConnected) anchor.focus({ preventScroll: true });
  };
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); done(true); } });
  openPopover(anchor, [
    el("div", { class: "mh" }, "Save view"),
    input,
    el("div", { class: "vdesc" }, describeView()),
    el("div", { class: "vfoot" },
      el("button", { class: "btn", onclick: () => done(false) }, "Cancel"),
      el("button", { class: "btn primary", onclick: () => done(true) }, "Save")),
  ], { label: "Save view", cls: "saveview", align: "end" });
  input.focus();
  input.select();
}
