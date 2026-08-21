import { createSlice, PayloadAction } from "@reduxjs/toolkit";

export type RecordingMode = "normal" | "conversational";
export type AppView = "recording" | "report";

export type ReportSectionKey =
  | "visitNotes"
  | "soapNote"
  | "icdCodes"
  | "cptCodes"
  | "cpt2Codes"
  | "emCodes"
  | "medication"
  | "labtest"
  | "followup"
  | "procedure"
  | "vaccine"
  | "referrals"
  | "transcription";

export const REPORT_SECTION_KEYS: ReportSectionKey[] = [
  "visitNotes",
  "soapNote",
  "icdCodes",
  "cptCodes",
  "cpt2Codes",
  "emCodes",
  "medication",
  "labtest",
  "followup",
  "procedure",
  "vaccine",
  "referrals",
  "transcription",
];

export type ReportSectionLoading = Record<ReportSectionKey, boolean>;

export function createEmptyReportData(): ReportData {
  return {
    visitNotes: [],
    soapNote: {
      subjective: {},
      objective: {},
      assessment: {},
      plan: {},
    },
    icdCodes: { icd_codes: [] },
    cptCodes: { cpt_codes: [] },
    cpt2Codes: { codes: [] },
    emCodes: { em_code: "", description: "" },
    medication: { prescribed_medications: [], in_clinic_medications: [] },
    labtest: { lab_test: [] },
    followup: { follow_up_appointment: null },
    vaccine: { vaccine: [] },
    procedure: { procedure: [] },
    referrals: [],
  };
}

function createSectionLoading(loading: boolean): ReportSectionLoading {
  return Object.fromEntries(
    REPORT_SECTION_KEYS.map((key) => [key, loading])
  ) as ReportSectionLoading;
}

function isAnySectionLoading(sections: ReportSectionLoading): boolean {
  return REPORT_SECTION_KEYS.some((key) => sections[key]);
}

export interface QAHistoryItem {
  questionEn: string;
  questionTranslated: string;
  responseEn?: string;
  responseTranslated: {
    english_translation: string;
    original_text: string;
  } | null;
}

export interface MriFinding {
  pathology?: string;
  details?: string;
}

export interface MriStudy {
  region?: string;
  date?: string;
  contrast?: string;
  human_label?: string;
  filename?: string;
  findings?: MriFinding[];
}

export interface MriReport {
  data: {
    studies: MriStudy[];
  };
}

export interface RecordingState {
  visitId: string | null;
  sessionId: string | null;
  isRecording: boolean;
  isPaused: boolean;
  recordingTime: number;
  isSpeechDetected: boolean;
  isConnected: boolean;
  isConnecting: boolean;
  recordingMode: RecordingMode;
  currentView: AppView;
  transcription: string[];
  formattedTranscription: string[] | null;
  pendingBufferCount: number;
  selectedLanguage: string;
  questionnaireStarted: boolean;
  questionnaireCompleted: boolean;
  conversationalModeStarted: boolean;
  normalModeStarted: boolean;
  currentQuestionIndex: number;
  qaHistory: QAHistoryItem[];
  isRecordingAnswer: boolean;
  isAnswerPaused: boolean;
  questionnaireStatus: string;
  currentQuestionTranslated: string;
  currentQuestionResponse: string;
  currentResponseTranslated: {
    english_translation: string;
    original_text: string;
  } | null;
  mriReport: MriReport | null;
  reportData: ReportData | null;
  reportLoading: boolean;
  reportSectionLoading: ReportSectionLoading;
  showModeWarning: boolean;
  showQRCode: boolean;
  showUserSidebar: boolean;
  showPremiumBanner: boolean;
  visitMinutesCharged: boolean;
  medicalNotesFeedbackRating: "up" | "down" | null;
  ordersFeedbackRating: "up" | "down" | null;
}

interface ConnectionStatePayload {
  isConnected: boolean;
  isConnecting: boolean;
}

