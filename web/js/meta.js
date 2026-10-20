// Cached project metadata from createmeta: issue types, per-type fields, and the priority list.
import * as jira from "./api.js";
import { state } from "./state.js";
import { priorityIssueType, prioritiesFromFields, normalizePriorities } from "./priorities.js";

let typesPromise = null;
const fieldsCache = new Map();  // issue type id -> Promise<fields>

/** Returns `p`; if it fails while still the cached one, `drop` forgets it so the next call retries. */
function cached(p, isCurrent, drop) {
  p.catch(() => { if (isCurrent()) drop(); });
  return p;
}

/** The project's issue types (createmeta), fetched once. */
export function issueTypes() {
  if (!typesPromise) {
    const p = jira.createMetaTypes(state.cfg.project);
    typesPromise = cached(p, () => typesPromise === p, () => { typesPromise = null; });
  }
  return typesPromise;
}

/** Create-screen fields of an issue type (createmeta), fetched once per type. */
export function typeFields(typeId) {
  if (!fieldsCache.has(typeId)) {
    const p = jira.createMetaFields(state.cfg.project, typeId);
    fieldsCache.set(typeId, cached(p, () => fieldsCache.get(typeId) === p, () => fieldsCache.delete(typeId)));
  }
  return fieldsCache.get(typeId);
}

/**
 * Priorities in Jira's order. GET /priority/search needs an admin scope under OAuth, so they
 * come from the first standard issue type's create metadata (which the create dialog reuses),
 * falling back to the deprecated GET /priority.
 */
export async function loadPriorities() {
  try {
    const type = priorityIssueType(await issueTypes());
    if (type) {
      const list = prioritiesFromFields(await typeFields(type.id));
      if (list.length) return list;
    }
  } catch (e) {
    if (e.loginRequired) throw e;
  }
  return normalizePriorities(await jira.getPriorities());
}
