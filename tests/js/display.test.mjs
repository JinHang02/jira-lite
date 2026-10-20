import { test } from "node:test";
import assert from "node:assert/strict";
import { sortIssues, groupIssues, dueInfo, labelHue, isDone, GROUPINGS, ORDERINGS } from "../../web/js/issues.js";

const ST = {
  prog: { id: "3", name: "In Progress", statusCategory: { key: "indeterminate" } },
  todo: { id: "1", name: "To Do", statusCategory: { key: "new" } },
  done: { id: "7", name: "Done", statusCategory: { key: "done" } },
};
const P = (name) => (name ? { id: name, name } : null);
const U = (id, name) => ({ accountId: id, displayName: name });
const iss = (key, { status = ST.todo, priority = null, assignee = null, updated, created } = {}) =>
  ({ key, fields: { summary: key, status, priority, assignee, updated, created } });
const keys = (list) => list.map((i) => i.key);

test("option lists", () => {
  assert.deepEqual(GROUPINGS, ["status", "assignee", "priority", "none"]);
  assert.deepEqual(ORDERINGS, ["updated", "priority", "created"]);
});

test("sortIssues by updated / created: newest first, missing dates last, input untouched", () => {
  const list = [
    iss("A", { updated: "2026-10-01T10:00:00.000+0800", created: "2026-01-03T00:00:00.000+0800" }),
    iss("B", { updated: "2026-10-03T10:00:00.000+0800" }),
    iss("C", { updated: "2026-10-02T10:00:00.000+0800", created: "2026-01-05T00:00:00.000+0800" }),
  ];
  assert.deepEqual(keys(sortIssues(list, "updated")), ["B", "C", "A"]);
  assert.deepEqual(keys(sortIssues(list, "created")), ["C", "A", "B"]);
  assert.deepEqual(keys(list), ["A", "B", "C"]);
  assert.notEqual(sortIssues(list, "updated"), list);
  assert.deepEqual(keys(sortIssues(list, "bogus")), ["A", "B", "C"]);
});

test("sortIssues by priority: most urgent first, then most recently updated", () => {
  const list = [
    iss("low", { priority: P("Low"), updated: "2026-10-05T00:00:00Z" }),
    iss("none", { updated: "2026-10-09T00:00:00Z" }),
    iss("high-old", { priority: P("High"), updated: "2026-10-01T00:00:00Z" }),
    iss("highest", { priority: P("Highest"), updated: "2026-10-02T00:00:00Z" }),
    iss("high-new", { priority: P("High"), updated: "2026-10-04T00:00:00Z" }),
  ];
  assert.deepEqual(keys(sortIssues(list, "priority")), ["highest", "high-new", "high-old", "low", "none"]);
});

test("groupIssues by status: KIND_ORDER, keyed by status name, order kept", () => {
  const list = [iss("1", { status: ST.todo }), iss("2", { status: ST.prog }), iss("3", { status: ST.todo }), iss("4", { status: ST.done })];
  const g = groupIssues(list, "status");
  assert.deepEqual(g.map((x) => x.key), ["In Progress", "To Do", "Done"]);
  assert.deepEqual(g.map((x) => x.label), ["In Progress", "To Do", "Done"]);
  assert.equal(g[0].status, ST.prog);
  assert.deepEqual(keys(g[1].items), ["1", "3"]);
});

test("groupIssues by assignee: by name, Unassigned last", () => {
  const zoe = U("z", "Zoe"), ada = U("a", "Ada");
  const list = [iss("1"), iss("2", { assignee: zoe }), iss("3", { assignee: ada }), iss("4", { assignee: zoe })];
  const g = groupIssues(list, "assignee");
  assert.deepEqual(g.map((x) => x.label), ["Ada", "Zoe", "Unassigned"]);
  assert.deepEqual(g.map((x) => x.key), ["assignee:a", "assignee:z", "assignee:"]);
  assert.deepEqual(keys(g[1].items), ["2", "4"]);
  assert.equal(g[2].assignee, null);
});

test("groupIssues by priority: Highest..Lowest, then No priority", () => {
  const names = ["Low", null, "Highest", "Medium", "Lowest", "High"];
  const list = names.map((n, k) => iss(String(k), { priority: P(n) }));
  const g = groupIssues(list, "priority");
  assert.deepEqual(g.map((x) => x.label), ["Highest", "High", "Medium", "Low", "Lowest", "No priority"]);
  assert.equal(g[5].key, "priority:");
});

test("groupIssues by priority: unrecognised names sort before No priority", () => {
  const g = groupIssues([iss("1"), iss("2", { priority: P("Whenever") }), iss("3", { priority: P("High") })], "priority");
  assert.deepEqual(g.map((x) => x.label), ["High", "Whenever", "No priority"]);
});

test("groupIssues none: one headerless group, or nothing", () => {
  const list = [iss("1"), iss("2")];
  assert.deepEqual(groupIssues(list, "none"), [{ key: "", label: "", items: list }]);
  assert.deepEqual(groupIssues([], "none"), []);
  assert.deepEqual(groupIssues([], "status"), []);
});

test("dueInfo: levels and names relative to the local day", () => {
  const now = new Date(2026, 9, 20, 15, 30).getTime();  // Oct 20 2026, afternoon
  assert.equal(dueInfo(null, { now }), null);
  assert.equal(dueInfo("", { now }), null);
  assert.deepEqual(dueInfo("2026-10-20", { now }), { label: "Today", level: "soon", days: 0 });
  assert.deepEqual(dueInfo("2026-10-21", { now }), { label: "Tomorrow", level: "soon", days: 1 });
  assert.deepEqual(dueInfo("2026-10-19", { now }), { label: "Yesterday", level: "overdue", days: -1 });
  assert.equal(dueInfo("2026-10-22", { now }).level, "soon");
  assert.equal(dueInfo("2026-10-23", { now }).level, "");
  assert.equal(dueInfo("2026-09-01", { now }).level, "overdue");
  assert.equal(dueInfo("2026-09-01", { now, done: true }).level, "");
  assert.equal(dueInfo("2026-11-05", { now }).days, 16);
  assert.ok(dueInfo("2026-11-05", { now }).label.length > 0);
});

test("labelHue is stable and in range", () => {
  assert.equal(labelHue("backend"), labelHue("backend"));
  for (const n of ["a", "frontend", "AIDC", ""]) assert.ok(labelHue(n) >= 0 && labelHue(n) < 360);
});

test("isDone reads the status category", () => {
  assert.equal(isDone(iss("1", { status: ST.done })), true);
  assert.equal(isDone(iss("1", { status: ST.prog })), false);
  assert.equal(isDone({}), false);
});
