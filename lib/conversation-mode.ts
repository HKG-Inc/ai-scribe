/**
 * Conversational questionnaire constants.
 * Play/record use GCS canned assets or Hikigai questionnaire agents (see hooks/useQuestionnaireFlow).
 */

export const PARENT_LANGUAGE = "en-US";

export interface Question {
  id: string;
  text_en: string;
  category: string;
}

export interface QuestionnaireHistoryItem {
  question_id: string;
  questionEn: string;
  questionTranslated: string;
  responseEn: string;
  responseTranslated: {
    english_translation: string;
    original_text: string;
  } | null;
  language: string;
  timestamp: string;
  questionNumber: number;
}

export const PATIENT_LANGUAGES = [
  { value: "ar-XA", label: "Arabic / العربية" },
  { value: "bn-IN", label: "Bengali / বাংলা" },
  { value: "de-DE", label: "German / Deutsch" },
  { value: "en-US", label: "English" },
  { value: "es-ES", label: "Spanish / Español" },
  { value: "fr-FR", label: "French / Français" },
  { value: "gu-IN", label: "Gujarati / ગુજરાતી" },
  { value: "hi-IN", label: "Hindi / हिन्दी" },
  { value: "it-IT", label: "Italian / Italiano" },
  { value: "ja-JP", label: "Japanese / 日本語" },
  { value: "kn-IN", label: "Kannada / ಕನ್ನಡ" },
  { value: "ko-KP", label: "Korean / 한국어" },
  { value: "ml-IN", label: "Malayalam / മലയാളം" },
  { value: "mr-IN", label: "Marathi / मराठी" },
  { value: "pl-PL", label: "Polish / Polski" },
  { value: "pt-BR", label: "Portuguese / Português" },
  { value: "ru-RU", label: "Russian / Русский" },
  { value: "ta-IN", label: "Tamil / தமிழ்" },
  { value: "te-IN", label: "Telugu / తెలుగు" },
  { value: "th-TH", label: "Thai / ไทย" },
  { value: "uk-UA", label: "Ukrainian / Українська" },
  { value: "vi-VN", label: "Vietnamese / Tiếng Việt" },
  { value: "zh-CN", label: "Chinese / 中文" },
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
];

export function languageLabel(code: string): string {
  return PATIENT_LANGUAGES.find((l) => l.value === code)?.label ?? code;
}

export function createQuestionnaireTimestamp(): string {
  return new Date().toISOString();
}
