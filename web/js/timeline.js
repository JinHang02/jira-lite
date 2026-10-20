// Activity section of the detail panel: comments interleaved with one-line history entries, and
// editing/deleting your own comments.
import * as jira from "./api.js";
import { state } from "./state.js";
import { el, icon, toast } from "./dom.js";
import { ago } from "./format.js";
import { avatar } from "./icons.js";
import { renderAdf, textToAdf, plainSafe, adfToText } from "./adf.js";
import { buildTimeline, collapseRuns, wasEdited } from "./activity.js";
import { actions } from "./actions.js";
import { mentionsOf } from "./mentions.js";
import { attachMentions } from "./mentionpicker.js";

const PENCIL = '<path d="M9.5 2.75l1.75 1.75-6.5 6.5-2.25.5.5-2.25z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>';
const TRASH = '<path d="M2.75 4h8.5M5.5 4V2.75h3V4M4 4l.5 7.25h5L10 4" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>';

// "Show N more" groups the user expanded, per issue, so an auto-refresh doesn't fold them again.
const expanded = new Set();

const when = (iso) => el("span", { class: "when", title: new Date(iso).toLocaleString() }, ago(iso));
const isMine = (c) => !!(state.me && c.author && c.author.accountId === state.me.accountId);

/**
 * Activity entries for an issue, oldest first. `histories` is the changelog (newest first),
 * `olderHidden` how many older changes Jira didn't return. `jiraUrl` is the issue in Jira,
 * `attachments` its files (media in comments shows them).
 */
export function renderActivity(issue, comments, histories, { olderHidden = 0, jiraUrl, attachments = [] } = {}) {
  const f = issue.fields;
  const entries = collapseRuns(buildTimeline({ comments, histories, created: f.created, creator: f.creator || f.reporter }));
  const box = el("div", { class: "timeline" });
  // Jira returned only the newest changes: say so right after "created the issue".
  const note = olderHidden > 0 ? el("div", { class: "tl-line tl-note" }, el("span", { class: "tl-dot" }),
    el("a", { href: jiraUrl, target: "_blank", rel: "noopener" }, olderHidden + " older change" + (olderHidden > 1 ? "s" : "") + " in Jira ↗")) : null;
  if (note && (!entries.length || entries[0].type !== "created")) box.append(note);
  for (const e of entries) {
    if (e.type === "created") { box.append(line(e)); if (note) box.append(note); continue; }
    if (e.type === "comment") box.append(commentCard(issue.key, e.comment, jiraUrl, attachments));
    else if (e.type === "more") {
      const id = issue.key + "|" + e.id;
      if (expanded.has(id)) box.append(...e.entries.map(line));
      else {
        const more = el("button", { class: "tl-line tl-more", type: "button" }, el("span", { class: "tl-dot" }),
          "Show " + e.entries.length + " more");
        more.addEventListener("click", () => { expanded.add(id); more.replaceWith(...e.entries.map(line)); });
        box.append(more);
      }
    } else box.append(line(e));
  }
  return box;
}

/** "(avatar) Alice changed status from To Do → In Progress · 2h ago" */
function line(e) {
  const who = e.author ? e.author.displayName : "Jira";
  return el("div", { class: "tl-line" + (e.type === "created" ? " tl-created" : "") },
    el("span", { class: "tl-av" }, avatar(e.author || { displayName: who, accountId: "jira" })),
    el("span", { class: "tl-text" }, el("span", { class: "tl-who" }, who), " " + e.text + " ", el("span", { class: "tl-sep" }, "·"), " ", when(e.at)));
}

