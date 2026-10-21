// Image viewer overlay, like Jira's media viewer: the image fitted to the window (click for full
// size), its name and size, ←/→ through the issue's images, Download and Open in Jira.
// Esc or a click outside the image closes it.
import { el, icon, ICONS } from "./dom.js";
import { showModal, closeModal } from "./modal.js";
import { fileUrl, formatSize, isImage, sortAttachments } from "./attachments.js";

const PREV = '<path d="M8.5 3L4.5 7l4 4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>';
const NEXT = '<path d="M5.5 3l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>';

/** Opens attachment `id` of `attachments` (an issue's fields.attachment); `jiraUrl` is the issue in Jira. */
export function openViewer(attachments, id, jiraUrl) {
  const images = sortAttachments((attachments || []).filter(isImage));
  let at = Math.max(0, images.findIndex((a) => String(a.id) === String(id)));
  if (!images.length) return;
  const img = el("img", { class: "vimg", alt: "" });
  const name = el("span", { class: "vw-name" });
  const meta = el("span", { class: "vw-meta" });
  const download = el("a", { class: "btn", target: "_blank", rel: "noopener", title: "Download the original" }, "Download");
  const jira = el("a", { class: "btn", href: jiraUrl, target: "_blank", rel: "noopener", title: "Open the issue in Jira" }, "Open in Jira ↗");
  const close = el("button", { class: "btn icon", type: "button", title: "Close (esc)", "aria-label": "Close", onclick: closeModal }, icon(14, ICONS.close, ""));
  const nav = (d, svg, label) => {
    const b = el("button", { class: "vnav " + (d < 0 ? "prev" : "next"), type: "button", title: label, "aria-label": label }, icon(14, svg, ""));
    b.addEventListener("click", (e) => { e.stopPropagation(); show(at + d); });
    return b;
  };
  const prev = images.length > 1 ? nav(-1, PREV, "Previous image (←)") : null;
  const next = images.length > 1 ? nav(1, NEXT, "Next image (→)") : null;
  const stage = el("div", { class: "vstage" }, prev, img, next);

  const show = (i) => {
    at = (i + images.length) % images.length;
    const a = images[at];
    stage.classList.remove("zoom");
    img.src = fileUrl(a.id);
    img.alt = a.filename;
    name.textContent = a.filename;
    meta.textContent = [formatSize(a.size), images.length > 1 ? at + 1 + " of " + images.length : ""].filter(Boolean).join(" · ");
    download.href = fileUrl(a.id);
  };
  img.addEventListener("click", (e) => { e.stopPropagation(); stage.classList.toggle("zoom"); });
  stage.addEventListener("click", (e) => { if (e.target === stage) closeModal(); });

  const box = el("div", { class: "viewer", role: "dialog", "aria-label": "Image viewer", tabindex: "-1" },
    el("div", { class: "vbar" }, el("span", { class: "vtitle" }, name, meta), el("span", { class: "spacer" }), download, jira, close), stage);
  box.addEventListener("keydown", (e) => {
    if (images.length > 1 && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
      e.preventDefault();
      show(at + (e.key === "ArrowLeft" ? -1 : 1));
    }
  });
  const m = showModal(box, { kind: "viewer" });
  m.ov.classList.add("vover");
  show(at);
  box.focus();
}
