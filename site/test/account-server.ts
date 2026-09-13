// Local-only test mailbox. Never imported by the production server or copied to its image.
import { Accounts, type Mail } from "../../server/accounts.ts";
import { serveSite } from "../server.ts";
const mail: Mail[] = [];
const accounts = new Accounts(":memory:", "http://127.0.0.1:4321", async message => { mail.push(message); });
serveSite({ accounts, port: 4321, hostname: "127.0.0.1" });
Bun.serve({ port: 4322, hostname: "127.0.0.1", fetch(request) {
  const url = new URL(request.url);
  if (url.pathname === "/test/mail") return Response.json(mail.filter(message => message.to === url.searchParams.get("email")));
  return new Response("Not found", { status: 404 });
} });
