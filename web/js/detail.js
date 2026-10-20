// Detail (peek) panel: issue header, editable title/description, properties, sub-issues, comments.
import * as jira from "./api.js";
import { state, stash, unstash } from "./state.js";
import { $, el, icon, ICONS, toast } from "./dom.js";
import { childrenJql } from "./jql.js";
import { progress } from "./issues.js";
import { ago, shortDate } from "./format.js";
import { statusIcon, prioIcon, avatar } from "./icons.js";
import { renderAdf, textToAdf, plainSafe, adfToText } from "./adf.js";
import { statusMenu, priorityMenu, assigneeMenu, updateFields } from "./edits.js";
import { markRows } from "./cursor.js";
import { actions } from "./actions.js";

let detailSeq = 0;
const browseUrl = (key) => state.cfg.site + "/browse/" + key;

export function openIssue(key) {
  state.current = state.cursor = key;
  history.replaceState(null, "", "#" + key);
  markRows();
  const d = $("#detail");
  d.hidden = false;
  if (!d.querySelector('.dh[data-key="' + CSS.escape(key) + '"]')) {
    d.replaceChildren(el("div", { class: "dh" }, el("span", { class: "crumb" }, key)), el("div", { class: "dscroll" }, el("p", { class: "nodesc" }, "Loading…")));
  }
  loadDetail();
}

export function closeDetail() {
  state.current = null;
  history.replaceState(null, "", location.pathname + location.search);
  $("#detail").hidden = true;
  markRows();
}

/** (Re)loads the open issue with its comments and children. Stale responses are dropped. */
export async function loadDetail() {
  const key = state.current;
  if (!key) return;
  const seq = ++detailSeq;
  try {
    const [issue, comments, children] = await Promise.all([
      jira.getIssue(key),
      jira.getComments(key),
      jira.searchIssues(childrenJql(key)).catch(() => []),
    ]);
    if (seq !== detailSeq || key !== state.current) return;
    state.known.set(issue.key, issue);
    for (const c of children) state.known.set(c.key, c);
    renderDetail(issue, comments.reverse(), children);  // newest 100, shown oldest-first
  } catch (e) {
    if (seq === detailSeq && key === state.current) {
      $("#detail").replaceChildren(el("div", { class: "dh", "data-key": key }, el("span", { class: "crumb" }, key), el("span", { class: "spacer" }),
        el("button", { class: "btn icon", title: "Close (esc)", onclick: closeDetail }, icon(14, ICONS.close, ""))),
        el("div", { class: "dscroll" }, el("p", { style: "color:var(--err)" }, e.message)));
    }
  }
}

