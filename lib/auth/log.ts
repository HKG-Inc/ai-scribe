import { errorFields, logger, type LogFields } from "@/lib/logger";

/** Where the log line was emitted. */
export type AuthLogSource = "frontend" | "server";

/**
 * Which layer produced / owns the failure.
 * - client: browser-side only (validation, storage, etc.)
 * - next-api: this app's /api/identity/* route
 * - hikigai-backend: platform identity service / Cognito behind it
 */
export type AuthLogOrigin = "client" | "next-api" | "hikigai-backend";

export type AuthLogFields = LogFields & {
  source: AuthLogSource;
  event: string;
  origin?: AuthLogOrigin;
  email?: string;
  path?: string;
  /** HTTP status when applicable. */
  status?: number;
  errorMessage?: string;
};

function write(
  level: "info" | "warn" | "error",
  scope: string,
  message: string,
  fields: AuthLogFields
): void {
  logger[level](scope, message, fields);
}

/** Successful auth lifecycle event. */
export function logAuthOk(
  scope: string,
  message: string,
  fields: AuthLogFields
): void {
  write("info", scope, message, fields);
}

/** Auth failure — always includes source/origin so Runtime Logs show FE vs server. */
export function logAuthError(
  scope: string,
  message: string,
  fields: AuthLogFields,
  cause?: unknown
): void {
  write("error", scope, message, {
    ...fields,
    ...(cause !== undefined ? errorFields(cause) : {}),
  });
}

export function logAuthWarn(
  scope: string,
  message: string,
  fields: AuthLogFields
): void {
  write("warn", scope, message, fields);
}

/** JSON body for Next identity API error responses. */
export function authErrorBody(
  error: string,
  origin: AuthLogOrigin = "hikigai-backend"
): { error: string; source: "server"; origin: AuthLogOrigin } {
  return { error, source: "server", origin };
}
