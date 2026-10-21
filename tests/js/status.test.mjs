import { test } from "node:test";
import assert from "node:assert/strict";
import {
  KIND_ORDER, BOARD_ORDER, statusKind, statusRank, compareStatuses, uniqueStatuses, groupByStatus, boardColumns, prioKind, PRIO_LEVELS,
} from "../../web/js/status.js";

const st = (id, name, cat) => ({ id: String(id), name, statusCategory: { key: cat } });
// The BA project's statuses (category keys as Jira reports them).
const BACKLOG = st(1, "Backlog", "new");
const TODO = st(2, "To Do", "new");
const PROGRESS = st(3, "In Progress", "indeterminate");
const BLOCKED = st(4, "Blocked", "indeterminate");
const REVIEW = st(5, "In Review", "indeterminate");
const TESTING = st(6, "Testing", "indeterminate");
const DONE = st(7, "Done", "done");
const WONTDO = st(8, "Won't Do", "done");
const issue = (key, status) => ({ key, fields: { status, summary: key } });

test("statusKind classifies by category and name", () => {
  assert.equal(statusKind(BACKLOG), "backlog");
  assert.equal(statusKind(st(9, "Icebox", "new")), "backlog");
  assert.equal(statusKind(TODO), "todo");
  assert.equal(statusKind(PROGRESS), "started");
  assert.equal(statusKind(BLOCKED), "blocked");
  assert.equal(statusKind(st(9, "On Hold", "indeterminate")), "blocked");
  assert.equal(statusKind(st(9, "Waiting for customer", "indeterminate")), "blocked");
  assert.equal(statusKind(REVIEW), "review");
  assert.equal(statusKind(TESTING), "review");
  assert.equal(statusKind(st(9, "QA", "indeterminate")), "review");
  assert.equal(statusKind(DONE), "done");
  assert.equal(statusKind(WONTDO), "canceled");
  assert.equal(statusKind(st(9, "Cancelled", "done")), "canceled");
  assert.equal(statusKind(st(9, "Duplicate", "done")), "canceled");
  assert.equal(statusKind({ name: "Whatever" }), "todo");
  assert.equal(statusKind(null), "todo");
});

test("statusRank follows the given order", () => {
  assert.deepEqual(KIND_ORDER, ["started", "review", "blocked", "todo", "backlog", "done", "canceled"]);
  assert.deepEqual(BOARD_ORDER, ["backlog", "todo", "started", "blocked", "review", "done", "canceled"]);
  assert.equal(statusRank(PROGRESS), 0);
  assert.equal(statusRank(WONTDO), 6);
  assert.equal(statusRank(BACKLOG, BOARD_ORDER), 0);
  assert.equal(statusRank(REVIEW, BOARD_ORDER), 4);
});

test("compareStatuses breaks ties by name", () => {
  assert.ok(compareStatuses(REVIEW, TESTING, BOARD_ORDER) < 0);
  assert.ok(compareStatuses(TESTING, REVIEW, BOARD_ORDER) > 0);
  assert.ok(compareStatuses(DONE, BACKLOG, BOARD_ORDER) > 0);
  assert.ok(compareStatuses(DONE, BACKLOG, KIND_ORDER) > 0);
  assert.ok(compareStatuses(BACKLOG, TODO, KIND_ORDER) > 0);
});

test("uniqueStatuses de-duplicates the per-issue-type listing", () => {
  const resp = [
    { name: "Task", statuses: [TODO, PROGRESS, DONE] },
    { name: "Bug", statuses: [TODO, { ...PROGRESS, name: "dup" }, BLOCKED] },
    { name: "Empty" },
  ];
  assert.deepEqual(uniqueStatuses(resp).map((s) => s.name), ["To Do", "In Progress", "Done", "Blocked"]);
  assert.deepEqual(uniqueStatuses(null), []);
});

