import { test } from "node:test";
import assert from "node:assert/strict";
import {
  snapshot, parseViews, serializeViews, uniqueName, newId, addView, renameView, deleteView, applyView, sameSettings, NAME_MAX,
} from "../../web/js/savedviews.js";

const settings = { who: "all", epic: null, view: "board", grouping: "priority", ordering: "created", showDone: true, filter: " signup ", extra: 1 };

test("snapshot keeps only the view settings, normalised", () => {
  assert.deepEqual(snapshot(settings), { who: "all", epic: null, view: "board", grouping: "priority", ordering: "created", showDone: true, filter: "signup" });
  assert.deepEqual(snapshot({ grouping: "bogus", ordering: 3, view: "table" }),
    { who: "mine", epic: null, view: "list", grouping: "status", ordering: "updated", showDone: false, filter: "" });
});

test("addView names uniquely and stores a snapshot", () => {
  let { views, view } = addView([], settings, "  Billing   board ", "v1");
  assert.deepEqual(view, { id: "v1", name: "Billing board", ...snapshot(settings) });
  ({ views, view } = addView(views, { who: "mine" }, "billing BOARD", "v2"));
  assert.equal(view.name, "billing BOARD 2");
  ({ views, view } = addView(views, { who: "mine" }, "", "v3"));
  assert.equal(view.name, "Untitled view");
  assert.deepEqual(views.map((v) => v.id), ["v1", "v2", "v3"]);
});

test("uniqueName counts up and respects the length cap", () => {
  const views = [{ id: "a", name: "Mine" }, { id: "b", name: "Mine 2" }];
  assert.equal(uniqueName(views, "mine"), "mine 3");
  assert.equal(uniqueName(views, "Mine", "a"), "Mine");
  const long = "x".repeat(80);
  const first = uniqueName([], long);
  assert.equal(first.length, NAME_MAX);
  assert.equal(uniqueName([{ id: "a", name: first }], long), "x".repeat(NAME_MAX - 2) + " 2");
});

test("renameView: unique, blank or unknown is a no-op", () => {
  const views = [{ id: "a", name: "One", ...snapshot({}) }, { id: "b", name: "Two", ...snapshot({}) }];
  assert.deepEqual(renameView(views, "a", "Two").map((v) => v.name), ["Two 2", "Two"]);
  assert.deepEqual(renameView(views, "a", " one ").map((v) => v.name), ["one", "Two"]);
  assert.equal(renameView(views, "a", "   "), views);
  assert.equal(renameView(views, "zz", "Three"), views);
});

test("deleteView", () => {
  assert.deepEqual(deleteView([{ id: "a" }, { id: "b" }], "a"), [{ id: "b" }]);
});

test("serialize / parse round trip; malformed entries are skipped", () => {
  const { views } = addView([], { who: "712020:x", epic: "BA-7", view: "list" }, "Epic", "v1");
  assert.deepEqual(parseViews(serializeViews(views)), views);
  const junk = JSON.stringify([null, 3, { id: "", name: "x" }, { id: "a", name: " " }, { id: "b", name: "B", grouping: "zzz" }, { id: "b", name: "dup" }]);
  assert.deepEqual(parseViews(junk), [{ id: "b", name: "B", ...snapshot({}) }]);
  assert.deepEqual(parseViews("{"), []);
  assert.deepEqual(parseViews(null), []);
  assert.deepEqual(parseViews('{"a":1}'), []);
});

test("applyView gives the settings to restore; sameSettings detects edits", () => {
  const { view } = addView([], settings, "V", "v1");
  assert.deepEqual(applyView(view), snapshot(settings));
  assert.ok(sameSettings(view, { ...settings, cursor: "x" }));
  assert.ok(!sameSettings(view, { ...settings, ordering: "updated" }));
});

test("newId avoids existing ids", () => {
  let n = 0;
  const rand = () => [0.5, 0.5, 0.25][n++];
  const taken = [{ id: "v" + Math.floor(0.5 * 2 ** 32).toString(36) }];
  assert.equal(newId(taken, rand), "v" + Math.floor(0.25 * 2 ** 32).toString(36));
});
