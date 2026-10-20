// Full-screen overlay hosting one dialog at a time (create dialog, command palette).
import { el } from "./dom.js";
import { closeMenu } from "./menu.js";

let modal = null;  // {ov, onClose, kind}

/** The open modal, or null. `kind` tells callers which dialog it is. */
export const activeModal = () => modal;

/** Shows `content` in an overlay; clicking the backdrop closes it. `onClose` runs on any close. */
export function showModal(content, { kind = "", onClose } = {}) {
  closeMenu();
  closeModal();
  const ov = el("div", { class: "overlay" }, content);
  ov.addEventListener("mousedown", (e) => { if (e.target === ov) closeModal(); });
  document.body.append(ov);
  modal = { ov, onClose, kind };
  return modal;
}

export function closeModal() {
  if (!modal) return;
  const m = modal;
  modal = null;
  if (m.onClose) m.onClose();
  m.ov.remove();
}
