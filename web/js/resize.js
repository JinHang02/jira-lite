// Drag handle between the list and the detail panel: drag it (or ←/→ while it has focus) to
// resize the panel, double-click to go back to the default width. Remembered as jl.detailWidth.
import { state, store } from "./state.js";
import { $, el } from "./dom.js";

const MIN = 400;       // the panel's own min-width (detail.css)
const LIST_MIN = 320;  // room the list keeps
const STEP = 32;

export function bindResize() {
  const body = $("#body"), detail = $("#detail");
  const handle = el("div", { id: "dsplit", role: "separator", tabindex: "0", "aria-orientation": "vertical", "aria-controls": "detail",
    "aria-label": "Resize the issue panel", title: "Drag to resize · double-click to reset" });
  body.insertBefore(handle, detail);
  // The list keeps LIST_MIN first; on narrow windows the panel may go below MIN (down to 280).
  const clamp = (w) => Math.round(Math.max(280, Math.min(Math.max(w, MIN), body.clientWidth - LIST_MIN)));
  const apply = () => {
    const w = state.detailWidth ? clamp(state.detailWidth) : 0;
    body.style.setProperty("--detail-w", w ? w + "px" : "");
    body.style.setProperty("--detail-max", w ? "none" : "");
    if (w) handle.setAttribute("aria-valuenow", String(w));
    else handle.removeAttribute("aria-valuenow");
  };
  const set = (w, save) => {
    state.detailWidth = w ? clamp(w) : 0;
    apply();
    if (save) store("detailWidth", state.detailWidth ? String(state.detailWidth) : "");
  };

  handle.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    document.body.classList.add("resizing");
    const right = body.getBoundingClientRect().right;
    const move = (ev) => set(right - ev.clientX, false);
    const end = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", end);
      document.body.classList.remove("resizing");
      set(state.detailWidth, true);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  });
  handle.addEventListener("dblclick", () => set(0, true));
  handle.addEventListener("keydown", (e) => {
    const d = { ArrowLeft: STEP, ArrowRight: -STEP }[e.key];
    if (!d) return;
    e.preventDefault();
    e.stopPropagation();  // not the list's shortcuts
    set(detail.getBoundingClientRect().width + d, true);
  });
  addEventListener("resize", apply);  // keep the list's share when the window narrows
  apply();
}
