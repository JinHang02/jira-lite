// Multi-select over list rows and board cards (x, shift+click, shift+j/k, ⌘A, a row's checkbox,
// long-press on touch) and the floating bar that bulk-edits the selection: status (the union of
// workflow targets), priority, assignee, add labels. Planning lives in bulk.js.
import * as jira from "./api.js";
import { state, issueByKey } from "./state.js";
import { $, el, icon, ICONS, toast } from "./dom.js";
import { statusIcon, prioIcon, avatar } from "./icons.js";
import { openMenu, openPopover, closeMenu } from "./menu.js";
import {
  toggleKey, extendRange, orderedSelection, pruneSelection, unionTargets, statusPlan, priorityPlan, assigneePlan, labelsPlan,
  knownLabels, runPool, statusSummary, fieldSummary, firstError, CONCURRENCY,
} from "./bulk.js";
import { labelHue } from "./issues.js";
import { parseLabels } from "./props.js";
import { afterEdit } from "./edits.js";
import { setCursor } from "./cursor.js";
import { actions } from "./actions.js";

const CHECK = '<path d="M3.5 7.25l2.25 2.25L10.5 4.75" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>';
const STATUS_GLYPH = '<circle cx="7" cy="7" r="5.75" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M7 3.25a3.75 3.75 0 0 1 0 7.5z" fill="currentColor"/>';
const PRIO_GLYPH = '<path d="M2.5 11.5v-2M5.5 11.5v-4.5M8.5 11.5v-7M11.5 11.5V2.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>';
const USER_GLYPH = '<circle cx="7" cy="5" r="2.5" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M2.5 12.25a4.5 4.5 0 0 1 9 0" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>';
const LABEL_GLYPH = '<path d="M2 3.25v3.4c0 .3.1.6.35.8l4.6 4.6a1.1 1.1 0 0 0 1.55 0l3.4-3.4a1.1 1.1 0 0 0 0-1.55l-4.6-4.6A1.1 1.1 0 0 0 6.5 2H3.25C2.56 2 2 2.56 2 3.25z" fill="none" stroke="currentColor" stroke-width="1.3"/><circle cx="4.75" cy="4.75" r="1" fill="currentColor"/>';
const LONG_PRESS_MS = 450;

let listed = [];  // keys of the rendered list (filtered, ordered; includes collapsed groups)

export const hasSelection = () => state.selected.size > 0;

/** Selected issues (loaded ones) in display order. */
function selectedIssues() {
  return orderedSelection(state.selected, listed).map(issueByKey).filter(Boolean);
}

// ---- changing the selection ----

/** x / ⌘-click / a checkbox: adds or removes one issue; it becomes the anchor of a shift-range. */
export function toggleSelect(key) {
  if (!key) return;
  state.selected = toggleKey(state.selected, key);
  state.selAnchor = key;
  state.selBase = new Set(state.selected);
  markSelection();
}

/** shift+click: selects from the anchor (or the cursor) to `key`, on top of the earlier selection. */
export function selectTo(key) {
  const vis = state.visible;
  let anchor = state.selAnchor && vis.includes(state.selAnchor) ? state.selAnchor : null;
  if (!anchor) {
    anchor = state.cursor && vis.includes(state.cursor) ? state.cursor : key;
    state.selAnchor = anchor;
    state.selBase = new Set(state.selected);
  }
  state.selected = extendRange(state.selBase, vis, anchor, key);
  setCursor(key);
  markSelection();
}

/** shift+j / shift+k: moves the cursor and extends the range from the anchor to it. */
export function extendBy(step) {
  const vis = state.visible;
  if (!vis.length) return;
  const cur = state.cursor && vis.includes(state.cursor) ? state.cursor : null;
  if (!cur || !state.selAnchor || !state.selected.has(state.selAnchor) || !vis.includes(state.selAnchor)) {
    const start = cur || vis[0];
    state.selAnchor = start;
    state.selBase = new Set(state.selected);
    if (!cur) {  // nothing under the cursor yet: start the range at the first issue
      setCursor(start, true);
      state.selected = extendRange(state.selBase, vis, start, start);
      return markSelection();
    }
  }
  const next = vis[Math.max(0, Math.min(vis.length - 1, vis.indexOf(cur) + step))];
  setCursor(next, true);
  state.selected = extendRange(state.selBase, vis, state.selAnchor, next);
  markSelection();
}

