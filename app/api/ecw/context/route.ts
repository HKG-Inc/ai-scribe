import { NextResponse, type NextRequest } from "next/server";
import { logger, errorFields } from "@/lib/logger";
import { callEcwTool, type EcwToolResult } from "@/lib/ecw/mcp";
import { withEcwSession } from "@/lib/ecw/route-session";

export const dynamic = "force-dynamic";

type HumanName = { use?: string; text?: string; prefix?: string[]; given?: string[]; family?: string };
type FhirResource = { resourceType?: string; id?: string; name?: HumanName[]; practitioner?: { reference?: string } };

type Person = { id: string; name: string | null } | null;

/** Display name from a FHIR HumanName list, preferring the official name. */
function displayName(names: HumanName[] | undefined, withPrefix: boolean): string | null {
  if (!names?.length) return null;
  const n = names.find((x) => x.use === "official") ?? names.find((x) => x.use === "usual") ?? names[0];
  const parts = [...(withPrefix ? (n.prefix ?? []) : []), ...(n.given ?? []), n.family].filter(Boolean);
  return parts.length ? parts.join(" ") : n.text?.trim() || null;
}

/** "Practitioner/123" or "https://…/Practitioner/123" -> ["Practitioner", "123"] */
function parseReference(ref: string | null | undefined): [string, string] | null {
  const m = ref?.match(/(?:^|\/)(Practitioner|PractitionerRole|Person|RelatedPerson|Patient)\/([A-Za-z0-9\-.]{1,64})\/?$/);
  return m ? [m[1], m[2]] : null;
}

/**
 * The launch's patient and signed-in clinician, read through the eCW MCP connector:
 *   patient -> ecw_read_resource(Patient, <launch patient>)
 *   doctor  -> ecw_read_resource(<fhirUser type>, <fhirUser id>)  (via PractitionerRole when needed)
 */
export async function GET(request: NextRequest) {
  try {
    return await withEcwSession(request, async (session) => {
      const { iss, patient: patientId, fhirUser, userName } = session.context;
      const creds = { baseUrl: iss, accessToken: session.accessToken };
      const read = (resource_type: string, resource_id: string) =>
        callEcwTool("ecw_read_resource", { resource_type, resource_id }, creds);
      const errors: Record<string, string> = {};
      const note = (key: string, result: EcwToolResult) => {
        if (!result.ok) errors[key] = `${result.status ?? ""} ${result.error?.message ?? "read failed"}`.trim();
      };

      const loadPatient = async (): Promise<Person> => {
        if (!patientId) return null;
        const result = await read("Patient", patientId);
        note("patient", result);
        const resource = result.resource as FhirResource | undefined;
        return { id: patientId, name: displayName(resource?.name, false) };
      };

      const loadDoctor = async (): Promise<Person> => {
        let ref = parseReference(fhirUser);
        if (!ref) return userName ? { id: "", name: userName } : null;
        if (ref[0] === "PractitionerRole") {
          const role = await read("PractitionerRole", ref[1]);
          note("doctorRole", role);
          ref = parseReference((role.resource as FhirResource | undefined)?.practitioner?.reference) ?? ref;
        }
        const result = await read(ref[0], ref[1]);
        note("doctor", result);
        const resource = result.resource as FhirResource | undefined;
        return { id: ref[1], name: displayName(resource?.name, true) ?? userName };
      };

      const [patient, doctor] = await Promise.all([loadPatient(), loadDoctor()]);
      if (Object.keys(errors).length) {
        logger.warn("ecw-context", "eCW context read incomplete", { event: "ecw_context_partial", errors });
      }
      return NextResponse.json({
        ok: true,
        connected: true,
        patient,
        doctor,
        encounterId: session.context.encounter,
        ...(Object.keys(errors).length ? { errors } : {}),
      });
    });
  } catch (error) {
    logger.error("ecw-context", "eCW context failed", { event: "ecw_context_error", ...errorFields(error) });
    return NextResponse.json({ ok: false, error: { message: (error as Error).message } }, { status: 502 });
  }
}
