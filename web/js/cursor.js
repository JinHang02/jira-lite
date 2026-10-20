// The keyboard/mouse cursor over list rows and board cards, and the open-row highlight.
import { state } from "./state.js";
import { rowFor } from "./dom.js";
import { actions } from "./actions.js";

/** Syncs the .cur / .open classes on rows and cards with state.cursor / state.current. */
export function markRows() {
  for (const r of document.querySelectorAll(".row[data-key], .tcard[data-key]")) {
    r.classList.toggle("cur", r.dataset.key === state.cursor);
    r.classList.toggle("open", r.dataset.key === state.current);
  }
}

export function setCursor(key, scroll) {
  state.cursor = key;
  markRows();
  if (scroll) {
    const r = rowFor(key);
    if (r) r.scrollIntoView({ block: "nearest", inline: "nearest" });
  }
}

/** Moves the cursor by `step` through the visible issues; an open peek panel follows it. */
export function move(step) {
  const { visible } = state;
  if (!visible.length) return;
  const at = visible.indexOf(state.cursor || state.current);
  const next = visible[Math.max(0, Math.min(visible.length - 1, at < 0 ? 0 : at + step))];
  setCursor(next, true);
  if (state.current) actions.openIssue(next);  // peek follows the cursor, like Linear
}
