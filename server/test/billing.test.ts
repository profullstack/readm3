import { test, expect, describe } from "bun:test";
import { createHmac } from "node:crypto";
import { Store, id } from "../store.ts";
import { createApi } from "../api.ts";
import { ARMS, Billing, costMicros, priceMicros, prompt, type Summarize } from "../billing.ts";
import { Payments, verifySignature } from "../payments.ts";
import { diffLines } from "../../src/diff.ts";
import { verifiedAccount } from "./fixtures.ts";

const SECRET = "whsec_test";
const API_KEY = `cp_test_${"a".repeat(32)}`;

function sign(body: string, at = Math.floor(Date.now() / 1000)) {
  return `t=${at},v1=${createHmac("sha256", SECRET).update(`${at}.${body}`).digest("hex")}`;
}

async function fixture(summarize: Summarize | null = async () => ({ text: "Ports changed.", usage: { input_tokens: 1000, output_tokens: 100 }, refused: false })) {
  const store = new Store(":memory:");
  const billing = new Billing(store, summarize, "claude-opus-5-5");
  const payments = new Payments(store, billing, { apiKey: API_KEY, businessId: "biz_1", webhookSecret: SECRET, url: "http://coinpay.test" });
  const api = createApi(store, "http://localhost", undefined, { billing, payments });
  const { user, token } = await verifiedAccount(store, `Ada${id().slice(0, 6)}`);
  const address = id();
  async function call(route: string, method = "GET", data?: unknown, headers: Record<string, string> = {}, raw?: string) {
    const response = (await api(new Request(`http://localhost/api/v1/${route}`, {
      method,
      headers: { ...(data !== undefined || raw ? { "content-type": "application/json" } : {}), ...headers },
      body: raw ?? (data === undefined ? undefined : JSON.stringify(data)),
    }), address))!;
    return { status: response.status, data: (await response.json()) as any };
  }
  const auth = { authorization: `Bearer ${token}` };
  return { store, billing, payments, user, call, auth };
}

describe("pricing", () => {
  test("a charge is the model's cost times the account's arm, rounded up to a micro-dollar", () => {
    const cost = costMicros("claude-opus-5-5", { input_tokens: 1000, output_tokens: 100 });
    expect(cost).toBe(1000 * 4 + 100 * 20);
    expect(priceMicros(cost, "2x")).toBe(12000);
    expect(priceMicros(cost, "4x")).toBe(24000);
    expect(priceMicros(1.2, "2x")).toBe(3);
  });

  test("arms are sticky per account and split accounts between both prices", async () => {
    const store = new Store(":memory:");
    const billing = new Billing(store, null);
    const seen = new Set<string>();
    for (let i = 0; i < 40; i++) {
      const user = { id: id(), username: `u${i}`, displayName: `U${i}`, admin: 0, createdAt: "2026-10-17" };
      store.run("INSERT INTO users (id,username,displayName,passwordHash,recoveryHash,createdAt) VALUES (?,?,?,'','','2026-10-17')", user.id, `u${i}`, `U${i}`);
      const arm = billing.arm(user);
      expect(billing.arm(user)).toBe(arm);
      seen.add(arm);
    }
    expect([...seen].sort()).toEqual(Object.keys(ARMS).sort());
  });

  test("the prompt carries the change, not the file, and says what was cut", () => {
    const before = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
    const after = before.replace("line 20", "line twenty");
    const text = prompt("config.json", diffLines(before, after));
    expect(text).toContain("+1 -1");
    expect(text).toContain("- line 20");
    expect(text).toContain("+ line twenty");
    expect(text).not.toContain("line 40");
  });
});

describe("summaries", () => {
  test("refuses without balance, charges the arm's price once funded, and records the arm", async () => {
    let calls = 0;
    const f = await fixture(async () => { calls++; return { text: "Ports changed.", usage: { input_tokens: 1000, output_tokens: 100 }, refused: false }; });
    const args = { path: "app.json", before: '{"port":80}', after: '{"port":443}' };
    const empty = await f.call("summaries", "POST", args, f.auth);
    expect(empty.status).toBe(402);
    expect(calls).toBe(0);
    f.billing.credit(f.user.id, 1_000_000, "test:1", "test");
    const done = await f.call("summaries", "POST", args, f.auth);
    expect(done.status).toBe(200);
    expect(done.data.summary).toBe("Ports changed.");
    expect(done.data.chargedMicros).toBe(6000 * ARMS[done.data.arm as keyof typeof ARMS]);
    expect(done.data.balanceMicros).toBe(1_000_000 - done.data.chargedMicros);
    const account = await f.call("billing", "GET", undefined, f.auth);
    expect(account.data.arm).toBe(done.data.arm);
    expect(account.data.ledger[0].kind).toBe("charge");
  });

  test("a refusal or a failed call costs nothing", async () => {
    const refused = await fixture(async () => ({ text: "", usage: { input_tokens: 10, output_tokens: 0 }, refused: true }));
    refused.billing.credit(refused.user.id, 1_000_000, "test:2", "test");
    expect((await refused.call("summaries", "POST", { before: "a", after: "b" }, refused.auth)).status).toBe(422);
    expect(refused.billing.balance(refused.user.id)).toBe(1_000_000);
    const broken = await fixture(async () => { throw new Error("upstream"); });
    broken.billing.credit(broken.user.id, 1_000_000, "test:3", "test");
    expect((await broken.call("summaries", "POST", { before: "a", after: "b" }, broken.auth)).status).toBe(502);
    expect(broken.billing.balance(broken.user.id)).toBe(1_000_000);
  });

  test("is unavailable without a model key, and refuses identical versions", async () => {
    const off = await fixture(null);
    expect((await off.call("summaries", "POST", { before: "a", after: "b" }, off.auth)).status).toBe(503);
    expect((await off.call("billing", "GET", undefined, off.auth)).data.enabled).toBe(false);
    const on = await fixture();
    on.billing.credit(on.user.id, 1_000_000, "test:4", "test");
    expect((await on.call("summaries", "POST", { before: "same", after: "same" }, on.auth)).status).toBe(400);
  });

  test("needs an account", async () => {
    const f = await fixture();
    expect((await f.call("summaries", "POST", { before: "a", after: "b" })).status).toBe(401);
  });
});

