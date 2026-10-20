// Pure JQL builders. No DOM access.

/**
 * JQL for the main list.
 * @param {{project: string, who: string, showDone: boolean}} q  who: "mine" | "all" | an accountId.
 */
export function buildJql({ project, who, showDone }) {
  let jql = 'project = "' + project + '"';
  if (who === "mine") jql += " AND assignee = currentUser()";
  else if (who !== "all") jql += ' AND assignee = "' + who + '"';
  if (!showDone) jql += " AND statusCategory != Done";
  return jql + " ORDER BY updated DESC";
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
