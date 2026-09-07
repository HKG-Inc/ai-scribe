"use client";

import { useEffect, useRef, useState } from "react";
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
    stopQuestionnaireReplySession,
    setAnswerRecordingPaused,
    isPlayConnecting,
  } = useQuestionnaireFlow();
  const [isQuestionnaireStarting, setIsQuestionnaireStarting] = useState(false);
  const [isBufferingAnswer, setIsBufferingAnswer] = useState(false);
  const [isAwaitingPlay, setIsAwaitingPlay] = useState(false);
  const [isStartingRecord, setIsStartingRecord] = useState(false);
  /** Only one button shows a spinner — the action that triggered work. */
  const [loadingAction, setLoadingAction] = useState<
    "start" | "next" | "replay" | "record" | null
  >(null);
  const isBusyRef = useRef(false);
  /** Tracks index for rapid Skip before Redux re-renders. */
  const questionIndexRef = useRef(currentQuestionIndex);
  questionIndexRef.current = currentQuestionIndex;
  /** Bumped on Skip so a superseded play does not update UI after advance. */
  const playGenerationRef = useRef(0);
  /** Coalesce rapid Skip so we only mint/play the latest question. */
  const skipPlayTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (skipPlayTimerRef.current) {
        clearTimeout(skipPlayTimerRef.current);
      }
    };
  }, []);

  // Drop the action spinner once that action's connect/debounce work is done.
  useEffect(() => {
    if (!loadingAction || loadingAction === "record") return;
    if (isAwaitingPlay || isPlayConnecting) return;
    setLoadingAction(null);
  }, [isPlayConnecting, isAwaitingPlay, loadingAction]);

  const hasValidResponse =
    !!currentQuestionResponse && !isNoSpeechResponse(currentQuestionResponse);
  const canAdvanceToNext = hasValidResponse || isNoSpeechResponse(currentQuestionResponse);
  const isPlayBusy =
    isPlayConnecting || isAwaitingPlay || isQuestionnaireStarting;
  const isRecordBusy = isStartingRecord || isBufferingAnswer;

  const primaryActionDisabled =
    !selectedLanguage ||
    isRecordingAnswer ||
    isAnswerPaused ||
    isRecordBusy ||
    isPlayBusy ||
    questionnaireCompleted ||
    (questionnaireStarted && !canAdvanceToNext);

  const replayDisabled = isRecordingAnswer || isRecordBusy || isPlayBusy;
  const recordDisabled = isRecordingAnswer
    ? isBufferingAnswer
    : isRecordBusy || hasValidResponse || isPlayBusy;

  if (isVisitRecording) return null;

  const playCurrentQuestion = async (index: number, language: string) => {
    const question = QUESTIONS[index];
    if (!question) return;

    const generation = playGenerationRef.current;
    setIsAwaitingPlay(false);
    dispatch(setCurrentQuestionTranslated(""));
    dispatch(setQuestionnaireStatus("Playing question..."));
    try {
      const { translatedText } = await playQuestion(index, language, {
        onTranslatedText: (text) => {
          if (generation !== playGenerationRef.current) return;
          dispatch(setCurrentQuestionTranslated(text));
        },
      });
      if (generation !== playGenerationRef.current) return;
      dispatch(
        setCurrentQuestionTranslated(
          translatedText || (language === PARENT_LANGUAGE ? question.text_en : "")
        )
      );
      dispatch(setQuestionnaireStatus("Ready to record your answer"));
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        if (generation === playGenerationRef.current) {
          dispatch(setQuestionnaireStatus(""));
        }
        return;
      }
      if (generation !== playGenerationRef.current) return;
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
    // Close previous question's reply WS before opening the next one.
    stopQuestionnaireReplySession();

    if (nextIndex >= QUESTIONS.length) {
      // Completing hides the in-progress panel (questionnaireStarted=false).
      // Current answer must already be in qaHistory via saveCurrentToHistory().
      dispatch(completeQuestionnaire());
      dispatch(setCurrentQuestionResponse(""));
      dispatch(setCurrentQuestionTranslated(""));
      dispatch(setCurrentResponseTranslated(null));
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
    setLoadingAction("start");
    setIsAwaitingPlay(true);
    setIsQuestionnaireStarting(true);
    try {
      dispatch(startQuestionnaire());
      await playCurrentQuestion(0, selectedLanguage);
    } catch (error) {
      stopQuestionnaireReplySession();
      const message =
        error instanceof Error ? error.message : "Failed to start questionnaire";
      toast.error(message);
    } finally {
      setIsQuestionnaireStarting(false);
      setIsAwaitingPlay(false);
      isBusyRef.current = false;
    }
  };

  const handleNextQuestion = async () => {
    if (!canAdvanceToNext || !selectedLanguage || isBusyRef.current) return;

    saveCurrentToHistory();

    const nextIndex = currentQuestionIndex + 1;
    isBusyRef.current = true;
    setLoadingAction("next");
    setIsAwaitingPlay(true);
    try {
      await advanceOrComplete(nextIndex, selectedLanguage);
    } finally {
      setIsAwaitingPlay(false);
      isBusyRef.current = false;
    }
  };

  const handleSkip = async () => {
    if (!selectedLanguage || isBusyRef.current || isBufferingAnswer) return;

    isBusyRef.current = true;
    playGenerationRef.current += 1;
    const language = selectedLanguage;
    let nextIndex = -1;

    try {
      setIsAwaitingPlay(true);
      // Instant silence + drop play WS; stop reply warm / in-flight reply connect.
      await cancelPlay({ settle: false });
      dispatch(setRecordingAnswer(false));
      dispatch(setAnswerPaused(false));

      const index = questionIndexRef.current;
      const question = QUESTIONS[index];
      if (question) {
        dispatch(
          addQAHistory({
            question_id: question.id,
            questionEn: question.text_en,
            // Avoid attaching a prior question's translation on rapid Skip before re-render.
            questionTranslated:
              index === currentQuestionIndex ? currentQuestionTranslated : "",
            responseEn: "Skipped",
            responseTranslated: null,
            language,
            timestamp: createQuestionnaireTimestamp(),
            questionNumber: index + 1,
          })
        );
      }

      nextIndex = index + 1;
      questionIndexRef.current = nextIndex;
      stopQuestionnaireReplySession();
      if (nextIndex >= QUESTIONS.length) {
        if (skipPlayTimerRef.current) {
          clearTimeout(skipPlayTimerRef.current);
          skipPlayTimerRef.current = null;
        }
        setIsAwaitingPlay(false);
        setLoadingAction(null);
        dispatch(completeQuestionnaire());
        dispatch(setCurrentQuestionResponse(""));
        dispatch(setCurrentQuestionTranslated(""));
        dispatch(setCurrentResponseTranslated(null));
        toast.success("Questionnaire completed! You can now record the visit notes.");
        return;
      }
      dispatch(nextQuestion());
      // Clear immediately so prior Q translation cannot flash on the next card.
      dispatch(setCurrentQuestionTranslated(""));
    } finally {
      // Release before next-question audio so Skip stays clickable mid-playback.
      isBusyRef.current = false;
    }

    // Debounce play: rapid Skip only mints/plays the latest index (stream cap).
    if (skipPlayTimerRef.current) {
      clearTimeout(skipPlayTimerRef.current);
    }
    const playIndex = nextIndex;
    const playGeneration = playGenerationRef.current;
    setIsAwaitingPlay(true);
    skipPlayTimerRef.current = setTimeout(() => {
      skipPlayTimerRef.current = null;
      if (playGeneration !== playGenerationRef.current) {
        setIsAwaitingPlay(false);
        return;
      }
      if (playIndex !== questionIndexRef.current) {
        setIsAwaitingPlay(false);
        return;
      }
      void playCurrentQuestion(playIndex, language);
    }, 250);
  };

  const handleReplay = () => {
    if (isRecordingAnswer || !selectedLanguage) return;
    setLoadingAction("replay");
    setIsAwaitingPlay(true);
    void playCurrentQuestion(currentQuestionIndex, selectedLanguage);
  };

  const handleRecordAnswer = async () => {
    if (isRecordingAnswer) {
      if (isBufferingAnswer) return;
      setIsBufferingAnswer(true);
      dispatch(setRecordingAnswer(false));
      dispatch(setAnswerPaused(false));
      dispatch(setQuestionnaireStatus("Buffering..."));

      try {
        if (!selectedLanguage) {
          throw new Error("Please select a language first");
        }
        const structured = await stopRecordingAndTranscribe(
          currentQuestionIndex,
          selectedLanguage
        );
        const english = structured?.english?.trim() || "";
        const original = structured?.original?.trim() || english;

        if (!english || isEmptyReply(structured)) {
          // Keep the same reply session so a retry can reuse it.
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
        const message =
          error instanceof Error ? error.message : "Failed to process answer";
        dispatch(setCurrentQuestionResponse(""));
        dispatch(setCurrentResponseTranslated(null));
        toast.error(message);
        dispatch(setQuestionnaireStatus("Ready to record your answer"));
      } finally {
        setIsBufferingAnswer(false);
      }
      return;
    }

    if (hasValidResponse) return;

    try {
      setLoadingAction("record");
      setIsStartingRecord(true);
      dispatch(setCurrentQuestionResponse(""));
      dispatch(setCurrentResponseTranslated(null));
      dispatch(setQuestionnaireStatus("Connecting..."));
      await startRecording(currentQuestionIndex);
      dispatch(setRecordingAnswer(true));
      dispatch(setAnswerPaused(false));
      dispatch(setQuestionnaireStatus("Recording your answer..."));
    } catch (error) {
      dispatch(setRecordingAnswer(false));
      dispatch(setQuestionnaireStatus(""));
      toast.error(
        error instanceof Error ? error.message : "Could not access microphone"
      );
    } finally {
      setIsStartingRecord(false);
      setLoadingAction(null);
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
          value={selectedLanguage ?? ""}
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
              className="p-2 rounded-lg text-sm text-slate-400 hover:text-slate-600 hover:bg-slate-100"
              onClick={() => void handleSkip()}
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
              primaryActionDisabled
                ? "bg-slate-200 text-slate-400 cursor-not-allowed"
                : "bg-sky-400 hover:bg-sky-500 text-white"
            )}
            disabled={primaryActionDisabled}
          >
            {questionnaireStarted
              ? `Next Question (${currentQuestionIndex + 1}/${QUESTIONS.length})`
              : "Questionnaire"}
            {(loadingAction === "start" || loadingAction === "next") &&
              (isAwaitingPlay || isPlayConnecting) && (
                <Loader2 className="h-4 w-4 animate-spin" />
              )}
          </button>
        )}

        {questionnaireStarted && (
          <button
            onClick={handleReplay}
            className={cn(
              "px-2 rounded-lg h-8 text-xs font-medium flex items-center gap-1",
              replayDisabled
                ? "text-slate-300 cursor-not-allowed bg-transparent"
                : "hover:bg-purple-500 text-blue-500 hover:text-white bg-transparent"
            )}
            disabled={replayDisabled}
          >
            <Repeat1 className="h-4 w-4" /> Question
            {loadingAction === "replay" &&
              (isAwaitingPlay || isPlayConnecting) && (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              )}
          </button>
        )}
      </div>

      {(questionnaireStarted || questionnaireCompleted) && (
        <div className="flex space-x-4 items-center">
          {questionnaireStarted &&
            isRecordingAnswer &&
            !isBufferingAnswer &&
            !isStartingRecord && (
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
                recordDisabled && !isRecordingAnswer
                  ? "bg-slate-200 text-slate-400 cursor-not-allowed"
                  : isBufferingAnswer || isStartingRecord
                    ? "bg-sky-400 text-white cursor-wait"
                    : isRecordingAnswer
                      ? "bg-red-500 hover:bg-red-600 text-white"
                      : "bg-brand-green hover:bg-opacity-90 text-white"
              )}
              disabled={recordDisabled}
            >
              {isBufferingAnswer ? (
                <>
                  Buffering...
                  <Loader2 className="h-4 w-4 animate-spin" />
                </>
              ) : isStartingRecord ? (
                <>
                  Connecting...
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
              className={cn(
                "px-6 rounded-lg h-12 text-base font-medium shadow-lg flex items-center gap-2",
                isStartingVisitNotes
                  ? "bg-slate-200 text-slate-400 cursor-not-allowed"
                  : "bg-brand-green hover:bg-opacity-90 text-white"
              )}
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
