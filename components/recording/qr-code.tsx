"use client";

import { QRCodeSVG } from "qrcode.react";
import { buildVisitQrPayload } from "@/lib/companion/protocol";

interface QRCodeCardProps {
  doctorId: string;
  visitId: string;
}

export function QRCodeCard({ doctorId, visitId }: QRCodeCardProps) {
  const qrData = buildVisitQrPayload(doctorId, visitId);

  return (
    <div className="w-full">
      <h2 className="text-brand-blue text-lg font-semibold">Companion App QR Code</h2>
      <p className="text-slate-600 text-sm mt-2">
        Scan this QR code with the companion app to use the phone as the microphone
      </p>

      <div className="flex justify-center my-6">
        <div className="bg-white p-4 rounded-lg">
          <QRCodeSVG value={qrData} size={192} level="M" />
        </div>
      </div>

      <p className="text-sm text-slate-500 text-center">
        This code contains the doctor, visit, and patient ids the companion app needs to join this session
      </p>
    </div>
  );
}
