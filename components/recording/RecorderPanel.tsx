"use client";

import { motion } from "framer-motion";
import Image from "next/image";
import { Mic, Play, Pause } from "lucide-react";
import { formatTime, withBasePath } from "@/lib/utils";
import { ConversationalControls } from "@/components/recording/ConversationalControls";
import UploadMRIButton from "@/components/recording/UploadMRIButton";
import type { RecordingMode } from "@/store/slices/recordingSlice";

interface RecorderPanelProps {
  visitId: string | null;
  isRecording: boolean;
  isPaused: boolean;
  isSpeechDetected: boolean;
  isConnected: boolean;
  isConnecting: boolean;
  recordingTime: number;
  companionActive?: boolean;
  companionJoined?: boolean;
  recordingMode?: RecordingMode;
  enableMRI?: boolean;
  onStartVisit: () => void;
  onStartRecording: () => void;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
}

export function RecorderPanel({
  visitId,
  isRecording,
  isPaused,
  isSpeechDetected,
  isConnected,
  isConnecting,
  recordingTime,
  companionActive = false,
  companionJoined = false,
  recordingMode = "normal",
  enableMRI = true,
  onStartVisit,
  onStartRecording,
  onPause,
  onResume,
  onStop,
}: RecorderPanelProps) {
  if (!visitId) {
    return (
      <div className="bg-white rounded-2xl p-8 flex justify-center items-center shadow-[0_2px_6px_rgba(0,0,0,0.04),0_0_16px_2px_rgba(191,223,241,0.9)]">
        <div className="flex flex-col items-center h-full w-full">
          <motion.div
            initial={{ scale: 0.8, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ duration: 0.5 }}
            className="flex flex-col items-center h-full justify-center gap-6"
          >
            <Image
              src={withBasePath("/vt_img.png")}
              alt="Visit illustration"
              width={400}
              height={400}
              className="mr-10"
              priority
            />
            <button
              onClick={onStartVisit}
              className="bg-brand-green hover:bg-opacity-90 text-white rounded-xl px-6 py-3 text-base font-medium shadow-md hover:shadow-lg transition-all"
            >
              Start Visit
            </button>
          </motion.div>
        </div>
      </div>
    );
  }

  const micBgColor = isRecording
    ? isPaused
      ? "bg-brand-orange"
      : "bg-brand-pink"
    : "bg-brand-green";

  const showNormalStart = recordingMode === "normal" && !isRecording;
  const showConversational = recordingMode === "conversational";

  return (
    <div className="mt-4 sm:mt-0 bg-white rounded-2xl p-5 sm:p-6 flex justify-center items-start sm:items-center min-h-[240px] sm:min-h-[280px] shadow-[0_2px_6px_rgba(0,0,0,0.04),0_0_16px_2px_rgba(191,223,241,0.9)]">
      <div className="flex flex-col items-center w-full">
        <div className="relative mb-5 sm:mb-8">
          <div
            className={`h-20 w-20 sm:h-28 sm:w-28 rounded-full ${micBgColor} flex items-center justify-center shadow-lg`}
          >
            {isRecording ? (
              isPaused ? (
                <Play className="h-9 w-9 sm:h-12 sm:w-12 text-white" />
              ) : (
                <Pause className="h-9 w-9 sm:h-12 sm:w-12 text-white" />
              )
            ) : (
              <Mic className="h-9 w-9 sm:h-12 sm:w-12 text-white" />
            )}
          </div>
        </div>

        {!isRecording && (
          <div className="text-base text-slate-500 mb-5 sm:mb-6 text-center">
            {isConnecting
              ? "Starting transcription…"
              : companionActive
                ? "Companion phone connected"
                : companionJoined
                  ? "Ready to record — scan QR to use the companion app"
                  : "Ready to record"}
          </div>
        )}

        {isRecording && (
          <div className="text-xl font-mono mb-5 sm:mb-6 text-slate-700">
            {formatTime(recordingTime)}
            {isSpeechDetected && (
              <span className="text-brand-green ml-2 text-base">(Speech detected)</span>
            )}
            {!isConnected && (
              <span className="text-yellow-600 ml-2 text-base">
                {isConnecting ? "(Reconnecting…)" : "(Disconnected)"}
              </span>
            )}
          </div>
        )}

        {showConversational && (
          <ConversationalControls
            isVisitRecording={isRecording}
            onStartVisitNotes={onStartRecording}
            isStartingVisitNotes={isConnecting}
          />
        )}

        {showNormalStart && (
          <button
            onClick={onStartRecording}
            disabled={isConnecting}
            className="bg-brand-green hover:bg-opacity-90 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-xl px-6 py-3 text-base font-medium shadow-md hover:shadow-lg transition-all"
          >
            {isConnecting ? "Starting…" : "Start Recording"}
          </button>
        )}

        {isRecording && (
          <div className="flex space-x-4">
            <button
              onClick={isPaused ? onResume : onPause}
              className="bg-brand-orange hover:bg-opacity-90 text-white rounded-xl px-6 py-3 text-base font-medium shadow-md hover:shadow-lg transition-all"
            >
              {isPaused ? "Resume" : "Pause"}
            </button>
            <button
              onClick={onStop}
              className="bg-brand-pink hover:bg-opacity-90 text-white rounded-xl px-6 py-3 text-base font-medium shadow-md hover:shadow-lg transition-all"
            >
              Stop Recording
            </button>
          </div>
        )}

        {isRecording && (
          <div className="mt-4 text-sm text-slate-500">
            {isPaused
              ? "Recording paused"
              : isSpeechDetected
                ? "Listening to speech..."
                : "Waiting for speech..."}
          </div>
        )}

        {enableMRI && <UploadMRIButton />}
      </div>
    </div>
  );
}
