"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAppDispatch, useAppSelector } from "@/store/hooks";
import { store } from "@/store/index";
import {
  addTranscription,
  startVisit,
  startRecording,
  pauseRecording,
  resumeRecording,
  stopRecording,
  endVisit,
  tickTimer,
  setCurrentView,
  setShowQRCode,
  startReportGeneration,
  patchReportData,
  setReportSectionLoading,
  setConnectionState,
  setSessionId,
  setSpeechDetected,
  setFormattedTranscription,
  type ReportData,
  type ReportSectionKey,
} from "@/store/slices/recordingSlice";
import { Header, UserProfileSidebar } from "@/components/recording/Header";
import { AlertBanners } from "@/components/recording/AlertBanners";
import { RecorderPanel } from "@/components/recording/RecorderPanel";
import { TranscriptionPanel } from "@/components/recording/TranscriptionPanel";
import { PictureInPicture } from "@/components/recording/PictureInPicture";
import { QRCodeDialog } from "@/components/recording/Dialogs";
import { ReportView } from "@/components/report/ReportView";
import type { AlertType } from "@/components/recording/AlertBanners";
import { chargeVisitMinutesIfNeeded } from "@/lib/auth/minutes";
import { apiFetch, cleanDateValue, mapFollowUpAppointment } from "@/lib/utils";
import { normalizeMedicationFrequency } from "@/lib/medication";
import { normalizeReferrals } from "@/lib/referrals";
import { useLiveTranscription } from "@/hooks/useLiveTranscription";

interface AlertItem {
  type: AlertType;
  id: string;
}

/** How long to wait without speech before showing the microphone alert. */
const NO_VOICE_SILENCE_MS = 15_000;

function resolveAlertType(id: string): AlertType {
  if (id.startsWith("mic-error:") || id === "no-voice-timeout") {
    return "microphone";
  }

  if (id === "browser-offline" || (typeof navigator !== "undefined" && !navigator.onLine)) {
    return "no-network";
  }

  if (id === "socket-parse-error") {
    return "network-slow";
  }

  if (
    id === "socket-reconnecting" ||
    id.startsWith("socket-closed:") ||
    id.startsWith("socket-connect:") ||
    id.startsWith("socket-error:")
  ) {
    return "socket-disconnected";
  }

  return "socket-disconnected";
}

