// Images in the description editor: paste, drop or pick one, it is uploaded as an attachment
// and a "⟦n · attachment: name⟧" line (an embedded image, see markdown.keepBlock) goes in at
// the caret.
import * as jira from "./api.js";
import { el, toast } from "./dom.js";
import { keepBlock } from "./markdown.js";
import { pastedName, imageNode, isImage, uploadBatch, MAX_BODY } from "./attachments.js";

const imageSize = (file) => createImageBitmap(file).then((b) => ({ width: b.width, height: b.height }), () => null);

/**
 * Wires image paste/drop into `ta` (the Markdown textarea of issue `key`) and returns an
 * "Image" button that opens a file picker. `onBusy(n)` gets the number of uploads in flight
 * (saving waits until it is 0). Other dropped files are attached without being embedded.
 */
export function bindImages(ta, key, kept, onBusy) {
  let busy = 0;
  let pasted = 0;
  const track = (d) => { busy += d; onBusy(busy); };

  /** Puts `text` on a line of its own at the caret; returns it. */
  const insert = (text) => {
    const s = ta.selectionStart, e = ta.selectionEnd;
    const before = ta.value.slice(0, s), after = ta.value.slice(e);
    const line = (before && !before.endsWith("\n") ? "\n" : "") + text + (!after.startsWith("\n") ? "\n" : "");
    ta.value = before + line + after;
    ta.selectionStart = ta.selectionEnd = before.length + line.length;
    ta.dispatchEvent(new Event("input"));
    return text;
  };
  const swap = (mark, text) => {
    // A function replacement: a file name's "$&" or "$'" must not be read as a pattern.
    ta.value = text ? ta.value.replace(mark, () => text) : ta.value.replace(mark + "\n", "").replace(mark, "");
    ta.dispatchEvent(new Event("input"));
  };

  const embed = async (raw) => {
    const file = raw.name && !/^image\.\w+$/i.test(raw.name) ? raw : new File([raw], pastedName(raw.name, raw.type, new Date(), pasted++), { type: raw.type });
    const mark = insert("⟦uploading " + file.name + "…⟧");
    track(1);
    try {
      const [size, added] = await Promise.all([imageSize(file), jira.uploadAttachments(key, [file])]);
      const att = (added || [])[0];
      if (!att) throw new Error("Jira returned no attachment");
      swap(mark, keepBlock(kept, imageNode(await jira.getMediaId(att.id), att.filename, size)));
    } catch (e) {
      swap(mark, "");
      if (!e.loginRequired) toast("Couldn't add " + file.name + ": " + e.message, true);
    } finally {
      track(-1);
    }
  };
  const attachOnly = async (files) => {
    track(1);
    try {
      await jira.uploadAttachments(key, files);
      toast("Attached " + files.map((f) => f.name).join(", ") + " (only images go into the description)");
    } catch (e) {
      if (!e.loginRequired) toast("Upload failed: " + e.message, true);
    } finally {
      track(-1);
    }
  };
  const add = (files) => {
    // Each image is its own upload; the other files go up together (see attachOnly).
    const imgs = files.filter((f) => isImage({ mimeType: f.type, filename: f.name }));
    const fits = imgs.filter((f) => uploadBatch([f]).ok.length);
    const { ok: others, tooBig } = uploadBatch(files.filter((f) => !imgs.includes(f)));
    const refused = [...imgs.filter((f) => !fits.includes(f)), ...tooBig];
    if (refused.length) {
      toast("Too large to attach here (max " + Math.floor(MAX_BODY / 1048576) + " MB per upload): " + refused.map((f) => f.name).join(", ") + ". Use Jira for big files.", true);
    }
    fits.forEach(embed);
    if (others.length) attachOnly(others);
  };

  ta.addEventListener("paste", (e) => {
    const files = [...((e.clipboardData && e.clipboardData.files) || [])];
    if (!files.length) return;  // plain text pastes as usual
    e.preventDefault();
    add(files);
  });
  const hasFiles = (e) => !!e.dataTransfer && [...e.dataTransfer.types].includes("Files");
  // Handled here, not by the panel's "Drop to attach" (which would only attach).
  for (const type of ["dragenter", "dragover", "dragleave"]) {
    ta.addEventListener(type, (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.stopPropagation();
      ta.classList.toggle("dropping", type !== "dragleave");
    });
  }
  ta.addEventListener("drop", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    ta.classList.remove("dropping");
    add([...e.dataTransfer.files]);
  });

  const picker = el("input", { type: "file", accept: "image/*", multiple: "", hidden: "" });
  picker.addEventListener("change", () => { add([...picker.files]); picker.value = ""; ta.focus(); });
  const btn = el("button", { class: "btn", type: "button", title: "Add an image (or paste / drop one into the text)" }, "Image");
  btn.addEventListener("click", () => picker.click());
  return el("span", { class: "imgbtn" }, btn, picker);
}
