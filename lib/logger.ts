/**
 * Structured logger for Runtime Logs (stdout/stderr → CloudWatch / Cloud Logging).
 * Prefer this over ad-hoc console.log so agent failures include URL + raw backend body.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogFields = Record<string, unknown>;

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify({ unserializable: String(value) });
  }
}

/** Prefer parsing backend bodies so Runtime Logs show structured `error` fields. */
export function parseRawResponse(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  const trimmed = raw.trim();
  if (!trimmed) return raw;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return raw;
  }
}

export function errorFields(error: unknown): LogFields {
  if (error instanceof Error) {
    return {
      errorName: error.name,
      errorMessage: error.message,
      ...(error.stack ? { errorStack: error.stack } : {}),
    };
  }
  if (typeof error === "string") {
    return { errorMessage: error };
  }
  return { error: error as unknown };
}

function write(level: LogLevel, scope: string, message: string, fields?: LogFields): void {
  const entry: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    scope,
    message,
    ...(fields ?? {}),
  };

  const line = safeJson(entry);
  if (level === "error" || level === "warn") {
    // stderr — surfaces clearly in platform Runtime Logs
    console.error(line);
  } else {
    console.log(line);
  }
}

export const logger = {
  debug(scope: string, message: string, fields?: LogFields): void {
    write("debug", scope, message, fields);
  },

  info(scope: string, message: string, fields?: LogFields): void {
    write("info", scope, message, fields);
  },

  warn(scope: string, message: string, fields?: LogFields): void {
    write("warn", scope, message, fields);
  },

  error(scope: string, message: string, fields?: LogFields): void {
    write("error", scope, message, fields);
  },

  /**
   * Agent HTTP / transport failure — includes invoke URL and raw backend body.
   * Use from HikigaiClient so every agent route gets consistent diagnose logs.
   */
  agentInvokeError(
    agentSlug: string,
    details: {
      url: string;
      status?: number;
      statusText?: string;
      rawResponse?: unknown;
      cause?: unknown;
      phase?: "http" | "network" | "auth" | "timeout" | "unknown";
    }
  ): void {
    const { url, status, statusText, rawResponse, cause, phase } = details;
    write("error", agentSlug, "invoke error", {
      event: "agent_invoke_error",
      url,
      ...(status != null ? { status } : {}),
      ...(statusText ? { statusText } : {}),
      ...(phase ? { phase } : {}),
      ...(rawResponse !== undefined
        ? {
            rawResponse: parseRawResponse(rawResponse),
            rawResponseText:
              typeof rawResponse === "string" ? rawResponse : safeJson(rawResponse),
          }
        : {}),
      ...(cause !== undefined ? errorFields(cause) : {}),
    });
  },

  /** Successful agent invoke — optional raw payload for debugging. */
  agentInvokeOk(
    agentSlug: string,
    details?: {
      url?: string;
      rawResponse?: unknown;
      normalized?: unknown;
      extra?: LogFields;
    }
  ): void {
    write("info", agentSlug, "invoke ok", {
      event: "agent_invoke_ok",
      ...(details?.url ? { url: details.url } : {}),
      ...(details?.rawResponse !== undefined
        ? { rawResponse: details.rawResponse }
        : {}),
      ...(details?.normalized !== undefined
        ? { normalized: details.normalized }
        : {}),
      ...(details?.extra ?? {}),
    });
  },
};
