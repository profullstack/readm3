import {
  createReadStream,
  readFileSync,
  existsSync,
  unlinkSync,
} from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { join } from "node:path";
import { apiUrl, configDir, freshToken, writeConfig } from "./account.ts";
export interface CloudConfig {
  url: string;
  api?: string;
  token?: string;
}
export function cloudConfig(tokenOverride?: string): CloudConfig {
  let saved: Partial<CloudConfig> = {};
  try {
    saved = JSON.parse(readFileSync(join(configDir(), "cloud.json"), "utf8"));
  } catch {
    /* Environment-only use is supported. */
  }
  const url = (
    process.env.READM3_URL ||
    saved.url ||
    "https://readm3.com"
  ).replace(/\/$/, "");
  const api = apiUrl(process.env.READM3_API_URL || (process.env.READM3_URL ? `${url}/api/v1` : saved.api || `${url}/api/v1`));
  const parsed = new URL(api);
  if (saved.token && !tokenOverride && !process.env.READM3_TOKEN && (saved.api || saved.url) && api !== apiUrl(saved.api || `${saved.url}/api/v1`))
    throw new Error("The server changed. Sign in to this server first.");
  return { url: parsed.origin, api, token: tokenOverride || process.env.READM3_TOKEN || saved.token };
}
export function saveCloudConfig(config: CloudConfig) {
  writeConfig("cloud.json", config);
}
export function clearCloudConfig() {
  const path = join(configDir(), "cloud.json");
  if (existsSync(path)) unlinkSync(path);
}
export async function cloudRequest<T = unknown>(
  path: string,
  method = "GET",
  body?: unknown,
  config = cloudConfig(),
): Promise<T> {
  const token = await freshToken(config.token);
  const response = await fetch(`${config.api || `${config.url}/api/v1`}/${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
    redirect: "error",
  });
  const value = (await response.json()) as { error?: string };
  if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`);
  return value as T;
}
export async function cloudAction<T = unknown>(
  operation: string,
  args: Record<string, unknown> = {},
  config = cloudConfig(),
): Promise<T> {
  if (!config.token)
    throw new Error(
      "Run readm3 login to sign in (or set READM3_TOKEN).",
    );
  return cloudRequest<T>("actions", "POST", { operation, args }, config);
}
/** The most a file paste may be (server/pastes.ts PASTE_FILE_MAX_BYTES). */
export const PASTE_FILE_MAX_BYTES = 2 * 1024 ** 3;

/**
 * A file pasted as itself: streamed from disk as the request body, with its length, so
 * a 2 GB file never sits in memory and never becomes base64. No timeout: a large file
 * on a slow link takes as long as it takes. `onProgress` hears every chunk sent.
 */
export async function uploadPaste<T = unknown>(
  path: string,
  size: number,
  query: Record<string, string | undefined>,
  config = cloudConfig(),
  onProgress?: (sent: number) => void,
): Promise<T> {
  const target = new URL(`${config.api || `${config.url}/api/v1`}/pastes`);
  for (const [key, value] of Object.entries(query)) if (value) target.searchParams.set(key, value);
  const request = target.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise<T>((resolve, reject) => {
    const outgoing = request(target, {
      method: "POST",
      headers: { "content-type": "application/octet-stream", "content-length": String(size) },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("error", reject);
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let value: { error?: string } = {};
        try { value = JSON.parse(text); } catch { /* nginx or a proxy answered with a page */ }
        if ((response.statusCode ?? 500) >= 400) {
          const status = response.statusCode === 413 ? "The file is too large for the server." : `HTTP ${response.statusCode}`;
          reject(new Error(value.error || status));
        } else resolve(value as T);
      });
    });
    outgoing.on("error", reject);
    let sent = 0;
    const stream = createReadStream(path);
    stream.on("data", (chunk) => { sent += chunk.length; onProgress?.(sent); });
    stream.on("error", (error) => { outgoing.destroy(error); reject(error); });
    stream.pipe(outgoing);
  });
}

export function pasteLocation(value: string): {
  token: string;
  config: CloudConfig;
} {
  const url = new URL(value);
  const match = url.pathname.match(/^\/p\/([\w-]{43})$/);
  if (!match || !["https:", "http:"].includes(url.protocol))
    throw new Error("Use a readm3 paste URL (…/p/<token>).");
  return { token: match[1]!, config: { url: url.origin } };
}
export function sharedLocation(value: string): {
  token: string;
  config: CloudConfig;
} {
  const url = new URL(value);
  const match = url.pathname.match(/^\/s\/([\w-]{43})$/);
  if (!match || !["https:", "http:"].includes(url.protocol))
    throw new Error("Use a readm3 shared document URL.");
  return { token: match[1], config: { url: url.origin } };
}
