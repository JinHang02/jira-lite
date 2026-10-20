// Pure date formatting. `now` is injectable so the output is deterministic in tests.

/** "just now", "5m ago", "3h ago", "2d ago", or a short date after 30 days. */
export function ago(iso, now = Date.now()) {
  const s = (now - new Date(iso)) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  if (s < 86400) return Math.floor(s / 3600) + "h ago";
  if (s < 86400 * 30) return Math.floor(s / 86400) + "d ago";
  return shortDate(iso, new Date(now));
}

/** "Mar 4", or "Mar 4, 24" when not in the current year (locale-dependent). */
export function shortDate(iso, now = new Date()) {
  const d = new Date(iso);
  const opts = { month: "short", day: "numeric" };
  if (d.getFullYear() !== new Date(now).getFullYear()) opts.year = "2-digit";
  return d.toLocaleDateString(undefined, opts);
}
