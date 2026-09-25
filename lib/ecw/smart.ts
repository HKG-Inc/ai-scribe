/**
 * SMART on FHIR EHR launch against eClinicalWorks (server side only).
 *
 *   eCW opens   GET /launch-ecw?iss=<fhir base>&launch=<token>
 *     -> 302 to eCW authorize (response_type=code, PKCE S256, state, aud=iss)
 *     -> clinician authorizes, eCW redirects to GET /redirect-ecw?code=…&state=…
 *     -> code exchanged at the token endpoint with client_secret_basic
 *     -> tokens + launch context kept in encrypted, httpOnly cookies
 *
 * The client secret never reaches the browser. Tokens are refreshed with the
 * refresh_token before they expire (see freshAccessToken).
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

export const PENDING_COOKIE = "ecw_pending";
export const ACCESS_COOKIE = "ecw_at";
export const REFRESH_COOKIE = "ecw_rt";
export const CONTEXT_COOKIE = "ecw_ctx";

export const PENDING_TTL_SECONDS = 600;
const REFRESH_MARGIN_MS = 60_000;
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 12;

// Scopes eCW accepts for Hikigai's EHR-launch app. Only request scopes enabled for the
// app in the eCW portal: one unknown scope fails the whole launch with invalid_scope.
const DEFAULT_SCOPES = "launch openid fhirUser offline_access";
const DEFAULT_ISS_SUFFIXES = [".ecwcloud.com", ".eclinicalworks.com", ".healow.com"];

export class EcwLaunchError extends Error {}

export type EcwSettings = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scopes: string;
  defaultIss: string;
  issSuffixes: string[];
};

export function loadEcwSettings(): EcwSettings {
  const settings: EcwSettings = {
    clientId: process.env.ECW_CLIENT_ID?.trim() ?? "",
    clientSecret: process.env.ECW_CLIENT_SECRET?.trim() ?? "",
    redirectUri: process.env.ECW_REDIRECT_URI?.trim() ?? "",
    scopes: process.env.ECW_LAUNCH_SCOPES?.trim() || DEFAULT_SCOPES,
    defaultIss: (process.env.ECW_BASE_URL?.trim() ?? "").replace(/\/+$/, ""),
    issSuffixes: (process.env.ECW_ALLOWED_ISS_SUFFIXES ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  };
  if (!settings.issSuffixes.length) settings.issSuffixes = DEFAULT_ISS_SUFFIXES;

  const missing = (
    [
      ["ECW_CLIENT_ID", settings.clientId],
      ["ECW_CLIENT_SECRET", settings.clientSecret],
      ["ECW_REDIRECT_URI", settings.redirectUri],
    ] as const
  )
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length) throw new EcwLaunchError(`eCW launch is not configured: set ${missing.join(", ")}`);
  return settings;
}

/** Public origin of the app, taken from the registered redirect URI (request.url may be an internal host). */
export function appUrl(settings: EcwSettings, path: string): URL {
  const basePath = process.env.BASEPATH || "";
  return new URL(`${basePath}${path}`, new URL(settings.redirectUri).origin);
}

/**
 * Only start OAuth against eCW hosts: iss comes from the query string, and the
 * token request (carrying our client secret) goes to the endpoint it advertises.
 */
