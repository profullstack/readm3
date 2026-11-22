import { test, expect, describe } from "bun:test";
import { Store, id } from "../store.ts";
import { createApi } from "../api.ts";
import { Billing } from "../billing.ts";
import { PACKS_USD, Payments } from "../payments.ts";
import { CHECKOUT_SLOT, DEFAULT_PACK_USD, checkoutOptions, createCheckoutPage, payTopup } from "../checkout.ts";
import { verifiedAccount } from "./fixtures.ts";

const ORIGIN = "http://localhost";
const API_KEY = `cp_test_${"a".repeat(32)}`;

async function fixture(options: { enabled?: boolean } = {}) {
  const store = new Store(":memory:");
  const billing = new Billing(store, null);
  const payments = new Payments(store, billing, options.enabled === false ? { url: "http://coinpay.test" }
    : { apiKey: API_KEY, businessId: "biz_1", webhookSecret: "whsec_test", url: "http://coinpay.test" });
  const money = { billing, payments };
  const api = createApi(store, ORIGIN, undefined, money);
  const page = createCheckoutPage(store, money, ORIGIN, { shell: () => `<main>${CHECKOUT_SLOT}</main>`, payOrigin: "http://coinpay.test" });
  const { user, token } = await verifiedAccount(store, `Ada${id().slice(0, 6)}`);
  const cookie = { cookie: `readm3_session=${token}` };
  const get = async (path: string, headers: Record<string, string> = {}) => (await page(new Request(`${ORIGIN}${path}`, { headers })))!;
  const post = async (fields: Record<string, string>, headers: Record<string, string> = {}) => (await page(new Request(`${ORIGIN}/checkout`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN, referer: `${ORIGIN}/checkout?source=usage`, ...headers },
    body: new URLSearchParams(fields).toString(),
  })))!;
  return { store, billing, payments, api, page, user, token, cookie, get, post };
}

/** Stand in for CoinPay: record every session it is asked to open. */
async function withCoinPay<T>(run: (sent: { url: string; body: any }[]) => Promise<T>): Promise<T> {
  const realFetch = globalThis.fetch;
  const sent: { url: string; body: any }[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    sent.push({ url: String(url), body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify({ id: `cs_${sent.length}`, url: `http://coinpay.test/checkout/cs_${sent.length}` }), { status: 201 });
  }) as typeof fetch;
  try { return await run(sent); } finally { globalThis.fetch = realFetch; }
}

const order = (usd: number, changes: Record<string, unknown> = {}) => ({ option: { id: String(usd), name: `$${usd}`, kind: "once" as const, months: 0 }, quantity: 1, discountCents: 0, totalCents: usd * 100, ...changes });

describe("the checkout page's options", () => {
  test("are the API's packs at the API's prices: $5, $10, $25", () => {
    expect(checkoutOptions()).toEqual([
      { id: "5", name: "$5", price: 5 },
      { id: "10", name: "$10", price: 10 },
      { id: "25", name: "$25", price: 25 },
    ]);
    expect(checkoutOptions().map((option) => option.price)).toEqual([...PACKS_USD]);
    expect(PACKS_USD).toContain(DEFAULT_PACK_USD);
  });

  test("the page lists each pack once, with $10 selected unless the link names another", async () => {
    const f = await fixture();
    const html = await (await f.get("/checkout?source=usage", f.cookie)).text();
    expect([...html.matchAll(/name="option" value="(\d+)"/g)].map((match) => match[1])).toEqual(["5", "10", "25"]);
    expect(html).toMatch(/name="option" value="10" checked/);
    expect(html).toContain("USD 10.00");
    expect(html).toContain('name="source" value="usage"');
    expect(html).toContain("Buying as");
    expect(html).not.toContain('name="email"');
    expect(html).not.toContain("Most popular");
    const linked = await (await f.get("/checkout?option=25", f.cookie)).text();
    expect(linked).toMatch(/name="option" value="25" checked/);
    expect(linked).toContain("USD 25.00");
    // A pack that is not sold falls back to the default rather than to a broken page.
    expect(await (await f.get("/checkout?option=7", f.cookie)).text()).toMatch(/name="option" value="10" checked/);
  });
});

