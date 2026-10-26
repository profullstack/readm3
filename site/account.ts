type Account = { id: string; email: string | null; displayName: string; emailVerifiedAt: string | null };
type CoinPayStatus = { enabled: boolean; identities: { providerUserId: string; email: string | null }[]; canUnlink: boolean };
const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const panels = ["loading", "sign-in", "check-email", "verify-email", "profile"];
const requestedNext = new URLSearchParams(location.search).get("next");
const next = requestedNext && /^\/(?:admin|viewer|oauth\/authorize)(?:\?|$)/.test(requestedNext) ? requestedNext : null;
let email = "";
let token: string | null = null;
/** "Create an account" adds the shared profile fields to the email form; plain sign-in never asks for them. */
let signup = false;
const PROFILE_FIELDS = ["first_name", "last_name", "company_domain", "job_title", "linkedin_url"] as const;
const fieldValues = (prefix: string) =>
  Object.fromEntries(PROFILE_FIELDS.map(name => [name, el<HTMLInputElement>(`${prefix}${name}`).value]));
function setSignup(on: boolean) {
  signup = on;
  el("signup-fields").hidden = !on;
  // A disabled fieldset's required boxes do not block a plain sign-in.
  el("signup-fields").querySelector("fieldset")!.disabled = !on;
  el("signup-toggle").textContent = on ? "Already have an account? Sign in" : "New to readm3? Create an account";
  el("signup-toggle").setAttribute("aria-expanded", String(on));
}
function readLink() {
  token = new URLSearchParams(location.hash.slice(1)).get("verify");
  if (location.hash) history.replaceState(null, "", location.pathname + location.search);
}
readLink();
// The CoinPay callback comes back here with ?coinpay=linked or ?coinpay_error=…; read it once, then drop it.
const returned = new URLSearchParams(location.search);
const coinpayNotice = returned.get("coinpay_error") ? { id: "error" as const, text: returned.get("coinpay_error")! }
  : returned.get("coinpay") === "linked" ? { id: "status" as const, text: "Your CoinPay account is linked." } : null;
if (coinpayNotice) {
  returned.delete("coinpay_error"); returned.delete("coinpay");
  history.replaceState(null, "", location.pathname + (returned.size ? `?${returned}` : "") + location.hash);
}
/** Inside the desktop app (desktop/preload.cjs): sign in through the system browser, where the password manager is. */
const desktop = (window as unknown as { readm3Desktop?: { signInWithBrowser?: () => Promise<void> } }).readm3Desktop;
const inDesktop = typeof desktop?.signInWithBrowser === "function";
let timer: ReturnType<typeof setInterval> | undefined;
let busy = false;

function show(panel: string) {
  for (const id of panels) el(id).hidden = id !== panel;
  for (const id of ["error", "status"]) { el(id).hidden = true; el(id).textContent = ""; }
  if (panel === "sign-in" || panel === "profile") void coinpay(panel);
}
/** The Sign in with CoinPay button, or the linked/unlink control; both hidden when the server has no CoinPay client. */
async function coinpay(panel: string) {
  let status: CoinPayStatus;
  try {
    const response = await fetch("/api/v1/coinpay/status", { credentials: "same-origin", cache: "no-store" });
    status = await response.json();
    if (!response.ok) return;
  } catch { return; }
  const button = el<HTMLAnchorElement>("coinpay-sign-in");
  // In the desktop app CoinPay's page would open in this window, with no password manager.
  button.hidden = !status.enabled || panel !== "sign-in" || inDesktop;
  button.href = `/api/v1/coinpay/oauth/start${next ? `?next=${encodeURIComponent(next)}` : ""}`;
  const linked = status.identities[0];
  el("coinpay-link").hidden = panel !== "profile" || (!status.enabled && !linked);
  el("coinpay-linked").textContent = linked ? `CoinPay linked${linked.email ? ` (${linked.email})` : ""}.${status.canUnlink ? "" : " It is this account’s only sign-in, so it cannot be unlinked."}` : "No CoinPay account linked.";
  el("coinpay-connect").hidden = !!linked || !status.enabled;
  el("coinpay-unlink").hidden = !linked || !status.canUnlink;
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
  el("account-email").textContent = user.email ?? "Signed in with CoinPay";
  el("verified-badge").textContent = user.email ? "Email verified" : "CoinPay account";
  el<HTMLInputElement>("display-name").value = user.displayName;
  void loadDetails();
}
async function profileApi(method: "GET" | "PATCH", body?: unknown) {
  const response = await fetch("/api/v1/me/profile", {
    method, credentials: "same-origin", cache: "no-store",
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.errors ? Object.values(result.errors)[0] as string : result.error || "Could not save your details.");
  return result as { profile: Record<string, string | null> | null };
}
async function loadDetails() {
  try {
    const { profile } = await profileApi("GET");
    for (const name of PROFILE_FIELDS) el<HTMLInputElement>(`details-${name}`).value = profile?.[name] ?? "";
  } catch { /* the fields stay empty; saving still works */ }
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
  const response = await api<{ retryAfter: number }>("email", { email, next, ...(signup ? { mode: "signup", ...fieldValues("signup-") } : {}) });
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
el("signup-toggle").addEventListener("click", () => { setSignup(!signup); el(signup ? "signup-first_name" : "email").focus(); });
el<HTMLFormElement>("details-form").addEventListener("submit", event => {
  event.preventDefault();
  void action(el("details-form").querySelector("button")!, async () => {
    await profileApi("PATCH", fieldValues("details-"));
    await loadDetails(); message("status", "Your details have been saved.");
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
el("coinpay-unlink").addEventListener("click", () => void action(el<HTMLButtonElement>("coinpay-unlink"), async () => {
  const response = await fetch("/api/v1/coinpay/unlink", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: "{}" });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Could not unlink CoinPay.");
  await coinpay("profile"); message("status", "CoinPay is unlinked. Sign in with your email from now on.");
}));
if (inDesktop) {
  // An emailed link opens in the browser and would sign the browser in, not this app.
  el("email-form").hidden = true;
  el("signup-toggle").hidden = true;
  el("desktop-sign-in").hidden = false;
  const fine = document.querySelector<HTMLElement>("#sign-in .fine-print");
  if (fine) fine.textContent = "Your browser opens readm3.com. Sign in there with your email or CoinPay, approve the desktop app, and come back.";
  el("desktop-sign-in").addEventListener("click", () => void action(el<HTMLButtonElement>("desktop-sign-in"), async () => {
    message("status", "Finish signing in in your browser, then come back here.");
    // Electron prefixes errors from the main process; show only the reason.
    try { await desktop!.signInWithBrowser!(); }
    catch (error) { throw new Error(String((error as Error).message).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "")); }
    location.assign(next ?? "/viewer");
  }));
}
async function initialize() {
  try {
    if (token) {
      const result = await api<{ email: string }>("preview", { token });
      show("verify-email"); el("verify-address").textContent = result.email;
    } else {
      const result = await api<{ user: Account | null }>("session");
      if (result.user) profile(result.user); else show("sign-in");
      if (coinpayNotice) message(coinpayNotice.id, coinpayNotice.text);
    }
  } catch (error) { token = null; show("sign-in"); message("error", error instanceof TypeError ? "Unable to connect. Check your connection and try again." : (error as Error).message); }
}
window.addEventListener("pageshow", event => { if (event.persisted) { show("loading"); void initialize(); } });
window.addEventListener("hashchange", () => { readLink(); show("loading"); void initialize(); });
setSignup(false);
void initialize();