export interface ReportData {
  visitNotes: string[];
  soapNote: {
    subjective: Record<string, string>;
    objective: Record<string, string>;
    assessment: Record<string, string>;
    plan: Record<string, string>;
  };
  icdCodes: { icd_codes: Array<{ icd_10_code: string; name: string }> };
  cptCodes: { cpt_codes: Array<{ cpt_code: string; name: string }> };
  cpt2Codes: { codes: Array<{ cpt2_code: string; description: string }> };
  emCodes: { em_code: string; description: string };
  medication: {
    prescribed_medications: Array<{
      correct_medicine_name: string;
      dosage: string;
      unit: string;
      frequency: { morning: string | null; afternoon: string | null; night: string | null };
      start_date: string;
      days: string;
      instruction: string;
    }>;
    in_clinic_medications: unknown[];
  };
  labtest: { lab_test: unknown[] };
  followup: {
    follow_up_appointment: {
      duration: string;
      reason: string;
      date?: string;
      instructions?: string;
      visit_type?: string;
    } | null;
  };
  vaccine: { vaccine: unknown[] };
  procedure: { procedure: unknown[] };
  referrals: unknown[];
}

const initialState: RecordingState = {
  visitId: null,
  sessionId: null,
  isRecording: false,
  isPaused: false,
  recordingTime: 0,
  isSpeechDetected: false,
  isConnected: false,
  isConnecting: false,
  recordingMode: "normal",
  currentView: "recording",
  transcription: [],
  formattedTranscription: null,
  pendingBufferCount: 0,
  selectedLanguage: "",
  questionnaireStarted: false,
  questionnaireCompleted: false,
  conversationalModeStarted: false,
  normalModeStarted: false,
  currentQuestionIndex: 0,
  qaHistory: [],
  isRecordingAnswer: false,
  isAnswerPaused: false,
  questionnaireStatus: "",
  currentQuestionTranslated: "",
  currentQuestionResponse: "",
  currentResponseTranslated: null,
  mriReport: null,
  reportData: null,
  reportLoading: false,
  reportSectionLoading: createSectionLoading(false),
  showModeWarning: false,
  showQRCode: false,
  showUserSidebar: false,
  showPremiumBanner: true,
  visitMinutesCharged: false,
  medicalNotesFeedbackRating: null,
  ordersFeedbackRating: null,
};

