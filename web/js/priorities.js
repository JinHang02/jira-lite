// Pure helpers for the priority list. GET /priority/search needs an admin scope under OAuth, so
// the list comes from create metadata (the priority field's allowedValues). No DOM access.

/** The issue type whose create metadata supplies the priorities: the first non-subtask type. */
export function priorityIssueType(types) {
  const list = types || [];
  return list.find((t) => !t.subtask) || list[0] || null;
}

/** [{id, name, iconUrl?}] from a createmeta field list, or [] when it has no priority field. */
export function prioritiesFromFields(fields) {
  const f = (fields || []).find((x) => (x.fieldId || x.key) === "priority");
  return normalizePriorities(f && f.allowedValues);
}

/** Keeps id, name and iconUrl of each priority, dropping entries without an id or a name. */
export function normalizePriorities(list) {
  return (Array.isArray(list) ? list : [])
    .filter((p) => p && p.id != null && p.name)
    .map((p) => ({ id: String(p.id), name: p.name, ...(p.iconUrl ? { iconUrl: p.iconUrl } : {}) }));
}
