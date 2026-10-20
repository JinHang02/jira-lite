// Pure store for saved views: a named snapshot of the view settings (whose issues or which epic,
// list/board, grouping, ordering, show completed, free-text filter). Persisted as JSON by the
// caller. No DOM access.
import { GROUPINGS, ORDERINGS } from "./issues.js";

/** Longest view name kept. */
export const NAME_MAX = 60;

/** The settings a view captures, from the app state. */
export function snapshot(s) {
  return {
    who: s.who || "mine",
    epic: s.epic || null,
    view: s.view === "board" ? "board" : "list",
    grouping: GROUPINGS.includes(s.grouping) ? s.grouping : GROUPINGS[0],
    ordering: ORDERINGS.includes(s.ordering) ? s.ordering : ORDERINGS[0],
    showDone: !!s.showDone,
    filter: String(s.filter || "").trim(),
  };
}

const cleanName = (n) => String(n == null ? "" : n).replace(/\s+/g, " ").trim().slice(0, NAME_MAX);

/** One stored view, normalised; null when it is unusable (no id or name). */
function normalize(v) {
  if (!v || typeof v !== "object" || typeof v.id !== "string" || !v.id) return null;
  const name = cleanName(v.name);
  if (!name) return null;
  return { id: v.id, name, ...snapshot(v) };
}

/** Views from their JSON (anything malformed is skipped; duplicate ids keep the first). */
export function parseViews(json) {
  let raw;
  try { raw = JSON.parse(json || "[]"); } catch (e) { return []; }
  if (!Array.isArray(raw)) return [];
  const ids = new Set();
  const out = [];
  for (const v of raw.map(normalize)) {
    if (!v || ids.has(v.id)) continue;
    ids.add(v.id);
    out.push(v);
  }
  return out;
}

export const serializeViews = (views) => JSON.stringify(views);

/**
 * `name` made unique among `views` (case-insensitive) by appending " 2", " 3", …; the view with
 * id `exceptId` doesn't count (renaming a view to its own name).
 */
export function uniqueName(views, name, exceptId = null) {
  const base = cleanName(name) || "Untitled view";
  const taken = new Set(views.filter((v) => v.id !== exceptId).map((v) => v.name.toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) {
    const cand = base.slice(0, NAME_MAX - String(n).length - 1) + " " + n;
    if (!taken.has(cand.toLowerCase())) return cand;
  }
}

/** A fresh id that no view in `views` uses. `rand` is injectable for tests. */
export function newId(views, rand = Math.random) {
  const ids = new Set(views.map((v) => v.id));
  for (;;) {
    const id = "v" + Math.floor(rand() * 2 ** 32).toString(36);
    if (!ids.has(id)) return id;
  }
}

/** Adds a view of `settings` named `name` (made unique). Returns {views, view}. */
export function addView(views, settings, name, id = newId(views)) {
  const view = { id, name: uniqueName(views, name), ...snapshot(settings) };
  return { views: [...views, view], view };
}

/** Renames view `id` (made unique); a blank name or unknown id leaves the list unchanged. */
export function renameView(views, id, name) {
  if (!cleanName(name) || !views.some((v) => v.id === id)) return views;
  const unique = uniqueName(views, name, id);
  return views.map((v) => (v.id === id ? { ...v, name: unique } : v));
}

export function deleteView(views, id) {
  return views.filter((v) => v.id !== id);
}

/** The state changes that applying `view` makes (see snapshot). */
export function applyView(view) {
  return snapshot(view);
}

/** True when the current settings are still exactly the view's (not modified since applied). */
export function sameSettings(view, s) {
  const a = snapshot(view), b = snapshot(s);
  return Object.keys(a).every((k) => a[k] === b[k]);
}
