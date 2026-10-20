// Properties block of the detail panel: labels and due date (editable inline), fix versions,
// components, required custom fields, reporter, created/updated.
import { state } from "./state.js";
import { el, icon, ICONS } from "./dom.js";
import { ago } from "./format.js";
import { avatar } from "./icons.js";
import { statusKind } from "./status.js";
import { dayText } from "./activity.js";
import { fieldText, localDay, dueState, parseLabels } from "./props.js";
import { updateFields } from "./edits.js";

const row = (label, value, wide) => el("div", { class: "prow" + (wide ? " wide" : "") }, el("span", { class: "plabel" }, label), el("div", { class: "pval" }, value));
const none = (text = "None") => el("span", { class: "pnone" }, text);
const stamp = (iso) => iso ? el("span", { title: new Date(iso).toLocaleString() }, ago(iso)) : none("—");

/** The properties block. `customs` are [{id, name}] custom fields to show (required on create). */
export function renderProps(issue, customs = []) {
  const f = issue.fields;
  const list = (v) => fieldText(v) ? el("span", { class: "ptext", title: fieldText(v) }, fieldText(v)) : none();
  return el("div", { class: "pblock", "aria-label": "Properties" },
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
    box.append(el("span", { class: "label" }, el("span", { class: "ldot" }), l, x));
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
