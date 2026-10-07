// Local-only test mailbox and stand-in CoinPay. Never imported by the production server or copied to its image.
import { createHash } from "node:crypto";
import { Accounts, type Mail } from "../../server/accounts.ts";
import { serveSite } from "../server.ts";
const port = Number(process.env.PORT || 4321);
const mail: Mail[] = [];
const accounts = new Accounts(":memory:", `http://127.0.0.1:${port}`, async message => { mail.push(message); });
// CoinPay approves every authorization at once, as the same person: authorize, token and userinfo.
const codes = new Map<string, string>();
const tokens = new Set<string>();
Bun.serve({ port: port + 2, hostname: "127.0.0.1", async fetch(request) {
  const url = new URL(request.url);
  if (url.pathname === "/api/oauth/authorize") {
    const code = crypto.randomUUID();
    codes.set(code, url.searchParams.get("code_challenge")!);
    return Response.redirect(`${url.searchParams.get("redirect_uri")}?code=${code}&state=${url.searchParams.get("state")}`, 302);
  }
  if (url.pathname === "/api/oauth/token") {
    const form = new URLSearchParams(await request.text());
    const challenge = codes.get(form.get("code") ?? "");
    if (!challenge || challenge !== createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url")) return Response.json({ error: "invalid_grant" }, { status: 400 });
    const token = `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ sub: "cp_browser", client_id: "readm3-test" })).toString("base64url")}.${crypto.randomUUID()}`;
    tokens.add(token);
    return Response.json({ access_token: token, token_type: "Bearer", expires_in: 3600 });
  }
  if (url.pathname === "/api/oauth/userinfo" && tokens.has(request.headers.get("authorization")?.slice(7) ?? ""))
    return Response.json({ sub: "cp_browser", name: "Coin Reader", email: "coin@example.com", email_verified: false });
  return Response.json({ error: "invalid_token" }, { status: 401 });
} });
serveSite({ accounts, port, hostname: "127.0.0.1", coinpay: { clientId: "readm3-test", clientSecret: "test-secret", url: `http://127.0.0.1:${port + 2}` } });
Bun.serve({ port: port + 1, hostname: "127.0.0.1", fetch(request) {
  const url = new URL(request.url);
  if (url.pathname === "/test/mail") return Response.json(mail.filter(message => message.to === url.searchParams.get("email")));
  return new Response("Not found", { status: 404 });
} });
