import { test } from "node:test";
import assert from "node:assert/strict";
import { syncPlan, deltaMinutes, mergeDelta, FULL_EVERY_MS, OVERLAP_MIN } from "../../web/js/sync.js";
import { deltaJql, matchesView, buildJql } from "../../web/js/jql.js";

const ME = "712020:me";
const OTHER = "712020:other";
const cat = (key) => ({ id: key === "done" ? "7" : "3", name: key === "done" ? "Done" : "In Progress", statusCategory: { key } });
const iss = (key, { assignee = ME, status = "indeterminate", updated = "2026-10-20T10:00:00.000+0800", summary = key } = {}) =>
  ({ key, fields: { summary, updated, status: cat(status), assignee: assignee ? { accountId: assignee, displayName: assignee } : null } });

// ---- deltaJql ----
test("deltaJql: project, relative window, newest first; no view filters", () => {
  assert.equal(deltaJql("BA", 3), 'project = "BA" AND updated >= -3m ORDER BY updated DESC');
  assert.equal(deltaJql("XY", 2.2), 'project = "XY" AND updated >= -3m ORDER BY updated DESC');
  assert.equal(deltaJql("BA", 0), 'project = "BA" AND updated >= -1m ORDER BY updated DESC');
});

// ---- deltaMinutes ----
test("deltaMinutes: minutes elapsed since the last sync started (rounded, at least 1), plus overlap", () => {
  const t = Date.parse("2026-10-20T10:00:00Z");
  assert.equal(OVERLAP_MIN, 2);
  assert.equal(deltaMinutes(t, t + 60000), 3);           // the usual 60 s tick
  assert.equal(deltaMinutes(t, t + 61500), 3);           // timer jitter doesn't widen the window
  assert.equal(deltaMinutes(t, t + 90000), 4);           // half a minute late rounds up
  assert.equal(deltaMinutes(t, t + 5000), 3);            // never less than one minute
  assert.equal(deltaMinutes(t, t + 9 * 60000 + 1), 11);  // tab was hidden for a while
  assert.equal(deltaMinutes(t, t - 30000), 3);           // clock went backwards
  assert.equal(deltaMinutes(t, t + 60000, 0), 1);
});

// ---- syncPlan ----
test("syncPlan: full until a full load has happened, then delta, full again every 10 minutes", () => {
  const now = 1_000_000_000;
  assert.equal(FULL_EVERY_MS, 600000);
  assert.equal(syncPlan({ now, lastFull: 0, lastSync: 0 }), "full");
  assert.equal(syncPlan({ now, lastFull: now - 60000, lastSync: now - 60000 }), "delta");
  assert.equal(syncPlan({ now, lastFull: now - FULL_EVERY_MS + 1, lastSync: now - 1000 }), "delta");
  assert.equal(syncPlan({ now, lastFull: now - FULL_EVERY_MS, lastSync: now - 1000 }), "full");
  assert.equal(syncPlan({ now, lastFull: now - 1000, lastSync: now - 1000, canDelta: false }), "full");
  assert.equal(syncPlan({ now, lastFull: now - 1000, lastSync: now - 1000, fullEveryMs: 500 }), "full");
});

// ---- matchesView ----
test("matchesView mirrors buildJql's filters", () => {
  const mineOpen = iss("BA-1");
  const mineDone = iss("BA-2", { status: "done" });
  const otherOpen = iss("BA-3", { assignee: OTHER });
  const unassigned = iss("BA-4", { assignee: null });
  const v = (who, showDone, meId = ME) => (i) => matchesView(i, { who, meId, showDone });

  assert.deepEqual([mineOpen, mineDone, otherOpen, unassigned].filter(v("mine", false)).map((i) => i.key), ["BA-1"]);
  assert.deepEqual([mineOpen, mineDone, otherOpen, unassigned].filter(v("mine", true)).map((i) => i.key), ["BA-1", "BA-2"]);
  assert.deepEqual([mineOpen, mineDone, otherOpen, unassigned].filter(v("all", false)).map((i) => i.key), ["BA-1", "BA-3", "BA-4"]);
  assert.deepEqual([mineOpen, mineDone, otherOpen, unassigned].filter(v("all", true)).map((i) => i.key), ["BA-1", "BA-2", "BA-3", "BA-4"]);
  assert.deepEqual([mineOpen, mineDone, otherOpen, unassigned].filter(v(OTHER, false)).map((i) => i.key), ["BA-3"]);
  // "mine" never matches while the user's id is unknown.
  assert.deepEqual([mineOpen, unassigned].filter(v("mine", true, null)).map((i) => i.key), []);
  // Tolerates missing fields.
  assert.equal(matchesView({ key: "BA-9" }, { who: "all", showDone: false }), true);
  assert.equal(matchesView({ key: "BA-9" }, { who: ME, showDone: false }), false);
  // Sanity: the same view in JQL.
  assert.equal(buildJql({ project: "BA", who: "mine", showDone: false }),
    'project = "BA" AND assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC');
});

