// Image viewer overlay, like Jira's media viewer: the image fitted to the window, its name and
// size, ←/→ through the issue's images, Download and Open in Jira. Zoom: click the image (at that
// point), pinch or ⌘/ctrl-scroll, +/−/0 or the bar buttons; drag or scroll to pan.
// Esc or a click outside the image closes it.
import { el, icon, ICONS } from "./dom.js";
import { showModal, closeModal } from "./modal.js";
import { fileUrl, formatSize, isImage, sortAttachments } from "./attachments.js";
import { FIT, zoomTo, clampView } from "./zoom.js";

const PREV = '<path d="M8.5 3L4.5 7l4 4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>';
const NEXT = '<path d="M5.5 3l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>';

/** Opens attachment `id` of `attachments` (an issue's fields.attachment); `jiraUrl` is the issue in Jira. */
export function openViewer(attachments, id, jiraUrl) {
  const images = sortAttachments((attachments || []).filter(isImage));
  let at = Math.max(0, images.findIndex((a) => String(a.id) === String(id)));
  if (!images.length) return;
  const img = el("img", { class: "vimg", alt: "", draggable: "false" });
  const name = el("span", { class: "vw-name" });
  const meta = el("span", { class: "vw-meta" });
  const download = el("a", { class: "btn", target: "_blank", rel: "noopener", title: "Download the original" }, "Download");
  const jira = el("a", { class: "btn", href: jiraUrl, target: "_blank", rel: "noopener", title: "Open the issue in Jira" }, "Open in Jira ↗");
  const zbtn = (label, text, onclick) => el("button", { class: "btn vzoom", type: "button", title: label, "aria-label": label, onclick }, text);
  const level = zbtn("Fit to window (0)", "", () => apply(FIT));
  level.classList.add("vlevel");
  const zoomOut = zbtn("Zoom out (−)", "−", () => zoomBy(1 / 1.5));
  const zoomIn = zbtn("Zoom in (+)", "+", () => zoomBy(1.5));
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
    apply(FIT);
    img.src = fileUrl(a.id);
    img.alt = a.filename;
    name.textContent = a.filename;
    meta.textContent = [formatSize(a.size), images.length > 1 ? at + 1 + " of " + images.length : ""].filter(Boolean).join(" · ");
    download.href = fileUrl(a.id);
  };

  // Zoom state: `view` is the transform over the fitted image (zoom.js); fitted size = offsetWidth/Height.
  let view = FIT, drag = null, dragged = false;
  const maxScale = () => Math.max(8, img.naturalWidth / (img.offsetWidth || 1));
  const apply = (v) => {
    view = clampView(v, img.offsetWidth, img.offsetHeight, stage.clientWidth, stage.clientHeight);
    img.style.transform = view.s === 1 ? "" : `translate(${view.x}px, ${view.y}px) scale(${view.s})`;
    stage.classList.toggle("zoomed", view.s > 1);
    const pct = img.naturalWidth ? Math.round((view.s * img.offsetWidth / img.naturalWidth) * 100) : 0;
    level.textContent = pct ? pct + "%" : "Fit";
  };
  // A pointer position relative to the fitted image's centre, which is where zoom.js measures from.
  const at0 = (e) => {
    const r = stage.getBoundingClientRect();
    return [e.clientX - r.left - img.offsetLeft - img.offsetWidth / 2, e.clientY - r.top - img.offsetTop - img.offsetHeight / 2];
  };
  const zoomBy = (k, p) => apply(zoomTo(view, view.s * k, p ? p[0] : 0, p ? p[1] : 0, maxScale()));
  img.addEventListener("load", () => apply(view));
  img.addEventListener("click", (e) => {
    e.stopPropagation();
    if (dragged) return;
    // Fitted → full size (at least 2×) at the clicked point; zoomed → back to fit.
    if (view.s > 1) apply(FIT);
    else apply(zoomTo(view, Math.max(2, img.naturalWidth / img.offsetWidth), ...at0(e), maxScale()));
  });
  stage.addEventListener("wheel", (e) => {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) zoomBy(Math.exp(-e.deltaY * 0.01), at0(e));  // trackpad pinch arrives as ctrl+wheel
    else if (view.s > 1) apply({ s: view.s, x: view.x - e.deltaX, y: view.y - e.deltaY });
  }, { passive: false });
  // Safari reports trackpad pinch as gesture events, not ctrl+wheel.
  let pinch0 = 1;
  stage.addEventListener("gesturestart", (e) => { e.preventDefault(); pinch0 = view.s; });
  stage.addEventListener("gesturechange", (e) => { e.preventDefault(); apply(zoomTo(view, pinch0 * e.scale, ...at0(e), maxScale())); });
  img.addEventListener("pointerdown", (e) => {
    dragged = false;
    if (view.s === 1 || e.button) return;
    drag = { px: e.clientX, py: e.clientY, x: view.x, y: view.y };
    img.setPointerCapture(e.pointerId);
    stage.classList.add("dragging");
  });
  img.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.px, dy = e.clientY - drag.py;
    if (Math.abs(dx) + Math.abs(dy) > 3) dragged = true;
    apply({ s: view.s, x: drag.x + dx, y: drag.y + dy });
  });
  const endDrag = () => { drag = null; stage.classList.remove("dragging"); };
  img.addEventListener("pointerup", endDrag);
  img.addEventListener("pointercancel", endDrag);
  stage.addEventListener("click", (e) => { if (e.target === stage) closeModal(); });

  const box = el("div", { class: "viewer", role: "dialog", "aria-label": "Image viewer", tabindex: "-1" },
    el("div", { class: "vbar" }, el("span", { class: "vtitle" }, name, meta), el("span", { class: "spacer" }),
      el("span", { class: "vzooms" }, zoomOut, level, zoomIn), download, jira, close), stage);
  box.addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "+" || e.key === "=") zoomBy(1.5);
    else if (e.key === "-") zoomBy(1 / 1.5);
    else if (e.key === "0") apply(FIT);
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
