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
