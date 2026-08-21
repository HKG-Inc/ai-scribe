/**
 * Conversational questionnaire constants and local (frontend-only) helpers.
 * In ai-scribe-web these talk to ambient socket events; here voice uses the browser
 * Speech Synthesis / Speech Recognition APIs — no backend questionnaire APIs.
 */

export const PARENT_LANGUAGE = "en-US";

export interface Question {
  id: string;
  text_en: string;
  category: string;
}

export interface QuestionnaireHistoryItem {
  questionEn: string;
  questionTranslated: string;
  responseEn: string;
  responseTranslated: {
    english_translation: string;
    original_text: string;
  } | null;
  questionNumber: number;
}

export const PATIENT_LANGUAGES = [
  { value: "ar-XA", label: "Arabic / العربية" },
  { value: "en-US", label: "English" },
  { value: "hi-IN", label: "Hindi / हिन्दी" },
  { value: "ml-IN", label: "Malayalam / മലയാളം" },
  { value: "es-ES", label: "Spanish / Español" },
  { value: "ta-IN", label: "Tamil / தமிழ்" },
  { value: "uk-UA", label: "Ukrainian / Українська" },
] as const;

export const QUESTIONS: Question[] = [
  { id: "q1", text_en: "What brings you in today?", category: "chief_complaint" },
  {
    id: "q2",
    text_en: "Were you the driver of a car or the passenger?",
    category: "accident_details",
  },
  {
    id: "q3",
    text_en:
      "When your car struck the other vehicle, were you T-boned on the side of your car? Was it a head-on collision or were you rear-ended?",
    category: "accident_details",
  },
  { id: "q4", text_en: "Were you seat belted at the time?", category: "accident_details" },
  {
    id: "q5",
    text_en: "Were the airbags deployed? Did the airbags deploy during the accident?",
    category: "accident_details",
  },
  {
    id: "q6",
    text_en: "Did your head hit anywhere in the accident?",
    category: "injury_assessment",
  },
  {
    id: "q7",
    text_en: "Did you completely pass out? In other words, did you lose consciousness?",
    category: "injury_assessment",
  },
  { id: "q8", text_en: "Did you have any low back pain?", category: "pain_assessment" },
  {
    id: "q9",
    text_en: "On a scale of 0 to 10, how would you rate your low back pain?",
    category: "pain_assessment",
  },
  {
    id: "q10",
    text_en: "Does the low back pain remain localized to your lower back?",
    category: "pain_characteristics",
  },
  {
    id: "q11",
    text_en: "Does it radiate down both legs or just one leg?",
    category: "pain_characteristics",
  },
  {
    id: "q12",
    text_en: "Is the pain constantly present, or does it occur intermittently?",
    category: "pain_characteristics",
  },
  {
    id: "q13",
    text_en:
      "Is there something that you're doing when the pain comes on? Like anything particular?",
    category: "pain_triggers",
  },
  {
    id: "q14",
    text_en:
      "Now tell me, what are the things that you do with your body in terms of that makes the lower back pain worse? For example, that's bending, extending, rotating the body, or flexing to the side (lateral flexion). Do any of those make your low back pain worse?",
    category: "pain_aggravating_factors",
  },
  {
    id: "q15",
    text_en: "What makes your pain better? What alleviates your pain?",
    category: "pain_relieving_factors",
  },
  {
    id: "q16",
    text_en:
      "Have you had any treatment for this pain? Like for example, have you had any surgeries?",
    category: "treatment_history",
  },
  { id: "q17", text_en: "What about physical therapy?", category: "treatment_history" },
  { id: "q18", text_en: "What about any injections?", category: "treatment_history" },
  {
    id: "q19",
    text_en:
      "Have you had any durable medical equipment given to you? Any back braces or anything of that sort?",
    category: "treatment_history",
  },
  {
    id: "q20",
    text_en:
      "Did any of the previous physicians who treated you, did any of them place you on any restrictions or limitations?",
    category: "treatment_history",
  },
  {
    id: "q21",
    text_en:
      "I want to talk to you about associated signs and symptoms. Is your sleep disturbed following this accident?",
    category: "associated_symptoms",
  },
  {
    id: "q22",
    text_en:
      "Is there any change in your mood? Like, are you irritable, depressed, or any kind of mood change?",
    category: "associated_symptoms",
  },
  {
    id: "q23",
    text_en: "And what about your bladder, I mean your bowel. Is that regular or irregular?",
    category: "associated_symptoms",
  },
  {
    id: "q24",
    text_en: "And finally, have you had any previous injury like this in the past?",
    category: "medical_history",
  },
  {
    id: "q25",
    text_en:
      "Were you ever treated at a hospital for this accident, were you ever treated at a previous facility like a hospital or an urgent care or a primary care physician's facility?",
    category: "medical_history",
  },
];

