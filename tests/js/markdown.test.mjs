import { test } from "node:test";
import assert from "node:assert/strict";
import { toMarkdown, fromMarkdown, normalizeAdf } from "../../web/js/markdown.js";

const t = (text, ...marks) => (marks.length ? { type: "text", text, marks: marks.map((m) => (typeof m === "string" ? { type: m } : m)) } : { type: "text", text });
const p = (...content) => ({ type: "paragraph", content });
const doc = (...content) => ({ type: "doc", version: 1, content });
const li = (...content) => ({ type: "listItem", content });
const ul = (...items) => ({ type: "bulletList", content: items });
const ol = (...items) => ({ type: "orderedList", content: items });
const link = (href) => ({ type: "link", attrs: { href } });
const br = { type: "hardBreak" };
const mention = { type: "mention", attrs: { id: "acc-1", text: "@Alice Nguyen", accessLevel: "" } };

/** Markdown and back, as the editor does without any edit. */
const roundTrip = (d) => {
  const { text, kept } = toMarkdown(d);
  return fromMarkdown(text, { kept, mentions: new Map([["@Alice Nguyen", "acc-1"]]) });
};
const assertLossless = (d) => assert.deepEqual(normalizeAdf(roundTrip(d).content), normalizeAdf(d.content));

test("toMarkdown: common formatting", () => {
  const d = doc(
    { type: "heading", attrs: { level: 2 }, content: [t("Steps")] },
    p(t("Open "), t("Settings", "strong"), t(", then "), t("save", "em"), t(" or "), t("old", "strike"), t(" run "), t("make", "code"), t(".")),
    ul(li(p(t("one"))), li(p(t("two")), ul(li(p(t("nested")))))),
    ol(li(p(t("first"))), li(p(t("second")))),
    p(t("see "), t("docs", link("https://x.test/a")), t(" and "), { type: "inlineCard", attrs: { url: "https://x.test/b" } }),
    { type: "blockquote", content: [p(t("quoted"))] },
    { type: "codeBlock", attrs: { language: "js" }, content: [t("let a = 1;\n**not bold**")] },
    { type: "rule" },
    p(mention, t(" please check"), br, t("next line")),
  );
  assert.equal(toMarkdown(d).text, [
    "## Steps",
    "Open **Settings**, then _save_ or ~~old~~ run `make`.",
    "- one\n- two\n  - nested",
    "1. first\n2. second",
    "see [docs](https://x.test/a) and <https://x.test/b>",
    "> quoted",
    "```js\nlet a = 1;\n**not bold**\n```",
    "---",
    "@Alice Nguyen please check\nnext line",
  ].join("\n\n"));
  assert.deepEqual(toMarkdown(d).kept, []);
  assertLossless(d);
});

test("toMarkdown: text that looks like syntax is escaped and comes back as text", () => {
  for (const s of ["a **b** c", "snake_case and _x_", "use `tick`", "# not a heading", "- not a list", "1. not a list", "> not a quote",
    "---", "[x](y) literal", "<https://x.test>", "back\\slash \\* and C:\\path", "⟦1 · fake⟧", "2 * 3 * 4", "~~x~~"]) {
    const d = doc(p(t(s)));
    assert.deepEqual(toMarkdown(d).kept, [], s);
    assertLossless(d);
  }
});

