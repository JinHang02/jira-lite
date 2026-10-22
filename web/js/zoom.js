// Zoom/pan math for the image viewer (viewer.js). A view is { s, x, y }: the scale over the
// fitted size and the image centre's offset from where it sits when fitted, in px.

export const FIT = Object.freeze({ s: 1, x: 0, y: 0 });

/** Scales to `s` (clamped to 1..max) keeping the point (mx, my), relative to the fitted image's centre, still. */
export function zoomTo(v, s, mx, my, max) {
  const n = Math.min(max, Math.max(1, s));
  const k = n / v.s;
  return { s: n, x: mx - (mx - v.x) * k, y: my - (my - v.y) * k };
}

/** Stops panning past the image's edges; an axis where the image fits the stage stays centred. */
export function clampView(v, fitW, fitH, stageW, stageH) {
  const ox = Math.max(0, (v.s * fitW - stageW) / 2), oy = Math.max(0, (v.s * fitH - stageH) / 2);
  return { s: v.s, x: ox && Math.min(ox, Math.max(-ox, v.x)), y: oy && Math.min(oy, Math.max(-oy, v.y)) };
}