export function languageLabel(code: string): string {
  return PATIENT_LANGUAGES.find((l) => l.value === code)?.label ?? code;
}

/** Speak question text locally (replaces ambient TTS / prerecorded audio). */
export function speakQuestion(text: string, language: string): Promise<void> {
  return new Promise((resolve) => {
    if (typeof window === "undefined" || !window.speechSynthesis) {
      resolve();
      return;
    }

    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = language || PARENT_LANGUAGE;
    utterance.rate = 0.95;

    const voices = window.speechSynthesis.getVoices();
    const match =
      voices.find((v) => v.lang === language) ||
      voices.find((v) => v.lang.startsWith(language.split("-")[0] || ""));
    if (match) {
      utterance.voice = match;
    }

    utterance.onend = () => resolve();
    utterance.onerror = () => resolve();
    window.speechSynthesis.speak(utterance);
  });
}

export function stopSpeaking() {
  if (typeof window !== "undefined" && window.speechSynthesis) {
    window.speechSynthesis.cancel();
  }
}

/* Browser SpeechRecognition is not always in lib.dom — keep a minimal shape. */
interface BrowserSpeechRecognition extends EventTarget {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  maxAlternatives: number;
  start: () => void;
  stop: () => void;
  onresult: ((event: BrowserSpeechRecognitionEvent) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
}

interface BrowserSpeechRecognitionEvent {
  resultIndex: number;
  results: ArrayLike<{ isFinal: boolean; 0?: { transcript: string } }>;
}

type SpeechRecognitionConstructor = new () => BrowserSpeechRecognition;

function getSpeechRecognition(): SpeechRecognitionConstructor | null {
  if (typeof window === "undefined") return null;
  const w = window as Window & {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  };
  return w.SpeechRecognition || w.webkitSpeechRecognition || null;
}

/**
 * Record a short spoken answer via Web Speech API (replaces ambient STT).
 * Falls back to a placeholder if the browser has no speech recognition.
 */
export function recognizeAnswer(language: string): {
  stop: () => void;
  result: Promise<{ transcript: string; usedFallback: boolean }>;
} {
  const Recognition = getSpeechRecognition();
  let recognition: BrowserSpeechRecognition | null = null;
  let settled = false;
  let resolveFn: ((value: { transcript: string; usedFallback: boolean }) => void) | null = null;

  const result = new Promise<{ transcript: string; usedFallback: boolean }>((resolve) => {
    resolveFn = resolve;
  });

  const finish = (transcript: string, usedFallback: boolean) => {
    if (settled) return;
    settled = true;
    resolveFn?.({ transcript, usedFallback });
  };

  if (!Recognition) {
    return {
      stop: () =>
        finish(
          "(Speech recognition unavailable in this browser — answer recorded locally.)",
          true
        ),
      result,
    };
  }

  recognition = new Recognition();
  recognition.lang = language || PARENT_LANGUAGE;
  recognition.interimResults = true;
  recognition.continuous = true;
  recognition.maxAlternatives = 1;

  let finalTranscript = "";
  let interimTranscript = "";

  recognition.onresult = (event: BrowserSpeechRecognitionEvent) => {
    interimTranscript = "";
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const piece = event.results[i]?.[0]?.transcript ?? "";
      if (event.results[i]?.isFinal) {
        finalTranscript += `${piece} `;
      } else {
        interimTranscript += piece;
      }
    }
  };

  recognition.onerror = () => {
    const text = (finalTranscript || interimTranscript).trim();
    finish(text || "(No speech detected)", !text);
  };

  recognition.onend = () => {
    const text = (finalTranscript || interimTranscript).trim();
    finish(text || "(No speech detected)", !text);
  };

  try {
    recognition.start();
  } catch {
    finish("(Could not start speech recognition)", true);
  }

  return {
    stop: () => {
      try {
        recognition?.stop();
      } catch {
        const text = (finalTranscript || interimTranscript).trim();
        finish(text || "(No speech detected)", !text);
      }
    },
    result,
  };
}
