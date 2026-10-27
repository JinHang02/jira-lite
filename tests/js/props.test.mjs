import { test } from "node:test";
import assert from "node:assert/strict";
import { fieldText, localDay, dueState, parseLabels, requiredCustomFields, parentAllowed, epicTypeName, epicJql, filterEpics, pickKind, pickChoices, pickValue, canSet, canAddRemove, ancestry } from "../../web/js/props.js";

test("fieldText: options, versions, users, arrays, scalars", () => {
  assert.equal(fieldText(null), "");
  assert.equal(fieldText(""), "");
  assert.equal(fieldText("x"), "x");
  assert.equal(fieldText(3), "3");
  assert.equal(fieldText({ id: "1", value: "Acme" }), "Acme");
  assert.equal(fieldText({ id: "1", name: "Q4 2026" }), "Q4 2026");
  assert.equal(fieldText({ accountId: "a", displayName: "Alice" }), "Alice");
  assert.equal(fieldText({ value: "EU", child: { value: "Paris" } }), "EU / Paris");
  assert.equal(fieldText([{ name: "1.0" }, { name: "2.0" }, null]), "1.0, 2.0");
  assert.equal(fieldText([]), "");
});

test("localDay pads month and day", () => {
  assert.equal(localDay(new Date(2026, 0, 5, 23, 59)), "2026-01-05");
});

test("dueState: overdue, today, future, finished", () => {
  assert.equal(dueState("2026-10-19", "2026-10-20"), "overdue");
  assert.equal(dueState("2026-10-20", "2026-10-20"), "today");
  assert.equal(dueState("2026-10-21", "2026-10-20"), "");
  assert.equal(dueState("2026-10-19", "2026-10-20", true), "");
  assert.equal(dueState(null, "2026-10-20"), "");
});

test("parseLabels splits on commas and whitespace and de-duplicates", () => {
  assert.deepEqual(parseLabels("ui, backend  ui,,api\nx"), ["ui", "backend", "api", "x"]);
  assert.deepEqual(parseLabels("  "), []);
  assert.deepEqual(parseLabels(undefined), []);
});

test("requiredCustomFields picks required customfield_* entries only", () => {
  const meta = [
    { fieldId: "summary", name: "Summary", required: true },
    { fieldId: "fixVersions", name: "Fix versions", required: true },
    { fieldId: "customfield_10034", name: "Client", required: true },
    { fieldId: "customfield_10015", name: "Start date", required: false },
  ];
  assert.deepEqual(requiredCustomFields(meta), [{ id: "customfield_10034", name: "Client" }]);
  assert.deepEqual(requiredCustomFields(null), []);
});

test("parentAllowed: standard types only (not epics, not sub-tasks)", () => {
  assert.equal(parentAllowed({ name: "New Feature", hierarchyLevel: 0 }), true);
  assert.equal(parentAllowed({ name: "Epic", hierarchyLevel: 1 }), false);
  assert.equal(parentAllowed({ name: "Initiative", hierarchyLevel: 2 }), false);
  assert.equal(parentAllowed({ name: "Sub-task", subtask: true, hierarchyLevel: -1 }), false);
  assert.equal(parentAllowed({ name: "Epic" }), false);
  assert.equal(parentAllowed({ name: "Task" }), true);
  assert.equal(parentAllowed(null), false);
});

test("epicTypeName: the level-1 type, else Epic", () => {
  assert.equal(epicTypeName([{ name: "Task", hierarchyLevel: 0 }, { name: "Feature Set", hierarchyLevel: 1 }]), "Feature Set");
  assert.equal(epicTypeName([]), "Epic");
  assert.equal(epicTypeName(undefined), "Epic");
});