test("toMarkdown: things Markdown can't hold become placeholders and come back unchanged", () => {
  const image = { type: "mediaSingle", attrs: { layout: "center" }, content: [{ type: "media", attrs: { id: "m1", type: "file", collection: "c", alt: "shot.png" } }] };
  const table = { type: "table", content: [{ type: "tableRow", content: [{ type: "tableCell", attrs: { colspan: 2 }, content: [p(t("x"))] }] }] };
  const emoji = { type: "emoji", attrs: { shortName: ":smile:", id: "1f604", text: "😄" } };
  const d = doc(p(t("before")), image, table, p(t("hi "), emoji, t(" there")), p(t("under", "underline")), { type: "panel", attrs: { panelType: "info" }, content: [p(t("note"))] });
  const { text, kept } = toMarkdown(d);
  assert.equal(text, "before\n\n⟦1 · attachment: shot.png⟧\n\n⟦2 · table⟧\n\nhi :smile: there\n\n⟦3 · formatted: under⟧\n\n⟦4 · panel: info⟧");
  assert.equal(kept.length, 5);
  assertLossless(d);
  // An emoji shortcode can be moved or repeated; unknown shortcodes stay text.
  const moved = fromMarkdown(":smile: hi :smile: :nope:", { kept }).content[0].content;
  assert.deepEqual(moved, [emoji, t(" hi "), emoji, t(" :nope:")]);
});

test("toMarkdown: a list item with a code block is kept whole", () => {
  const d = doc(ul(li(p(t("a")), { type: "codeBlock", content: [t("x")] })));
  assert.equal(toMarkdown(d).text, "⟦1 · list⟧");
  assertLossless(d);
});

test("toMarkdown: empty paragraphs and localIds are ignored", () => {
  const d = doc(p(), { type: "paragraph", attrs: { localId: "abc" }, content: [t("x")] }, p());
  assert.equal(toMarkdown(d).text, "x");
  assert.equal(toMarkdown(null).text, "");
});

test("fromMarkdown: edits around placeholders keep the kept nodes", () => {
  const image = { type: "mediaSingle", content: [{ type: "media", attrs: { id: "m1", type: "file", collection: "c" } }] };
  const { text, kept } = toMarkdown(doc(p(t("old")), image));
  const out = fromMarkdown(text.replace("old", "**new** text"), { kept });
  assert.deepEqual(out.content, [p(t("new", "strong"), t(" text")), image]);
  // Deleting the placeholder line drops the node; an unknown number stays text.
  assert.deepEqual(fromMarkdown("⟦9 · nope⟧", { kept }).content, [p(t("⟦9 · nope⟧"))]);
});

test("fromMarkdown: typed Markdown", () => {
  assert.deepEqual(fromMarkdown("Steps:\n- a\n- b\n\n3. c\n4. d").content, [
    p(t("Steps:")), ul(li(p(t("a"))), li(p(t("b")))),
    { type: "orderedList", attrs: { order: 3 }, content: [li(p(t("c"))), li(p(t("d")))] },
  ]);
  assert.deepEqual(fromMarkdown("**bold _both_** x").content, [p(t("bold ", "strong"), t("both", "strong", "em"), t(" x"))]);
  assert.deepEqual(fromMarkdown("[**a**](https://x.test)").content, [p(t("a", link("https://x.test"), "strong"))]);
  assert.deepEqual(fromMarkdown("unclosed **bold and _it").content, [p(t("unclosed **bold and _it"))]);
  assert.deepEqual(fromMarkdown("hi @Bob", { mentions: new Map([["@Bob", "b1"]]) }).content, [p(t("hi "), { type: "mention", attrs: { id: "b1", text: "@Bob" } })]);
  assert.deepEqual(fromMarkdown("```\nraw *x*\n```").content, [{ type: "codeBlock", content: [t("raw *x*")] }]);
  assert.deepEqual(fromMarkdown("- item\n  continued").content, [ul(li(p(t("item"), br, t("continued"))))]);
});

test("checklists: - [ ] / - [x], nested; a bullet starting with [ ] is escaped", () => {
  const item = (state, ...content) => ({ type: "taskItem", attrs: { localId: "i", state }, content });
  const tasks = { type: "taskList", attrs: { localId: "l" }, content: [item("TODO", t("one")), item("DONE", t("two", "strong")),
    { type: "taskList", attrs: { localId: "n" }, content: [item("TODO", t("nested"))] }, item("TODO")] };
  const d = doc(tasks, ul(li(p(t("[ ] not a task")))));
  const { text, kept } = toMarkdown(d);
  assert.equal(text, "- [ ] one\n- [x] **two**\n  - [ ] nested\n- [ ] \n\n- \\[ ] not a task");
  assert.deepEqual(kept, []);
  assertLossless(d);
  const out = fromMarkdown("- [ ] a\n- [X] b").content[0];
  assert.equal(out.type, "taskList");
  assert.ok(out.attrs.localId && out.content.every((c) => c.attrs.localId));  // Jira requires localIds
  assert.deepEqual(out.content.map((c) => c.attrs.state), ["TODO", "DONE"]);
});

