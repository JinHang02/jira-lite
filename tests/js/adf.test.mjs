import { test } from "node:test";
import assert from "node:assert/strict";
import { textToAdf, plainSafe, adfToText, safeUrl } from "../../web/js/adf.js";

const text = (t) => ({ type: "text", text: t });
const br = { type: "hardBreak" };
const para = (...content) => ({ type: "paragraph", content });

test("textToAdf: one paragraph", () => {
  assert.deepEqual(textToAdf("hello"), { type: "doc", version: 1, content: [para(text("hello"))] });
});

test("textToAdf: blank lines split paragraphs (including whitespace-only lines)", () => {
  assert.deepEqual(textToAdf("one\n\ntwo\n  \nthree").content, [para(text("one")), para(text("two")), para(text("three"))]);
});

test("textToAdf: single newlines become hard breaks", () => {
  assert.deepEqual(textToAdf("a\nb\nc").content, [para(text("a"), br, text("b"), br, text("c"))]);
});

test("textToAdf: trims and handles empty lines inside a paragraph", () => {
  // Outer whitespace is trimmed; several blank lines are one paragraph break.
  assert.deepEqual(textToAdf("\n\n  a\n\n\n\nb  \n").content, [para(text("a")), para(text("b"))]);
  // Inner leading spaces survive; an empty input gives one empty paragraph.
  assert.deepEqual(textToAdf("x\n  y").content, [para(text("x"), br, text("  y"))]);
  assert.deepEqual(textToAdf("").content, [para()]);
});

test("plainSafe accepts unformatted text only", () => {
  assert.equal(plainSafe(null), true);
  assert.equal(plainSafe(undefined), true);
  assert.equal(plainSafe(textToAdf("a\nb\n\nc")), true);
  assert.equal(plainSafe({ type: "doc", content: [para({ type: "text", text: "x", marks: [{ type: "strong" }] })] }), false);
  assert.equal(plainSafe({ type: "doc", content: [{ type: "bulletList", content: [] }] }), false);
  assert.equal(plainSafe({ type: "doc", content: [para({ type: "mention", attrs: { text: "@x" } })] }), false);
  assert.equal(plainSafe({ type: "doc", content: [{ type: "codeBlock", content: [text("x")] }] }), false);
  assert.equal(plainSafe({ type: "doc", content: [para({ type: "text", text: "x", marks: [] })] }), true);
});

test("adfToText", () => {
  assert.equal(adfToText(null), "");
  assert.equal(adfToText({ type: "doc", content: [] }), "");
  assert.equal(adfToText({ type: "doc", content: [para(text("a"), br, text("b")), para(text("c"))] }), "a\nb\n\nc");
  assert.equal(adfToText({ type: "doc", content: [para()] }), "");
});

test("adfToText(textToAdf(x)) round-trips normalised text", () => {
  for (const s of ["hello", "a\nb", "one\n\ntwo", "first line\nsecond\n\nnew para\nwith break\n\nlast"]) {
    assert.equal(adfToText(textToAdf(s)), s);
  }
  // Leading/trailing whitespace is trimmed and runs of blank lines collapse to one.
  assert.equal(adfToText(textToAdf("  x\n\n\n\ny \n")), "x\n\ny");
});

test("textToAdf(adfToText(doc)) round-trips plain-safe docs", () => {
  const doc = { type: "doc", version: 1, content: [para(text("a"), br, text("b")), para(text("c"))] };
  assert.ok(plainSafe(doc));
  assert.deepEqual(textToAdf(adfToText(doc)), doc);
});

test("safeUrl allows http(s) and mailto only", () => {
  assert.equal(safeUrl("https://x.y/z"), "https://x.y/z");
  assert.equal(safeUrl("HTTP://x"), "HTTP://x");
  assert.equal(safeUrl("mailto:a@b.c"), "mailto:a@b.c");
  assert.equal(safeUrl("javascript:alert(1)"), null);
  assert.equal(safeUrl(""), null);
  assert.equal(safeUrl(undefined), null);
});
