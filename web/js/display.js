// The header's Display popover: grouping, ordering, show completed, show sub-issue progress.
import { state, store } from "./state.js";
import { el } from "./dom.js";
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
  ], { label: "Display options", cls: "display", align: "end" });
  const first = focus && box.querySelector("select:not([disabled]), button");
  if (first) first.focus({ preventScroll: true });
}
