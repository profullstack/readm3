import { afterEach, describe, expect, test } from "bun:test";
import { Accounts, type Mail } from "../accounts.ts";
import { createApi } from "../api.ts";
import { profiles } from "../profile.ts";
import { Store } from "../store.ts";

/**
 * The shared @profullstack/profile fields: asked for only when creating an account,
 * carried on the emailed link (the user row exists only once it is spent), saved on
 * verify, and served at /api/v1/me/profile.
 */
const origin = "https://readm3.com";
const opened: Accounts[] = [];
afterEach(() => { for (const app of opened.splice(0)) app.db.close(); });
function fixture() {
  const mail: Mail[] = [];
  const app = new Accounts(":memory:", origin, async message => { mail.push(message); });
  opened.push(app);
  const store = new Store(app.db);
  const api = createApi(store, origin);
  const request = (action: string, args: unknown, cookie?: string) => app.handle(new Request(`${origin}/api/auth/${action}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin, ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(args),
  }), "127.0.0.1").then(r => r!);
  const token = () => new URLSearchParams(new URL(mail.at(-1)!.url).hash.slice(1)).get("verify")!;
  return { app, mail, api, request, token };
}

describe("signup profile", () => {
  test("a signup with the fields stores them once the link is verified", async () => {
    const { app, api, request, token } = fixture();
    const sent = await request("email", {
      email: "Ada@Acme.com", mode: "signup", first_name: "Ada", last_name: "Lovelace",
      company_domain: "https://www.acme.com/about", job_title: "CTO", linkedin_url: "in/ada-lovelace",
    });
    expect(sent.status).toBe(200);
    expect(app.db.query("SELECT * FROM users").all()).toHaveLength(0);
    const verified = await request("verify", { token: token() });
    expect(verified.status).toBe(200);
    const { user } = await verified.json();
    const saved = await (await profiles(app.db).ready).get(user.id);
    expect(saved).toMatchObject({
      email: "ada@acme.com", first_name: "Ada", last_name: "Lovelace",
      company_domain: "acme.com", job_title: "CTO", linkedin_url: "https://www.linkedin.com/in/ada-lovelace",
    });
    const cookie = verified.headers.get("set-cookie")!.split(";")[0];
    const response = await api(new Request(`${origin}/api/v1/me/profile`, { headers: { cookie } }));
    expect(response!.status).toBe(200);
    expect((await response!.json()).profile.job_title).toBe("CTO");
  });

  test("a signup missing a name is refused before any link is sent", async () => {
    const { app, mail, request } = fixture();
    const response = await request("email", { email: "ada@acme.com", mode: "signup", first_name: "Ada" });
    expect(response.status).toBe(400);
    expect((await response.json()).errors.last_name).toBeTruthy();
    expect(mail).toHaveLength(0);
    expect(app.db.query("SELECT * FROM email_challenges").all()).toHaveLength(0);
  });

  test("plain sign-in never asks for the fields", async () => {
    const { app, request, token } = fixture();
    expect((await request("email", { email: "person@example.com" })).status).toBe(200);
    const { user } = await (await request("verify", { token: token() })).json();
    expect(await (await profiles(app.db).ready).get(user.id)).toBeNull();
  });

  test("the profile API needs a session", async () => {
    const { api } = fixture();
    const response = await api(new Request(`${origin}/api/v1/me/profile`));
    expect(response!.status).toBe(401);
  });
});