function commentCard(key, c, jiraUrl, attachments) {
  const body = el("div", { class: "cbody" }, renderAdf(c.body, { jiraUrl, attachments }));
  const edited = wasEdited(c) ? el("span", { class: "edited", title: "Edited " + new Date(c.updated).toLocaleString() }, "· edited") : null;
  const tools = el("span", { class: "ctools" });
  const card = el("div", { class: "card", "data-cid": c.id },
    el("div", { class: "who" }, avatar(c.author), el("span", { class: "name" }, c.author ? c.author.displayName : "?"), when(c.created), edited,
      el("span", { class: "spacer" }), tools),
    body);
  if (isMine(c)) {
    const editBtn = plainSafe(c.body)
      ? el("button", { class: "cbtn", type: "button", title: "Edit comment", "aria-label": "Edit comment" }, icon(14, PENCIL, ""))
      : el("a", { class: "cbtn", href: jiraUrl + "?focusedCommentId=" + encodeURIComponent(c.id), target: "_blank", rel: "noopener",
        title: "Has formatting that plain-text editing would lose: edit in Jira", "aria-label": "Edit comment in Jira" }, icon(14, PENCIL, ""));
    if (editBtn.tagName === "BUTTON") editBtn.addEventListener("click", () => editComment(key, c, card, body));
    const delBtn = el("button", { class: "cbtn", type: "button", title: "Delete comment", "aria-label": "Delete comment" }, icon(14, TRASH, ""));
    delBtn.addEventListener("click", () => confirmDelete(key, c, card, tools));
    tools.append(editBtn, delBtn);
  }
  return card;
}

/** Runs a comment write with auto-refresh paused, then reloads the panel. */
async function commentWrite(run, okMsg, failMsg) {
  state.busy = true;
  try {
    await run();
    toast(okMsg);
    state.busy = false;
    await actions.loadDetail();
    return true;
  } catch (e) {
    toast(failMsg + e.message, true);
    return false;
  } finally {
    state.busy = false;
  }
}

/** Swaps the comment body for the composer; ⌘↵ saves, Esc cancels. */
function editComment(key, c, card, body) {
  if (card.dataset.editing) return;
  card.dataset.editing = "1";
  const ta = el("textarea", { "aria-label": "Edit comment" });
  ta.value = adfToText(c.body);
  const mentions = attachMentions(ta, mentionsOf(c.body));
  const save = el("button", { class: "btn primary", type: "button" }, "Save");
  const cancel = el("button", { class: "btn", type: "button" }, "Cancel");
  const msg = el("span", { class: "cmsg" }, "⌘↵ to save · esc to cancel");
  const editor = el("div", { class: "composer cedit" }, ta, el("div", { class: "crow" }, msg, cancel, save));
  const view = body.firstChild;
  body.replaceChildren(editor);
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
  const close = () => { delete card.dataset.editing; body.replaceChildren(view); };
  const commit = async () => {
    const text = ta.value.trim();
    if (save.disabled) return;
    if (!text) { msg.textContent = "A comment can't be empty. Delete it instead."; return; }
    if (text === adfToText(c.body).trim()) return close();
    save.disabled = true;
    msg.textContent = "Saving…";
    delete card.dataset.editing;  // let the reload re-render the card
    const ok = await commentWrite(() => jira.updateComment(key, c.id, textToAdf(text, mentions)), "Comment updated", "Couldn't update the comment: ");
    if (!ok) { card.dataset.editing = "1"; save.disabled = false; msg.textContent = "⌘↵ to save · esc to cancel"; }
  };
  cancel.addEventListener("click", close);
  save.addEventListener("click", commit);
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); commit(); }
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
  });
}

/** In-place "Delete this comment?" confirmation (no window.confirm). */
function confirmDelete(key, c, card, tools) {
  if (card.dataset.editing) return;
  card.dataset.editing = "1";
  card.classList.add("confirming");
  const old = [...tools.childNodes];
  const no = el("button", { class: "btn", type: "button" }, "Cancel");
  const yes = el("button", { class: "btn danger", type: "button" }, "Delete");
  const restore = () => { delete card.dataset.editing; card.classList.remove("confirming"); tools.replaceChildren(...old); };
  no.addEventListener("click", restore);
  yes.addEventListener("click", async () => {
    yes.disabled = no.disabled = true;
    delete card.dataset.editing;
    const ok = await commentWrite(() => jira.deleteComment(key, c.id), "Comment deleted", "Couldn't delete the comment: ");
    if (!ok && card.isConnected) restore();
  });
  tools.replaceChildren(el("span", { class: "cconfirm" }, "Delete this comment?"), no, yes);
  tools.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && card.classList.contains("confirming")) { e.preventDefault(); e.stopPropagation(); restore(); }
  });
  no.focus();
}
