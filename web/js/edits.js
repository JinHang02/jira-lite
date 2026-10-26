// Writes to Jira from menus and inline editors: status, priority, assignee, any field update.
import * as jira from "./api.js";
import { state, issueByKey } from "./state.js";
import { toast, follow } from "./dom.js";
import { statusIcon, prioIcon, avatar } from "./icons.js";
import { openMenu } from "./menu.js";
import { actions } from "./actions.js";
import { writes } from "./overlay.js";
import { priorities } from "./meta.js";

/** The parent's key of the issue, if it has one. */
const parentOf = (i) => (i && i.fields && i.fields.parent ? i.fields.parent.key : null);

/**
 * Makes a write visible at once (read-your-writes). Search lags behind writes in Jira Cloud, so
 * instead of re-searching, the touched issues — and their parents, whose sub-task lists and
 * progress change too — are fetched by key, recorded in the overlay (overlay.js) and merged into
 * the list; `deleted` keys are dropped. Then the open detail panel reloads (unless `detail` is
 * false) and the sidebar's epic progress when an epic or an epic's child changed.
 */
export async function settle(keys, { deleted = [], detail = true } = {}) {
  const before = keys.map(issueByKey);
  const touched = new Set([...keys, ...before.map(parentOf)].filter((k) => k && !deleted.includes(k)));
  for (const k of deleted) writes.drop(k);
  const fetched = await Promise.all([...touched].map((k) => jira.getIssue(k, jira.FIELDS).catch((e) => {
    if (e.status === 404) writes.drop(k);  // gone (deleted elsewhere, or moved out of reach)
    return null;
  })));
  for (const i of fetched) if (i) writes.put(i);
  // A new parent (set by the write) also lists the issue now: fetch it too.
  const parents = fetched.map(parentOf).filter((k) => k && !touched.has(k));
  for (const i of await Promise.all(parents.map((k) => jira.getIssue(k, jira.FIELDS).catch(() => null)))) if (i) writes.put(i);
  actions.reconcile();
  const isEpic = (i) => !!i && (state.epicInfo.has(i.key) || ((i.fields && i.fields.issuetype) || {}).hierarchyLevel === 1);
  const inEpic = (i) => isEpic(i) || (!!i && state.epicInfo.has(parentOf(i)));
  if ([...before, ...fetched].some(inEpic) || deleted.some((k) => state.epicInfo.has(k))) actions.loadEpics();
  if (detail && state.current && !deleted.includes(state.current)) await actions.loadDetail();
}

/**
 * Shows `fields` on the issue right away (an optimistic update); `settle` then replaces it with
 * what Jira stored, which also undoes it when the write failed.
 */
function patchLocal(key, fields) {
  const patch = (i) => ({ ...i, fields: { ...i.fields, ...fields } });
  state.issues = state.issues.map((i) => (i.key === key ? patch(i) : i));
  if (state.known.has(key)) state.known.set(key, patch(state.known.get(key)));
  actions.renderMain();
}

// Writes run one at a time per issue, in the order they were made (key -> the last one's
// promise), so a quick second edit never races the first; `busy` stays set while any runs.
const queue = new Map();
let running = 0;

/** Resolves once the writes queued on `key` so far are done (and settled). */
export const idle = (key) => queue.get(key) || Promise.resolve();

/**
 * Queues a write on `key`: shows `patch` at once (optimistic), then runs it with `busy` set (so
 * auto-refresh skips) after the issue's earlier writes, and settles it. `failMsg` formats the
 * error; on failure `onFail` runs and the detail panel is left alone (e.g. the description editor
 * keeps the typed text) — unless no `onFail`.
 */
function write(key, run, okMsg, failMsg, { patch, onFail } = {}) {
  if (patch) patchLocal(key, patch);
  const p = idle(key).then(async () => {
    running++;
    state.busy = true;
    let ok = false;
    try {
      await run();
      ok = true;
      if (okMsg) toast(okMsg);
    } catch (e) {
      toast(failMsg(e.message), true);
      if (onFail) onFail(e);
    } finally {
      if (--running === 0) state.busy = false;
    }
    if (ok || patch || !onFail) await settle([key], { detail: ok || !onFail });
  });
  queue.set(key, p);
  return p.finally(() => { if (queue.get(key) === p) queue.delete(key); });
}

