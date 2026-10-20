// The header's Display popover: grouping, ordering, show completed, show sub-issue progress, and
// "Save view…" (the name prompt for a saved view).
import { state, store } from "./state.js";
import { $, el } from "./dom.js";
import { uniqueName } from "./savedviews.js";
import { openPopover, closeMenu, activeMenu } from "./menu.js";
import { actions } from "./actions.js";

const GROUP_LABELS = { status: "Status", assignee: "Assignee", priority: "Priority", none: "No grouping" };
const ORDER_LABELS = { updated: "Last updated", priority: "Priority", created: "Created" };

/** Sets a Display option (grouping / ordering / showSubProgress), persists it and re-renders. */
export function setDisplay(key, value) {
  state[key] = value;
  store({ grouping: "grouping", ordering: "ordering", showSubProgress: "subProgress" }[key], typeof value === "boolean" ? (value ? "1" : "0") : value);
  actions.renderMain();
}

/** Opens the popover under `anchor`, or closes it if it's already open. `focus`: move focus into it (keyboard). */
export function toggleDisplay(anchor, focus = true) {
  const m = activeMenu();
  if (m && m.anchor === anchor) return closeMenu();
  const select = (label, key, options, disabledNote) => {
    const s = el("select", { class: "dsel", "aria-label": label, disabled: disabledNote ? "" : null, title: disabledNote || null },
      Object.entries(options).map(([v, text]) => el("option", { value: v }, text)));
    s.value = disabledNote ? "status" : state[key];
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
    select("Grouping", "grouping", GROUP_LABELS, board ? "The board's columns are statuses" : ""),
    select("Ordering", "ordering", ORDER_LABELS),
    el("div", { class: "dsep" }),
    toggle("Show completed", () => state.showDone, () => actions.toggleDone()),
    toggle("Show sub-issue progress", () => state.showSubProgress, () => setDisplay("showSubProgress", !state.showSubProgress)),
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
  if (state.view !== "board" && state.grouping !== "status") parts.push(state.grouping === "none" ? "no grouping" : "by " + GROUP_LABELS[state.grouping].toLowerCase());
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
  input.value = uniqueName(state.savedViews, $("#title").textContent || "My view");
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
