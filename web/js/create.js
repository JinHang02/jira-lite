// New issue / new sub-issue dialog, including selects for fields Jira requires (e.g. Client, Fix versions).
import * as jira from "./api.js";
import { state, store, recall, stash, unstash } from "./state.js";
import { el, icon, ICONS, toast } from "./dom.js";
import { prioIcon, avatar, logo } from "./icons.js";
import { typeIcon } from "./typeicons.js";
import { fromMarkdown } from "./markdown.js";
import { showModal, closeModal } from "./modal.js";
import { openMenu } from "./menu.js";
import { issueTypes, typeFields } from "./meta.js";
import { actions } from "./actions.js";

// Fields the dialog sets itself (or Jira fills), so they never get a generic required-field select.
const HANDLED = new Set(["summary", "issuetype", "project", "reporter", "parent", "description", "priority", "assignee"]);
const LIST_SVG = '<path d="M3 4h8M3 7h8M3 10h5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>';
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

/**
 * A pill showing an icon and the selected option's label, with the native <select> laid over it
 * (invisible) so keyboard, screen readers and the OS picker still work. `lead(value)` gives the icon.
 */
function chipSelect(label, options, value, lead, cls = "") {
  const s = el("select", { "aria-label": label }, options.map(([v, text]) => el("option", { value: v }, text)));
  s.value = value;
  const leadBox = el("span", { class: "clead" });
  const text = el("span", { class: "ctext" });
  const chip = el("label", { class: "chip csel" + (cls ? " " + cls : ""), title: label },
    leadBox, text, icon(14, ICONS.chev, "cchev"), s);
  const sync = () => {
    const opt = s.selectedOptions[0];
    leadBox.replaceChildren(lead ? lead(s.value) || "" : "");
    text.textContent = opt ? opt.textContent : "";
    chip.classList.toggle("empty", !s.value);
  };
  s.addEventListener("change", sync);
  sync();
  return { chip, s };
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

  const title = el("input", { class: "ntitle", placeholder: parent ? "Sub-issue title" : "Issue title", autocomplete: "off", "aria-label": "Title" });
  const desc = el("textarea", { class: "ndesc", placeholder: "Description", "aria-label": "Description", title: "Markdown works: **bold**, - lists, - [ ] checklists, `code`" });
  if (!parent) { title.value = createDraft.title; desc.value = createDraft.desc; }

  const type = chipSelect("Issue type", types.map((t) => [t.id, t.name]), defType, (v) => typeIcon(types.find((t) => t.id === v)));
  const defPrio = (priorities.find((p) => p.name === "Medium") || priorities[0] || {}).id || "";
  const prio = chipSelect("Priority", [["", "No priority"], ...priorities.map((p) => [p.id, p.name])], defPrio,
    (v) => prioIcon(priorities.find((p) => p.id === v)));
  const ppl = [...(me ? [me] : []), ...people.filter((u) => !me || u.accountId !== me.accountId)];
  const who = chipSelect("Assignee", [["", "Unassigned"], ...ppl.map((u) => [u.accountId, u.displayName + (me && u.accountId === me.accountId ? " (me)" : "")])],
    me ? me.accountId : "", (v) => avatar(ppl.find((u) => u.accountId === v) || null));
  who.chip.title = "Assignee: who will work on it. You'll be the reporter (Jira sets the creator).";
  // Everyone assignable, searchable, with avatars (like the assignee menu elsewhere) instead of the OS dropdown.
  const pickWho = (e) => {
    e.preventDefault();
    const cur = who.s.value;
    const items = [{ id: "", label: "Unassigned", icon: avatar(null), current: !cur },
      ...ppl.map((u) => ({ id: u.accountId, label: u.displayName + (me && u.accountId === me.accountId ? " (me)" : ""), icon: avatar(u), current: u.accountId === cur }))];
    openMenu(who.chip, "Assignee", items, (it) => {
      who.s.value = it.id;
      who.s.dispatchEvent(new Event("change"));
      who.s.focus({ preventScroll: true });
    }, { search: true });
  };
  // mousedown only stops the OS dropdown: opening the menu there would let the outside-click
  // handler (menu.js, also on mousedown) close it at once.
  who.s.addEventListener("mousedown", (e) => e.preventDefault());
  who.s.addEventListener("click", pickWho);
  who.s.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown") pickWho(e); });
  const extras = el("div", { class: "props" });
  const reqSec = el("div", { class: "reqsec", hidden: true }, el("div", { class: "reqh" }, "Required by Jira"), extras);
  const warn = el("div", { class: "warn" });
  let dynamic = [];  // [{field, s, chip}]
  let fieldIds = new Set();
  let typeSeq = 0;

  // Required fields Jira insists on (e.g. Client, Fix versions) get a select; sub-issues inherit the parent's value.
  async function loadTypeFields() {
    const seq = ++typeSeq;
    extras.replaceChildren();
    reqSec.hidden = true;
    warn.textContent = "";
    dynamic = [];
    let fields;
    try { fields = await typeFields(type.s.value); } catch (e) { warn.textContent = "Couldn't load fields: " + e.message; return; }
    if (seq !== typeSeq) return;
    fieldIds = new Set(fields.map((x) => x.fieldId));
    const need = fields.filter((x) => x.required && !x.hasDefaultValue && !HANDLED.has(x.fieldId));
    let inherited = {};
    if (parent && need.length) {
      try { inherited = (await jira.getIssue(parent.key, need.map((x) => x.fieldId))).fields || {}; } catch (e) { /* no inheritance */ }
      if (seq !== typeSeq) return;
    }
    const unsupported = [];
    for (const fld of need) {
      const av = fld.allowedValues || [];
      if (!av.length) { unsupported.push(fld.name); continue; }
      const pv = inherited[fld.fieldId];
      const pid = Array.isArray(pv) ? (pv[0] || {}).id : (pv || {}).id;
      const last = recall("last." + fld.fieldId);
      const val = av.some((v) => v.id === pid) ? pid : (av.some((v) => v.id === last) ? last : "");
      const sel = chipSelect(fld.name + " (required by Jira)", [["", fld.name + "…"], ...av.filter((v) => !v.archived).map((v) => [v.id, v.name || v.value])], val,
        () => icon(14, LIST_SVG, "cfield"), "req");
      sel.s.addEventListener("change", () => sel.chip.classList.remove("bad"));
      dynamic.push({ field: fld, s: sel.s, chip: sel.chip });
      extras.append(sel.chip);
    }
    reqSec.hidden = !dynamic.length;
    if (unsupported.length) warn.textContent = "Jira also requires " + unsupported.join(", ") + ", which can't be set here yet. Create it in Jira instead.";
  }
  type.s.addEventListener("change", loadTypeFields);

  const msg = el("span", { class: "cmsg" });
  const create = el("button", { class: "btn primary", type: "button" }, parent ? "Create sub-issue" : "Create issue");
  const cancel = el("button", { class: "btn", type: "button", onclick: closeModal }, "Cancel");

  async function submit() {
    if (create.disabled) return;
    const summary = title.value.trim();
    if (!summary) { title.focus(); msg.textContent = "Add a title first."; return; }
    const missing = dynamic.filter((d) => !d.s.value);
    dynamic.forEach((d) => d.chip.classList.toggle("bad", !d.s.value));
    if (missing.length) { msg.textContent = "Pick " + missing.map((d) => d.field.name).join(", ") + "."; return; }
    const fields = { project: { key: cfg.project }, issuetype: { id: type.s.value }, summary };
    if (desc.value.trim()) fields.description = fromMarkdown(desc.value.trim());
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
      toast("Created " + r.key);
      closeModal();
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

  const dialog = el("div", { class: "modal cdialog", role: "dialog", "aria-label": parent ? "New sub-issue" : "New issue" },
    el("div", { class: "mhead" }, logo(20),
      el("span", {}, parent ? parent.key + " › New sub-issue" : "New issue"),
      el("span", { class: "spacer" }), el("button", { class: "btn icon", type: "button", title: "Close (esc)", "aria-label": "Close", onclick: closeModal }, icon(14, ICONS.close, ""))),
    el("div", { class: "mbody" }, title, desc,
      el("div", { class: "props" }, type.chip, prio.chip, who.chip), reqSec, warn),
    el("div", { class: "mfoot" }, msg, el("span", { class: "spacer" }), cancel, create, el("kbd", { title: "Create" }, "⌘↵")));
  dialog.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); }
    else if (e.key === "Enter" && e.target === title) { e.preventDefault(); desc.focus(); }
  });
  // Keep an unsent new-issue draft if the dialog is closed by accident.
  showModal(dialog, { kind: "create", onClose: () => { if (!parent && title.value) createDraft = { title: title.value, desc: desc.value }; } });
  title.focus();
  loadTypeFields();
}
