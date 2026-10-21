import { describe, expect, test } from "bun:test";
import { createCrawlGate } from "../crawl-gate.ts";

const GPT = "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)";
const CHROME = {
  "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  accept: "text/html",
  "sec-fetch-mode": "navigate",
  "sec-fetch-site": "none",
  "sec-fetch-dest": "document",
};
const gate = createCrawlGate({ COINPAY_X402_KEY: "cp_live_test", CRAWL_PAY_TO: "0xCC3b072391AE7A8d10cF00DdC5F61DB2cA5541E5" })!;
const ask = (path: string, headers: Record<string, string>) => gate.handle(new Request(`https://readm3.com${path}`, { headers }));

describe("crawl gate", () => {
  test("is off without a key", () => {
    expect(createCrawlGate({})).toBeNull();
  });
  test("charges GPTBot with PAYMENT-REQUIRED", async () => {
    const res = await ask("/", { "user-agent": GPT });
    expect(res?.status).toBe(402);
    expect(res?.headers.get("payment-required")).toBeTruthy();
  });
  test("sells a $1 day pass on /crawl", async () => {
    const res = (await ask("/crawl", { accept: "application/json" }))!;
    expect(res.status).toBe(402);
    expect(String(((await res.json()) as { accepts: Array<{ amount: string }> }).accepts[0]!.amount)).toBe("1000000");
  });
  test("passes browsers, signed-in users and the API", async () => {
    expect(await ask("/", CHROME)).toBeNull();
    expect(await ask("/", { "user-agent": GPT, cookie: "__Host-readm3_session=x" })).toBeNull();
    expect(await ask("/api/health", { "user-agent": GPT })).toBeNull();
  });
});
