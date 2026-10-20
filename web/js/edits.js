// Writes to Jira from menus and inline editors: status, priority, assignee, any field update.
import * as jira from "./api.js";
import { state, issueByKey } from "./state.js";
import { toast } from "./dom.js";
import { statusIcon, prioIcon, avatar } from "./icons.js";
import { openMenu } from "./menu.js";
import { actions } from "./actions.js";

/** Reloads the list and, if open, the detail panel after a write. */
export function afterEdit() {
  return Promise.all([actions.loadList(), state.current ? actions.loadDetail() : null]);
}

/** Runs a write with `busy` set (so auto-refresh skips), then refreshes. `failMsg` formats the error. */
async function write(run, okMsg, failMsg, onFail) {
  state.busy = true;
  try {
    await run();
    if (okMsg) toast(okMsg);
    state.busy = false;
    await afterEdit();
  } catch (e) {
    toast(failMsg(e.message), true);
    if (onFail) onFail(e);
  } finally {
    state.busy = false;
  }
}

/** Opens the "move to" menu with the workflow transitions available from the issue's status. */
export async function statusMenu(key, anchor) {
  const i = issueByKey(key);
  if (state.busy || !i) return;
  let trans;
  try {
    trans = await jira.getTransitions(key);
  } catch (e) {
    return toast("Couldn't load statuses for " + key + ": " + e.message, true);
  }
  if (!anchor.isConnected) return;  // re-rendered meanwhile
  const items = trans.filter((t) => t.to.id !== i.fields.status.id).map((t) => ({
    id: t.id, label: t.to.name, via: t.name !== t.to.name ? t.name : "", icon: statusIcon(t.to),
  }));
  openMenu(anchor, key + " · move to", items, (it) => transition(key, it), { empty: "No transitions available" });
}

/** Applies transition {id, label}. */
export function transition(key, it) {
  toast("Moving " + key + " to " + it.label + "…");
  return write(() => jira.transition(key, it.id), key + " → " + it.label,
    (m) => "Status change failed: " + m + " (if it needs extra fields, use Open in Jira)");
}

export function priorityMenu(key, anchor) {
  const i = issueByKey(key);
  if (state.busy || !i || !state.priorities.length) return;
  const cur = i.fields.priority ? i.fields.priority.id : null;
  const items = state.priorities.map((p) => ({ id: p.id, label: p.name, icon: prioIcon(p), current: p.id === cur }));
  openMenu(anchor, key + " · priority", items, (it) => {
    if (!it.current) updateFields(key, { priority: { id: it.id } }, key + " priority → " + it.label);
  });
}

export function assigneeMenu(key, anchor) {
  const i = issueByKey(key);
  if (state.busy || !i) return;
  const { me, people } = state;
  const cur = i.fields.assignee ? i.fields.assignee.accountId : null;
  const mine = me ? [me] : [];
  const others = people.filter((u) => !me || u.accountId !== me.accountId);
  const items = [{ id: null, label: "Unassigned", icon: avatar(null), current: !cur },
    ...[...mine, ...others].map((u) => ({
      id: u.accountId, label: u.displayName + (me && u.accountId === me.accountId ? " (me)" : ""), icon: avatar(u), current: u.accountId === cur,
    }))];
  openMenu(anchor, key + " · assignee", items, (it) => {
    if (it.current) return;
    write(() => jira.assign(key, it.id), key + " → " + (it.id ? it.label : "Unassigned"), (m) => "Assign failed: " + m);
  }, { search: true });
}

/** PUTs `fields` on the issue; on failure the open detail panel is reloaded to drop the optimistic edit. */
export function updateFields(key, fields, msg) {
  return write(() => jira.updateIssue(key, fields), msg, (m) => "Update failed: " + m, () => {
    if (state.current === key) actions.loadDetail();
  });
}
