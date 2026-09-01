"use client";

import { useRef, useState } from "react";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { toast } from "sonner";
import { FileText, Eye, Paperclip, Loader2, X, Download } from "lucide-react";
import { useAppDispatch, useAppSelector } from "@/store/hooks";
import { appendMriReport, clearMriReport, removeMriStudiesForFilename, type MriReport, type MriStudy } from "@/store/slices/recordingSlice";
import MRISummaryModal from "@/components/recording/MRISummaryModal";
import { apiFetch, displayMriFinding } from "@/lib/utils";

const MAX_FILE_SIZE = 20 * 1024 * 1024;
const MAX_FILES = 6;

function tagStudiesWithFilenames(studies: MriStudy[], filenames: string[]): MriStudy[] {
  return studies.map((study, index) => ({
    ...study,
    filename:
      study.filename?.trim() ||
      (filenames.length === 1 ? filenames[0] : filenames[index] || filenames[0]),
  }));
}

export default function UploadMRIButton() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dispatch = useAppDispatch();
  const mriReport = useAppSelector((s) => s.recording.mriReport);

  const [mriFiles, setMriFiles] = useState<File[]>([]);
  const [isPreviewOpen, setIsPreviewOpen] = useState(false);
  const [isMriSummaryOpen, setIsMriSummaryOpen] = useState(false);
  const [isGeneratingReport, setIsGeneratingReport] = useState(false);
  const [isDownloadingPdf, setIsDownloadingPdf] = useState(false);

  const generateMRIClinicalSummary = async (files: File[]) => {
    setIsGeneratingReport(true);
    try {
      const formData = new FormData();
      for (const file of files) {
        formData.append("mri_files", file, file.name);
      }

      // Do not set Content-Type — the browser sets multipart/form-data with boundary.
      const response = await apiFetch("/api/gen/v2/mri_report/clinical_summary", {
        method: "POST",
        body: formData,
      });

      const result = (await response.json()) as {
        status?: string;
        message?: string;
        data?: MriReport["data"] & { patient_label?: string };
      };

      if (!response.ok || result.status === "error") {
        throw new Error(result.message || `API request failed with status ${response.status}`);
      }

      if (!result.data?.studies?.length) {
        throw new Error("MRI clinical summary returned no studies");
      }

      const taggedStudies = tagStudiesWithFilenames(
        result.data.studies,
        files.map((file) => file.name)
      );
      dispatch(appendMriReport({ data: { studies: taggedStudies } }));
      toast.success("MRI clinical summary generated successfully!");
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to generate MRI clinical summary"
      );
    } finally {
      setIsGeneratingReport(false);
    }
  };

  const handleMRIUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || []);
    if (files.length === 0) return;

    if (mriFiles.length + files.length > MAX_FILES) {
      toast.error(
        `Maximum ${MAX_FILES} files allowed. You can only add ${MAX_FILES - mriFiles.length} more file(s).`
      );
      return;
    }

    const validFiles: File[] = [];
    const invalidFiles: string[] = [];
    const duplicateFiles: string[] = [];
    const existingFilenames = mriFiles.map((f) => f.name);

    files.forEach((file) => {
      if (file.size > MAX_FILE_SIZE) {
        invalidFiles.push(`${file.name} (exceeds 20MB)`);
      } else if (existingFilenames.includes(file.name)) {
        duplicateFiles.push(file.name);
      } else {
        validFiles.push(file);
      }
    });

    if (invalidFiles.length > 0) {
      toast.error(`The following files exceed 20MB limit:\n${invalidFiles.join("\n")}`);
    }
    if (duplicateFiles.length > 0) {
      toast.error(`The following files are already uploaded:\n${duplicateFiles.join("\n")}`);
    }

    if (validFiles.length > 0) {
      setMriFiles((prev) => [...prev, ...validFiles]);
      toast.success(`${validFiles.length} file(s) uploaded successfully`);
      await generateMRIClinicalSummary(validFiles);
    }

    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  const handleRemoveFile = (index: number) => {
    const file = mriFiles[index];
    if (!file) return;

    dispatch(removeMriStudiesForFilename(file.name));

    const nextFiles = mriFiles.filter((_, i) => i !== index);
    setMriFiles(nextFiles);

    if (nextFiles.length === 0) {
      dispatch(clearMriReport());
    }

    toast.success("File removed");
  };

  const handleOpenFile = (file: File) => {
    const fileUrl = URL.createObjectURL(file);
    window.open(fileUrl, "_blank");
  };

  const formatFileSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  };

  const handleDownloadMriPdf = async () => {
    if (!mriReport?.data?.studies?.length || isDownloadingPdf) return;
    setIsDownloadingPdf(true);
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
        if (!text?.trim()) return;
        const sanitized = sanitizeText(text) || text;
        const lines = doc.splitTextToSize(sanitized, pageWidth - margin * 2 - indent);
        checkY(lines.length * 5);
        doc.text(lines, margin + indent, y);
        y += lines.length * 5;
      };

      doc.setFontSize(16);
      doc.setFont("helvetica", "bold");
      doc.text("MRI Report", margin, y);
      y += 12;
      doc.setFontSize(11);
      doc.setFont("helvetica", "normal");

      mriReport.data.studies.forEach((study, studyIndex) => {
        checkY(20);
        doc.setFont("helvetica", "bold");
        doc.text(
          `${studyIndex + 1}. ${study.region?.replace(/_/g, " ").toUpperCase() || "MRI Study"}`,
          margin,
          y
        );
        y += 6;
        doc.setFont("helvetica", "normal");
        if (study.human_label) addParagraph(study.human_label, 5);
        study.findings?.forEach((finding) => {
          const { label, details } = displayMriFinding(finding);
          addParagraph(`• ${label}`, 5);
          if (details) addParagraph(details, 10);
        });
        y += 4;
      });

      const fileName = new Date().toLocaleDateString("en-US", {
        year: "numeric",
        month: "long",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
      await doc.save(`mri-report-${fileName}.pdf`);
    } catch {
      toast.error("Failed to export MRI report PDF");
    } finally {
      setIsDownloadingPdf(false);
    }
  };

  return (
    <>
      <input
        type="file"
        ref={fileInputRef}
        className="hidden"
        accept=".pdf"
        multiple
        onChange={(e) => void handleMRIUpload(e)}
      />

      <div className="mt-4 inline-flex items-center gap-3">
        {!!mriReport?.data?.studies?.length && (
          <button
            onClick={() => void handleDownloadMriPdf()}
            disabled={isDownloadingPdf}
            className="flex items-center justify-center h-9 w-9 rounded-full bg-brand-green/10 hover:bg-brand-green/20 transition-colors cursor-pointer disabled:opacity-40"
            title="Download MRI Report PDF"
          >
            {isDownloadingPdf ? (
              <Loader2 className="h-5 w-5 text-brand-green animate-spin" />
            ) : (
              <Download className="h-5 w-5 text-brand-green" />
            )}
          </button>
        )}

        <div className="inline-flex rounded-xl overflow-hidden shadow-sm">
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={isGeneratingReport}
            className="bg-brand-orange text-white hover:bg-brand-orange/90 rounded-none rounded-l-xl px-4 py-3 transition-all flex items-center gap-3 border-r border-white/20 disabled:opacity-50"
          >
            {isGeneratingReport ? (
              <>
                <Loader2 className="h-5 w-5 animate-spin" />
                Generating Report...
              </>
            ) : (
              "Upload MRI"
            )}
          </button>
          <button
            onClick={() => {
              if (mriFiles.length === 0) {
                toast.error("No files uploaded yet");
                return;
              }
              setIsPreviewOpen(true);
            }}
            className="bg-brand-orange text-white hover:bg-brand-orange/90 rounded-none rounded-r-xl px-3 py-3 transition-all"
            title="Preview uploaded files"
          >
            <Paperclip className="h-5 w-5" />
          </button>
        </div>

        {!!mriReport?.data?.studies?.length && (
          <button
            onClick={() => setIsMriSummaryOpen(true)}
            className="flex items-center justify-center h-9 w-9 rounded-full bg-brand-blue/10 hover:bg-brand-blue/20 transition-colors"
            title="View MRI Summary"
          >
            <Eye className="h-5 w-5 text-brand-blue" />
          </button>
        )}
      </div>

      <Dialog open={isPreviewOpen} onOpenChange={setIsPreviewOpen}>
        <DialogContent
          className="sm:max-w-4xl max-h-[90vh] overflow-y-auto p-6"
          hiddenTitle="MRI Files Preview"
          hiddenDescription="Preview uploaded MRI PDF files"
        >
          <h3 className="text-lg font-semibold text-slate-800">
            MRI Files Preview ({mriFiles.length})
          </h3>
          <div className="mt-4">
            {mriFiles.length > 0 ? (
              <div className="space-y-4">
                {mriFiles.map((file, index) => (
                  <div
                    key={`${file.name}-${index}`}
                    className="border border-slate-200 rounded-lg p-4 hover:border-brand-orange/50 hover:bg-slate-50 transition-colors cursor-pointer"
                    onClick={() => handleOpenFile(file)}
                  >
                    <div className="flex items-start gap-4">
                      <div className="flex-shrink-0 w-24 h-24 bg-slate-100 rounded-lg flex items-center justify-center">
                        <FileText className="h-12 w-12 text-slate-400" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <h4 className="font-medium text-slate-900 truncate">{file.name}</h4>
                        <p className="text-sm text-slate-500 mt-1">
                          Size: {formatFileSize(file.size)}
                        </p>
                        <p className="text-sm text-slate-500">Type: {file.type || "Unknown"}</p>
                      </div>
                      <button
                        disabled={isGeneratingReport}
                        onClick={(e) => {
                          e.stopPropagation();
                          if (isGeneratingReport) {
                            toast.error("Cannot remove file while generating report");
                            return;
                          }
                          handleRemoveFile(index);
                        }}
                        className="text-red-500 hover:text-red-700 hover:bg-red-50 rounded-md p-2"
                      >
                        <X className="h-5 w-5" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-center py-12 text-slate-400">No files uploaded yet</div>
            )}
          </div>
          <div className="mt-4 flex justify-end">
            <button
              onClick={() => setIsPreviewOpen(false)}
              className="border border-slate-200 rounded-lg px-4 py-2 text-sm hover:bg-slate-50"
            >
              Close
            </button>
          </div>
        </DialogContent>
      </Dialog>

      <MRISummaryModal open={isMriSummaryOpen} onClose={() => setIsMriSummaryOpen(false)} />
    </>
  );
}
