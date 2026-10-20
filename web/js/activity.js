// Pure activity timeline: Jira changelog items -> one-line sentences, merged with comments in
// time order, with long runs of history lines collapsed. No DOM access.

// Changelog fields that are noise in a human timeline (time tracking, rank, remote links...).
const SKIP = new Set(["remoteworkitemlink", "remoteissuelink", "timeestimate", "timeoriginalestimate", "timespent",
  "worklogid", "worklogtimespent", "rank", "resolution", "resolutiondate", "workflow", "flagged"]);
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MAX_VALUE = 80;

/** Shortens a changelog value for a one-line sentence. */
export function clip(s, max = MAX_VALUE) {
  const t = String(s == null ? "" : s).replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1).trimEnd() + "…" : t;
}

/** "2026-10-21 00:00:00.0" or "2026-10-21" -> "Oct 21, 2026"; anything else unchanged. */
export function dayText(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s || "");
  return m ? MONTHS[Number(m[2]) - 1] + " " + Number(m[3]) + ", " + m[1] : String(s || "");
}

const words = (s) => (s || "").split(/\s+/).filter(Boolean);
const val = (s) => "“" + clip(s) + "”";

/** Labels are space-separated in the changelog: "added label x", "removed labels a, b". */
function labelChange(from, to) {
  const a = words(from), b = words(to);
  const added = b.filter((x) => !a.includes(x)), removed = a.filter((x) => !b.includes(x));
  const part = (verb, xs) => xs.length ? verb + " label" + (xs.length > 1 ? "s " : " ") + xs.join(", ") : "";
  return [part("added", added), part("removed", removed)].filter(Boolean).join(" and ") || null;
}

/** One changelog item ({field, fieldId, fromString, toString}) -> a sentence without the actor, or null to hide it. */
export function describeItem(item) {
  const field = item.field || item.fieldId || "";
  const key = (item.fieldId || field).toLowerCase();
  if (SKIP.has(field.toLowerCase()) || SKIP.has(key)) return null;
  const from = item.fromString == null || item.fromString === "" ? null : item.fromString;
  const to = item.toString == null || item.toString === "" ? null : item.toString;
  switch (key) {
    case "status": return from ? "changed status from " + from + " → " + to : "set status to " + to;
    case "assignee":
      if (!to) return "unassigned " + (from || "the issue");
      return from ? "reassigned from " + from + " to " + to : "assigned to " + to;
    case "priority": return from && to ? "changed priority from " + from + " → " + to : to ? "set priority to " + to : "removed the priority";
    case "summary": return "renamed the issue to " + val(to);
    case "description": return "updated the description";
    case "labels": return labelChange(from, to);
    case "duedate": return to ? (from ? "changed the due date to " : "set the due date to ") + dayText(to) : "removed the due date";
    case "attachment": return to ? "attached " + clip(to) : "removed attachment " + clip(from);
    case "issuetype": return "changed the type from " + from + " → " + to;
    case "link": case "issuelinks": return to ? "added link: " + clip(to) : "removed link: " + clip(from);
    case "parent": case "issueparentassociation": return to ? "set the parent to " + clip(to) : "removed the parent";
    case "comment": return null;  // comments are shown as cards
  }
  const multi = /version|component|sprint/i.test(field);  // multi-value fields log adds/removes
  if (from && to) return "changed " + field + " from " + val(from) + " → " + val(to);
  if (to) return multi ? "added " + field + " " + val(to) : "set " + field + " to " + val(to);
  if (from) return multi ? "removed " + field + " " + val(from) : "cleared " + field;
  return null;
}

/** Changelog histories ([{id, author, created, items}]) -> history entries, one per visible item. */
export function historyEntries(histories) {
  const out = [];
  for (const h of histories || []) {
    (h.items || []).forEach((it, i) => {
      const text = describeItem(it);
      if (text) out.push({ type: "history", id: h.id + ":" + i, at: h.created, author: h.author || null, text });
    });
  }
  return out;
}

const time = (iso) => { const t = Date.parse(iso); return Number.isNaN(t) ? 0 : t; };

/**
 * Comments, changelog histories and the "created" event in chronological order (oldest first).
 * Ties keep the order: created, history, comments. Entries: {type: "created"|"history"|"comment", at, ...}.
 */
export function buildTimeline({ comments = [], histories = [], created = null, creator = null } = {}) {
  const all = [];
  if (created) all.push({ type: "created", id: "created", at: created, author: creator, text: "created the issue" });
  all.push(...historyEntries(histories));
  for (const c of comments) all.push({ type: "comment", id: "c" + c.id, at: c.created, comment: c });
  return all.map((e, i) => [e, i]).sort((a, b) => time(a[0].at) - time(b[0].at) || a[1] - b[1]).map(([e]) => e);
}

/**
 * Collapses each run of more than `max` consecutive one-line entries (history/created): the first
 * and last stay visible, the middle becomes {type: "more", id, entries}.
 */
export function collapseRuns(entries, max = 3) {
  const out = [];
  let run = [];
  const flush = () => {
    if (run.length > max) out.push(run[0], { type: "more", id: "more:" + run[1].id, entries: run.slice(1, -1) }, run[run.length - 1]);
    else out.push(...run);
    run = [];
  };
  for (const e of entries) {
    if (e.type === "comment") { flush(); out.push(e); } else run.push(e);
  }
  flush();
  return out;
}

/** True if a comment was edited after it was posted (Jira sets updated = created on creation). */
export function wasEdited(c) {
  return !!(c && c.updated && c.created && time(c.updated) - time(c.created) > 1000);
}
