import { test } from "node:test";
import assert from "node:assert/strict";
import { buildJql, searchJql, childrenJql } from "../../web/js/jql.js";

test("buildJql: my open issues", () => {
  assert.equal(buildJql({ project: "BA", who: "mine", showDone: false }),
    'project = "BA" AND assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC');
});

test("buildJql: all issues including done", () => {
  assert.equal(buildJql({ project: "BA", who: "all", showDone: true }), 'project = "BA" ORDER BY updated DESC');
});

test("buildJql: a person's issues", () => {
  assert.equal(buildJql({ project: "BA", who: "712020:abc-def", showDone: false }),
    'project = "BA" AND assignee = "712020:abc-def" AND statusCategory != Done ORDER BY updated DESC');
  assert.equal(buildJql({ project: "XY", who: "abc", showDone: true }), 'project = "XY" AND assignee = "abc" ORDER BY updated DESC');
});

test("buildJql ignores unknown keys such as a stale sprint", () => {
  assert.equal(buildJql({ project: "BA", who: "all", showDone: true, sprint: "12" }), 'project = "BA" ORDER BY updated DESC');
});

test("searchJql builds a prefix text search", () => {
  assert.equal(searchJql("BA", "  login bug "), 'project = "BA" AND text ~ "login bug*" ORDER BY updated DESC');
});

test("searchJql drops quotes and backslashes", () => {
  assert.equal(searchJql("BA", 'say "hi"'), 'project = "BA" AND text ~ "say  hi*" ORDER BY updated DESC');
  assert.equal(searchJql("BA", "a\\b"), 'project = "BA" AND text ~ "a b*" ORDER BY updated DESC');
  assert.equal(searchJql("BA", '"\\'), 'project = "BA" AND text ~ "*" ORDER BY updated DESC');
});

test("childrenJql", () => {
  assert.equal(childrenJql("BA-7"), 'parent = "BA-7" ORDER BY created ASC');
});
