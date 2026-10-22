import { test } from "node:test";
import assert from "node:assert/strict";
import { FIT, zoomTo, clampView } from "../../web/js/zoom.js";

test("zoomTo: keeps the point under the cursor still", () => {
  const v = zoomTo(FIT, 2, 50, -20, 8);
  assert.deepEqual(v, { s: 2, x: -50, y: 20 });
  // the image point under (50, -20) was (50, -20) before; now it is x + s*q = -50 + 2*50 = 50
  assert.equal(v.x + v.s * 50, 50);
  assert.equal(v.y + v.s * -20, -20);
});

test("zoomTo: scale stays within 1..max", () => {
  assert.equal(zoomTo(FIT, 0.2, 0, 0, 8).s, 1);
  assert.equal(zoomTo(FIT, 50, 0, 0, 8).s, 8);
  assert.deepEqual(zoomTo({ s: 4, x: 30, y: 10 }, 1, 0, 0, 8), { s: 1, x: 7.5, y: 2.5 });
});

test("clampView: no panning past the edges, centred where it fits", () => {
  // 400x100 fitted, 2x → 800x200 in a 600x300 stage: 100px of slack each side in x, none in y
  assert.deepEqual(clampView({ s: 2, x: 500, y: 40 }, 400, 100, 600, 300), { s: 2, x: 100, y: 0 });
  assert.deepEqual(clampView({ s: 2, x: -500, y: -40 }, 400, 100, 600, 300), { s: 2, x: -100, y: 0 });
  assert.deepEqual(clampView({ s: 2, x: 20, y: 0 }, 400, 100, 600, 300), { s: 2, x: 20, y: 0 });
  assert.deepEqual(clampView({ s: 1, x: 7.5, y: 2.5 }, 400, 100, 600, 300), { s: 1, x: 0, y: 0 });
});
