"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import {
  Activity,
  ArrowLeft,
  Download,
  X,
  Loader2,
  AlertTriangle,
  ClipboardList,
  Lock,
  MessageSquare,
  RefreshCcw,
  Calendar,
  FileText,
  Stethoscope,
  Pill,
  FlaskConical,
  ClipboardCheck,
  ThumbsUp,
  ThumbsDown,
  Pencil,
  Save,
  Info,
} from "lucide-react";
import { toast } from "sonner";

import { useAppDispatch, useAppSelector } from "@/store/hooks";
import { apiFetch, cleanDateValue, displayMriFinding, mapFollowUpAppointment, withoutBasePath } from "@/lib/utils";
import { formatMedicationFrequency, normalizeMedicationFrequency } from "@/lib/medication";
import { getProcedureTypeBadge, getProcedureTypeBadgeClass } from "@/lib/procedure-types";
import {
  mapVisitNotesApiResponseToDisplay,
  qaHistoryToQuestionnaireResponses,
} from "@/lib/questionnaire-visit-notes";
import { formatReferralUrgency } from "@/lib/referrals";
import { PatientAnswerDisplay } from "@/components/recording/PatientAnswerDisplay";
import { isNoSpeechResponse } from "@/lib/conversation-mode";
import { chargeVisitMinutesIfNeeded, resolveDoctorId } from "@/lib/auth/minutes";
import { exportVisitReportPdf } from "@/lib/report-pdf";
import { toUserFacingApiError } from "@/lib/api-errors";
import { fetchOrdersPatchFromMessage } from "@/lib/regenerate-orders-from-message";
import {
  setCurrentView,
  endVisit,
  patchReportData,
  setReportData,
  setReportLoading,
  setReportSectionLoading,
  updateVisitNote,
  setMedicalNotesFeedbackRating,
  setOrdersFeedbackRating,
  type ReportData,
} from "@/store/slices/recordingSlice";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Dialog, DialogContent } from "@/components/ui/dialog";

type VisitNotesEditState = {
  isEditing: boolean;
  hasChanges: boolean;
};

function SectionBodyLoader() {
  return (
    <div className="flex items-center justify-center py-8">
      <Loader2 className="h-5 w-5 text-brand-blue animate-spin" />
    </div>
  );
}

function todayMmDdYyyy(): string {
  return new Date().toLocaleDateString("en-US", {
    month: "2-digit",
    day: "2-digit",
    year: "numeric",
  });
}


function RetryButton({ onClick, isLoading = false }: { onClick: () => void; isLoading?: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={isLoading}
      className="text-xs px-2 h-7 rounded-full border border-slate-200 hover:border-amber-500 hover:text-amber-500 transition-colors flex items-center disabled:opacity-60 disabled:cursor-not-allowed"
    >
      <RefreshCcw className={`h-3 w-3 mr-1 ${isLoading ? "animate-spin" : ""}`} />
      {isLoading ? "Retrying" : "Retry"}
    </button>
  );
}

