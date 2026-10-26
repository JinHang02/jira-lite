// Small DOM helpers. Nothing here touches `document` at import time.

const SVGNS = "http://www.w3.org/2000/svg";

export const $ = (sel) => document.querySelector(sel);

/** Builds an element. `on*` attrs become listeners; null/false attrs and children are skipped. */
export function el(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") e.className = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  for (const k of kids.flat(Infinity)) if (k != null && k !== false) e.append(k instanceof Node ? k : String(k));
  return e;
}

/** Inline SVG of size x size. `body` must be a fixed string from this codebase, never user data. */
export function icon(size, body, cls) {
  const s = document.createElementNS(SVGNS, "svg");
  s.setAttribute("width", size);
  s.setAttribute("height", size);
  s.setAttribute("viewBox", "0 0 " + size + " " + size);
  if (cls) s.setAttribute("class", cls);
  s.setAttribute("aria-hidden", "true");
  s.innerHTML = body;
  return s;
}

/** Shared 14px glyphs. */
export const ICONS = {
  check: '<path d="M3 7.5l2.5 2.5L11 4.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>',
  plus: '<path d="M7 2.5v9M2.5 7h9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
  sub: '<path d="M3 2v5.5a2 2 0 0 0 2 2h4M3 4.5h6" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><circle cx="10" cy="4.5" r="1.4" fill="currentColor"/><circle cx="10" cy="9.5" r="1.4" fill="currentColor"/>',
  up: '<path d="M7 11.5v-9M3.5 6L7 2.5 10.5 6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>',
  close: '<path d="M3.5 3.5l7 7M10.5 3.5l-7 7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
  chev: '<path d="M5 6.5l3 3 3-3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>',
};

let toastTimer;
/** Shows a transient message at the bottom of the screen; errors stay longer. */
export function toast(text, isErr) {
  const t = $("#toast");
  t.textContent = text;
  t.className = "show" + (isErr ? " err" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = isErr ? "err" : ""; }, isErr ? 8000 : 2500);
}

/** True if keyboard input on `node` is text entry (so global shortcuts should not fire). */
export function typingIn(node) {
  return node instanceof Element && node.matches("input, textarea, select, [contenteditable]");
}

/**
 * Returns a function giving `node`, or — once a re-render replaced it — the same element of the
 * re-rendered row/card/panel (same `data-key` host, same position among its kind), or null.
 * For menus that open after an await, during which the list may re-render.
 */
export function follow(node) {
  const host = node.closest("[data-key]");
  if (!host) return () => (node.isConnected ? node : null);
  const area = host.closest("#list, #board, #detail");
  const sel = (area ? "#" + area.id + " " : "") + "." + [...host.classList][0] + '[data-key="' + CSS.escape(host.dataset.key) + '"]';
  const idx = [...host.querySelectorAll(node.tagName)].indexOf(node);
  return () => {
    if (node.isConnected) return node;
    const h = document.querySelector(sel);
    return (h && h.querySelectorAll(node.tagName)[idx]) || null;
  };
}

/** The list row or board card showing `key`. */
export function rowFor(key) {
  return document.querySelector('[data-key="' + CSS.escape(key) + '"]:is(.row, .tcard)');
}
