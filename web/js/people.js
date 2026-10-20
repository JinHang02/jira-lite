// Pure helpers for the sidebar's People section. No DOM access.

/** People listed before "Show all (N)". */
export const PEOPLE_LIMIT = 8;

/**
 * The people to list: {shown, hidden}. `people` is sorted by name and `shown` keeps that order.
 * - a filter shows every name match;
 * - `showAll`, or no more than `limit` people, shows everyone;
 * - otherwise up to `limit`: the selected person first, then recent picks, then by name.
 * `hidden` is how many are left out (0 when filtering).
 */
export function visiblePeople(people, { selected = "", recent = [], filter = "", showAll = false, limit = PEOPLE_LIMIT } = {}) {
  const q = filter.trim().toLowerCase();
  if (q) return { shown: people.filter((u) => u.displayName.toLowerCase().includes(q)), hidden: 0 };
  if (showAll || people.length <= limit) return { shown: people, hidden: 0 };
  const ids = new Set(people.map((u) => u.accountId));
  const pick = new Set();
  for (const id of [selected, ...recent]) if (pick.size < limit && ids.has(id)) pick.add(id);
  for (const u of people) {
    if (pick.size >= limit) break;
    pick.add(u.accountId);
  }
  const shown = people.filter((u) => pick.has(u.accountId));
  return { shown, hidden: people.length - shown.length };
}

/** Most-recently-used list: `id` first, no duplicates, at most `max` entries. */
export function pushRecent(recent, id, max = PEOPLE_LIMIT) {
  return [id, ...(recent || []).filter((x) => x !== id)].slice(0, max);
}
