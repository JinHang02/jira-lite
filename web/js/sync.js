// Pure helpers for the cheap auto-refresh: choose between a full reload and a delta sync,
// size the delta window, and merge a delta into the loaded list. No DOM access.

/** A full reload at least this often, to catch deleted or moved issues that a delta can't see. */
export const FULL_EVERY_MS = 10 * 60 * 1000;
/** Extra minutes added to every delta window (search index lag, request latency). */
export const OVERLAP_MIN = 2;

/**
 * "full" or "delta". Full when nothing has loaded yet, when the last full load is
 * `fullEveryMs` old, or when `canDelta` is false (e.g. "mine" before the user's id is known).
 */
export function syncPlan({ now, lastFull, lastSync, canDelta = true, fullEveryMs = FULL_EVERY_MS }) {
  if (!canDelta || !lastFull || !lastSync) return "full";
  return now - lastFull >= fullEveryMs ? "full" : "delta";
}

/**
 * Minutes to look back: the whole minutes elapsed since the last sync *started*, plus the
 * overlap. A clock that went backwards counts as one minute.
 */
export function deltaMinutes(lastSync, now, overlap = OVERLAP_MIN) {
  return Math.max(1, Math.ceil((now - lastSync) / 60000)) + overlap;
}

/**
 * Merges `delta` (recently updated issues, newest first) into `issues`. Changed issues that
 * still `keep(issue)` move to the top, where a full reload ordered by `updated DESC` would put
 * them; new matching issues go there too; issues that no longer match are removed.
 * Returns {issues, changed, keys}: `issues` is the input array itself when nothing changed,
 * and `keys` lists every key the delta contained.
 */
export function mergeDelta(issues, delta, keep) {
  const byKey = new Map(issues.map((i) => [i.key, i]));
  const fresh = [];
  const drop = new Set();
  const keys = [];
  for (const d of delta || []) {
    if (keys.includes(d.key)) continue;  // listed twice (pages shifted while paging)
    keys.push(d.key);
    const old = byKey.get(d.key);
    if (keep(d)) {
      if (!old || JSON.stringify(old.fields) !== JSON.stringify(d.fields)) {
        fresh.push(d);
        drop.add(d.key);
      }
    } else if (old) {
      drop.add(d.key);
    }
  }
  if (!drop.size) return { issues, changed: false, keys };
  return { issues: [...fresh, ...issues.filter((i) => !drop.has(i.key))], changed: true, keys };
}
