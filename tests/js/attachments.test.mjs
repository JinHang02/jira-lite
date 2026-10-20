import { test } from "node:test";
import assert from "node:assert/strict";
import { fileUrl, thumbUrl, formatSize, fileKind, isImage, findAttachment, sortAttachments, uploadBatch, MAX_BODY } from "../../web/js/attachments.js";

test("file URLs go through the same-origin /files/ routes", () => {
  assert.equal(fileUrl("25639"), "/files/content/25639");
  assert.equal(thumbUrl(7), "/files/thumbnail/7");
  assert.equal(fileUrl("../x"), "/files/content/..%2Fx");  // never a path; the server only takes digits
});

test("formatSize", () => {
  assert.equal(formatSize(0), "0 B");
  assert.equal(formatSize(512), "512 B");
  assert.equal(formatSize(1024), "1 KB");
  assert.equal(formatSize(1536), "1.5 KB");
  assert.equal(formatSize(73587), "72 KB");
  assert.equal(formatSize(5120334), "4.9 MB");
  assert.equal(formatSize(3 * 1024 ** 3), "3 GB");
  assert.equal(formatSize(undefined), "");
  assert.equal(formatSize(-1), "");
});

test("fileKind from MIME type, then extension", () => {
  assert.equal(fileKind("image/png", "a.png"), "image");
  assert.equal(fileKind("video/mp4", "x"), "video");
  assert.equal(fileKind("application/pdf", "x"), "pdf");
  assert.equal(fileKind("application/zip", "x"), "archive");
  assert.equal(fileKind("text/plain", "logcat.txt"), "text");
  assert.equal(fileKind("application/octet-stream", "shot.JPG"), "image");
  assert.equal(fileKind("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "a.xlsx"), "sheet");
  assert.equal(fileKind("application/msword", "a.doc"), "doc");
  assert.equal(fileKind("", "notes.md"), "text");
  assert.equal(fileKind("application/octet-stream", "blob"), "other");
  assert.equal(isImage({ mimeType: "image/gif", filename: "a.gif" }), true);
  assert.equal(isImage({ mimeType: "text/plain", filename: "a.txt" }), false);
  assert.equal(isImage(null), false);
});

test("findAttachment matches media nodes by file name (alt), newest wins", () => {
  const atts = [
    { id: "1", filename: "image-20261014-085929.png", created: "2026-10-14T08:59:00.000+0000" },
    { id: "2", filename: "shot.png", created: "2026-10-01T00:00:00.000+0000" },
    { id: "3", filename: "shot.png", created: "2026-10-02T00:00:00.000+0000" },
    { id: "4", filename: "Diagram.PNG", created: "2026-10-02T00:00:00.000+0000" },
  ];
  assert.equal(findAttachment({ id: "9f1e035a", alt: "image-20261014-085929.png" }, atts).id, "1");
  assert.equal(findAttachment({ alt: "shot.png" }, atts).id, "3");
  assert.equal(findAttachment({ alt: "diagram.png" }, atts).id, "4");
  assert.equal(findAttachment({ name: "shot.png" }, atts).id, "3");
  assert.equal(findAttachment({ alt: "missing.png" }, atts), null);
  assert.equal(findAttachment({ id: "9f1e035a" }, atts), null);  // no name: can't tell
  assert.equal(findAttachment({ alt: "shot.png" }, undefined), null);
  assert.equal(findAttachment(null, atts), null);
});

test("sortAttachments: oldest first", () => {
  const out = sortAttachments([{ id: "2", created: "2026-10-02" }, { id: "1", created: "2026-10-01" }]);
  assert.deepEqual(out.map((a) => a.id), ["1", "2"]);
  assert.deepEqual(sortAttachments(undefined), []);
});

test("uploadBatch keeps the request under the server's body limit", () => {
  const MB = 1024 * 1024;
  const f = (name, size) => ({ name, size });
  const { ok, tooBig } = uploadBatch([f("a", 10 * MB), f("b", 30 * MB), f("c", 10 * MB), f("d", 10 * MB)]);
  assert.deepEqual(ok.map((x) => x.name), ["a", "c"]);
  assert.deepEqual(tooBig.map((x) => x.name), ["b", "d"]);
  assert.equal(MAX_BODY, 25 * MB);
  assert.deepEqual(uploadBatch([]), { ok: [], tooBig: [] });
});
