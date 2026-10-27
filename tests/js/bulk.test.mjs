import { test } from "node:test";
import assert from "node:assert/strict";
import {
  toggleKey, range, extendRange, orderedSelection, pruneSelection, unionTargets, statusPlan, priorityPlan,
  assigneePlan, labelsPlan, listOps, knownLabels, runPool, statusSummary, fieldSummary, firstError,
} from "../../web/js/bulk.js";

const st = (id, name, cat) => ({ id, name, statusCategory: { key: cat } });
const TODO = st("1", "To Do", "new"), PROG = st("3", "In Progress", "indeterminate"), REVIEW = st("4", "In Review", "indeterminate");
const DONE = st("5", "Done", "done"), BACKLOG = st("0", "Backlog", "new"), CANCEL = st("6", "Canceled", "done");
const issue = (key, status, extra = {}) => ({ key, fields: { status, labels: [], priority: null, assignee: null, ...extra } });
const tr = (id, to, name = to.name) => ({ id, name, to });

test("toggleKey adds and removes without mutating", () => {
  const a = new Set(["A"]);
  assert.deepEqual([...toggleKey(a, "B")], ["A", "B"]);
  assert.deepEqual([...toggleKey(a, "A")], []);
  assert.deepEqual([...a], ["A"]);
});

test("range and extendRange follow display order in both directions", () => {
  const vis = ["A", "B", "C", "D", "E"];
  assert.deepEqual(range(vis, "B", "D"), ["B", "C", "D"]);
  assert.deepEqual(range(vis, "D", "B"), ["B", "C", "D"]);
  assert.deepEqual(range(vis, "X", "C"), ["C"]);
  assert.deepEqual(range(vis, "A", "X"), []);
  assert.deepEqual([...extendRange(new Set(["E"]), vis, "A", "B")].sort(), ["A", "B", "E"]);
});

test("orderedSelection and pruneSelection", () => {
  const sel = new Set(["C", "A", "Z"]);
  assert.deepEqual(orderedSelection(sel, ["A", "B", "C"]), ["A", "C"]);
  assert.deepEqual([...pruneSelection(sel, ["A", "C"])], ["C", "A"]);
  const same = new Set(["A"]);
  assert.equal(pruneSelection(same, ["A", "B"]), same);
});

test("unionTargets: every reachable status once, with how many issues can reach it, in board order", () => {
  const issues = [issue("K-1", TODO), issue("K-2", PROG), issue("K-3", TODO), issue("K-4", PROG)];
  const t = new Map([
    ["K-1", [tr("11", BACKLOG), tr("31", PROG), tr("71", CANCEL)]],
    ["K-2", [tr("21", TODO), tr("41", REVIEW), tr("41b", REVIEW, "Again")]],
    ["K-3", [tr("31", PROG), tr("99", TODO)]],  // a looped transition to its own status is ignored
    // K-4: the lookup failed
  ]);
  const u = unionTargets(issues, t);
  assert.deepEqual(u.map((x) => [x.status.name, x.count]),
    [["Backlog", 1], ["To Do", 1], ["In Progress", 2], ["In Review", 1], ["Canceled", 1]]);
});

test("statusPlan sorts issues into moves, already there, can't move and unknown", () => {
  const issues = [issue("K-1", TODO), issue("K-2", REVIEW), issue("K-3", DONE), issue("K-4", TODO), issue("K-5", PROG)];
  const t = new Map([["K-1", [tr("31", PROG)]], ["K-2", [tr("61", DONE)]], ["K-3", [tr("81", PROG)]], ["K-4", [tr("31", PROG)]]]);
  assert.deepEqual(statusPlan(issues, t, "5"), { moves: [{ key: "K-2", transitionId: "61" }], already: ["K-3"], cannot: ["K-1", "K-4"], unknown: ["K-5"] });
  assert.deepEqual(statusPlan(issues, t, 3).moves.map((m) => m.key), ["K-1", "K-3", "K-4"]);
});

