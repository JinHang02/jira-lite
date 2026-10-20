import { test } from "node:test";
import assert from "node:assert/strict";
import { ago, shortDate } from "../../web/js/format.js";

const NOW = Date.parse("2026-06-15T12:00:00Z");
const before = (sec) => new Date(NOW - sec * 1000).toISOString();

test("ago: relative buckets", () => {
  assert.equal(ago(before(0), NOW), "just now");
  assert.equal(ago(before(59), NOW), "just now");
  assert.equal(ago(before(60), NOW), "1m ago");
  assert.equal(ago(before(3599), NOW), "59m ago");
  assert.equal(ago(before(3600), NOW), "1h ago");
  assert.equal(ago(before(86399), NOW), "23h ago");
  assert.equal(ago(before(86400), NOW), "1d ago");
  assert.equal(ago(before(86400 * 29), NOW), "29d ago");
});

test("ago: older than 30 days falls back to shortDate", () => {
  const iso = before(86400 * 40);
  assert.equal(ago(iso, NOW), shortDate(iso, new Date(NOW)));
});

test("shortDate omits the year within the current year", () => {
  const iso = "2026-03-04T12:00:00Z";
  assert.equal(shortDate(iso, new Date(NOW)), new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" }));
});

test("shortDate adds a 2-digit year for other years", () => {
  const iso = "2024-03-04T12:00:00Z";
  const out = shortDate(iso, new Date(NOW));
  assert.equal(out, new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "2-digit" }));
  assert.match(out, /24/);
});
