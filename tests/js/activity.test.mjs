import { test } from "node:test";
import assert from "node:assert/strict";
import { describeItem, historyEntries, buildTimeline, collapseRuns, wasEdited, dayText, clip } from "../../web/js/activity.js";

const item = (field, fromString, toString, fieldId) => ({ field, fieldId, fromString, toString });
const ALICE = { accountId: "a", displayName: "Alice" };

test("describeItem: status, assignee, priority, summary", () => {
  assert.equal(describeItem(item("status", "To Do", "In Progress", "status")), "changed status from To Do → In Progress");
  assert.equal(describeItem(item("status", null, "Backlog")), "set status to Backlog");
  assert.equal(describeItem(item("assignee", null, "Bob", "assignee")), "assigned to Bob");
  assert.equal(describeItem(item("assignee", "Bob", "Carol")), "reassigned from Bob to Carol");
  assert.equal(describeItem(item("assignee", "Bob", null)), "unassigned Bob");
  assert.equal(describeItem(item("priority", "Medium", "High")), "changed priority from Medium → High");
  assert.equal(describeItem(item("priority", null, "High")), "set priority to High");
  assert.equal(describeItem(item("summary", "Old", "New title", "summary")), "renamed the issue to “New title”");
});

test("describeItem: description, labels, due date, attachments, multi-value fields", () => {
  assert.equal(describeItem(item("description", "a", "b")), "updated the description");
  assert.equal(describeItem(item("labels", "", "ui", "labels")), "added label ui");
  assert.equal(describeItem(item("labels", "a b", "b c d")), "added labels c, d and removed label a");
  assert.equal(describeItem(item("labels", "a", "a")), null);
  assert.equal(describeItem(item("duedate", null, "2026-10-21 00:00:00.0", "duedate")), "set the due date to Oct 21, 2026");
  assert.equal(describeItem(item("duedate", "2026-10-21", "2026-11-02")), "changed the due date to Nov 2, 2026");
  assert.equal(describeItem(item("duedate", "2026-10-21", null)), "removed the due date");
  assert.equal(describeItem(item("Attachment", null, "shot.png")), "attached shot.png");
  assert.equal(describeItem(item("Fix Version", null, "Q4 2026", "fixVersions")), "added Fix Version “Q4 2026”");
  assert.equal(describeItem(item("Component", "Core", null, "components")), "removed Component “Core”");
});

test("describeItem: generic custom fields and hidden noise", () => {
  assert.equal(describeItem(item("Start date", null, "12/Oct/26", "customfield_10015")), "set Start date to “12/Oct/26”");
  assert.equal(describeItem(item("Client", "Acme", "Globex")), "changed Client from “Acme” → “Globex”");
  assert.equal(describeItem(item("Client", "Acme", null)), "cleared Client");
  for (const f of ["RemoteWorkItemLink", "timeestimate", "timeoriginalestimate", "Rank", "resolution", "WorklogId"]) {
    assert.equal(describeItem(item(f, "x", "y")), null, f);
  }
  assert.equal(describeItem(item("Client", null, null)), null);
});

test("clip and dayText", () => {
  assert.equal(clip("a  b\n c"), "a b c");
  assert.equal(clip("x".repeat(100), 10), "xxxxxxxxx…");
  assert.equal(dayText("2026-01-05"), "Jan 5, 2026");
  assert.equal(dayText("soon"), "soon");
});

test("historyEntries: one entry per visible item, ids stable", () => {
  const h = [{ id: "7", author: ALICE, created: "2026-10-12T11:34:38.423+0800",
    items: [item("status", "Backlog", "To Do"), item("timeestimate", null, "1")] }];
  assert.deepEqual(historyEntries(h), [{ type: "history", id: "7:0", at: h[0].created, author: ALICE, text: "changed status from Backlog → To Do" }]);
  assert.deepEqual(historyEntries(undefined), []);
});

test("buildTimeline: interleaves created, history (newest-first input) and comments chronologically", () => {
  const histories = [  // the changelog expand lists newest first
    { id: "2", author: ALICE, created: "2026-10-03T10:00:00.000+0000", items: [item("status", "To Do", "Done")] },
    { id: "1", author: ALICE, created: "2026-10-01T10:00:00.000+0000", items: [item("assignee", null, "Alice")] },
  ];
  const comments = [{ id: "9", created: "2026-10-02T10:00:00.000+0000", author: ALICE }];
  const t = buildTimeline({ comments, histories, created: "2026-09-30T08:00:00.000+0000", creator: ALICE });
  assert.deepEqual(t.map((e) => e.type + ":" + e.id), ["created:created", "history:1:0", "comment:c9", "history:2:0"]);
  assert.equal(t[0].text, "created the issue");
  assert.equal(t[2].comment, comments[0]);
});

test("buildTimeline: timezone offsets compare correctly and ties keep input order", () => {
  const histories = [{ id: "1", created: "2026-10-12T11:00:00.000+0800", items: [item("status", "A", "B")] }];  // 03:00Z
  const comments = [{ id: "5", created: "2026-10-12T04:00:00.000+0000" }, { id: "6", created: "2026-10-12T04:00:00.000+0000" }];
  assert.deepEqual(buildTimeline({ comments, histories }).map((e) => e.id), ["1:0", "c5", "c6"]);
  assert.deepEqual(buildTimeline(), []);
});

test("collapseRuns: runs of more than 3 one-liners keep first and last", () => {
  const h = (n) => ({ type: "history", id: "h" + n });
  const c = (n) => ({ type: "comment", id: "c" + n });
  assert.deepEqual(collapseRuns([h(1), h(2), h(3), c(1)]), [h(1), h(2), h(3), c(1)]);
  const out = collapseRuns([{ type: "created", id: "created" }, h(1), h(2), h(3), h(4), c(1), h(5)]);
  assert.deepEqual(out.map((e) => e.id), ["created", "more:h1", "h4", "c1", "h5"]);
  assert.deepEqual(out[1].entries.map((e) => e.id), ["h1", "h2", "h3"]);
  assert.deepEqual(collapseRuns([h(1), h(2), h(3), h(4)]).map((e) => e.id), ["h1", "more:h2", "h4"]);
  assert.deepEqual(collapseRuns([]), []);
});

test("wasEdited: updated more than a second after created", () => {
  assert.equal(wasEdited({ created: "2026-10-19T15:43:09.367+0800", updated: "2026-10-19T15:47:42.543+0800" }), true);
  assert.equal(wasEdited({ created: "2026-10-19T15:43:09.367+0800", updated: "2026-10-19T15:43:09.367+0800" }), false);
  assert.equal(wasEdited({ created: "2026-10-19T15:43:09.367+0800" }), false);
  assert.equal(wasEdited(null), false);
});
