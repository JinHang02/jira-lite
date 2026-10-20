// Talks to the local proxy (server.py): /jira/* -> Jira REST v3.

/** Fields fetched for list rows, board cards, search hits and sub-issues. */
export const FIELDS = ["summary", "status", "priority", "assignee", "updated", "issuetype", "subtasks", "parent"];
const DETAIL_FIELDS = ["summary", "status", "description", "assignee", "reporter", "priority", "issuetype", "created", "parent", "subtasks"];
const enc = encodeURIComponent;

/** Thrown when the server says the OAuth session is missing or expired. */
export class LoginRequired extends Error {
  constructor() {
    super("Signed out of Atlassian. Sign in again.");
    this.name = "LoginRequired";
    this.loginRequired = true;
  }
}

let onLoginRequired = () => {};
/** Sets what happens when a call comes back "login required" (main.js shows the sign-in screen). */
export function setLoginHandler(fn) { onLoginRequired = fn; }

/** True for the server's "sign in again" 401 (a Jira 401 without the header is a normal error). */
const needsLogin = (r) => r.status === 401 && r.headers.get("X-Jira-Lite-Auth") === "login";

/**
 * Calls the proxy. Relative paths go to /jira/; absolute ones are used as is.
 * POSTs when a body is given, unless `method` says otherwise. Throws Error with Jira's messages,
 * or LoginRequired (after notifying the login handler) when the session has ended.
 */
export async function request(path, body, method) {
  const opts = { method: method || (body !== undefined ? "POST" : "GET"), headers: { "X-Jira-Lite": "1" } };
  if (body !== undefined) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const r = await fetch(path.startsWith("/") ? path : "/jira/" + path, opts);
  if (needsLogin(r)) {
    onLoginRequired();
    throw new LoginRequired();
  }
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

/** The signed-in user ({accountId, displayName, auth}), or null when a sign-in is needed. */
export async function getAuthMe() {
  const r = await fetch("/auth/me", { headers: { "X-Jira-Lite": "1" } });
  if (r.status === 401) return null;
  if (!r.ok) throw new Error("HTTP " + r.status);
  return r.json();
}

/** Ends the server-side session. */
export async function logout() {
  const r = await fetch("/auth/logout", { method: "POST", headers: { "X-Jira-Lite": "1" } });
  if (!r.ok) throw new Error("HTTP " + r.status);
}

/** Where the "Sign in with Atlassian" button goes; the server redirects back to "/". */
export const LOGIN_URL = "/oauth/login";

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
/** All priorities via the deprecated GET /priority (read scope); prefer createmeta (meta.js). */
export const getPriorities = () => request("priority");
export const getAssignable = (project) => request("user/assignable/search?project=" + enc(project) + "&maxResults=1000");
export const getProjectStatuses = (project) => request("project/" + enc(project) + "/statuses");

// ---- detail panel ----
/** Fields the detail panel shows; `extra` adds custom field ids (e.g. ones required on create). */
const PANEL_FIELDS = ["summary", "status", "description", "assignee", "reporter", "creator", "priority", "issuetype", "created", "updated",
  "parent", "subtasks", "labels", "duedate", "fixVersions", "components"];
/** The issue with its newest 100 changelog histories (`issue.changelog.histories`, newest first). */
export const getIssueDetail = (key, extra = []) =>
  request("issue/" + enc(key) + "?fields=" + [...PANEL_FIELDS, ...extra].join(",") + "&expand=changelog");
export const updateComment = (key, id, adfBody) => request("issue/" + enc(key) + "/comment/" + enc(id), { body: adfBody }, "PUT");
export const deleteComment = (key, id) => request("issue/" + enc(key) + "/comment/" + enc(id), undefined, "DELETE");
