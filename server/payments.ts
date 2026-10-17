/**
 * Top-ups through CoinPay checkout, the fleet's payment rail (ported from ch4nnels'
 * src/shop/coinpay.js). A top-up is a pending row written before the buyer is sent
 * to CoinPay; the signed webhook settles it once, and the amount credited is always
 * the row's, never the webhook's.
 *
 * - The payee is the business's own imported wallets, so no address is sent.
 * - The chain must be one the business holds a wallet for.
 * - The webhook payload is nested: the top-level id is the event, the payment is `data`.
 *   `detected` is never paid (it fires before reorg safety); `forwarded` is.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Billing } from "./billing.ts";
import { HttpError, id, now, type Store, type User } from "./store.ts";

export const TOPUP_SCHEMA = `
  CREATE TABLE IF NOT EXISTS billing_topups (id TEXT PRIMARY KEY, userId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, paymentRef TEXT UNIQUE NOT NULL, amountMicros INTEGER NOT NULL, chain TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','paid')), createdAt TEXT NOT NULL, paidAt TEXT);
`;
export const PACKS_USD = [5, 10, 25] as const;
export const CHAINS = ["USDC_POL", "USDT_POL", "USDC_SOL", "USDT_SOL", "BTC", "ETH", "SOL", "POL"] as const;
const SETTLED = new Set(["confirmed", "paid", "completed", "succeeded", "settled", "forwarded"]);

export type PaymentOptions = { apiKey?: string; businessId?: string; webhookSecret?: string; url?: string };
export function paymentOptions(env = process.env): PaymentOptions {
  return {
    apiKey: env.COINPAY_API_KEY || undefined,
    businessId: env.COINPAY_BUSINESS_ID || undefined,
    webhookSecret: env.COINPAY_WEBHOOK_SECRET || undefined,
    // Vaults store the base without /api.
    url: (env.COINPAY_API_URL || "https://coinpayportal.com").replace(/\/+$/, "").replace(/\/api$/, ""),
  };
}

/** `t=<unix>,v1=<hex HMAC-SHA256 of "t.rawBody">`, over the raw bytes, within 300 s. */
export function verifySignature(secret: string, rawBody: string, header: string | null, at = Date.now() / 1000): boolean {
  if (!header || !secret) return false;
  const parts = Object.fromEntries(header.split(",").map((pair) => pair.split("=").map((part) => part.trim())));
  const t = Number(parts.t);
  if (!Number.isFinite(t) || !/^[0-9a-f]+$/i.test(parts.v1 ?? "") || Math.abs(at - t) > 300) return false;
  const expected = createHmac("sha256", secret).update(`${parts.t}.${rawBody}`).digest();
  const given = Buffer.from(parts.v1!, "hex");
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export class Payments {
  constructor(private store: Store, private billing: Billing, private options: PaymentOptions = paymentOptions()) {
    store.db.exec(TOPUP_SCHEMA);
  }

  get enabled(): boolean {
    return /^cp_(live|test)_[0-9a-f]{32}$/.test(this.options.apiKey ?? "") && !!this.options.businessId && !!this.options.webhookSecret;
  }

  async topup(user: User, args: Record<string, unknown>, origin: string) {
    if (!this.enabled) throw new HttpError(503, "Top-ups are not open yet.");
    const amountUsd = Number(args.amountUsd);
    if (!PACKS_USD.includes(amountUsd as (typeof PACKS_USD)[number])) throw new HttpError(400, `Top up by ${PACKS_USD.map((usd) => `$${usd}`).join(", ")}.`);
    const chain = CHAINS.includes(args.chain as (typeof CHAINS)[number]) ? (args.chain as string) : CHAINS[0];
    const topupId = id();
    const response = await fetch(`${this.options.url}/api/payments/create`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.options.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        business_id: this.options.businessId,
        amount: amountUsd,
        currency: "USD",
        blockchain: chain,
        payment_method: "crypto",
        description: `readm3 AI summaries, $${amountUsd} balance`,
        metadata: { readm3_topup: topupId, user_id: user.id },
        success_url: `${origin}/viewer?topup=${topupId}`,
        cancel_url: `${origin}/viewer`,
      }),
      signal: AbortSignal.timeout(20_000),
    });
    const text = await response.text();
    if (!response.ok) throw new HttpError(502, `CoinPay could not start the payment (${response.status}).`);
    const body = JSON.parse(text) as { payment?: { id?: string; payment_id?: string }; id?: string };
    const ref = body.payment?.id ?? body.payment?.payment_id ?? body.id;
    if (!ref) throw new HttpError(502, "CoinPay returned no payment reference.");
    // Written before the buyer leaves, so the webhook always finds it.
    this.store.run(
      "INSERT INTO billing_topups (id,userId,paymentRef,amountMicros,chain,status,createdAt) VALUES (?,?,?,?,?,'pending',?)",
      topupId, user.id, ref, amountUsd * 1_000_000, chain, now(),
    );
    return { id: topupId, payUrl: `${this.options.url}/pay/${ref}`, amountUsd, chain };
  }

  /** The signed webhook. Anything that verifies gets a 200, or CoinPay retries it forever. */
  webhook(rawBody: string, signature: string | null): { credited: boolean } {
    if (!this.options.webhookSecret || !verifySignature(this.options.webhookSecret, rawBody, signature)) throw new HttpError(401, "Bad signature.");
    let payload: { type?: string; data?: Record<string, unknown> } & Record<string, unknown>;
    try { payload = JSON.parse(rawBody); } catch { return { credited: false }; }
    const data = (payload.data ?? payload) as Record<string, unknown>;
    const ref = (data.payment_id ?? data.id) as string | undefined;
    const status = String(data.status ?? "").toLowerCase();
    const settled = SETTLED.has(status) || /\.(confirmed|forwarded)$/.test(String(payload.type ?? ""));
    if (!ref || !settled) return { credited: false };
    let credited = false;
    this.store.db.transaction(() => {
      const row = this.store.get<{ userId: string; amountMicros: number }>("SELECT userId,amountMicros FROM billing_topups WHERE paymentRef=? AND status='pending'", ref);
      if (!row) return;
      this.store.run("UPDATE billing_topups SET status='paid', paidAt=? WHERE paymentRef=? AND status='pending'", now(), ref);
      credited = this.billing.credit(row.userId, row.amountMicros, `coinpay:${ref}`, `Top-up via CoinPay`);
    })();
    return { credited };
  }

  status(user: User, topupId: string) {
    const row = this.store.get<{ status: string; amountMicros: number }>("SELECT status,amountMicros FROM billing_topups WHERE id=? AND userId=?", topupId, user.id);
    if (!row) throw new HttpError(404, "No such top-up.");
    return { status: row.status, amountMicros: row.amountMicros, balanceMicros: this.billing.balance(user.id) };
  }
}
