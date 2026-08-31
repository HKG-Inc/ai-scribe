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
  createQuestionnaireTimestamp,
  isNoSpeechResponse,
  NO_SPEECH_DETECTED,
  PARENT_LANGUAGE,
  PATIENT_LANGUAGES,
  QUESTIONS,
} from "@/lib/conversation-mode";
import { useQuestionnaireFlow } from "@/hooks/useQuestionnaireFlow";
import { cn } from "@/lib/utils";
import { isEmptyReply } from "@/lib/questionnaire/live-client";

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
    currentQuestionTranslated,
    currentResponseTranslated,
    isRecordingAnswer,
    isAnswerPaused,
    questionnaireStatus,
  } = useAppSelector((s) => s.recording);

  const {
    playQuestion,
    cancelPlay,
    startRecording,
    stopRecordingAndTranscribe,
    startQuestionnaireReplySession,
    stopQuestionnaireReplySession,
    setAnswerRecordingPaused,
  } = useQuestionnaireFlow();
  const [isQuestionnaireStarting, setIsQuestionnaireStarting] = useState(false);
  const [isProcessingAnswer, setIsProcessingAnswer] = useState(false);
  const isBusyRef = useRef(false);

  const hasValidResponse =
    !!currentQuestionResponse && !isNoSpeechResponse(currentQuestionResponse);
  const canAdvanceToNext = hasValidResponse || isNoSpeechResponse(currentQuestionResponse);

  if (isVisitRecording) return null;

  const playCurrentQuestion = async (index: number, language: string) => {
    const question = QUESTIONS[index];
    if (!question) return;

    dispatch(setQuestionnaireStatus("Playing question..."));
    try {
      const { translatedText } = await playQuestion(index, language);
      dispatch(
        setCurrentQuestionTranslated(
          translatedText || (language === PARENT_LANGUAGE ? question.text_en : "")
        )
      );
      dispatch(setQuestionnaireStatus("Ready to record your answer"));
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        dispatch(setQuestionnaireStatus(""));
        return;
      }
      const message =
        error instanceof Error ? error.message : "Failed to play question";
      dispatch(setQuestionnaireStatus(""));
      toast.error(message);
    }
  };

  const saveCurrentToHistory = () => {
    const question = QUESTIONS[currentQuestionIndex];
    if (!question || !selectedLanguage || !currentQuestionResponse) return;

    const isSkipped = currentQuestionResponse === "Skipped";
    const isNoSpeech = isNoSpeechResponse(currentQuestionResponse);
    dispatch(
      addQAHistory({
        question_id: question.id,
        questionEn: question.text_en,
        questionTranslated: currentQuestionTranslated,
        responseEn: currentQuestionResponse,
        responseTranslated:
          isSkipped || isNoSpeech
            ? null
            : {
                english_translation:
                  currentResponseTranslated?.english_translation || currentQuestionResponse,
                original_text:
                  currentResponseTranslated?.original_text || currentQuestionResponse,
              },
        language: selectedLanguage,
        timestamp: createQuestionnaireTimestamp(),
        questionNumber: currentQuestionIndex + 1,
      })
    );
  };

  const advanceOrComplete = async (nextIndex: number, language: string) => {
    if (nextIndex >= QUESTIONS.length) {
      stopQuestionnaireReplySession();
      dispatch(completeQuestionnaire());
      toast.success("Questionnaire completed! You can now record the visit notes.");
      return;
    }

    dispatch(nextQuestion());
    await playCurrentQuestion(nextIndex, language);
  };

  const handleStartQuestionnaire = async () => {
    if (!selectedLanguage) {
      toast.error("Please select a language first");
      return;
    }
    if (isQuestionnaireStarting || isBusyRef.current) return;

    isBusyRef.current = true;
    setIsQuestionnaireStarting(true);
    try {
      await startQuestionnaireReplySession();
      dispatch(startQuestionnaire());
      await playCurrentQuestion(0, selectedLanguage);
    } catch (error) {
      stopQuestionnaireReplySession();
      const message =
        error instanceof Error ? error.message : "Failed to start questionnaire";
      toast.error(message);
    } finally {
      setIsQuestionnaireStarting(false);
      isBusyRef.current = false;
    }
  };

  const handleNextQuestion = async () => {
    if (!canAdvanceToNext || !selectedLanguage || isBusyRef.current) return;

    saveCurrentToHistory();

    const nextIndex = currentQuestionIndex + 1;
    isBusyRef.current = true;
    try {
      await advanceOrComplete(nextIndex, selectedLanguage);
    } finally {
      isBusyRef.current = false;
    }
  };

  const handleSkip = async () => {
    if (!selectedLanguage || isBusyRef.current) return;

    cancelPlay();
    dispatch(setRecordingAnswer(false));
    dispatch(setAnswerPaused(false));

    const question = QUESTIONS[currentQuestionIndex];
    if (question) {
      dispatch(
        addQAHistory({
          question_id: question.id,
          questionEn: question.text_en,
          questionTranslated: currentQuestionTranslated,
          responseEn: "Skipped",
          responseTranslated: null,
          language: selectedLanguage,
          timestamp: createQuestionnaireTimestamp(),
          questionNumber: currentQuestionIndex + 1,
        })
      );
    }

    const nextIndex = currentQuestionIndex + 1;
    isBusyRef.current = true;
    try {
      if (nextIndex >= QUESTIONS.length) {
        stopQuestionnaireReplySession();
        dispatch(completeQuestionnaire());
        toast.success("Questionnaire completed! You can now record the visit notes.");
        return;
      }
      dispatch(nextQuestion());
      await playCurrentQuestion(nextIndex, selectedLanguage);
    } finally {
      isBusyRef.current = false;
    }
  };

  const handleReplay = () => {
    if (isRecordingAnswer || !selectedLanguage) return;
    void playCurrentQuestion(currentQuestionIndex, selectedLanguage);
  };

  const handleRecordAnswer = async () => {
    if (isRecordingAnswer) {
      if (isProcessingAnswer) return;
      setIsProcessingAnswer(true);
      dispatch(setQuestionnaireStatus("Processing your response..."));
      dispatch(setRecordingAnswer(false));
      dispatch(setAnswerPaused(false));

      try {
        const structured = await stopRecordingAndTranscribe();
        const english = structured?.english?.trim() || "";
        const original = structured?.original?.trim() || english;

        if (!english || isEmptyReply(structured)) {
          dispatch(setCurrentQuestionResponse(NO_SPEECH_DETECTED));
          dispatch(setCurrentResponseTranslated(null));
          dispatch(setQuestionnaireStatus("Ready to record your answer"));
        } else {
          dispatch(setCurrentQuestionResponse(english));
          dispatch(
            setCurrentResponseTranslated({
              english_translation: english,
              original_text: original || english,
            })
          );
          dispatch(setQuestionnaireStatus(""));
        }
      } catch (error) {
        dispatch(setCurrentQuestionResponse(NO_SPEECH_DETECTED));
        dispatch(setCurrentResponseTranslated(null));
        const message =
          error instanceof Error ? error.message : "Failed to process answer";
        toast.error(message);
        dispatch(setQuestionnaireStatus("Ready to record your answer"));
      } finally {
        setIsProcessingAnswer(false);
      }
      return;
    }

    if (hasValidResponse) return;

    try {
      dispatch(setCurrentQuestionResponse(""));
      dispatch(setCurrentResponseTranslated(null));
      dispatch(setRecordingAnswer(true));
      dispatch(setAnswerPaused(false));
      dispatch(setQuestionnaireStatus("Recording your answer..."));
      await startRecording();
    } catch (error) {
      dispatch(setRecordingAnswer(false));
      dispatch(setQuestionnaireStatus(""));
      toast.error(
        error instanceof Error ? error.message : "Could not access microphone"
      );
    }
  };

  const handlePauseResumeAnswer = () => {
    if (!isRecordingAnswer) return;
    const paused = !isAnswerPaused;
    dispatch(setAnswerPaused(paused));
    setAnswerRecordingPaused(paused);
    dispatch(
      setQuestionnaireStatus(
        paused ? "Answer recording paused" : "Recording your answer..."
      )
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
        {!questionnaireCompleted && questionnaireStarted && !isRecordingAnswer && !isAnswerPaused && (
            <button
              className="p-2 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg text-sm"
              onClick={() => void handleSkip()}
              disabled={isQuestionnaireStarting}
            >
              Skip
            </button>
          )}

        {!questionnaireCompleted && (
          <button
            onClick={() =>
              void (questionnaireStarted && canAdvanceToNext
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
              (questionnaireStarted && !canAdvanceToNext)
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
            disabled={isRecordingAnswer || isProcessingAnswer}
          >
            <Repeat1 className="h-4 w-4" /> Question
          </button>
        )}
      </div>

      {(questionnaireStarted || questionnaireCompleted) && (
        <div className="flex space-x-4 items-center">
          {questionnaireStarted && isRecordingAnswer && !isProcessingAnswer && (
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
                "px-4 rounded-lg h-12 text-base font-medium shadow-sm flex items-center gap-2 min-w-[160px] justify-center",
                isProcessingAnswer
                  ? "bg-sky-400 text-white cursor-wait"
                  : isRecordingAnswer
                    ? "bg-red-500 hover:bg-red-600 text-white"
                    : hasValidResponse
                      ? "bg-slate-200 text-slate-400"
                      : "bg-brand-green hover:bg-opacity-90 text-white"
              )}
              disabled={isProcessingAnswer || (hasValidResponse && !isRecordingAnswer)}
            >
              {isProcessingAnswer ? (
                <>
                  Processing...
                  <Loader2 className="h-4 w-4 animate-spin" />
                </>
              ) : isRecordingAnswer ? (
                "Stop Recording"
              ) : (
                "Record Answer"
              )}
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
