import {
  readFileSync,
  existsSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { apiUrl, configDir, writeConfig } from "./account.ts";
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
  const response = await fetch(`${config.api || `${config.url}/api/v1`}/${path}`, {
    method,
    headers: {
      ...(config.token ? { authorization: `Bearer ${config.token}` } : {}),
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
      "Sign in at readm3.com/admin, create an API token, and run readm3 login --token-stdin (or set READM3_TOKEN).",
    );
  return cloudRequest<T>("actions", "POST", { operation, args }, config);
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