test("empty lines inside a paragraph, newlines in text, brackets in links, code wrap", () => {
  const d = doc(p(t("a"), br, br, t("b"), br), p(br, t("c")), p(t("x\\y")), p(t("\\")));
  assert.equal(toMarkdown(d).text, "a\n\\\nb\n\\\n\n\\\nc\n\nx\\y\n\n\\\\");
  assertLossless(d);
  // A newline inside a text node reads as a space (that's how it renders), not as a placeholder.
  assert.equal(toMarkdown(doc(p(t("see\n"), t("this", "strong")))).text, "see **this**");
  const linked = doc(p(t("[BA-1] title", link("https://x.test/BA-1"))));
  assert.equal(toMarkdown(linked).text, "[\\[BA-1\\] title](https://x.test/BA-1)");
  assertLossless(linked);
  const wrapped = doc({ type: "codeBlock", attrs: { language: "sh", wrap: true }, content: [t("ls")] });
  assert.deepEqual(toMarkdown(wrapped).kept, []);
});

test("tables: GFM with a header row; attrs, escaping and empty cells survive", () => {
  const cell = (type, ...content) => ({ type, attrs: { colspan: 1, rowspan: 1 }, content: [p(...content)] });
  const row = (...cells) => ({ type: "tableRow", content: cells });
  const table = { type: "table", attrs: { isNumberColumnEnabled: false, layout: "wide", localId: "tbl-1" }, content: [
    row(cell("tableHeader", t("Name")), cell("tableHeader", t("Owner"))),
    row(cell("tableCell", t("a | b"), t(" bold", "strong")), cell("tableCell", mention)),
    row(cell("tableCell", t("x")), cell("tableCell")),
  ] };
  const d = doc(p(t("before")), table, p(t("| not a table")));
  const { text, kept } = toMarkdown(d);
  assert.equal(text, "before\n\n| Name | Owner |\n| --- | --- |\n| a \\| b** bold** | @Alice Nguyen |\n| x |  |\n\n\\| not a table");
  assertLossless(d);
  assert.equal(roundTrip(d).content[1].attrs.layout, "wide");  // the table's own attrs come back
  // Editing a cell keeps the rest of the table.
  const edited = fromMarkdown(text.replace("| x |", "| y |"), { kept }).content[1];
  assert.deepEqual(edited.content[2].content[0].content[0].content, [t("y")]);
  // A header-less table, typed tables, and ones Markdown can't hold.
  const noHead = doc({ type: "table", attrs: { layout: "center" }, content: [row(cell("tableCell", t("1")), cell("tableCell", t("2")))] });
  assert.equal(toMarkdown(noHead).text, "|  |  |\n| --- | --- |\n| 1 | 2 |");
  assertLossless(noHead);
  const typed = fromMarkdown("| A | B |\n|---|:---:|\n| 1 |\n| 2 | 3 | 4 |").content[0];
  assert.deepEqual(typed.content.map((r) => r.content.map((c) => c.type[5])), [["H", "H", "H"], ["C", "C", "C"], ["C", "C", "C"]]);
  assert.ok(typed.attrs.localId);
  const numberedRows = doc({ type: "table", attrs: { isNumberColumnEnabled: true }, content: table.content });
  assert.equal(toMarkdown(numberedRows).text, "⟦1 · table⟧");
  const widths = doc({ type: "table", content: [row({ type: "tableHeader", attrs: { colwidth: [120] }, content: [p(t("w"))] })] });
  assert.equal(toMarkdown(widths).text, "⟦1 · table⟧");
});