function FeedbackPrompt({
  feedbackType,
  visitId,
  sessionId,
  notes,
  response,
  doctorId,
  doctorName,
  rating,
  onRatingChange,
}: {
  feedbackType: "visit_notes" | "medication";
  visitId: string | null;
  sessionId: string | null;
  notes: string;
  response: string[];
  doctorId: string;
  doctorName: string;
  rating: "up" | "down" | null;
  onRatingChange: (rating: "up" | "down" | null) => void;
}) {
  const [isSubmitting, setIsSubmitting] = useState(false);

  const submitFeedback = async (nextRating: "up" | "down") => {
    if (isSubmitting || nextRating === rating) {
      return;
    }

    if (!visitId) {
      toast.error("Visit ID is missing. Start a visit before submitting feedback.");
      return;
    }

    const previousRating = rating;
    const resolvedSessionId = sessionId || `session_${visitId}`;
    const numericRating = nextRating === "up" ? 1 : 0;

    onRatingChange(nextRating);
    setIsSubmitting(true);

    try {
      const apiResponse = await apiFetch("/api/diagnosis-feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          visit_id: visitId,
          session_id: resolvedSessionId,
          feedback_type: feedbackType,
          rating: numericRating,
          notes,
          response,
          doctor_id: doctorId,
          doctor_name: doctorName,
        }),
      });

      const data = (await apiResponse.json()) as { error?: string; success?: boolean };
      const apiError = getApiError(
        apiResponse,
        data,
        "Failed to submit feedback. Please try again."
      );

      if (apiError) {
        throw new Error(apiError);
      }

      toast.success("Thank you for your feedback");
    } catch (submitError) {
      onRatingChange(previousRating);
      toast.error(
        toUserFacingApiError(submitError, "Failed to submit feedback. Please try again.")
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="flex items-center justify-end gap-2 pt-2">
      <span className="text-xs text-slate-400">Was this helpful?</span>
      <button
        type="button"
        aria-label="Thumbs up"
        aria-pressed={rating === "up"}
        disabled={isSubmitting}
        onClick={() => void submitFeedback("up")}
        className={`h-7 w-7 rounded-full border flex items-center justify-center transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
          rating === "up"
            ? "border-emerald-500 text-emerald-600 bg-emerald-50"
            : "border-slate-200 text-slate-500 hover:border-emerald-300 hover:text-emerald-600"
        }`}
      >
        <ThumbsUp className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        aria-label="Thumbs down"
        aria-pressed={rating === "down"}
        disabled={isSubmitting}
        onClick={() => void submitFeedback("down")}
        className={`h-7 w-7 rounded-full border flex items-center justify-center transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
          rating === "down"
            ? "border-rose-500 text-rose-600 bg-rose-50"
            : "border-slate-200 text-slate-500 hover:border-rose-300 hover:text-rose-600"
        }`}
      >
        <ThumbsDown className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

function buildMedicalNotesFeedbackContent(reportData: ReportData) {
  const notes = JSON.stringify({
    visitNotes: reportData.visitNotes,
    soapNote: reportData.soapNote,
    icdCodes: reportData.icdCodes,
    cptCodes: reportData.cptCodes,
    cpt2Codes: reportData.cpt2Codes,
    emCodes: reportData.emCodes,
  });

  const response = [
    reportData.visitNotes[0] ? "Visit Summary" : "",
    "SOAP Notes",
    reportData.icdCodes.icd_codes.length > 0 ? "ICD-10 Coding" : "",
    reportData.cptCodes.cpt_codes.length > 0 ? "CPT Codes" : "",
    reportData.cpt2Codes.codes.length > 0 ? "CPT-2 Codes" : "",
    reportData.emCodes.em_code ? "EM Codes" : "",
  ].filter(Boolean);

  return { notes, response };
}

function buildOrdersFeedbackContent(reportData: ReportData) {
  const meds = reportData.medication.prescribed_medications;
  const notes = JSON.stringify({
    medication: reportData.medication,
    labtest: reportData.labtest,
    procedure: reportData.procedure,
    vaccine: reportData.vaccine,
    referrals: reportData.referrals,
    followup: reportData.followup,
  });

  const response =
    meds.length > 0
      ? meds.map((med) => med.correct_medicine_name).filter(Boolean)
      : ["Orders"];

  return { notes, response };
}

function buildTranscriptMessage(transcription: string[]) {
  return transcription
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join("\n");
}

function getApiError(
  response: Response,
  data: { error?: string },
  fallbackMessage: string
): string | null {
  const responseError =
    typeof data.error === "string" && data.error.trim() ? data.error.trim() : null;

  if (!response.ok || responseError) {
    return toUserFacingApiError(responseError || fallbackMessage, fallbackMessage);
  }

  return null;
}

function MedicalNotesTab({
  transcriptMessage,
  feedbackRating,
  onFeedbackRatingChange,
  onVisitNotesEditStateChange,
}: {
  transcriptMessage: string;
  feedbackRating: "up" | "down" | null;
  onFeedbackRatingChange: (rating: "up" | "down" | null) => void;
  onVisitNotesEditStateChange?: (state: VisitNotesEditState) => void;
}) {
  const dispatch = useAppDispatch();
  const reportData = useAppSelector((s) => s.recording.reportData);
  const sectionLoading = useAppSelector((s) => s.recording.reportSectionLoading);
  const visitId = useAppSelector((s) => s.recording.visitId);
  const sessionId = useAppSelector((s) => s.recording.sessionId);
  const qaHistory = useAppSelector((s) => s.recording.qaHistory);
  const user = useAppSelector((s) => s.user);

  const [expandedSoap, setExpandedSoap] = useState<Record<string, boolean>>({});
  const [retryingSection, setRetryingSection] = useState<"visit" | "soap" | "icd" | "cpt" | "cpt2" | "em" | null>(null);
  const [retryErrors, setRetryErrors] = useState<Record<string, string>>({});
  const [isEditingVisitNotes, setIsEditingVisitNotes] = useState(false);
  const [editedVisitNotes, setEditedVisitNotes] = useState("");
  const [hasVisitNotesChanged, setHasVisitNotesChanged] = useState(false);
  const [isSavingVisitNotes, setIsSavingVisitNotes] = useState(false);

  const visitNotesText = reportData?.visitNotes.join("\n").trim() ?? "";

  useEffect(() => {
    onVisitNotesEditStateChange?.({
      isEditing: isEditingVisitNotes,
      hasChanges: hasVisitNotesChanged,
    });
  }, [hasVisitNotesChanged, isEditingVisitNotes, onVisitNotesEditStateChange]);

  useEffect(() => {
    if (!isEditingVisitNotes) {
      setHasVisitNotesChanged(false);
      return;
    }
    setHasVisitNotesChanged(editedVisitNotes.trim() !== visitNotesText);
  }, [editedVisitNotes, isEditingVisitNotes, visitNotesText]);

  if (!reportData) return null;

  const doctorName = `${user.firstName} ${user.lastName}`.trim();
  const medicalNotesFeedback = buildMedicalNotesFeedbackContent(reportData);

  const handleEditVisitNotes = () => {
    setEditedVisitNotes(visitNotesText);
    setIsEditingVisitNotes(true);
    setHasVisitNotesChanged(false);
  };

  const handleCancelEditVisitNotes = () => {
    setIsEditingVisitNotes(false);
    setEditedVisitNotes("");
    setHasVisitNotesChanged(false);
  };

  const regenerateSoapNotes = async (message: string) => {
    dispatch(setReportSectionLoading({ section: "soapNote", loading: true }));
    try {
      const response = await apiFetch("/api/soap-notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message }),
      });

      const data = (await response.json()) as {
        subjective?: string;
        objective?: string;
        assessment?: string;
        plan?: string;
        error?: string;
      };

      const apiError = getApiError(response, data, "SOAP notes update failed");
      if (apiError) {
        throw new Error(apiError);
      }

      const subjective = data.subjective?.trim() || "";
      const objective = data.objective?.trim() || "";
      const assessment = data.assessment?.trim() || "";
      const plan = data.plan?.trim() || "";

      dispatch(
        patchReportData({
          soapNote: {
            subjective: subjective ? { subjective } : {},
            objective: objective ? { objective } : {},
            assessment: assessment ? { assessment } : {},
            plan: plan ? { plan } : {},
          },
        })
      );
    } finally {
      dispatch(setReportSectionLoading({ section: "soapNote", loading: false }));
    }
  };

  const regenerateOrdersFromMessage = async (message: string) => {
    const orderSections = [
      "medication",
      "labtest",
      "followup",
      "procedure",
      "referrals",
      "vaccine",
    ] as const;

    for (const section of orderSections) {
      dispatch(setReportSectionLoading({ section, loading: true }));
    }

    try {
      const ordersPatch = await fetchOrdersPatchFromMessage(message);
      dispatch(patchReportData(ordersPatch));
    } finally {
      for (const section of orderSections) {
        dispatch(setReportSectionLoading({ section, loading: false }));
      }
    }
  };

  const handleSaveVisitNotes = async () => {
    const nextVisitNotes = editedVisitNotes.trim();
    if (!nextVisitNotes) {
      toast.error("Visit notes cannot be empty.");
      return;
    }

    setIsSavingVisitNotes(true);
    try {
      dispatch(updateVisitNote(nextVisitNotes));
      setIsEditingVisitNotes(false);
      setEditedVisitNotes("");
      setHasVisitNotesChanged(false);

      await Promise.all([
        regenerateSoapNotes(nextVisitNotes),
        regenerateOrdersFromMessage(nextVisitNotes),
      ]);

      toast.success("Visit notes updated.");
    } catch (error) {
      toast.error(
        toUserFacingApiError(
          error,
          "Failed to refresh report sections from updated visit notes."
        )
      );
    } finally {
      setIsSavingVisitNotes(false);
    }
  };

  const retryVisitNotes = async () => {
    if (!transcriptMessage) return;
    setRetryingSection("visit");
    setRetryErrors((prev) => ({ ...prev, visit: "" }));
    try {
      const response = await apiFetch("/api/visit-notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: transcriptMessage,
          questionnaire_responses: qaHistoryToQuestionnaireResponses(qaHistory),
        }),
      });

      const data = (await response.json()) as {
        visit_notes?: unknown;
        visit_notes_text?: string[];
        error?: string;
      };
      const apiError = getApiError(response, data, "Visit notes retry failed");
      if (apiError) {
        throw new Error(apiError);
      }

      dispatch(
        setReportData({
          ...reportData,
          visitNotes: mapVisitNotesApiResponseToDisplay(data),
        })
      );
    } catch (error) {
      setRetryErrors((prev) => ({
        ...prev,
        visit: toUserFacingApiError(error, "Visit notes retry failed. Please try again."),
      }));
    } finally {
      setRetryingSection(null);
    }
  };

  const retrySoapNotes = async () => {
    if (!transcriptMessage) return;
    setRetryingSection("soap");
    setRetryErrors((prev) => ({ ...prev, soap: "" }));
    try {
      const response = await apiFetch("/api/soap-notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: transcriptMessage }),
      });

      const data = (await response.json()) as {
        subjective?: string;
        objective?: string;
        assessment?: string;
        plan?: string;
        error?: string;
      };

      const apiError = getApiError(response, data, "SOAP notes retry failed");
      if (apiError) {
        throw new Error(apiError);
      }

      const subjective = data.subjective?.trim() || "";
      const objective = data.objective?.trim() || "";
      const assessment = data.assessment?.trim() || "";
      const plan = data.plan?.trim() || "";

      dispatch(
        setReportData({
          ...reportData,
          soapNote: {
            subjective: subjective ? { subjective } : {},
            objective: objective ? { objective } : {},
            assessment: assessment ? { assessment } : {},
            plan: plan ? { plan } : {},
          },
        })
      );
    } catch (error) {
      setRetryErrors((prev) => ({
        ...prev,
        soap: toUserFacingApiError(error, "SOAP notes retry failed. Please try again."),
      }));
    } finally {
      setRetryingSection(null);
    }
  };

  const retryIcdCodes = async () => {
    if (!transcriptMessage) return;
    setRetryingSection("icd");
    setRetryErrors((prev) => ({ ...prev, icd: "" }));
    try {
      const response = await apiFetch("/api/icd-10-codes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: transcriptMessage }),
      });

      const data =
        (await response.json()) as {
          icd_codes?: Array<{ icd_10_code: string; name: string }>;
          error?: string;
        };

      const apiError = getApiError(response, data, "ICD-10 retry failed");
      if (apiError) {
        throw new Error(apiError);
      }

      dispatch(
        setReportData({
          ...reportData,
          icdCodes: {
            icd_codes: data.icd_codes || [],
          },
        })
      );
    } catch (error) {
      setRetryErrors((prev) => ({
        ...prev,
        icd: toUserFacingApiError(error, "ICD-10 retry failed. Please try again."),
      }));
    } finally {
      setRetryingSection(null);
    }
  };

  const retryCptCodes = async () => {
    if (!transcriptMessage) return;
    setRetryingSection("cpt");
    setRetryErrors((prev) => ({ ...prev, cpt: "" }));
    try {
      const response = await apiFetch("/api/cpt-pipeline", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: transcriptMessage }),
      });

      const data = (await response.json()) as {
        cpt_codes?: Array<{ cpt_code: string; name: string }>;
        error?: string;
      };

      const apiError = getApiError(response, data, "CPT retry failed");
      if (apiError) {
        throw new Error(apiError);
      }

      dispatch(
        setReportData({
          ...reportData,
          cptCodes: {
            cpt_codes: data.cpt_codes || [],
          },
        })
      );
    } catch (error) {
      setRetryErrors((prev) => ({
        ...prev,
        cpt: toUserFacingApiError(error, "CPT retry failed. Please try again."),
      }));
    } finally {
      setRetryingSection(null);
    }
  };

  const retryCpt2Codes = async () => {
    if (!transcriptMessage) return;
    setRetryingSection("cpt2");
    setRetryErrors((prev) => ({ ...prev, cpt2: "" }));
    try {
      const response = await apiFetch("/api/cpt2-codes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: transcriptMessage }),
      });

      const data = (await response.json()) as {
        codes?: Array<{ cpt2_code: string; description: string }>;
        error?: string;
      };

      const apiError = getApiError(response, data, "CPT-2 retry failed");
      if (apiError) {
        throw new Error(apiError);
      }

      dispatch(
        setReportData({
          ...reportData,
          cpt2Codes: {
            codes: data.codes || [],
          },
        })
      );
    } catch (error) {
      setRetryErrors((prev) => ({
        ...prev,
        cpt2: toUserFacingApiError(error, "CPT-2 retry failed. Please try again."),
      }));
    } finally {
      setRetryingSection(null);
    }
  };

  const retryEmCode = async () => {
    if (!transcriptMessage) return;
    setRetryingSection("em");
    setRetryErrors((prev) => ({ ...prev, em: "" }));
    try {
      const response = await apiFetch("/api/em-code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: transcriptMessage }),
      });

      const data = (await response.json()) as {
        em_code?: string;
        description?: string;
        error?: string;
      };

      const apiError = getApiError(response, data, "E/M retry failed");
      if (apiError) {
        throw new Error(apiError);
      }

      dispatch(
        setReportData({
          ...reportData,
          emCodes: {
            em_code: data.em_code || "",
            description: data.description || "",
          },
        })
      );
    } catch (error) {
      setRetryErrors((prev) => ({
        ...prev,
        em: toUserFacingApiError(error, "E/M retry failed. Please try again."),
      }));
    } finally {
      setRetryingSection(null);
    }
  };

  const isVisitSummaryMissing = !reportData.visitNotes[0];

  const soapSections = [
    { key: "subjective", label: "Subjective" },
    { key: "objective", label: "Objective" },
    { key: "assessment", label: "Assessment" },
    { key: "plan", label: "Plan" },
  ] as const;

  const isSoapMissing = soapSections.some(
    ({ key }) => Object.keys(reportData.soapNote[key]).length === 0
  );

  return (
    <div className="p-3 sm:p-6 space-y-4">
      <div className="grid gap-4 grid-cols-1 md:grid-cols-2">
        {/* Visit Summary */}
        <div className="bg-white p-3 rounded-xl border border-slate-100 shadow-[0_2px_6px_rgba(0,0,0,0.04),0_0_16px_2px_rgba(191,223,241,0.9)] flex flex-col max-h-[60vh] overflow-hidden">
          <div className="flex justify-between items-center mb-2">
            <div className="flex items-center gap-2">
              <h3 className="font-medium text-lg text-black">Visit Summary</h3>
              {isEditingVisitNotes && (
                <span
                  className="inline-flex"
                  title="You are editing visit notes. Going back without saving will discard your changes."
                >
                  <Info className="h-4 w-4 text-slate-400" />
                </span>
              )}
            </div>
            <div className="flex gap-2">
              {!isEditingVisitNotes && !!visitNotesText && (
                <button
                  type="button"
                  onClick={handleEditVisitNotes}
                  className="h-8 w-8 flex items-center justify-center rounded-md hover:bg-slate-100 transition-colors"
                  title="Edit visit notes"
                >
                  <Pencil className="h-4 w-4 text-slate-400 hover:text-brand-blue" />
                </button>
              )}
              {!sectionLoading.visitNotes && isVisitSummaryMissing && !isEditingVisitNotes && (
                <RetryButton onClick={retryVisitNotes} isLoading={retryingSection === "visit"} />
              )}
            </div>
          </div>
          {!!retryErrors.visit && (
            <p className="text-xs text-rose-600 mb-2">{retryErrors.visit}</p>
          )}
          {sectionLoading.visitNotes ? (
            <SectionBodyLoader />
          ) : isEditingVisitNotes ? (
            <div className="space-y-4 flex flex-col flex-1 min-h-0">
              <textarea
                className="w-full min-h-[300px] flex-1 p-4 rounded-lg border border-slate-200 focus:outline-none focus:ring-2 focus:ring-brand-blue/50 font-sans text-sm leading-relaxed resize-y"
                value={editedVisitNotes}
                onChange={(e) => setEditedVisitNotes(e.target.value)}
                placeholder="Enter visit notes..."
              />
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={handleCancelEditVisitNotes}
                  disabled={isSavingVisitNotes}
                  className="px-4 py-2 text-sm text-slate-500 hover:text-slate-700 rounded-lg hover:bg-slate-50 disabled:opacity-60"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => void handleSaveVisitNotes()}
                  disabled={isSavingVisitNotes || !editedVisitNotes.trim()}
                  className="px-4 py-2 text-sm bg-brand-blue hover:bg-brand-blue/90 text-white rounded-lg flex items-center gap-2 disabled:opacity-60"
                >
                  {isSavingVisitNotes ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Save className="h-4 w-4" />
                  )}
                  Save Changes
                </button>
              </div>
            </div>
          ) : (
            <div className="text-justify whitespace-pre-line overflow-y-auto flex-1 min-h-0 pr-4 text-sm text-slate-700">
              {visitNotesText || (
                <p className="text-slate-400 italic">No visit summary available.</p>
              )}
            </div>
          )}
        </div>

        {/* SOAP Notes */}
        <div className="bg-white p-3 rounded-xl border border-slate-100 shadow-[0_2px_6px_rgba(0,0,0,0.04),0_0_16px_2px_rgba(191,223,241,0.9)] flex flex-col overflow-hidden max-h-[60vh]">
          <div className="flex justify-between items-center mb-2">
            <h3 className="font-medium text-lg text-black">SOAP Notes</h3>
            {!sectionLoading.soapNote && isSoapMissing && (
              <RetryButton onClick={retrySoapNotes} isLoading={retryingSection === "soap"} />
            )}
          </div>
          {!!retryErrors.soap && (
            <p className="text-xs text-rose-600 mb-2">{retryErrors.soap}</p>
          )}
          {sectionLoading.soapNote ? (
            <SectionBodyLoader />
          ) : (
          <div className="space-y-3 overflow-y-auto flex-1">
            {soapSections.map(({ key, label }) => {
              const section = reportData.soapNote[key];
              const text = Object.values(section).join("\n");
              const isExpanded = expandedSoap[key];
              const canToggle = text.trim().length > 180;
              return (
                <div
                  key={key}
                  className="bg-white p-2 rounded-xl border border-slate-50 shadow-md relative"
                >
                  <h4 className="font-medium text-base text-black mb-1">{label}</h4>
                  <div
                    className={`text-sm text-slate-700 whitespace-pre-line ${!isExpanded && canToggle ? "line-clamp-2" : ""}`}
                  >
                    {text}
                  </div>
                  {canToggle && !isExpanded && (
                    <button
                      onClick={() => setExpandedSoap((p) => ({ ...p, [key]: true }))}
                      className="text-sm text-blue-500 hover:text-blue-700 font-medium mt-1"
                    >
                      Read more
                    </button>
                  )}
                  {canToggle && isExpanded && (
                    <button
                      onClick={() => setExpandedSoap((p) => ({ ...p, [key]: false }))}
                      className="text-sm text-blue-500 hover:text-blue-700 font-medium mt-1"
                    >
                      Show less
                    </button>
                  )}
                </div>
              );
            })}
          </div>
          )}
        </div>
      </div>

      {/* Code cards */}
      <div className="grid gap-4 grid-cols-1 md:grid-cols-2 mt-4">
        {/* ICD-10 */}
        <div className="bg-white p-3 rounded-xl border border-slate-100 shadow-[0_2px_6px_rgba(0,0,0,0.04),0_0_16px_2px_rgba(191,223,241,0.9)] max-h-[350px] flex flex-col">
          <div className="flex justify-between items-center mb-2">
            <h3 className="font-medium text-lg text-black">ICD-10 Coding</h3>
            {!sectionLoading.icdCodes && reportData.icdCodes.icd_codes.length === 0 && (
              <RetryButton onClick={retryIcdCodes} isLoading={retryingSection === "icd"} />
            )}
          </div>
          {!!retryErrors.icd && <p className="text-xs text-rose-600 mb-2">{retryErrors.icd}</p>}
          {sectionLoading.icdCodes ? (
            <SectionBodyLoader />
          ) : (
            <div className="space-y-3 overflow-y-auto flex-1 min-h-0 pr-2 pb-2">
              {reportData.icdCodes.icd_codes.length === 0 ? (
                <p className="text-sm text-slate-500 text-center py-2">No ICD codes available</p>
              ) : (
                reportData.icdCodes.icd_codes.map((c, i) => (
                  <div key={i} className="bg-white p-2.5 rounded-xl border border-slate-50 shadow-md">
                    <p className="font-bold text-sm leading-snug">
                      {c.icd_10_code} -{" "}
                      <span className="font-medium text-slate-700">{c.name}</span>
                    </p>
                  </div>
                ))
              )}
            </div>
          )}
        </div>

        {/* CPT Codes */}
        <div className="bg-white p-3 rounded-xl border border-slate-100 shadow-[0_2px_6px_rgba(0,0,0,0.04),0_0_16px_2px_rgba(191,223,241,0.9)] max-h-[350px] flex flex-col">
          <div className="flex justify-between items-center mb-2">
            <h3 className="font-medium text-lg text-black">CPT Codes</h3>
            {!sectionLoading.cptCodes && reportData.cptCodes.cpt_codes.length === 0 && (
              <RetryButton onClick={retryCptCodes} isLoading={retryingSection === "cpt"} />
            )}
          </div>
          {!!retryErrors.cpt && <p className="text-xs text-rose-600 mb-2">{retryErrors.cpt}</p>}
          {sectionLoading.cptCodes ? (
            <SectionBodyLoader />
          ) : (
            <div className="space-y-3 overflow-y-auto flex-1 min-h-0 pr-2 pb-2">
              {reportData.cptCodes.cpt_codes.length === 0 ? (
                <p className="text-sm text-slate-500 text-center py-2">No CPT codes available</p>
              ) : (
                reportData.cptCodes.cpt_codes.map((c, i) => (
                  <div key={i} className="bg-white p-2.5 rounded-xl border border-slate-50 shadow-md">
                    <p className="font-bold text-sm leading-snug">
                      {c.cpt_code} -{" "}
                      <span className="font-medium text-slate-700">{c.name}</span>
                    </p>
                  </div>
                ))
              )}
            </div>
          )}
        </div>

        {/* CPT-2 Codes */}
        <div className="bg-white p-3 rounded-xl border border-slate-100 shadow-[0_2px_6px_rgba(0,0,0,0.04),0_0_16px_2px_rgba(191,223,241,0.9)] max-h-[350px] flex flex-col">
          <div className="flex justify-between items-center mb-2">
            <h3 className="font-medium text-lg text-black">CPT-2 Codes</h3>
            {!sectionLoading.cpt2Codes && reportData.cpt2Codes.codes.length === 0 && (
              <RetryButton onClick={retryCpt2Codes} isLoading={retryingSection === "cpt2"} />
            )}
          </div>
          {!!retryErrors.cpt2 && <p className="text-xs text-rose-600 mb-2">{retryErrors.cpt2}</p>}
          {sectionLoading.cpt2Codes ? (
            <SectionBodyLoader />
          ) : (
            <div className="space-y-3 overflow-y-auto flex-1 min-h-0 pr-2 pb-2">
              {reportData.cpt2Codes.codes.length === 0 ? (
                <p className="text-sm text-slate-500 text-center py-2">No CPT-2 codes available</p>
              ) : (
                reportData.cpt2Codes.codes.map((c, i) => (
                  <div key={i} className="bg-white p-2.5 rounded-xl border border-slate-50 shadow-md">
                    <p className="font-bold text-sm leading-snug">
                      {c.cpt2_code} -{" "}
                      <span className="font-medium text-slate-700">{c.description}</span>
                    </p>
                  </div>
                ))
              )}
            </div>
          )}
        </div>

        {/* EM Codes */}
        <div className="bg-white p-3 rounded-xl border border-slate-100 shadow-[0_2px_6px_rgba(0,0,0,0.04),0_0_16px_2px_rgba(191,223,241,0.9)] max-h-[350px] flex flex-col">
          <div className="flex justify-between items-center mb-2">
            <h3 className="font-medium text-lg text-black">EM Codes</h3>
            {!sectionLoading.emCodes && !reportData.emCodes.em_code && (
              <RetryButton onClick={retryEmCode} isLoading={retryingSection === "em"} />
            )}
          </div>
          {!!retryErrors.em && <p className="text-xs text-rose-600 mb-2">{retryErrors.em}</p>}
          {sectionLoading.emCodes ? (
            <SectionBodyLoader />
          ) : (
            <div className="space-y-3 overflow-y-auto flex-1 min-h-0 pr-2 pb-2">
              {!reportData.emCodes.em_code ? (
                <p className="text-sm text-slate-500 text-center py-2">No E&M codes available</p>
              ) : (
                <div className="bg-white p-2.5 rounded-xl border border-slate-50 shadow-md">
                  <p className="font-bold text-sm leading-snug">
                    {reportData.emCodes.em_code} -{" "}
                    <span className="font-medium text-slate-700">{reportData.emCodes.description}</span>
                  </p>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <FeedbackPrompt
        feedbackType="visit_notes"
        visitId={visitId}
        sessionId={sessionId}
        notes={medicalNotesFeedback.notes}
        response={medicalNotesFeedback.response}
        doctorId={resolveDoctorId(user.email) || "unknown"}
        doctorName={doctorName}
        rating={feedbackRating}
        onRatingChange={onFeedbackRatingChange}
      />
    </div>
  );
}

function OrdersTab({
  transcriptMessage,
  feedbackRating,
  onFeedbackRatingChange,
}: {
  transcriptMessage: string;
  feedbackRating: "up" | "down" | null;
  onFeedbackRatingChange: (rating: "up" | "down" | null) => void;
}) {
  const dispatch = useAppDispatch();
  const reportData = useAppSelector((s) => s.recording.reportData);
  const visitId = useAppSelector((s) => s.recording.visitId);
  const sessionId = useAppSelector((s) => s.recording.sessionId);
  const user = useAppSelector((s) => s.user);
  const sectionLoading = useAppSelector((s) => s.recording.reportSectionLoading);
  const [retryingSection, setRetryingSection] = useState<"medications" | "labs" | "followup" | "procedures" | "vaccines" | "referrals" | null>(null);
  const [retryErrors, setRetryErrors] = useState<Record<string, string>>({});

  if (!reportData) return null;

  const doctorName = `${user.firstName} ${user.lastName}`.trim();
  const ordersFeedback = buildOrdersFeedbackContent(reportData);
  const meds = reportData.medication.prescribed_medications;
  const labs = (reportData.labtest.lab_test as Array<Record<string, unknown>>)
    .map((item) => {
      const name = typeof item.name === "string" ? item.name : "";
      if (!name.trim()) return null;
      const date = cleanDateValue(item.date);
      const notes = typeof item.notes === "string" && item.notes.trim() ? item.notes.trim() : "";
      return {
        name,
        ...(date ? { date } : {}),
        ...(notes ? { notes } : {}),
      };
    })
    .filter((item): item is { name: string; date?: string; notes?: string } => item !== null);
  const followup = reportData.followup.follow_up_appointment;
  const vaccines = (reportData.vaccine.vaccine as Array<Record<string, unknown>>)
    .map((item) => {
      const name =
        typeof item.name === "string"
          ? item.name
          : typeof item.vaccine_name === "string"
            ? item.vaccine_name
            : typeof item.vaccineName === "string"
              ? item.vaccineName
              : "";
      if (!name.trim()) return null;
      return {
        name,
        dose:
          typeof item.dose === "string" && item.dose.trim()
            ? item.dose
            : typeof item.dose_number === "string" && item.dose_number.trim()
              ? item.dose_number
              : typeof item.doseNumber === "string" && item.doseNumber.trim()
                ? item.doseNumber
                : "N/A",
        date:
          typeof item.date === "string" && item.date.trim()
            ? item.date
            : typeof item.vaccinationDate === "string" && item.vaccinationDate.trim()
              ? item.vaccinationDate
              : "N/A",
      };
    })
    .filter((item): item is { name: string; dose: string; date: string } => item !== null);
  const procedures = (reportData.procedure.procedure as Array<Record<string, unknown>>)
    .map((item) => {
      const name =
        typeof item.name === "string"
          ? item.name
          : typeof item.procedure_name === "string"
            ? item.procedure_name
            : "";
      if (!name.trim()) return null;
      const date = cleanDateValue(item.date);
      const note =
        (typeof item.notes === "string" && item.notes.trim()) ||
        (typeof item.reason === "string" && item.reason.trim()) ||
        (typeof item.clinical_context === "string" && item.clinical_context.trim()) ||
        "";
      return {
        name,
        ...(date ? { date } : {}),
        ...(note ? { note } : {}),
        badge: getProcedureTypeBadge(
          typeof item.procedure_type === "string" ? item.procedure_type : undefined
        ),
      };
    })
    .filter((item): item is { name: string; date?: string; note?: string; badge: string } => item !== null);

  const allProcedures = [
    ...procedures.map((item) => ({
      key: `procedure-${item.name}-${item.date ?? "no-date"}`,
      name: item.name,
      badge: item.badge,
      date: item.date,
      detailLabel: "Notes",
      detail: item.note,
    })),
    ...vaccines.map((item) => ({
      key: `vaccine-${item.name}-${item.date}`,
      name: item.name,
      badge: "Vaccine",
      date: item.date !== "N/A" ? item.date : undefined,
      detailLabel: "Dose",
      detail: item.dose !== "N/A" ? item.dose : undefined,
    })),
  ];

  const hasNoProcedures = procedures.length === 0;
  const hasNoVaccines = vaccines.length === 0;

  const referrals = (reportData.referrals as Array<Record<string, unknown>>)
    .map((item) => {
      const specialty =
        typeof item.specialty === "string"
          ? item.specialty
          : typeof item.specialist === "string"
            ? item.specialist
            : typeof item.name === "string"
              ? item.name
              : "";
      if (!specialty.trim()) return null;
      return {
        specialty,
        referred_to: typeof item.referred_to === "string" ? item.referred_to : "",
        reason:
          typeof item.reason === "string"
            ? item.reason
            : typeof item.clinical_context === "string"
              ? item.clinical_context
              : "",
        notes: typeof item.notes === "string" ? item.notes : "",
        urgency:
          typeof item.urgency === "string" && item.urgency.trim()
            ? item.urgency
            : typeof item.type === "string" && item.type.trim()
              ? item.type
              : "routine",
      };
    })
    .filter(
      (
        item
      ): item is {
        specialty: string;
        referred_to: string;
        reason: string;
        notes: string;
        urgency: string;
      } => item !== null
    );

  const followupCard = (() => {
    if (!followup) {
      return null;
    }
    const item = followup as unknown as Record<string, unknown>;
    return {
      date: cleanDateValue(item.date) || cleanDateValue(item.duration) || "N/A",
      reason:
        (typeof item.reason === "string" && item.reason.trim()) ||
        "No follow-up reason provided",
      instructions:
        (typeof item.instructions === "string" && item.instructions.trim()) ||
        "No additional instructions",
      badge:
        (typeof item.visit_type === "string" && item.visit_type.trim()
          ? `${item.visit_type} Follow-Up`
          : "Routine Follow-Up"),
    };
  })();

  const retryMedications = async () => {
    if (!transcriptMessage) return;
    setRetryingSection("medications");
    setRetryErrors((prev) => ({ ...prev, medications: "" }));
    try {
      const response = await apiFetch("/api/medications", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: transcriptMessage,
          current_date: todayMmDdYyyy(),
        }),
      });
      const data = (await response.json()) as { medication?: unknown[]; error?: string };
      const apiError = getApiError(response, data, "Medication retry failed");
      if (apiError) {
        throw new Error(apiError);
      }

      const today = todayMmDdYyyy();

      const mappedPrescribedMedications = (data.medication || [])
        .map((item) => {
          if (typeof item === "string") {
            return {
              correct_medicine_name: item,
              dosage: "",
              unit: "",
              frequency: { morning: null, afternoon: null, night: null },
              start_date: today,
              days: "",
              instruction: "",
            };
          }

          if (item && typeof item === "object") {
            const med = item as {
              correct_medicine_name?: unknown;
              medicine_name?: unknown;
              name?: unknown;
              dosage?: unknown;
              unit?: unknown;
              start_date?: unknown;
              days?: unknown;
              instruction?: unknown;
              frequency?: unknown;
            };

            const rawFreq = med.frequency;
            const frequency = normalizeMedicationFrequency(rawFreq);

            const medicineName =
              typeof med.correct_medicine_name === "string"
                ? med.correct_medicine_name
                : typeof med.medicine_name === "string"
                  ? med.medicine_name
                  : typeof med.name === "string"
                    ? med.name
                    : "";

            if (!medicineName) {
              return null;
            }

            return {
              correct_medicine_name: medicineName,
              dosage: typeof med.dosage === "string" ? med.dosage : "",
              unit: typeof med.unit === "string" ? med.unit : "",
              frequency,
              start_date:
                typeof med.start_date === "string" && med.start_date ? med.start_date : today,
              days: typeof med.days === "string" ? med.days : "",
              instruction: typeof med.instruction === "string" ? med.instruction : "",
            };
          }

          return null;
        })
        .filter(
          (
            item
          ): item is {
            correct_medicine_name: string;
            dosage: string;
            unit: string;
            frequency: { morning: string | null; afternoon: string | null; night: string | null };
            start_date: string;
            days: string;
            instruction: string;
          } => item !== null
        );

      dispatch(
        setReportData({
          ...reportData,
          medication: {
            ...reportData.medication,
            prescribed_medications: mappedPrescribedMedications,
          },
        })
      );
    } catch (error) {
      setRetryErrors((prev) => ({
        ...prev,
        medications: toUserFacingApiError(error, "Medication retry failed. Please try again."),
      }));
    } finally {
      setRetryingSection(null);
    }
  };

  const retryLabTests = async () => {
    if (!transcriptMessage) return;
    setRetryingSection("labs");
    setRetryErrors((prev) => ({ ...prev, labs: "" }));
    try {
      const response = await apiFetch("/api/lab-tests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: transcriptMessage, current_date: todayMmDdYyyy() }),
      });
      const data = (await response.json()) as { lab_test?: unknown[]; error?: string };
      const apiError = getApiError(response, data, "Lab tests retry failed");
      if (apiError) {
        throw new Error(apiError);
      }

      dispatch(
        setReportData({
          ...reportData,
          labtest: {
            lab_test: data.lab_test || [],
          },
        })
      );
    } catch (error) {
      setRetryErrors((prev) => ({
        ...prev,
        labs: toUserFacingApiError(error, "Lab tests retry failed. Please try again."),
      }));
    } finally {
      setRetryingSection(null);
    }
  };

  const retryFollowup = async () => {
    if (!transcriptMessage) return;
    setRetryingSection("followup");
    setRetryErrors((prev) => ({ ...prev, followup: "" }));
    try {
      const response = await apiFetch("/api/follow-ups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: transcriptMessage, current_date: todayMmDdYyyy() }),
      });
      const data = (await response.json()) as { follow_ups?: unknown[]; error?: string };
      const apiError = getApiError(response, data, "Follow-up retry failed");
      if (apiError) {
        throw new Error(apiError);
      }

      const firstFollowUp = (data.follow_ups || [])[0];
      const mappedFollowUp = mapFollowUpAppointment(firstFollowUp);

      dispatch(
        setReportData({
          ...reportData,
          followup: {
            follow_up_appointment: mappedFollowUp,
          },
        })
      );
    } catch (error) {
      setRetryErrors((prev) => ({
        ...prev,
        followup: toUserFacingApiError(error, "Follow-up retry failed. Please try again."),
      }));
    } finally {
      setRetryingSection(null);
    }
  };

  const retryProcedures = async () => {
    if (!transcriptMessage) return;
    setRetryingSection("procedures");
    setRetryErrors((prev) => ({ ...prev, procedures: "" }));
    try {
      const response = await apiFetch("/api/procedures", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: transcriptMessage, current_date: todayMmDdYyyy() }),
      });

      const data = (await response.json()) as {
        procedure?: unknown[];
        procedures?: unknown[];
        error?: string;
      };

      const apiError = getApiError(response, data, "Procedures retry failed");
      if (apiError) {
        throw new Error(apiError);
      }

      dispatch(
        setReportData({
          ...reportData,
          procedure: {
            procedure: data.procedure || data.procedures || [],
          },
        })
      );
    } catch (error) {
      setRetryErrors((prev) => ({
        ...prev,
        procedures: toUserFacingApiError(error, "Procedures retry failed. Please try again."),
      }));
    } finally {
      setRetryingSection(null);
    }
  };

  const retryProceduresAndVaccines = async () => {
    if (!transcriptMessage) return;
    setRetryingSection("procedures");
    setRetryErrors((prev) => ({ ...prev, procedures: "", vaccines: "" }));

    try {
      const [procedureResponse, vaccineResponse] = await Promise.all([
        apiFetch("/api/procedures", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: transcriptMessage,
            current_date: todayMmDdYyyy(),
          }),
        }),
        apiFetch("/api/vaccines", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: transcriptMessage,
            current_date: todayMmDdYyyy(),
          }),
        }),
      ]);

      const procedureData = (await procedureResponse.json()) as {
        procedure?: unknown[];
        procedures?: unknown[];
        error?: string;
      };
      const vaccineData = (await vaccineResponse.json()) as {
        vaccine?: unknown[];
        error?: string;
      };

      const procedureError = getApiError(procedureResponse, procedureData, "Procedures retry failed");
      const vaccineError = getApiError(vaccineResponse, vaccineData, "Vaccines retry failed");

      if (procedureError && vaccineError) {
        setRetryErrors((prev) => ({
          ...prev,
          procedures: toUserFacingApiError(
            new Error(procedureError),
            "Procedures retry failed. Please try again."
          ),
          vaccines: toUserFacingApiError(
            new Error(vaccineError),
            "Vaccines retry failed. Please try again."
          ),
        }));
        return;
      }

      dispatch(
        setReportData({
          ...reportData,
          ...(!procedureError
            ? { procedure: { procedure: procedureData.procedure || procedureData.procedures || [] } }
            : {}),
          ...(!vaccineError ? { vaccine: { vaccine: vaccineData.vaccine || [] } } : {}),
        })
      );

      setRetryErrors((prev) => ({
        ...prev,
        ...(procedureError
          ? {
              procedures: toUserFacingApiError(
                new Error(procedureError),
                "Procedures retry failed. Please try again."
              ),
            }
          : {}),
        ...(vaccineError
          ? {
              vaccines: toUserFacingApiError(
                new Error(vaccineError),
                "Vaccines retry failed. Please try again."
              ),
            }
          : {}),
      }));
    } catch (error) {
      setRetryErrors((prev) => ({
        ...prev,
        procedures: toUserFacingApiError(error, "Procedures retry failed. Please try again."),
        vaccines: toUserFacingApiError(error, "Vaccines retry failed. Please try again."),
      }));
    } finally {
      setRetryingSection(null);
    }
  };

  const retryVaccines = async () => {
    if (!transcriptMessage) return;
    setRetryingSection("vaccines");
    setRetryErrors((prev) => ({ ...prev, vaccines: "" }));
    try {
      const response = await apiFetch("/api/vaccines", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: transcriptMessage, current_date: todayMmDdYyyy() }),
      });

      const data = (await response.json()) as { vaccine?: unknown[]; error?: string };
      const apiError = getApiError(response, data, "Vaccines retry failed");
      if (apiError) {
        throw new Error(apiError);
      }

      dispatch(
        setReportData({
          ...reportData,
          vaccine: {
            vaccine: data.vaccine || [],
          },
        })
      );
    } catch (error) {
      setRetryErrors((prev) => ({
        ...prev,
        vaccines: toUserFacingApiError(error, "Vaccines retry failed. Please try again."),
      }));
    } finally {
      setRetryingSection(null);
    }
  };

  const retryReferrals = async () => {
    if (!transcriptMessage) return;
    setRetryingSection("referrals");
    setRetryErrors((prev) => ({ ...prev, referrals: "" }));
    try {
      const response = await apiFetch("/api/referrals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: transcriptMessage }),
      });
      const data = (await response.json()) as { referrals?: unknown[]; error?: string };
      const apiError = getApiError(response, data, "Referrals retry failed");
      if (apiError) {
        throw new Error(apiError);
      }

      dispatch(
        setReportData({
          ...reportData,
          referrals: data.referrals || [],
        })
      );
    } catch (error) {
      setRetryErrors((prev) => ({
        ...prev,
        referrals: toUserFacingApiError(error, "Referrals retry failed. Please try again."),
      }));
    } finally {
      setRetryingSection(null);
    }
  };

  return (
    <div className="p-3 sm:p-6 space-y-4">
      <div className="bg-white p-3 rounded-xl border border-slate-100 shadow-[0_2px_6px_rgba(0,0,0,0.04),0_0_16px_2px_rgba(191,223,241,0.9)]">
          <div className="flex justify-between items-center mb-2">
            <h3 className="font-medium text-lg text-black flex items-center gap-2">
            <Pill className="h-4 w-4 text-slate-400" />
            Prescribed Medications
          </h3>
          {!sectionLoading.medication && meds.length === 0 && <RetryButton onClick={retryMedications} isLoading={retryingSection === "medications"} />}
        </div>
        {!!retryErrors.medications && <p className="text-xs text-rose-600 mb-2">{retryErrors.medications}</p>}
        {sectionLoading.medication ? (
          <SectionBodyLoader />
        ) : meds.length === 0 ? (
          <div className="text-center p-4 text-slate-500">No medications prescribed</div>
        ) : (
          <div className="space-y-2">
            {meds.map((med, i) => (
              <div key={i} className="bg-white p-3 rounded-lg border border-slate-200 shadow-sm">
                <div className="grid grid-cols-2 md:grid-cols-6 gap-2">
                  <div className="font-bold text-sm text-slate-900 col-span-2 md:col-span-1">{med.correct_medicine_name}</div>
                  <div>
                    <p className="text-sm font-semibold text-slate-600">Dosage</p>
                    <p className="text-sm text-slate-800">{med.dosage && med.unit ? `${med.dosage} ${med.unit}` : med.dosage || "N/A"}</p>
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-slate-600">Frequency</p>
                    <p className="text-sm text-slate-800">{formatMedicationFrequency(med.frequency)}</p>
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-slate-600">Start Date</p>
                    <p className="text-sm text-slate-800">{med.start_date || "N/A"}</p>
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-slate-600">Duration</p>
                    <p className="text-sm text-slate-800">{med.days ? `${med.days} days` : "N/A"}</p>
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-slate-600">Instructions</p>
                    <p className="text-sm text-slate-800">{med.instruction || "N/A"}</p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="bg-white p-3 rounded-xl border border-slate-100 shadow-[0_2px_6px_rgba(0,0,0,0.04),0_0_16px_2px_rgba(191,223,241,0.9)]">
            <div className="flex justify-between items-center mb-2">
              <h3 className="font-medium text-lg text-black flex items-center gap-2">
              <FlaskConical className="h-4 w-4 text-slate-400" />
              Recommended Lab Tests
            </h3>
            {!sectionLoading.labtest && labs.length === 0 && <RetryButton onClick={retryLabTests} isLoading={retryingSection === "labs"} />}
          </div>
          {!!retryErrors.labs && <p className="text-xs text-rose-600 mb-2">{retryErrors.labs}</p>}
          {sectionLoading.labtest ? (
            <SectionBodyLoader />
          ) : labs.length === 0 ? (
            <div className="text-center p-4 text-slate-500">No lab tests recommended</div>
          ) : (
            <div className="space-y-2">
              {labs.map((lab, i) => (
                <div key={i} className="bg-white p-2.5 rounded-lg border border-slate-200 shadow-sm">
                  <p className="text-sm font-bold text-slate-900">{lab.name}</p>
                  {lab.date && (
                    <>
                      <p className="text-sm font-semibold text-slate-600 mt-1">Date</p>
                      <p className="text-sm text-slate-800">{lab.date}</p>
                    </>
                  )}
                  {lab.notes && (
                    <>
                      <p className="text-sm font-semibold text-slate-600 mt-1">Notes</p>
                      <p className="text-sm text-slate-800">{lab.notes}</p>
                    </>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="bg-white p-3 rounded-xl border border-slate-100 shadow-[0_2px_6px_rgba(0,0,0,0.04),0_0_16px_2px_rgba(191,223,241,0.9)]">
            <div className="flex justify-between items-center mb-2">
              <h3 className="font-medium text-lg text-black flex items-center gap-2">
              <ClipboardCheck className="h-4 w-4 text-slate-400" />
              Procedures
            </h3>
            <div className="flex items-center gap-2">
              {!sectionLoading.procedure && !sectionLoading.vaccine && hasNoProcedures && hasNoVaccines && (
                <RetryButton
                  onClick={retryProceduresAndVaccines}
                  isLoading={retryingSection === "procedures"}
                />
              )}
              {!sectionLoading.procedure && hasNoProcedures && !hasNoVaccines && (
                <RetryButton onClick={retryProcedures} isLoading={retryingSection === "procedures"} />
              )}
              {!sectionLoading.vaccine && hasNoVaccines && !hasNoProcedures && (
                <RetryButton onClick={retryVaccines} isLoading={retryingSection === "vaccines"} />
              )}
            </div>
          </div>
          {!!retryErrors.procedures && <p className="text-xs text-rose-600 mb-2">{retryErrors.procedures}</p>}
          {!!retryErrors.vaccines && <p className="text-xs text-rose-600 mb-2">{retryErrors.vaccines}</p>}

          {sectionLoading.procedure || sectionLoading.vaccine ? (
            <SectionBodyLoader />
          ) : allProcedures.length === 0 ? (
            <div className="text-center p-4 text-slate-500">No procedure information available</div>
          ) : (
            <div className="space-y-2">
              {allProcedures.map((item) => (
                <div key={item.key} className="bg-white p-2.5 rounded-lg border border-slate-200 shadow-sm">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-bold text-slate-900">{item.name}</p>
                    <span
                      className={`text-xs px-2 py-0.5 rounded-full font-medium ${getProcedureTypeBadgeClass(item.badge)}`}
                    >
                      {item.badge}
                    </span>
                  </div>
                  {item.date && (
                    <>
                      <p className="text-sm font-semibold text-slate-600 mt-1">Date</p>
                      <p className="text-sm text-slate-800">{item.date}</p>
                    </>
                  )}
                  {item.detail && (
                    <>
                      <p className="text-sm font-semibold text-slate-600 mt-1">{item.detailLabel}</p>
                      <p className="text-sm text-slate-800">{item.detail}</p>
                    </>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="bg-white p-3 rounded-xl border border-slate-100 shadow-[0_2px_6px_rgba(0,0,0,0.04),0_0_16px_2px_rgba(191,223,241,0.9)]">
            <div className="flex justify-between items-center mb-2">
              <h3 className="font-medium text-lg text-black flex items-center gap-2">
              <Stethoscope className="h-4 w-4 text-slate-400" />
              Referrals
            </h3>
            {!sectionLoading.referrals && referrals.length === 0 && <RetryButton onClick={retryReferrals} isLoading={retryingSection === "referrals"} />}
          </div>
          {!!retryErrors.referrals && <p className="text-xs text-rose-600 mb-2">{retryErrors.referrals}</p>}
          {sectionLoading.referrals ? (
            <SectionBodyLoader />
          ) : referrals.length === 0 ? (
            <div className="text-center p-4 text-slate-500">No referrals available</div>
          ) : (
            <div className="space-y-2">
              {referrals.map((referral, i) => (
                <div key={i} className="bg-white p-2.5 rounded-lg border border-slate-200 shadow-sm">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm font-bold text-slate-900">{referral.specialty}</p>
                    <span className="text-xs px-2 py-0.5 rounded-full bg-green-100 text-green-700 font-medium shrink-0">
                      {formatReferralUrgency(referral.urgency)}
                    </span>
                  </div>
                  {referral.referred_to && (
                    <p className="text-sm text-slate-800 mt-1">
                      <span className="font-semibold text-slate-600">Referred To:</span> {referral.referred_to}
                    </p>
                  )}
                  <p className="text-sm text-slate-800 mt-1"><span className="font-semibold text-slate-600">Reason:</span> {referral.reason || "N/A"}</p>
                  <p className="text-sm text-slate-800"><span className="font-semibold text-slate-600">Notes:</span> {referral.notes || "N/A"}</p>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="bg-white p-3 rounded-xl border border-slate-100 shadow-[0_2px_6px_rgba(0,0,0,0.04),0_0_16px_2px_rgba(191,223,241,0.9)]">
            <div className="flex justify-between items-center mb-2">
              <h3 className="font-medium text-lg text-black flex items-center gap-2">
              <Calendar className="h-4 w-4 text-slate-400" />
              Follow-up Appointment
            </h3>
            {!sectionLoading.followup && !followupCard && <RetryButton onClick={retryFollowup} isLoading={retryingSection === "followup"} />}
          </div>
          {!!retryErrors.followup && <p className="text-xs text-rose-600 mb-2">{retryErrors.followup}</p>}
          {sectionLoading.followup ? (
            <SectionBodyLoader />
          ) : !followupCard ? (
            <div className="text-center p-4 text-slate-500">No follow-up appointment scheduled</div>
          ) : (
            <div className="bg-white p-2.5 rounded-lg border border-slate-200 shadow-sm">
              <div className="flex items-center justify-between">
                <p className="text-sm font-bold text-slate-900">{followupCard.date}</p>
                <span className="text-xs px-2 py-0.5 rounded-full bg-green-100 text-green-700 font-medium">{followupCard.badge}</span>
              </div>
              <p className="text-sm text-slate-800 mt-1"><span className="font-semibold text-slate-600">Reason:</span> {followupCard.reason}</p>
              <p className="text-sm text-slate-800"><span className="font-semibold text-slate-600">Instructions:</span> {followupCard.instructions}</p>
            </div>
          )}
        </div>
      </div>

      <FeedbackPrompt
        feedbackType="medication"
        visitId={visitId}
        sessionId={sessionId}
        notes={ordersFeedback.notes}
        response={ordersFeedback.response}
        doctorId={resolveDoctorId(user.email) || "unknown"}
        doctorName={doctorName}
        rating={feedbackRating}
        onRatingChange={onFeedbackRatingChange}
      />
    </div>
  );
}

function TranscriptionTab() {
  const transcription = useAppSelector((s) => s.recording.transcription);
  const formattedTranscription = useAppSelector((s) => s.recording.formattedTranscription);
  const qaHistory = useAppSelector((s) => s.recording.qaHistory);
  const sectionLoading = useAppSelector((s) => s.recording.reportSectionLoading);
  const displayTranscription = formattedTranscription ?? transcription;

  const speakerRows = displayTranscription
    .map((line, index) => {
      const doctorMatch = line.match(/^doctor\s*:\s*(.*)$/i);
      if (doctorMatch) {
        return { key: index, speaker: "Doctor", message: doctorMatch[1]?.trim() || "", tone: "doctor" as const };
      }

      const patientMatch = line.match(/^patient\s*:\s*(.*)$/i);
      if (patientMatch) {
        return { key: index, speaker: "Patient", message: patientMatch[1]?.trim() || "", tone: "patient" as const };
      }

      return { key: index, speaker: "Doctor", message: line, tone: "doctor" as const };
    })
    .filter((row) => row.message.length > 0);

  return (
    <div className="p-3 sm:p-6">
      <div className="bg-white p-3 rounded-xl border border-slate-100 shadow-[0_2px_6px_rgba(0,0,0,0.04),0_0_16px_2px_rgba(191,223,241,0.9)]">
          <h3 className="font-medium text-lg text-black mb-4 flex items-center gap-2">
          <FileText className="h-5 w-5 text-slate-500" />
          Full Conversation
        </h3>
        <div className="bg-slate-50 rounded-xl p-4 max-h-[60vh] overflow-y-auto border border-slate-100">
          {sectionLoading.transcription ? (
            <SectionBodyLoader />
          ) : (
            <>
              {qaHistory.length > 0 && (
                <div className="mb-6 space-y-4">
                  <h4 className="text-sm font-semibold text-slate-600">Questionnaire</h4>
                  {qaHistory.map((qa, idx) => (
                    <div key={idx} className="space-y-2 pb-3 border-b border-slate-200">
                      <p className="text-sm font-semibold text-brand-green">Doctor</p>
                      <p className="text-base text-slate-700">{qa.questionEn}</p>
                      {qa.questionTranslated && (
                        <p className="text-sm text-slate-500 italic">{qa.questionTranslated}</p>
                      )}
                      <p className="text-sm font-semibold text-brand-orange mt-2">Patient</p>
                      <PatientAnswerDisplay
                        original={qa.responseTranslated?.original_text}
                        english={
                          qa.responseTranslated?.english_translation || qa.responseEn
                        }
                        language={qa.language}
                        skipped={!qa.responseTranslated && qa.responseEn === "Skipped"}
                        noSpeech={isNoSpeechResponse(qa.responseEn)}
                      />
                    </div>
                  ))}
                </div>
              )}
              {speakerRows.length === 0 && qaHistory.length === 0 ? (
                <p className="text-slate-400 italic text-center">No transcription available</p>
              ) : (
                speakerRows.map((row) => (
                  <div key={row.key} className="flex items-start gap-3 mb-4">
                    <div
                      className={`h-9 w-9 rounded-full text-white text-sm font-semibold flex items-center justify-center flex-shrink-0 ${
                        row.tone === "doctor" ? "bg-brand-blue" : "bg-brand-orange"
                      }`}
                    >
                      {row.tone === "doctor" ? "D" : "P"}
                    </div>
                    <div className="flex-1 bg-white border border-slate-200 rounded-xl px-3 py-2 shadow-sm">
                      <p className={`text-lg font-semibold ${row.tone === "doctor" ? "text-brand-blue" : "text-brand-orange"}`}>
                        {row.speaker}
                      </p>
                      <p className="text-base leading-relaxed text-slate-700">{row.message}</p>
                    </div>
                  </div>
                ))
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function MRIReportTab() {
  const mriReport = useAppSelector((s) => s.recording.mriReport);

  if (!mriReport?.data?.studies?.length) {
    return (
      <div className="p-8 text-center text-slate-500">
        <Activity className="h-12 w-12 mx-auto mb-3 text-slate-300" />
        <p>No MRI studies available</p>
      </div>
    );
  }

  return (
    <div className="p-3 sm:p-6 space-y-4">
      {mriReport.data.studies.map((study, studyIndex) => (
        <div
          key={studyIndex}
          className="border border-brand-blue/10 rounded-lg p-5 bg-gradient-to-br from-brand-blue/5 to-white"
        >
          <h4 className="font-semibold text-brand-blue text-base mb-2">
            {study.region?.replace(/_/g, " ").toUpperCase() || "MRI Study"}
          </h4>
          {study.human_label && (
            <p className="text-xs text-slate-500 mb-3">{study.human_label}</p>
          )}
          {study.findings?.length ? (
            study.findings.map((finding, findingIndex) => {
              const { label, details } = displayMriFinding(finding);
              return (
              <div key={findingIndex} className="flex items-start gap-3 mb-2">
                <div className="font-medium text-sm text-slate-800">
                  {label}
                </div>
                {details && (
                  <div className="text-sm text-slate-600">- {details}</div>
                )}
              </div>
              );
            })
          ) : (
            <p className="text-sm text-slate-500 italic">No findings recorded</p>
          )}
        </div>
      ))}
    </div>
  );
}

export function ReportView({ onBeforeEndVisit }: { onBeforeEndVisit?: () => void } = {}) {
  const dispatch = useAppDispatch();
  const router = useRouter();
  const pathname = usePathname();
  const isVisitDetailsRoute = withoutBasePath(pathname ?? "") === "/visit-details";
  const { reportData, visitId, transcription, formattedTranscription, recordingTime, visitMinutesCharged } = useAppSelector((s) => s.recording);
  const mriReport = useAppSelector((s) => s.recording.mriReport);
  const transcriptMessage = buildTranscriptMessage(transcription);
  const displayTranscription = formattedTranscription ?? transcription;
  const [isExporting, setIsExporting] = useState(false);
  const [exportWarning, setExportWarning] = useState("");
  const [isEndingVisit, setIsEndingVisit] = useState(false);
  const medicalNotesFeedbackRating = useAppSelector((s) => s.recording.medicalNotesFeedbackRating);
  const ordersFeedbackRating = useAppSelector((s) => s.recording.ordersFeedbackRating);
  const tabCount = mriReport?.data?.studies?.length ? 4 : 3;
  const [visitNotesEditState, setVisitNotesEditState] = useState<VisitNotesEditState>({
    isEditing: false,
    hasChanges: false,
  });
  const [showVisitNotesWarning, setShowVisitNotesWarning] = useState(false);

  const navigateBackToRecording = () => {
    dispatch(setReportLoading(false));
    dispatch(setCurrentView("recording"));
    if (isVisitDetailsRoute) {
      router.push("/recording");
    }
  };

  const handleBack = () => {
    if (visitNotesEditState.isEditing || visitNotesEditState.hasChanges) {
      setShowVisitNotesWarning(true);
      return;
    }
    navigateBackToRecording();
  };

  const handleEndVisit = async () => {
    if (isEndingVisit) {
      return;
    }

    setIsEndingVisit(true);
    try {
      onBeforeEndVisit?.();
      await chargeVisitMinutesIfNeeded(dispatch, recordingTime, visitMinutesCharged);
      dispatch(endVisit());
      if (isVisitDetailsRoute) {
        router.push("/recording");
      }
    } finally {
      setIsEndingVisit(false);
    }
  };

  const handleExportPDF = async () => {
    if (!reportData) {
      setExportWarning("No report data available to export.");
      setTimeout(() => setExportWarning(""), 3000);
      return;
    }

    setIsExporting(true);
    try {
      await exportVisitReportPdf({
        reportData,
        visitId,
        transcription: displayTranscription,
      });
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <div className="min-h-screen bg-white">
      {/* Report Header */}
      <header className="bg-white border-b border-slate-100 py-2 px-2 sm:py-4 sm:px-6 flex justify-between items-center gap-1 sm:gap-2 sticky top-0 z-50 shadow-sm">
        <button
          onClick={handleBack}
          className="flex items-center space-x-1 sm:space-x-2 text-slate-600 hover:text-brand-blue px-1 sm:px-3 text-sm transition-colors"
        >
          <ArrowLeft className="h-4 w-4 shrink-0" />
          <span className="hidden sm:inline">Back to Recording</span>
        </button>

        <h1 className="text-xs sm:text-lg font-bold bg-clip-text text-transparent bg-brand-gradient truncate">
          HIKIGAI AIScribe
        </h1>

        <div className="flex space-x-1 sm:space-x-2">
          {exportWarning && (
            <span className="flex items-center gap-1 text-xs text-amber-600 bg-amber-50 border border-amber-200 rounded-full px-2 py-1">
              <AlertTriangle className="h-3 w-3 shrink-0" />
              <span className="hidden sm:inline">{exportWarning}</span>
            </span>
          )}
          <button
            onClick={handleExportPDF}
            disabled={isExporting}
            className="rounded-full border border-slate-200 hover:border-brand-green hover:text-brand-green text-xs sm:text-sm px-2 sm:px-3 h-8 sm:h-9 flex items-center transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {isExporting ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin sm:mr-2" />
                <span className="hidden sm:inline">Exporting...</span>
              </>
            ) : (
              <>
                <Download className="h-4 w-4 sm:mr-2" />
                <span className="hidden sm:inline">Export PDF</span>
              </>
            )}
          </button>
          <button
            onClick={() => void handleEndVisit()}
            disabled={isEndingVisit}
            className="text-red-500 hover:text-white hover:bg-red-500 border border-red-200 rounded-full px-2 sm:px-4 h-8 sm:h-9 flex items-center text-sm transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {isEndingVisit ? (
              <Loader2 className="h-4 w-4 animate-spin sm:mr-1" />
            ) : (
              <X className="h-4 w-4 sm:mr-1" />
            )}
            <span className="hidden sm:inline">End Visit</span>
          </button>
        </div>
      </header>

      {/* No data state */}
      {!reportData && (
        <div className="flex justify-center items-center h-[60vh]">
          <div className="flex flex-col items-center text-center">
            <AlertTriangle className="h-12 w-12 text-brand-orange mb-4" />
            <h2 className="text-xl font-medium text-brand-orange mb-2">
              No Report Data Available
            </h2>
            <p className="text-slate-600 max-w-md mb-4">
              We couldn&apos;t find any report data. Please go back to the recording page to start
              a new session.
            </p>
            <button
              onClick={() => dispatch(setCurrentView("recording"))}
              className="mt-2 bg-brand-blue text-white hover:bg-brand-pink rounded-lg px-6 py-2 transition-colors"
            >
              Return to Recording
            </button>
          </div>
        </div>
      )}

      {/* Tabs — shown as soon as report generation starts */}
      {reportData && (
        <main className="mx-2 py-3 px-2 sm:mx-8 sm:py-8 sm:px-6">
          <h1 className="text-base sm:text-2xl mb-2 font-semibold text-slate-800">Visit Notes</h1>
          <div className="bg-white rounded-2xl shadow-[0_8px_30px_rgb(0,0,0,0.06)] overflow-hidden">
            <Tabs defaultValue="medical-notes">
              <div className="overflow-x-auto px-2 sm:px-4 pt-2 pb-2">
                <TabsList
                  className={`grid bg-transparent rounded-lg p-1 gap-1 sm:gap-2 h-auto w-full ${
                    tabCount === 4 ? "grid-cols-4" : "grid-cols-3"
                  }`}
                >
                  <TabsTrigger value="medical-notes">
                    <ClipboardList className="h-3.5 w-3.5 sm:h-4 sm:w-4 shrink-0" />
                    <span className="truncate">Medical Notes</span>
                  </TabsTrigger>
                  <TabsTrigger value="orders">
                    <Lock className="h-3.5 w-3.5 sm:h-4 sm:w-4 shrink-0" />
                    <span className="truncate">Orders</span>
                  </TabsTrigger>
                  <TabsTrigger value="transcription">
                    <MessageSquare className="h-3.5 w-3.5 sm:h-4 sm:w-4 shrink-0" />
                    <span className="truncate">Transcription</span>
                  </TabsTrigger>
                  {!!mriReport?.data?.studies?.length && (
                    <TabsTrigger value="mri-report">
                      <Activity className="h-3.5 w-3.5 sm:h-4 sm:w-4 shrink-0" />
                      <span className="truncate">MRI Report</span>
                    </TabsTrigger>
                  )}
                </TabsList>
              </div>

              <TabsContent value="medical-notes">
                <MedicalNotesTab
                  transcriptMessage={transcriptMessage}
                  feedbackRating={medicalNotesFeedbackRating}
                  onFeedbackRatingChange={(r) => dispatch(setMedicalNotesFeedbackRating(r))}
                  onVisitNotesEditStateChange={setVisitNotesEditState}
                />
              </TabsContent>
              <TabsContent value="orders">
                <OrdersTab
                  transcriptMessage={transcriptMessage}
                  feedbackRating={ordersFeedbackRating}
                  onFeedbackRatingChange={(r) => dispatch(setOrdersFeedbackRating(r))}
                />
              </TabsContent>
              <TabsContent value="transcription">
                <TranscriptionTab />
              </TabsContent>
              {!!mriReport?.data?.studies?.length && (
                <TabsContent value="mri-report">
                  <MRIReportTab />
                </TabsContent>
              )}
            </Tabs>
          </div>
        </main>
      )}

      <Dialog open={showVisitNotesWarning} onOpenChange={setShowVisitNotesWarning}>
        <DialogContent
          className="p-6"
          showClose={false}
          hiddenTitle="Unsaved visit notes changes"
          hiddenDescription="Discard unsaved visit notes changes and return to recording"
        >
          <h2 className="text-lg font-semibold text-slate-900">Unsaved Changes</h2>
          <p className="mt-2 text-sm text-slate-600">
            You are currently editing the visit notes. Going back to the recording page will
            discard any changes you&apos;ve made. Are you sure you want to continue?
          </p>
          <div className="mt-6 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setShowVisitNotesWarning(false)}
              className="px-4 py-2 text-sm border border-slate-200 rounded-lg hover:bg-slate-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => {
                setShowVisitNotesWarning(false);
                navigateBackToRecording();
              }}
              className="px-4 py-2 text-sm bg-brand-blue hover:bg-brand-blue/90 text-white rounded-lg"
            >
              Go Back
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
