import { test } from "node:test";
import assert from "node:assert/strict";
import { priorityIssueType, prioritiesFromFields, normalizePriorities } from "../../web/js/priorities.js";

const TYPES = [
  { id: "10003", name: "Sub-task", subtask: true },
  { id: "10001", name: "Task", subtask: false },
  { id: "10002", name: "Bug", subtask: false },
];
const PRIOS = [
  { self: "x", iconUrl: "https://x/highest.svg", name: "Highest", id: "1" },
  { name: "Medium", id: 3 },
  { name: "", id: "9" },
  { name: "Low" },
];

test("priorityIssueType: first non-subtask type, else the first type", () => {
  assert.equal(priorityIssueType(TYPES).id, "10001");
  assert.equal(priorityIssueType([TYPES[0]]).id, "10003");
  assert.equal(priorityIssueType([]), null);
  assert.equal(priorityIssueType(undefined), null);
});

test("prioritiesFromFields reads the priority field's allowedValues", () => {
  const fields = [
    { fieldId: "summary", required: true },
    { fieldId: "priority", name: "Priority", allowedValues: PRIOS },
  ];
  assert.deepEqual(prioritiesFromFields(fields), [
    { id: "1", name: "Highest", iconUrl: "https://x/highest.svg" },
    { id: "3", name: "Medium" },
  ]);
  // Older createmeta shapes use `key` instead of `fieldId`.
  assert.deepEqual(prioritiesFromFields([{ key: "priority", allowedValues: [{ id: "2", name: "High" }] }]), [{ id: "2", name: "High" }]);
  assert.deepEqual(prioritiesFromFields([{ fieldId: "summary" }]), []);
  assert.deepEqual(prioritiesFromFields([{ fieldId: "priority" }]), []);
  assert.deepEqual(prioritiesFromFields(null), []);
});

test("normalizePriorities handles the /priority fallback's array and junk", () => {
  assert.deepEqual(normalizePriorities([{ id: "4", name: "Low", statusColor: "#fff" }]), [{ id: "4", name: "Low" }]);
  assert.deepEqual(normalizePriorities({ values: [] }), []);
  assert.deepEqual(normalizePriorities([null, {}]), []);
});