test("groupByStatus orders list groups in workflow order (like the board), then name", () => {
  const groups = groupByStatus([issue("A-1", DONE), issue("A-2", TESTING), issue("A-3", PROGRESS), issue("A-4", REVIEW),
    issue("A-5", BACKLOG), issue("A-6", PROGRESS), issue("A-7", TODO)]);
  assert.deepEqual(groups.map((g) => g.status.name), ["Backlog", "To Do", "In Progress", "In Review", "Testing", "Done"]);
  assert.deepEqual(groups[2].items.map((i) => i.key), ["A-3", "A-6"]);
});

test("boardColumns: one column per project status in BOARD_ORDER", () => {
  const statuses = [DONE, TESTING, TODO, REVIEW, BLOCKED, PROGRESS, BACKLOG];
  const cols = boardColumns(statuses, [issue("A-1", PROGRESS), issue("A-2", PROGRESS), issue("A-3", DONE)]);
  assert.deepEqual(cols.map((c) => c.status.name), ["Backlog", "To Do", "In Progress", "Blocked", "In Review", "Testing", "Done"]);
  assert.deepEqual(cols[2].items.map((i) => i.key), ["A-1", "A-2"]);
  assert.equal(cols[0].items.length, 0);
});

test("boardColumns adds statuses only seen on issues", () => {
  const other = st(99, "Deployed", "done");
  const cols = boardColumns([TODO], [issue("A-1", other), issue("A-2", TODO)]);
  assert.deepEqual(cols.map((c) => c.status.name), ["To Do", "Deployed"]);
  assert.deepEqual(boardColumns(null, [issue("A-1", TODO)]).map((c) => c.status.name), ["To Do"]);
});

test("boardColumns hides empty done/canceled columns when done is hidden", () => {
  const statuses = [TODO, DONE, WONTDO, PROGRESS];
  assert.deepEqual(boardColumns(statuses, [], { showDone: false }).map((c) => c.status.name), ["To Do", "In Progress"]);
  assert.deepEqual(boardColumns(statuses, [], { showDone: true }).map((c) => c.status.name), ["To Do", "In Progress", "Done", "Won't Do"]);
  // A done issue that is loaded anyway keeps its column.
  assert.deepEqual(boardColumns(statuses, [issue("A-1", DONE)], { showDone: false }).map((c) => c.status.name), ["To Do", "In Progress", "Done"]);
});

test("prioKind maps names to five levels plus none", () => {
  assert.deepEqual(PRIO_LEVELS, ["highest", "high", "medium", "low", "lowest", "none"]);
  const k = (name) => prioKind({ name });
  assert.equal(k("Highest"), "highest");
  assert.equal(k("Blocker"), "highest");
  assert.equal(k("Critical"), "highest");
  assert.equal(k("Urgent"), "highest");
  assert.equal(k("High"), "high");
  assert.equal(k("Major"), "high");
  assert.equal(k("Medium"), "medium");
  assert.equal(k("Normal"), "medium");
  assert.equal(k("Low"), "low");
  assert.equal(k("Minor"), "low");
  assert.equal(k("Lowest"), "lowest");
  assert.equal(k("Trivial"), "lowest");
  assert.equal(k("Something else"), "none");
  assert.equal(prioKind(null), "none");
  assert.equal(prioKind(undefined), "none");
});

test("boardLanes: each group split into the board's columns, in column order", async () => {
  const { boardLanes } = await import("../../web/js/status.js");
  const todo = { id: "1", name: "To Do" }, prog = { id: 3, name: "In Progress" };
  const i = (key, status) => ({ key, fields: { status } });
  const cols = [{ status: todo, items: [] }, { status: prog, items: [] }];
  const lanes = boardLanes(cols, [{ key: "a", label: "A", items: [i("1", prog), i("2", todo), i("3", { id: "3" })] }, { key: "b", label: "B", items: [] }]);
  assert.deepEqual(lanes.map((l) => l.cells.map((c) => c.items.map((x) => x.key))), [[["2"], ["1", "3"]], [[], []]]);
  assert.equal(lanes[0].label, "A");
  assert.equal(lanes[0].cells[1].status, prog);
});
