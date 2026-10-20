import { test } from "node:test";
import assert from "node:assert/strict";
import { visiblePeople, pushRecent, PEOPLE_LIMIT } from "../../web/js/people.js";
import { shortcutGroups } from "../../web/js/shortcuts.js";

const people = "Ada Ben Cy Dee Eve Fay Gus Hal Ivy Jo Kai".split(" ").map((n) => ({ accountId: n.toLowerCase(), displayName: n }));
const names = (r) => r.shown.map((u) => u.displayName);

test("a short list is shown in full", () => {
  const few = people.slice(0, PEOPLE_LIMIT);
  assert.deepEqual(visiblePeople(few, {}), { shown: few, hidden: 0 });
});

test("a long list shows the first eight by name", () => {
  const r = visiblePeople(people, {});
  assert.deepEqual(names(r), ["Ada", "Ben", "Cy", "Dee", "Eve", "Fay", "Gus", "Hal"]);
  assert.equal(r.hidden, 3);
});

test("the selected person and recent picks are always included, in name order", () => {
  const r = visiblePeople(people, { selected: "kai", recent: ["jo", "ada", "nobody"] });
  assert.deepEqual(names(r), ["Ada", "Ben", "Cy", "Dee", "Eve", "Fay", "Jo", "Kai"]);
  assert.equal(r.hidden, 3);
  assert.equal(visiblePeople(people, { selected: "mine" }).shown.length, PEOPLE_LIMIT);
});

test("show all and filter", () => {
  assert.deepEqual(visiblePeople(people, { showAll: true }), { shown: people, hidden: 0 });
  assert.deepEqual(names(visiblePeople(people, { filter: " A " })), ["Ada", "Fay", "Hal", "Kai"]);
  assert.deepEqual(visiblePeople(people, { filter: "zz" }), { shown: [], hidden: 0 });
});

test("pushRecent: most recent first, deduplicated, capped", () => {
  assert.deepEqual(pushRecent([], "a"), ["a"]);
  assert.deepEqual(pushRecent(["a", "b", "c"], "b"), ["b", "a", "c"]);
  assert.deepEqual(pushRecent(["a", "b", "c"], "d", 3), ["d", "a", "b"]);
  assert.deepEqual(pushRecent(undefined, "a"), ["a"]);
});

test("shortcut groups: the four sections, non-empty, modifier by platform", () => {
  const g = shortcutGroups(true);
  assert.deepEqual(g.map((x) => x.title), ["General", "Navigation", "Issue", "Views"]);
  for (const s of g) for (const it of s.items) assert.ok(it.label && it.keys.length && it.keys.every((c) => c.length));
  const caps = (groups) => groups.flatMap((s) => s.items.flatMap((it) => it.keys.flat()));
  assert.ok(caps(g).includes("⌘") && !caps(g).includes("Ctrl"));
  assert.ok(caps(shortcutGroups(false)).includes("Ctrl") && !caps(shortcutGroups(false)).includes("⌘"));
});
