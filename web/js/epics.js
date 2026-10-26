// Pure helpers for the sidebar's Epics section: the JQL, child-progress counting and which epics
// to list. No DOM access.
import { quote } from "./jql.js";

/** Open epics listed in the sidebar (one search page). */
export const EPIC_LIMIT = 50;
/** Epics listed before "Show all (N)". */
export const EPIC_SHOWN = 8;
/** Parent keys per `parent in (...)` progress search (keeps the JQL short). */
const CHUNK = 50;

/** The project's open epics, most recently updated first. */
export function epicsJql(project) {
  return "project = " + quote(project) + " AND issuetype = Epic AND statusCategory != Done ORDER BY updated DESC";
}

/** Children of any of `keys` (one search for all epics' progress). */
export function epicChildrenJql(keys) {
  return "parent in (" + keys.map(quote).join(", ") + ")";
}

/** `list` cut into arrays of at most `size` items. */
export function chunk(list, size = CHUNK) {
  const out = [];
  for (let i = 0; i < (list || []).length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/**
 * {done, total} per epic key from a flat list of child issues (fields: status, parent). Children
 * in Jira's Done category (Done, Canceled, …) count as done; epics without children get 0/0.
 */
export function epicProgress(keys, children) {
  const out = new Map((keys || []).map((k) => [k, { done: 0, total: 0 }]));
  for (const c of children || []) {
    const f = c.fields || {};
    const p = out.get(f.parent && f.parent.key);
    if (!p) continue;
    p.total++;
    if (((f.status || {}).statusCategory || {}).key === "done") p.done++;
  }
  return out;
}

/**
 * Sidebar entries: [{key, summary, status, done, total, more}] from the epics search and the
 * progress map; `more` for the epics in `partial` (their children search was cut off, so the
 * counts are a lower bound).
 */
export function epicEntries(epics, progress, partial = new Set()) {
  return (epics || []).map((e) => {
    const p = (progress && progress.get(e.key)) || { done: 0, total: 0 };
    return { key: e.key, summary: (e.fields || {}).summary || e.key, status: (e.fields || {}).status || null, done: p.done, total: p.total,
      more: partial.has(e.key) };
  });
}

/**
 * The epics to list: everything when `showAll` or when there are at most `limit`; otherwise the
 * first `limit` in their order, plus the selected epic if it is further down.
 * Returns {shown, hidden}.
 */
export function visibleEpics(epics, { selected = null, showAll = false, limit = EPIC_SHOWN } = {}) {
  const list = epics || [];
  if (showAll || list.length <= limit) return { shown: list, hidden: 0 };
  const shown = list.slice(0, limit);
  const sel = selected && !shown.some((e) => e.key === selected) ? list.find((e) => e.key === selected) : null;
  if (sel) shown.push(sel);
  return { shown, hidden: list.length - shown.length };
}

/** The ring's stroke-dasharray for a done/total fraction on a circle of `circumference`. */
export function ringDash(done, total, circumference) {
  const f = total > 0 ? Math.max(0, Math.min(1, done / total)) : 0;
  return (f * circumference).toFixed(2) + " " + circumference.toFixed(2);
}
