import { describe, expect, test } from "bun:test";
import { Billing } from "../billing.ts";
import { applyPass, PASS_MICROS, passFromUserinfo, passRef } from "../pass.ts";
import { Store, id, now } from "../store.ts";
import { verifiedAccount } from "./fixtures.ts";

const at = new Date("2026-11-07T12:00:00Z");
const until = "2026-12-07T12:00:00.000Z";

async function fixture() {
  const store = new Store(":memory:");
  const billing = new Billing(store, null);
  const { user } = await verifiedAccount(store, `Ada${id().slice(0, 6)}`);
  const { user: other } = await verifiedAccount(store, `Bob${id().slice(0, 6)}`);
  for (const [u, sub] of [[user.id, "sub-a"], [other.id, "sub-b"]])
    store.run("INSERT INTO user_identities VALUES (?,?,?,?,?,?,?)", id(), u, "coinpay", sub, null, now(), now());
  const passUntil = (sub: string) => store.get<{ passUntil: string | null }>("SELECT passUntil FROM user_identities WHERE providerUserId=?", sub)?.passUntil;
  return { store, billing, user, other, passUntil };
}

describe("passFromUserinfo (inline claim parse)", () => {
  test("active only with active === true and a future expires_at", () => {
    expect(passFromUserinfo({ pass: { active: true, expires_at: until } }, at)).toEqual({ active: true, expiresAt: new Date(until) });
    for (const body of [null, {}, { pass: { active: false } }, { pass: { active: true } }, { pass: { active: "true", expires_at: until } }, { pass: { active: true, expires_at: "soon" } }, { pass: { active: true, expires_at: "2026-11-01T00:00:00Z" } }])
      expect(passFromUserinfo(body, at)).toEqual({ active: false, expiresAt: null });
  });
});

describe("applyPass", () => {
  test("credits the $5 pack once per pass and records passUntil", async () => {
    const f = await fixture();
    expect(PASS_MICROS).toBe(5_000_000);
    const pass = passFromUserinfo({ pass: { active: true, expires_at: until } }, at);
    expect(applyPass(f.store, f.billing, f.user.id, "sub-a", pass, at)).toBe(true);
    expect(applyPass(f.store, f.billing, f.user.id, "sub-a", pass, at)).toBe(false);
    expect(f.billing.balance(f.user.id)).toBe(5_000_000);
    expect(f.passUntil("sub-a")).toBe(until);
    expect(passRef("sub-a", new Date(until))).toBe(`coinpay-pass:sub-a:${until}`);
    // A renewal is a new pass.
    const renewed = passFromUserinfo({ pass: { active: true, expires_at: "2027-01-07T12:00:00.000Z" } }, at);
    expect(applyPass(f.store, f.billing, f.user.id, "sub-a", renewed, at)).toBe(true);
    expect(f.billing.balance(f.user.id)).toBe(10_000_000);
    // Pass grants are not paying customers in the pricing experiment.
    f.store.run("INSERT OR IGNORE INTO pricing_arms (userId,arm,assignedAt) VALUES (?,?,?)", f.user.id, "2x", now());
    expect(f.billing.experiment().reduce((n, arm) => n + arm.payers + arm.topupMicros, 0)).toBe(0);
  });

  test("no pass pays nothing and clears passUntil", async () => {
    const f = await fixture();
    expect(applyPass(f.store, f.billing, f.other.id, "sub-b", { active: false, expiresAt: null }, at)).toBe(false);
    expect(applyPass(f.store, f.billing, f.other.id, "sub-b", { active: true, expiresAt: new Date("2026-11-01T00:00:00Z") }, at)).toBe(false);
    expect(f.billing.balance(f.other.id)).toBe(0);
    expect(f.passUntil("sub-b")).toBeNull();
  });
});
