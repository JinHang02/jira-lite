// Talks to the local proxy (server.py): /jira/* -> Jira REST v3.

/** Fields fetched for list rows, board cards, search hits and sub-issues. */
export const FIELDS = ["summary", "status", "priority", "assignee", "updated", "issuetype", "subtasks", "parent"];
const DETAIL_FIELDS = ["summary", "status", "description", "assignee", "reporter", "priority", "issuetype", "created", "parent", "subtasks"];
const enc = encodeURIComponent;

/**
 * Calls the proxy. Relative paths go to /jira/; absolute ones are used as is.
 * POSTs when a body is given, unless `method` says otherwise. Throws Error with Jira's messages.
 */
export async function request(path, body, method) {
  const opts = { method: method || (body !== undefined ? "POST" : "GET"), headers: { "X-Jira-Lite": "1" } };
  if (body !== undefined) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const r = await fetch(path.startsWith("/") ? path : "/jira/" + path, opts);
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { /* non-JSON error page */ }
  if (!r.ok) {
    const parts = data ? [...(data.errorMessages || []), ...Object.entries(data.errors || {}).map(([k, v]) => k + ": " + v)] : [];
    throw new Error(parts.join("; ") || ("HTTP " + r.status + (text ? ": " + text.slice(0, 200) : "")));
  }
  return data;
}

// ---- server ----
export const getConfig = () => fetch("/config").then((r) => r.json());

// ---- search ----
/** One page of /search/jql: {issues, nextPageToken, isLast}. */
export function searchPage(jql, { fields = FIELDS, maxResults = 100, nextPageToken } = {}) {
  const body = { jql, fields, maxResults };
  if (nextPageToken) body.nextPageToken = nextPageToken;
  return request("search/jql", body);
}

/** Issues matching `jql` (first page only). */
export const searchIssues = (jql, maxResults = 100) => searchPage(jql, { maxResults }).then((r) => r.issues || []);

/** All issues matching `jql`, following pagination up to `maxPages` pages of 100. */
export async function searchAll(jql, maxPages = 5) {
  const out = [];
  let token;
  for (let page = 0; page < maxPages; page++) {
    const r = await searchPage(jql, { nextPageToken: token });
    out.push(...(r.issues || []));
    token = r.nextPageToken;
    if (!token || r.isLast) break;
  }
  return out;
}

// ---- issues ----
export const getIssue = (key, fields = DETAIL_FIELDS) => request("issue/" + enc(key) + "?fields=" + fields.join(","));
export const getComments = (key) => request("issue/" + enc(key) + "/comment?orderBy=-created&maxResults=100").then((r) => r.comments || []);
export const getTransitions = (key) => request("issue/" + enc(key) + "/transitions").then((r) => r.transitions || []);
export const transition = (key, transitionId) => request("issue/" + enc(key) + "/transitions", { transition: { id: transitionId } });
export const updateIssue = (key, fields) => request("issue/" + enc(key), { fields }, "PUT");
export const assign = (key, accountId) => request("issue/" + enc(key) + "/assignee", { accountId }, "PUT");
export const addComment = (key, adfBody) => request("issue/" + enc(key) + "/comment", { body: adfBody });
export const createIssue = (fields) => request("issue", { fields });

// ---- metadata ----
export const createMetaTypes = (project) => request("issue/createmeta/" + enc(project) + "/issuetypes").then((r) => r.issueTypes || []);
export const createMetaFields = (project, typeId) =>
  request("issue/createmeta/" + enc(project) + "/issuetypes/" + enc(typeId) + "?maxResults=200").then((r) => r.fields || r.results || []);
export const getMyself = () => request("myself");
export const getPriorities = () => request("priority/search?maxResults=50").then((r) => r.values || []);
export const getAssignable = (project) => request("user/assignable/search?project=" + enc(project) + "&maxResults=1000");
export const getProjectStatuses = (project) => request("project/" + enc(project) + "/statuses");
