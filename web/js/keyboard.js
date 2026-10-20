// Global keyboard shortcuts (Linear-style). The list shown to users is shortcuts.js (press ?).
import { state } from "./state.js";
import { $, rowFor, typingIn } from "./dom.js";
import { menuKey, installMenuDismiss, activeMenu } from "./menu.js";
import { activeModal, closeModal } from "./modal.js";
import { openPalette, paletteOpen } from "./palette.js";
import { toggleHelp, helpOpen } from "./help.js";
import { toggleSidebar, closeDrawer } from "./sidebar.js";
import { setCursor, move } from "./cursor.js";
import { statusMenu, priorityMenu, assigneeMenu } from "./edits.js";
import { clearFilter } from "./views.js";
import { toggleSelect, extendBy, selectAll, clearSelection, hasSelection, bulkKey } from "./selection.js";
import { actions } from "./actions.js";

function onKey(e) {
  const k = e.key;
  const mod = e.metaKey || e.ctrlKey;
  if (mod && k.toLowerCase() === "k") { e.preventDefault(); if (paletteOpen()) closeModal(); else openPalette(); return; }
  if (mod && k.toLowerCase() === "b" && !activeModal()) { e.preventDefault(); actions.setView(state.view === "board" ? "list" : "board"); return; }
  if (menuKey(e)) { e.preventDefault(); return; }
  if (activeMenu()) return;  // a popover (Display) is open: its controls get the keys
  if (activeModal()) {
    if (k === "Escape" || (k === "?" && helpOpen())) { e.preventDefault(); closeModal(); }
    return;
  }
  if (typingIn(e.target)) {
    if (k === "Escape") {
      if (e.target.id === "q" && e.target.value) clearFilter();
      else e.target.blur();
    } else if (k === "Enter" && e.target.id === "q") {
      e.target.blur();
      if (state.visible.length) setCursor(state.visible[0], true);
    }
    return;
  }
  if (mod && !e.altKey && !e.shiftKey && k.toLowerCase() === "a") { e.preventDefault(); selectAll(); return; }
  if (mod || e.altKey) return;
  if (e.shiftKey && (k === "ArrowDown" || k === "ArrowUp")) { e.preventDefault(); extendBy(k === "ArrowDown" ? 1 : -1); return; }
  // With a multi-selection, s / p / a / l open the selection bar's menus instead.
  if (hasSelection() && ["s", "p", "a", "l"].includes(k) && bulkKey(k)) { e.preventDefault(); return; }
  const target = state.current || state.cursor;
  // In the detail panel menus anchor to the property chips; otherwise to the row's buttons.
  const anchor = (id, sel) => (state.current && $(id)) || (rowFor(target) && (rowFor(target).querySelector(sel) || rowFor(target)));
  switch (k) {
    case "j": case "ArrowDown": move(1); break;
    case "k": case "ArrowUp": move(-1); break;
    case "J": if (e.shiftKey) extendBy(1); else move(1); break;
    case "K": if (e.shiftKey) extendBy(-1); else move(-1); break;
    case "x": toggleSelect(target); break;
    case "Enter": case "o":
      // Enter on a focused button (header, sidebar, group header) activates it instead.
      if (k === "Enter" && e.target instanceof Element && e.target.closest("button, a, [role=button]")) return;
      if (state.cursor) actions.openIssue(state.cursor);
      break;
    case "Escape":
      if (closeDrawer()) break;
      if (clearSelection()) break;
      if (state.current) actions.closeDetail();
      else if (state.filter) clearFilter();
      break;
    case "c": actions.openCreate(null); break;
    case "/": $("#q").focus(); $("#q").select(); break;
    case "?": toggleHelp(); break;
    case "[": toggleSidebar(); break;
    case "s": if (target && anchor("#schip", ".ibtn:nth-of-type(2)")) statusMenu(target, anchor("#schip", ".ibtn:nth-of-type(2)")); break;
    case "p": if (target && anchor("#pchip", ".ibtn")) priorityMenu(target, anchor("#pchip", ".ibtn")); break;
    case "a": if (target && anchor("#achip", ".rright .ibtn")) assigneeMenu(target, anchor("#achip", ".rright .ibtn")); break;
    case "m": if (state.current && $("#cbox")) $("#cbox").focus(); break;
    case "r": actions.refresh(); break;
    default: return;
  }
  e.preventDefault();
}

export function installKeyboard() {
  document.addEventListener("keydown", onKey);
  installMenuDismiss();
}
