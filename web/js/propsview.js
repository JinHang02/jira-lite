// Properties block of the detail panel: parent epic, labels and due date (editable inline), fix
// versions, components, required custom fields, reporter, created/updated.
import * as jira from "./api.js";
import { state } from "./state.js";
import { el, icon, ICONS, toast } from "./dom.js";
import { ago } from "./format.js";
import { avatar, statusIcon } from "./icons.js";
import { statusKind } from "./status.js";
import { labelHue } from "./issues.js";
import { dayText } from "./activity.js";
import { fieldText, localDay, dueState, parseLabels, parentAllowed, epicTypeName, epicJql, filterEpics } from "./props.js";
import { updateFields } from "./edits.js";
import { openPopover, closeMenu } from "./menu.js";
import { issueTypes } from "./meta.js";
import { typeIcon } from "./typeicons.js";
import { actions } from "./actions.js";

const row = (label, value, wide) => el("div", { class: "prow" + (wide ? " wide" : "") }, el("span", { class: "plabel" }, label), el("div", { class: "pval" }, value));
const none = (text = "None") => el("span", { class: "pnone" }, text);
const stamp = (iso) => iso ? el("span", { title: new Date(iso).toLocaleString() }, ago(iso)) : none("—");

/** The properties block. `customs` are [{id, name}] custom fields to show (required on create). */
export function renderProps(issue, customs = []) {
  const f = issue.fields;
  const list = (v) => fieldText(v) ? el("span", { class: "ptext", title: fieldText(v) }, fieldText(v)) : none();
  return el("div", { class: "pblock", "aria-label": "Properties" },
    parentAllowed(f.issuetype) ? row("Parent", parentEditor(issue.key, f.parent), true) : null,
    row("Labels", labelsEditor(issue.key, f.labels || []), true),
    row("Due date", dueEditor(issue.key, f.duedate, ["done", "canceled"].includes(statusKind(f.status)))),
    row("Reporter", f.reporter ? el("span", { class: "pperson" }, avatar(f.reporter), f.reporter.displayName) : none()),
    row("Fix versions", list(f.fixVersions)),
    row("Components", list(f.components)),
    customs.map((c) => row(c.name, list(f[c.id]))),
    row("Created", stamp(f.created)),
    row("Updated", stamp(f.updated)));
}

/** Label pills with remove buttons, plus "+" that turns into an input (Enter adds, Esc cancels). */
function labelsEditor(key, labels) {
  const box = el("div", { class: "labels" });
  const save = (next, msg) => updateFields(key, { labels: next }, msg);
  for (const l of labels) {
    const x = el("button", { class: "lx", type: "button", title: "Remove label " + l, "aria-label": "Remove label " + l }, icon(14, ICONS.close, ""));
    x.addEventListener("click", () => { if (!state.busy) save(labels.filter((y) => y !== l), key + ": removed label " + l); });
    box.append(el("span", { class: "label" }, el("span", { class: "ldot", style: "--h:" + labelHue(l) }), l, x));
  }
  const add = el("button", { class: "ladd", type: "button", title: "Add labels", "aria-label": "Add labels" },
    icon(14, ICONS.plus, ""), labels.length ? null : "Add label");
  add.addEventListener("click", () => {
    const input = el("input", { class: "linput", placeholder: "label, another", "aria-label": "New labels (comma separated)" });
    input.dataset.editing = "1";
    add.replaceWith(input);
    input.focus();
    let done = false;
    const finish = (commit) => {
      if (done) return;
      done = true;
      const added = parseLabels(input.value).filter((l) => !labels.includes(l));
      input.replaceWith(add);
      if (commit && added.length) save([...labels, ...added], key + ": added " + added.join(", "));
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); finish(true); }
      else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); finish(false); }
    });
    input.addEventListener("blur", () => finish(true));
  });
  box.append(add);
  return box;
}

/** Due date text (red when overdue); click for a native date input. Enter/blur saves, Esc cancels. */
function dueEditor(key, due, finished) {
  const st = dueState(due, localDay(), finished);
  const show = el("button", { class: "pdue" + (st ? " " + st : ""), type: "button", title: due ? (st === "overdue" ? "Overdue · " : "") + "Change due date" : "Set due date" },
    due ? dayText(due) : none("Set due date"));
  const wrap = el("div", { class: "due" }, show);
  if (due) {
    const clear = el("button", { class: "lx", type: "button", title: "Remove due date", "aria-label": "Remove due date" }, icon(14, ICONS.close, ""));
    clear.addEventListener("click", () => { if (!state.busy) updateFields(key, { duedate: null }, key + ": due date removed"); });
    wrap.append(clear);
  }
  show.addEventListener("click", () => {
    const input = el("input", { type: "date", class: "dinput", "aria-label": "Due date" });
    input.value = due ? due.slice(0, 10) : "";
    input.dataset.editing = "1";
    wrap.replaceChildren(input);
    input.focus();
    try { input.showPicker(); } catch (e) { /* needs a user gesture or unsupported: typing still works */ }
    let done = false;
    const finish = (commit) => {
      if (done) return;
      done = true;
      const v = input.value;
      wrap.replaceWith(dueEditor(key, due, finished));  // the reload after saving shows the new date
      // An empty or half-typed input is a cancel; removing the date is the × button's job.
      if (commit && v && v !== (due || "").slice(0, 10)) updateFields(key, { duedate: v }, key + ": due " + dayText(v));
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); finish(true); }
      else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); finish(false); }
    });
    input.addEventListener("blur", () => finish(true));
  });
  return wrap;
}

