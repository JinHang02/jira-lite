// Command palette (⌘K): commands plus issue search (local matches first, then Jira full-text or key lookup).
import * as jira from "./api.js";
import { state } from "./state.js";
import { $, el, icon, ICONS } from "./dom.js";
import { searchJql } from "./jql.js";
import { matches } from "./issues.js";
import { statusIcon, avatar, NAV_ICONS } from "./icons.js";
import { showModal, closeModal, activeModal } from "./modal.js";
import { toggleHelp, isMac } from "./help.js";
import { toggleSidebar } from "./sidebar.js";
import { setDisplay, promptSaveView } from "./display.js";
import { actions } from "./actions.js";

const SEARCH_DELAY_MS = 200;
const VIEW_GLYPH = '<path d="M8 2.25l5.75 3L8 8.25l-5.75-3z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="M2.25 8.25L8 11.25l5.75-3M2.25 10.75L8 13.75l5.75-3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>';
const EPIC_GLYPH = '<circle cx="8" cy="8" r="5.25" fill="none" stroke="currentColor" stroke-width="1.6" stroke-opacity=".35"/><path d="M8 2.75a5.25 5.25 0 0 1 5.25 5.25" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>';

export const paletteOpen = () => (activeModal() || {}).kind === "palette";

export function openPalette() {
  if (activeModal()) return;
  const input = el("input", { class: "pinput", placeholder: "Search issues or type a command…", autocomplete: "off", spellcheck: "false" });
  const list = el("div", { class: "plist" });
  const m = showModal(el("div", { class: "palette", role: "dialog", "aria-label": "Command menu" }, input, list), { kind: "palette" });
  const pal = { items: [], buttons: [], idx: 0, seq: 0, timer: 0 };

  // Items with `more` only show up once something is typed.
  const commands = () => [
    { label: "New issue", hint: "C", icon: icon(14, ICONS.plus, ""), run: () => actions.openCreate(null) },
    { label: state.view === "board" ? "Switch to list view" : "Switch to board view", hint: (isMac() ? "⌘" : "Ctrl ") + "B", run: () => actions.setView(state.view === "board" ? "list" : "board") },
    { label: "My issues", icon: icon(16, NAV_ICONS.mine, ""), run: () => actions.setWho("mine") },
    { label: "All issues", icon: icon(16, NAV_ICONS.all, ""), run: () => actions.setWho("all") },
    { label: state.showDone ? "Hide completed issues" : "Show completed issues", run: () => actions.toggleDone() },
    { label: "Save view…", icon: icon(16, VIEW_GLYPH, ""), run: () => promptSaveView($("#displayBtn")) },
    ...state.savedViews.map((v) => ({ label: v.name, via: "View", icon: icon(16, VIEW_GLYPH, ""), more: true, run: () => actions.applySavedView(v.id) })),
    ...state.epics.map((e) => ({ label: e.summary, via: "Epic · " + e.key, icon: icon(16, EPIC_GLYPH, ""), more: true, run: () => actions.setEpic(e.key) })),
    { label: "Refresh", hint: "R", run: () => actions.refresh() },
    { label: "Keyboard shortcuts", hint: "?", run: () => toggleHelp() },
    { label: "Toggle sidebar", hint: "[", more: true, run: () => toggleSidebar() },
    ...[["status", "Group by status"], ["assignee", "Group by assignee"], ["priority", "Group by priority"], ["none", "No grouping"]]
      .map(([v, label]) => ({ label, more: true, run: () => setDisplay("grouping", v) })),
    ...[["updated", "Order by last updated"], ["priority", "Order by priority"], ["created", "Order by created"]]
      .map(([v, label]) => ({ label, more: true, run: () => setDisplay("ordering", v) })),
    ...state.people.map((u) => ({ label: u.displayName + "’s issues", icon: avatar(u), more: true, run: () => actions.setWho(u.accountId) })),
  ];
  const issueItem = (i) => ({ label: i.fields.summary, via: i.key, icon: statusIcon(i.fields.status), run: () => { state.known.set(i.key, i); actions.openIssue(i.key); } });

  const pick = (n) => {
    if (!pal.buttons.length) return;
    pal.idx = (n + pal.buttons.length) % pal.buttons.length;
    pal.buttons.forEach((b, i) => b.classList.toggle("hi", i === pal.idx));
    pal.buttons[pal.idx].scrollIntoView({ block: "nearest" });
  };
  const run = (n) => { const it = pal.items[n]; if (it) { closeModal(); it.run(); } };
  const draw = (issueHits, cmds, note) => {
    pal.items = [...issueHits.map(issueItem), ...cmds];
    pal.buttons = pal.items.map((it, n) => {
      const b = el("button", { class: "mi" }, it.icon || el("span", { style: "width:14px" }), el("span", { class: "grow" }, it.label),
        it.via ? el("span", { class: "via" }, it.via) : null, it.hint ? el("kbd", {}, it.hint) : null);
      b.addEventListener("mousemove", () => pick(n));
      b.addEventListener("click", () => run(n));
      return b;
    });
    list.replaceChildren(...pal.buttons, ...(note ? [el("div", { class: "mh" }, note)] : []),
      ...(!pal.buttons.length && !note ? [el("div", { class: "mh" }, "No results")] : []));
    pick(0);
  };

  const query = () => {
    const q = input.value.trim();
    const ql = q.toLowerCase();
    const cmds = commands().filter((c) => ql ? (c.label + " " + (c.via || "")).toLowerCase().includes(ql) : !c.more);
    const local = ql ? state.issues.filter((i) => matches(i, ql)).slice(0, 6) : [];
    draw(local, cmds, q ? "Searching Jira…" : "");
    clearTimeout(pal.timer);
    if (!q) return;
    const seq = ++pal.seq;
    pal.timer = setTimeout(async () => {
      let hits = [];
      try {
        const km = q.match(/^(?:([A-Za-z][A-Za-z0-9]*)-)?(\d+)$/);
        if (km) {
          const key = (km[1] ? km[1].toUpperCase() : state.cfg.project) + "-" + km[2];
          hits = [await jira.getIssue(key, jira.FIELDS)].filter(Boolean);
        } else {
          hits = await jira.searchIssues(searchJql(state.cfg.project, q), 12);
        }
      } catch (e) { /* no match: e.g. the key doesn't exist */ }
      if (activeModal() !== m || seq !== pal.seq) return;
      const seen = new Set(local.map((i) => i.key));
      draw([...local, ...hits.filter((i) => !seen.has(i.key))].slice(0, 15), cmds, "");
    }, SEARCH_DELAY_MS);
  };
  input.addEventListener("input", query);
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") pick(pal.idx + 1);
    else if (e.key === "ArrowUp") pick(pal.idx - 1);
    else if (e.key === "Enter") run(pal.idx);
    else return;
    e.preventDefault();
  });
  query();
  input.focus();
}
