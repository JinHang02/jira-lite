// Detail (peek) panel: issue header, editable title/description, properties, sub-issues, activity.
import * as jira from "./api.js";
import { state, stash, unstash, issueByKey } from "./state.js";
import { $, el, icon, ICONS, toast } from "./dom.js";
import { childrenJql } from "./jql.js";
import { progress } from "./issues.js";
import { statusIcon, prioIcon, avatar } from "./icons.js";
import { renderAdf, textToAdf, copyText } from "./adf.js";
import { toMarkdown, fromMarkdown } from "./markdown.js";
import { isImage } from "./attachments.js";
import { statusMenu, priorityMenu, assigneeMenu, updateFields } from "./edits.js";
import { typeFields } from "./meta.js";
import { requiredCustomFields, ancestry } from "./props.js";
import { renderProps, typeMenu } from "./propsview.js";
import { renderActivity } from "./timeline.js";
import { typeIcon, typeKind } from "./typeicons.js";
import { markRows } from "./cursor.js";
import { actions } from "./actions.js";
import { mentionsOf } from "./mentions.js";
import { attachMentions } from "./mentionpicker.js";
import { renderAttachments, bindDrop } from "./attachview.js";
import { bindImages } from "./descimages.js";
import { confirmDelete } from "./deleteview.js";
import { openViewer } from "./viewer.js";

const HASH_SVG = '<path d="M5.25 2.5l-1 9M9.75 2.5l-1 9M2.75 5.25h9M2.25 8.75h9" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>';
const LINK_SVG = '<path d="M6 8a2.5 2.5 0 0 0 3.5.25l1.75-1.75a2.5 2.5 0 0 0-3.5-3.5l-.75.75M8 6a2.5 2.5 0 0 0-3.5-.25L2.75 7.5a2.5 2.5 0 0 0 3.5 3.5l.75-.75" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>';
const TRASH_SVG = '<path d="M2.75 4h8.5M5.5 4V2.75h3V4M3.75 4l.5 7.25h5.5l.5-7.25M5.75 6v3.5M8.25 6v3.5" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>';
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
    d.replaceChildren(header(key, issueByKey(key)), el("div", { class: "dscroll" }, el("p", { class: "nodesc" }, "Loading…")));
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

// editmeta per issue key, for the issue type + status it was fetched for (what may be edited
// can depend on both, e.g. a Done status locking fields): a change of either refetches it.
const editMetas = new Map();
const metaSig = (i) => (i && i.fields ? ((i.fields.issuetype || {}).id || "") + "|" + ((i.fields.status || {}).id || "") : null);

/** What the user may change on the issue (editmeta fields); {} if it can't be loaded. */
function editMeta(key, typeId) {
  const hit = editMetas.get(key);
  if (hit && hit.type === typeId) return hit.p;
  const p = jira.getEditMeta(key).catch((e) => {
    if (e.loginRequired) throw e;
    if (editMetas.get(key) === entry) editMetas.delete(key);
    return {};
  });
  const entry = { type: typeId, p };
  editMetas.set(key, entry);
  return p;
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
    let [issue, comments, children, meta] = await Promise.all([
      jira.getIssueDetail(key, ["attachment", ...customs.map((c) => c.id)]),
      jira.getComments(key),
      jira.searchIssues(childrenJql(key)).catch(() => []),
      editMeta(key, metaSig(known)),
    ]);
    if (stale()) return;
    if (metaSig(issue) !== metaSig(known)) meta = await editMeta(key, metaSig(issue));
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
    renderDetail(issue, comments, children, { customs, meta, histories, olderHidden: Math.max(0, (log.total || 0) - histories.length) });
  } catch (e) {
    if (!stale()) {
      $("#detail").replaceChildren(header(key), el("div", { class: "dscroll" }, el("p", { style: "color:var(--err)" }, e.message)));
    }
  }
}

// Parents fetched only to complete a breadcrumb (a sub-task whose parent isn't loaded): key -> issue.
const lineage = new Map();
const lookup = (k) => issueByKey(k) || lineage.get(k) || null;

