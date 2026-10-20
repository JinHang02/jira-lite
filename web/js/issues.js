// Pure helpers over lists of Jira issues. No DOM access.

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

/** {done, total} for a list of sub-issues (each with fields.status). */
export function progress(children) {
  const total = (children || []).length;
  const done = (children || []).filter((c) => (((c.fields || {}).status || {}).statusCategory || {}).key === "done").length;
  return { done, total };
}
