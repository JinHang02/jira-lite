// Status and priority icons, avatars and the sub-issue badge.
import { el, icon, ICONS } from "./dom.js";
import { statusKind, prioKind } from "./status.js";
import { progress } from "./issues.js";

/** Linear-style status glyph: dashed ring, ring with a pie slice, or a filled disc. 14px. */
export function statusIcon(s) {
  const k = statusKind(s);
  const ring = '<circle cx="7" cy="7" r="6" fill="none" stroke="currentColor" stroke-width="1.5"';
  const C = 2 * Math.PI * 2;  // inner pie: r=2 circle stroked 4 wide covers radius 0..4
  let b;
  if (k === "backlog") b = ring + ' stroke-dasharray="1.4 1.74"/>';
  else if (k === "done") b = '<circle cx="7" cy="7" r="6.75" fill="currentColor"/><path d="M4.4 7.2l1.8 1.8 3.5-3.7" fill="none" style="stroke:var(--bg)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>';
  else if (k === "canceled") b = '<circle cx="7" cy="7" r="6.75" fill="currentColor"/><path d="M5 5l4 4M9 5l-4 4" style="stroke:var(--bg)" stroke-width="1.5" stroke-linecap="round"/>';
  else {
    const f = { todo: 0, started: 0.5, review: 0.75, blocked: 0.5 }[k];
    b = ring + "/>" + (f ? '<circle cx="7" cy="7" r="2" fill="none" stroke="currentColor" stroke-width="4" stroke-dasharray="' +
      (f * C).toFixed(3) + " " + C.toFixed(3) + '" transform="rotate(-90 7 7)"/>' : "");
  }
  return icon(14, b, "s-" + k);
}

// Jira-style priority glyphs on a 16px grid, centred on (8, 8); colours come from --prio-* tokens.
const STROKE = 'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';
const PRIO_PATHS = {
  highest: "M3.5 7.5L8 4l4.5 3.5M3.5 12L8 8.5l4.5 3.5",   // double chevron up
  high: "M3.5 9.75L8 6.25l4.5 3.5",                       // chevron up
  medium: "M3.5 6.25h9M3.5 9.75h9",                       // "="
  low: "M3.5 6.25L8 9.75l4.5-3.5",                        // chevron down
  lowest: "M3.5 4L8 7.5l4.5-3.5M3.5 8.5L8 12l4.5-3.5",    // double chevron down
};
const PRIO_NONE = [4, 8, 12].map((x) => '<circle cx="' + x + '" cy="8" r="1.1" fill="currentColor"/>').join("");

/** SVG markup for a priority level (exported for tests and previews). */
export function prioSvgBody(kind) {
  return PRIO_PATHS[kind] ? '<path d="' + PRIO_PATHS[kind] + '" ' + STROKE + "/>" : PRIO_NONE;
}

/** 16px priority icon for a Jira priority ({name}) or null. */
export function prioIcon(p) {
  const k = prioKind(p);
  const s = icon(16, prioSvgBody(k), "picon p-" + k);
  s.dataset.prio = k;
  return s;
}

/** 18px initials avatar with a stable colour per account, or a dashed circle for nobody. */
export function avatar(u) {
  if (!u) return icon(18, '<circle cx="9" cy="9" r="7.5" fill="none" stroke="currentColor" stroke-width="1.2" stroke-dasharray="2 2"/>', "av none");
  const initials = u.displayName.split(/\s+/).filter(Boolean).map((w) => w[0]).slice(0, 2).join("").toUpperCase();
  let h = 0;
  for (const ch of u.accountId || u.displayName) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return el("span", { class: "av", title: u.displayName, style: "background:hsl(" + h + " 45% 48%)" }, initials);
}

/** "2/5" sub-task progress pill, or null when the issue has no sub-tasks. */
export function subBadge(f) {
  const { done, total } = progress(f.subtasks);
  if (!total) return null;
  return el("span", { class: "badge", title: done + " of " + total + " sub-tasks done" }, icon(12, ICONS.sub, ""), done + "/" + total);
}

/** Sidebar navigation glyphs (16px). */
export const NAV_ICONS = {
  mine: '<circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="8" cy="8" r="2.25" fill="currentColor"/>',
  all: '<rect x="2" y="2" width="9" height="9" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M5.5 14h6a2.5 2.5 0 0 0 2.5-2.5v-6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
};