const recordingSlice = createSlice({
  name: "recording",
  initialState,
  reducers: {
    startVisit(state, action: PayloadAction<string>) {
      state.visitId = action.payload;
      state.sessionId = null;
      state.isConnected = false;
      state.isConnecting = false;
      state.currentView = "recording";
      state.transcription = [];
      state.formattedTranscription = null;
      state.reportData = null;
      state.reportLoading = false;
      state.reportSectionLoading = createSectionLoading(false);
      state.recordingTime = 0;
      state.visitMinutesCharged = false;
      state.medicalNotesFeedbackRating = null;
      state.ordersFeedbackRating = null;
      state.questionnaireStarted = false;
      state.questionnaireCompleted = false;
      state.conversationalModeStarted = false;
      state.normalModeStarted = false;
      state.currentQuestionIndex = 0;
      state.qaHistory = [];
      state.isRecordingAnswer = false;
      state.isAnswerPaused = false;
      state.questionnaireStatus = "";
      state.currentQuestionTranslated = "";
      state.currentQuestionResponse = "";
      state.currentResponseTranslated = null;
      state.selectedLanguage = "";
      state.mriReport = null;
      state.showModeWarning = false;
    },
    endVisit() {
      return { ...initialState };
    },
    startRecording(state) {
      state.isRecording = true;
      state.isPaused = false;
    },
    pauseRecording(state) {
      state.isPaused = true;
    },
    resumeRecording(state) {
      state.isPaused = false;
    },
    stopRecording(state) {
      state.isRecording = false;
      state.isPaused = false;
    },
    tickTimer(state) {
      state.recordingTime += 1;
    },
    setSpeechDetected(state, action: PayloadAction<boolean>) {
      state.isSpeechDetected = action.payload;
    },
    addTranscription(state, action: PayloadAction<string>) {
      state.transcription.push(action.payload);
    },
    setTranscription(state, action: PayloadAction<string[]>) {
      state.transcription = action.payload;
    },
    setFormattedTranscription(state, action: PayloadAction<string[] | null>) {
      state.formattedTranscription = action.payload;
    },
    startReportGeneration(state) {
      state.reportData = createEmptyReportData();
      state.formattedTranscription = null;
      state.reportSectionLoading = createSectionLoading(true);
      state.reportLoading = true;
    },
    patchReportData(state, action: PayloadAction<Partial<ReportData>>) {
      if (!state.reportData) {
        state.reportData = {
          ...createEmptyReportData(),
          ...action.payload,
        };
        return;
      }
      state.reportData = {
        ...state.reportData,
        ...action.payload,
      };
    },
    setReportSectionLoading(
      state,
      action: PayloadAction<{ section: ReportSectionKey; loading: boolean }>
    ) {
      state.reportSectionLoading[action.payload.section] = action.payload.loading;
      state.reportLoading = isAnySectionLoading(state.reportSectionLoading);
    },
    setReportData(state, action: PayloadAction<ReportData>) {
      state.reportData = action.payload;
      state.reportLoading = false;
      state.reportSectionLoading = createSectionLoading(false);
    },
    setReportLoading(state, action: PayloadAction<boolean>) {
      state.reportLoading = action.payload;
      if (!action.payload) {
        state.reportSectionLoading = createSectionLoading(false);
      }
    },
    setCurrentView(state, action: PayloadAction<AppView>) {
      state.currentView = action.payload;
    },
    setRecordingMode(state, action: PayloadAction<RecordingMode>) {
      state.recordingMode = action.payload;
    },
    setShowModeWarning(state, action: PayloadAction<boolean>) {
      state.showModeWarning = action.payload;
    },
    setShowQRCode(state, action: PayloadAction<boolean>) {
      state.showQRCode = action.payload;
    },
    setShowUserSidebar(state, action: PayloadAction<boolean>) {
      state.showUserSidebar = action.payload;
    },
    setSelectedLanguage(state, action: PayloadAction<string>) {
      state.selectedLanguage = action.payload;
    },
    startQuestionnaire(state) {
      state.questionnaireStarted = true;
      state.conversationalModeStarted = true;
      state.currentQuestionIndex = 0;
      state.currentQuestionResponse = "";
      state.currentQuestionTranslated = "";
      state.currentResponseTranslated = null;
      state.questionnaireStatus = "Playing question...";
    },
    nextQuestion(state) {
      state.currentQuestionIndex += 1;
      state.currentQuestionResponse = "";
      state.currentQuestionTranslated = "";
      state.currentResponseTranslated = null;
    },
    completeQuestionnaire(state) {
      state.questionnaireCompleted = true;
      state.questionnaireStarted = false;
      state.questionnaireStatus = "";
      state.isRecordingAnswer = false;
      state.isAnswerPaused = false;
    },
    addQAHistory(state, action: PayloadAction<QAHistoryItem>) {
      state.qaHistory.push(action.payload);
    },
    setRecordingAnswer(state, action: PayloadAction<boolean>) {
      state.isRecordingAnswer = action.payload;
    },
    setAnswerPaused(state, action: PayloadAction<boolean>) {
      state.isAnswerPaused = action.payload;
    },
    setConversationalModeStarted(state, action: PayloadAction<boolean>) {
      state.conversationalModeStarted = action.payload;
    },
    setNormalModeStarted(state, action: PayloadAction<boolean>) {
      state.normalModeStarted = action.payload;
    },
    setQuestionnaireStatus(state, action: PayloadAction<string>) {
      state.questionnaireStatus = action.payload;
    },
    setCurrentQuestionTranslated(state, action: PayloadAction<string>) {
      state.currentQuestionTranslated = action.payload;
    },
    setCurrentQuestionResponse(state, action: PayloadAction<string>) {
      state.currentQuestionResponse = action.payload;
    },
    setCurrentResponseTranslated(
      state,
      action: PayloadAction<{
        english_translation: string;
        original_text: string;
      } | null>
    ) {
      state.currentResponseTranslated = action.payload;
    },
    setMriReport(state, action: PayloadAction<MriReport | null>) {
      state.mriReport = action.payload;
    },
    appendMriReport(state, action: PayloadAction<MriReport>) {
      if (!state.mriReport?.data?.studies) {
        state.mriReport = action.payload;
        return;
      }
      state.mriReport = {
        data: {
          studies: [
            ...state.mriReport.data.studies,
            ...(action.payload.data?.studies ?? []),
          ],
        },
      };
    },
    clearMriReport(state) {
      state.mriReport = null;
    },
    resetQuestionnaireState(state) {
      state.questionnaireStarted = false;
      state.questionnaireCompleted = false;
      state.conversationalModeStarted = false;
      state.currentQuestionIndex = 0;
      state.qaHistory = [];
      state.isRecordingAnswer = false;
      state.isAnswerPaused = false;
      state.questionnaireStatus = "";
      state.currentQuestionTranslated = "";
      state.currentQuestionResponse = "";
      state.currentResponseTranslated = null;
      state.selectedLanguage = "";
    },
    setPendingBufferCount(state, action: PayloadAction<number>) {
      state.pendingBufferCount = action.payload;
    },
    setConnectionState(state, action: PayloadAction<ConnectionStatePayload>) {
      state.isConnected = action.payload.isConnected;
      state.isConnecting = action.payload.isConnecting;
    },
    setSessionId(state, action: PayloadAction<string>) {
      state.sessionId = action.payload;
    },
    setVisitMinutesCharged(state, action: PayloadAction<boolean>) {
      state.visitMinutesCharged = action.payload;
    },
    updateVisitNote(state, action: PayloadAction<string>) {
      if (state.reportData) {
        state.reportData.visitNotes[0] = action.payload;
      }
    },
    setMedicalNotesFeedbackRating(state, action: PayloadAction<"up" | "down" | null>) {
      state.medicalNotesFeedbackRating = action.payload;
    },
    setOrdersFeedbackRating(state, action: PayloadAction<"up" | "down" | null>) {
      state.ordersFeedbackRating = action.payload;
    },
  },
});

export const {
  startVisit,
  endVisit,
  startRecording,
  pauseRecording,
  resumeRecording,
  stopRecording,
  tickTimer,
  setSpeechDetected,
  addTranscription,
  setTranscription,
  setFormattedTranscription,
  startReportGeneration,
  patchReportData,
  setReportSectionLoading,
  setReportData,
  setReportLoading,
  setCurrentView,
  setRecordingMode,
  setShowModeWarning,
  setShowQRCode,
  setShowUserSidebar,
  setSelectedLanguage,
  startQuestionnaire,
  nextQuestion,
  completeQuestionnaire,
  addQAHistory,
  setRecordingAnswer,
  setAnswerPaused,
  setConversationalModeStarted,
  setNormalModeStarted,
  setQuestionnaireStatus,
  setCurrentQuestionTranslated,
  setCurrentQuestionResponse,
  setCurrentResponseTranslated,
  setMriReport,
  appendMriReport,
  clearMriReport,
  resetQuestionnaireState,
  setPendingBufferCount,
  setConnectionState,
  setSessionId,
  setVisitMinutesCharged,
  updateVisitNote,
  setMedicalNotesFeedbackRating,
  setOrdersFeedbackRating,
} = recordingSlice.actions;

export default recordingSlice.reducer;
