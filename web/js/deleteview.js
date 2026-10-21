// Delete-issue dialog, Jira-style: the Delete button only unlocks once "delete" is typed.
import * as jira from "./api.js";
import { state } from "./state.js";
import { el, icon, ICONS, toast } from "./dom.js";
import { showModal, closeModal, activeModal } from "./modal.js";
import { withoutIssue, deleteWarning, deleteTyped } from "./issues.js";
import { actions } from "./actions.js";

/** Asks to confirm deleting `key` (and its sub-tasks), then deletes it. */
export function confirmDelete(key) {
  if (state.busy) return;
  const issue = state.known.get(key) || state.issues.find((i) => i.key === key);
  const f = (issue && issue.fields) || {};
  const subtasks = (f.subtasks || []).length;
  const children = [...state.known.values()].filter((i) => i.fields && i.fields.parent && i.fields.parent.key === key && !(i.fields.issuetype || {}).subtask).length;

  const input = el("input", { class: "delinput", placeholder: "delete", autocomplete: "off", spellcheck: "false", "aria-label": "Type delete to confirm" });
  const del = el("button", { class: "btn danger", type: "button", disabled: "" }, "Delete");
  const cancel = el("button", { class: "btn", type: "button", onclick: closeModal }, "Cancel");
  const msg = el("span", { class: "cmsg" });
  input.addEventListener("input", () => { del.disabled = !deleteTyped(input.value); });

  const run = async () => {
    if (!deleteTyped(input.value) || state.busy) return;
    state.busy = true;
    del.disabled = input.disabled = cancel.disabled = true;
    msg.textContent = "Deleting…";
    try {
      await jira.deleteIssue(key, subtasks > 0);
    } catch (e) {
      state.busy = false;
      del.disabled = input.disabled = cancel.disabled = false;
      msg.textContent = "";
      if (!e.loginRequired) toast("Delete failed: " + e.message, true);
      return;
    }
    state.busy = false;
    if (activeModal() && activeModal().kind === "delete") closeModal();  // not another dialog opened meanwhile
    if (state.current === key) actions.closeDetail();
    state.issues = withoutIssue(state.issues, key);
    state.known.delete(key);
    actions.renderMain();
    toast("Deleted " + key);
    // The view showed this epic's children: back to whose issues it was (setWho also clears the epic).
    if (state.epic === key) return actions.setWho(state.who);
    actions.sync();
    actions.loadEpics();
  };
  del.addEventListener("click", run);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); run(); } });

  const dialog = el("div", { class: "modal deldialog", role: "alertdialog", "aria-label": "Delete " + key },
    el("div", { class: "mhead" }, el("span", { class: "deltitle" }, "Delete " + key + "?"), el("span", { class: "spacer" }),
      el("button", { class: "btn icon", type: "button", title: "Close (esc)", "aria-label": "Close", onclick: closeModal }, icon(14, ICONS.close, ""))),
    el("div", { class: "mbody" },
      f.summary ? el("p", { class: "delsum" }, f.summary) : null,
      deleteWarning({ subtasks, children }).map((t) => el("p", {}, t)),
      el("label", { class: "dellabel" }, el("span", {}, "Type ", el("b", {}, "delete"), " to confirm"), input)),
    el("div", { class: "mfoot" }, msg, el("span", { class: "spacer" }), cancel, del));
  showModal(dialog, { kind: "delete" });
  input.focus();
}
