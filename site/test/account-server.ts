// Local-only test mailbox. Never imported by the production server or copied to its image.
import { Accounts, type Mail } from "../../server/accounts.ts";
import { serveSite } from "../server.ts";
const port = Number(process.env.PORT || 4321);
const mail: Mail[] = [];
const accounts = new Accounts(":memory:", `http://127.0.0.1:${port}`, async message => { mail.push(message); });
serveSite({ accounts, port, hostname: "127.0.0.1" });
Bun.serve({ port: port + 1, hostname: "127.0.0.1", fetch(request) {
  const url = new URL(request.url);
  if (url.pathname === "/test/mail") return Response.json(mail.filter(message => message.to === url.searchParams.get("email")));
  return new Response("Not found", { status: 404 });
} });
