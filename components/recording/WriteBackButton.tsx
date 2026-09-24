"use client";

import { useState } from "react";
import { Upload } from "lucide-react";
import { Dialog, DialogContent } from "@/components/ui/dialog";

/**
 * Placeholder for the eCW EHR write-back. For now it only opens a popup;
 * the actual eCW integration will be wired in here later.
 */
export function WriteBackButton({ className = "" }: { className?: string }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className={`text-brand-blue hover:text-white hover:bg-brand-blue border border-brand-blue rounded-full px-2.5 sm:px-3 md:px-4 text-xs sm:text-sm h-8 sm:h-9 flex items-center transition-colors ${className}`}
      >
        <Upload className="h-3 w-3 sm:h-4 sm:w-4 mr-0.5 sm:mr-1 md:mr-2" />
        <span className="hidden sm:inline">Write Back</span>
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          className="max-w-md p-6"
          showClose={false}
          hiddenTitle="Write back to eCW"
          hiddenDescription="Writing visit data back to the eCW EHR"
        >
          <h2 className="text-slate-700 text-lg font-medium">Writing Back to eCW</h2>
          <div className="py-4">
            <p className="text-slate-600 text-sm">
              The visit data is being written back to the eCW EHR.
            </p>
          </div>
          <div className="flex justify-end">
            <button
              onClick={() => setOpen(false)}
              className="bg-brand-blue hover:bg-brand-pink text-white rounded-md px-4 py-2 text-sm transition-colors"
            >
              OK
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
