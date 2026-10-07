/**
 * `readm3 login --coinpay`: an OAuth 2.1 authorization code grant with PKCE,
 * started here and finished on a loopback redirect (CoinPay accepts any port on
 * 127.0.0.1). The CLI never sees a client secret: it hands the code and its
 * verifier to readm3, which makes the exchange and answers with an ordinary
 * readm3 API token.
 */
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { cloudRequest, type CloudConfig } from "./cloud-client.ts";

const WAIT_MS = 5 * 60_000;

function openBrowser(url: string) {
  const [command, ...args] =
    process.platform === "darwin"
      ? ["open", url]
      : process.platform === "win32"
        ? ["cmd", "/c", "start", "", url]
        : ["xdg-open", url];
  try {
    const child = spawn(command!, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    /* The link is printed; opening it is a convenience. */
  }
}

const page = (message: string) =>
  `<!doctype html><meta charset="utf-8"><title>readm3</title><p style="font:16px system-ui;margin:3em">${message}</p>`;

/** Returns a readm3 API token for the CoinPay account the person signs in with. */
export async function coinpayLogin(config: CloudConfig): Promise<string> {
  const anonymous = { ...config, token: undefined };
  const status = await cloudRequest<{
    enabled: boolean;
    clientId?: string;
    coinpayUrl?: string;
    scopes?: string;
  }>("coinpay/status", "GET", undefined, anonymous);
  if (!status.enabled || !status.clientId || !status.coinpayUrl)
    throw new Error("This readm3 server does not offer Sign in with CoinPay.");
  const verifier = randomBytes(32).toString("base64url");
  const state = randomBytes(24).toString("base64url");
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as { port: number }).port;
  const redirectUri = `http://127.0.0.1:${port}/callback`;
  try {
    const code = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Timed out waiting for CoinPay. Run readm3 login --coinpay again.")),
        WAIT_MS,
      );
      server.on("request", (request, response) => {
        const url = new URL(request.url ?? "/", redirectUri);
        if (url.pathname !== "/callback") {
          response.writeHead(404).end();
          return;
        }
        const finish = (ok: boolean, message: string) => {
          response
            .writeHead(ok ? 200 : 400, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" })
            .end(page(message));
          clearTimeout(timer);
        };
        if (url.searchParams.get("state") !== state) {
          // Not ours: someone else's tab or a stale link. Keep waiting for the real one.
          response.writeHead(400, { "content-type": "text/html; charset=utf-8" }).end(page("This sign-in link does not belong to the waiting readm3 CLI."));
          return;
        }
        const error = url.searchParams.get("error");
        const code = url.searchParams.get("code");
        if (error || !code) {
          finish(false, "CoinPay sign-in did not complete. You can close this tab.");
          reject(new Error(`CoinPay sign-in failed: ${url.searchParams.get("error_description") || error || "no code returned"}.`));
          return;
        }
        finish(true, "Signed in to readm3 with CoinPay. You can close this tab and return to the terminal.");
        resolve(code);
      });
      const authorize = `${status.coinpayUrl}/api/oauth/authorize?${new URLSearchParams({
        client_id: status.clientId!,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: status.scopes || "openid profile email",
        state,
        code_challenge: createHash("sha256").update(verifier).digest("base64url"),
        code_challenge_method: "S256",
      })}`;
      process.stderr.write(`Sign in with CoinPay in your browser. If it does not open, visit:\n${authorize}\n`);
      if (!process.env.READM3_NO_BROWSER) openBrowser(authorize);
    });
    const result = await cloudRequest<{ token: string }>(
      "coinpay/oauth/cli-exchange",
      "POST",
      { code, code_verifier: verifier, redirect_uri: redirectUri },
      anonymous,
    );
    return result.token;
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
}
