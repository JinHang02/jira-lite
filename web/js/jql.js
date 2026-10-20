// Pure JQL builders. No DOM access.

/** A JQL string literal: double-quoted, with quotes and backslashes escaped. */
export const quote = (v) => '"' + String(v).replace(/["\\]/g, (c) => "\\" + c) + '"';

/**
 * JQL for the main list.
 * @param {{project: string, who: string, showDone: boolean, epic?: string|null}} q
 *   who: "mine" | "all" | an accountId. `epic` (an issue key) shows that epic's children instead,
 *   whoever they are assigned to.
 */
export function buildJql({ project, who, showDone, epic }) {
  let jql = 'project = "' + project + '"';
  if (epic) jql += " AND parent = " + quote(epic);
  else if (who === "mine") jql += " AND assignee = currentUser()";
  else if (who !== "all") jql += ' AND assignee = "' + who + '"';
  if (!showDone) jql += " AND statusCategory != Done";
  return jql + " ORDER BY updated DESC";
}

/**
 * Client-side twin of buildJql's filters: true if `issue` belongs in the view
 * {who, meId, showDone, epic}. who: "mine" | "all" | an accountId; meId is the signed-in user's
 * accountId ("mine" never matches without it); epic: only children of that issue key, any
 * assignee. Keep the two in step.
 */
export function matchesView(issue, { who, meId, showDone, epic }) {
  const f = (issue && issue.fields) || {};
  if (!showDone && ((f.status || {}).statusCategory || {}).key === "done") return false;
  if (epic) return !!f.parent && f.parent.key === epic;
  if (who === "all") return true;
  const assignee = f.assignee ? f.assignee.accountId : null;
  if (who === "mine") return !!meId && assignee === meId;
  return assignee === who;
}

/**
 * JQL for an incremental sync: every issue in the project updated in the last `minutes` minutes,
 * newest first. It deliberately ignores the view's assignee/done filters, so issues that left
 * the view (reassigned, closed) come back too and can be removed (see matchesView).
 * The relative form (-Nm) is evaluated by Jira against its own clock, so neither the browser's
 * nor the Jira user's time zone (they can differ) nor client clock skew matters.
 */
export function deltaJql(project, minutes) {
  const m = Math.max(1, Math.ceil(minutes));
  return 'project = "' + project + '" AND updated >= -' + m + "m ORDER BY updated DESC";
}

/** Full-text prefix search within a project. Quotes and backslashes in the query are dropped. */
export function searchJql(project, q) {
  const safe = q.replace(/["\\]/g, " ").trim();
  return 'project = "' + project + '" AND text ~ "' + safe + '*" ORDER BY updated DESC';
}

/** Children of an issue (sub-tasks, or issues in an epic), oldest first. */
export function childrenJql(key) {
  return 'parent = "' + key + '" ORDER BY created ASC';
}
