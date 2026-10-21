// Pure helpers for the detail panel's properties block: field values as text, due-date state,
// label parsing, required custom fields from createmeta. No DOM access.

/** Display text of a Jira field value (option, version, user, array, string, number), or "" if empty. */
export function fieldText(v) {
  if (v == null || v === "") return "";
  if (Array.isArray(v)) return v.map(fieldText).filter(Boolean).join(", ");
  if (typeof v !== "object") return String(v);
  const own = v.value || v.name || v.displayName || v.key || "";
  return v.child ? own + " / " + fieldText(v.child) : String(own);
}

/** "YYYY-MM-DD" of a Date in local time. */
export function localDay(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
}

/** "overdue", "today" or "" for a due date ("YYYY-MM-DD"); finished issues are never overdue. */
export function dueState(due, today, finished = false) {
  if (!due || finished) return "";
  const d = due.slice(0, 10);
  return d < today ? "overdue" : d === today ? "today" : "";
}

/** Labels typed as "a, b c" -> ["a", "b", "c"] (Jira labels can't contain spaces), de-duplicated. */
export function parseLabels(text) {
  return [...new Set(String(text || "").split(/[\s,]+/).filter(Boolean))];
}

/** Required custom fields of a createmeta field list ([{fieldId, name, required}]) -> [{id, name}]. */
export function requiredCustomFields(fields) {
  return (fields || []).filter((f) => f.required && /^customfield_/.test(f.fieldId || "")).map((f) => ({ id: f.fieldId, name: f.name }));
}

// ---- editable fields (editmeta) ----

const PICKABLE = ["option", "version", "component"];

/**
 * How a field from editmeta is edited here: "one" (pick one), "many" (pick any number) or null
 * (not editable as a pick list: no allowed values, no "set" operation, or another schema).
 */
export function pickKind(meta) {
  if (!meta || !Array.isArray(meta.allowedValues) || !(meta.operations || []).includes("set")) return null;
  const s = meta.schema || {};
  if (s.type === "array" && PICKABLE.includes(s.items)) return "many";
  return PICKABLE.includes(s.type) ? "one" : null;
}

/** Allowed values to offer: archived versions and disabled options only when currently set. */
export function pickChoices(meta, current) {
  const set = new Set((Array.isArray(current) ? current : current ? [current] : []).map((v) => String(v.id)));
  return ((meta && meta.allowedValues) || []).filter((v) => set.has(String(v.id)) || !(v.archived || v.disabled));
}

/** The field value to PUT for the picked allowed values ({id}): an array for "many", else one or null. */
export function pickValue(kind, picked) {
  if (kind === "many") return (picked || []).map((v) => ({ id: String(v.id) }));
  return picked ? { id: String(picked.id) } : null;
}

/** True if editmeta lets the user set the field (e.g. reporter needs "Modify Reporter"). */
export const canSet = (meta) => !!(meta && (meta.operations || []).includes("set"));

// ---- parent (epic) ----

/**
 * True if the issue type takes an epic as parent: standard types (hierarchy level 0). Epics
 * (level 1+) and sub-tasks (level -1, whose parent is fixed) don't get the Parent row.
 */
export function parentAllowed(issuetype) {
  if (!issuetype || issuetype.subtask) return false;
  if (typeof issuetype.hierarchyLevel === "number") return issuetype.hierarchyLevel === 0;
  return !/^epic$/i.test(issuetype.name || "");
}

/** The epic issue type's name among the project's types (hierarchy level 1), else "Epic". */
export function epicTypeName(types) {
  const t = (types || []).find((x) => x && x.hierarchyLevel === 1 && !x.subtask);
  return t && t.name ? t.name : "Epic";
}

const KEY_RE = /^[A-Z][A-Z0-9_]*-\d+$/i;

/**
 * JQL for the parent picker: open epics of the project, newest first; `query` narrows them by
 * key (when it looks like one) or by a summary prefix search. Characters Jira's text search
 * treats as syntax are dropped.
 */
export function epicJql(project, query = "", typeName = "Epic") {
  const clean = (s) => String(s).replace(/["\\]/g, " ");
  let jql = 'project = "' + clean(project) + '" AND issuetype = "' + clean(typeName) + '" AND statusCategory != Done';
  const q = String(query || "").trim();
  if (KEY_RE.test(q)) jql += ' AND key = "' + q.toUpperCase() + '"';
  else {
    const words = q.replace(/[+\-&|!(){}[\]^~*?\\:"'/]/g, " ").trim().replace(/\s+/g, " ");
    if (words) jql += ' AND summary ~ "' + words + '*"';
  }
  return jql + " ORDER BY updated DESC";
}

/** Epics ({key, fields.summary}) whose key or summary contains `query` (case-insensitive). */
export function filterEpics(epics, query) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return epics || [];
  return (epics || []).filter((e) => e.key.toLowerCase().includes(q) || String((e.fields || {}).summary || "").toLowerCase().includes(q));
}

// ---- breadcrumb ----

/**
 * The issue's ancestors, top first (e.g. [epic, parent] for a sub-task): its `parent`, then each
 * parent's own parent as far as `lookup(key)` (a cached issue or null) knows. At most 3; stops on a cycle.
 */
export function ancestry(issue, lookup) {
  const out = [];
  const seen = new Set([issue.key]);
  let p = issue.fields && issue.fields.parent;
  while (p && p.key && !seen.has(p.key) && out.length < 3) {
    seen.add(p.key);
    out.unshift(p);
    const full = lookup(p.key);
    p = full && full.fields ? full.fields.parent : null;
  }
  return out;
}
