// Detail (peek) panel: issue header, editable title/description, properties, sub-issues, activity.
import * as jira from "./api.js";
import { state, stash, unstash, issueByKey } from "./state.js";
import { $, el, icon, ICONS, toast } from "./dom.js";
import { childrenJql } from "./jql.js";
import { progress } from "./issues.js";
import { statusIcon, prioIcon, avatar } from "./icons.js";
import { renderAdf, textToAdf, plainSafe, adfToText, copyText } from "./adf.js";
import { statusMenu, priorityMenu, assigneeMenu, updateFields } from "./edits.js";
import { typeFields } from "./meta.js";
import { requiredCustomFields } from "./props.js";
import { renderProps } from "./propsview.js";
import { renderActivity } from "./timeline.js";
import { typeIcon } from "./typeicons.js";
import { markRows } from "./cursor.js";
import { actions } from "./actions.js";
import { mentionsOf } from "./mentions.js";
import { attachMentions } from "./mentionpicker.js";
import { renderAttachments, bindDrop } from "./attachview.js";

const HASH_SVG = '<path d="M5.25 2.5l-1 9M9.75 2.5l-1 9M2.75 5.25h9M2.25 8.75h9" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>';
const LINK_SVG = '<path d="M6 8a2.5 2.5 0 0 0 3.5.25l1.75-1.75a2.5 2.5 0 0 0-3.5-3.5l-.75.75M8 6a2.5 2.5 0 0 0-3.5-.25L2.75 7.5a2.5 2.5 0 0 0 3.5 3.5l.75-.75" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>';
const OPEN_SVG = '<path d="M8.5 2.5h3v3M11.5 2.5L6.5 7.5M10 8.5v2a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h2" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>';

let detailSeq = 0;
// People picked with @ in each issue's comment composer ("@Name" -> accountId), kept across
// re-renders like the draft text itself.
const composerMentions = new Map();
const mentionsFor = (key) => {
  if (!composerMentions.has(key)) composerMentions.set(key, new Map());
  return composerMentions.get(key);
};
const browseUrl = (key) => state.cfg.site + "/browse/" + key;

export function openIssue(key) {
  state.current = state.cursor = key;
  history.replaceState(null, "", "#" + key);
  markRows();
  const d = $("#detail");
  d.hidden = false;
  bindDrop();
  if (!d.querySelector('.dh[data-key="' + CSS.escape(key) + '"]')) {
    d.replaceChildren(header(key), el("div", { class: "dscroll" }, el("p", { class: "nodesc" }, "Loading…")));
  }
  loadDetail();
}

export function closeDetail() {
  state.current = null;
  history.replaceState(null, "", location.pathname + location.search);
  $("#detail").hidden = true;
  markRows();
}

/** Required custom fields ({id, name}) of an issue type from createmeta; [] if unavailable. */
function requiredCustoms(typeId) {
  if (!typeId) return Promise.resolve([]);
  return typeFields(typeId).then(requiredCustomFields, (e) => { if (e.loginRequired) throw e; return []; });
}

/** (Re)loads the open issue with its changelog, comments and children. Stale responses are dropped. */
export async function loadDetail() {
  const key = state.current;
  if (!key) return;
  const seq = ++detailSeq;
  const stale = () => seq !== detailSeq || key !== state.current;
  try {
    // Ask for the custom fields Jira requires on create (e.g. Client) in the same request when the
    // issue type is already known from the list; otherwise fetch them afterwards.
    const known = issueByKey(key);
    const guess = known && known.fields.issuetype ? known.fields.issuetype.id : null;
    let customs = await requiredCustoms(guess);
    const [issue, comments, children] = await Promise.all([
      jira.getIssueDetail(key, ["attachment", ...customs.map((c) => c.id)]),
      jira.getComments(key),
      jira.searchIssues(childrenJql(key)).catch(() => []),
    ]);
    if (stale()) return;
    const typeId = issue.fields.issuetype ? issue.fields.issuetype.id : null;
    if (typeId !== guess) {
      customs = await requiredCustoms(typeId);
      const missing = customs.filter((c) => !(c.id in issue.fields)).map((c) => c.id);
      if (missing.length) {
        try { Object.assign(issue.fields, (await jira.getIssue(key, missing)).fields || {}); } catch (e) { if (e.loginRequired) throw e; }
      }
      if (stale()) return;
    }
    const log = issue.changelog || {};
    delete issue.changelog;  // keep the cached issue small
    const histories = log.histories || [];
    state.known.set(issue.key, issue);
    for (const c of children) state.known.set(c.key, c);
    renderDetail(issue, comments, children, { customs, histories, olderHidden: Math.max(0, (log.total || 0) - histories.length) });
  } catch (e) {
    if (!stale()) {
      $("#detail").replaceChildren(header(key), el("div", { class: "dscroll" }, el("p", { style: "color:var(--err)" }, e.message)));
    }
  }
}

