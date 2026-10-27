// Read-your-writes overlay. Jira Cloud's search (/search/jql) is eventually consistent: for a few
// seconds after a write it still returns the old issue, or misses a new one, while GET issue/{key}
// is current at once. After every write the app fetches the issues it touched by key and records
// them here; every search result (list, delta, sub-issues, epic progress) is passed through
// `apply`, which swaps in those fresher copies, adds created ones and drops deleted ones until the
// index has caught up. No DOM access.

/** How long a write is remembered: well past Jira's index lag, then search alone is trusted. */
export const TTL_MS = 10 * 60 * 1000;

/** Milliseconds of a Jira timestamp ("2026-10-26T09:12:00.000+0800"); NaN when missing or invalid. */
export function stamp(iso) {
  // Jira writes the offset without a colon, which not every engine's Date.parse accepts.
  return Date.parse(String(iso || "").replace(/([+-]\d\d)(\d\d)$/, "$1:$2"));
}

/** True when every field the search copy `a` has equals that field in `b` (searches ask for fewer fields). */
function sameFields(a, b) {
  const fa = a.fields || {}, fb = b.fields || {};
  return Object.keys(fa).every((k) => JSON.stringify(fa[k]) === JSON.stringify(fb[k]));
}

/**
 * A store of issues known to be newer than the search index. `now` is injectable for tests.
 *   put(issue)  an issue just fetched by key after a write
 *   drop(key)   an issue just deleted
 *   update(issue), missing(list, keep)  re-check what `apply` would add (edits.withWrites)
 *   apply(list, keep, {add}) -> list with the fresher copies (see below)
 */
export function createOverlay({ ttl = TTL_MS, now = () => Date.now() } = {}) {
  const entries = new Map();  // key -> {issue (null: deleted), at}

  const prune = () => {
    const t = now();
    for (const [k, e] of entries) if (t - e.at > ttl) entries.delete(k);
  };

  return {
    put(issue) {
      if (issue && issue.key) entries.set(issue.key, { issue, at: now() });
    },
    drop(key) {
      entries.set(key, { issue: null, at: now() });
    },
    /** Swaps in a re-read copy of a remembered issue, keeping its age (so it still expires). */
    update(issue) {
      const e = issue && entries.get(issue.key);
      if (e) e.issue = issue;
    },
    get(key) {
      const e = entries.get(key);
      return e ? e.issue : undefined;
    },
    /** Keys of the remembered issues `apply` would add to `list` (missing from it, and `keep`ing). */
    missing(list, keep) {
      prune();
      const seen = new Set(list.map((i) => i.key));
      return [...entries].filter(([k, e]) => e.issue && !seen.has(k) && keep(e.issue)).map(([k]) => k);
    },
    get size() { prune(); return entries.size; },

    /**
     * Reconciles search results with the remembered writes. An issue in `list` is replaced by
     * the remembered copy when that copy is newer (by `fields.updated`), removed when it was
     * deleted, or when the newer copy no longer `keep`s (e.g. moved out of the view). Once the
     * search copy is as new as ours, the entry is retired. With `add`, remembered issues missing
     * from `list` that `keep` are put in front (e.g. a just-created sub-task). Returns `list`
     * itself when nothing changed.
     */
    apply(list, keep, { add = true } = {}) {
      prune();
      if (!entries.size) return list;
      let changed = false;
      const seen = new Set();
      const out = [];
      for (const i of list) {
        seen.add(i.key);
        const e = entries.get(i.key);
        if (!e) { out.push(i); continue; }
        if (e.issue === null) { changed = true; continue; }
        const ours = stamp(e.issue.fields && e.issue.fields.updated);
        const theirs = stamp(i.fields && i.fields.updated);
        // Newer than ours (someone else edited since), or the same version with the same values: the
        // index caught up. Same `updated` but different values happens for derived fields (a new
        // sub-task doesn't touch its parent's `updated`, but its `subtasks` list): keep ours.
        if (theirs > ours || (theirs === ours && sameFields(i, e.issue)) || Number.isNaN(ours)) {
          entries.delete(i.key);
          out.push(i);
          continue;
        }
        changed = true;
        if (keep(e.issue)) out.push(e.issue);
      }
      const extra = [];
      if (add) for (const [k, e] of entries) if (e.issue && !seen.has(k) && keep(e.issue)) extra.push(e.issue);
      if (!changed && !extra.length) return list;
      return [...extra, ...out];
    },
  };
}

/** The app's overlay. */
export const writes = createOverlay();
