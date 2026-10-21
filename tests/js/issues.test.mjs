import { test } from "node:test";
import assert from "node:assert/strict";
import { matches, filterIssues, progress } from "../../web/js/issues.js";

const iss = (key, summary, assignee) => ({ key, fields: { summary, assignee: assignee ? { displayName: assignee } : null } });
const LIST = [iss("BA-1", "Fix login", "Ada Lovelace"), iss("BA-22", "Write docs", null), iss("BA-3", "Deploy", "Alan Turing")];

test("matches key, summary and assignee", () => {
  assert.equal(matches(LIST[0], "ba-1"), true);
  assert.equal(matches(LIST[0], "login"), true);
  assert.equal(matches(LIST[0], "ada"), true);
  assert.equal(matches(LIST[1], "ada"), false);
  assert.equal(matches(LIST[2], "nothing"), false);
});

test("filterIssues trims and lower-cases; blank returns all", () => {
  assert.equal(filterIssues(LIST, ""), LIST);
  assert.equal(filterIssues(LIST, "   "), LIST);
  assert.deepEqual(filterIssues(LIST, " DOCS ").map((i) => i.key), ["BA-22"]);
  assert.deepEqual(filterIssues(LIST, "ba-").map((i) => i.key), ["BA-1", "BA-22", "BA-3"]);
});

test("progress counts done sub-issues", () => {
  const sub = (cat) => ({ fields: { status: { statusCategory: { key: cat } } } });
  assert.deepEqual(progress([sub("done"), sub("new"), sub("done"), {}]), { done: 2, total: 4 });
  assert.deepEqual(progress(undefined), { done: 0, total: 0 });
});

test("delete: withoutIssue drops the issue and its sub-tasks; warning and typed check", async () => {
  const { withoutIssue, deleteWarning, deleteTyped } = await import("../../web/js/issues.js");
  const mk = (key, parent, subtask = false) => ({ key, fields: { parent: parent ? { key: parent } : undefined, issuetype: { subtask } } });
  const list = [mk("A-1"), mk("A-2", "A-1", true), mk("A-3", "A-1"), mk("A-4")];
  assert.deepEqual(withoutIssue(list, "A-1").map((i) => i.key), ["A-3", "A-4"]);
  assert.equal(deleteWarning().length, 1);
  assert.deepEqual(deleteWarning({ subtasks: 2, children: 1 }).slice(1), ["Its 2 sub-tasks will be deleted too.", "1 child issue will lose its parent but won't be deleted."]);
  assert.equal(deleteTyped(" Delete "), true);
  assert.equal(deleteTyped("delet"), false);
  assert.equal(deleteTyped("delete it"), false);
});

test("childProgress: an epic's child issues from the sidebar counts, else sub-tasks", async () => {
  const { childProgress } = await import("../../web/js/issues.js");
  const done = { statusCategory: { key: "done" } }, todo = { statusCategory: { key: "new" } };
  const task = { key: "A-2", fields: { subtasks: [{ fields: { status: done } }, { fields: { status: todo } }] } };
  assert.deepEqual(childProgress(task, []), { done: 1, total: 2, epic: false });
  const epic = { key: "A-1", fields: { subtasks: [] } };
  assert.deepEqual(childProgress(epic, [{ key: "A-1", done: 3, total: 8 }]), { done: 3, total: 8, epic: true });
  assert.deepEqual(childProgress(epic, [{ key: "A-1", done: 0, total: 0 }]), { done: 0, total: 0, epic: false });
  assert.equal(childProgress({ key: "A-3", fields: {} }, undefined).total, 0);
});