/** Breadcrumb: the epic and parent (type icon + key, click to open) › this issue. */
function crumbs(issue) {
  const box = el("span", { class: "crumbs" });
  const crumb = (i, here) => {
    const f = i.fields || {};
    const kids = [f.issuetype ? typeIcon(f.issuetype) : null, el("span", {}, i.key)];
    const title = i.key + (f.issuetype ? " · " + f.issuetype.name : "") + (f.summary ? " · " + f.summary : "");
    if (here) return el("span", { class: "crumb ckey", title }, kids);
    const b = el("button", { class: "crumb clink", type: "button", title: "Open " + title }, kids);
    b.addEventListener("click", () => openIssue(i.key));
    return b;
  };
  const fill = () => {
    const up = ancestry(issue, lookup);
    box.replaceChildren(...up.flatMap((a) => [crumb(a), el("span", { class: "csep" }, "›")]), crumb(issue, true));
    return up;
  };
  const top = fill()[0];
  if (top && typeKind((top.fields || {}).issuetype) !== "epic" && !lookup(top.key)) {
    jira.getIssue(top.key, ["summary", "issuetype", "parent"]).then((r) => {
      lineage.set(r.key, r);
      if (box.isConnected) fill();
    }, () => { /* the breadcrumb just stays shorter */ });
  }
  return box;
}

/** Panel header: breadcrumb (once the issue is loaded), copy key/link, open in Jira, delete, close. */
function header(key, issue) {
  const iconBtn = (title, svg, onclick) => {
    const b = el("button", { class: "btn icon", type: "button", title, "aria-label": title }, icon(14, svg, ""));
    b.addEventListener("click", onclick);
    return b;
  };
  return el("div", { class: "dh", "data-key": key },
    issue ? crumbs(issue) : el("span", { class: "crumbs" }, el("span", { class: "crumb ckey" }, key)),
    el("span", { class: "spacer" }),
    iconBtn("Copy key " + key, HASH_SVG, () => copyText(key, key)),
    iconBtn("Copy link", LINK_SVG, () => copyText(browseUrl(key), "link to " + key)),
    el("a", { class: "btn icon", href: browseUrl(key), target: "_blank", rel: "noopener", title: "Open in Jira", "aria-label": "Open in Jira" }, icon(14, OPEN_SVG, "")),
    iconBtn("Delete issue…", TRASH_SVG, () => confirmDelete(key)),
    el("span", { class: "dhsep" }),
    el("button", { class: "btn icon", type: "button", title: "Close (esc)", "aria-label": "Close", onclick: closeDetail }, icon(14, ICONS.close, "")));
}

