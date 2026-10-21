// Pure helpers over lists of Jira issues: filtering, display ordering and grouping, due dates.
// No DOM access.
import { groupByStatus, prioKind, PRIO_LEVELS } from "./status.js";

/** True if the lower-cased query `q` occurs in the key, summary or assignee name. */
export function matches(issue, q) {
  const f = issue.fields;
  return issue.key.toLowerCase().includes(q) || (f.summary || "").toLowerCase().includes(q) ||
    !!(f.assignee && f.assignee.displayName.toLowerCase().includes(q));
}

/** Issues matching a free-text filter (all of them when the filter is blank). */
export function filterIssues(issues, filter) {
  const q = (filter || "").trim().toLowerCase();
  return q ? issues.filter((i) => matches(i, q)) : issues;
}

/** Issues whose status id isn't in `hidden` (Display › Statuses). */
export function hideStatuses(issues, hidden) {
  return hidden && hidden.size ? issues.filter((i) => !hidden.has(String(((i.fields || {}).status || {}).id))) : issues;
}

/** {done, total} for a list of sub-issues (each with fields.status). */
export function progress(children) {
  const total = (children || []).length;
  const done = (children || []).filter((c) => (((c.fields || {}).status || {}).statusCategory || {}).key === "done").length;
  return { done, total };
}

/**
 * {done, total, epic} of an issue's sub-issues: an epic's child issues as counted for the sidebar
 * (`epics`: [{key, done, total}]), otherwise its sub-tasks.
 */
export function childProgress(issue, epics) {
  const e = (epics || []).find((x) => x.key === issue.key);
  if (e && e.total) return { done: e.done, total: e.total, epic: true };
  return { ...progress(((issue || {}).fields || {}).subtasks), epic: false };
}

/** True if the issue's status is in Jira's Done category. */
export const isDone = (issue) => ((((issue || {}).fields || {}).status || {}).statusCategory || {}).key === "done";

// ---- Display options: grouping and ordering (the header's Display popover) ----

/** List groupings; the board always shows status columns. */
export const GROUPINGS = ["status", "assignee", "priority", "component", "none"];
/** Orderings, applied within each group (and within board columns). */
export const ORDERINGS = ["updated", "priority", "created"];

const time = (iso) => { const t = Date.parse(iso || ""); return isNaN(t) ? 0 : t; };
const prioRank = (p) => PRIO_LEVELS.indexOf(prioKind(p));

/**
 * A sorted copy of `issues`. "updated" and "created": newest first (missing dates last);
 * "priority": most urgent first, ties by most recently updated. Stable; unknown orderings keep
 * the input order.
 */
export function sortIssues(issues, ordering) {
  const newest = (field) => (a, b) => time(b.fields[field]) - time(a.fields[field]);
  const by = {
    updated: newest("updated"),
    created: newest("created"),
    priority: (a, b) => prioRank(a.fields.priority) - prioRank(b.fields.priority) || newest("updated")(a, b),
  }[ordering];
  return by ? [...issues].sort(by) : [...issues];
}

/** Buckets issues by `keyOf`, keeping their order; `meta(issue)` describes a new group. */
function bucket(issues, keyOf, meta) {
  const groups = new Map();
  for (const i of issues) {
    const key = keyOf(i);
    if (!groups.has(key)) groups.set(key, { key, ...meta(i), items: [] });
    groups.get(key).items.push(i);
  }
  return [...groups.values()];
}

/**
 * Groups (already ordered) issues for the list view: [{key, label, items, status|assignee|priority}].
 * - "status": in workflow order (BOARD_ORDER, like the board); the key is the status name (what the collapsed-groups pref stores).
 * - "assignee": by name, "Unassigned" last.
 * - "priority": Highest..Lowest, then unrecognised priorities, then "No priority".
 * - "component": by the issue's components together ("API, Web"; each issue shows once), A-Z,
 *   "No component" last.
 * - "none": a single group with key "" (rendered without a header), or [] for no issues.
 * The order of issues within a group is preserved.
 */
