// Popover menu anchored to a button (status / priority / assignee pickers), and free-form popovers
// (the Display options). One open at a time.
import { el, icon, ICONS, typingIn } from "./dom.js";

let menu = null;  // {box, search, buttons, idx, popover?, anchor?}

/** The open menu or popover, or null. */
export const activeMenu = () => menu;

/** Positions `box` under `anchor` (above it if there's no room); align "end" lines up right edges. */
function place(box, anchor, align) {
  const r = anchor.getBoundingClientRect();
  const w = box.offsetWidth, h = box.offsetHeight;
  const left = align === "end" ? r.right - w : r.left;
  box.style.left = Math.max(8, Math.min(left, innerWidth - w - 8)) + "px";
  if (r.bottom + 4 + h > innerHeight - 8 && r.top - h - 12 >= 8) {
    // Above the anchor, pinned by its bottom edge so content that grows later (filtering) grows upwards.
    box.style.top = "auto";
    box.style.bottom = (innerHeight - r.top + 12) + "px";  // clears the selection bar's frame too
  } else {
    box.style.top = (r.bottom + 4 + h > innerHeight - 8 ? Math.max(8, r.top - h - 4) : r.bottom + 4) + "px";
  }
}

/**
 * Opens a menu under `anchor`.
 * @param items [{label, icon?, via?, current?, ...}] — the picked item is passed to onPick.
 * @param opts {search?: boolean, empty?: string}
 */
export function openMenu(anchor, title, items, onPick, opts = {}) {
  closeMenu();
  const box = el("div", { class: "menu", role: "menu" }, el("div", { class: "mh" }, title));
  const search = opts.search ? el("input", { class: "msearch", placeholder: "Filter…", autocomplete: "off" }) : null;
  const list = el("div", { class: "mlist" });
  if (search) box.append(search);
  box.append(list);
  const m = { box, search, buttons: [], idx: 0 };
  menu = m;
  const fill = () => {
    const q = search ? search.value.trim().toLowerCase() : "";
    const hits = items.filter((it) => !q || it.label.toLowerCase().includes(q));
    m.buttons = hits.map((it, n) => {
      const b = el("button", { class: "mi", role: "menuitem" }, it.icon || null, el("span", { class: "grow" }, it.label),
        it.via ? el("span", { class: "via" }, it.via) : null,
        it.current ? icon(14, ICONS.check, "") : !search && n < 9 ? el("kbd", {}, String(n + 1)) : null);
      b.addEventListener("mousemove", () => hilite(n));
      b.addEventListener("click", () => { closeMenu(); onPick(it); });
      return b;
    });
    list.replaceChildren(...(m.buttons.length ? m.buttons : [el("div", { class: "mh" }, opts.empty || "No matches")]));
    hilite(Math.max(0, hits.findIndex((it) => it.current && !q)));
  };
  if (search) search.addEventListener("input", fill);
  fill();
  document.body.append(box);
  place(box, anchor);
  if (search) search.focus();
}

/**
 * Opens a free-form popover (its own controls, no item list) under `anchor`, which gets
 * aria-expanded. Only Escape is handled for it (see menuKey); global shortcuts are suppressed
 * while it is open. Returns the popover element.
 * @param opts {label?: string, cls?: string, align?: "start" | "end", onClose?: () => void}
 */
export function openPopover(anchor, content, opts = {}) {
  closeMenu();
  const box = el("div", { class: "menu pop " + (opts.cls || ""), role: "dialog", "aria-label": opts.label || null }, content);
  menu = { box, search: null, buttons: [], idx: 0, popover: true, anchor, onClose: opts.onClose };
  anchor.setAttribute("aria-expanded", "true");
  document.body.append(box);
  place(box, anchor, opts.align);
  return box;
}

/** Highlights item n (wrapping around). */
export function hilite(n) {
  if (!menu || !menu.buttons.length) return;
  menu.idx = (n + menu.buttons.length) % menu.buttons.length;
  menu.buttons.forEach((b, i) => b.classList.toggle("hi", i === menu.idx));
  menu.buttons[menu.idx].scrollIntoView({ block: "nearest" });
}

export function closeMenu() {
  if (!menu) return;
  const done = menu.onClose;
  if (menu.anchor) menu.anchor.setAttribute("aria-expanded", "false");
  menu.box.remove();
  menu = null;
  if (done) done();
}

/**
 * Keyboard handling while a menu is open. Returns true if the key was consumed. For a popover
 * only Escape is consumed (it closes and refocuses the anchor); other keys reach its controls.
 */
export function menuKey(e) {
  if (!menu) return false;
  // Focus has moved to a text field outside the menu (Tab, or a programmatic focus): the menu is
  // stale. Close it and let the key be typed instead of steering the menu (j/k/digits/Enter).
  if (typingIn(e.target) && !menu.box.contains(e.target)) {
    closeMenu();
    return false;
  }
  const k = e.key;
  if (menu.popover) {
    if (k !== "Escape") return false;
    const a = menu.anchor;
    closeMenu();
    if (a) a.focus();
    return true;
  }
  const typing = menu.search && e.target === menu.search;
  if (k === "ArrowDown" || (!typing && k === "j")) hilite(menu.idx + 1);
  else if (k === "ArrowUp" || (!typing && k === "k")) hilite(menu.idx - 1);
  else if (k === "Enter") { if (menu.buttons[menu.idx]) menu.buttons[menu.idx].click(); }
  else if (k === "Escape") closeMenu();
  else if (!typing && /^[1-9]$/.test(k) && menu.buttons[k - 1]) menu.buttons[k - 1].click();
  else return false;
  return true;
}

/** Closes the menu on a click outside it (a click on a popover's own anchor toggles it instead). */
export function installMenuDismiss() {
  document.addEventListener("mousedown", (e) => {
    if (!menu || menu.box.contains(e.target)) return;
    if (menu.anchor && menu.anchor.contains(e.target)) return;  // the anchor's click handler toggles
    closeMenu();
  });
  // Keyboard focus leaving for another text field closes the menu too (a click already does).
  document.addEventListener("focusin", (e) => {
    if (!menu || menu.box.contains(e.target) || (menu.anchor && menu.anchor.contains(e.target))) return;
    if (typingIn(e.target)) closeMenu();
  });
}