export function issAllowed(iss: string, settings: EcwSettings): boolean {
  let url: URL;
  try {
    url = new URL(iss);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  if (settings.defaultIss && iss.replace(/\/+$/, "") === settings.defaultIss) return true;
  const host = url.hostname.toLowerCase();
  return settings.issSuffixes.some((suffix) => host.endsWith(suffix));
}

type SmartEndpoints = { authorize: string; token: string };

const discoveryCache = new Map<string, SmartEndpoints>();

/** authorize/token endpoints from .well-known/smart-configuration, falling back to /metadata. */
export async function discover(iss: string): Promise<SmartEndpoints> {
  const key = iss.replace(/\/+$/, "");
  const cached = discoveryCache.get(key);
  if (cached) return cached;

  let endpoints: SmartEndpoints | null = null;
  try {
    const res = await fetch(`${key}/.well-known/smart-configuration`, {
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    if (res.ok) {
      const config = (await res.json()) as { authorization_endpoint?: string; token_endpoint?: string };
      if (config.authorization_endpoint && config.token_endpoint) {
        endpoints = { authorize: config.authorization_endpoint, token: config.token_endpoint };
      }
    }
  } catch {
    // fall through to the CapabilityStatement
  }

  if (!endpoints) {
    const res = await fetch(`${key}/metadata?_format=json`, {
      headers: { Accept: "application/fhir+json" },
      cache: "no-store",
    });
    if (!res.ok) throw new EcwLaunchError(`SMART discovery failed for ${key} (HTTP ${res.status})`);
    type Ext = { url: string; valueUri?: string; extension?: Ext[] };
    const metadata = (await res.json()) as { rest?: { security?: { extension?: Ext[] } }[] };
    const oauth = metadata.rest?.[0]?.security?.extension?.find(
      (e) => e.url === "http://fhir-registry.smarthealthit.org/StructureDefinition/oauth-uris"
    );
    const authorize = oauth?.extension?.find((e) => e.url === "authorize")?.valueUri;
    const token = oauth?.extension?.find((e) => e.url === "token")?.valueUri;
    if (!authorize || !token) throw new EcwLaunchError(`No OAuth endpoints advertised by ${key}`);
    endpoints = { authorize, token };
  }

  discoveryCache.set(key, endpoints);
  return endpoints;
}

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(64).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

// --- cookie encryption (AES-256-GCM, key derived from the client secret) -------------

function cookieKey(settings: EcwSettings): Buffer {
  const secret = process.env.ECW_COOKIE_SECRET?.trim() || settings.clientSecret;
  return createHash("sha256").update(`ecw-cookie:${secret}`).digest();
}

export function seal(settings: EcwSettings, value: unknown): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", cookieKey(settings), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64url");
}

export function unseal<T>(settings: EcwSettings, sealed: string | undefined): T | null {
  if (!sealed) return null;
  try {
    const raw = Buffer.from(sealed, "base64url");
    const decipher = createDecipheriv("aes-256-gcm", cookieKey(settings), raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    const data = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]);
    return JSON.parse(data.toString("utf8")) as T;
  } catch {
    return null;
  }
}

// eCW opens the launch URL inside an iframe on its own site, so these are third-party
// cookies: SameSite=None + Partitioned (CHIPS) keeps them working in that iframe.
export const cookieOptions = (maxAge: number) => ({
  httpOnly: true,
  secure: true,
  sameSite: "none" as const,
  partitioned: true,
  path: "/",
  maxAge,
});

export const SESSION_COOKIE_MAX_AGE = SESSION_MAX_AGE_SECONDS;

// --- launch state ---------------------------------------------------------------------

export type PendingLaunch = {
  state: string;
  verifier: string;
  iss: string;
  tokenUrl: string;
  created: number;
};

/** Launch context safe to hand to the browser (no tokens). */
export type EcwContext = {
  iss: string;
  tokenUrl: string;
  scope: string;
  expiresAt: number;
  patient: string | null;
  encounter: string | null;
  fhirUser: string | null;
  userName: string | null;
  extra: Record<string, string | number | boolean>;
};

type TokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  id_token?: string;
  patient?: string;
  encounter?: string;
  [key: string]: unknown;
};

export async function tokenRequest(
  settings: EcwSettings,
  tokenUrl: string,
  params: Record<string, string>
): Promise<TokenResponse> {
  const basic = Buffer.from(`${settings.clientId}:${settings.clientSecret}`).toString("base64");
  const res = await fetch(tokenUrl, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams(params).toString(),
    cache: "no-store",
  });
  const text = await res.text();
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    body = { error: text.slice(0, 300) };
  }
  if (!res.ok || typeof body.access_token !== "string") {
    const reason = body.error_description || body.error || `HTTP ${res.status}`;
    throw new EcwLaunchError(`eCW token endpoint refused the request (HTTP ${res.status}): ${String(reason)}`);
  }
  return body as TokenResponse;
}

