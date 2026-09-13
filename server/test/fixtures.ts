import { Accounts, type Mail } from "../accounts.ts";
import { Store } from "../store.ts";

/** Exercise the real email verification path with an in-memory test mailbox. */
export async function verifiedAccount(store: Store, name: string) {
  const mail: Mail[] = [];
  const accounts = new Accounts(
    store.db,
    "http://localhost",
    async (message) => {
      mail.push(message);
    },
  );
  const call = async (path: string, args: unknown) => {
    const response = (await accounts.handle(
      new Request(`http://localhost/api/auth/${path}`, {
        method: "POST",
        headers: {
          origin: "http://localhost",
          "content-type": "application/json",
        },
        body: JSON.stringify(args),
      }),
      name,
    ))!;
    if (!response.ok) throw new Error(await response.text());
    return response;
  };
  await call("email", { email: `${name.toLowerCase()}@example.com` });
  const challenge = new URLSearchParams(
    new URL(mail[0]!.url).hash.slice(1),
  ).get("verify");
  const response = await call("verify", { token: challenge });
  const { user } = await response.json();
  const token = response.headers
    .get("set-cookie")!
    .match(/readm3_session=([^;]+)/)![1];
  return { user, token, accounts };
}