function renderDetail(issue, comments, children, { customs, meta, histories, olderHidden }) {
  const f = issue.fields;
  const d = $("#detail");
  // Don't clobber an inline editor (comment edit, labels, due date, delete confirm) on auto-refresh.
  if (d.querySelector('.dscroll[data-key="' + CSS.escape(issue.key) + '"] [data-editing]')) return;
  // Keep an unsent comment draft and the scroll position across auto-refreshes.
  const oldBox = $("#cbox");
  const draft = oldBox && oldBox.dataset.key === issue.key ? oldBox.value : stashedComment(issue.key);
  // Someone typing in the box while the panel re-renders must keep focus: otherwise the next keys
  // land on the page and run shortcuts (j/k move, s/p/a open menus) instead of being typed.
  const caret = oldBox && oldBox.dataset.key === issue.key && document.activeElement === oldBox
    ? [oldBox.selectionStart, oldBox.selectionEnd] : null;
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
  const startEdit = () => { if (!descHolder.querySelector("[data-editing]")) editDescription(descHolder, issue.key, f.description); };
  const descEdit = el("button", { class: "link", type: "button", title: "Edit description (or double-click it)", onclick: startEdit }, f.description ? "Edit" : "Add");
  descHolder.addEventListener("dblclick", (e) => {
    if (e.target.closest("a, button, summary, .codeblock, .composer")) return;  // links, copy buttons, code; the editor itself
    e.preventDefault();
    getSelection().removeAllRanges();  // the double-click selected a word
    startEdit();
  });
  const types = (meta.issuetype && meta.issuetype.allowedValues) || [];

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
      !f.issuetype ? null : types.length > 1
        ? chip("tchip", "Change type", [typeIcon(f.issuetype), f.issuetype.name], (b) => typeMenu(issue.key, f.issuetype, types, b))
        : el("span", { class: "chip", title: "Issue type" }, typeIcon(f.issuetype), f.issuetype.name)),
    renderProps(issue, customs, meta),
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

  // Images (in the description, comments or the attachment list) open in the viewer, like Jira.
  main.addEventListener("click", (e) => {
    const a = e.target.closest("a.adf-img, a.atttile");
    if (!a || e.metaKey || e.ctrlKey || e.shiftKey || e.button) return;  // ⌘-click still opens a tab
    const id = a.dataset.att || (/\/files\/content\/(\d+)/.exec(a.getAttribute("href") || "") || [])[1];
    const att = attachments.find((x) => String(x.id) === String(id));
    if (!att || !isImage(att)) return;
    e.preventDefault();
    openViewer(attachments, att.id, jiraUrl);
  });
  const body = el("div", { class: "dscroll", "data-key": issue.key }, main);
  d.replaceChildren(header(issue.key, issue), body);
  body.scrollTop = scrollTop;
  if (caret) {
    box.focus({ preventScroll: true });
    box.setSelectionRange(caret[0], caret[1]);
  }
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

/**
 * Markdown description editor (see markdown.js). Parts Markdown can't hold (images, tables,
 * panels…) appear as ⟦n · …⟧ lines and are saved back unchanged; deleting such a line removes it.
 * Pasted or dropped images are uploaded and embedded (descimages.js).
 */
function editDescription(holder, key, doc) {
  const { text: original, kept } = toMarkdown(doc);
  const ta = el("textarea", { class: "mdedit", placeholder: "Add a description… Markdown works: **bold**, _italic_, - lists, `code`, [link](url)", "aria-label": "Description" });
  ta.value = original;
  const mentions = attachMentions(ta, mentionsOf(doc));
  const save = el("button", { class: "btn primary", type: "button" }, "Save");
  const cancel = el("button", { class: "btn", type: "button" }, "Cancel");
  const hint = "Markdown · paste or drop images · " + (kept.length ? "⟦…⟧ parts stay as they are · " : "") + "⌘↵ to save";
  const msg = el("span", { class: "cmsg" }, hint);
  let uploading = 0, uploaded = false;
  const image = bindImages(ta, key, kept, (n) => {
    uploading = n;
    uploaded = uploaded || n > 0;
    save.disabled = n > 0;
    msg.textContent = n ? "Uploading " + n + " image" + (n > 1 ? "s" : "") + "…" : hint;
  });
  const box = el("div", { class: "composer", "data-editing": "1" }, ta, el("div", { class: "crow" }, msg, image, cancel, save));
  const view = holder.firstChild;
  holder.replaceChildren(box);
  const fit = () => { ta.style.height = "auto"; ta.style.height = Math.min(Math.max(ta.scrollHeight + 2, 140), innerHeight * 0.6) + "px"; };
  ta.addEventListener("input", fit);
  fit();
  ta.focus();
  const restore = () => {
    holder.replaceChildren(view);
    if (uploaded) loadDetail();  // show the new attachments
  };
  const commit = () => {
    if (uploading || save.disabled) return;  // image lines not in yet, or already saving (⌘↵ twice)
    if (ta.value === original) return restore();
    const text = ta.value.replace(/^\s*\n/, "").trimEnd();  // keep the first line's indent
    save.disabled = true;
    delete box.dataset.editing;  // let the reload after saving re-render
    // On failure keep the editor and the typed text (no reload over it).
    updateFields(key, { description: text.trim() ? fromMarkdown(text, { kept, mentions }) : null }, key + " description updated",
      () => { box.dataset.editing = "1"; save.disabled = false; ta.focus(); });
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
