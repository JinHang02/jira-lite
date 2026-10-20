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
