import { test } from "node:test";
import assert from "node:assert/strict";
import { epicsJql, epicChildrenJql, chunk, epicProgress, epicEntries, visibleEpics, ringDash, EPIC_SHOWN } from "../../web/js/epics.js";

test("epicsJql: the project's open epics, newest first", () => {
  assert.equal(epicsJql("BA"), 'project = "BA" AND issuetype = Epic AND statusCategory != Done ORDER BY updated DESC');
});

test("epicChildrenJql: one parent-in search", () => {
  assert.equal(epicChildrenJql(["BA-1", "BA-22"]), 'parent in ("BA-1", "BA-22")');
});

test("chunk", () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(chunk([], 2), []);
  assert.equal(chunk(Array.from({ length: 120 }, (_, i) => i)).length, 3);
});

const child = (parent, cat) => ({ key: "x", fields: { parent: { key: parent }, status: { statusCategory: { key: cat } } } });

test("epicProgress counts done-category children per epic", () => {
  const p = epicProgress(["E-1", "E-2", "E-3"], [
    child("E-1", "done"), child("E-1", "indeterminate"), child("E-1", "done"), child("E-2", "new"), child("Other", "done"), { key: "y", fields: {} },
  ]);
  assert.deepEqual(Object.fromEntries(p), { "E-1": { done: 2, total: 3 }, "E-2": { done: 0, total: 1 }, "E-3": { done: 0, total: 0 } });
});

test("epicEntries joins the epics with their progress; cut-off counts are marked `more`", () => {
  const epics = [{ key: "E-1", fields: { summary: "One", status: { name: "To Do" } } }, { key: "E-2", fields: {} }];
  const p = new Map([["E-1", { done: 1, total: 4 }]]);
  assert.deepEqual(epicEntries(epics, p), [
    { key: "E-1", summary: "One", status: { name: "To Do" }, done: 1, total: 4, more: false },
    { key: "E-2", summary: "E-2", status: null, done: 0, total: 0, more: false },
  ]);
  assert.deepEqual(epicEntries(epics, p, new Set(["E-1"])).map((e) => e.more), [true, false]);
});

test("visibleEpics: first N, plus the selected one; all on request", () => {
  const list = Array.from({ length: 12 }, (_, i) => ({ key: "E-" + i }));
  assert.equal(visibleEpics(list.slice(0, EPIC_SHOWN)).hidden, 0);
  const r = visibleEpics(list, { selected: "E-10" });
  assert.deepEqual(r.shown.map((e) => e.key), ["E-0", "E-1", "E-2", "E-3", "E-4", "E-5", "E-6", "E-7", "E-10"]);
  assert.equal(r.hidden, 3);
  assert.equal(visibleEpics(list, { selected: "E-2" }).shown.length, EPIC_SHOWN);
  assert.equal(visibleEpics(list, { showAll: true }).shown.length, 12);
});

test("ringDash", () => {
  assert.equal(ringDash(1, 4, 20), "5.00 20.00");
  assert.equal(ringDash(0, 0, 20), "0.00 20.00");
  assert.equal(ringDash(9, 4, 20), "20.00 20.00");
});
