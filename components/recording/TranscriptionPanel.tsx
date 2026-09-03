"use client";

import { useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Eye, Loader2 } from "lucide-react";
import { useAppSelector } from "@/store/hooks";
import { PARENT_LANGUAGE, QUESTIONS, isNoSpeechResponse } from "@/lib/conversation-mode";
import { PatientAnswerDisplay } from "@/components/recording/PatientAnswerDisplay";
import type { RecordingMode } from "@/store/slices/recordingSlice";

function DoctorQuestionDisplay({
  questionEn,
  questionTranslated,
  showTranslation,
}: {
  questionEn: string;
  questionTranslated?: string;
  showTranslation: boolean;
}) {
  return (
    <>
      <div className="text-base font-semibold text-slate-800">{questionEn}</div>
      {showTranslation && questionTranslated && (
        <div className="text-base text-slate-500 italic" dir="auto">
          {questionTranslated}
        </div>
      )}
    </>
  );
}

interface TranscriptionPanelProps {
  transcription: string[];
  liveDraft?: string;
  isRecording: boolean;
  isPaused: boolean;
  hasVisit: boolean;
  hasReport?: boolean;
  recordingMode?: RecordingMode;
  onViewReport?: () => void;
}

export function TranscriptionPanel({
  transcription,
  liveDraft,
  isRecording,
  isPaused,
  hasVisit,
  hasReport = false,
  recordingMode = "normal",
  onViewReport,
}: TranscriptionPanelProps) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const {
    qaHistory,
    questionnaireStarted,
    questionnaireCompleted,
    currentQuestionIndex,
    currentQuestionTranslated,
    currentQuestionResponse,
    currentResponseTranslated,
    questionnaireStatus,
    selectedLanguage,
  } = useAppSelector((s) => s.recording);

  const showQuestionnaire =
    recordingMode === "conversational" &&
    (questionnaireStarted || questionnaireCompleted || qaHistory.length > 0);

  const showTranslatedQuestion =
    !!selectedLanguage && selectedLanguage !== PARENT_LANGUAGE;

  const isBufferingAnswer = questionnaireStatus === "Buffering...";

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [
    transcription,
    liveDraft,
    qaHistory,
    currentQuestionResponse,
    currentQuestionTranslated,
    questionnaireStatus,
  ]);

  return (
    <div className="flex flex-col bg-white rounded-2xl shadow-[0_2px_6px_rgba(0,0,0,0.04),0_0_16px_2px_rgba(191,223,241,0.9)] p-6 pt-4">
      <div className="flex justify-between mb-4 items-center">
        <h2 className="text-lg font-medium flex items-center gap-2">
          <span className="bg-clip-text text-transparent bg-gradient-to-r from-brand-blue to-brand-green">
            Live Transcription
          </span>
          {isRecording && !isPaused && (
            <span className="inline-block h-2 w-2 rounded-full bg-brand-green animate-pulse" />
          )}
        </h2>
        {(hasReport || transcription.length > 0) && !isRecording && onViewReport && (
            <button
              onClick={onViewReport}
              className="text-xs text-brand-blue flex items-center gap-1 hover:underline"
            >
              <Eye className="h-3 w-3" />
              Report
            </button>
          )}
      </div>

      <div className="bg-slate-50 rounded-xl p-5 overflow-y-auto border border-slate-100 h-[63vh] flex flex-col">
        {!hasVisit ? (
          <div className="flex items-center justify-center h-full">
            <p className="text-slate-400 italic text-center">Start a visit to proceed</p>
          </div>
        ) : showQuestionnaire ? (
          <div className="space-y-4">
            {qaHistory.map((qa, idx) => (
              <div key={idx} className="space-y-3 pb-4 border-b border-slate-200">
                <div className="text-sm font-semibold text-brand-green">Doctor</div>
                <DoctorQuestionDisplay
                  questionEn={qa.questionEn}
                  questionTranslated={qa.questionTranslated}
                  showTranslation={showTranslatedQuestion}
                />
                <div className="text-sm font-semibold text-brand-blue mt-3">Patient</div>
                <PatientAnswerDisplay
                  original={qa.responseTranslated?.original_text}
                  english={
                    qa.responseTranslated?.english_translation || qa.responseEn
                  }
                  language={selectedLanguage}
                  skipped={!qa.responseTranslated && qa.responseEn === "Skipped"}
                  noSpeech={isNoSpeechResponse(qa.responseEn)}
                />
              </div>
            ))}

            {questionnaireStarted && !questionnaireCompleted && (
              <div className="space-y-3">
                <div className="text-sm font-semibold text-brand-green">Doctor</div>
                <DoctorQuestionDisplay
                  questionEn={QUESTIONS[currentQuestionIndex]?.text_en ?? ""}
                  questionTranslated={currentQuestionTranslated}
                  showTranslation={showTranslatedQuestion}
                />
                {isBufferingAnswer && !currentQuestionResponse && (
                  <>
                    <div className="text-sm font-semibold text-brand-blue mt-3">Patient</div>
                    <div className="flex items-center gap-2 text-sm text-slate-500 italic">
                      <Loader2 className="h-4 w-4 animate-spin shrink-0" />
                      Buffering...
                    </div>
                  </>
                )}
                {currentQuestionResponse && (
                  <>
                    <div className="text-sm font-semibold text-brand-blue mt-3">Patient</div>
                    {currentResponseTranslated ? (
                      <PatientAnswerDisplay
                        original={currentResponseTranslated.original_text}
                        english={currentResponseTranslated.english_translation}
                        language={selectedLanguage}
                      />
                    ) : (
                      <PatientAnswerDisplay
                        english={currentQuestionResponse}
                        noSpeech={isNoSpeechResponse(currentQuestionResponse)}
                      />
                    )}
                  </>
                )}
              </div>
            )}

            {(questionnaireCompleted || qaHistory.length > 0) && transcription.length > 0 && (
              <div>
                <div className="text-sm font-semibold text-brand-green mb-4">
                  Visit Notes Recording
                </div>
                <AnimatePresence initial={false}>
                  {transcription.map((text, i) => (
                    <motion.div
                      key={`visit-${i}`}
                      initial={{ opacity: 0, y: 12 }}
                      animate={{ opacity: 1, y: 0 }}
                      className="mb-3"
                    >
                      <p className="leading-relaxed text-sm">{text}</p>
                    </motion.div>
                  ))}
                </AnimatePresence>
                {!!liveDraft && (
                  <p className="leading-relaxed text-sm text-slate-500 italic">{liveDraft}</p>
                )}
              </div>
            )}

            {questionnaireStatus && !questionnaireCompleted && (
              <div className="text-xs text-slate-500 italic mt-4 pt-4 border-t border-slate-200">
                {questionnaireStatus}
              </div>
            )}
            <div ref={bottomRef} />
          </div>
        ) : transcription.length === 0 && !liveDraft ? (
          <div className="flex items-center justify-center h-full">
            <p className="text-slate-400 italic text-center">
              {isRecording
                ? "Listening..."
                : recordingMode === "conversational"
                  ? "Select the patient's language and click on 'Questionnaire' to start asking questions."
                  : "Start recording to see transcription"}
            </p>
          </div>
        ) : (
          <>
            <AnimatePresence initial={false}>
              {transcription.map((text, i) => (
                <motion.div
                  key={i}
                  initial={{ opacity: 0, y: 20, filter: "blur(8px)" }}
                  animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
                  transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
                  className="mb-3"
                >
                  <p className="leading-relaxed text-sm">{text}</p>
                </motion.div>
              ))}
              {!!liveDraft && (
                <motion.div
                  initial={{ opacity: 0.5 }}
                  animate={{ opacity: 1 }}
                  className="mb-3"
                >
                  <p className="leading-relaxed text-sm text-slate-500 italic">{liveDraft}</p>
                </motion.div>
              )}
            </AnimatePresence>
            <div ref={bottomRef} />
          </>
        )}
      </div>
    </div>
  );
}