/** ⌘A: every visible issue (collapsed groups excluded). */
export function selectAll() {
  if (!state.visible.length) return;
  state.selected = new Set(state.visible);
  state.selAnchor = null;
  state.selBase = new Set(state.selected);
  markSelection();
}

/** Esc / Clear: true if there was a selection. */
export function clearSelection() {
  if (!state.selected.size) return false;
  state.selected = new Set();
  state.selAnchor = null;
  state.selBase = new Set();
  markSelection();
  return true;
}

/** After a re-render: drops selected keys that are no longer listed and repaints. */
export function syncSelection(keys) {
  listed = keys;
  state.selected = pruneSelection(state.selected, keys);
  markSelection();
}

/** A click on a row or card: shift extends, ⌘/Ctrl toggles. True if it was a selection click. */
export function clickSelect(e, key) {
  if (e.shiftKey) { selectTo(key); return true; }
  if (e.metaKey || e.ctrlKey) { toggleSelect(key); return true; }
  return false;
}

/** The checkbox shown in a row's left gutter (or a card's corner) on hover and while selecting. */
export function selBox(key) {
  const on = state.selected.has(key);
  const b = el("button", { class: "selbox", role: "checkbox", "aria-checked": String(on), "aria-label": "Select " + key, title: "Select (X)", tabindex: "-1" },
    icon(14, CHECK, ""));
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    if (e.shiftKey) selectTo(key);
    else toggleSelect(key);
  });
  return b;
}

/** Row/card listeners: no text selection on shift+click, long-press toggles on touch screens. */
export function bindSelect(node, key) {
  let timer = 0;
  let fired = false;
  node.addEventListener("mousedown", (e) => { if (e.shiftKey) e.preventDefault(); });
  node.addEventListener("pointerdown", (e) => {
    if (e.pointerType !== "touch") return;
    fired = false;
    clearTimeout(timer);
    timer = setTimeout(() => { fired = true; toggleSelect(key); }, LONG_PRESS_MS);
  });
  for (const ev of ["pointerup", "pointercancel", "pointerleave", "pointermove"]) {
    node.addEventListener(ev, (e) => { if (ev !== "pointermove" || Math.abs(e.movementX) + Math.abs(e.movementY) > 4) clearTimeout(timer); });
  }
  node.addEventListener("contextmenu", (e) => { if (fired) e.preventDefault(); });
  // The click that ends a long-press must not open the issue.
  node.addEventListener("click", (e) => { if (fired) { fired = false; e.stopImmediatePropagation(); } }, true);
}

/** Syncs row/card classes and checkboxes with the selection, and shows or hides the bar. */
export function markSelection() {
  const sel = state.selected;
  for (const r of document.querySelectorAll(".row[data-key], .tcard[data-key]")) {
    const on = sel.has(r.dataset.key);
    r.classList.toggle("sel", on);
    const b = r.querySelector(".selbox");
    if (b) b.setAttribute("aria-checked", String(on));
  }
  document.body.classList.toggle("selecting", sel.size > 0);
  renderBar();
}

// ---- the bar ----

let bar = null;  // {count, buttons: {status, priority, assignee, labels}}

function renderBar() {
  const box = $("#selbar");
  if (!box) return;
  const n = state.selected.size;
  if (!n) {
    if (bar && bar.box.contains(document.activeElement)) document.activeElement.blur();
    box.hidden = true;
    return;
  }
  if (!bar) bar = buildBar(box);
  bar.count.textContent = String(n);
  box.hidden = false;
}

