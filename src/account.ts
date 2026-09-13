import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface AccountUser { id: string; username: string; displayName: string }
export interface Credentials { api: string; token: string; user: AccountUser; expiresAt?: string }
export const configDir = () => process.env.READM3_CONFIG_DIR || join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "readm3");
export function apiUrl(value = process.env.READM3_API_URL || (process.env.READM3_URL ? `${process.env.READM3_URL.replace(/\/+$/, "")}/api/v1` : "https://readm3.com/api/v1")): string {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || !(url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) throw new Error("Use an HTTPS API URL (HTTP is allowed on localhost).");
  return url.href.replace(/\/+$/, "");
}
export function writeConfig(name: string, value: unknown, root = configDir()) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const path = join(root, name);
  const temp = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  renameSync(temp, path);
  chmodSync(path, 0o600);
}
export function storedCredentials(root = configDir()): Credentials | undefined {
  const path = join(root, "cloud.json");
  if (!existsSync(path)) return;
  const value = JSON.parse(readFileSync(path, "utf8")) as Credentials & { url?: string };
  return { ...value, api: apiUrl(value.api || (value.url ? `${value.url}/api/v1` : undefined)) };
}
export class ApiError extends Error {
  status: number;
  body: Record<string, unknown>;
  constructor(status: number, message: string, body: Record<string, unknown>) { super(message); this.status = status; this.body = body; }
}
export function accountClient(options: { api: string; token?: string; fetchImpl?: typeof fetch }) {
  const base = apiUrl(options.api);
  return async function request<T = Record<string, unknown>>(path: string, method = "GET", body?: unknown): Promise<T> {
    const response = await (options.fetchImpl || fetch)(`${base}${path}`, {
      method, redirect: "error", signal: AbortSignal.timeout(30_000),
      headers: { accept: "application/json", ...(options.token ? { authorization: `Bearer ${options.token}` } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = await response.json() as Record<string, unknown>;
    if (!response.ok) throw new ApiError(response.status, String(data.error || `HTTP ${response.status}`), data);
    return data as T;
  };
}
export async function credentials(root = configDir()): Promise<Credentials> {
  const saved = storedCredentials(root);
  const token = process.env.READM3_TOKEN || saved?.token;
  if (!token) throw new Error("Sign in with `readm3 login` first, or set READM3_TOKEN and READM3_API_URL.");
  // Never send a saved token to a different server because an environment variable changed.
  const api = apiUrl(process.env.READM3_API_URL || (process.env.READM3_URL ? `${process.env.READM3_URL.replace(/\/+$/, "")}/api/v1` : saved?.api));
  if (!process.env.READM3_TOKEN && saved && api !== saved.api) throw new Error("The API changed. Sign in to this server first.");
  const { user } = await accountClient({ api, token })<{ user: AccountUser | null }>("/me");
  if (!user) throw new Error("Session expired or revoked. Run `readm3 login`.");
  return { api, token, user };
}
