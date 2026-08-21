"use client";

import { useRef, useState } from "react";
import { Languages, Loader2, Repeat1 } from "lucide-react";
import { toast } from "sonner";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAppDispatch, useAppSelector } from "@/store/hooks";
import {
  addQAHistory,
  completeQuestionnaire,
  nextQuestion,
  setAnswerPaused,
  setCurrentQuestionResponse,
  setCurrentQuestionTranslated,
  setCurrentResponseTranslated,
  setQuestionnaireStatus,
  setRecordingAnswer,
  setSelectedLanguage,
  startQuestionnaire,
} from "@/store/slices/recordingSlice";
import {
  PARENT_LANGUAGE,
  PATIENT_LANGUAGES,
  QUESTIONS,
  languageLabel,
  recognizeAnswer,
  speakQuestion,
  stopSpeaking,
} from "@/lib/conversation-mode";
import { cn } from "@/lib/utils";

interface ConversationalControlsProps {
  isVisitRecording: boolean;
  onStartVisitNotes: () => void;
  isStartingVisitNotes?: boolean;
}

export function ConversationalControls({
  isVisitRecording,
  onStartVisitNotes,
  isStartingVisitNotes = false,
}: ConversationalControlsProps) {
  const dispatch = useAppDispatch();
  const {
    selectedLanguage,
    questionnaireStarted,
    questionnaireCompleted,
    conversationalModeStarted,
    currentQuestionIndex,
    currentQuestionResponse,
    isRecordingAnswer,
    isAnswerPaused,
    questionnaireStatus,
  } = useAppSelector((s) => s.recording);

  const recognitionStopRef = useRef<(() => void) | null>(null);
  const recognitionPromiseRef = useRef<Promise<{
    transcript: string;
    usedFallback: boolean;
  }> | null>(null);
  const [isQuestionnaireStarting, setIsQuestionnaireStarting] = useState(false);

  if (isVisitRecording) return null;

  const playCurrentQuestion = async (index: number, language: string) => {
    const question = QUESTIONS[index];
    if (!question) return;

    dispatch(setQuestionnaireStatus("Playing question..."));
    // Without ambient TTS/translation API, spoken text stays English; label notes patient language.
    const translatedNote =
      language && language !== PARENT_LANGUAGE
        ? `[Spoken for patient language: ${languageLabel(language)}]`
        : "";
    dispatch(setCurrentQuestionTranslated(translatedNote));
    await speakQuestion(question.text_en, language);
    dispatch(setQuestionnaireStatus("Ready to record your answer"));
  };

  const handleStartQuestionnaire = async () => {
    if (!selectedLanguage) {
      toast.error("Please select a language first");
      return;
    }
    if (isQuestionnaireStarting) return;
    setIsQuestionnaireStarting(true);
    try {
      dispatch(startQuestionnaire());
      await playCurrentQuestion(0, selectedLanguage);
    } finally {
      setIsQuestionnaireStarting(false);
    }
  };

  const saveCurrentAndAdvance = () => {
    const question = QUESTIONS[currentQuestionIndex];
    if (!question) return;

    dispatch(
      addQAHistory({
        questionEn: question.text_en,
        questionTranslated:
          selectedLanguage !== PARENT_LANGUAGE
            ? `[Patient language: ${languageLabel(selectedLanguage)}]`
            : "",
        responseEn: currentQuestionResponse,
        responseTranslated: currentQuestionResponse
          ? {
              english_translation: currentQuestionResponse,
              original_text: currentQuestionResponse,
            }
          : null,
      })
    );

    const nextIndex = currentQuestionIndex + 1;
    if (nextIndex >= QUESTIONS.length) {
      dispatch(completeQuestionnaire());
      toast.success("Questionnaire completed! You can now record the visit notes.");
      return;
    }

    dispatch(nextQuestion());
    void playCurrentQuestion(nextIndex, selectedLanguage);
  };

  const handleNextQuestion = () => {
    if (!currentQuestionResponse) return;
    saveCurrentAndAdvance();
  };

  const handleSkip = () => {
    stopSpeaking();
    recognitionStopRef.current?.();
    recognitionStopRef.current = null;
    dispatch(setRecordingAnswer(false));
    dispatch(setAnswerPaused(false));

    const question = QUESTIONS[currentQuestionIndex];
    if (question) {
      dispatch(
        addQAHistory({
          questionEn: question.text_en,
          questionTranslated:
            selectedLanguage !== PARENT_LANGUAGE
              ? `[Patient language: ${languageLabel(selectedLanguage)}]`
              : "",
          responseEn: "",
          responseTranslated: null,
        })
      );
    }

    const nextIndex = currentQuestionIndex + 1;
    if (nextIndex >= QUESTIONS.length) {
      dispatch(completeQuestionnaire());
      toast.success("Questionnaire completed! You can now record the visit notes.");
      return;
    }

    dispatch(nextQuestion());
    void playCurrentQuestion(nextIndex, selectedLanguage);
  };

  const handleReplay = () => {
    if (isRecordingAnswer) return;
    void playCurrentQuestion(currentQuestionIndex, selectedLanguage);
  };

  const handleRecordAnswer = async () => {
    if (isRecordingAnswer) {
      dispatch(setQuestionnaireStatus("Processing your response..."));
      recognitionStopRef.current?.();
      const outcome = await recognitionPromiseRef.current;
      recognitionStopRef.current = null;
      recognitionPromiseRef.current = null;
      dispatch(setRecordingAnswer(false));
      dispatch(setAnswerPaused(false));

      const transcript = outcome?.transcript?.trim() || "(No speech detected)";
      dispatch(setCurrentQuestionResponse(transcript));
      dispatch(
        setCurrentResponseTranslated({
          english_translation: transcript,
          original_text: transcript,
        })
      );
      dispatch(setQuestionnaireStatus(""));
      if (outcome?.usedFallback) {
        toast.message("Using browser speech recognition fallback");
      }
      return;
    }

    if (currentQuestionResponse) return;

    stopSpeaking();
    dispatch(setRecordingAnswer(true));
    dispatch(setAnswerPaused(false));
    dispatch(setQuestionnaireStatus("Recording your answer..."));

    const session = recognizeAnswer(selectedLanguage || PARENT_LANGUAGE);
    recognitionStopRef.current = session.stop;
    recognitionPromiseRef.current = session.result;
  };

  const handlePauseResumeAnswer = () => {
    if (!isRecordingAnswer) return;
    // Web Speech API has limited pause support; toggle UI state only.
    dispatch(setAnswerPaused(!isAnswerPaused));
    dispatch(
      setQuestionnaireStatus(isAnswerPaused ? "Recording your answer..." : "Answer recording paused")
    );
  };

  return (
    <div className="w-full max-w-md space-y-4 flex flex-col items-center mt-2">
      <div
        className={cn(
          "bg-white rounded-xl p-4 border border-slate-200 w-full",
          questionnaireCompleted && "opacity-50"
        )}
      >
        <div className="flex items-center gap-2 mb-3">
          <Languages className="h-4 w-4 text-brand-green" />
          <label className="text-base font-semibold text-brand-green">
            Select Patient Language
          </label>
        </div>
        <Select
          value={selectedLanguage || undefined}
          onValueChange={(value) => dispatch(setSelectedLanguage(value))}
          disabled={
            questionnaireStarted || questionnaireCompleted || conversationalModeStarted
          }
        >
          <SelectTrigger className="w-full h-12 rounded-lg">
            <SelectValue placeholder="Select a language" />
          </SelectTrigger>
          <SelectContent>
            {PATIENT_LANGUAGES.map((lang) => (
              <SelectItem key={lang.value} value={lang.value}>
                {lang.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex items-center gap-4 flex-wrap justify-center">
        {!questionnaireCompleted &&
          questionnaireStarted &&
          !isRecordingAnswer &&
          !isAnswerPaused && (
            <button
              className="p-2 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg text-sm"
              onClick={handleSkip}
            >
              Skip
            </button>
          )}

        {!questionnaireCompleted && (
          <button
            onClick={() =>
              void (questionnaireStarted && currentQuestionResponse
                ? handleNextQuestion()
                : handleStartQuestionnaire())
            }
            className={cn(
              "px-4 rounded-lg h-12 text-base font-medium shadow-sm transition-all flex items-center gap-2",
              selectedLanguage && !questionnaireCompleted
                ? "bg-sky-400 hover:bg-sky-500 text-white"
                : "bg-slate-200 text-slate-400 cursor-not-allowed"
            )}
            disabled={
              !selectedLanguage ||
              isRecordingAnswer ||
              isAnswerPaused ||
              isQuestionnaireStarting ||
              questionnaireCompleted ||
              (questionnaireStarted && !currentQuestionResponse)
            }
          >
            {questionnaireStarted
              ? `Next Question (${currentQuestionIndex + 1}/${QUESTIONS.length})`
              : "Questionnaire"}
            {isQuestionnaireStarting && <Loader2 className="h-4 w-4 animate-spin" />}
          </button>
        )}

        {questionnaireStarted && (
          <button
            onClick={handleReplay}
            className="px-2 hover:bg-purple-500 text-blue-500 hover:text-white bg-transparent rounded-lg h-8 text-xs font-medium flex items-center gap-1"
            disabled={isRecordingAnswer}
          >
            <Repeat1 className="h-4 w-4" /> Question
          </button>
        )}
      </div>

      {(questionnaireStarted || questionnaireCompleted) && (
        <div className="flex space-x-4 items-center">
          {questionnaireStarted && isRecordingAnswer && (
            <button
              onClick={handlePauseResumeAnswer}
              className="px-4 bg-orange-400 hover:bg-orange-500 text-white rounded-lg h-12 text-base font-medium shadow-sm"
            >
              {isAnswerPaused ? "Resume" : "Pause"}
            </button>
          )}

          {questionnaireStarted ? (
            <button
              onClick={() => void handleRecordAnswer()}
              className={cn(
                "px-4 rounded-lg h-12 text-base font-medium shadow-sm",
                isRecordingAnswer
                  ? "bg-red-500 hover:bg-red-600 text-white"
                  : currentQuestionResponse
                    ? "bg-slate-200 text-slate-400"
                    : "bg-brand-green hover:bg-opacity-90 text-white"
              )}
              disabled={!!currentQuestionResponse && !isRecordingAnswer}
            >
              {isRecordingAnswer ? "Stop Recording" : "Record Answer"}
            </button>
          ) : questionnaireCompleted ? (
            <button
              onClick={onStartVisitNotes}
              className="px-6 bg-brand-green hover:bg-opacity-90 text-white rounded-lg h-12 text-base font-medium shadow-lg flex items-center gap-2"
              disabled={isStartingVisitNotes}
            >
              ✓ Record Visit Notes
              {isStartingVisitNotes && <Loader2 className="h-4 w-4 animate-spin" />}
            </button>
          ) : null}
        </div>
      )}

      {questionnaireStatus && !questionnaireCompleted && (
        <p className="text-xs text-slate-500 italic text-center">{questionnaireStatus}</p>
      )}
    </div>
  );
}
