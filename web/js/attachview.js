// Attachments section of the detail panel: the issue's files (thumbnails for images), an Attach
// button, and drag-and-drop onto the panel. Files load through the server's same-origin
// /files/ routes; uploads go to Jira as multipart (api.uploadAttachments).
import * as jira from "./api.js";
import { state } from "./state.js";
import { $, el, icon, toast } from "./dom.js";
import { ago } from "./format.js";
import { fileUrl, thumbUrl, formatSize, fileKind, isImage, sortAttachments, uploadBatch, MAX_BODY } from "./attachments.js";
import { actions } from "./actions.js";

const PAPER = '<path d="M8 1.75H4.25a1 1 0 0 0-1 1v8.5a1 1 0 0 0 1 1h5.5a1 1 0 0 0 1-1V4.5L8 1.75z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M7.75 1.75V4.75h3" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>';
const KIND_MARK = {
  image: '<circle cx="5.6" cy="7.4" r=".9" fill="currentColor"/><path d="M4.4 10.6l2-2 1.3 1.2 1.1-1.1 1.6 1.9" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round"/>',
  video: '<path d="M5.75 7.25v3l2.5-1.5z" fill="currentColor"/>',
  audio: '<path d="M6.5 10.5V7l2.5-.6v3" fill="none" stroke="currentColor" stroke-width="1.1"/>',
  pdf: '<path d="M4.75 8h4.5M4.75 10h3" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/>',
  archive: '<path d="M7 5.5v1M7 7.5v1M7 9.5v1" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/>',
  sheet: '<path d="M4.75 7.5h4.5M4.75 9.5h4.5M7 6.5v4.5" stroke="currentColor" stroke-width="1" stroke-linecap="round"/>',
  doc: '<path d="M4.75 7.5h4.5M4.75 9.5h4.5" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/>',
  text: '<path d="M4.75 7.5h4.5M4.75 9.5h3" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/>',
  other: "",
};
const CLIP = '<path d="M9.75 6.5L6.6 9.65a1.75 1.75 0 0 1-2.5-2.5l3.6-3.6a1.15 1.15 0 0 1 1.65 1.65L5.9 8.65a.55.55 0 0 1-.8-.8L8.1 4.9" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>';

/** 14px file glyph for an attachment kind (fixed SVG strings only). */
export function kindIcon(kind) {
  return icon(14, PAPER + (KIND_MARK[kind] || ""), "fk fk-" + kind);
}

/** The section: header with count and Attach button, then the file tiles (or a hint). */
export function renderAttachments(issue) {
  const atts = sortAttachments(issue.fields.attachment);
  const input = el("input", { type: "file", multiple: "", hidden: "", "aria-label": "Files to attach" });
  input.addEventListener("change", () => {
    const files = [...input.files];
    input.value = "";
    if (files.length) uploadFiles(issue.key, files);
  });
  const attach = el("button", { class: "link", type: "button", title: "Attach files (or drop them on the panel)" }, "+ Attach");
  attach.addEventListener("click", () => input.click());
  const head = el("div", { class: "sec", id: "attsec" }, "Attachments" + (atts.length ? " · " + atts.length : ""),
    el("span", { class: "spacer" }), attach, input);
  const body = atts.length
    ? el("div", { class: "attlist" }, atts.map(tile))
    : el("p", { class: "nodesc atthint" }, "No attachments. Drop files here to attach them.");
  return [head, body];
}

function tile(a) {
  const kind = fileKind(a.mimeType, a.filename);
  let preview = el("span", { class: "attkind" }, kindIcon(kind));
  if (isImage(a) && a.thumbnail) {
    const img = el("img", { src: thumbUrl(a.id), alt: "", loading: "lazy", decoding: "async" });
    const holder = el("span", { class: "attthumb" }, img);
    img.addEventListener("error", () => holder.replaceWith(el("span", { class: "attkind" }, kindIcon(kind))), { once: true });
    preview = holder;
  }
  const who = a.author ? a.author.displayName : "";
  return el("a", { class: "atttile", href: fileUrl(a.id), target: "_blank", rel: "noopener", "data-att": a.id,
    title: a.filename + " · " + formatSize(a.size) + (who ? " · " + who : "") + (a.created ? " · " + new Date(a.created).toLocaleString() : "") },
  preview,
  el("span", { class: "attinfo" },
    el("span", { class: "attfile" }, a.filename),
    el("span", { class: "attmeta" }, [formatSize(a.size), who, a.created ? ago(a.created) : ""].filter(Boolean).join(" · "))));
}

let uploads = 0;

/** Uploads `files` to issue `key` with progress toasts, then reloads the panel. */
export async function uploadFiles(key, files) {
  const { ok, tooBig } = uploadBatch(files);
  if (tooBig.length) {
    toast("Too large to attach here (max " + Math.floor(MAX_BODY / 1048576) + " MB per upload): " + tooBig.map((f) => f.name).join(", ") + ". Use Jira for big files.", true);
  }
  if (!ok.length) return;
  const label = ok.length === 1 ? ok[0].name : ok.length + " files";
  uploads++;
  state.busy = true;  // no auto-refresh re-render mid-upload
  toast("Uploading " + label + "…");
  let done = false;
  try {
    const added = await jira.uploadAttachments(key, ok, (f) => toast("Uploading " + label + "… " + Math.round(f * 100) + "%"));
    toast("Attached " + (Array.isArray(added) && added.length === 1 ? added[0].filename : label) + " to " + key);
    done = true;
  } catch (e) {
    toast("Upload failed: " + e.message, true);
  } finally {
    if (--uploads === 0) state.busy = false;
  }
  if (done && state.current === key) await actions.loadDetail();
}

let dropBound = false;

/** Makes the detail panel a drop target for files (once; it uploads to the open issue). */
export function bindDrop() {
  if (dropBound) return;
  const d = $("#detail");
  if (!d) return;
  dropBound = true;
  let depth = 0;
  const hasFiles = (e) => !!e.dataTransfer && [...e.dataTransfer.types].includes("Files");
  const overlay = el("div", { class: "dropzone", "aria-hidden": "true" }, icon(14, CLIP, ""), "Drop to attach");
  const show = (on) => {
    if (on && !overlay.isConnected) {
      const r = d.getBoundingClientRect();
      Object.assign(overlay.style, { left: r.left + "px", top: r.top + "px", width: r.width + "px", height: r.height + "px" });
      document.body.append(overlay);
    } else if (!on) overlay.remove();
  };
  d.addEventListener("dragenter", (e) => {
    if (!hasFiles(e) || !state.current) return;
    e.preventDefault();
    depth++;
    show(true);
  });
  d.addEventListener("dragover", (e) => {
    if (!hasFiles(e) || !state.current) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  });
  d.addEventListener("dragleave", (e) => {
    if (!hasFiles(e)) return;
    depth = Math.max(0, depth - 1);
    if (!depth) show(false);
  });
  d.addEventListener("drop", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    show(false);
    const files = [...e.dataTransfer.files];
    if (state.current && files.length) uploadFiles(state.current, files);
  });
}
