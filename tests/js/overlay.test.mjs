import { test } from "node:test";
import assert from "node:assert/strict";
import { createOverlay, stamp, TTL_MS } from "../../web/js/overlay.js";

const iss = (key, updated, extra = {}) => ({ key, fields: { summary: key, updated, ...extra } });
const T0 = "2026-10-26T10:00:00.000+0800";
const T1 = "2026-10-26T10:00:05.000+0800";
const all = () => true;

const clock = () => {
  const c = { t: 1000, now: () => c.t };
  return c;
};

test("stamp: Jira offsets without a colon, invalid input", () => {
  assert.equal(stamp(T0), Date.parse("2026-10-26T02:00:00.000Z"));
  assert.equal(stamp("2026-10-26T10:00:00.000-0130"), Date.parse("2026-10-26T11:30:00.000Z"));
  assert.ok(Number.isNaN(stamp(undefined)));
  assert.ok(Number.isNaN(stamp("nope")));
});

test("apply: empty overlay returns the list itself", () => {
  const o = createOverlay();
  const list = [iss("A-1", T0)];
  assert.equal(o.apply(list, all), list);
});

test("apply: a stale search copy is replaced by the fresher written one", () => {
  const o = createOverlay();
  const fresh = iss("A-1", T1, { status: "Done" });
  o.put(fresh);
  const out = o.apply([iss("A-2", T0), iss("A-1", T0)], all);
  assert.deepEqual(out.map((i) => i.key), ["A-2", "A-1"]);
  assert.equal(out[1], fresh);
  assert.equal(o.size, 1);  // still waiting for the index
});

test("apply: once the index has caught up, the entry retires and search wins", () => {
  const o = createOverlay();
  o.put(iss("A-1", T0));
  const caught = iss("A-1", T0);
  const list = [caught];
  assert.equal(o.apply(list, all), list);
  assert.equal(o.size, 0);
  // ...and a newer edit from someone else is never shadowed.
  o.put(iss("A-1", T0));
  const newer = iss("A-1", T1);
  assert.equal(o.apply([newer], all)[0], newer);
});

test("apply: a written issue that no longer belongs in the view is removed", () => {
  const o = createOverlay();
  o.put(iss("A-1", T1, { assignee: "bob" }));
  const out = o.apply([iss("A-1", T0, { assignee: "me" }), iss("A-2", T0)], (i) => i.fields.assignee !== "bob");
  assert.deepEqual(out.map((i) => i.key), ["A-2"]);
});

test("apply: a created issue missing from search is added in front when it matches; add:false skips it", () => {
  const o = createOverlay();
  const created = iss("A-9", T1, { parent: { key: "A-1" } });
  o.put(created);
  o.put(iss("A-8", T1, { parent: { key: "A-5" } }));
  const kids = (i) => !!i.fields.parent && i.fields.parent.key === "A-1";
  assert.deepEqual(o.apply([iss("A-3", T0, { parent: { key: "A-1" } })], kids).map((i) => i.key), ["A-9", "A-3"]);
  const list = [iss("A-3", T0)];
  assert.equal(o.apply(list, all, { add: false }), list);
});

test("drop: a deleted issue disappears from search results and is not re-added", () => {
  const o = createOverlay();
  o.drop("A-1");
  assert.deepEqual(o.apply([iss("A-1", T1), iss("A-2", T0)], all).map((i) => i.key), ["A-2"]);
  assert.equal(o.get("A-1"), null);
  assert.equal(o.get("A-2"), undefined);
});

test("entries expire after the TTL", () => {
  const c = clock();
  const o = createOverlay({ now: c.now });
  o.put(iss("A-1", T1));
  c.t += TTL_MS + 1;
  const list = [iss("A-1", T0)];
  assert.equal(o.apply(list, all), list);
  assert.equal(o.size, 0);
});

test("put of a newer write replaces the older one", () => {
  const o = createOverlay();
  o.put(iss("A-1", T0, { summary: "first" }));
  o.put(iss("A-1", T1, { summary: "second" }));
  assert.equal(o.apply([iss("A-1", "2026-10-26T09:00:00.000+0800")], all)[0].fields.summary, "second");
});

test("apply: same `updated` but different values (a parent's new sub-task) keeps ours; equal values retire", () => {
  const o = createOverlay();
  const ours = iss("A-1", T0, { subtasks: [{ key: "A-2" }, { key: "A-3" }] });
  o.put(ours);
  assert.equal(o.apply([iss("A-1", T0, { subtasks: [{ key: "A-2" }] })], all)[0], ours);
  // A narrower search (fewer fields) that agrees on what it has: caught up.
  const narrow = { key: "A-1", fields: { updated: T0, summary: "A-1" } };
  assert.equal(o.apply([narrow], all)[0], narrow);
  assert.equal(o.size, 0);
});

test("missing / update: what apply would add can be re-read first; a stale copy then stays out", () => {
  const c = clock();
  const o = createOverlay({ now: c.now });
  o.put(iss("A-1", T0, { assignee: "me" }));
  o.put(iss("A-2", T0, { assignee: "me" }));
  const mine = (i) => i.fields.assignee === "me";
  assert.deepEqual(o.missing([iss("A-2", T0, { assignee: "me" })], mine), ["A-1"]);
  // Re-read by key: a colleague unassigned it since our write, so it no longer belongs.
  c.t += 1000;
  o.update(iss("A-1", T1, { assignee: "bob" }));
  assert.deepEqual(o.apply([], mine).map((i) => i.key), ["A-2"]);
  o.update(iss("A-9", T1));  // not remembered: ignored
  assert.equal(o.get("A-9"), undefined);
  c.t += TTL_MS;  // update kept the age: still expires
  assert.equal(o.size, 0);
});