// ---- mergeDelta ----
const keepMine = (i) => matchesView(i, { who: "mine", meId: ME, showDone: false });
const keys = (r) => r.issues.map((i) => i.key);

test("mergeDelta: nothing changed returns the same array", () => {
  const list = [iss("BA-1"), iss("BA-2")];
  const r = mergeDelta(list, [iss("BA-2")], keepMine);
  assert.equal(r.changed, false);
  assert.equal(r.issues, list);
  assert.equal(mergeDelta(list, [], keepMine).issues, list);
  assert.equal(mergeDelta(list, undefined, keepMine).issues, list);
  // An irrelevant issue (not in the view, not loaded) changes nothing.
  assert.equal(mergeDelta(list, [iss("BA-7", { assignee: OTHER })], keepMine).changed, false);
});

test("mergeDelta: updated issues move to the top, new ones are added there", () => {
  const list = [iss("BA-1"), iss("BA-2"), iss("BA-3")];
  const upd = iss("BA-3", { summary: "renamed", updated: "2026-10-20T10:05:00.000+0800" });
  const r = mergeDelta(list, [iss("BA-9", { updated: "2026-10-20T10:06:00.000+0800" }), upd], keepMine);
  assert.equal(r.changed, true);
  assert.deepEqual(keys(r), ["BA-9", "BA-3", "BA-1", "BA-2"]);
  assert.equal(r.issues[1].fields.summary, "renamed");
  assert.deepEqual(keys({ issues: list }), ["BA-1", "BA-2", "BA-3"]);  // input untouched
});

test("mergeDelta: issues that left the view are removed", () => {
  const list = [iss("BA-1"), iss("BA-2"), iss("BA-3")];
  const reassigned = iss("BA-1", { assignee: OTHER });
  const closed = iss("BA-2", { status: "done" });
  const r = mergeDelta(list, [reassigned, closed], keepMine);
  assert.equal(r.changed, true);
  assert.deepEqual(keys(r), ["BA-3"]);
  // With done shown, the closed one stays (updated, moved up); the reassigned one still goes.
  const keepMineDone = (i) => matchesView(i, { who: "mine", meId: ME, showDone: true });
  assert.deepEqual(keys(mergeDelta(list, [reassigned, closed], keepMineDone)), ["BA-2", "BA-3"]);
});

test("mergeDelta: duplicate keys in the delta count once", () => {
  const r = mergeDelta([iss("BA-1")], [iss("BA-5"), iss("BA-5")], keepMine);
  assert.deepEqual(keys(r), ["BA-5", "BA-1"]);
});

// ---- sinceLabel / REFRESH_MS ----
test("sinceLabel: relative time since the last sync", async () => {
  const { sinceLabel, REFRESH_MS } = await import("../../web/js/sync.js");
  const t = Date.parse("2026-10-20T10:00:00Z");
  assert.equal(REFRESH_MS, 60000);
  assert.equal(sinceLabel(0, t), "");
  assert.equal(sinceLabel(t, t + 30000), "just now");
  assert.equal(sinceLabel(t, t - 5000), "just now");
  assert.equal(sinceLabel(t, t + 60000), "1 min ago");
  assert.equal(sinceLabel(t, t + 12 * 60000 + 59000), "12 min ago");
  assert.equal(sinceLabel(t, t + 3 * 3600000 + 1), "3 h ago");
});