function buildBar(box) {
  const btn = (label, glyph, run, key) => {
    const b = el("button", { class: "selbtn", title: label + " (" + key + ")", "aria-haspopup": "menu" }, icon(14, glyph, ""), el("span", { class: "lbl" }, label),
      icon(16, ICONS.chev, "selchev"));
    b.addEventListener("click", () => run(b));
    return b;
  };
  const buttons = {
    status: btn("Status", STATUS_GLYPH, bulkStatus, "S"),
    priority: btn("Priority", PRIO_GLYPH, bulkPriority, "P"),
    assignee: btn("Assignee", USER_GLYPH, bulkAssignee, "A"),
    labels: el("button", { class: "selbtn", title: "Add labels (L)", "aria-haspopup": "dialog" }, icon(14, LABEL_GLYPH, ""), el("span", { class: "lbl" }, "+ Label")),
  };
  buttons.labels.addEventListener("click", () => bulkLabels(buttons.labels));
  const count = el("b", {}, "0");
  box.replaceChildren(
    el("span", { class: "selcount", "aria-live": "polite" }, count, el("span", { class: "lbl-sel" }, " selected")),
    el("span", { class: "selsep" }),
    buttons.status, buttons.priority, buttons.assignee, buttons.labels,
    el("span", { class: "selsep" }),
    el("button", { class: "selbtn clear", title: "Clear selection (Esc)", onclick: clearSelection }, el("span", { class: "lbl" }, "Clear"), icon(14, ICONS.close, "selx")));
  return { box, count, buttons };
}

/** s / p / a / l with a selection: the bar's menus. */
export function bulkKey(k) {
  if (!bar || !hasSelection()) return false;
  const b = { s: bar.buttons.status, p: bar.buttons.priority, a: bar.buttons.assignee, l: bar.buttons.labels }[k];
  if (!b) return false;
  b.click();
  return true;
}

// ---- bulk edits ----

/** Runs `write(item)` for every item (≤ CONCURRENCY at once) with `busy` set; resolves to pool results. */
async function writeAll(items, write) {
  state.busy = true;
  try {
    return await runPool(items, CONCURRENCY, write);
  } finally {
    state.busy = false;
  }
}

/** Toasts the summary, then one delta sync (and the open panel). */
function finish(text, results, isErr) {
  const err = firstError(results, (it) => it.key);
  toast(text + (err ? " — " + err : ""), isErr || !!err);
  return afterEdit();
}

/** Status: transitions of every selected issue (≤ 4 at once), the union of targets, then moves. */
async function bulkStatus(btn) {
  const issues = selectedIssues();
  if (state.busy || !issues.length || btn.classList.contains("busy")) return;
  btn.classList.add("busy");
  let res;
  try {
    res = await runPool(issues, CONCURRENCY, (i) => jira.getTransitions(i.key));
  } finally {
    btn.classList.remove("busy");
  }
  const trans = new Map(res.filter((r) => r.ok).map((r) => [r.item.key, r.value]));
  if (!trans.size) return toast("Couldn't load statuses: " + firstError(res, (i) => i.key), true);
  if (!btn.isConnected || btn.closest("[hidden]")) return;  // the selection was cleared meanwhile
  const n = issues.length;
  const items = unionTargets(issues, trans).map((t) => ({
    id: t.status.id, label: t.status.name, icon: statusIcon(t.status), via: t.count < n ? t.count + " of " + n : "", status: t.status,
  }));
  openMenu(btn, "Move " + n + (n === 1 ? " issue" : " issues") + " to", items, (it) => applyStatus(issues, trans, it.status), { empty: "No transitions available" });
}

async function applyStatus(issues, trans, status) {
  const plan = statusPlan(issues, trans, status.id);
  if (plan.moves.length) toast("Moving " + plan.moves.length + " to " + status.name + "…");
  const res = await writeAll(plan.moves, (m) => jira.transition(m.key, m.transitionId));
  const failed = res.filter((r) => !r.ok).length + plan.unknown.length;
  const moved = res.length - res.filter((r) => !r.ok).length;
  const text = statusSummary({ moved, cannot: plan.cannot.length, already: plan.already.length, failed }, status.name);
  // Epic progress rings count done children: refresh them when an epic or an epic's child moved.
  const inEpic = (i) => state.epicInfo.has(i.key) || (i.fields.parent && state.epicInfo.has(i.fields.parent.key));
  if (moved && issues.some((i) => plan.moves.some((m) => m.key === i.key) && inEpic(i))) actions.loadEpics();
  return finish(text, res, failed > 0 || (plan.cannot.length > 0 && !moved));
}

