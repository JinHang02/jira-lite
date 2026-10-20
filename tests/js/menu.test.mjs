// Regression test for menuKey: a list menu left open must not swallow keys typed into another text
// field (j/k/digits used to steer the stale menu instead of reaching the field).
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

// ---- a minimal DOM: just what menu.js and dom.js's el()/typingIn() touch ----
class FakeEl {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.parent = null;
    this.attrs = {};
    this.style = {};
    this.listeners = {};
    this.classList = { toggle() {}, add() {}, remove() {} };
    this.offsetWidth = 200;
    this.offsetHeight = 100;
    this.value = "";
  }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  removeAttribute(k) { delete this.attrs[k]; }
  getAttribute(k) { return this.attrs[k] ?? null; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  append(...kids) { for (const k of kids) if (k && typeof k === "object") { k.parent = this; this.children.push(k); } }
  replaceChildren(...kids) { this.children = []; this.append(...kids); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); this.parent = null; }
  contains(node) { for (let n = node; n; n = n.parent) if (n === this) return true; return false; }
  get isConnected() { let n = this; while (n.parent) n = n.parent; return n === globalThis.document.body; }
  matches(sel) { return sel.split(",").some((s) => s.trim().toLowerCase() === this.tagName.toLowerCase()); }
  getBoundingClientRect() { return { left: 10, right: 110, top: 10, bottom: 30 }; }
  scrollIntoView() {}
  focus() { globalThis.document.activeElement = this; }
  set className(v) { this.attrs.class = v; }
}
globalThis.Element = FakeEl;
globalThis.Node = FakeEl;
globalThis.innerWidth = 1440;
globalThis.innerHeight = 900;
const body = new FakeEl("body");
globalThis.document = {
  body,
  activeElement: body,
  listeners: {},
  createElement: (tag) => new FakeEl(tag),
  createElementNS: (_ns, tag) => new FakeEl(tag),
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
};

const { openMenu, menuKey, activeMenu, closeMenu, installMenuDismiss } = await import("../../web/js/menu.js");
installMenuDismiss();

const key = (k, target) => ({ key: k, target, preventDefault() {} });
const items = [{ label: "High" }, { label: "Medium" }, { label: "Low" }];

beforeEach(() => closeMenu());

test("j/k still steer the menu when focus is on the page", () => {
  openMenu(new FakeEl("button"), "priority", items, () => {});
  assert.equal(menuKey(key("j", body)), true);
  assert.ok(activeMenu());
});

test("typing in another text field closes the stale menu and lets the key through", () => {
  openMenu(new FakeEl("button"), "priority", items, () => {});
  const filter = new FakeEl("input");
  body.append(filter);
  for (const k of ["k", "j", "1", "Enter"]) {
    openMenu(new FakeEl("button"), "priority", items, () => {});
    assert.equal(menuKey(key(k, filter)), false, k + " must reach the field");
    assert.equal(activeMenu(), null);
  }
});

test("typing in the menu's own search box keeps the menu open", () => {
  openMenu(new FakeEl("button"), "assignee", items, () => {}, { search: true });
  const search = activeMenu().search;
  assert.equal(menuKey(key("j", search)), false);  // typed into the search, not navigation
  assert.ok(activeMenu());
});

test("focus moving into another text field closes the menu", () => {
  openMenu(new FakeEl("button"), "priority", items, () => {});
  const textarea = new FakeEl("textarea");
  body.append(textarea);
  for (const fn of document.listeners.focusin) fn({ target: textarea });
  assert.equal(activeMenu(), null);
});