test("priorityPlan and assigneePlan skip issues that already have the value", () => {
  const issues = [issue("K-1", TODO, { priority: { id: "2", name: "High" } }), issue("K-2", TODO), issue("K-3", TODO, { priority: { id: "3" } })];
  assert.deepEqual(priorityPlan(issues, "2"), [{ key: "K-2", fields: { priority: { id: "2" } } }, { key: "K-3", fields: { priority: { id: "2" } } }]);
  const people = [issue("K-1", TODO, { assignee: { accountId: "a" } }), issue("K-2", TODO)];
  assert.deepEqual(assigneePlan(people, "a"), [{ key: "K-2", accountId: "a" }]);
  assert.deepEqual(assigneePlan(people, null), [{ key: "K-1", accountId: null }]);
});

test("labelsPlan adds only missing labels (add verbs) and skips issues that have them all", () => {
  const issues = [issue("K-1", TODO, { labels: ["ux", "web"] }), issue("K-2", TODO, { labels: ["urgent"] }), issue("K-3", TODO)];
  assert.deepEqual(labelsPlan(issues, ["urgent", "urgent", "ux"]), [
    { key: "K-1", update: { labels: [{ add: "urgent" }] } },
    { key: "K-2", update: { labels: [{ add: "ux" }] } },
    { key: "K-3", update: { labels: [{ add: "urgent" }, { add: "ux" }] } },
  ]);
  assert.deepEqual(labelsPlan(issues, []), []);
});

test("listOps: adds then removes, by id for objects; nothing changed → []", () => {
  assert.deepEqual(listOps(["a", "b"], ["b", "c"]), [{ add: "c" }, { remove: "a" }]);
  assert.deepEqual(listOps([{ id: "1" }], [{ id: "1" }, { id: "2" }]), [{ add: { id: "2" } }]);
  assert.deepEqual(listOps([{ id: "1" }], [{ id: 1 }]), []);
  assert.deepEqual(listOps(undefined, []), []);
});

test("knownLabels ranks by frequency, then name", () => {
  const issues = [issue("A", TODO, { labels: ["b", "a"] }), issue("B", TODO, { labels: ["b", "c"] }), issue("C", TODO, { labels: undefined })];
  assert.deepEqual(knownLabels(issues), ["b", "a", "c"]);
});

test("runPool keeps at most `limit` in flight, keeps order and never rejects", async () => {
  let live = 0, peak = 0;
  const items = [1, 2, 3, 4, 5, 6, 7, 8, 9];
  const out = await runPool(items, 4, async (n) => {
    live++; peak = Math.max(peak, live);
    await new Promise((r) => setTimeout(r, (n % 3) * 3));
    live--;
    if (n === 5) throw new Error("boom");
    return n * 10;
  });
  assert.equal(peak, 4);
  assert.deepEqual(out.map((r) => r.ok ? r.value : r.error.message), [10, 20, 30, 40, "boom", 60, 70, 80, 90]);
  assert.deepEqual(await runPool([], 4, async () => 1), []);
  assert.equal(firstError(out, (n) => "K-" + n), "K-5: boom");
  assert.equal(firstError([{ item: "K-1", ok: true }]), "");
});

test("statusSummary", () => {
  assert.equal(statusSummary({ moved: 5, cannot: 1 }, "Done"), "Moved 5 · 1 can't move to Done");
  assert.equal(statusSummary({ moved: 3 }, "Done"), "Moved 3 to Done");
  assert.equal(statusSummary({ moved: 2, already: 1, failed: 1 }, "In Progress"), "Moved 2 to In Progress · 1 already in In Progress · 1 failed");
  assert.equal(statusSummary({ cannot: 2 }, "Done"), "2 can't move to Done");
  assert.equal(statusSummary({}, "Done"), "Nothing to change");
});

test("fieldSummary", () => {
  assert.equal(fieldSummary("Priority → High", { changed: 4, skipped: 1 }), "Priority → High on 4 issues · 1 already");
  assert.equal(fieldSummary("Added urgent", { changed: 1, failed: 2 }), "Added urgent on 1 issue · 2 failed");
  assert.equal(fieldSummary("x", { skipped: 3 }), "3 already");
});