/** Runs a field plan ([{key, ...}]) with `write`, then toasts "<what> on N issues · M already". */
async function applyPlan(issues, plan, write, what) {
  if (!plan.length) return toast(fieldSummary(what, { skipped: issues.length }));
  const res = await writeAll(plan, write);
  const failed = res.filter((r) => !r.ok).length;
  return finish(fieldSummary(what, { changed: res.length - failed, skipped: issues.length - plan.length, failed }), res, failed > 0);
}

function bulkPriority(btn) {
  const issues = selectedIssues();
  if (state.busy || !issues.length) return;
  if (!state.priorities.length) return toast("Priorities haven't loaded yet.", true);
  const cur = new Set(issues.map((i) => (i.fields.priority ? String(i.fields.priority.id) : "")));
  const items = state.priorities.map((p) => ({ id: p.id, label: p.name, icon: prioIcon(p), current: cur.size === 1 && cur.has(String(p.id)) }));
  openMenu(btn, "Priority for " + issues.length, items, (it) =>
    applyPlan(issues, priorityPlan(issues, it.id), (x) => jira.updateIssue(x.key, x.fields), "Priority → " + it.label));
}

function bulkAssignee(btn) {
  const issues = selectedIssues();
  if (state.busy || !issues.length) return;
  const { me, people } = state;
  const cur = new Set(issues.map((i) => (i.fields.assignee ? i.fields.assignee.accountId : null)));
  const one = cur.size === 1 ? [...cur][0] : undefined;
  const others = people.filter((u) => !me || u.accountId !== me.accountId);
  const items = [{ id: null, label: "Unassigned", icon: avatar(null), current: one === null },
    ...[...(me ? [me] : []), ...others].map((u) => ({
      id: u.accountId, label: u.displayName + (me && u.accountId === me.accountId ? " (me)" : ""), icon: avatar(u), current: one === u.accountId,
    }))];
  openMenu(btn, "Assign " + issues.length + " to", items, (it) =>
    applyPlan(issues, assigneePlan(issues, it.id), (x) => jira.assign(x.key, x.accountId), it.id ? "Assigned to " + it.label.replace(/ \(me\)$/, "") : "Unassigned"),
  { search: true });
}

/** + Label: type labels ("a, b") or pick a known one; adds them to every selected issue. */
function bulkLabels(btn) {
  const issues = selectedIssues();
  if (state.busy || !issues.length) return;
  const known = knownLabels(state.issues);
  const input = el("input", { class: "msearch", placeholder: "Add labels…", "aria-label": "Labels to add", autocomplete: "off", spellcheck: "false" });
  const list = el("div", { class: "mlist" });
  const apply = (labels) => {
    if (!labels.length) return input.focus();
    closeMenu();
    applyPlan(issues, labelsPlan(issues, labels), (x) => jira.updateIssue(x.key, x.fields), "Added " + labels.join(", "));
  };
  const opt = (label, text, labels) => el("button", { class: "mi", onclick: () => apply(labels) },
    el("i", { class: "ldot", style: "--h:" + labelHue(label) }), el("span", { class: "grow" }, text));
  const fill = () => {
    const typed = parseLabels(input.value);
    const q = (typed[typed.length - 1] || "").toLowerCase();
    const hits = known.filter((l) => !typed.includes(l) && (!q || l.toLowerCase().includes(q))).slice(0, 8);
    const add = typed.length && !(typed.length === 1 && known.includes(typed[0])) ? [opt(typed[0], "Add “" + typed.join(", ") + "”", typed)] : [];
    list.replaceChildren(...add, ...hits.map((l) => opt(l, l, [l])), ...(add.length || hits.length ? [] : [el("div", { class: "mh" }, "Type a label")]));
  };
  input.addEventListener("input", fill);
  input.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const typed = parseLabels(input.value);
    const first = list.querySelector(".mi");
    if (typed.length) apply(typed);
    else if (first) first.click();
  });
  fill();  // before placing: the popover opens upwards from the bar and must know its height
  openPopover(btn, [el("div", { class: "mh" }, "Add labels to " + issues.length + (issues.length === 1 ? " issue" : " issues")), input, list],
    { label: "Add labels", cls: "labelpop" });
  input.focus();
}
