// Sidebar: workspace, My/All issues, people, keyboard hints. Also owns the "whose issues" selection.
import { state, store } from "./state.js";
import { $, el, icon } from "./dom.js";
import { avatar, NAV_ICONS } from "./icons.js";
import { actions } from "./actions.js";

/** Header title for the current selection. */
export function whoLabel() {
  if (state.who === "mine") return "My issues";
  if (state.who === "all") return "All issues";
  const p = state.people.find((u) => u.accountId === state.who);
  return p ? p.displayName : "Issues";
}

export function renderSide() {
  const { cfg, people } = state;
  const nav = (value, label, ico) => el("button", { class: "nav" + (state.who === value ? " on" : ""), onclick: () => setWho(value) }, ico, el("span", {}, label));
  const k = (...keys) => keys.map((x) => [el("kbd", {}, x), " "]);
  $("#side").replaceChildren(...[
    el("div", { class: "ws" }, el("span", { class: "logo" }, cfg.project.slice(0, 2)), el("span", {}, "Jira · " + cfg.project)),
    nav("mine", "My issues", icon(16, NAV_ICONS.mine, "")),
    nav("all", "All issues", icon(16, NAV_ICONS.all, "")),
    people.length ? el("div", { class: "side-h" }, "People") : null,
    ...people.map((u) => nav(u.accountId, u.displayName, avatar(u))),
    el("div", { class: "hints" },
      el("div", {}, k("c"), "new  ", k("⌘K"), "search  ", k("/"), "filter"),
      el("div", {}, k("j", "k"), "move  ", k("↵"), "open  ", k("esc"), "close"),
      el("div", {}, k("s", "p", "a"), "status/priority/assignee"),
      el("div", {}, k("m"), "comment  ", k("⌘B"), "board  ", k("r"), "refresh")),
  ].filter(Boolean));
}

/** Switches to "mine", "all" or a person's accountId and reloads the list. */
export function setWho(value) {
  state.who = value;
  store("who", value);
  renderSide();
  $("#title").textContent = whoLabel();
  state.issues = [];
  $("#count").textContent = "";
  $("#list").replaceChildren(el("p", { class: "empty" }, "Loading…"));
  actions.loadList();
}
