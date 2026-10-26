// Talks to the local proxy (app/): /jira/* -> Jira REST v3.

/** Fields fetched for list rows, board cards, search hits and sub-issues. */
export const FIELDS = ["summary", "status", "priority", "assignee", "updated", "created", "duedate", "labels", "issuetype", "subtasks", "parent", "components"];
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
    const err = new Error(parts.join("; ") || ("HTTP " + r.status + (text ? ": " + text.slice(0, 200) : "")));
    err.status = r.status;
    throw err;
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
export const updateIssue = (key, fields) => editIssue(key, { fields });
/**
 * PUT issue/{key} with a raw body: `fields` (replace values) and/or `update` (Jira's atomic verbs,
 * e.g. {labels: [{add: "x"}, {remove: "y"}]}, which keep values others added meanwhile).
 */
export const editIssue = (key, body) => request("issue/" + enc(key), body, "PUT");
export const assign = (key, accountId) => request("issue/" + enc(key) + "/assignee", { accountId }, "PUT");
export const addComment = (key, adfBody) => request("issue/" + enc(key) + "/comment", { body: adfBody });
export const createIssue = (fields) => request("issue", { fields });
/** Deletes the issue; Jira refuses one with sub-tasks unless `withSubtasks`. */
export const deleteIssue = (key, withSubtasks) => request("issue/" + enc(key) + (withSubtasks ? "?deleteSubtasks=true" : ""), undefined, "DELETE");

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
/** What the user may change on the issue: field id -> {name, schema, operations, allowedValues?, required}. */
export const getEditMeta = (key) => request("issue/" + enc(key) + "/editmeta").then((r) => (r && r.fields) || {});
export const updateComment = (key, id, adfBody) => request("issue/" + enc(key) + "/comment/" + enc(id), { body: adfBody }, "PUT");
export const deleteComment = (key, id) => request("issue/" + enc(key) + "/comment/" + enc(id), undefined, "DELETE");

// ---- detail & content ----
/** Open epics etc. for the parent picker: one page of {key, summary, status, issuetype}. */
export const searchParents = (jql, maxResults = 50) =>
  searchPage(jql, { fields: ["summary", "status", "issuetype"], maxResults }).then((r) => r.issues || []);

/**
 * Uploads files as multipart/form-data (field "file") to the issue. XHR rather than fetch, for
 * upload progress: `onProgress(fraction)` gets 0..1. Resolves to Jira's list of the new
 * attachments; rejects like `request` (Error with Jira's messages, or LoginRequired).
 */
export function uploadAttachments(key, files, onProgress = () => {}) {
  const form = new FormData();
  for (const f of files) form.append("file", f, f.name);
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/jira/issue/" + enc(key) + "/attachments");
    xhr.setRequestHeader("X-Jira-Lite", "1");  // the browser sets the multipart Content-Type (boundary)
    xhr.upload.addEventListener("progress", (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); });
    xhr.addEventListener("error", () => reject(new Error("Upload failed: network error")));
    xhr.addEventListener("abort", () => reject(new Error("Upload cancelled")));
    xhr.addEventListener("load", () => {
      if (xhr.status === 401 && xhr.getResponseHeader("X-Jira-Lite-Auth") === "login") {
        onLoginRequired();
        return reject(new LoginRequired());
      }
      let data = null;
      try { data = xhr.responseText ? JSON.parse(xhr.responseText) : null; } catch (e) { /* plain-text error */ }
      if (xhr.status >= 200 && xhr.status < 300) return resolve(data || []);
      const parts = data ? [...(data.errorMessages || []), ...Object.entries(data.errors || {}).map(([k, v]) => k + ": " + v)] : [];
      reject(new Error(parts.join("; ") || ("HTTP " + xhr.status + (xhr.responseText ? ": " + xhr.responseText.slice(0, 200) : ""))));
    });
    xhr.send(form);
  });
}

/** The Media Services file id of an attachment (what an ADF media node names), via the server. */
export const getMediaId = (attachmentId) => request("/files/media/" + enc(attachmentId)).then((r) => r.id);

// ---- lists & navigation ----
/** All issues matching `jql` with only `fields` (e.g. the sidebar's epic progress), up to `maxPages` pages of 100. */
export async function searchFields(jql, fields, maxPages = 5) {
  const out = [];
  let token;
  for (let page = 0; page < maxPages; page++) {
    const r = await searchPage(jql, { fields, nextPageToken: token });
    out.push(...(r.issues || []));
    token = r.nextPageToken;
    if (!token || r.isLast) break;
  }
  return out;
}