/** Parent epic: "KEY · summary" (opens it) with change/remove buttons, or "Set parent…". */
function parentEditor(key, parent) {
  const wrap = el("div", { class: "pparent" });
  const set = el("button", { class: "pset", type: "button", title: parent ? "Change parent" : "Set parent epic", "aria-haspopup": "dialog" },
    parent ? icon(14, PENCIL, "") : none("Set parent…"));
  set.addEventListener("click", () => { if (!state.busy) parentPicker(key, parent, set); });
  if (!parent) {
    wrap.append(set);
    return wrap;
  }
  const pf = parent.fields || {};
  const open = el("button", { class: "plink", type: "button", title: "Open " + parent.key },
    pf.issuetype ? typeIcon(pf.issuetype) : null, el("span", { class: "pkey" }, parent.key), el("span", { class: "ptext" }, pf.summary || ""));
  open.addEventListener("click", () => actions.openIssue(parent.key));
  const clear = el("button", { class: "lx", type: "button", title: "Remove parent", "aria-label": "Remove parent" }, icon(14, ICONS.close, ""));
  clear.addEventListener("click", () => { if (!state.busy) updateFields(key, { parent: null }, key + ": parent " + parent.key + " removed"); });
  wrap.append(open, set, clear);
  return wrap;
}

const PENCIL = '<path d="M9.5 2.75l1.75 1.75-6.5 6.5-2.25.5.5-2.25z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>';
const SEARCH_DELAY = 250;  // ms after the last keystroke before asking Jira

/**
 * Searchable list of open epics under `anchor`: loads them once, filters locally as you type
 * and also asks Jira (key or summary search) so epics beyond the first page are found.
 * ↑/↓ + Enter picks; Esc closes (menu.js).
 */
async function parentPicker(key, parent, anchor) {
  const input = el("input", { class: "msearch", placeholder: "Search open epics…", autocomplete: "off", "aria-label": "Search epics" });
  const list = el("div", { class: "mlist", role: "listbox" }, el("div", { class: "mh" }, "Loading epics…"));
  const box = openPopover(anchor, [el("div", { class: "mh" }, key + " · parent"), input, list], { label: "Set parent", cls: "parentpick" });
  input.focus();
  let typeName = "Epic";
  try { typeName = epicTypeName(await issueTypes()); } catch (e) { if (e.loginRequired) return closeMenu(); }
  let loaded = [], remote = [], idx = 0, seq = 0, timer = 0;
  let buttons = [];
  const project = state.cfg.project;
  const hits = () => {
    const q = input.value;
    const seen = new Set();
    return [...filterEpics(loaded, q), ...remote].filter((e) => e.key !== key && !seen.has(e.key) && seen.add(e.key));
  };
  const hilite = (n) => {
    if (!buttons.length) return;
    idx = (n + buttons.length) % buttons.length;
    buttons.forEach((b, i) => b.classList.toggle("hi", i === idx));
    buttons[idx].scrollIntoView({ block: "nearest" });
  };
  const pick = (e) => {
    closeMenu();
    if (parent && parent.key === e.key) return;
    updateFields(key, { parent: { key: e.key } }, key + " → parent " + e.key);
  };
  const render = (status) => {
    const items = hits();
    buttons = items.map((e, i) => {
      const f = e.fields || {};
      const b = el("button", { class: "mi", type: "button", role: "option" }, f.status ? statusIcon(f.status) : null,
        el("span", { class: "via" }, e.key), el("span", { class: "grow" }, f.summary || ""),
        parent && parent.key === e.key ? icon(14, ICONS.check, "") : null);
      b.addEventListener("mousemove", () => hilite(i));
      b.addEventListener("click", () => pick(e));
      return b;
    });
    list.replaceChildren(...(buttons.length ? buttons : [el("div", { class: "mh" }, status || "No open epics match")]));
    if (status && buttons.length) list.append(el("div", { class: "mh" }, status));
    hilite(Math.max(0, items.findIndex((e) => parent && e.key === parent.key && !input.value.trim())));
  };
  const search = async () => {
    const q = input.value.trim();
    const mine = ++seq;
    if (!q) { remote = []; return render(); }
    render("Searching…");
    try {
      const found = await jira.searchParents(epicJql(project, q, typeName));
      if (mine !== seq || !box.isConnected) return;
      remote = found;
      render();
    } catch (e) {
      if (mine === seq && box.isConnected) render("Search failed: " + e.message);
    }
  };
  input.addEventListener("input", () => {
    remote = [];
    render();
    clearTimeout(timer);
    timer = setTimeout(search, SEARCH_DELAY);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); hilite(idx + 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); hilite(idx - 1); }
    else if (e.key === "Enter") { e.preventDefault(); if (buttons[idx]) buttons[idx].click(); }
  });
  try {
    loaded = await jira.searchParents(epicJql(project, "", typeName));
  } catch (e) {
    if (!box.isConnected) return;
    if (e.loginRequired) return closeMenu();
    toast("Couldn't load epics: " + e.message, true);
  }
  if (box.isConnected) render();
}
