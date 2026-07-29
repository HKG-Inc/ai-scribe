import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

function normalizeBasePath(path: string): string {
  return path.startsWith("/") ? path : `/${path}`;
}

function getConfiguredBasePath(): string {
  if (typeof window === "undefined") return "";

  const nextData = (window as Window & { __NEXT_DATA__?: { basePath?: string } }).__NEXT_DATA__;
  if (nextData?.basePath) return nextData.basePath;

  const publicBasePath = process.env.NEXT_PUBLIC_BASEPATH;
  if (publicBasePath) {
    return normalizeBasePath(publicBasePath);
  }

  return "";
}

function getRuntimeBasePath(): string {
  if (typeof window === "undefined" || getConfiguredBasePath()) return "";

  // Derive from current URL at runtime (works even if build-time env missing).
  // On Hikigai platform the app is mounted at /<slug>/... e.g. /ai-scribe-a060ee0a.
  // The platform may also mount apps at reserved-looking paths like /signup.
  const knownPages = new Set([
    "recording", "login", "signup", "pricing", "help",
    "visit-details", "processing", "api",
  ]);
  const pathSegments = window.location.pathname.split("/").filter(Boolean);
  const [firstSegment, secondSegment] = pathSegments;

  if (
    firstSegment &&
    (window.location.hostname.endsWith(".cloudfront.net") ||
      !knownPages.has(firstSegment) ||
      (secondSegment ? knownPages.has(secondSegment) : false))
  ) {
    return `/${firstSegment}`;
  }

  return "";
}

function getDeployedBasePath(): string {
  return getConfiguredBasePath() || getRuntimeBasePath();
}

export function withBasePath(path: string): string {
  if (!path.startsWith("/")) return path;
  const basePath = getDeployedBasePath();
  return basePath ? basePath + path : path;
}

export function withoutBasePath(path: string): string {
  const basePath = getDeployedBasePath();
  if (!basePath || (path !== basePath && !path.startsWith(`${basePath}/`))) return path;

  const stripped = path.slice(basePath.length);
  return stripped.startsWith("/") ? stripped : `/${stripped}`;
}

export function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(withBasePath(path), init);
}

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60)
    .toString()
    .padStart(2, "0");
  const s = (seconds % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

export function getInitials(firstName: string, lastName: string): string {
  return `${firstName.charAt(0)}${lastName.charAt(0)}`.toUpperCase();
}

/** Letters with optional spaces, hyphens, or apostrophes between name parts (e.g. Mary-Jane, O'Brien). */
export const PERSON_NAME_PATTERN = /^[a-zA-Z]+(?:[ '\-][a-zA-Z]+)*$/;

export function getPersonNameError(
  value: string,
  fieldLabel = "Name",
): string | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed.replace(/[ '\-]/g, "").length < 2) {
    return `${fieldLabel} must be at least 2 letters`;
  }
  if (!PERSON_NAME_PATTERN.test(trimmed)) {
    return `${fieldLabel} can only contain letters, spaces, hyphens, and apostrophes`;
  }
  return null;
}

const DATE_PLACEHOLDERS = new Set([
  "mmddyyyy",
  "ddmmyyyy",
  "yyyymmdd",
  "mmddyy",
  "ddmmyy",
  "mmdd",
]);

// Some agents emit a literal date template (e.g. "MM/DD/YYYY") when they cannot
// extract a real date. Treat those placeholders as empty so they never surface
// in the UI or exported PDF.
export function cleanDateValue(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  const compact = trimmed.toLowerCase().replace(/[/\-.\s]/g, "");
  return DATE_PLACEHOLDERS.has(compact) ? "" : trimmed;
}

export type FollowUpAppointment = {
  duration: string;
  reason: string;
  date?: string;
  instructions?: string;
  visit_type?: string;
};

export function mapFollowUpAppointment(firstFollowUp: unknown): FollowUpAppointment | null {
  if (!firstFollowUp) {
    return null;
  }

  if (typeof firstFollowUp === "string") {
    const reason = firstFollowUp.trim();
    return reason ? { duration: "", reason } : null;
  }

  if (typeof firstFollowUp !== "object") {
    return null;
  }

  const item = firstFollowUp as Record<string, unknown>;
  const date = cleanDateValue(item.date) || cleanDateValue(item.duration) || "";
  const reason =
    (typeof item.reason === "string" && item.reason.trim()) ||
    (typeof item.description === "string" && item.description.trim()) ||
    (typeof item.text === "string" && item.text.trim()) ||
    "";
  const instructions =
    typeof item.instructions === "string" ? item.instructions.trim() : "";
  const visit_type = typeof item.visit_type === "string" ? item.visit_type.trim() : "";

  if (!date && !reason && !instructions) {
    return null;
  }

  return {
    duration: date,
    ...(date ? { date } : {}),
    reason,
    ...(instructions ? { instructions } : {}),
    ...(visit_type ? { visit_type } : {}),
  };
}
