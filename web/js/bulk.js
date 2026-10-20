// Pure logic for multi-select and bulk edits: selection ranges, the union of workflow targets,
// per-issue plans, a small concurrency pool and the summary toasts. No DOM access.
import { compareStatuses, BOARD_ORDER } from "./status.js";

/** Concurrent requests per bulk step (transitions lookup, writes). */
export const CONCURRENCY = 4;

// ---- selection ----

/** A copy of `sel` with `key` added or removed. */
export function toggleKey(sel, key) {
  const out = new Set(sel);
  if (out.has(key)) out.delete(key);
  else out.add(key);
  return out;
}

/** The keys of `visible` from `a` to `b` inclusive (either order); [b] when `a` isn't visible. */
export function range(visible, a, b) {
  const i = visible.indexOf(a), j = visible.indexOf(b);
  if (j < 0) return [];
  if (i < 0) return [b];
  return visible.slice(Math.min(i, j), Math.max(i, j) + 1);
}

/** `base` plus the range anchor..key (shift+click, shift+j/k). */
export function extendRange(base, visible, anchor, key) {
  return new Set([...(base || []), ...range(visible, anchor, key)]);
}

/** The selected keys in display order (keys no longer visible are dropped). */
export function orderedSelection(sel, visible) {
  return visible.filter((k) => sel.has(k));
}

/** `sel` restricted to `keys`; the same Set when nothing had to go. */
export function pruneSelection(sel, keys) {
  const keep = new Set(keys);
  if ([...sel].every((k) => keep.has(k))) return sel;
  return new Set([...sel].filter((k) => keep.has(k)));
}

// ---- status ----

/**
 * The statuses any selected issue can move to: [{status, count}] where `count` is how many of
 * the issues have a transition there (issues already in that status don't count). Ordered like
 * the board's columns. `transitions`: Map key -> [{id, name, to}] (missing = lookup failed).
 */
export function unionTargets(issues, transitions) {
  const byId = new Map();
  for (const i of issues) {
    const list = transitions.get(i.key);
    if (!list) continue;
    const seen = new Set();
    for (const t of list) {
      const id = String(t.to.id);
      if (id === String(i.fields.status.id) || seen.has(id)) continue;
      seen.add(id);
      if (!byId.has(id)) byId.set(id, { status: t.to, count: 0 });
      byId.get(id).count++;
    }
  }
  return [...byId.values()].sort((a, b) => compareStatuses(a.status, b.status, BOARD_ORDER));
}

/**
 * What moving `issues` to status `statusId` does: {moves: [{key, transitionId}], already: [key],
 * cannot: [key], unknown: [key]} — unknown = the transitions lookup failed.
 */
export function statusPlan(issues, transitions, statusId) {
  const out = { moves: [], already: [], cannot: [], unknown: [] };
  const want = String(statusId);
  for (const i of issues) {
    if (String(i.fields.status.id) === want) { out.already.push(i.key); continue; }
    const list = transitions.get(i.key);
    if (!list) { out.unknown.push(i.key); continue; }
    const t = list.find((x) => String(x.to.id) === want);
    if (t) out.moves.push({ key: i.key, transitionId: t.id });
    else out.cannot.push(i.key);
  }
  return out;
}

// ---- fields ----

/** Issues whose priority isn't already `priorityId`: [{key, fields: {priority: {id}}}]. */
export function priorityPlan(issues, priorityId) {
  return issues.filter((i) => !i.fields.priority || String(i.fields.priority.id) !== String(priorityId))
    .map((i) => ({ key: i.key, fields: { priority: { id: String(priorityId) } } }));
}

/** Issues not already assigned to `accountId` (null = unassign): [{key, accountId}]. */
export function assigneePlan(issues, accountId) {
  return issues.filter((i) => ((i.fields.assignee || {}).accountId || null) !== (accountId || null))
    .map((i) => ({ key: i.key, accountId: accountId || null }));
}

/**
 * Adding `labels` to each issue, keeping its existing ones (a PUT replaces the whole list):
 * [{key, fields: {labels}}] for the issues that lack at least one of them.
 */
export function labelsPlan(issues, labels) {
  const add = [...new Set(labels || [])];
  return issues.map((i) => {
    const have = i.fields.labels || [];
    const missing = add.filter((l) => !have.includes(l));
    return missing.length ? { key: i.key, fields: { labels: [...have, ...missing] } } : null;
  }).filter(Boolean);
}

/** Every label used by `issues`, by how often it occurs (then by name). */
export function knownLabels(issues) {
  const n = new Map();
  for (const i of issues || []) for (const l of (i.fields && i.fields.labels) || []) n.set(l, (n.get(l) || 0) + 1);
  return [...n.keys()].sort((a, b) => n.get(b) - n.get(a) || a.localeCompare(b));
}

// ---- running ----

/**
 * Runs `fn(item)` for every item with at most `limit` in flight. Never rejects; resolves to
 * [{item, ok, value?, error?}] in input order.
 */
export async function runPool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const n = next++;
      try {
        out[n] = { item: items[n], ok: true, value: await fn(items[n]) };
      } catch (e) {
        out[n] = { item: items[n], ok: false, error: e };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}

// ---- summaries ----

const plural = (n, one, many) => n + " " + (n === 1 ? one : many);

/**
 * The toast after a bulk status change, e.g. "Moved 5 · 1 can't move to Done" or
 * "Moved 3 to Done · 1 already in Done · 1 failed". Counts; `target` is the status name.
 */
export function statusSummary({ moved = 0, cannot = 0, already = 0, failed = 0 }, target) {
  const parts = [];
  if (moved) parts.push("Moved " + moved + (cannot ? "" : " to " + target));
  if (cannot) parts.push(cannot + " can't move to " + target);
  if (already) parts.push(already + " already in " + target);
  if (failed) parts.push(failed + " failed");
  return parts.join(" · ") || "Nothing to change";
}

/** The toast after a bulk field edit, e.g. "Priority → High on 4 issues · 1 already · 1 failed". */
export function fieldSummary(what, { changed = 0, skipped = 0, failed = 0 }) {
  const parts = [];
  if (changed) parts.push(what + " on " + plural(changed, "issue", "issues"));
  if (skipped) parts.push(skipped + " already");
  if (failed) parts.push(failed + " failed");
  return parts.join(" · ") || "Nothing to change";
}

/** First error message of failed pool results, with its issue key, for the toast. */
export function firstError(results, keyOf = (it) => it.key || it) {
  const f = results.find((r) => !r.ok);
  return f ? keyOf(f.item) + ": " + ((f.error && f.error.message) || "failed") : "";
}
