/**
 * Profullstack Pass (2026-11-07): a user who deposits $99 into their own CoinPay
 * wallet gets a free month on every Profullstack property. CoinPay reports it on
 * userinfo (scope openid) as `pass: { active, expires_at? }`.
 *
 * readm3 is prepaid (billing_ledger micros) with free quotas, so a pass pays the
 * smallest top-up pack ($5) once per pass: billing.credit() with ref
 * `coinpay-pass:<sub>:<expires_at>`, which billing_ledger.ref UNIQUE keeps to one
 * payment per pass whichever account it lands on; a renewal pays again.
 *
 * The claim is only seen at sign-in, so the expiry is kept on the CoinPay
 * identity (user_identities.passUntil).
 */
import type { Billing } from "./billing.ts";
import { PACKS_USD } from "./payments.ts";
import type { Store } from "./store.ts";

export const PASS_URL = "https://coinpayportal.com/pass";
/** The smallest top-up pack, in micros: what one pass is worth here. */
export const PASS_MICROS = Math.min(...PACKS_USD) * 1_000_000;

export type Pass = { active: boolean; expiresAt: Date | null };

/** Active only when `pass.active === true` and `expires_at` parses to a future date. */
export function passFromUserinfo(body: unknown, at: Date = new Date()): Pass {
  const raw = (body as { pass?: unknown } | null)?.pass as { active?: unknown; expires_at?: unknown } | undefined;
  if (!raw || typeof raw !== "object" || raw.active !== true || typeof raw.expires_at !== "string")
    return { active: false, expiresAt: null };
  const expiresAt = new Date(raw.expires_at);
  if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= at.getTime()) return { active: false, expiresAt: null };
  return { active: true, expiresAt };
}

export const passRef = (sub: string, expiresAt: Date) => `coinpay-pass:${sub}:${expiresAt.toISOString()}`;

export function ensurePassColumn(store: Store) {
  const columns = store.db.query("PRAGMA table_info(user_identities)").all() as { name: string }[];
  if (columns.length && !columns.some((c) => c.name === "passUntil"))
    store.db.exec("ALTER TABLE user_identities ADD COLUMN passUntil TEXT");
}

/** Record the pass on the CoinPay identity and pay it once. True only when this call paid. */
export function applyPass(store: Store, billing: Pick<Billing, "credit">, userId: string, sub: string, pass: Pass, at: Date = new Date()): boolean {
  ensurePassColumn(store);
  const active = pass.active && pass.expiresAt !== null && pass.expiresAt.getTime() > at.getTime();
  store.run(
    "UPDATE user_identities SET passUntil=? WHERE provider='coinpay' AND providerUserId=?",
    active ? pass.expiresAt!.toISOString() : null,
    sub,
  );
  if (!active) return false;
  return billing.credit(userId, PASS_MICROS, passRef(sub, pass.expiresAt!), `Profullstack Pass: $${PASS_MICROS / 1_000_000} credit`);
}
