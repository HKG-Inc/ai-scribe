const TECHNICAL_MARKERS = [
  "hikigai agent invocation failed",
  "client error",
  "http://",
  "https://",
  '{"detail"',
  "for more information check:",
  "a.run.app",
];

export function isAgentUnavailableError(error: unknown): boolean {
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";
  const lower = raw.toLowerCase();
  return lower.includes("404") || lower.includes("not found");
}

export function toUserFacingApiError(error: unknown, fallback: string): string {
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";

  if (!raw.trim()) {
    return fallback;
  }

  const lower = raw.toLowerCase();

  if (lower.includes("404") || lower.includes("not found")) {
    return "This section is temporarily unavailable. Please try again later.";
  }

  if (lower.includes("timed out") || lower.includes("timeout")) {
    return "The request took too long. Please try again.";
  }

  if (lower.includes("missing hikigai")) {
    return "Service configuration is incomplete. Please contact support.";
  }

  const looksTechnical = TECHNICAL_MARKERS.some((marker) => lower.includes(marker));
  if (looksTechnical || raw.length > 160) {
    return fallback;
  }

  return raw;
}