function renderDetail(issue, comments, children) {
  const f = issue.fields;
  const { cfg } = state;
  const d = $("#detail");
  // Keep an unsent comment draft and the scroll position across auto-refreshes.
  const oldBox = $("#cbox");
  const draft = oldBox && oldBox.dataset.key === issue.key ? oldBox.value : stashedComment(issue.key);
  const scroll = d.querySelector(".dscroll[data-key='" + CSS.escape(issue.key) + "']");
  const scrollTop = scroll ? scroll.scrollTop : 0;

  const chip = (id, title, kids, onclick) => {
    const b = el("button", { class: "chip", id, title }, kids);
    b.addEventListener("click", () => onclick(b));
    return b;
  };
  const h1 = el("h1", { class: "dtitle", title: "Click to edit" }, f.summary);
  h1.addEventListener("click", () => editTitle(h1, issue.key, f.summary));

  const box = el("textarea", { id: "cbox", placeholder: "Leave a comment…" });
  box.dataset.key = issue.key;
  box.value = draft;
  const send = el("button", { class: "btn primary" }, "Comment");
  const cmsg = el("span", { class: "cmsg" }, "⌘↵ to send");
  const submit = () => postComment(issue.key, box, send, cmsg);
  send.addEventListener("click", submit);
  box.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit(); });

  const descHolder = el("div", {}, f.description ? renderAdf(f.description) : el("p", { class: "nodesc" }, "No description."));
  const descEdit = plainSafe(f.description)
    ? el("button", { class: "link", onclick: () => editDescription(descHolder, issue.key, f.description) }, f.description ? "Edit" : "Add")
    : el("a", { class: "link", href: browseUrl(issue.key), target: "_blank", rel: "noopener", title: "Has formatting that plain-text editing would lose" }, "Edit in Jira ↗");

  const isSub = f.issuetype && f.issuetype.subtask;
  const { done } = progress(children);
  const subRows = children.map((c) => {
    const sb = el("button", { class: "ibtn", title: c.fields.status.name + " · change status" }, statusIcon(c.fields.status));
    sb.addEventListener("click", (e) => { e.stopPropagation(); statusMenu(c.key, sb); });
    return el("div", { class: "subrow", onclick: () => openIssue(c.key) },
      sb, el("span", { class: "rid" }, c.key), el("span", { class: "rtitle" }, c.fields.summary), avatar(c.fields.assignee));
  });

  const body = el("div", { class: "dscroll", "data-key": issue.key },
    f.parent ? el("button", { class: "parent", title: "Open parent", onclick: () => openIssue(f.parent.key) },
      icon(14, ICONS.up, ""), el("span", {}, f.parent.key + " · " + ((f.parent.fields || {}).summary || ""))) : null,
    h1,
    el("div", { class: "props" },
      chip("schip", "Change status (s)", [statusIcon(f.status), f.status.name], (b) => statusMenu(issue.key, b)),
      chip("pchip", "Change priority (p)", [prioIcon(f.priority), f.priority ? f.priority.name : "No priority"], (b) => priorityMenu(issue.key, b)),
      chip("achip", "Change assignee (a)", [avatar(f.assignee), f.assignee ? f.assignee.displayName : "Unassigned"], (b) => assigneeMenu(issue.key, b)),
      f.issuetype ? el("span", { class: "chip" }, f.issuetype.name) : null),
    el("div", { class: "meta" }, "Created " + shortDate(f.created) + (f.reporter ? " by " + f.reporter.displayName : "")),
    el("div", { class: "sec" }, "Description", el("span", { class: "spacer" }), descEdit),
    descHolder,
    isSub ? null : el("div", { class: "sec" }, "Sub-issues" + (children.length ? " · " + done + "/" + children.length + " done" : ""),
      el("span", { class: "spacer" }),
      el("button", { class: "link", onclick: () => actions.openCreate(issue) }, "+ Add sub-issue")),
    isSub || !children.length ? null : el("div", { class: "subs" }, subRows),
    el("div", { class: "sec" }, "Activity" + (comments.length ? " · " + comments.length : "")),
    ...comments.map((c) => el("div", { class: "card" },
      el("div", { class: "who" }, avatar(c.author), el("span", { class: "name" }, c.author ? c.author.displayName : "?"),
        el("span", { class: "when", title: new Date(c.created).toLocaleString() }, ago(c.created))),
      renderAdf(c.body))),
    el("div", { class: "composer" }, box, el("div", { class: "crow" }, cmsg, send)));

  d.replaceChildren(
    el("div", { class: "dh", "data-key": issue.key },
      el("span", { class: "crumb" }, cfg.project), "›", el("span", { class: "crumb", style: "color:var(--title)" }, issue.key),
      el("span", { class: "spacer" }),
      el("a", { class: "btn", href: browseUrl(issue.key), target: "_blank", rel: "noopener" }, "Open in Jira ↗"),
      el("button", { class: "btn icon", title: "Close (esc)", onclick: closeDetail }, icon(14, ICONS.close, ""))),
    body);
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
  const ta = el("textarea", { class: "dtitle", rows: "1" });
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
  const ta = el("textarea", { class: "", placeholder: "Add a description…" });
  ta.value = adfToText(doc);
  const save = el("button", { class: "btn primary" }, "Save");
  const cancel = el("button", { class: "btn" }, "Cancel");
  const box = el("div", { class: "composer" }, ta, el("div", { class: "crow" }, el("span", { class: "cmsg" }, "⌘↵ to save"), cancel, save));
  const view = holder.firstChild;
  holder.replaceChildren(box);
  ta.style.minHeight = "140px";
  ta.focus();
  const restore = () => holder.replaceChildren(view);
  const commit = () => {
    const text = ta.value.trim();
    save.disabled = true;
    updateFields(key, { description: text ? textToAdf(text) : null }, key + " description updated");
  };
  cancel.addEventListener("click", restore);
  save.addEventListener("click", commit);
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) commit();
    else if (e.key === "Escape") { e.stopPropagation(); restore(); }
  });
}

async function postComment(key, box, btn, msg) {
  if (!box.value.trim() || btn.disabled) return;
  state.busy = true;
  btn.disabled = true;
  msg.textContent = "Sending…";
  try {
    await jira.addComment(key, textToAdf(box.value));
    box.value = "";
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
