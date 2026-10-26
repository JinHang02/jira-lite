// Unsaved editor text that must survive the sign-in round trip (OAuth sessions end on a server
// restart or token expiry, and signing in again leaves the page). Open editors register a
// snapshot function; auth.requireLogin stashes every snapshot, and the detail panel reopens the
// editors of the issue it renders with that text. No DOM access.
//
// A draft: {key, kind: "title" | "description" | "comment", id?, text, mentions?: [[name, accountId]],
//           kept?: [ADF node], base?: string}  (description: the ⟦n⟧ blocks and the Markdown it started from)

const live = new Set();

/**
 * Registers an open editor; `snapshot()` returns its draft, or null when there's nothing to keep
 * (closed, unchanged). Returns the unregister function.
 */
export function track(snapshot) {
  live.add(snapshot);
  return () => live.delete(snapshot);
}

/** The drafts of every open editor (a closed editor's snapshot returns null and is dropped). */
export function snapshotAll() {
  const out = [];
  for (const s of [...live]) {
    const d = s();
    if (d) out.push(d);
    else live.delete(s);
  }
  return out;
}

/** Parses stashed drafts: only well-formed ones survive (sessionStorage content is not trusted). */
export function parseDrafts(raw) {
  let list;
  try { list = JSON.parse(raw || "[]"); } catch (e) { return []; }
  if (!Array.isArray(list)) return [];
  return list.filter((d) => d && typeof d.key === "string" && typeof d.text === "string"
    && ["title", "description", "comment"].includes(d.kind) && (d.kind !== "comment" || typeof d.id === "string")
    && (d.mentions === undefined || Array.isArray(d.mentions)) && (d.kept === undefined || Array.isArray(d.kept)));
}

/** Splits drafts into those for issue `key` and the rest (kept for other issues). */
export function draftsFor(list, key) {
  return { mine: list.filter((d) => d.key === key), rest: list.filter((d) => d.key !== key) };
}
