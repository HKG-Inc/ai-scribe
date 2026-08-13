"use client";

import { Dialog, DialogContent } from "@/components/ui/dialog";
import { QRCodeCard } from "@/components/recording/qr-code";

interface QRCodeDialogProps {
  open: boolean;
  onClose: () => void;
  visitId: string | null;
  doctorId: string;
}

export function QRCodeDialog({ open, onClose, visitId, doctorId }: QRCodeDialogProps) {
  if (!visitId || !doctorId) return null;

  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogContent
        className="w-11/12 sm:max-w-md p-6"
        hiddenTitle="Companion App QR Code"
        hiddenDescription="Scan this QR code with the companion app to connect your device for microphone access"
      >
        <QRCodeCard doctorId={doctorId} visitId={visitId} />
      </DialogContent>
    </Dialog>
  );
}

interface ModeWarningDialogProps {
  open: boolean;
  onClose: () => void;
}

export function ModeWarningDialog({ open, onClose }: ModeWarningDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent
        className="max-w-md p-6"
        showClose={false}
        hiddenTitle="Cannot switch mode"
        hiddenDescription="Explains why mode switching is disabled during an active conversational visit"
      >
        <h2 className="text-slate-700 text-lg font-medium">Cannot Switch to Normal Mode</h2>
        <div className="py-4">
          <p className="text-slate-600 text-sm">
            You have started the conversational mode questionnaire. You can only switch back to
            Normal Mode after ending this visit.
          </p>
          <p className="text-slate-600 text-sm mt-3">
            To switch modes, please click the &quot;End Visit&quot; button in the header and start a new visit.
          </p>
        </div>
        <div className="flex justify-end">
          <button
            onClick={onClose}
            className="bg-brand-blue hover:bg-brand-pink text-white rounded-md px-4 py-2 text-sm transition-colors"
          >
            Got it
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
