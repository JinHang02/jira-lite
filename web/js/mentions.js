// Pure helpers for @mentions in plain-text editors: finding the "@query" at the caret, matching
// people, inserting "@Display Name", and turning the inserted names back into ADF mention nodes.
// No DOM access.

/** Longest text typed after "@" that still counts as a query (names have spaces). */
export const MAX_QUERY = 40;

/**
 * The mention being typed at `caret`: {start, query} where `start` is the index of the "@",
 * or null. The "@" must start the text or follow whitespace or an opening bracket/quote (so
 * "sam@example.com" is not a mention), and the query may not cross a line break.
 */
export function mentionQuery(text, caret) {
  const before = String(text || "").slice(0, caret);
  const at = before.lastIndexOf("@");
  if (at < 0) return null;
  if (at > 0 && !/[\s([{"'“‘]/.test(before[at - 1])) return null;
  const query = before.slice(at + 1);
  // A space may separate first and last name ("@Alice N"), but a trailing one ends the query
  // (so the list doesn't come back right after a pick inserted "@Name ").
  if (query.length > MAX_QUERY || /[\n@]/.test(query) || /^\s|\s$|\s{2}/.test(query)) return null;
  return { start: at, query };
}

/**
 * People matching `query` (case-insensitive), best first: whole-name prefix, then a word
 * prefix, then a substring. An empty query lists everyone (up to `limit`).
 */
export function matchPeople(people, query, limit = 8) {
  const q = String(query || "").trim().toLowerCase();
  const rank = (u) => {
    const n = (u.displayName || "").toLowerCase();
    if (!q || n.startsWith(q)) return 0;
    if (n.split(/\s+/).some((w) => w.startsWith(q))) return 1;
    return n.includes(q) ? 2 : -1;
  };
  return (people || [])
    .map((u, i) => ({ u, r: rank(u), i }))
    .filter((x) => x.r >= 0)
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .slice(0, limit)
    .map((x) => x.u);
}

/**
 * Replaces the "@query" from `start` to `caret` with "@Name " and returns {text, caret}
 * (the caret after the inserted space). An existing space after the caret is reused.
 */
export function insertMention(text, start, caret, name) {
  const s = String(text || "");
  const after = s.slice(caret);
  const token = "@" + name;
  const sep = /^\s/.test(after) ? "" : " ";
  return { text: s.slice(0, start) + token + sep + after, caret: start + token.length + 1 };
}

/** A mention map entry for a person: "@Display Name" -> accountId. */
export const mentionToken = (u) => "@" + u.displayName;

/**
 * Splits one line of text into strings and {id, text} mention parts, for every "@Name" in
 * `mentions` (a Map or object "@Name" -> accountId). A token only matches as a whole: it must
 * start the line or follow a non-word character, and must not run on into a letter or digit.
 * Longer names win over shorter ones that are their prefix ("@Ann Lee" before "@Ann").
 */
export function splitMentions(line, mentions) {
  const entries = mentions instanceof Map ? [...mentions] : Object.entries(mentions || {});
  const tokens = entries.filter(([t, id]) => t && t.length > 1 && t[0] === "@" && id).sort((a, b) => b[0].length - a[0].length);
  const out = [];
  let buf = "";
  let i = 0;
  const s = String(line || "");
  outer: while (i < s.length) {
    if (s[i] === "@" && (i === 0 || !/[\p{L}\p{N}_]/u.test(s[i - 1]))) {
      for (const [t, id] of tokens) {
        if (s.startsWith(t, i) && !/[\p{L}\p{N}_]/u.test(s[i + t.length] || "")) {
          if (buf) out.push(buf);
          buf = "";
          out.push({ id, text: t });
          i += t.length;
          continue outer;
        }
      }
    }
    buf += s[i++];
  }
  if (buf) out.push(buf);
  return out;
}

/** "@Name" -> accountId for every mention node in an ADF doc (for re-editing it as text). */
export function mentionsOf(doc) {
  const map = new Map();
  const walk = (n) => {
    if (!n || typeof n !== "object") return;
    if (n.type === "mention" && n.attrs && n.attrs.id && /^@/.test(n.attrs.text || "")) map.set(n.attrs.text, n.attrs.id);
    (n.content || []).forEach(walk);
  };
  walk(doc);
  return map;
}