function idTokenClaims(idToken: string | undefined): Record<string, unknown> {
  // Display only (name / fhirUser); not used for any trust decision, so not verified.
  const payload = idToken?.split(".")[1];
  if (!payload) return {};
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

const KNOWN_TOKEN_FIELDS = new Set([
  "access_token",
  "refresh_token",
  "expires_in",
  "scope",
  "token_type",
  "id_token",
  "patient",
  "encounter",
]);

export function contextFromToken(pending: PendingLaunch, body: TokenResponse): EcwContext {
  const claims = idTokenClaims(body.id_token);
  const str = (v: unknown) => (typeof v === "string" && v ? v : null);
  const extra: EcwContext["extra"] = {};
  for (const [k, v] of Object.entries(body)) {
    if (!KNOWN_TOKEN_FIELDS.has(k) && ["string", "number", "boolean"].includes(typeof v)) {
      extra[k] = v as string | number | boolean;
    }
  }
  return {
    iss: pending.iss,
    tokenUrl: pending.tokenUrl,
    scope: body.scope ?? "",
    expiresAt: Date.now() + Number(body.expires_in ?? 300) * 1000,
    patient: str(body.patient),
    encounter: str(body.encounter),
    fhirUser: str(claims.fhirUser) ?? str(claims.profile),
    // Only a real display name: eCW's sub / preferred_username are opaque ids.
    userName: str(claims.name) ?? ([str(claims.given_name), str(claims.family_name)].filter(Boolean).join(" ") || null),
    extra,
  };
}

export type EcwSession = { accessToken: string; refreshToken: string; context: EcwContext };

type CookieReader = { get(name: string): { value: string } | undefined };

export function readSession(settings: EcwSettings, cookies: CookieReader): EcwSession | null {
  const accessToken = unseal<string>(settings, cookies.get(ACCESS_COOKIE)?.value);
  const context = unseal<EcwContext>(settings, cookies.get(CONTEXT_COOKIE)?.value);
  if (!accessToken || !context) return null;
  const refreshToken = unseal<string>(settings, cookies.get(REFRESH_COOKIE)?.value) ?? "";
  return { accessToken, refreshToken, context };
}

/** Cookie values for a session; the caller writes them onto its response. */
export function sessionCookies(settings: EcwSettings, session: EcwSession): [string, string][] {
  const cookies: [string, string][] = [
    [ACCESS_COOKIE, seal(settings, session.accessToken)],
    [CONTEXT_COOKIE, seal(settings, session.context)],
  ];
  if (session.refreshToken) cookies.push([REFRESH_COOKIE, seal(settings, session.refreshToken)]);
  return cookies;
}

/**
 * Returns a usable session, refreshing the access token first when it is about
 * to expire. `refreshed` tells the caller to rewrite the session cookies.
 */
export async function freshSession(
  settings: EcwSettings,
  session: EcwSession
): Promise<{ session: EcwSession; refreshed: boolean }> {
  if (Date.now() < session.context.expiresAt - REFRESH_MARGIN_MS) return { session, refreshed: false };
  if (!session.refreshToken) {
    throw new EcwLaunchError("eCW session expired and has no refresh token; launch the app from eCW again");
  }
  const body = await tokenRequest(settings, session.context.tokenUrl, {
    grant_type: "refresh_token",
    refresh_token: session.refreshToken,
  });
  return {
    refreshed: true,
    session: {
      accessToken: body.access_token,
      refreshToken: body.refresh_token ?? session.refreshToken,
      context: {
        ...session.context,
        scope: body.scope ?? session.context.scope,
        expiresAt: Date.now() + Number(body.expires_in ?? 300) * 1000,
      },
    },
  };
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** Plain page for launch failures: the clinician sees it inside eCW, so say what to do. */
export function launchErrorPage(title: string, detail: string, status = 400): Response {
  const html =
    "<!doctype html><meta charset=utf-8><title>eCW launch</title>" +
    "<body style='font-family:system-ui;max-width:640px;margin:48px auto;padding:0 16px;color:#0f172a'>" +
    `<h2 style='color:#b91c1c'>${escapeHtml(title)}</h2><p>${escapeHtml(detail)}</p>` +
    "<p style='color:#475569'>Close this window and launch AI Scribe from the patient chart in eCW again.</p></body>";
  return new Response(html, { status, headers: { "Content-Type": "text/html; charset=utf-8" } });
}
