type Account = { id: string; email: string; displayName: string; emailVerifiedAt: string };
const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const panels = ["loading", "sign-in", "check-email", "verify-email", "profile"];
const requestedNext = new URLSearchParams(location.search).get("next");
const next = requestedNext && /^\/(?:admin|viewer)(?:\?|$)/.test(requestedNext) ? requestedNext : null;
let email = "";
let token: string | null = null;
function readLink() {
  token = new URLSearchParams(location.hash.slice(1)).get("verify");
  if (location.hash) history.replaceState(null, "", location.pathname + location.search);
}
readLink();
let timer: ReturnType<typeof setInterval> | undefined;
let busy = false;

function show(panel: string) {
  for (const id of panels) el(id).hidden = id !== panel;
  for (const id of ["error", "status"]) { el(id).hidden = true; el(id).textContent = ""; }
}
function message(id: "error" | "status", text: string) { el(id).textContent = text; el(id).hidden = false; }
async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api/auth/${path}`, {
    method: body === undefined ? "GET" : "POST", credentials: "same-origin", cache: "no-store",
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) {
    if (response.status === 401) show("sign-in");
    throw new Error(result.error || "Something went wrong. Please try again.");
  }
  return result as T;
}
async function action(button: HTMLButtonElement, fn: () => Promise<void>) {
  if (busy) return;
  busy = true;
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  el("error").hidden = true;
  el("status").hidden = true;
  try { await fn(); }
  catch (error) { message("error", error instanceof TypeError ? "Unable to connect. Check your connection and try again." : (error as Error).message); }
  finally { busy = false; button.disabled = false; button.removeAttribute("aria-busy"); }
}
function profile(user: Account) {
  if (next) { location.replace(next); return; }
  show("profile");
  el("account-email").textContent = user.email;
  el<HTMLInputElement>("display-name").value = user.displayName;
}
function cooldown(seconds: number) {
  clearInterval(timer);
  const button = el<HTMLButtonElement>("resend");
  const until = Date.now() + seconds * 1000;
  const tick = () => {
    const remaining = Math.max(0, Math.ceil((until - Date.now()) / 1000));
    button.disabled = remaining > 0;
    button.textContent = remaining ? `Send another link in ${remaining}s` : "Send another link";
    if (!remaining) clearInterval(timer);
  };
  tick(); timer = setInterval(tick, 1000);
}
async function sendLink() {
  const response = await api<{ retryAfter: number }>("email", { email, next });
  show("check-email"); el("sent-email").textContent = email;
  cooldown(response.retryAfter);
}
el<HTMLFormElement>("email-form").addEventListener("submit", event => {
  event.preventDefault(); email = el<HTMLInputElement>("email").value.trim();
  void action(el<HTMLButtonElement>("send-link"), sendLink);
});
el("resend").addEventListener("click", () => {
  void action(el<HTMLButtonElement>("resend"), sendLink).then(() => {
    // action's finalizer reenables its button; restore the send cooldown.
    if (!el("check-email").hidden && el("error").hidden) cooldown(60);
  });
});
for (const id of ["different-email", "cancel-verify"]) el(id).addEventListener("click", () => { token = null; show("sign-in"); el("email").focus(); });
el("confirm-verify").addEventListener("click", () => void action(el<HTMLButtonElement>("confirm-verify"), async () => {
  const result = await api<{ user: Account }>("verify", { token }); token = null; profile(result.user);
  message("status", "You’re signed in. Your email is verified.");
}));
el<HTMLFormElement>("profile-form").addEventListener("submit", event => {
  event.preventDefault();
  void action(el("profile-form").querySelector("button")!, async () => {
    const result = await api<{ user: Account }>("profile", { displayName: el<HTMLInputElement>("display-name").value });
    profile(result.user); message("status", "Your name has been saved.");
  });
});
for (const id of ["logout", "logout-all"]) el(id).addEventListener("click", () => void action(el<HTMLButtonElement>(id), async () => {
  await api(id, {}); show("sign-in"); el<HTMLInputElement>("display-name").value = ""; el("account-email").textContent = "";
  message("status", id === "logout-all" ? "You’re signed out on all devices." : "You’re signed out.");
}));
async function initialize() {
  try {
    if (token) {
      const result = await api<{ email: string }>("preview", { token });
      show("verify-email"); el("verify-address").textContent = result.email;
    } else {
      const result = await api<{ user: Account | null }>("session");
      if (result.user) profile(result.user); else show("sign-in");
    }
  } catch (error) { token = null; show("sign-in"); message("error", error instanceof TypeError ? "Unable to connect. Check your connection and try again." : (error as Error).message); }
}
window.addEventListener("pageshow", event => { if (event.persisted) { show("loading"); void initialize(); } });
window.addEventListener("hashchange", () => { readLink(); show("loading"); void initialize(); });
void initialize();