/** Panel header: breadcrumb, copy key/link, open in Jira, close. */
function header(key) {
  const iconBtn = (title, svg, onclick) => {
    const b = el("button", { class: "btn icon", type: "button", title, "aria-label": title }, icon(14, svg, ""));
    b.addEventListener("click", onclick);
    return b;
  };
  return el("div", { class: "dh", "data-key": key },
    el("span", { class: "crumb" }, state.cfg.project), el("span", { class: "csep" }, "›"),
    el("span", { class: "crumb ckey" }, key),
    el("span", { class: "spacer" }),
    iconBtn("Copy key " + key, HASH_SVG, () => copyText(key, key)),
    iconBtn("Copy link", LINK_SVG, () => copyText(browseUrl(key), "link to " + key)),
    el("a", { class: "btn icon", href: browseUrl(key), target: "_blank", rel: "noopener", title: "Open in Jira", "aria-label": "Open in Jira" }, icon(14, OPEN_SVG, "")),
    el("span", { class: "dhsep" }),
    el("button", { class: "btn icon", type: "button", title: "Close (esc)", "aria-label": "Close", onclick: closeDetail }, icon(14, ICONS.close, "")));
}

function renderDetail(issue, comments, children, { customs, histories, olderHidden }) {
  const f = issue.fields;
  const d = $("#detail");
  // Don't clobber an inline editor (comment edit, labels, due date, delete confirm) on auto-refresh.
  if (d.querySelector('.dscroll[data-key="' + CSS.escape(issue.key) + '"] [data-editing]')) return;
  // Keep an unsent comment draft and the scroll position across auto-refreshes.
  const oldBox = $("#cbox");
  const draft = oldBox && oldBox.dataset.key === issue.key ? oldBox.value : stashedComment(issue.key);
  const scroll = d.querySelector(".dscroll[data-key='" + CSS.escape(issue.key) + "']");
  const scrollTop = scroll ? scroll.scrollTop : 0;
  const jiraUrl = browseUrl(issue.key);

  const chip = (id, title, kids, onclick) => {
    const b = el("button", { class: "chip", id, title, type: "button" }, kids);
    b.addEventListener("click", () => onclick(b));
    return b;
  };
  const h1 = el("h1", { class: "dtitle", title: "Click to edit" }, f.summary);
  h1.addEventListener("click", () => editTitle(h1, issue.key, f.summary));

  const box = el("textarea", { id: "cbox", placeholder: "Leave a comment…", "aria-label": "New comment" });
  box.dataset.key = issue.key;
  box.value = draft;
  const picked = attachMentions(box, mentionsFor(issue.key));
  const send = el("button", { class: "btn primary", type: "button" }, "Comment");
  const cmsg = el("span", { class: "cmsg" }, "⌘↵ to send");
  const submit = () => postComment(issue.key, box, send, cmsg, picked);
  send.addEventListener("click", submit);
  box.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit(); });

  const attachments = f.attachment || [];
  const descHolder = el("div", {}, f.description ? renderAdf(f.description, { jiraUrl, attachments }) : el("p", { class: "nodesc" }, "No description."));
  const descEdit = plainSafe(f.description)
    ? el("button", { class: "link", type: "button", onclick: () => editDescription(descHolder, issue.key, f.description) }, f.description ? "Edit" : "Add")
    : el("a", { class: "link", href: jiraUrl, target: "_blank", rel: "noopener", title: "Has formatting that plain-text editing would lose" }, "Edit in Jira ↗");

  const isSub = f.issuetype && f.issuetype.subtask;
  const { done } = progress(children);
  const subRows = children.map((c) => {
    const sb = el("button", { class: "ibtn", type: "button", title: c.fields.status.name + " · change status" }, statusIcon(c.fields.status));
    sb.addEventListener("click", (e) => { e.stopPropagation(); statusMenu(c.key, sb); });
    return el("div", { class: "subrow", onclick: () => openIssue(c.key) },
      sb, el("span", { class: "rid" }, c.key), el("span", { class: "rtitle" }, c.fields.summary), avatar(c.fields.assignee));
  });

  const main = el("div", { class: "dlayout" },
    f.parent ? el("button", { class: "parent", type: "button", title: "Open parent", onclick: () => openIssue(f.parent.key) },
      icon(14, ICONS.up, ""), el("span", {}, f.parent.key + " · " + ((f.parent.fields || {}).summary || ""))) : null,
    h1,
    el("div", { class: "props" },
      chip("schip", "Change status (s)", [statusIcon(f.status), f.status.name], (b) => statusMenu(issue.key, b)),
      chip("pchip", "Change priority (p)", [prioIcon(f.priority), f.priority ? f.priority.name : "No priority"], (b) => priorityMenu(issue.key, b)),
      chip("achip", "Change assignee (a)", [avatar(f.assignee), f.assignee ? f.assignee.displayName : "Unassigned"], (b) => assigneeMenu(issue.key, b)),
      f.issuetype ? el("span", { class: "chip", title: "Issue type" }, typeIcon(f.issuetype), f.issuetype.name) : null),
    renderProps(issue, customs),
    el("div", { class: "sec" }, "Description", el("span", { class: "spacer" }), descEdit),
    descHolder,
    renderAttachments(issue),
    isSub ? null : el("div", { class: "sec" }, "Sub-issues" + (children.length ? " · " + done + "/" + children.length + " done" : ""),
      el("span", { class: "spacer" }),
      el("button", { class: "link", type: "button", onclick: () => actions.openCreate(issue) }, "+ Add sub-issue")),
    isSub || !children.length ? null : el("div", { class: "subs" }, subRows),
    el("div", { class: "sec" }, "Activity" + (comments.length ? " · " + comments.length + " comment" + (comments.length > 1 ? "s" : "") : "")),
    renderActivity(issue, comments, histories, { olderHidden, jiraUrl, attachments }),
    el("div", { class: "composer" }, box, el("div", { class: "crow" }, cmsg, send)));

  const body = el("div", { class: "dscroll", "data-key": issue.key }, main);
  d.replaceChildren(header(issue.key), body);
  body.scrollTop = scrollTop;
}