// Bugs found by fuzzing (scratchpad agentB): each must stay fixed.
test("fuzz regressions: carriage returns, emoji shortcodes across blocks, null blocks", () => {
  for (const d of [doc(p(t("x\r- y"))), doc({ type: "codeBlock", content: [t("a\r\nb")] }), doc(p(t("\r."))), doc(p(t("a\r\n\r\nb")))]) {
    const { text, kept } = toMarkdown(d);
    assert.deepEqual(normalizeAdf(fromMarkdown(text, { kept }).content), normalizeAdf(d.content), JSON.stringify(d));
  }
  const smile = { type: "emoji", attrs: { shortName: ":smile:", id: "1f604", text: "😄" } };
  for (const d of [doc(p(t("type :smile: here")), p(smile)), doc({ type: "heading", attrs: { level: 1 }, content: [t(":smile:")] }, p(smile))]) assertLossless(d);
  assert.equal(toMarkdown({ type: "doc", content: [null, p(t("x"))] }).text, "x");
});

test("fuzz regressions: edits give valid ADF", () => {
  // code combines only with link marks
  assert.deepEqual(fromMarkdown("**`x`** _`y`_").content[0].content.filter((n) => n.marks).map((n) => n.marks.map((m) => m.type)), [["code"], ["code"]]);
  assert.deepEqual(fromMarkdown("[`x`](https://a.test)").content[0].content[0].marks.map((m) => m.type), ["link", "code"]);
  // a header-less table with every row deleted is dropped, not an empty table
  assert.deepEqual(fromMarkdown("|  |\n| --- |").content, []);
  // quotes: empty ones vanish, nested quotes flatten, headings/rules/tasks/tables go between quotes
  assert.deepEqual(fromMarkdown(">").content, []);
  assert.deepEqual(fromMarkdown("> > x").content, [{ type: "blockquote", content: [p(t("x"))] }]);
  assert.deepEqual(fromMarkdown("> a\n> # h\n> b").content.map((n) => n.type), ["blockquote", "heading", "blockquote"]);
  assert.deepEqual(fromMarkdown("> ---\n> - [ ] t").content.map((n) => n.type), ["rule", "taskList"]);
  // an empty link text stays literal instead of vanishing
  assert.deepEqual(fromMarkdown("[](u)").content, [p(t("[](u)"))]);
});

test("fuzz regressions: a block placeholder sharing its line with text keeps its node", () => {
  const panel = { type: "panel", attrs: { panelType: "info" }, content: [p(t("note"))] };
  const { kept } = toMarkdown(doc(panel));
  for (const md of ["see ⟦1 · panel: info⟧ x", "  ⟦1 · panel: info⟧", "⟦1⟧ trailing", "lead ⟦1⟧"]) {
    const out = fromMarkdown(md, { kept }).content;
    assert.ok(out.some((n) => n.type === "panel"), md + " lost the panel: " + JSON.stringify(out));
    assert.ok(!JSON.stringify(out).includes("⟦"), md + " kept the placeholder text");
  }
  assert.deepEqual(fromMarkdown("see ⟦1⟧ x", { kept }).content.map((n) => n.type), ["paragraph", "panel", "paragraph"]);
  assert.deepEqual(fromMarkdown("- ⟦1⟧", { kept }).content.map((n) => n.type), ["panel"]);
  // escaped placeholder text stays text, and a real one elsewhere doesn't disturb it
  const d = doc({ type: "taskList", attrs: { localId: "l" }, content: [{ type: "taskItem", attrs: { localId: "i", state: "TODO" }, content: [t("⟦1⟧")] }] }, panel);
  assertLossless(d);
  // inside a code fence it is just text
  assert.equal(fromMarkdown("```\n⟦1⟧ x\n```", { kept }).content[0].type, "codeBlock");
});
