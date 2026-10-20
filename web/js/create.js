// New issue / new sub-issue dialog, including selects for fields Jira requires (e.g. Client, Fix versions).
import * as jira from "./api.js";
import { state, store, recall, stash, unstash } from "./state.js";
import { el, icon, ICONS, toast } from "./dom.js";
import { prioIcon, avatar } from "./icons.js";
import { textToAdf } from "./adf.js";
import { showModal, closeModal } from "./modal.js";
import { issueTypes, typeFields } from "./meta.js";
import { actions } from "./actions.js";

// Fields the dialog sets itself (or Jira fills), so they never get a generic required-field select.
const HANDLED = new Set(["summary", "issuetype", "project", "reporter", "parent", "description", "priority", "assignee"]);
// Unsent new-issue text, kept if the dialog is closed (and across a sign-in, see stashCreateDraft).
let createDraft = restoreDraft();

function restoreDraft() {
  try {
    const d = JSON.parse(unstash("createDraft") || "null");
    if (d && typeof d.title === "string" && typeof d.desc === "string") return d;
  } catch (e) { /* no draft */ }
  return { title: "", desc: "" };
}

/** Saves the new-issue draft for the sign-in round trip (call after closing the dialog). */
export function stashCreateDraft() {
  if (createDraft.title || createDraft.desc) stash("createDraft", JSON.stringify(createDraft));
}

