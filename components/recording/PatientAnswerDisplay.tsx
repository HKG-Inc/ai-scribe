import { getPatientAnswerLines, isNoSpeechResponse, NO_SPEECH_DETECTED, PARENT_LANGUAGE } from "@/lib/conversation-mode";

interface PatientAnswerDisplayProps {
  original?: string;
  english?: string;
  /** Patient BCP-47 code; defaults to English-only display when en-US. */
  language?: string | null;
  skipped?: boolean;
  noSpeech?: boolean;
  className?: string;
}

export function PatientAnswerDisplay({
  original,
  english,
  language,
  skipped = false,
  noSpeech = false,
  className = "",
}: PatientAnswerDisplayProps) {
  if (skipped) {
    return <p className={`text-slate-400 text-sm ${className}`.trim()}>Skipped</p>;
  }

  if (
    noSpeech ||
    isNoSpeechResponse(original) ||
    isNoSpeechResponse(english)
  ) {
    return (
      <p className={`text-slate-400 italic text-sm ${className}`.trim()}>
        {NO_SPEECH_DETECTED}
      </p>
    );
  }

  const lines = getPatientAnswerLines(original, english, language ?? PARENT_LANGUAGE);

  if (lines.single) {
    return (
      <div className={`text-base text-slate-700 ${className}`.trim()}>{lines.single}</div>
    );
  }

  if (!lines.original && !lines.english) {
    return null;
  }

  return (
    <div className={`space-y-1 ${className}`.trim()}>
      {lines.original && (
        <div className="text-base text-slate-700" dir="auto">
          {lines.original}
        </div>
      )}
      {lines.english && (
        <div className="text-base text-slate-600 italic" dir="auto">
          {lines.english}
        </div>
      )}
    </div>
  );
}