describe("paying from the checkout page", () => {
  test("opens the same CoinPay session as POST /api/v1/billing/topups, for every pack", async () => {
    for (const usd of PACKS_USD) {
      const f = await fixture();
      await withCoinPay(async (sent) => {
        const viaApi = (await f.api(new Request(`${ORIGIN}/api/v1/billing/topups`, {
          method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${f.token}` }, body: JSON.stringify({ amountUsd: usd }),
        })))!;
        expect(viaApi.status).toBe(201);
        const apiTopup = (await viaApi.json()) as { id: string };

        const viaPage = await f.post({ option: String(usd), source: "usage" }, f.cookie);
        expect(viaPage.status).toBe(303);
        expect(viaPage.headers.get("location")).toBe("http://coinpay.test/checkout/cs_2");

        expect(sent).toHaveLength(2);
        expect(sent[1]!.url).toBe(sent[0]!.url);
        const rows = f.store.all<{ id: string; amountMicros: number; paymentRef: string; status: string; chain: string; userId: string }>("SELECT id,userId,amountMicros,paymentRef,status,chain FROM billing_topups ORDER BY paymentRef");
        expect(rows).toHaveLength(2);
        const pageTopup = rows[1]!;
        // Identical but for the top-up's own id, which names the row the webhook settles.
        const swap = (body: any, topupId: string) => JSON.parse(JSON.stringify(body).replaceAll(topupId, "TOPUP"));
        expect(swap(sent[1]!.body, pageTopup.id)).toEqual(swap(sent[0]!.body, apiTopup.id));
        expect(sent[1]!.body).toMatchObject({
          amount: usd, currency: "USD", account_id: f.user.id, property: "readm3.com", business_id: "biz_1",
          metadata: { readm3_topup: pageTopup.id, user_id: f.user.id },
          success_url: `${ORIGIN}/viewer?topup=${pageTopup.id}`, cancel_url: `${ORIGIN}/viewer`, expires_in_minutes: 60,
        });
        expect(Object.keys(sent[1]!.body.metadata).sort()).toEqual(["readm3_topup", "user_id"]);
        expect(pageTopup).toMatchObject({ userId: f.user.id, amountMicros: usd * 1_000_000, paymentRef: "cs_2", status: "pending", chain: "ANY" });
      });
    }
  });

  test("the wrapper calls topup() with the pack's dollars and nothing else", async () => {
    const calls: unknown[][] = [];
    const payments = { topup: async (...args: unknown[]) => { calls.push(args); return { id: "t1", payUrl: "http://coinpay.test/checkout/cs_1", amountUsd: 25, sessionId: "cs_1" }; } };
    const user = { id: "u1" } as any;
    expect(await payTopup(payments as any, user, ORIGIN, order(25))).toEqual({ url: "http://coinpay.test/checkout/cs_1", id: "t1" });
    expect(calls).toEqual([[user, { amountUsd: 25 }, ORIGIN]]);
  });

  test("a total that is not the pack's price is refused before CoinPay is called", async () => {
    const calls: unknown[] = [];
    const payments = { topup: async (...args: unknown[]) => { calls.push(args); return { id: "t1", payUrl: "x", amountUsd: 10, sessionId: "cs_1" }; } };
    const user = { id: "u1" } as any;
    for (const bad of [order(10, { totalCents: 500 }), order(10, { totalCents: 1001 }), order(10, { quantity: 2, totalCents: 2000 }), order(10, { discountCents: 100, totalCents: 900 }), order(7), order(10, { option: { id: "custom", name: "Other", kind: "once", months: 0 } })])
      await expect(payTopup(payments as any, user, ORIGIN, bad)).rejects.toThrow("does not match");
    expect(calls).toHaveLength(0);
    // A session opened for another amount is never handed to the buyer.
    await expect(payTopup(payments as any, user, ORIGIN, order(25))).rejects.toThrow("different amount");
  });

  test("an unlisted option goes back to the page with an error and charges nothing", async () => {
    const f = await fixture();
    await withCoinPay(async (sent) => {
      const response = await f.post({ option: "7" }, f.cookie);
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe("/checkout?option=7&error=invalid_option");
      expect(sent).toHaveLength(0);
    });
    expect(f.store.get("SELECT 1 AS x FROM billing_topups")).toBeNull();
  });
});

describe("who may use the checkout page", () => {
  test("signed out: the page and the form both go to sign-in and come back", async () => {
    const f = await fixture();
    const page = await f.get("/checkout?option=25&source=usage&email=mallory@example.com");
    expect(page.status).toBe(302);
    expect(page.headers.get("location")).toBe(`/account?next=${encodeURIComponent("/checkout?option=25&source=usage")}`);
    await withCoinPay(async (sent) => {
      const posted = await f.post({ option: "25", source: "usage", email: "mallory@example.com" });
      expect(posted.status).toBe(303);
      expect(posted.headers.get("location")).toBe(`/account?next=${encodeURIComponent("/checkout?option=25&source=usage")}`);
      expect(sent).toHaveLength(0);
    });
  });

  test("the buyer is the session, never the form or a bearer token", async () => {
    const f = await fixture();
    const other = await verifiedAccount(f.store, `Bob${id().slice(0, 6)}`);
    await withCoinPay(async (sent) => {
      await f.post({ option: "5", email: "mallory@example.com", account_id: other.user.id, user_id: other.user.id }, f.cookie);
      expect(sent[0]!.body).toMatchObject({ account_id: f.user.id, metadata: { user_id: f.user.id } });
      expect(sent[0]!.body.customer_email).not.toBe("mallory@example.com");
      // A bearer token is for the JSON API: the page does not take it for a session.
      const bearer = await f.post({ option: "5" }, { authorization: `Bearer ${f.token}` });
      expect(bearer.headers.get("location")).toStartWith("/account?next=");
      expect(sent).toHaveLength(1);
    });
  });

  test("a post from another site, or with no Origin, is refused", async () => {
    const f = await fixture();
    await withCoinPay(async (sent) => {
      expect((await f.post({ option: "10" }, { ...f.cookie, origin: "https://evil.example" })).status).toBe(403);
      expect((await f.post({ option: "10" }, { ...f.cookie, origin: "null" })).status).toBe(403);
      const bare = (await f.page(new Request(`${ORIGIN}/checkout`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...f.cookie }, body: "option=10" })))!;
      expect(bare.status).toBe(403);
      expect(sent).toHaveLength(0);
    });
    expect(f.store.get("SELECT 1 AS x FROM billing_topups")).toBeNull();
  });

  test("top-ups not open: the page says so and sells nothing", async () => {
    const f = await fixture({ enabled: false });
    const html = await (await f.get("/checkout", f.cookie)).text();
    expect(html).toContain("Top-ups open soon.");
    expect(html).not.toContain("<form");
    const posted = await f.post({ option: "10" }, f.cookie);
    expect(posted.headers.get("location")).toBe("/checkout?option=10&error=payment_unavailable");
  });

  test("the page allows no inline script and only CoinPay as a form target", async () => {
    const f = await fixture();
    const response = await f.get("/checkout", f.cookie);
    const csp = response.headers.get("content-security-policy")!;
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("form-action 'self' http://coinpay.test");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("same-origin");
    expect(await response.text()).not.toMatch(/<script|<style/);
    expect(await f.page(new Request(`${ORIGIN}/viewer`))).toBeNull();
  });
});
