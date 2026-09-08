"use client";

import {
  classifyVisitNotesLine,
  splitMajorHeader,
} from "@/lib/visit-notes-display";

interface VisitNotesFormattedProps {
  text: string;
  className?: string;
}

/**
 * Renders Visit Summary text in the clinical A–E screenshot format:
 * bold major headers / anatomy region headers, left-aligned full-width rows.
 */
export function VisitNotesFormatted({
  text,
  className = "",
}: VisitNotesFormattedProps) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");

  return (
    <div
      className={`text-left text-sm text-slate-700 leading-relaxed overflow-y-auto flex-1 min-h-0 pr-4 ${className}`}
    >
      {lines.map((line, index) => {
        const kind = classifyVisitNotesLine(line);
        const key = `vn-${index}`;

        if (kind === "blank") {
          return <div key={key} className="h-3" aria-hidden />;
        }

        if (kind === "major") {
          const split = splitMajorHeader(line);
          if (!split) {
            return (
              <p key={key} className="font-semibold text-slate-900 mt-3 first:mt-0">
                {line}
              </p>
            );
          }
          return (
            <p key={key} className="mt-3 first:mt-0">
              <span className="font-semibold text-slate-900">{split.label}</span>
              {split.rest ? (
                <>
                  {" "}
                  <span className="font-normal text-slate-700">{split.rest}</span>
                </>
              ) : null}
            </p>
          );
        }

        if (kind === "subheader") {
          return (
            <p key={key} className="font-semibold text-slate-900 mt-2">
              {line.trim()}
            </p>
          );
        }

        return (
          <p key={key} className="text-slate-700 whitespace-pre-wrap">
            {line}
          </p>
        );
      })}
    </div>
  );
}
