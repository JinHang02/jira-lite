// Pure classification and ordering of Jira statuses and priorities. No DOM access.

/** Order of status kinds for list groups: work in progress first, finished last. */
export const KIND_ORDER = ["started", "review", "blocked", "todo", "backlog", "done", "canceled"];

/** Order of status kinds for board columns: left-to-right workflow. */
export const BOARD_ORDER = ["backlog", "todo", "started", "blocked", "review", "done", "canceled"];

/** Maps a Jira status ({name, statusCategory}) onto one of the KIND_ORDER kinds. */
export function statusKind(s) {
  const n = ((s && s.name) || "").toLowerCase();
  const cat = ((s && s.statusCategory) || {}).key;
  if (cat === "done") return /cancel|won.?t|duplicate|reject|abandon/.test(n) ? "canceled" : "done";
  if (cat === "indeterminate") return /block|hold|wait/.test(n) ? "blocked" : /review|test|qa|verif/.test(n) ? "review" : "started";
  return /backlog|icebox/.test(n) ? "backlog" : "todo";
}

/** Sort rank of a status: its kind's position in `order` (KIND_ORDER or BOARD_ORDER). */
export function statusRank(s, order = KIND_ORDER) {
  return order.indexOf(statusKind(s));
}

/** Comparator for statuses by kind in `order`, ties broken by name. */
export function compareStatuses(a, b, order = KIND_ORDER) {
  return statusRank(a, order) - statusRank(b, order) || (a.name || "").localeCompare(b.name || "");
}

/**
 * De-duplicated statuses from GET /project/{key}/statuses, which lists the statuses per issue type
 * ([{name, statuses: [status]}]). First occurrence of each id wins.
 */
export function uniqueStatuses(perIssueType) {
  const byId = new Map();
  for (const t of perIssueType || []) for (const s of t.statuses || []) if (!byId.has(String(s.id))) byId.set(String(s.id), s);
  return [...byId.values()];
}

/** Groups issues by status in list order (KIND_ORDER, then name): [{status, items}]. */
export function groupByStatus(issues) {
  const groups = new Map();
  for (const i of issues) {
    const s = i.fields.status;
    const id = String(s.id);
    if (!groups.has(id)) groups.set(id, { status: s, items: [] });
    groups.get(id).items.push(i);
  }
  return [...groups.values()].sort((a, b) => compareStatuses(a.status, b.status, KIND_ORDER));
}

/**
 * Board columns: one per project status plus any status seen on `issues` but not in `statuses`,
 * in BOARD_ORDER (ties by name): [{status, items}]. With showDone off, empty done/canceled
 * columns are left out (their issues are not loaded then).
 */
export function boardColumns(statuses, issues, { showDone = true } = {}) {
  const cols = new Map();
  for (const s of statuses || []) if (!cols.has(String(s.id))) cols.set(String(s.id), { status: s, items: [] });
  for (const i of issues || []) {
    const s = i.fields.status;
    const id = String(s.id);
    if (!cols.has(id)) cols.set(id, { status: s, items: [] });
    cols.get(id).items.push(i);
  }
  return [...cols.values()]
    .filter((c) => showDone || c.items.length || !["done", "canceled"].includes(statusKind(c.status)))
    .sort((a, b) => compareStatuses(a.status, b.status, BOARD_ORDER));
}

/** Priority levels, most to least urgent. */
export const PRIO_LEVELS = ["highest", "high", "medium", "low", "lowest", "none"];

/** Maps a Jira priority ({name}) or null onto one of PRIO_LEVELS. */
export function prioKind(p) {
  const n = p && p.name ? p.name.toLowerCase() : "";
  if (/highest|blocker|critical|urgent/.test(n)) return "highest";
  if (/lowest|trivial/.test(n)) return "lowest";
  if (/high|major/.test(n)) return "high";
  if (/medium|normal/.test(n)) return "medium";
  if (/low|minor/.test(n)) return "low";
  return "none";
}