describe("top-ups", () => {
  test("only listed packs, and the webhook credits the stored amount exactly once", async () => {
    const f = await fixture();
    expect((await f.call("billing/topups", "POST", { amountUsd: 7 }, f.auth)).status).toBe(400);
    const realFetch = globalThis.fetch;
    let sent: any;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ success: true, payment: { id: "pay_123" } }), { status: 200 });
    }) as typeof fetch;
    let created;
    try { created = await f.call("billing/topups", "POST", { amountUsd: 10 }, f.auth); }
    finally { globalThis.fetch = realFetch; }
    expect(created.status).toBe(201);
    expect(created.data.payUrl).toBe("http://coinpay.test/pay/pay_123");
    expect(sent).toMatchObject({ business_id: "biz_1", amount: 10, currency: "USD", payment_method: "crypto" });
    expect(sent.merchant_wallet_address).toBeUndefined();

    // The webhook's own amount is ignored: the row says $10.
    const body = JSON.stringify({ id: "evt_1", type: "payment.confirmed", data: { payment_id: "pay_123", status: "confirmed", amount: 999 } });
    expect((await f.call("billing/coinpay/webhook", "POST", undefined, { "x-coinpay-signature": "t=1,v1=00" }, body)).status).toBe(401);
    const first = await f.call("billing/coinpay/webhook", "POST", undefined, { "x-coinpay-signature": sign(body) }, body);
    expect(first.data.credited).toBe(true);
    const again = await f.call("billing/coinpay/webhook", "POST", undefined, { "x-coinpay-signature": sign(body) }, body);
    expect(again.status).toBe(200);
    expect(again.data.credited).toBe(false);
    expect(f.billing.balance(f.user.id)).toBe(10_000_000);
    expect((await f.call(`billing/topups/${created.data.id}`, "GET", undefined, f.auth)).data.status).toBe("paid");
  });

  test("detected is not paid", async () => {
    const f = await fixture();
    f.store.run("INSERT INTO billing_topups (id,userId,paymentRef,amountMicros,chain,status,createdAt) VALUES ('t1',?,'pay_9',5000000,'USDC_POL','pending','2026-10-17')", f.user.id);
    const body = JSON.stringify({ type: "payment.detected", data: { payment_id: "pay_9", status: "detected" } });
    expect((await f.call("billing/coinpay/webhook", "POST", undefined, { "x-coinpay-signature": sign(body) }, body)).data.credited).toBe(false);
    expect(f.billing.balance(f.user.id)).toBe(0);
  });

  test("signatures expire after five minutes", () => {
    const old = Math.floor(Date.now() / 1000) - 301;
    expect(verifySignature(SECRET, "{}", sign("{}", old))).toBe(false);
    expect(verifySignature(SECRET, "{}", sign("{}"))).toBe(true);
  });
});

describe("experiment", () => {
  test("admins see per-arm accounts, payers, money in, summaries and model cost", async () => {
    const f = await fixture();
    f.billing.credit(f.user.id, 5_000_000, "test:5", "test");
    await f.call("summaries", "POST", { before: "a", after: "b" }, f.auth);
    expect((await f.call("billing/experiment", "GET", undefined, f.auth)).status).toBe(403);
    f.store.run("UPDATE users SET admin=1 WHERE id=?", f.user.id);
    const arms = (await f.call("billing/experiment", "GET", undefined, f.auth)).data.arms as any[];
    const mine = arms.find((row) => row.accounts === 1)!;
    expect(mine).toMatchObject({ payers: 1, topupMicros: 5_000_000, summaries: 1, costMicros: 6000 });
    expect(mine.chargedMicros).toBe(6000 * mine.multiplier);
  });
});