/** Opens the create dialog; with `parent` it creates a sub-issue (or a child of an epic). */
export async function openCreate(parent) {
  if (state.busy) return;
  const { cfg, me, people, priorities } = state;
  if (!state.issueTypes.length) {
    try { state.issueTypes = await issueTypes(); }
    catch (e) { return toast("Couldn't load issue types: " + e.message, true); }
  }
  const parentIsEpic = parent && parent.fields.issuetype && parent.fields.issuetype.hierarchyLevel === 1;
  const types = state.issueTypes.filter((t) => parent ? (parentIsEpic ? !t.subtask && t.hierarchyLevel === 0 : t.subtask) : !t.subtask);
  if (!types.length) return toast("This project has no issue type for that.", true);
  const lastType = recall("lastType");
  const defType = (types.find((t) => t.id === lastType) || types.find((t) => t.name === "Task") || types[0]).id;

  const title = el("input", { class: "ntitle", placeholder: parent ? "Sub-issue title" : "Issue title", autocomplete: "off" });
  const desc = el("textarea", { class: "ndesc", placeholder: "Add description…" });
  if (!parent) { title.value = createDraft.title; desc.value = createDraft.desc; }

  const select = (cls, options, value, lead) => {
    const s = el("select", {}, options.map(([v, label]) => el("option", { value: v }, label)));
    s.value = value;
    return { chip: el("label", { class: "chip" + (cls ? " " + cls : "") }, lead || null, s), s };
  };
  const type = select("", types.map((t) => [t.id, t.name]), defType);
  const defPrio = (priorities.find((p) => p.name === "Medium") || priorities[0] || {}).id || "";
  const prio = select("", [["", "No priority"], ...priorities.map((p) => [p.id, p.name])], defPrio, prioIcon(priorities.find((p) => p.id === defPrio)));
  prio.s.addEventListener("change", () => prio.chip.firstChild.replaceWith(prioIcon(priorities.find((p) => p.id === prio.s.value))));
  const ppl = [...(me ? [me] : []), ...people.filter((u) => !me || u.accountId !== me.accountId)];
  const who = select("", [["", "Unassigned"], ...ppl.map((u) => [u.accountId, u.displayName + (me && u.accountId === me.accountId ? " (me)" : "")])],
    me ? me.accountId : "");
  const extras = el("span", { style: "display:contents" });
  const warn = el("div", { class: "warn" });
  let dynamic = [];  // [{field, s, chip}]
  let fieldIds = new Set();

  // Required fields Jira insists on (e.g. Client, Fix versions) get a select; sub-issues inherit the parent's value.
  async function loadTypeFields() {
    extras.replaceChildren();
    warn.textContent = "";
    dynamic = [];
    let fields;
    try { fields = await typeFields(type.s.value); } catch (e) { warn.textContent = "Couldn't load fields: " + e.message; return; }
    fieldIds = new Set(fields.map((x) => x.fieldId));
    const need = fields.filter((x) => x.required && !x.hasDefaultValue && !HANDLED.has(x.fieldId));
    let inherited = {};
    if (parent && need.length) {
      try { inherited = (await jira.getIssue(parent.key, need.map((x) => x.fieldId))).fields || {}; } catch (e) { /* no inheritance */ }
    }
    const unsupported = [];
    for (const fld of need) {
      const av = fld.allowedValues || [];
      if (!av.length) { unsupported.push(fld.name); continue; }
      const pv = inherited[fld.fieldId];
      const pid = Array.isArray(pv) ? (pv[0] || {}).id : (pv || {}).id;
      const last = recall("last." + fld.fieldId);
      const val = av.some((v) => v.id === pid) ? pid : (av.some((v) => v.id === last) ? last : "");
      const sel = select("req", [["", fld.name + "…"], ...av.filter((v) => !v.archived).map((v) => [v.id, v.name || v.value])], val);
      sel.chip.title = fld.name + " (required by Jira)";
      dynamic.push({ field: fld, s: sel.s, chip: sel.chip });
      extras.append(sel.chip);
    }
    if (unsupported.length) warn.textContent = "Jira also requires " + unsupported.join(", ") + ", which can't be set here yet. Create it in Jira instead.";
  }
  type.s.addEventListener("change", loadTypeFields);

  const msg = el("span", { class: "cmsg" });
  const create = el("button", { class: "btn primary" }, parent ? "Create sub-issue" : "Create issue");
  const cancel = el("button", { class: "btn", onclick: closeModal }, "Cancel");

  async function submit() {
    if (create.disabled) return;
    const summary = title.value.trim();
    if (!summary) { title.focus(); msg.textContent = "Add a title first."; return; }
    const missing = dynamic.filter((d) => !d.s.value);
    dynamic.forEach((d) => d.chip.classList.toggle("bad", !d.s.value));
    if (missing.length) { msg.textContent = "Pick " + missing.map((d) => d.field.name).join(", ") + "."; return; }
    const fields = { project: { key: cfg.project }, issuetype: { id: type.s.value }, summary };
    if (desc.value.trim()) fields.description = textToAdf(desc.value);
    if (prio.s.value && fieldIds.has("priority")) fields.priority = { id: prio.s.value };
    if (who.s.value && fieldIds.has("assignee")) fields.assignee = { accountId: who.s.value };
    if (parent) fields.parent = { key: parent.key };
    for (const d of dynamic) fields[d.field.fieldId] = d.field.schema && d.field.schema.type === "array" ? [{ id: d.s.value }] : { id: d.s.value };
    create.disabled = true;
    msg.textContent = "Creating…";
    try {
      const r = await jira.createIssue(fields);
      store("lastType", type.s.value);
      for (const d of dynamic) store("last." + d.field.fieldId, d.s.value);
      if (!parent) createDraft = { title: "", desc: "" };
      title.value = "";
      closeModal();
      toast("Created " + r.key);
      await actions.sync();
      if (parent && state.current === parent.key) actions.loadDetail();
      else actions.openIssue(r.key);
    } catch (e) {
      msg.textContent = "";
      toast("Create failed: " + e.message, true);
      create.disabled = false;
    }
  }
  create.addEventListener("click", submit);

  const dialog = el("div", { class: "modal", role: "dialog", "aria-label": "New issue" },
    el("div", { class: "mhead" }, el("span", { class: "logo" }, cfg.project.slice(0, 2)),
      el("span", {}, parent ? cfg.project + " › " + parent.key + " › New sub-issue" : cfg.project + " › New issue"),
      el("span", { class: "spacer" }), el("button", { class: "btn icon", title: "Close (esc)", onclick: closeModal }, icon(14, ICONS.close, ""))),
    el("div", { class: "mbody" }, title, desc,
      el("div", { class: "props" }, type.chip, prio.chip, el("label", { class: "chip" }, avatar(null), who.s), extras), warn),
    el("div", { class: "mfoot" }, msg, cancel, create, el("kbd", { title: "Create" }, "⌘↵")));
  dialog.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); }
    else if (e.key === "Enter" && e.target === title) { e.preventDefault(); desc.focus(); }
  });
  // Keep an unsent new-issue draft if the dialog is closed by accident.
  showModal(dialog, { kind: "create", onClose: () => { if (!parent && title.value) createDraft = { title: title.value, desc: desc.value }; } });
  title.focus();
  loadTypeFields();
}
