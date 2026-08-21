"use client";

import { useEffect, useState } from "react";
import { Activity, DownloadIcon, Loader2Icon, X } from "lucide-react";
import { useAppSelector } from "@/store/hooks";

interface MRISummaryModalProps {
  open: boolean;
  onClose: () => void;
}

export default function MRISummaryModal({ open, onClose }: MRISummaryModalProps) {
  const mriReport = useAppSelector((s) => s.recording.mriReport);
  const [isExportingPdf, setIsExportingPdf] = useState(false);

  useEffect(() => {
    window.dispatchEvent(new CustomEvent("mri-modal-change", { detail: { open } }));
    return () => {
      if (open) {
        window.dispatchEvent(new CustomEvent("mri-modal-change", { detail: { open: false } }));
      }
    };
  }, [open]);

  const handleExportMriPdf = async () => {
    if (!mriReport?.data?.studies?.length || isExportingPdf) return;
    setIsExportingPdf(true);

    try {
      const { default: jsPDF } = await import("jspdf");
      const doc = new jsPDF();
      const pageHeight = doc.internal.pageSize.height;
      const pageWidth = doc.internal.pageSize.width;
      const margin = 15;
      let y = margin;

      const sanitizeText = (text: string | null | undefined) => {
        if (!text) return text;
        return text.replace(/[^\x00-\x7F]/g, "");
      };

      const checkY = (heightNeeded = 20) => {
        if (y + heightNeeded > pageHeight - margin) {
          doc.addPage();
          y = margin;
        }
      };

      const addParagraph = (text: string | null | undefined, indent = 0) => {
        if (!text?.trim()) {
          checkY(8);
          doc.setFont("helvetica", "italic");
          doc.setTextColor(150);
          doc.text("No data available", margin + indent, y);
          doc.setFont("helvetica", "normal");
          doc.setTextColor(0);
          y += 6;
          return;
        }
        const sanitized = sanitizeText(text) || text;
        const lines = doc.splitTextToSize(sanitized, pageWidth - margin * 2 - indent);
        checkY(lines.length * 5);
        doc.text(lines, margin + indent, y);
        y += lines.length * 5;
      };

      checkY(15);
      doc.setFontSize(16);
      doc.setFont("helvetica", "bold");
      doc.text("MRI Report", margin, y);
      y += 5;
      doc.setLineWidth(0.5);
      doc.line(margin, y, pageWidth - margin, y);
      y += 8;
      doc.setFontSize(11);
      doc.setFont("helvetica", "normal");

      mriReport.data.studies.forEach((study, studyIndex) => {
        checkY(20);
        const regionName = study.region?.replace(/_/g, " ").toUpperCase() || "MRI Study";
        doc.setFont("helvetica", "bold");
        doc.setFontSize(13);
        doc.text(`${studyIndex + 1}. ${regionName}`, margin, y);
        y += 6;
        doc.setFontSize(11);
        doc.setFont("helvetica", "normal");

        if (study.date) addParagraph(`Date: ${study.date}`, 5);
        if (study.contrast) addParagraph(`Contrast: ${study.contrast}`, 5);
        if (study.human_label) {
          doc.setFont("helvetica", "italic");
          doc.setTextColor(100);
          const labelLines = doc.splitTextToSize(study.human_label, pageWidth - margin * 2 - 5);
          checkY(labelLines.length * 5);
          doc.text(labelLines, margin + 5, y);
          y += labelLines.length * 5 + 3;
          doc.setFont("helvetica", "normal");
          doc.setTextColor(0);
        }

        y += 3;
        if (study.findings?.length) {
          doc.setFont("helvetica", "bold");
          doc.text("Findings:", margin + 5, y);
          y += 6;
          doc.setFont("helvetica", "normal");

          study.findings.forEach((finding) => {
            checkY(15);
            doc.setFont("helvetica", "bold");
            doc.text(`• ${finding.pathology || "Unknown pathology"}`, margin + 10, y);
            y += 5;
            doc.setFont("helvetica", "normal");
            if (finding.details) {
              const sanitizedDetails = sanitizeText(finding.details) || finding.details;
              const detailLines = doc.splitTextToSize(
                sanitizedDetails,
                pageWidth - margin * 2 - 15
              );
              checkY(detailLines.length * 5);
              doc.text(detailLines, margin + 15, y);
              y += detailLines.length * 5 + 3;
            }
          });
        } else {
          doc.setFont("helvetica", "italic");
          doc.setTextColor(150);
          doc.text("No findings recorded", margin + 5, y);
          doc.setFont("helvetica", "normal");
          doc.setTextColor(0);
          y += 6;
        }
        y += 5;
      });

      const fileName = new Date().toLocaleDateString("en-US", {
        year: "numeric",
        month: "long",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
      await doc.save(`mri-report-${fileName}.pdf`);
    } catch (error) {
      console.error("Error exporting MRI PDF:", error);
    } finally {
      setIsExportingPdf(false);
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div
        className="relative z-10 bg-white rounded-2xl shadow-[0_8px_30px_rgb(0,0,0,0.06)] overflow-hidden flex flex-col"
        style={{ width: "calc(100vw - 48px)", height: "calc(100vh - 48px)" }}
      >
        <div className="border-b border-slate-100 px-6 py-4 flex items-center shrink-0">
          <div className="flex-1 flex items-center justify-center">
            <Activity className="h-4 w-4 mr-2 text-brand-blue" />
            <h2 className="text-brand-blue font-semibold">MRI Report</h2>
          </div>
          <div className="flex items-center space-x-2 shrink-0">
            <button
              className="rounded-full border border-slate-200 hover:border-brand-green hover:text-brand-green disabled:opacity-50 px-3 py-1.5 text-sm flex items-center"
              onClick={() => void handleExportMriPdf()}
              disabled={isExportingPdf || !mriReport?.data?.studies?.length}
            >
              {isExportingPdf ? (
                <Loader2Icon className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <DownloadIcon className="h-4 w-4 mr-2" />
              )}
              {isExportingPdf ? "Exporting..." : "Export PDF"}
            </button>
            <button
              onClick={onClose}
              className="h-8 w-8 flex items-center justify-center rounded-full hover:bg-slate-100 transition-colors"
            >
              <X className="h-4 w-4 text-slate-500" />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {mriReport?.data?.studies?.length ? (
            <div className="space-y-6">
              {mriReport.data.studies.map((study, studyIndex) => (
                <div
                  key={studyIndex}
                  className="border border-brand-blue/10 rounded-lg p-5 bg-gradient-to-br from-brand-blue/5 to-white"
                >
                  <div className="mb-3">
                    <h4 className="font-semibold text-brand-blue text-base">
                      {study.region?.replace(/_/g, " ").toUpperCase() || "MRI Study"}
                    </h4>
                    {study.human_label && (
                      <p className="text-xs text-slate-500 mt-2">{study.human_label}</p>
                    )}
                  </div>
                  {study.findings?.length ? (
                    <div>
                      {study.findings.map((finding, findingIndex) => (
                        <div key={findingIndex} className="flex items-start gap-3 mb-2">
                          <div className="font-medium text-sm text-slate-800">
                            {finding.pathology || "Unknown pathology"}
                          </div>
                          {finding.details && (
                            <div className="text-sm text-slate-600 leading-relaxed">
                              - {finding.details}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-sm text-slate-500 italic">No findings recorded</p>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <div className="text-center p-8 text-slate-500">
              <Activity className="h-12 w-12 mx-auto mb-3 text-slate-300" />
              <p>No MRI studies available</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
