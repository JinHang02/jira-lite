// "Keyboard shortcuts" dialog (? or the sidebar's help button).
import { el, icon, ICONS } from "./dom.js";
import { showModal, closeModal, activeModal } from "./modal.js";
import { shortcutGroups } from "./shortcuts.js";

/** True on Apple platforms, where the modifier is ⌘ (Ctrl elsewhere). */
export const isMac = () => /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent || "");

export const helpOpen = () => (activeModal() || {}).kind === "help";

/** Opens the dialog, or closes it when it's already open. Does nothing over another dialog. */
export function toggleHelp() {
  if (helpOpen()) return closeModal();
  if (activeModal()) return;
  const combo = (caps) => el("span", { class: "combo" }, caps.map((c) => el("kbd", {}, c)));
  const keys = (alts) => el("span", { class: "keys" }, alts.flatMap((c, n) => (n ? [el("span", { class: "or" }, "or"), combo(c)] : [combo(c)])));
  const groups = shortcutGroups(isMac()).map((g) => el("section", { class: "kgroup" },
    el("h3", {}, g.title),
    g.items.map((it) => el("div", { class: "krow" }, el("span", {}, it.label), keys(it.keys)))));
  const close = el("button", { class: "btn icon ghost", "aria-label": "Close", title: "Close (Esc)", onclick: closeModal }, icon(14, ICONS.close, ""));
  const dlg = el("div", { class: "modal help", role: "dialog", "aria-modal": "true", "aria-labelledby": "helpTitle", tabindex: "-1" },
    el("div", { class: "help-h" }, el("h2", { id: "helpTitle" }, "Keyboard shortcuts"), close),
    el("div", { class: "help-b" }, groups));
  const back = document.activeElement;
  showModal(dlg, { kind: "help", onClose: () => { if (back && back.isConnected && back.focus) back.focus({ preventScroll: true }); } });
  dlg.focus();
}
