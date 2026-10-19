// @profullstack/auth-system ships plain JavaScript; these are the parts readm3 uses.

declare module "@profullstack/auth-system/cli" {
  export interface SavedTokens {
    access_token: string;
    refresh_token?: string;
    expires_at: number;
    issuer?: string;
    client_id?: string;
    token_endpoint?: string;
    revocation_endpoint?: string;
    [key: string]: unknown;
  }
  export interface TokenStore {
    load(): Promise<SavedTokens | null>;
    save(data: SavedTokens): Promise<unknown>;
    clear(): Promise<void>;
  }
  export function login(options: {
    issuer: string;
    clientId: string;
    store?: TokenStore;
    scope?: string;
    manual?: boolean;
    manualRedirectUri?: string;
    open?: (url: string) => unknown;
    log?: (message: string) => void;
    input?: NodeJS.ReadableStream;
    fetch?: typeof fetch;
    timeoutMs?: number;
  }): Promise<SavedTokens>;
  export function getAccessToken(options: { store: TokenStore; fetch?: typeof fetch; skewMs?: number }): Promise<string | null>;
  export function logout(options: { store: TokenStore; fetch?: typeof fetch }): Promise<boolean>;
  export function hasDisplay(): boolean;
}

declare module "@profullstack/auth-system/oauth2" {
  export interface CodeRow {
    codeHash: string;
    userId: string;
    clientId: string;
    redirectUri: string;
    codeChallenge: string;
    scope: string;
    expiresAt: Date | string;
  }
  export interface TokenRow {
    tokenHash: string;
    kind: "access" | "refresh";
    userId: string;
    clientId: string;
    scope: string;
    familyId: string;
    expiresAt: Date | string;
    revoked?: boolean | number;
    used?: boolean | number;
  }
  export interface OAuthStore {
    saveCode(row: CodeRow): Promise<void>;
    takeCode(codeHash: string): Promise<CodeRow | null>;
    saveToken(row: TokenRow): Promise<void>;
    getToken(tokenHash: string): Promise<TokenRow | null>;
    markUsed(tokenHash: string): Promise<boolean>;
    revokeFamily(familyId: string): Promise<void>;
  }
  export class OAuthError extends Error {
    code: string;
    status: number;
    constructor(code: string, description?: string, status?: number);
    toJSON(): { error: string; error_description: string };
  }
  export interface AuthorizeRequest {
    clientId: string;
    clientName: string;
    redirectUri: string;
    codeChallenge: string;
    scope: string;
    state: string;
  }
  export interface OAuthServer {
    validateAuthorize(query: Record<string, string | undefined>): AuthorizeRequest;
    approve(request: Omit<AuthorizeRequest, "clientName"> & { userId: string }): Promise<string>;
    denyUrl(request: { redirectUri: string; state: string }): string;
    token(body: Record<string, unknown>): Promise<Record<string, unknown>>;
    verifyAccessToken(bearer: string): Promise<{ userId: string; clientId: string; scope: string } | null>;
    revoke(token: string | undefined): Promise<void>;
    metadata(paths?: { authorizePath?: string; tokenPath?: string; revokePath?: string }): Record<string, unknown>;
  }
  export function createOAuthServer(options: {
    store: OAuthStore;
    clients: Record<string, { redirectUris: string[]; name?: string }>;
    issuer: string;
    tokenPrefix?: string;
    scopes?: string[];
  }): OAuthServer;
}
