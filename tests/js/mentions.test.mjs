import { test } from "node:test";
import assert from "node:assert/strict";
import { mentionQuery, matchPeople, insertMention, splitMentions, mentionsOf, mentionToken, MAX_QUERY } from "../../web/js/mentions.js";
import { textToAdf } from "../../web/js/adf.js";

const ALICE = { accountId: "a1", displayName: "Alice Nguyen" };
const AL = { accountId: "a2", displayName: "Al Gore" };
const BOB = { accountId: "b1", displayName: "Bob Okafor" };
const CAROL = { accountId: "c1", displayName: "Carol Schmidt" };
const PEOPLE = [AL, ALICE, BOB, CAROL];

test("mentionQuery: '@' at start, after space or bracket, up to the caret", () => {
  assert.deepEqual(mentionQuery("@", 1), { start: 0, query: "" });
  assert.deepEqual(mentionQuery("hi @ali", 7), { start: 3, query: "ali" });
  assert.deepEqual(mentionQuery("(@bo", 4), { start: 1, query: "bo" });
  assert.deepEqual(mentionQuery("hi @Alice Ng", 12), { start: 3, query: "Alice Ng" });
  assert.deepEqual(mentionQuery("hi @ali and more", 7), { start: 3, query: "ali" });
  assert.deepEqual(mentionQuery("line\n@c", 7), { start: 5, query: "c" });
});

test("mentionQuery: not a mention", () => {
  assert.equal(mentionQuery("sam@example.com", 15), null);  // e-mail
  assert.equal(mentionQuery("no at here", 10), null);
  assert.equal(mentionQuery("@ali\nbob", 8), null);           // crossed a line break
  assert.equal(mentionQuery("@ ali", 5), null);               // space right after @
  assert.equal(mentionQuery("@ali  x", 7), null);             // two spaces end it
  assert.equal(mentionQuery("@Carol Schmidt ", 15), null);    // a trailing space ends it (after a pick)
  assert.equal(mentionQuery("@" + "x".repeat(MAX_QUERY + 1), MAX_QUERY + 2), null);
  assert.equal(mentionQuery("", 0), null);
});

test("matchPeople: whole-name prefix, then word prefix, then substring; limit", () => {
  assert.deepEqual(matchPeople(PEOPLE, "al").map((u) => u.accountId), ["a2", "a1"]);
  assert.deepEqual(matchPeople(PEOPLE, "ok").map((u) => u.accountId), ["b1"]);       // word prefix "Okafor"
  assert.deepEqual(matchPeople(PEOPLE, "mid").map((u) => u.accountId), ["c1"]);      // substring
  assert.deepEqual(matchPeople(PEOPLE, "ALICE N").map((u) => u.accountId), ["a1"]);
  assert.deepEqual(matchPeople(PEOPLE, "zzz"), []);
  assert.equal(matchPeople(PEOPLE, "").length, 4);
  assert.equal(matchPeople(PEOPLE, "", 2).length, 2);
  assert.deepEqual(matchPeople(null, "a"), []);
});

test("insertMention replaces the query and adds one space", () => {
  assert.deepEqual(insertMention("hi @ali", 3, 7, "Alice Nguyen"), { text: "hi @Alice Nguyen ", caret: 17 });
  assert.deepEqual(insertMention("@bo, thanks", 0, 3, "Bob Okafor"), { text: "@Bob Okafor , thanks", caret: 12 });
  assert.deepEqual(insertMention("x @c rest", 2, 4, "Carol Schmidt"), { text: "x @Carol Schmidt rest", caret: 17 });
});

test("splitMentions: whole tokens only, longest name first", () => {
  const m = new Map([[mentionToken(ALICE), "a1"], ["@Al", "a2"], ["@Al Gore", "a2"]]);
  assert.deepEqual(splitMentions("ping @Alice Nguyen please", m), ["ping ", { id: "a1", text: "@Alice Nguyen" }, " please"]);
  assert.deepEqual(splitMentions("@Al Gore and @Al.", m), [{ id: "a2", text: "@Al Gore" }, " and ", { id: "a2", text: "@Al" }, "."]);
  assert.deepEqual(splitMentions("@Alfred is not @Al", m), ["@Alfred is not ", { id: "a2", text: "@Al" }]);
  assert.deepEqual(splitMentions("mail x@Al", m), ["mail x@Al"]);
  assert.deepEqual(splitMentions("plain @someone", m), ["plain @someone"]);
  assert.deepEqual(splitMentions("obj", { "@x": "" }), ["obj"]);
});

test("textToAdf: picked mentions become mention nodes inside the paragraph", () => {
  const doc = textToAdf("Hi @Alice Nguyen, see @Bob\n@Carol Schmidt\n\nmail me@x.io", { "@Alice Nguyen": "a1", "@Carol Schmidt": "c1" });
  assert.deepEqual(doc, {
    type: "doc", version: 1, content: [
      { type: "paragraph", content: [
        { type: "text", text: "Hi " },
        { type: "mention", attrs: { id: "a1", text: "@Alice Nguyen" } },
        { type: "text", text: ", see @Bob" },
        { type: "hardBreak" },
        { type: "mention", attrs: { id: "c1", text: "@Carol Schmidt" } },
      ] },
      { type: "paragraph", content: [{ type: "text", text: "mail me@x.io" }] },
    ],
  });
});

test("textToAdf without a map keeps '@' as text (unchanged behaviour)", () => {
  assert.deepEqual(textToAdf("hi @Alice Nguyen").content[0].content, [{ type: "text", text: "hi @Alice Nguyen" }]);
});

test("mentions round-trip: mentionsOf, textToAdf", () => {
  const doc = { type: "doc", version: 1, content: [{ type: "paragraph", content: [
    { type: "text", text: "cc " }, { type: "mention", attrs: { id: "a1", text: "@Alice Nguyen", accessLevel: "" } }, { type: "text", text: " ok" }] }] };
  const text = "cc @Alice Nguyen ok";
  const map = mentionsOf(doc);
  assert.deepEqual([...map], [["@Alice Nguyen", "a1"]]);
  const again = textToAdf(text, map);
  assert.deepEqual(again.content[0].content[1], { type: "mention", attrs: { id: "a1", text: "@Alice Nguyen" } });
});