/** Opens the "move to" menu with the workflow transitions available from the issue's status. */
export async function statusMenu(key, anchor) {
  if (!issueByKey(key)) return;
  const where = follow(anchor);
  let trans;
  try {
    await idle(key);  // the transitions depend on the status an earlier write may still be setting
    trans = await jira.getTransitions(key);
  } catch (e) {
    return toast("Couldn't load statuses for " + key + ": " + e.message, true);
  }
  const i = issueByKey(key);
  anchor = where();
  if (!i || !anchor) return;  // gone, or its row closed meanwhile
  const items = trans.filter((t) => t.to.id !== i.fields.status.id).map((t) => ({
    id: t.id, label: t.to.name, via: t.name !== t.to.name ? t.name : "", icon: statusIcon(t.to), to: t.to,
  }));
  openMenu(anchor, key + " · move to", items, (it) => transition(key, it), { empty: "No transitions available" });
}

/** Applies transition {id, label, to?}; with the target status `to`, the issue moves there at once. */
export function transition(key, it) {
  toast("Moving " + key + " to " + it.label + "…");
  return write(key, () => jira.transition(key, it.id), key + " → " + it.label,
    (m) => "Status change failed: " + m + " (if it needs extra fields, use Open in Jira)", { patch: it.to ? { status: it.to } : null });
}

export async function priorityMenu(key, anchor) {
  if (!state.priorities.length) {  // still loading (or failed at startup): wait for / retry it
    const where = follow(anchor);
    try { state.priorities = await priorities(); } catch (e) { return toast("Couldn't load priorities: " + e.message, true); }
    anchor = where();
    if (!anchor || !state.priorities.length) return;
  }
  const i = issueByKey(key);
  if (!i) return;
  const cur = i.fields.priority ? i.fields.priority.id : null;
  const items = state.priorities.map((p) => ({ id: p.id, label: p.name, icon: prioIcon(p), current: p.id === cur, priority: p }));
  openMenu(anchor, key + " · priority", items, (it) => {
    if (!it.current) updateFields(key, { priority: { id: it.id } }, key + " priority → " + it.label, null, { priority: it.priority });
  });
}

export function assigneeMenu(key, anchor) {
  const i = issueByKey(key);
  if (!i) return;
  const { me, people } = state;
  const cur = i.fields.assignee ? i.fields.assignee.accountId : null;
  const mine = me ? [me] : [];
  const others = people.filter((u) => !me || u.accountId !== me.accountId);
  const items = [{ id: null, label: "Unassigned", icon: avatar(null), current: !cur },
    ...[...mine, ...others].map((u) => ({
      id: u.accountId, label: u.displayName + (me && u.accountId === me.accountId ? " (me)" : ""), icon: avatar(u), current: u.accountId === cur, user: u,
    }))];
  openMenu(anchor, key + " · assignee", items, (it) => {
    if (it.current) return;
    write(key, () => jira.assign(key, it.id), key + " → " + (it.id ? it.label : "Unassigned"), (m) => "Assign failed: " + m,
      { patch: { assignee: it.user || null } });
  }, { search: true });
}

/**
 * PUTs `fields` on the issue. `patch` (optional) is shown at once, in the issue's JSON shape.
 * On failure the open detail panel is reloaded to drop the optimistic edit, or `onFail` runs
 * instead (e.g. the description editor keeps the typed text).
 */
export function updateFields(key, fields, msg, onFail, patch) {
  return write(key, () => jira.updateIssue(key, fields), msg, (m) => "Update failed: " + m, { patch, onFail });
}

/** Like updateFields, with Jira's `update` verbs ({labels: [{add: "x"}]}): list edits that keep others' changes. */
export function updateOps(key, update, msg) {
  return write(key, () => jira.editIssue(key, { update }), msg, (m) => "Update failed: " + m);
}
