// "Sign in with Atlassian" (OAuth mode): the sign-in screen, session expiry and sign-out.
import * as jira from "./api.js";
import { state, stash } from "./state.js";
import { $, el, icon, toast } from "./dom.js";
import { logo } from "./icons.js";
import { closeMenu } from "./menu.js";
import { closeModal } from "./modal.js";
import { stashCreateDraft } from "./create.js";

const SIGNIN_ICON = '<path d="M6.5 2.5h-2a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2M10 5l3 3-3 3M13 8H6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>';

/** True when the server signs each user in with Atlassian (else it uses one shared API token). */
export const oauthMode = () => state.cfg.auth === "oauth";

/** Replaces the app with the sign-in card. Stops auto-refresh (state.signedOut). */
export function showSignIn() {
  state.signedOut = true;
  if ($("#signin")) return;
  const { site } = state.cfg;
  const host = (site || "").replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const go = el("button", { class: "btn primary big", id: "signinBtn" }, icon(16, SIGNIN_ICON, ""), "Sign in with Atlassian");
  go.addEventListener("click", () => {
    go.disabled = true;
    location.assign(jira.LOGIN_URL);
  });
  const card = el("div", { class: "signin-card", role: "dialog", "aria-labelledby": "signinTitle" },
    logo(40, "big"),
    el("h1", { id: "signinTitle" }, "Sign in to jira-lite"),
    el("p", { class: "where" }, host),
    go,
    el("p", { class: "note" }, "You'll act as yourself in Jira"));
  document.body.append(el("div", { id: "signin" }, card));
  document.body.classList.add("signed-out");
  document.title = "Sign in · jira-lite";
  go.focus();
}

/**
 * The session ended mid-use (an API call said "login required"): keep unsent drafts and the
 * open issue in sessionStorage for after the sign-in round trip, then show the sign-in screen.
 */
export function requireLogin() {
  if (state.signedOut) return;
  state.signedOut = true;
  const box = $("#cbox");
  if (box && box.value.trim()) stash("commentDraft", JSON.stringify({ key: box.dataset.key, text: box.value }));
  closeMenu();
  closeModal();  // the create dialog keeps its draft on close
  stashCreateDraft();
  if (state.current) stash("returnTo", state.current);
  showSignIn();
}

/** Signs out on the server, then shows the sign-in screen. */
export async function signOut() {
  try {
    await jira.logout();
  } catch (e) {
    return toast("Sign out failed: " + e.message, true);
  }
  state.me = null;
  closeMenu();
  closeModal();
  showSignIn();
}
