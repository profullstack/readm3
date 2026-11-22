/**
 * readm3.com/checkout: the Add funds page (@profullstack/checkout). The packs are
 * the ones the API sells (PACKS_USD), the buyer is whoever the session cookie says,
 * and paying is Payments.topup(), the same call POST /api/v1/billing/topups makes:
 * one CoinPay session, one pending row, settled by the same webhook.
 *
 * It is a plain form post that ends in a 303 to CoinPay, so it works without script.
 * The link only prefills: /checkout?option=25&source=usage.
 */
import { createCheckout, type Order } from "@profullstack/checkout";
import { limit, sessionCookie, type Money } from "./api.ts";
import { PACKS_USD, type Payments } from "./payments.ts";
import { HttpError, type Store, type User } from "./store.ts";

export const CHECKOUT_PATH = "/checkout";
/** The pack that opens selected, as it did in the Add funds dialog this page replaced. */
export const DEFAULT_PACK_USD = 10;
/** Where the page template (site/build.ts) takes the form. */
export const CHECKOUT_SLOT = "<!--readm3:checkout-->";

/** One option per pack: the id is the dollar amount Payments.topup() takes. */
export const checkoutOptions = () => PACKS_USD.map((usd) => ({ id: String(usd), name: `$${usd}`, price: usd }));

/**
 * Opens the CoinPay session for a priced order through Payments.topup(), with the
 * arguments the JSON API passes it. The page may never charge anything but a pack's
 * own price: any order that does not come to exactly that is refused before CoinPay
 * is called, and a session opened for another amount is not handed to the buyer.
 */
export async function payTopup(payments: Pick<Payments, "topup">, user: User, origin: string, order: Pick<Order, "option" | "quantity" | "discountCents" | "totalCents">) {
  const amountUsd = Number(order.option.id);
  if (!PACKS_USD.includes(amountUsd as (typeof PACKS_USD)[number]) || order.quantity !== 1 || order.discountCents !== 0 || order.totalCents !== amountUsd * 100)
    throw new HttpError(400, "The checkout total does not match the pack's price.");
  const created = await payments.topup(user, { amountUsd }, origin);
  if (created.amountUsd * 100 !== order.totalCents) throw new HttpError(502, "The payment was opened for a different amount.");
  return { url: created.payUrl, id: created.id };
}

const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const dollars = (micros: number) => `$${(micros / 1e6).toFixed(micros !== 0 && Math.abs(micros) < 10_000 ? 4 : 2)}`;

export type CheckoutPage = {
  /** The site page around the form: its html with CHECKOUT_SLOT where the form goes. */
  shell: () => Promise<string> | string;
  /** CoinPay's origin, which the form's redirect must be allowed to reach. */
  payOrigin?: string;
};

