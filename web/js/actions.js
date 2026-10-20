// Late-bound entry points shared between views. Views call each other through this object
// instead of importing each other, which keeps the module graph acyclic. main.js wires it.

const NAMES = ["openIssue", "closeDetail", "loadDetail", "loadList", "renderMain", "openCreate", "setWho", "setView", "toggleDone", "refresh", "sync",
  "setEpic", "applySavedView", "saveView", "loadEpics"];

export const actions = Object.fromEntries(NAMES.map((n) => [n, () => { throw new Error("actions." + n + " is not wired"); }]));

/** Installs implementations; every name must be provided exactly once. */
export function wire(impls) {
  for (const n of NAMES) {
    if (typeof impls[n] !== "function") throw new Error("wire: missing " + n);
    actions[n] = impls[n];
  }
  const extra = Object.keys(impls).filter((n) => !NAMES.includes(n));
  if (extra.length) throw new Error("wire: unknown " + extra.join(", "));
}