test("epicJql: open epics, key lookup or summary prefix search", () => {
  const base = 'project = "BA" AND issuetype = "Epic" AND statusCategory != Done';
  assert.equal(epicJql("BA"), base + " ORDER BY updated DESC");
  assert.equal(epicJql("BA", "  onboarding rev "), base + ' AND summary ~ "onboarding rev*" ORDER BY updated DESC');
  assert.equal(epicJql("BA", "ba-12"), base + ' AND key = "BA-12" ORDER BY updated DESC');
  assert.equal(epicJql("BA", 'a "b" (c) \\ d:e'), base + ' AND summary ~ "a b c d e*" ORDER BY updated DESC');
  assert.equal(epicJql("BA", '"*?'), base + " ORDER BY updated DESC");
  assert.equal(epicJql("BA", "x", 'My "Epic"'), 'project = "BA" AND issuetype = "My  Epic " AND statusCategory != Done AND summary ~ "x*" ORDER BY updated DESC');
});

test("filterEpics by key or summary", () => {
  const epics = [{ key: "BA-1", fields: { summary: "Onboarding revamp" } }, { key: "BA-22", fields: { summary: "Billing" } }];
  assert.deepEqual(filterEpics(epics, "bill").map((e) => e.key), ["BA-22"]);
  assert.deepEqual(filterEpics(epics, "ba-1").map((e) => e.key), ["BA-1"]);
  assert.equal(filterEpics(epics, "").length, 2);
  assert.deepEqual(filterEpics(null, "x"), []);
});

test("pickKind: pick lists from editmeta schemas", () => {
  const meta = (schema, ops = ["set"]) => ({ schema, operations: ops, allowedValues: [] });
  assert.equal(pickKind(meta({ type: "option" })), "one");
  assert.equal(pickKind(meta({ type: "array", items: "version" })), "many");
  assert.equal(pickKind(meta({ type: "array", items: "component" })), "many");
  assert.equal(pickKind(meta({ type: "array", items: "option" })), "many");
  assert.equal(pickKind(meta({ type: "array", items: "string" })), null);
  assert.equal(pickKind(meta({ type: "option" }, ["add"])), null);
  assert.equal(pickKind({ schema: { type: "option" }, operations: ["set"] }), null);
  assert.equal(pickKind(undefined), null);
});

test("pickChoices hides archived/disabled values unless set; pickValue shapes the PUT", () => {
  const meta = { allowedValues: [{ id: "1", name: "a" }, { id: "2", name: "old", archived: true }, { id: 3, value: "x", disabled: true }] };
  assert.deepEqual(pickChoices(meta, []).map((v) => v.id), ["1"]);
  assert.deepEqual(pickChoices(meta, [{ id: "2" }]).map((v) => v.id), ["1", "2"]);
  assert.deepEqual(pickChoices(meta, { id: "3" }).map((v) => v.id), ["1", 3]);
  assert.deepEqual(pickValue("many", [{ id: 1, name: "a" }, { id: "2" }]), [{ id: "1" }, { id: "2" }]);
  assert.deepEqual(pickValue("many", []), []);
  assert.deepEqual(pickValue("one", { id: 5, value: "x" }), { id: "5" });
  assert.equal(pickValue("one", null), null);
  assert.equal(canSet({ operations: ["set"] }), true);
  assert.equal(canSet({ operations: [] }), false);
  assert.equal(canSet(undefined), false);
  assert.equal(canAddRemove({ operations: ["set", "add", "remove"] }), true);
  assert.equal(canAddRemove({ operations: ["set", "add"] }), false);  // a whole-list PUT then
  assert.equal(canAddRemove(undefined), false);
});

test("ancestry: parent chain top first, via the lookup; stops on cycles", () => {
  const ref = (key, parent) => ({ key, fields: { summary: key, parent: parent ? { key: parent } : undefined } });
  const known = { "A-2": ref("A-2", "A-1"), "A-1": ref("A-1") };
  const lookup = (k) => known[k] || null;
  assert.deepEqual(ancestry(ref("A-3", "A-2"), lookup).map((a) => a.key), ["A-1", "A-2"]);
  assert.deepEqual(ancestry(ref("A-3", "A-9"), lookup).map((a) => a.key), ["A-9"]);  // parent's parent unknown
  assert.deepEqual(ancestry(ref("A-1"), lookup), []);
  const loop = { "B-1": ref("B-1", "B-2"), "B-2": ref("B-2", "B-1") };
  assert.deepEqual(ancestry(ref("B-1", "B-2"), (k) => loop[k]).map((a) => a.key), ["B-2"]);
});
