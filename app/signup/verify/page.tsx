"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { formatAuthError, trimAuthInput } from "@/lib/auth/errors";
import {
  ensureIdentitySession,
  hasValidIdentitySession,
  identityApi,
} from "@/lib/auth/session";
import Image from "next/image";
import { AlertCircle } from "lucide-react";

export default function VerifySignupPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const email = searchParams.get("email") || "";

  useEffect(() => {
    let isMounted = true;

    const redirectAuthenticatedUser = async () => {
      try {
        const session = await ensureIdentitySession();
        if (!isMounted) {
          return;
        }

        if (hasValidIdentitySession(session)) {
          router.replace("/recording");
        }
      } catch {
        // No active session; allow access to verification.
      }
    };

    void redirectAuthenticatedUser();

    return () => {
      isMounted = false;
    };
  }, [router]);

  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [resent, setResent] = useState(false);

  const handleVerify = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    const trimmedCode = trimAuthInput(code);
    if (!trimmedCode) {
      setError("Please enter the verification code.");
      return;
    }

    if (!email) {
      setError("Missing email. Please go back and sign up again.");
      return;
    }

    setIsLoading(true);
    try {
      await identityApi("/api/identity/confirm", {
        email,
        code: trimmedCode,
      });
      router.push(`/login?email=${encodeURIComponent(email)}&signup=success`);
    } catch (err) {
      setError(formatAuthError(err, "Verification failed. Please try again."));
    } finally {
      setIsLoading(false);
    }
  };

  const handleResend = async () => {
    setError("");
    setResent(false);

    if (!email) {
      setError("Missing email. Please go back and sign up again.");
      return;
    }

    setIsLoading(true);
    try {
      // Platform does not expose a dedicated resend endpoint yet.
      // Re-calling signup is unsafe (duplicate user); guide the user instead.
      setError("Resend is not available yet. Check your inbox or spam folder for the original code.");
    } finally {
      setIsLoading(false);
    }
  };

  const handleChangeEmail = () => {
    router.push(`/signup?email=${encodeURIComponent(email)}`);
  };

  return (
    <div className="min-h-screen bg-white flex items-center justify-center p-4 overflow-hidden relative">
      <div className="absolute inset-0 -z-10 overflow-hidden">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_right,rgba(140,198,63,0.1),transparent_40%)]" />
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_bottom_left,rgba(229,100,159,0.1),transparent_40%)]" />
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(41,171,226,0.1),transparent_40%)]" />
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_bottom_right,rgba(247,148,29,0.1),transparent_40%)]" />
      </div>
      <div className="w-full max-w-md animate-fade-in-up">
        <div className="text-center mb-8">
          <Image
            src="https://hebbkx1anhila5yf.public.blob.vercel-storage.com/image-3iYmNCbNrAz3xweW1kCvDFAA44QRiG.png"
            alt="HIKIGAI AIScribe Logo"
            width={80}
            height={80}
            className="mx-auto"
            unoptimized
            priority
          />
          <h1 className="text-3xl font-bold bg-clip-text text-transparent bg-brand-gradient mt-4">
            Verify Your Email
          </h1>
          <p className="text-slate-600 mt-2">
            Enter the code sent to <span className="font-semibold">{email}</span>
          </p>
        </div>
        <div className="bg-white p-8 rounded-2xl shadow-[0_8px_30px_rgb(0,0,0,0.06)]">
          {error && (
            <div className="mb-4 p-3 bg-red-50 border border-red-200 text-red-600 rounded-lg flex items-center">
              <AlertCircle className="h-4 w-4 mr-2 shrink-0" />
              <span className="text-sm">{error}</span>
            </div>
          )}
          <form className="space-y-5" onSubmit={handleVerify}>
            <div className="space-y-2">
              <label className="text-sm font-medium text-slate-700">Verification Code</label>
              <input
                type="text"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                className="w-full p-3 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-1 focus:ring-brand-blue focus:border-brand-blue"
                placeholder="Enter code"
                autoFocus
              />
            </div>
            <button
              type="submit"
              className="w-full bg-brand-blue hover:bg-brand-pink text-white rounded-xl h-11 text-base flex items-center justify-center transition-colors"
              disabled={isLoading}
            >
              Verify & Continue
            </button>
          </form>
          <div className="flex justify-between items-center mt-4">
            <button
              type="button"
              className="text-brand-blue hover:underline text-sm"
              onClick={handleResend}
              disabled={isLoading}
            >
              Resend Code
            </button>
            <button
              type="button"
              className="text-slate-500 hover:underline text-sm"
              onClick={handleChangeEmail}
              disabled={isLoading}
            >
              Change Email
            </button>
          </div>
          {resent && <div className="text-green-600 text-xs mt-2">Code resent to your email.</div>}
        </div>
      </div>
    </div>
  );
}
