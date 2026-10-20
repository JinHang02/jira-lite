import { test } from "node:test";
import assert from "node:assert/strict";
import { fieldText, localDay, dueState, parseLabels, requiredCustomFields } from "../../web/js/props.js";

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