/** A comment draft for `key` saved before a sign-in round trip (see auth.requireLogin), or "". */
function stashedComment(key) {
  const raw = unstash("commentDraft");
  if (!raw) return "";
  try {
    const d = JSON.parse(raw);
    if (d && d.key === key && typeof d.text === "string") return d.text;
  } catch (e) { return ""; }
  stash("commentDraft", raw);  // belongs to another issue: keep it for that one
  return "";
}

/** Swaps the title for a textarea; Enter or blur saves, Escape cancels. */
function editTitle(h1, key, old) {
  const ta = el("textarea", { class: "dtitle", rows: "1", "aria-label": "Title" });
  ta.value = old;
  const fit = () => { ta.style.height = "auto"; ta.style.height = ta.scrollHeight + "px"; };
  ta.addEventListener("input", fit);
  h1.replaceWith(ta);
  fit();
  ta.focus();
  ta.setSelectionRange(old.length, old.length);
  let done = false;
  const finish = (save) => {
    if (done) return;
    done = true;
    const v = ta.value.replace(/\s+/g, " ").trim();
    if (save && v && v !== old) {
      h1.textContent = v;
      ta.replaceWith(h1);
      updateFields(key, { summary: v }, key + " title updated");
    } else ta.replaceWith(h1);
  };
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); finish(true); }
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); finish(false); }
  });
  ta.addEventListener("blur", () => finish(true));
}

/** Plain-text description editor (only offered when plainSafe). */
function editDescription(holder, key, doc) {
  const ta = el("textarea", { placeholder: "Add a description…", "aria-label": "Description" });
  ta.value = adfToText(doc);
  const mentions = attachMentions(ta, mentionsOf(doc));
  const save = el("button", { class: "btn primary", type: "button" }, "Save");
  const cancel = el("button", { class: "btn", type: "button" }, "Cancel");
  const box = el("div", { class: "composer", "data-editing": "1" }, ta, el("div", { class: "crow" }, el("span", { class: "cmsg" }, "⌘↵ to save"), cancel, save));
  const view = holder.firstChild;
  holder.replaceChildren(box);
  ta.style.minHeight = "140px";
  ta.focus();
  const restore = () => holder.replaceChildren(view);
  const commit = () => {
    const text = ta.value.trim();
    save.disabled = true;
    delete box.dataset.editing;  // let the reload after saving re-render
    updateFields(key, { description: text ? textToAdf(text, mentions) : null }, key + " description updated");
  };
  cancel.addEventListener("click", restore);
  save.addEventListener("click", commit);
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) commit();
    else if (e.key === "Escape") { e.stopPropagation(); restore(); }
  });
}

async function postComment(key, box, btn, msg, mentions) {
  if (!box.value.trim() || btn.disabled) return;
  state.busy = true;
  btn.disabled = true;
  msg.textContent = "Sending…";
  try {
    await jira.addComment(key, textToAdf(box.value, mentions));
    box.value = "";
    mentions.clear();
    state.busy = false;
    await loadDetail();
    const s = $("#detail .dscroll");
    if (s) s.scrollTop = s.scrollHeight;
  } catch (e) {
    msg.textContent = "";
    toast("Comment failed: " + e.message, true);
    btn.disabled = false;
  } finally {
    state.busy = false;
  }
}
