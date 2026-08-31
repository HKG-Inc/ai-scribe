"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Image from "next/image";
import Link from "next/link";
import { Mail, Lock, Eye, EyeOff, AlertCircle } from "lucide-react";
import { useAppDispatch } from "@/store/hooks";
import { setUser, setLoggedIn } from "@/store/slices/userSlice";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import {
  DEFAULT_SUBSCRIPTION_MINUTES,
  MINUTES_LEFT_ATTRIBUTE,
  parseMinutesLeft,
  syncMinutesLeft,
} from "@/lib/auth/minutes";
import {
  consumePendingSignupProfile,
  decodeIdToken,
  ensureIdentitySession,
  hasValidIdentitySession,
  identityApi,
  sessionFromLoginResponse,
  setIdentitySession,
} from "@/lib/auth/session";
import {
  isInvalidResetCodeError,
  isValidPassword,
  PASSWORD_REQUIREMENTS_MSG,
} from "@/lib/auth/reset-password";
import { formatAuthError, trimAuthInput } from "@/lib/auth/errors";
import { syncEndUserProfile } from "@/lib/auth/profile";

export default function LoginPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const dispatch = useAppDispatch();

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
        // No active session; allow access to login.
      }
    };

    void redirectAuthenticatedUser();

    return () => {
      isMounted = false;
    };
  }, [router]);

  const [email, setEmail] = useState(() => searchParams.get("email") ?? "");
  const signupSuccess = searchParams.get("signup") === "success";
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(false);

  // Forgot password dialog
  const [forgotOpen, setForgotOpen] = useState(false);
  const [forgotStep, setForgotStep] = useState<"email" | "verify-code" | "new-password">("email");
  const [forgotEmail, setForgotEmail] = useState("");
  const [resetCode, setResetCode] = useState("");
  const [resetNewPassword, setResetNewPassword] = useState("");
  const [resetConfirmPassword, setResetConfirmPassword] = useState("");
  const [showResetNewPw, setShowResetNewPw] = useState(false);
  const [showResetConfirmPw, setShowResetConfirmPw] = useState(false);
  const [forgotMsg, setForgotMsg] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [forgotLoading, setForgotLoading] = useState(false);

  const resetForgotDialog = () => {
    setForgotStep("email");
    setForgotEmail("");
    setResetCode("");
    setResetNewPassword("");
    setResetConfirmPassword("");
    setShowResetNewPw(false);
    setShowResetConfirmPw(false);
    setForgotMsg(null);
  };

  const isValidPasswordCheck = isValidPassword;

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    const trimmedEmail = trimAuthInput(email);
    const trimmedPassword = trimAuthInput(password);

    if (!trimmedEmail || !trimmedPassword) {
      setError("Please fill in all fields.");
      return;
    }

    setIsLoading(true);
    try {
      const result = await identityApi<{
        status: string;
        challenge_name?: string;
        id_token?: string;
        access_token?: string;
        refresh_token?: string;
        expires_in?: number;
        token_type?: string;
        user_sub?: string;
        user_id?: string;
      }>("/api/identity/login", {
        email: trimmedEmail,
        password: trimmedPassword,
      });

      if (result.status === "challenge" || result.challenge_name) {
        setError("Additional authentication is required. MFA support is coming soon.");
        setIsLoading(false);
        return;
      }

      if (
        result.status !== "authenticated" ||
        !result.id_token ||
        !result.access_token ||
        !result.refresh_token ||
        !result.expires_in
      ) {
        setError("Sign in failed. Please try again.");
        setIsLoading(false);
        return;
      }

      const session = sessionFromLoginResponse(
        {
          id_token: result.id_token,
          access_token: result.access_token,
          refresh_token: result.refresh_token,
          expires_in: result.expires_in,
          token_type: result.token_type || "Bearer",
          user_sub: result.user_sub,
          user_id: result.user_id,
        },
        trimmedEmail
      );
      setIdentitySession(session);

      const claims = decodeIdToken(result.id_token);
      const pending = consumePendingSignupProfile();
      const firstName =
        claims?.given_name ??
        claims?.name?.split(" ")[0] ??
        pending?.firstName ??
        "";
      const lastName =
        claims?.family_name ??
        claims?.name?.split(" ").slice(1).join(" ") ??
        pending?.lastName ??
        "";

      dispatch(
        setUser({
          firstName,
          lastName,
          email: claims?.email ?? trimmedEmail,
          speciality:
            (claims?.role as string | undefined) ??
            (claims?.["custom:role"] as string | undefined) ??
            (claims?.["custom:specialty"] as string | undefined) ??
            pending?.speciality ??
            "",
          clinicName:
            (claims?.["custom:clinic_name"] as string | undefined) ??
            pending?.clinicName ??
            "",
          phone:
            (claims?.["custom:phone"] as string | undefined) ??
            (claims?.phone_number as string | undefined) ??
            pending?.phone ??
            "",
          totalMinutesLeft: parseMinutesLeft(
            claims?.[MINUTES_LEFT_ATTRIBUTE] as string | undefined
          ),
          totalMinutesAllowed: DEFAULT_SUBSCRIPTION_MINUTES,
        })
      );
      dispatch(setLoggedIn(true));
      void syncMinutesLeft(dispatch);
      void syncEndUserProfile(dispatch).catch(() => {
        // Keep claim/pending profile if platform profile sync fails.
      });
      router.push("/recording");
    } catch (error) {
      setError(formatAuthError(error, "Sign in failed. Please try again."));
    } finally {
      setIsLoading(false);
    }
  };

  const handleSendResetCode = async (e: React.FormEvent) => {
    e.preventDefault();
    setForgotMsg(null);

    const trimmedForgotEmail = trimAuthInput(forgotEmail);

    if (!trimmedForgotEmail) {
      setForgotMsg({ type: "error", text: "Please enter your email address." });
      return;
    }

    setForgotLoading(true);
    try {
      await identityApi<{ success: boolean; message: string }>("/api/identity/forgot-password", {
        email: trimmedForgotEmail,
      });

      setForgotStep("verify-code");
      setForgotMsg({
        type: "success",
        text: "If an account exists for this email, a password reset code has been sent.",
      });
    } catch (error) {
      setForgotMsg({
        type: "error",
        text: formatAuthError(error, "Password reset failed. Please try again."),
      });
    } finally {
      setForgotLoading(false);
    }
  };

  const handleVerifyResetCode = async (e: React.FormEvent) => {
    e.preventDefault();
    setForgotMsg(null);

    const trimmedResetCode = trimAuthInput(resetCode);

    if (!trimmedResetCode) {
      setForgotMsg({ type: "error", text: "Please enter the reset code." });
      return;
    }

    setForgotStep("new-password");
    setForgotMsg({
      type: "success",
      text: "Enter a new password below to finish resetting.",
    });
  };

  const handleConfirmResetPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setForgotMsg(null);

    const trimmedResetCode = trimAuthInput(resetCode);
    const trimmedNewPassword = trimAuthInput(resetNewPassword);
    const trimmedConfirmPassword = trimAuthInput(resetConfirmPassword);
    const trimmedForgotEmail = trimAuthInput(forgotEmail);

    if (!trimmedNewPassword || !trimmedConfirmPassword) {
      setForgotMsg({ type: "error", text: "All password fields are required." });
      return;
    }

    if (!isValidPasswordCheck(trimmedNewPassword)) {
      setForgotMsg({
        type: "error",
        text: PASSWORD_REQUIREMENTS_MSG,
      });
      return;
    }

    if (trimmedNewPassword !== trimmedConfirmPassword) {
      setForgotMsg({ type: "error", text: "Passwords do not match." });
      return;
    }

    setForgotLoading(true);
    try {
      await identityApi<{ success: boolean; message: string }>("/api/identity/reset-password", {
        email: trimmedForgotEmail,
        code: trimmedResetCode,
        new_password: trimmedNewPassword,
      });

      setForgotMsg({ type: "success", text: "Your password has been updated. You can sign in now." });
      setTimeout(() => {
        setForgotOpen(false);
        resetForgotDialog();
      }, 1200);
    } catch (error) {
      if (isInvalidResetCodeError(error)) {
        setForgotStep("verify-code");
        setForgotMsg({
          type: "error",
          text: "Your reset code is no longer valid. Please enter the code again.",
        });
        return;
      }
      setForgotMsg({
        type: "error",
        text: formatAuthError(error, "Password reset failed. Please try again."),
      });
    } finally {
      setForgotLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-white flex items-center justify-center p-4 overflow-hidden relative">
      {/* Radial gradient background */}
      <div className="absolute inset-0 -z-10 overflow-hidden">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_right,rgba(140,198,63,0.1),transparent_40%)]" />
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_bottom_left,rgba(229,100,159,0.1),transparent_40%)]" />
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(41,171,226,0.1),transparent_40%)]" />
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_bottom_right,rgba(247,148,29,0.1),transparent_40%)]" />
      </div>

      <div className="w-full max-w-md animate-fade-in-up">
        {/* Header */}
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
            Welcome
          </h1>
          <p className="text-slate-600 mt-2">Sign in to HIKIGAI AIScribe</p>
        </div>

        {/* Form card */}
        <div className="bg-white p-8 rounded-2xl shadow-[0_8px_30px_rgb(0,0,0,0.06)]">
          {/* Error banner */}
          {error && (
            <div className="mb-4 p-3 bg-red-50 border border-red-200 text-red-600 rounded-lg flex items-center">
              <AlertCircle className="h-4 w-4 mr-2 shrink-0" />
              <span className="text-sm">{error}</span>
            </div>
          )}

          {signupSuccess && !error && (
            <div className="mb-4 p-3 bg-green-50 border border-green-200 text-green-700 rounded-lg text-sm">
              Account created successfully. Sign in with your new credentials.
            </div>
          )}

          <form className="space-y-5" onSubmit={handleLogin}>
            {/* Email */}
            <div className="space-y-2">
              <label className="text-sm font-medium text-slate-700">Email</label>
              <div className="relative">
                <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
                <input
                  type="email"
                  placeholder="name@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="pl-10 h-12 rounded-xl border border-slate-200 w-full text-sm placeholder:text-slate-400 focus:outline-none focus:border-brand-blue focus:ring-1 focus:ring-brand-blue"
                />
              </div>
            </div>

            {/* Password */}
            <div className="space-y-2">
              <div className="flex justify-between items-center">
                <label className="text-sm font-medium text-slate-700">Password</label>
                <button
                  type="button"
                  onClick={() => {
                    resetForgotDialog();
                    setForgotOpen(true);
                  }}
                  className="text-sm text-[#0066b3] hover:text-[#b83280] transition-colors"
                >
                  Forgot password?
                </button>
              </div>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
                <input
                  type={showPassword ? "text" : "password"}
                  placeholder="••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="pl-10 pr-10 h-12 rounded-xl border border-slate-200 w-full text-sm placeholder:text-slate-400 focus:outline-none focus:border-brand-blue focus:ring-1 focus:ring-brand-blue"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                >
                  {showPassword ? (
                    <EyeOff className="h-4 w-4" />
                  ) : (
                    <Eye className="h-4 w-4" />
                  )}
                </button>
              </div>
            </div>

            {/* CTA button */}
            <div className="pt-2">
              <div className="relative group">
                <div className="absolute -inset-0.5 bg-brand-gradient rounded-xl blur opacity-50 group-hover:opacity-100 transition duration-1000 group-hover:duration-200" />
                <button
                  type="submit"
                  disabled={isLoading}
                  className="relative w-full h-12 bg-white text-slate-800 hover:text-white hover:bg-brand-blue rounded-xl text-base font-medium transition-all duration-300 border-none flex items-center justify-center"
                >
                  {isLoading && (
                    <div className="mr-2 h-4 w-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
                  )}
                  Sign In
                </button>
              </div>
            </div>
          </form>

          <div className="mt-8 text-center">
            <span className="text-slate-600">Don&apos;t have an account? </span>
            <Link
              href="/signup"
              className="text-brand-pink hover:text-brand-orange transition-colors font-medium"
            >
              Sign Up
            </Link>
          </div>

          <div className="mt-8 pt-6 border-t border-slate-100">
            <div className="flex justify-center space-x-4">
              <a
                className="p-2 rounded-full bg-slate-50 hover:bg-slate-100 transition-colors cursor-pointer"
                target="_blank"
                rel="noopener noreferrer"
                href="https://www.facebook.com/profile.php?id=61555402344945"
                aria-label="Facebook"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="text-slate-600"
                >
                  <path d="M18 2h-3a5 5 0 0 0-5 5v3H7v4h3v8h4v-8h3l1-4h-4V7a1 1 0 0 1 1-1h3z"></path>
                </svg>
              </a>
              <a
                className="p-2 rounded-full bg-slate-50 hover:bg-slate-100 transition-colors cursor-pointer"
                target="_blank"
                rel="noopener noreferrer"
                href="https://x.com/HikigaiInc"
                aria-label="X (Twitter)"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="text-slate-600"
                >
                  <path d="M22 4s-.7 2.1-2 3.4c1.6 10-9.4 17.3-18 11.6 2.2.1 4.4-.6 6-2C3 15.5.5 9.6 3 5c2.2 2.6 5.6 4.1 9 4-.9-4.2 4-6.6 7-3.8 1.1 0 3-1.2 3-1.2z"></path>
                </svg>
              </a>
              <a
                className="p-2 rounded-full bg-slate-50 hover:bg-slate-100 transition-colors cursor-pointer"
                target="_blank"
                rel="noopener noreferrer"
                href="https://www.linkedin.com/company/hikigai/"
                aria-label="LinkedIn"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="text-slate-600"
                >
                  <path d="M16 8a6 6 0 0 1 6 6v7h-4v-7a2 2 0 0 0-2-2 2 2 0 0 0-2 2v7h-4v-7a6 6 0 0 1 6-6z"></path>
                  <rect x="2" y="9" width="4" height="12"></rect>
                  <circle cx="4" cy="4" r="2"></circle>
                </svg>
              </a>
            </div>
          </div>
        </div>
      </div>

      {/* Forgot Password Dialog */}
      <Dialog
        open={forgotOpen}
        onOpenChange={(open) => {
          setForgotOpen(open);
          if (!open) {
            resetForgotDialog();
          }
        }}
      >
        <DialogContent
          className="w-11/12 sm:w-full max-w-[425px] p-6"
          hiddenTitle="Forgot password"
          hiddenDescription="Send a password reset code to the entered email address"
        >
          <h2 className="text-slate-700 text-lg font-medium mb-1">Forgot Password</h2>
          {forgotStep === "email" ? (
            <>
              <p className="text-slate-500 text-sm mb-4">
                Enter your email address below and we&apos;ll send you a reset code to change your password.
              </p>
              <form onSubmit={handleSendResetCode}>
                <div className="space-y-4 pb-6">
                  <label className="text-sm text-slate-700 block">Email</label>
                  <input
                    type="email"
                    placeholder="name@example.com"
                    value={forgotEmail}
                    onChange={(e) => setForgotEmail(e.target.value)}
                    className="w-full h-10 rounded-md border border-slate-200 px-3 mt-2 text-sm focus:outline-none focus:border-brand-blue focus:ring-1 focus:ring-brand-blue"
                  />
                  {forgotMsg && (
                    <div
                      className={`text-sm p-2 rounded-md ${
                        forgotMsg.type === "success"
                          ? "bg-green-50 text-green-700"
                          : "bg-red-50 text-red-600"
                      }`}
                    >
                      {forgotMsg.text}
                    </div>
                  )}
                </div>
                <div className="flex gap-4 justify-end">
                  <button
                    type="button"
                    onClick={() => setForgotOpen(false)}
                    className="rounded-md border border-slate-200 px-4 py-2 text-sm hover:bg-slate-50 transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={forgotLoading}
                    className="bg-brand-blue hover:bg-brand-pink text-white rounded-md px-4 py-2 text-sm transition-colors flex items-center"
                  >
                    {forgotLoading && (
                      <div className="mr-2 h-3 w-3 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    )}
                    Send Reset Code
                  </button>
                </div>
              </form>
            </>
          ) : forgotStep === "verify-code" ? (
            <>
              <p className="text-slate-500 text-sm mb-4">
                Enter the reset code sent to <span className="font-medium text-slate-700">{forgotEmail}</span>.
              </p>
              <form onSubmit={handleVerifyResetCode}>
                <div className="space-y-4 pb-6">
                  <div>
                    <label className="text-sm text-slate-700 block mb-2">Reset Code</label>
                    <input
                      type="text"
                      placeholder="Enter code"
                      value={resetCode}
                      onChange={(e) => setResetCode(e.target.value)}
                      className="w-full h-10 rounded-md border border-slate-200 px-3 text-sm focus:outline-none focus:border-brand-blue focus:ring-1 focus:ring-brand-blue"
                    />
                  </div>
                  {forgotMsg && (
                    <div
                      className={`text-sm p-2 rounded-md ${
                        forgotMsg.type === "success"
                          ? "bg-green-50 text-green-700"
                          : "bg-red-50 text-red-600"
                      }`}
                    >
                      {forgotMsg.text}
                    </div>
                  )}
                </div>
                <div className="flex gap-4 justify-between items-center">
                  <button
                    type="button"
                    onClick={() => {
                      setForgotStep("email");
                      setForgotMsg(null);
                      setResetCode("");
                    }}
                    className="text-sm text-brand-blue hover:underline"
                    disabled={forgotLoading}
                  >
                    Back
                  </button>
                  <div className="flex gap-4">
                    <button
                      type="button"
                      onClick={() => setForgotOpen(false)}
                      className="rounded-md border border-slate-200 px-4 py-2 text-sm hover:bg-slate-50 transition-colors"
                      disabled={forgotLoading}
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      disabled={forgotLoading}
                      className="bg-brand-blue hover:bg-brand-pink text-white rounded-md px-4 py-2 text-sm transition-colors flex items-center"
                    >
                      {forgotLoading && (
                        <div className="mr-2 h-3 w-3 border-2 border-white border-t-transparent rounded-full animate-spin" />
                      )}
                      Verify Code
                    </button>
                  </div>
                </div>
              </form>
            </>
          ) : (
            <>
              <p className="text-slate-500 text-sm mb-4">
                Code verified. Set a new password for <span className="font-medium text-slate-700">{forgotEmail}</span>.
              </p>
              <form onSubmit={handleConfirmResetPassword}>
                <div className="space-y-4 pb-6">
                  <div>
                    <label className="text-sm text-slate-700 block mb-2">New Password</label>
                    <div className="relative">
                      <input
                        type={showResetNewPw ? "text" : "password"}
                        placeholder="••••••••"
                        value={resetNewPassword}
                        onChange={(e) => setResetNewPassword(e.target.value)}
                        className="w-full h-10 rounded-md border border-slate-200 px-3 pr-10 text-sm focus:outline-none focus:border-brand-blue focus:ring-1 focus:ring-brand-blue"
                      />
                      <button
                        type="button"
                        onClick={() => setShowResetNewPw(!showResetNewPw)}
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                        aria-label={showResetNewPw ? "Hide new password" : "Show new password"}
                      >
                        {showResetNewPw ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                      </button>
                    </div>
                  </div>
                  <div>
                    <label className="text-sm text-slate-700 block mb-2">Confirm Password</label>
                    <div className="relative">
                      <input
                        type={showResetConfirmPw ? "text" : "password"}
                        placeholder="••••••••"
                        value={resetConfirmPassword}
                        onChange={(e) => setResetConfirmPassword(e.target.value)}
                        className="w-full h-10 rounded-md border border-slate-200 px-3 pr-10 text-sm focus:outline-none focus:border-brand-blue focus:ring-1 focus:ring-brand-blue"
                      />
                      <button
                        type="button"
                        onClick={() => setShowResetConfirmPw(!showResetConfirmPw)}
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                        aria-label={showResetConfirmPw ? "Hide confirm password" : "Show confirm password"}
                      >
                        {showResetConfirmPw ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                      </button>
                    </div>
                  </div>
                  {forgotMsg && (
                    <div
                      className={`text-sm p-2 rounded-md ${
                        forgotMsg.type === "success"
                          ? "bg-green-50 text-green-700"
                          : "bg-red-50 text-red-600"
                      }`}
                    >
                      {forgotMsg.text}
                    </div>
                  )}
                </div>
                <div className="flex gap-4 justify-between items-center">
                  <button
                    type="button"
                    onClick={() => {
                      setForgotStep("verify-code");
                      setForgotMsg(null);
                      setResetNewPassword("");
                      setResetConfirmPassword("");
                      setShowResetNewPw(false);
                      setShowResetConfirmPw(false);
                    }}
                    className="text-sm text-brand-blue hover:underline"
                    disabled={forgotLoading}
                  >
                    Back
                  </button>
                  <div className="flex gap-4">
                    <button
                      type="button"
                      onClick={() => setForgotOpen(false)}
                      className="rounded-md border border-slate-200 px-4 py-2 text-sm hover:bg-slate-50 transition-colors"
                      disabled={forgotLoading}
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      disabled={forgotLoading}
                      className="bg-brand-blue hover:bg-brand-pink text-white rounded-md px-4 py-2 text-sm transition-colors flex items-center"
                    >
                      {forgotLoading && (
                        <div className="mr-2 h-3 w-3 border-2 border-white border-t-transparent rounded-full animate-spin" />
                      )}
                      Reset Password
                    </button>
                  </div>
                </div>
              </form>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
