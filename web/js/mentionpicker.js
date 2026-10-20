// "@" people picker for plain-text editors (comment composer, comment edit, description). Typing
// "@" opens a list anchored at the caret, filtered as you type from the project's assignable
// users (state.people); ↑/↓ move, Enter/Tab insert "@Display Name", Esc closes. Picked names are
// recorded in a Map "@Name" -> accountId that adf.textToAdf turns into mention nodes on save.
import { state } from "./state.js";
import { el } from "./dom.js";
import { avatar } from "./icons.js";
import { mentionQuery, matchPeople, insertMention, mentionToken } from "./mentions.js";

let open = null;  // {ta, box, people, idx, start}
const maps = new WeakMap();  // textarea -> its mention map
let scrollHooked = false;

/** Everyone who can be mentioned: assignable users, plus me if Jira didn't list me. */
function candidates() {
  const list = [...state.people];
  if (state.me && state.me.accountId && !list.some((u) => u.accountId === state.me.accountId)) list.push(state.me);
  return list;
}

/**
 * Adds the picker to `ta`. `mentions` (Map "@Name" -> accountId) is extended as people are
 * picked; pass the map of the doc being edited so existing mentions survive. Returns the map.
 * Its key handler runs in the capture phase, before the editor's own ⌘↵/Esc handlers.
 */
export function attachMentions(ta, mentions = new Map()) {
  maps.set(ta, mentions);
  if (!scrollHooked) {  // a scrolled panel would leave the list floating away from the caret
    scrollHooked = true;
    document.addEventListener("scroll", (e) => { if (open && !open.box.contains(e.target)) close(); }, true);
  }
  ta.addEventListener("keydown", (e) => onKey(e, ta), true);
  ta.addEventListener("input", () => update(ta));
  ta.addEventListener("click", () => update(ta));
  ta.addEventListener("keyup", (e) => { if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) update(ta); });
  ta.addEventListener("blur", () => { if (open && open.ta === ta) close(); });
  return mentions;
}

/** True while the picker is open (for tests/e2e and other key handlers). */
export const mentionPickerOpen = () => !!open;

function close() {
  if (!open) return;
  open.box.remove();
  open.ta.removeAttribute("aria-activedescendant");
  open = null;
}

function update(ta) {
  const caret = ta.selectionStart;
  const q = caret === ta.selectionEnd ? mentionQuery(ta.value, caret) : null;
  const people = q ? matchPeople(candidates(), q.query) : [];
  if (!q || !people.length) return close();
  if (!open || open.ta !== ta) {
    close();
    const box = el("div", { class: "menu mpick", role: "listbox", "aria-label": "Mention someone" });
    box.addEventListener("mousedown", (e) => e.preventDefault());  // keep the caret in the textarea
    document.body.append(box);
    open = { ta, box, people: [], idx: 0, start: q.start };
  }
  const keep = open.people[open.idx];
  open.start = q.start;
  open.people = people;
  open.idx = Math.max(0, keep ? people.findIndex((u) => u.accountId === keep.accountId) : 0);
  open.box.replaceChildren(...people.map((u, i) => {
    const b = el("button", { class: "mi", type: "button", role: "option", id: "mpick-" + i, tabindex: "-1" },
      avatar(u), el("span", { class: "grow" }, u.displayName));
    b.addEventListener("mousemove", () => hilite(i));
    b.addEventListener("click", () => pick(u));
    return b;
  }));
  hilite(open.idx);
  place(ta, q.start);
}

function hilite(i) {
  if (!open) return;
  const n = open.people.length;
  open.idx = (i + n) % n;
  [...open.box.children].forEach((b, j) => b.classList.toggle("hi", j === open.idx));
  open.ta.setAttribute("aria-activedescendant", "mpick-" + open.idx);
  open.box.children[open.idx].scrollIntoView({ block: "nearest" });
}

function pick(u) {
  if (!open) return;
  const { ta, start } = open;
  const mentions = maps.get(ta);
  const r = insertMention(ta.value, start, ta.selectionStart, u.displayName);
  close();
  ta.value = r.text;
  ta.setSelectionRange(r.caret, r.caret);
  if (mentions) mentions.set(mentionToken(u), u.accountId);
  ta.dispatchEvent(new Event("input", { bubbles: true }));  // let autosize/draft logic see it
  ta.focus();
}

function onKey(e, ta) {
  if (!open || open.ta !== ta) return;
  const k = e.key;
  if (k === "Enter" && (e.metaKey || e.ctrlKey)) { close(); return; }  // send/save goes through
  if (k === "ArrowDown") hilite(open.idx + 1);
  else if (k === "ArrowUp") hilite(open.idx - 1);
  else if (k === "Enter" || k === "Tab") pick(open.people[open.idx]);
  else if (k === "Escape") close();
  else return;
  e.preventDefault();
  e.stopImmediatePropagation();
}

/** Puts the list under the caret (above it when there's no room below). */
function place(ta, index) {
  const { x, y, h } = caretXY(ta, index);
  const box = open.box;
  const w = box.offsetWidth, bh = box.offsetHeight;
  box.style.left = Math.max(8, Math.min(x, innerWidth - w - 8)) + "px";
  box.style.top = (y + h + 4 + bh > innerHeight - 8 ? Math.max(8, y - bh - 4) : y + h + 4) + "px";
}

const MIRRORED = ["boxSizing", "width", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "borderTopWidth",
  "borderRightWidth", "borderBottomWidth", "borderLeftWidth", "fontFamily", "fontSize", "fontWeight", "fontStyle",
  "letterSpacing", "lineHeight", "textTransform", "wordSpacing", "tabSize", "textIndent"];

/** Viewport position {x, y, h} of character `index` in a textarea (mirror-div measurement). */
function caretXY(ta, index) {
  const cs = getComputedStyle(ta);
  const div = el("div", { "aria-hidden": "true" });
  for (const p of MIRRORED) div.style[p] = cs[p];
  Object.assign(div.style, { position: "absolute", visibility: "hidden", top: "0", left: "-9999px", whiteSpace: "pre-wrap", overflowWrap: "break-word", overflow: "hidden" });
  div.textContent = ta.value.slice(0, index);
  const mark = el("span", {}, ta.value.slice(index, index + 1) || ".");
  div.append(mark);
  document.body.append(div);
  const r = ta.getBoundingClientRect();
  const x = r.left + mark.offsetLeft - ta.scrollLeft;
  const y = r.top + mark.offsetTop - ta.scrollTop;
  const h = mark.offsetHeight || parseFloat(cs.lineHeight) || 18;
  div.remove();
  return { x, y, h };
}