export function createCheckoutPage(store: Store, money: Money, origin: string, page: CheckoutPage) {
  const signIn = "/account";
  const headers = (extra: Record<string, string> = {}) => ({
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    // Not no-referrer: a form on a no-referrer page posts `Origin: null`.
    "referrer-policy": "same-origin",
    "x-robots-tag": "noindex",
    "x-frame-options": "DENY",
    // Scripts from here only. The site footers bring their own inline styles and badge images.
    "content-security-policy": `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https: data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'${page.payOrigin ? ` ${page.payOrigin}` : ""}`,
    ...extra,
  });

  /** The session's user: the cookie only, never the link, the form or a bearer token. */
  const sessionUser = (request: Request): User | null => {
    const cookie = sessionCookie(request, origin);
    try { return cookie ? store.authenticate(cookie) : null; } catch { return null; }
  };

  function checkoutFor(user: User | null) {
    const multiplier = user ? money.billing.account(user).multiplier : 2;
    const per = multiplier === 2 ? "twice" : `${multiplier} times`;
    return createCheckout({
      site: "readm3.com",
      title: "Add funds",
      subtitle: `Pay as you go, from one balance that never expires: storage over the free 5 GB is $0.05 per GB a month, and each AI summary costs ${per} what the AI call costs us, usually a fraction of a cent.`,
      action: CHECKOUT_PATH,
      page: CHECKOUT_PATH,
      options: checkoutOptions(),
      processor: "Pay with BTC, ETH, SOL, USDC, USDT and more, or PayPal, on CoinPay.",
      requireAccount: true,
      signIn,
      siteUrl: origin,
      account: () => user ? { id: user.id, email: money.payments.emailFor(user) ?? "" } : null,
      pay: async (order) => {
        if (!user) throw new HttpError(401, "Sign in to add funds.");
        limit(`topup:${user.id}`, 10);
        const paid = await payTopup(money.payments, user, origin, order);
        if (order.source) console.log(`[checkout] top-up ${paid.id} opened from ${JSON.stringify(order.source)}`);
        return paid;
      },
      onError: (error) => console.error(`[checkout] could not open a top-up: ${error instanceof Error ? error.message : error}`),
    });
  }

  return async (request: Request): Promise<Response | null> => {
    const url = new URL(request.url);
    if (url.pathname !== CHECKOUT_PATH) return null;
    const user = sessionUser(request);

    if (request.method === "POST") {
      // The API's rule for cookie-authenticated writes: the browser must say it posts from here.
      if (request.headers.get("origin") !== origin)
        return new Response("This form was sent from another site.", { status: 403, headers: headers({ "content-type": "text/plain; charset=utf-8" }) });
      const response = await checkoutFor(user).POST(request);
      for (const [name, value] of Object.entries(headers())) response.headers.set(name, value);
      return response;
    }
    if (request.method !== "GET" && request.method !== "HEAD")
      return new Response("Method not allowed.", { status: 405, headers: headers({ allow: "GET, HEAD, POST", "content-type": "text/plain; charset=utf-8" }) });

    // The link is a hint: a listed pack and where the buyer came from, nothing else.
    const asked = url.searchParams.get("option") ?? url.searchParams.get("plan") ?? "";
    const query = new URLSearchParams({ option: PACKS_USD.some((usd) => String(usd) === asked) ? asked : String(DEFAULT_PACK_USD) });
    const source = (url.searchParams.get("source") ?? "").slice(0, 64);
    if (source) query.set("source", source);
    if (!user) {
      const next = `${CHECKOUT_PATH}?${query}`;
      return new Response(null, { status: 302, headers: headers({ location: `${signIn}?next=${encodeURIComponent(next)}` }) });
    }
    const error = url.searchParams.get("error");
    if (error) query.set("error", error);

    const email = money.payments.emailFor(user);
    const balance = `<p>Balance ${escape(dollars(money.billing.balance(user.id)))}</p>`;
    const pass = `<p>Deposit $99 in your CoinPay wallet and get a free month: <a href="https://coinpayportal.com/pass" target="_blank" rel="noopener">CoinPay Pass</a> ($5 of credit when you sign in with CoinPay).</p>`;
    const back = `<p><a href="/viewer">Back to the editor</a></p>`;
    // Nothing to sell yet, or no address for the receipt: say so instead of a form that cannot be paid.
    const closed = !money.payments.enabled ? "Top-ups open soon."
      : !email ? `Add an email to your <a href="/account">account</a> to top up.` : "";
    const form = closed
      ? `<section class="pfc"><div class="pfc-main"><header class="pfc-head"><h1 class="pfc-title">Add funds</h1></header><p class="pfc-error" role="alert">${closed}</p></div></section>`
      : checkoutFor(user).html({ query, account: { email: email ?? "" } });
    const html = (await page.shell()).replace(CHECKOUT_SLOT, () => `${form}<div class="checkout-notes">${balance}${pass}${back}</div>`);
    return new Response(request.method === "HEAD" ? null : html, { headers: headers({ "content-type": "text/html; charset=utf-8" }) });
  };
}
