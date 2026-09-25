/**
 * Patient chart sections read from eCW through the MCP connector, and the
 * mapping from FHIR resources to the flat rows the chart tabs display.
 */

export type ChartSection = {
  label: string;
  resourceType: string;
  params?: Record<string, string>;
};

// Each section is one ecw_search_resources call for the launch patient.
// Each needs its patient/<resourceType>.read scope in ECW_LAUNCH_SCOPES.
export const CHART_SECTIONS = {
  problems: { label: "Problems", resourceType: "Condition" },
  medications: { label: "Medications", resourceType: "MedicationRequest" },
  allergies: { label: "Allergies", resourceType: "AllergyIntolerance" },
  vitals: { label: "Vitals", resourceType: "Observation", params: { category: "vital-signs" } },
  labs: { label: "Labs", resourceType: "Observation", params: { category: "laboratory" } },
  immunizations: { label: "Immunizations", resourceType: "Immunization" },
  procedures: { label: "Procedures", resourceType: "Procedure" },
  encounters: { label: "Encounters", resourceType: "Encounter" },
} satisfies Record<string, ChartSection>;

export type ChartSectionKey = keyof typeof CHART_SECTIONS;

export function isChartSection(key: string): key is ChartSectionKey {
  return Object.hasOwn(CHART_SECTIONS, key);
}

export type ChartRow = {
  id: string;
  title: string;
  detail: string | null;
  status: string | null;
  date: string | null;
};

type Coding = { code?: string; display?: string };
type CodeableConcept = { text?: string; coding?: Coding[] };
type Quantity = { value?: number; unit?: string; code?: string };
type FhirResource = Record<string, unknown> & { resourceType?: string; id?: string };

function concept(cc: unknown): string | null {
  const c = cc as CodeableConcept | undefined;
  if (!c) return null;
  return c.text?.trim() || c.coding?.find((x) => x.display)?.display || c.coding?.[0]?.code || null;
}

function firstConcept(list: unknown): string | null {
  return Array.isArray(list) ? concept(list[0]) : null;
}

function quantity(q: unknown): string | null {
  const v = q as Quantity | undefined;
  if (v?.value === undefined) return null;
  return [v.value, v.unit ?? v.code].filter((x) => x !== undefined && x !== "").join(" ");
}

function observationValue(r: FhirResource): string | null {
  const direct =
    quantity(r.valueQuantity) ??
    (typeof r.valueString === "string" ? r.valueString : null) ??
    concept(r.valueCodeableConcept);
  if (direct) return direct;
  // Blood pressure and other panels carry their values in components.
  const components = (r.component as FhirResource[] | undefined) ?? [];
  const values = components.map((c) => quantity(c.valueQuantity) ?? concept(c.valueCodeableConcept)).filter(Boolean);
  if (!values.length) return null;
  const units = components.map((c) => (c.valueQuantity as Quantity | undefined)?.unit).filter(Boolean);
  const sameUnit = units.length === values.length && units.every((u) => u === units[0]);
  return sameUnit
    ? `${components.map((c) => (c.valueQuantity as Quantity).value).join("/")} ${units[0]}`
    : values.join(", ");
}

const str = (v: unknown) => (typeof v === "string" && v ? v : null);
const period = (v: unknown) => str((v as { start?: string } | undefined)?.start);
const joined = (...parts: (string | null)[]) => parts.filter(Boolean).join(" · ") || null;

function toRow(r: FhirResource): ChartRow {
  const id = r.id ?? "";
  const status = concept(r.clinicalStatus) ?? str(r.status);
  switch (r.resourceType) {
    case "Condition":
      return {
        id,
        title: concept(r.code) ?? "Unnamed condition",
        detail: joined(firstConcept(r.category), concept(r.severity)),
        status,
        date: str(r.onsetDateTime) ?? period(r.onsetPeriod) ?? str(r.recordedDate),
      };
    case "MedicationRequest": {
      const dosage = (r.dosageInstruction as { text?: string }[] | undefined)?.[0]?.text ?? null;
      return {
        id,
        title:
          concept(r.medicationCodeableConcept) ??
          str((r.medicationReference as { display?: string } | undefined)?.display) ??
          "Unnamed medication",
        detail: dosage,
        status,
        date: str(r.authoredOn),
      };
    }
    case "AllergyIntolerance": {
      const reaction = (r.reaction as { manifestation?: unknown[] }[] | undefined)?.[0];
      return {
        id,
        title: concept(r.code) ?? "Unnamed allergy",
        detail: joined(firstConcept(reaction?.manifestation), str(r.criticality) && `criticality: ${r.criticality}`),
        status,
        date: str(r.recordedDate) ?? str(r.onsetDateTime),
      };
    }
    case "Observation":
      return {
        id,
        title: concept(r.code) ?? "Observation",
        detail: observationValue(r),
        status,
        date: str(r.effectiveDateTime) ?? period(r.effectivePeriod) ?? str(r.issued),
      };
    case "Immunization":
      return {
        id,
        title: concept(r.vaccineCode) ?? "Unnamed vaccine",
        detail: joined(concept(r.route), concept(r.site)),
        status,
        date: str(r.occurrenceDateTime),
      };
    case "Procedure":
      return {
        id,
        title: concept(r.code) ?? "Unnamed procedure",
        detail: firstConcept(r.reasonCode),
        status,
        date: str(r.performedDateTime) ?? period(r.performedPeriod),
      };
    case "Encounter":
      return {
        id,
        title:
          firstConcept(r.type) ??
          str((r.class as Coding | undefined)?.display) ??
          str((r.class as Coding | undefined)?.code) ??
          "Encounter",
        detail: joined(
          firstConcept(r.reasonCode),
          str((r.serviceProvider as { display?: string } | undefined)?.display)
        ),
        status,
        date: period(r.period),
      };
    default:
      return { id, title: r.resourceType ?? "Resource", detail: null, status, date: null };
  }
}

/** Rows for one section from a search Bundle, newest first. */
export function bundleRows(bundle: unknown, resourceType: string): ChartRow[] {
  const entries = ((bundle as { entry?: { resource?: FhirResource }[] } | undefined)?.entry ?? [])
    .map((e) => e.resource)
    .filter((r): r is FhirResource => r?.resourceType === resourceType);
  return entries.map(toRow).sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
}
