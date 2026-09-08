import type { ReportData } from "@/store/slices/recordingSlice";
import { cleanDateValue } from "@/lib/utils";
import { formatMedicationFrequency } from "@/lib/medication";
import { getProcedureTypeBadge } from "@/lib/procedure-types";
import { formatReferralUrgency } from "@/lib/referrals";
import {
  classifyVisitNotesLine,
  splitMajorHeader,
} from "@/lib/visit-notes-display";

export interface ExportVisitReportPdfOptions {
  reportData: ReportData;
  visitId?: string | null;
  transcription?: string[];
}

export async function exportVisitReportPdf({
  reportData,
  visitId,
  transcription = [],
}: ExportVisitReportPdfOptions): Promise<void> {
  const { default: jsPDF } = await import("jspdf");
  const doc = new jsPDF();
  const pageHeight = doc.internal.pageSize.height;
  const pageWidth = doc.internal.pageSize.width;
  const margin = 15;
  let y = margin;

  const sanitizeText = (text: string | null | undefined): string => {
    if (!text) return "";
    return text.replace(/[^\x00-\x7F]/g, "");
  };

  const checkY = (heightNeeded = 20) => {
    if (y + heightNeeded > pageHeight - margin) {
      doc.addPage();
      y = margin;
    }
  };

  const addSectionTitle = (title: string) => {
    checkY(15);
    doc.setFontSize(16);
    doc.setFont("helvetica", "bold");
    doc.text(title, margin, y);
    y += 5;
    doc.setLineWidth(0.5);
    doc.line(margin, y, pageWidth - margin, y);
    y += 8;
    doc.setFontSize(11);
    doc.setFont("helvetica", "normal");
  };

  const addSubTitle = (title: string, keepWithNext = false) => {
    const titleHeight = 10;
    const minContentHeight = keepWithNext ? 15 : 0;
    checkY(titleHeight + minContentHeight);
    doc.setFontSize(12);
    doc.setFont("helvetica", "bold");
    doc.text(title, margin, y);
    y += 7;
    doc.setFontSize(11);
    doc.setFont("helvetica", "normal");
  };

  const renderTextBlock = (text: string, indent: number) => {
    const sanitizedText = sanitizeText(text) || text;
    const lines = doc.splitTextToSize(sanitizedText, pageWidth - margin * 2 - indent);
    const lineHeight = 5;
    const maxLinesPerCheck = 10;

    for (let i = 0; i < lines.length; i += maxLinesPerCheck) {
      const chunk = lines.slice(i, i + maxLinesPerCheck);
      const chunkHeight = chunk.length * lineHeight;
      checkY(chunkHeight);
      doc.text(chunk, margin + indent, y);
      y += chunk.length * lineHeight;
    }
  };

  const addParagraph = (text: string | null | undefined, indent = 0, preserveNewlines = false) => {
    if (
      !text ||
      text.trim() === "" ||
      text.trim() === "N/A" ||
      text.trim() === "Insufficient content"
    ) {
      checkY(6);
      doc.setFont("helvetica", "italic");
      doc.setTextColor(150);
      doc.text("Insufficient content", margin + indent, y);
      doc.setFont("helvetica", "normal");
      doc.setTextColor(0);
      y += 6;
      return;
    }

    let paragraphs: string[];
    if (preserveNewlines) {
      paragraphs = text
        .split(/\n/)
        .map((p) => p.replace(/\s+/g, " ").trim())
        .filter((p) => p.length > 0);
    } else {
      paragraphs = text
        .split(/\n\n+/)
        .map((p) => p.replace(/\n/g, " ").replace(/\s+/g, " ").trim())
        .filter((p) => p.length > 0);
    }

    const paragraphSpacing = preserveNewlines ? 2 : 4;
    paragraphs.forEach((paragraph, index) => {
      renderTextBlock(paragraph, indent);
      if (index < paragraphs.length - 1) {
        y += paragraphSpacing;
      }
    });
    y += 1;
  };

  const addListItem = (label: string, value: string | null | undefined) => {
    if (!value || value.trim() === "" || value.trim() === "N/A") return;
    checkY(6);
    doc.setFont("helvetica", "bold");
    doc.text(`${label}:`, margin, y, { align: "left" });
    doc.setFont("helvetica", "normal");
    const valueX = margin + doc.getTextWidth(`${label}: `) + 1;
    const sanitizedValue = sanitizeText(value) || value;
    const valueLines = doc.splitTextToSize(sanitizedValue, pageWidth - margin - valueX);
    doc.text(valueLines, valueX, y);
    y += valueLines.length * 5 + 1;
  };

  const renderCodeBox = (
    title: string,
    renderContent: (contentX: number, maxWidth: number) => void,
    estimatedItems = 1
  ) => {
    const boxX = margin;
    const boxWidth = pageWidth - margin * 2;
    const contentX = boxX + 4;
    const contentMaxWidth = boxWidth - 8;
    const estimatedHeight = 10 + estimatedItems * 6 + 6;
    checkY(estimatedHeight);

    const startPage = doc.getNumberOfPages();
    const boxStartY = y;

    y += 5;
    doc.setFontSize(11);
    doc.setFont("helvetica", "bold");
    doc.text(title, contentX, y);
    y += 5;
    doc.setFont("helvetica", "normal");

    renderContent(contentX, contentMaxWidth);

    const endPage = doc.getNumberOfPages();
    doc.setDrawColor(190);
    doc.setLineWidth(0.4);

    if (startPage === endPage) {
      const boxHeight = y - boxStartY - 2;
      doc.roundedRect(boxX, boxStartY, boxWidth, boxHeight, 2, 2, "S");
      y = boxStartY + boxHeight + 2;
    } else {
      doc.setPage(startPage);
      const firstPageBottom = pageHeight - margin;
      doc.line(boxX, boxStartY, boxX + boxWidth, boxStartY);
      doc.line(boxX, boxStartY, boxX, firstPageBottom);
      doc.line(boxX + boxWidth, boxStartY, boxX + boxWidth, firstPageBottom);

      for (let p = startPage + 1; p < endPage; p++) {
        doc.setPage(p);
        doc.line(boxX, margin, boxX, pageHeight - margin);
        doc.line(boxX + boxWidth, margin, boxX + boxWidth, pageHeight - margin);
      }

      doc.setPage(endPage);
      const contentEndY = y - 2;
      doc.line(boxX, margin, boxX, contentEndY);
      doc.line(boxX + boxWidth, margin, boxX + boxWidth, contentEndY);
      doc.line(boxX, contentEndY, boxX + boxWidth, contentEndY);
      y = contentEndY + 2;
    }

    doc.setDrawColor(0);
    doc.setLineWidth(0.2);
  };

  // Title
  doc.setFontSize(20);
  doc.setFont("helvetica", "bold");
  doc.text("Visit Report", pageWidth / 2, y, { align: "center" });
  y += 10;


  // Visit Summary
  addSectionTitle("Visit Summary");
  addSubTitle("Notes", true);
  const visitNotesText = reportData.visitNotes.filter((note) => note?.trim()).join("\n\n");
  if (
    !visitNotesText ||
    visitNotesText.trim() === "" ||
    visitNotesText.trim() === "N/A" ||
    visitNotesText.trim() === "Insufficient content"
  ) {
    addParagraph(null, 0, true);
  } else {
    const lines = visitNotesText.replace(/\r\n/g, "\n").split("\n");
    const lineHeight = 5;
    for (const line of lines) {
      const kind = classifyVisitNotesLine(line);
      if (kind === "blank") {
        y += 3;
        continue;
      }

      checkY(lineHeight + 2);
      if (kind === "major") {
        const split = splitMajorHeader(line);
        if (split?.rest) {
          doc.setFont("helvetica", "bold");
          const labelWidth = doc.getTextWidth(split.label + " ");
          doc.text(sanitizeText(split.label) || split.label, margin, y);
          doc.setFont("helvetica", "normal");
          const restLines = doc.splitTextToSize(
            sanitizeText(split.rest) || split.rest,
            pageWidth - margin * 2 - labelWidth
          );
          doc.text(restLines[0] || "", margin + labelWidth, y);
          y += lineHeight;
          for (let i = 1; i < restLines.length; i += 1) {
            checkY(lineHeight);
            doc.text(restLines[i], margin, y);
            y += lineHeight;
          }
        } else {
          doc.setFont("helvetica", "bold");
          const header = split?.label || line.trim();
          const headerLines = doc.splitTextToSize(
            sanitizeText(header) || header,
            pageWidth - margin * 2
          );
          doc.text(headerLines, margin, y);
          y += headerLines.length * lineHeight;
          doc.setFont("helvetica", "normal");
        }
      } else if (kind === "subheader") {
        doc.setFont("helvetica", "bold");
        const headerLines = doc.splitTextToSize(
          sanitizeText(line.trim()) || line.trim(),
          pageWidth - margin * 2
        );
        doc.text(headerLines, margin, y);
        y += headerLines.length * lineHeight;
        doc.setFont("helvetica", "normal");
      } else {
        doc.setFont("helvetica", "normal");
        const bodyLines = doc.splitTextToSize(
          sanitizeText(line) || line,
          pageWidth - margin * 2
        );
        for (const bodyLine of bodyLines) {
          checkY(lineHeight);
          doc.text(bodyLine, margin, y);
          y += lineHeight;
        }
      }
    }
  }
  y += 4;

  // Medical Coding
  addSubTitle("Medical Coding");
  y -= 4;

  const icdCount = reportData.icdCodes.icd_codes.length || 1;
  renderCodeBox("ICD-10 Diagnosis Codes", (contentX, contentMaxWidth) => {
    if (reportData.icdCodes.icd_codes.length > 0) {
      reportData.icdCodes.icd_codes.forEach((code) => {
        const text = `• ${code.icd_10_code} - ${code.name}`;
        const lines = doc.splitTextToSize(sanitizeText(text) || text, contentMaxWidth - 5);
        checkY(lines.length * 5);
        doc.text(lines, contentX + 3, y);
        y += lines.length * 5;
      });
    } else {
      addParagraph(null, 5);
    }
  }, icdCount);

  const cptCount = reportData.cptCodes.cpt_codes.length || 1;
  renderCodeBox("CPT Procedure Codes", (contentX, contentMaxWidth) => {
    if (reportData.cptCodes.cpt_codes.length > 0) {
      reportData.cptCodes.cpt_codes.forEach((code) => {
        const text = `• ${code.cpt_code} - ${code.name}`;
        const lines = doc.splitTextToSize(sanitizeText(text) || text, contentMaxWidth - 5);
        checkY(lines.length * 5);
        doc.text(lines, contentX + 3, y);
        y += lines.length * 5;
      });
    } else {
      addParagraph(null, 5);
    }
  }, cptCount);

  renderCodeBox("EM Codes", (contentX, contentMaxWidth) => {
    if (reportData.emCodes.em_code) {
      const text = `• ${reportData.emCodes.em_code} - ${reportData.emCodes.description}`;
      const lines = doc.splitTextToSize(sanitizeText(text) || text, contentMaxWidth - 5);
      checkY(lines.length * 5);
      doc.text(lines, contentX + 3, y);
      y += lines.length * 5;
    } else {
      addParagraph(null, 5);
    }
  }, 1);

  const cpt2Count = reportData.cpt2Codes.codes.length || 1;
  renderCodeBox("CPT-2 Codes", (contentX, contentMaxWidth) => {
    if (reportData.cpt2Codes.codes.length > 0) {
      reportData.cpt2Codes.codes.forEach((code) => {
        const text = `• ${code.cpt2_code} - ${code.description}`;
        const lines = doc.splitTextToSize(sanitizeText(text) || text, contentMaxWidth - 5);
        checkY(lines.length * 5);
        doc.text(lines, contentX + 3, y);
        y += lines.length * 5;
      });
    } else {
      addParagraph(null, 5);
    }
  }, cpt2Count);

  y += 5;

  // Medications
  addSubTitle("Prescribed Medications");
  const meds = reportData.medication.prescribed_medications;
  if (meds.length === 0) {
    addParagraph(null, 5);
  } else {
    meds.forEach((med, index) => {
      checkY(30);
      doc.setFont("helvetica", "bold");
      doc.text(`${index + 1}. ${med.correct_medicine_name}`, margin, y);
      y += 6;
      doc.setFont("helvetica", "normal");

      const dosage = med.dosage ? `${med.dosage} ${med.unit}`.trim() : "N/A";

      addParagraph(`Dosage: ${dosage}`, 5);
      addParagraph(`Frequency: ${formatMedicationFrequency(med.frequency)}`, 5);
      addParagraph(`Start Date: ${med.start_date || "N/A"}`, 5);
      addParagraph(`Duration: ${med.days ? `${med.days} days` : "N/A"}`, 5);
      addParagraph(`Instruction: ${med.instruction || "N/A"}`, 5);
      y += 3;
    });
  }

  // Lab Tests
  addSubTitle("Recommended Lab Tests");
  const labs = reportData.labtest.lab_test as Array<Record<string, unknown>>;
  if (labs.length === 0) {
    addParagraph(null, 5);
  } else {
    labs.forEach((test, index) => {
      const name = typeof test.name === "string" ? test.name : "";
      if (!name.trim()) return;
      checkY(15);
      doc.setFont("helvetica", "bold");
      doc.text(`${index + 1}. ${name}`, margin, y);
      y += 6;
      doc.setFont("helvetica", "normal");
      const notes = typeof test.notes === "string" && test.notes.trim() ? test.notes.trim() : "";
      const date = cleanDateValue(test.date);
      if (notes) {
        addParagraph(`Notes: ${notes}`, 5);
      }
      if (date) {
        addParagraph(`Date: ${date}`, 5);
      }
      y += 3;
    });
  }

  // Procedures (includes vaccines)
  addSubTitle("Procedure Information");
  const procedureItems = [
    ...(reportData.vaccine.vaccine as Array<Record<string, unknown>>).map((item) => ({
      name:
        typeof item.name === "string"
          ? item.name
          : typeof item.vaccine_name === "string"
            ? item.vaccine_name
            : "",
      typeLabel: "Vaccine",
      note:
        typeof item.dose === "string"
          ? item.dose
          : typeof item.dose_number === "string"
            ? item.dose_number
            : "",
      date: cleanDateValue(item.date) || "N/A",
    })),
    ...(reportData.procedure.procedure as Array<Record<string, unknown>>).map((item) => {
      const name =
        typeof item.name === "string"
          ? item.name
          : typeof item.procedure_name === "string"
            ? item.procedure_name
            : "";
      const procedureType =
        typeof item.procedure_type === "string" ? item.procedure_type : undefined;
      const typeLabel = getProcedureTypeBadge(procedureType);
      return {
        name,
        typeLabel,
        note:
          (typeof item.notes === "string" && item.notes.trim()) ||
          (typeof item.reason === "string" && item.reason.trim()) ||
          (typeof item.clinical_context === "string" && item.clinical_context.trim()) ||
          "",
        date: cleanDateValue(item.date) || "N/A",
      };
    }),
  ].filter((item) => item.name.trim());

  if (procedureItems.length === 0) {
    addParagraph(null, 5);
  } else {
    procedureItems.forEach((item, index) => {
      checkY(24);
      doc.setFont("helvetica", "bold");
      doc.text(`${index + 1}. ${item.name} (${item.typeLabel})`, margin, y);
      y += 6;
      doc.setFont("helvetica", "normal");
      addParagraph(`Note: ${item.note?.trim() || "N/A"}`, 5);
      addParagraph(`Date: ${item.date?.trim() || "N/A"}`, 5);
      y += 3;
    });
  }

  // Follow-up
  addSubTitle("Follow-up Appointment");
  const followup = reportData.followup.follow_up_appointment;
  const followupText = (() => {
    if (!followup) return "";
    const when = cleanDateValue(followup.date) || cleanDateValue(followup.duration);
    const reason = followup.reason?.trim() || "";
    const instructions = followup.instructions?.trim() || "";
    const visitType = followup.visit_type?.trim() || "";

    const parts: string[] = [];
    if (when) parts.push(when);
    if (visitType) parts.push(visitType);
    if (reason) parts.push(reason);
    if (instructions) parts.push(`Instructions: ${instructions}`);

    return parts.join(" - ");
  })();
  addParagraph(followupText || null, 5);
  y += 5;

  // Referrals
  addSubTitle("Referrals");
  const referrals = (reportData.referrals as Array<Record<string, unknown>>).filter((item) => {
    const specialty =
      typeof item.specialty === "string"
        ? item.specialty
        : typeof item.specialist === "string"
          ? item.specialist
          : typeof item.name === "string"
            ? item.name
            : "";
    return specialty.trim().length > 0;
  });

  if (referrals.length === 0) {
    addParagraph(null, 5);
  } else {
    referrals.forEach((referral, index) => {
      const specialty =
        typeof referral.specialty === "string"
          ? referral.specialty
          : typeof referral.specialist === "string"
            ? referral.specialist
            : typeof referral.name === "string"
              ? referral.name
              : "N/A";
      checkY(30);
      doc.setFont("helvetica", "bold");
      doc.text(`${index + 1}. ${specialty}`, margin, y);
      y += 6;
      doc.setFont("helvetica", "normal");
      addParagraph(
        `Referred To: ${
          typeof referral.referred_to === "string" && referral.referred_to.trim()
            ? referral.referred_to
            : "N/A"
        }`,
        5
      );
      addParagraph(
        `Reason: ${
          typeof referral.reason === "string"
            ? referral.reason
            : typeof referral.clinical_context === "string"
              ? referral.clinical_context
              : "N/A"
        }`,
        5
      );
      addParagraph(
        `Urgency: ${formatReferralUrgency(
          typeof referral.urgency === "string"
            ? referral.urgency
            : typeof referral.type === "string"
              ? referral.type
              : "routine"
        )}`,
        5
      );
      addParagraph(
        `Notes: ${typeof referral.notes === "string" ? referral.notes : "N/A"}`,
        5
      );
      y += 3;
    });
  }

  // SOAP Notes
  addSectionTitle("SOAP Notes");

  const addSoapSubSection = (title: string, content: Record<string, string> | undefined) => {
    const normalizeLabel = (label: string) => label.replace(/_/g, " ").toLowerCase().trim();

    checkY(10);
    addSubTitle(title);
    if (content && Object.keys(content).length > 0) {
      const entries = Object.entries(content).filter(
        ([, value]) =>
          value && value.trim() !== "" && value !== "Not provided" && value !== "Not mentioned"
      );
      if (entries.length > 0) {
        entries.forEach(([key, value]) => {
          if (normalizeLabel(key) === normalizeLabel(title)) {
            addParagraph(value, 5);
            return;
          }

          const formattedKey = key.replace(/_/g, " ").replace(/\b\w/g, (l) => l.toUpperCase());
          addListItem(formattedKey, value);
        });
      } else {
        addParagraph(null, 5);
      }
    } else {
      addParagraph(null, 5);
    }
    y += 2;
  };

  addSoapSubSection("Subjective", reportData.soapNote.subjective);
  addSoapSubSection("Objective", reportData.soapNote.objective);
  addSoapSubSection("Assessment", reportData.soapNote.assessment);
  addSoapSubSection("Plan", reportData.soapNote.plan);
  y += 5;

  // Transcription
  addSectionTitle("Transcription");

  const addSpeakerLine = (speaker: string, text: string) => {
    if (!text.trim()) return;
    checkY(8);
    doc.setFont("helvetica", "bold");
    doc.text(`${speaker}:`, margin, y);
    doc.setFont("helvetica", "normal");
    const textX = margin + doc.getTextWidth(`${speaker}: `) + 1;
    const sanitizedText = sanitizeText(text) || text;
    const lines = doc.splitTextToSize(sanitizedText, pageWidth - margin - textX);
    checkY(lines.length * 5);
    doc.text(lines, textX, y);
    y += lines.length * 5 + 3;
  };

  const speakerLines = transcription
    .map((line) => {
      const doctorMatch = line.match(/^doctor\s*:\s*(.*)$/i);
      if (doctorMatch) {
        return { speaker: "Doctor", message: doctorMatch[1]?.trim() || "" };
      }

      const patientMatch = line.match(/^patient\s*:\s*(.*)$/i);
      if (patientMatch) {
        return { speaker: "Patient", message: patientMatch[1]?.trim() || "" };
      }

      return { speaker: "Doctor", message: line.trim() };
    })
    .filter((row) => row.message.length > 0);

  if (speakerLines.length === 0) {
    addParagraph(null);
  } else {
    speakerLines.forEach((row) => addSpeakerLine(row.speaker, row.message));
  }

  doc.save(`visit-report-${visitId || "draft"}.pdf`);
}
