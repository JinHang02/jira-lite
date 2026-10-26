// Status and priority icons, avatars and the sub-issue badge.
import { el, icon, ICONS } from "./dom.js";
import { statusKind, prioKind } from "./status.js";
import { childProgress } from "./issues.js";

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

/** "2/5" progress pill of an issue's sub-issues (an epic's child issues per `epics`, else its sub-tasks), or null. */
export function subBadge(issue, epics) {
  const { done, total, epic, more } = childProgress(issue, epics);
  if (!total) return null;
  const n = total + (more ? "+" : "");  // more: Jira has further children than were counted
  return el("span", { class: "badge", title: done + " of " + n + (epic ? " child issues" : " sub-tasks") + " done" }, icon(12, ICONS.sub, ""), done + "/" + n);
}

const COMPONENT_SVG = '<path d="M7 1.75l4.75 2.6v5.3L7 12.25l-4.75-2.6v-5.3z M2.5 4.4L7 6.9l4.5-2.5M7 6.9v5.2" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>';

/** The icon for a group from issues.groupIssues (list group headers, board swimlanes). */
export function groupIcon(g) {
  if (g.status) return statusIcon(g.status);
  if ("assignee" in g) return avatar(g.assignee);
  if ("priority" in g) return prioIcon(g.priority);
  if ("component" in g) return icon(14, COMPONENT_SVG, "gcomp");
  return null;
}

// The app's mark: a ticket with a face (24-unit grid; the body takes currentColor). The
// detail panel's loader animates the same drawing, so `.eye` classes are part of the API.
const LOGO = '<path fill="currentColor" d="M6 3.5h12a5 5 0 0 1 5 5V11a2.4 2.4 0 0 0 0 4.8v.7a5 5 0 0 1-5 5H6a5 5 0 0 1-5-5v-.7A2.4 2.4 0 0 0 1 11V8.5a5 5 0 0 1 5-5z"/>' +
  '<g fill="#ff8fab" opacity=".6"><circle cx="6.5" cy="16.6" r="1.8"/><circle cx="17.5" cy="16.6" r="1.8"/></g>' +
  '<g fill="#fff"><rect class="eye" x="7.2" y="8.6" width="3" height="4.4" rx="1.5"/><rect class="eye" x="13.8" y="8.6" width="3" height="4.4" rx="1.5"/></g>' +
  '<path d="M9.7 14.6a2.3 2.1 0 0 0 4.6 0" fill="none" stroke="#fff" stroke-width="1.4" stroke-linecap="round"/>';

/** The jira-lite logo at `size` px (sidebar 20, sign-in 40); `cls` adds classes after "logo". */
export function logo(size, cls = "") {
  const s = icon(24, LOGO, ("logo " + cls).trim());
  s.setAttribute("width", size);
  s.setAttribute("height", size);
  return s;
}

/** Sidebar navigation glyphs (16px). */
export const NAV_ICONS = {
  mine: '<circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="8" cy="8" r="2.25" fill="currentColor"/>',
  all: '<rect x="2" y="2" width="9" height="9" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M5.5 14h6a2.5 2.5 0 0 0 2.5-2.5v-6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
};