function normalizeSpeaker(value: string) {
  const lower = value.trim().toLowerCase();
  if (lower === "doctor") return "Doctor";
  if (lower === "patient") return "Patient";
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function extractSpeakerLines(payload: unknown): string[] {
  if (!payload) {
    return [];
  }

  if (typeof payload === "string") {
    try {
      return extractSpeakerLines(JSON.parse(payload));
    } catch {
      return [];
    }
  }

  if (Array.isArray(payload)) {
    return payload.flatMap((item) => extractSpeakerLines(item));
  }

  if (typeof payload === "object") {
    const obj = payload as Record<string, unknown>;

    if (Array.isArray(obj.transcript)) {
      return extractSpeakerLines(obj.transcript);
    }

    const lines: string[] = [];
    if (typeof obj.doctor === "string" && obj.doctor.trim()) {
      lines.push(`Doctor: ${obj.doctor.trim()}`);
    }
    if (typeof obj.patient === "string" && obj.patient.trim()) {
      lines.push(`Patient: ${obj.patient.trim()}`);
    }

    if (lines.length > 0) {
      return lines;
    }

    for (const [speaker, value] of Object.entries(obj)) {
      if (typeof value === "string" && value.trim()) {
        lines.push(`${normalizeSpeaker(speaker)}: ${value.trim()}`);
      }
    }
    return lines;
  }

  return [];
}

export default function RecordingPage() {
  const dispatch = useAppDispatch();
  const router = useRouter();
  const recording = useAppSelector((s) => s.recording);
  const user = useAppSelector((s) => s.user);
  const [alerts, setAlerts] = useState<AlertItem[]>([]);
  const [noTranscriptToast, setNoTranscriptToast] = useState(false);
  const [conversationText, setConversationText] = useState("");
  const [liveDraft, setLiveDraft] = useState("");

  const pushAlert = (type: AlertType, id: string) => {
    setAlerts((prev) => {
      if (prev.some((item) => item.id === id)) {
        return prev;
      }
      return [...prev, { type, id }];
    });
  };

  const {
    startTranscription,
    disconnect,
    stopAudioCapture,
    pauseSendingAudio,
    resumeSendingAudio,
    flushDraft,
  } = useLiveTranscription({
    onLiveDraft: setLiveDraft,
    onTurnComplete: (text) => dispatch(addTranscription(text)),
    onConnectionState: (state) => dispatch(setConnectionState(state)),
    onSessionId: (sessionId) => dispatch(setSessionId(sessionId)),
    onSpeechDetected: (detected) => dispatch(setSpeechDetected(detected)),
    onError: (id) => {
      pushAlert(resolveAlertType(id), id);
    },
    onClearError: (prefix) => {
      setAlerts((prev) => prev.filter((a) => !a.id.startsWith(prefix)));
    },
  });

  // Timer tick when recording and not paused
  useEffect(() => {
    if (!recording.isRecording || recording.isPaused) return;
    const interval = setInterval(() => {
      dispatch(tickTimer());
    }, 1000);
    return () => clearInterval(interval);
  }, [recording.isRecording, recording.isPaused, dispatch]);

  // Show alert when no voice is detected for an extended period while recording.
  useEffect(() => {
    if (!recording.isRecording || recording.isPaused) {
      setAlerts((prev) => prev.filter((alert) => alert.id !== "no-voice-timeout"));
      return;
    }

    if (recording.isSpeechDetected) {
      setAlerts((prev) => prev.filter((alert) => alert.id !== "no-voice-timeout"));
      return;
    }

    const timer = setTimeout(() => {
      pushAlert("microphone", "no-voice-timeout");
    }, NO_VOICE_SILENCE_MS);

    return () => clearTimeout(timer);
  }, [recording.isRecording, recording.isPaused, recording.isSpeechDetected]);

  // Show alert when the browser goes offline during a recording session.
  useEffect(() => {
    if (!recording.isRecording) {
      return;
    }

    const handleOffline = () => {
      pushAlert("no-network", "browser-offline");
    };

    const handleOnline = () => {
      setAlerts((prev) => prev.filter((alert) => alert.id !== "browser-offline"));
    };

    if (typeof navigator !== "undefined" && !navigator.onLine) {
      pushAlert("no-network", "browser-offline");
    }

    window.addEventListener("offline", handleOffline);
    window.addEventListener("online", handleOnline);

    return () => {
      window.removeEventListener("offline", handleOffline);
      window.removeEventListener("online", handleOnline);
    };
  }, [recording.isRecording]);

  const handleStartVisit = () => {
    const visitId = `visit_${Date.now()}`;
    dispatch(startVisit(visitId));
  };

  const handleStartRecording = async () => {
    if (recording.isRecording || recording.isConnecting) {
      return;
    }

    const started = await startTranscription();
    if (!started) {
      return;
    }

    dispatch(startRecording());
  };

  const handlePause = () => {
    pauseSendingAudio();
    dispatch(pauseRecording());
  };

  const handleResume = () => {
    resumeSendingAudio();
    dispatch(resumeRecording());
  };

  const generateReportFromMessage = async (
    rawMessage: string,
    visitIdAtGeneration: string | null = null
  ) => {
    const isStale = () =>
      visitIdAtGeneration != null &&
      store.getState().recording.visitId !== visitIdAtGeneration;

    const finishSection = (
      section: ReportSectionKey,
      patch?: Partial<ReportData>
    ) => {
      if (isStale()) return;
      if (patch) {
        dispatch(patchReportData(patch));
      }
      dispatch(setReportSectionLoading({ section, loading: false }));
    };

    const callAgentRoute = async <T,>(url: string, extraBody?: Record<string, string>) => {
      try {
        const response = await apiFetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            message: rawMessage,
            ...extraBody,
          }),
        });

        const data = (await response.json()) as T & { error?: string };

        const responseError =
          typeof data.error === "string" && data.error.trim() ? data.error.trim() : null;

        if (!response.ok || responseError) {
          return {
            ok: false as const,
            data: null,
            error: responseError || `Request failed for ${url}`,
          };
        }

        return {
          ok: true as const,
          data,
          error: null,
        };
      } catch (error) {
        return {
          ok: false as const,
          data: null,
          error: error instanceof Error ? error.message : `Request failed for ${url}`,
        };
      }
    };

    const today = new Date().toLocaleDateString("en-US", {
      month: "2-digit",
      day: "2-digit",
      year: "numeric",
    });

    const runTranscriptionFormatter = async () => {
      try {
        const formatterResponse = await apiFetch("/api/transcription-formatter", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            message: rawMessage,
          }),
        });

        if (!formatterResponse.ok) {
          const formatterData = (await formatterResponse.json().catch(() => ({}))) as {
            error?: string;
          };
          console.warn(
            "[generateReport] Transcription formatter failed:",
            formatterData.error || "Transcription formatter failed"
          );
          finishSection("transcription");
          return;
        }

        const formatterData = (await formatterResponse.json()) as {
          transcription?: unknown;
          transcript?: unknown;
          raw?: { output?: { transcript?: unknown } };
        };
        const structuredTranscript =
          formatterData.transcript ?? formatterData.raw?.output?.transcript ?? null;
        const formattedPayload = structuredTranscript ?? formatterData.transcription;
        const speakerLines = extractSpeakerLines(formattedPayload);

        if (isStale()) return;

        if (speakerLines.length > 0) {
          dispatch(setFormattedTranscription(speakerLines));
        } else if (
          typeof formatterData.transcription === "string" &&
          formatterData.transcription.trim()
        ) {
          const lines = formatterData.transcription
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line.length > 0);
          dispatch(
            setFormattedTranscription(
              lines.length > 0 ? lines : [formatterData.transcription]
            )
          );
        }
      } catch (error) {
        console.error("[generateReport] Transcription formatter error:", error);
      } finally {
        finishSection("transcription");
      }
    };

    const runVisitNotes = async () => {
      const result = await callAgentRoute<{ visit_notes?: string[] }>("/api/visit-notes");
      if (!result.ok) {
        console.warn("[generateReport] Visit notes failed:", result.error);
        finishSection("visitNotes");
        return;
      }
      const mappedVisitNotes = (result.data?.visit_notes || []).filter(
        (item) => item.trim().length > 0
      );
      finishSection("visitNotes", {
        visitNotes:
          mappedVisitNotes.length > 0 ? [mappedVisitNotes.join("\n\n")] : [],
      });
    };

    const runSoapNotes = async () => {
      const result = await callAgentRoute<{
        subjective?: string;
        objective?: string;
        assessment?: string;
        plan?: string;
      }>("/api/soap-notes");
      if (!result.ok) {
        console.warn("[generateReport] SOAP notes failed:", result.error);
        finishSection("soapNote");
        return;
      }
      const subjective = result.data?.subjective?.trim() || "";
      const objective = result.data?.objective?.trim() || "";
      const assessment = result.data?.assessment?.trim() || "";
      const plan = result.data?.plan?.trim() || "";
      finishSection("soapNote", {
        soapNote: {
          subjective: subjective ? { subjective } : {},
          objective: objective ? { objective } : {},
          assessment: assessment ? { assessment } : {},
          plan: plan ? { plan } : {},
        },
      });
    };

    const runIcdCodes = async () => {
      const result = await callAgentRoute<{
        icd_codes?: Array<{ icd_10_code: string; name: string }>;
      }>("/api/icd-10-codes");
      if (!result.ok) {
        console.warn("[generateReport] ICD-10 failed:", result.error);
        finishSection("icdCodes");
        return;
      }
      finishSection("icdCodes", {
        icdCodes: { icd_codes: result.data?.icd_codes || [] },
      });
    };

    const runCpt2Codes = async () => {
      const result = await callAgentRoute<{
        codes?: Array<{ cpt2_code: string; description: string }>;
      }>("/api/cpt2-codes");
      if (!result.ok) {
        console.warn("[generateReport] CPT-2 failed:", result.error);
        finishSection("cpt2Codes");
        return;
      }
      finishSection("cpt2Codes", {
        cpt2Codes: { codes: result.data?.codes || [] },
      });
    };

    const runFollowUp = async () => {
      const result = await callAgentRoute<{ follow_ups?: unknown[] }>(
        "/api/follow-ups",
        { current_date: today }
      );
      if (!result.ok) {
        console.warn("[generateReport] Follow-up failed:", result.error);
        finishSection("followup");
        return;
      }
      const firstFollowUp = (result.data?.follow_ups || [])[0];
      finishSection("followup", {
        followup: { follow_up_appointment: mapFollowUpAppointment(firstFollowUp) },
      });
    };

    const runEmCode = async () => {
      const result = await callAgentRoute<{ em_code?: string; description?: string }>(
        "/api/em-code"
      );
      if (!result.ok) {
        console.warn("[generateReport] E&M failed:", result.error);
        finishSection("emCodes");
        return;
      }
      finishSection("emCodes", {
        emCodes: {
          em_code: result.data?.em_code || "",
          description: result.data?.description || "",
        },
      });
    };

    const runMedications = async () => {
      const result = await callAgentRoute<{ medication?: unknown[] }>("/api/medications", {
        current_date: today,
      });
      if (!result.ok) {
        console.warn("[generateReport] Medication failed:", result.error);
        finishSection("medication");
        return;
      }

      const mappedPrescribedMedications = (result.data?.medication || [])
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

            const frequency = normalizeMedicationFrequency(med.frequency);
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
                typeof med.start_date === "string" && med.start_date
                  ? med.start_date
                  : today,
              days: typeof med.days === "string" ? med.days : "",
              instruction: typeof med.instruction === "string" ? med.instruction : "",
            };
          }

          return null;
        })
        .filter(
          (item): item is ReportData["medication"]["prescribed_medications"][number] =>
            item !== null
        );

      finishSection("medication", {
        medication: {
          prescribed_medications: mappedPrescribedMedications,
          in_clinic_medications: [],
        },
      });
    };

    const mapProcedures = (items: unknown[]) =>
      items
        .map((item) => {
          if (!item || typeof item !== "object") return null;
          const procedure = item as {
            name?: unknown;
            reason?: unknown;
            notes?: unknown;
            procedure_name?: unknown;
            clinical_context?: unknown;
            date?: unknown;
            procedure_type?: unknown;
          };

          const name =
            typeof procedure.name === "string"
              ? procedure.name
              : typeof procedure.procedure_name === "string"
                ? procedure.procedure_name
                : "";

          if (!name.trim()) {
            return null;
          }

          const mapped: Record<string, unknown> = { name };
          const date = cleanDateValue(procedure.date);
          if (date) {
            mapped.date = date;
          }
          if (typeof procedure.procedure_type === "string" && procedure.procedure_type.trim()) {
            mapped.procedure_type = procedure.procedure_type;
          }
          const note =
            typeof procedure.notes === "string" && procedure.notes.trim()
              ? procedure.notes
              : typeof procedure.reason === "string" && procedure.reason.trim()
                ? procedure.reason
                : typeof procedure.clinical_context === "string" &&
                    procedure.clinical_context.trim()
                  ? procedure.clinical_context
                  : "";
          if (note) {
            mapped.notes = note;
          }

          return mapped;
        })
        .filter((item): item is Record<string, unknown> => item !== null);

    const runProcedures = async () => {
      const result = await callAgentRoute<{
        procedure?: unknown[];
        procedures?: unknown[];
      }>("/api/procedures", { current_date: today });
      if (!result.ok) {
        console.warn("[generateReport] Procedures failed:", result.error);
        finishSection("procedure");
        return;
      }
      const mappedProcedures = mapProcedures(
        result.data?.procedure || result.data?.procedures || []
      );
      finishSection("procedure", {
        procedure: { procedure: mappedProcedures },
      });
    };

    const runReferrals = async () => {
      const result = await callAgentRoute<{ referrals?: unknown[] }>("/api/referrals");
      if (!result.ok) {
        console.warn("[generateReport] Referrals failed:", result.error);
        finishSection("referrals");
        return;
      }
      finishSection("referrals", {
        referrals: normalizeReferrals({ referrals: result.data?.referrals || [] }),
      });
    };

    const runCptPipeline = async () => {
      const result = await callAgentRoute<{
        procedures?: unknown[];
        cpt_codes?: Array<{ cpt_code: string; name: string }>;
      }>("/api/cpt-pipeline");
      if (!result.ok) {
        console.warn("[generateReport] CPT pipeline failed:", result.error);
        finishSection("cptCodes");
        return;
      }

      const mappedCptCodes = result.data?.cpt_codes || [];
      const patch: Partial<ReportData> = {
        cptCodes: { cpt_codes: mappedCptCodes },
      };

      const currentProcedures = store.getState().recording.reportData?.procedure.procedure || [];
      if (currentProcedures.length === 0) {
        const pipelineProcedures = mapProcedures(result.data?.procedures || []);
        if (pipelineProcedures.length > 0) {
          patch.procedure = { procedure: pipelineProcedures };
        }
      }

      finishSection("cptCodes", patch);
    };

    const runLabTests = async () => {
      const result = await callAgentRoute<{ lab_test?: unknown[] }>("/api/lab-tests", {
        current_date: today,
      });
      if (!result.ok) {
        console.warn("[generateReport] Lab tests failed:", result.error);
        finishSection("labtest");
        return;
      }

      const mappedLabTests = (result.data?.lab_test || [])
        .map((item) => {
          if (!item || typeof item !== "object") return null;
          const lab = item as {
            name?: unknown;
            test_name?: unknown;
            date?: unknown;
            notes?: unknown;
          };

          const name =
            typeof lab.name === "string"
              ? lab.name
              : typeof lab.test_name === "string"
                ? lab.test_name
                : "";
          if (!name.trim()) return null;

          const mapped: Record<string, unknown> = { name };
          const date = cleanDateValue(lab.date);
          if (date) {
            mapped.date = date;
          }
          if (typeof lab.notes === "string" && lab.notes.trim()) {
            mapped.notes = lab.notes.trim();
          }

          return mapped;
        })
        .filter((item): item is Record<string, unknown> => item !== null);

      finishSection("labtest", {
        labtest: { lab_test: mappedLabTests },
      });
    };

    const runVaccines = async () => {
      const result = await callAgentRoute<{ vaccine?: unknown[] }>("/api/vaccines", {
        current_date: today,
      });
      if (!result.ok) {
        console.warn("[generateReport] Vaccines failed:", result.error);
        finishSection("vaccine");
        return;
      }

      const mappedVaccines = (result.data?.vaccine || [])
        .map((item) => {
          if (typeof item === "string") {
            return item.trim() ? { name: item.trim() } : null;
          }
          if (!item || typeof item !== "object") return null;
          const vaccine = item as {
            name?: unknown;
            vaccine_name?: unknown;
            vaccineName?: unknown;
            dose?: unknown;
            dose_number?: unknown;
            doseNumber?: unknown;
            date?: unknown;
            vaccinationDate?: unknown;
          };
          const name =
            typeof vaccine.name === "string"
              ? vaccine.name
              : typeof vaccine.vaccine_name === "string"
                ? vaccine.vaccine_name
                : typeof vaccine.vaccineName === "string"
                  ? vaccine.vaccineName
                  : "";
          if (!name.trim()) return null;
          const dose =
            typeof vaccine.dose === "string"
              ? vaccine.dose
              : typeof vaccine.dose_number === "string"
                ? vaccine.dose_number
                : typeof vaccine.doseNumber === "string"
                  ? vaccine.doseNumber
                  : "";
          const date =
            typeof vaccine.date === "string"
              ? vaccine.date
              : typeof vaccine.vaccinationDate === "string"
                ? vaccine.vaccinationDate
                : "";
          return {
            name,
            ...(dose ? { dose } : {}),
            ...(date.trim() ? { date } : {}),
          };
        })
        .filter((item): item is { name: string; dose?: string; date?: string } => item !== null);

      finishSection("vaccine", {
        vaccine: { vaccine: mappedVaccines },
      });
    };

    await Promise.all([
      runTranscriptionFormatter(),
      runVisitNotes(),
      runSoapNotes(),
      runIcdCodes(),
      runCpt2Codes(),
      runFollowUp(),
      runEmCode(),
      runMedications(),
      runProcedures(),
      runReferrals(),
      runCptPipeline(),
      runLabTests(),
      runVaccines(),
    ]);
  };

  const handleStop = async () => {
    const visitIdAtStop = recording.visitId;
    const recordingTimeAtStop = recording.recordingTime;
    const visitMinutesChargedAtStop = recording.visitMinutesCharged;

    setAlerts([]);
    stopAudioCapture();
    const draft = flushDraft();
    disconnect();

    if (draft) {
      dispatch(addTranscription(draft));
      setLiveDraft("");
    }

    const transcriptMessage = [...store.getState().recording.transcription]
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .join("\n");

    if (!transcriptMessage) {
      // Empty visit ends here — deduct cumulative active recording time.
      await chargeVisitMinutesIfNeeded(
        dispatch,
        recordingTimeAtStop,
        visitMinutesChargedAtStop
      );
      // Fully reset state so Start Visit button reappears
      dispatch(endVisit());
      setNoTranscriptToast(true);
      setTimeout(() => setNoTranscriptToast(false), 5000);
      return;
    }

    // Minutes are deducted only at End Visit (or logout), not on Stop,
    // so Back to Recording can accumulate more active time for the same visit.
    dispatch(stopRecording());
    dispatch(startReportGeneration());
    dispatch(setCurrentView("report"));

    await generateReportFromMessage(transcriptMessage, visitIdAtStop);
  };

  const handleStartConversation = async () => {
    const message = conversationText.trim();
    if (!message) return;

    const visitId = `visit_${Date.now()}`;
    dispatch(startVisit(visitId));
    dispatch(addTranscription(message));
    dispatch(startReportGeneration());
    router.push("/visit-details");

    await generateReportFromMessage(message);
  };

  const dismissAlert = (id: string) => {
    setAlerts((prev) => prev.filter((a) => a.id !== id));
  };

  if (recording.currentView === "report") {
    return <ReportView />;
  }

  return (
    <div className="min-h-screen max-h-screen bg-white flex-col flex">
      <Header />
      <UserProfileSidebar />

      {/* Alert banners */}
      {alerts.length > 0 && (
        <div className="container mx-auto px-8 pt-4">
          <AlertBanners alerts={alerts} onDismiss={dismissAlert} />
        </div>
      )}

      {/* Main content */}
      <main className="container mx-auto pt-2 pb-6 px-6 flex-1 flex flex-col">
        {recording.recordingMode === "conversational" ? (
          <div className="w-full flex-1 flex items-start justify-center">
            <div className="w-full max-w-3xl bg-white rounded-2xl p-6 sm:p-8 shadow-[0_8px_30px_rgb(0,0,0,0.06)] border border-slate-100">
              <h2 className="text-xl font-semibold text-slate-800 mb-2">Conversation Input</h2>
              <p className="text-sm text-slate-500 mb-4">
                Paste or type the complete doctor-patient conversation below.
              </p>
              <textarea
                value={conversationText}
                onChange={(e) => setConversationText(e.target.value)}
                placeholder="Doctor: Good morning...\nPatient: I have a headache..."
                className="w-full min-h-[280px] p-4 rounded-xl border border-slate-200 text-sm leading-relaxed resize-y focus:outline-none focus:border-brand-blue focus:ring-1 focus:ring-brand-blue"
              />
              <button
                onClick={handleStartConversation}
                disabled={!conversationText.trim()}
                className="mt-4 w-full sm:w-auto px-6 h-12 bg-brand-green hover:bg-opacity-90 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-xl text-base font-medium shadow-md hover:shadow-lg transition-all"
              >
                Start
              </button>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 w-full flex-1 min-h-0">
            {/* Left: Recorder */}
            <RecorderPanel
              visitId={recording.visitId}
              isRecording={recording.isRecording}
              isPaused={recording.isPaused}
              isSpeechDetected={recording.isSpeechDetected}
              isConnected={recording.isConnected}
              isConnecting={recording.isConnecting}
              recordingTime={recording.recordingTime}
              onStartVisit={handleStartVisit}
              onStartRecording={handleStartRecording}
              onPause={handlePause}
              onResume={handleResume}
              onStop={handleStop}
            />

            {/* Right: Transcription */}
            <TranscriptionPanel
              transcription={recording.transcription}
              liveDraft={liveDraft}
              isRecording={recording.isRecording}
              isPaused={recording.isPaused}
              hasVisit={!!recording.visitId}
              hasReport={!!recording.reportData}
              onViewReport={() => dispatch(setCurrentView("report"))}
            />
          </div>
        )}
      </main>

      {/* Dialogs */}
      <QRCodeDialog
        open={recording.showQRCode}
        onClose={() => dispatch(setShowQRCode(false))}
        visitId={recording.visitId}
        patientId={user.email}
      />

      {recording.isRecording && recording.currentView === "recording" && (
        <PictureInPicture
          recordingTime={recording.recordingTime}
          isSpeechDetected={recording.isSpeechDetected}
          isPaused={recording.isPaused}
          transcriptionText={recording.transcription}
          onPause={handlePause}
          onResume={handleResume}
          onStop={handleStop}
        />
      )}

      {/* No-transcription toast */}
      {noTranscriptToast && (
        <div className="fixed bottom-6 right-6 z-[10001] flex items-start gap-3 bg-white border border-rose-200 shadow-2xl rounded-2xl px-5 py-4 max-w-sm animate-in slide-in-from-bottom-4 fade-in duration-300">
          <div className="flex-shrink-0 mt-0.5 h-8 w-8 rounded-full bg-rose-100 flex items-center justify-center">
            <svg className="h-4 w-4 text-rose-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
            </svg>
          </div>
          <div className="flex-1">
            <p className="font-semibold text-sm text-slate-900">No transcription captured</p>
            <p className="text-sm text-slate-500 mt-0.5">Please start recording and speak before stopping.</p>
          </div>
          <button
            onClick={() => setNoTranscriptToast(false)}
            className="flex-shrink-0 text-slate-400 hover:text-slate-600 transition-colors"
          >
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      )}

    </div>
  );
}
