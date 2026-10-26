import { test } from "node:test";
import assert from "node:assert/strict";
import { track, snapshotAll, parseDrafts, draftsFor } from "../../web/js/drafts.js";

test("snapshotAll: open editors' drafts; closed ones (null) are dropped for good", () => {
  let open = true;
  const stop = track(() => ({ key: "A-1", kind: "title", text: "t" }));
  track(() => (open ? { key: "A-2", kind: "comment", id: "9", text: "c" } : null));
  assert.deepEqual(snapshotAll().map((d) => d.key), ["A-1", "A-2"]);
  open = false;
  assert.deepEqual(snapshotAll().map((d) => d.key), ["A-1"]);
  open = true;
  assert.deepEqual(snapshotAll().map((d) => d.key), ["A-1"]);  // unregistered when it returned null
  stop();
  assert.deepEqual(snapshotAll(), []);
});

test("parseDrafts: round trip; junk and malformed entries are ignored", () => {
  const good = [
    { key: "A-1", kind: "description", text: "x ⟦1 · table⟧", kept: [{ type: "table" }], base: "x", mentions: [["@Bo", "acc"]] },
    { key: "A-1", kind: "comment", id: "10", text: "hi" },
  ];
  assert.deepEqual(parseDrafts(JSON.stringify(good)), good);
  assert.deepEqual(parseDrafts("not json"), []);
  assert.deepEqual(parseDrafts(null), []);
  assert.deepEqual(parseDrafts('{"key":"A-1"}'), []);
  assert.deepEqual(parseDrafts(JSON.stringify([{ key: "A-1", kind: "comment", text: "no id" }, { key: "A-1", kind: "x", text: "" },
    { key: 1, kind: "title", text: "" }, { key: "A-1", kind: "title", text: "ok", kept: "bad" }])), []);
});

test("draftsFor: this issue's drafts, the rest kept", () => {
  const list = [{ key: "A-1", kind: "title", text: "a" }, { key: "B-2", kind: "title", text: "b" }];
  const { mine, rest } = draftsFor(list, "A-1");
  assert.deepEqual(mine.map((d) => d.text), ["a"]);
  assert.deepEqual(rest.map((d) => d.text), ["b"]);
});
