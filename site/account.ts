type Account = { id: string; email: string | null; displayName: string; emailVerifiedAt: string | null };
type CoinPayStatus = { enabled: boolean; identities: { providerUserId: string; email: string | null }[]; canUnlink: boolean };
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
// The CoinPay callback comes back here with ?coinpay=linked or ?coinpay_error=…; read it once, then drop it.
const returned = new URLSearchParams(location.search);
const coinpayNotice = returned.get("coinpay_error") ? { id: "error" as const, text: returned.get("coinpay_error")! }
  : returned.get("coinpay") === "linked" ? { id: "status" as const, text: "Your CoinPay account is linked." } : null;
if (coinpayNotice) {
  returned.delete("coinpay_error"); returned.delete("coinpay");
  history.replaceState(null, "", location.pathname + (returned.size ? `?${returned}` : "") + location.hash);
}
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
  button.hidden = !status.enabled || panel !== "sign-in";
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
el("coinpay-unlink").addEventListener("click", () => void action(el<HTMLButtonElement>("coinpay-unlink"), async () => {
  const response = await fetch("/api/v1/coinpay/unlink", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: "{}" });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Could not unlink CoinPay.");
  await coinpay("profile"); message("status", "CoinPay is unlinked. Sign in with your email from now on.");
}));
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
void initialize();
