// Popover menu anchored to a button (status / priority / assignee pickers). One open at a time.
import { el, icon, ICONS } from "./dom.js";

let menu = null;  // {box, search, buttons, idx}

/** The open menu, or null. */
export const activeMenu = () => menu;

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
  const r = anchor.getBoundingClientRect();
  const w = box.offsetWidth, h = box.offsetHeight;
  box.style.left = Math.max(8, Math.min(r.left, innerWidth - w - 8)) + "px";
  box.style.top = (r.bottom + 4 + h > innerHeight - 8 ? Math.max(8, r.top - h - 4) : r.bottom + 4) + "px";
  if (search) search.focus();
}

/** Highlights item n (wrapping around). */
export function hilite(n) {
  if (!menu || !menu.buttons.length) return;
  menu.idx = (n + menu.buttons.length) % menu.buttons.length;
  menu.buttons.forEach((b, i) => b.classList.toggle("hi", i === menu.idx));
  menu.buttons[menu.idx].scrollIntoView({ block: "nearest" });
}

export function closeMenu() {
  if (menu) { menu.box.remove(); menu = null; }
}

/** Keyboard handling while a menu is open. Returns true if the key was consumed. */
export function menuKey(e) {
  if (!menu) return false;
  const k = e.key;
  const typing = menu.search && e.target === menu.search;
  if (k === "ArrowDown" || (!typing && k === "j")) hilite(menu.idx + 1);
  else if (k === "ArrowUp" || (!typing && k === "k")) hilite(menu.idx - 1);
  else if (k === "Enter") { if (menu.buttons[menu.idx]) menu.buttons[menu.idx].click(); }
  else if (k === "Escape") closeMenu();
  else if (!typing && /^[1-9]$/.test(k) && menu.buttons[k - 1]) menu.buttons[k - 1].click();
  else return false;
  return true;
}

/** Closes the menu on a click outside it. */
export function installMenuDismiss() {
  document.addEventListener("mousedown", (e) => { if (menu && !menu.box.contains(e.target)) closeMenu(); });
}