export function groupIssues(issues, grouping) {
  if (grouping === "none") return issues.length ? [{ key: "", label: "", items: issues }] : [];
  if (grouping === "assignee") {
    const a = (i) => i.fields.assignee || null;
    return bucket(issues, (i) => "assignee:" + (a(i) ? a(i).accountId || a(i).displayName : ""),
      (i) => ({ label: a(i) ? a(i).displayName : "Unassigned", assignee: a(i) }))
      .sort((x, y) => (!x.assignee) - (!y.assignee) || x.label.localeCompare(y.label));
  }
  if (grouping === "priority") {
    const p = (i) => i.fields.priority || null;
    return bucket(issues, (i) => "priority:" + (p(i) ? p(i).name : ""),
      (i) => ({ label: p(i) ? p(i).name : "No priority", priority: p(i) }))
      .sort((x, y) => prioRank(x.priority) - prioRank(y.priority) || (!x.priority) - (!y.priority) || x.label.localeCompare(y.label));
  }
  if (grouping === "component") {
    const names = (i) => (i.fields.components || []).map((c) => c.name).filter(Boolean).sort((a, b) => a.localeCompare(b));
    return bucket(issues, (i) => "component:" + names(i).join("\n"), (i) => ({ label: names(i).join(", ") || "No component", component: names(i) }))
      .sort((x, y) => (!x.component.length) - (!y.component.length) || x.label.localeCompare(y.label));
  }
  return groupByStatus(issues).map((g) => ({ key: g.status.name, label: g.status.name, status: g.status, items: g.items }));
}

// ---- due dates and labels ----

const DAY_MS = 86400000;

/**
 * How to show a Jira due date ("YYYY-MM-DD", a calendar day in the viewer's time zone):
 * {label, level, days} or null when unset. `days` is due minus today; `level` is "overdue"
 * (past), "soon" (today .. 2 days ahead) or "" — always "" for finished issues.
 */
export function dueInfo(duedate, { now = Date.now(), done = false } = {}) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(duedate || "");
  if (!m) return null;
  const due = new Date(+m[1], +m[2] - 1, +m[3]);
  const t = new Date(now);
  const today = new Date(t.getFullYear(), t.getMonth(), t.getDate());
  const days = Math.round((due - today) / DAY_MS);  // round: DST days are 23 or 25 hours
  const level = done ? "" : days < 0 ? "overdue" : days <= 2 ? "soon" : "";
  const named = { "-1": "Yesterday", 0: "Today", 1: "Tomorrow" }[days];
  const opts = { month: "short", day: "numeric" };
  if (due.getFullYear() !== today.getFullYear()) opts.year = "2-digit";
  return { label: named || due.toLocaleDateString(undefined, opts), level, days };
}

/** A stable hue (0-359) for a label name, for its colour dot. */
export function labelHue(name) {
  let h = 0;
  for (const ch of String(name)) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

// ---- deleting ----

/** `issues` without `key` and its sub-tasks (Jira deletes those with it); other children stay. */
export function withoutIssue(issues, key) {
  return (issues || []).filter((i) => i.key !== key &&
    !(((i.fields || {}).parent || {}).key === key && ((i.fields || {}).issuetype || {}).subtask));
}

/** The delete dialog's warning lines for an issue with these many sub-tasks / child issues. */
export function deleteWarning({ subtasks = 0, children = 0 } = {}) {
  const n = (k, one) => k + " " + one + (k === 1 ? "" : "s");
  const out = ["You're about to permanently delete this issue, its comments, attachments and all of its data. This can't be undone."];
  if (subtasks) out.push("Its " + n(subtasks, "sub-task") + " will be deleted too.");
  if (children) out.push(n(children, "child issue") + " will lose " + (children === 1 ? "its" : "their") + " parent but won't be deleted.");
  return out;
}

/** True once the confirmation box says "delete" (case and surrounding spaces ignored). */
export const deleteTyped = (text) => String(text || "").trim().toLowerCase() === "delete";
