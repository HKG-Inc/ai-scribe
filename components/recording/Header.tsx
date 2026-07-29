"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import { Crown, QrCode, X, LogOut, Save, LockKeyhole, Info, Eye, EyeOff, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useAppDispatch, useAppSelector } from "@/store/hooks";
import {
  setShowUserSidebar,
  setShowQRCode,
  endVisit,
} from "@/store/slices/recordingSlice";
import { logout } from "@/store/slices/userSlice";
import { getInitials, getPersonNameError } from "@/lib/utils";
import { SPECIALTIES } from "@/lib/specialties";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { chargeVisitMinutesIfNeeded, syncMinutesLeft } from "@/lib/auth/minutes";
import {
  isInvalidResetCodeError,
  isValidPassword,
  PASSWORD_REQUIREMENTS_MSG,
} from "@/lib/auth/reset-password";
import { formatAuthError, trimAuthInput } from "@/lib/auth/errors";
import {
  clearIdentitySession,
  ensureIdentitySession,
  getIdentitySession,
  identityApi,
} from "@/lib/auth/session";
import {
  fetchEndUserProfile,
  mapEndUserToUserFields,
  updateEndUserProfile,
} from "@/lib/auth/profile";
import { updateProfile } from "@/store/slices/userSlice";

function InfoTooltip({ text }: { text: string }) {
  return (
    <div className="relative group inline-flex">
      <Info className="h-3 w-3 sm:h-4 sm:w-4 text-slate-400 cursor-help" />
      <div className="absolute left-0 top-full mt-1 z-50 hidden group-hover:block bg-slate-800 text-white text-xs rounded-md px-2 py-1 w-[225px] text-justify shadow-lg">
        {text}
      </div>
    </div>
  );
}

export function Header() {
  const dispatch = useAppDispatch();
  const router = useRouter();
  const user = useAppSelector((s) => s.user);
  const { visitId, showPremiumBanner, recordingTime, visitMinutesCharged } = useAppSelector(
    (s) => s.recording
  );
  const [isEndingVisit, setIsEndingVisit] = useState(false);

  const handleEndVisit = async () => {
    if (isEndingVisit) {
      return;
    }

    setIsEndingVisit(true);
    try {
      await chargeVisitMinutesIfNeeded(dispatch, recordingTime, visitMinutesCharged);
      dispatch(endVisit());
    } finally {
      setIsEndingVisit(false);
    }
  };

  const initials = getInitials(user.firstName || "U", user.lastName || "S");

  return (
    <header className="bg-white border-b border-slate-100 py-3 sm:py-4 px-4 sm:px-6 lg:px-8 flex justify-between items-center sticky top-0 z-10 shadow-sm">
      {/* Left: Logo + Name */}
      <div className="flex items-center gap-2 sm:gap-3 min-w-0">
        <Image
          src="https://hebbkx1anhila5yf.public.blob.vercel-storage.com/image-3iYmNCbNrAz3xweW1kCvDFAA44QRiG.png"
          alt="HIKIGAI AIScribe Logo"
          width={36}
          height={36}
          className="h-8 w-8 sm:h-9 sm:w-9 flex-shrink-0"
          unoptimized
        />
        <h1 className="text-lg sm:text-xl lg:text-2xl font-bold bg-clip-text text-transparent bg-brand-gradient truncate">
          HIKIGAI AIScribe
        </h1>
      </div>

      {/* Right: Action buttons */}
      <div className="flex items-center gap-2 sm:gap-3 lg:gap-4 flex-shrink-0">
        {showPremiumBanner && (
          <button
            onClick={() => router.push("/pricing")}
            className="flex text-white hover:bg-orange-500 bg-brand-orange border border-brand-orange rounded-full px-2 sm:px-4 text-xs sm:text-sm h-8 sm:h-9 items-center transition-colors"
          >
            <Crown className="h-3 w-3 sm:h-4 sm:w-4 sm:mr-2" />
            <span className="hidden md:inline">Get Premium</span>
            <span className="hidden sm:inline md:hidden">Premium</span>
          </button>
        )}

        {visitId && (
          <>
            <button
              onClick={() => dispatch(setShowQRCode(true))}
              className="hidden sm:flex text-brand-blue hover:text-white hover:bg-brand-blue border border-brand-blue rounded-full px-3 sm:px-4 text-xs sm:text-sm h-8 sm:h-9 items-center transition-colors"
            >
              <QrCode className="h-3 w-3 sm:h-4 sm:w-4 mr-1 sm:mr-2" />
              <span className="hidden md:inline">QR Code</span>
            </button>

            <button
              onClick={() => void handleEndVisit()}
              disabled={isEndingVisit}
              className="text-red-500 hover:text-white hover:bg-red-500 border border-red-200 rounded-full px-2.5 sm:px-3 md:px-4 text-xs sm:text-sm h-8 sm:h-9 flex items-center transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {isEndingVisit ? (
                <Loader2 className="h-3 w-3 sm:h-4 sm:w-4 animate-spin mr-0.5 sm:mr-1 md:mr-2" />
              ) : (
                <X className="h-3 w-3 sm:h-4 sm:w-4 mr-0.5 sm:mr-1 md:mr-2" />
              )}
              <span className="hidden sm:inline">End Visit</span>
            </button>
          </>
        )}

        {/* User Avatar */}
        <button
          onClick={() => dispatch(setShowUserSidebar(true))}
          className="rounded-full h-9 w-9 sm:h-10 sm:w-10 p-0 flex items-center justify-center"
        >
          <div className="h-8 w-8 sm:h-9 sm:w-9 rounded-full ring-2 ring-offset-2 ring-brand-blue bg-slate-100 flex items-center justify-center text-xs font-medium uppercase">
            {initials}
          </div>
        </button>
      </div>
    </header>
  );
}

export function UserProfileSidebar() {
  const dispatch = useAppDispatch();
  const router = useRouter();
  const user = useAppSelector((s) => s.user);
  const showSidebar = useAppSelector((s) => s.recording.showUserSidebar);
  const { recordingTime, visitMinutesCharged } = useAppSelector((s) => s.recording);

  const [firstName, setFirstName] = useState(user.firstName);
  const [lastName, setLastName] = useState(user.lastName);
  const [specialty, setSpecialty] = useState(user.speciality);
  const [firstNameError, setFirstNameError] = useState("");
  const [lastNameError, setLastNameError] = useState("");
  const [isSavingProfile, setIsSavingProfile] = useState(false);
  const [isLoadingProfile, setIsLoadingProfile] = useState(false);

  // Change password dialog
  const [changePasswordOpen, setChangePasswordOpen] = useState(false);
  const [oldPassword, setOldPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [resetCode, setResetCode] = useState("");
  const [resetNewPassword, setResetNewPassword] = useState("");
  const [resetConfirmPassword, setResetConfirmPassword] = useState("");
  const [showOldPw, setShowOldPw] = useState(false);
  const [showNewPw, setShowNewPw] = useState(false);
  const [showConfirmPw, setShowConfirmPw] = useState(false);
  const [showResetNewPw, setShowResetNewPw] = useState(false);
  const [showResetConfirmPw, setShowResetConfirmPw] = useState(false);
  const [pwError, setPwError] = useState("");
  const [pwSuccess, setPwSuccess] = useState("");
  const [isChangingPassword, setIsChangingPassword] = useState(false);
  const [isResettingPassword, setIsResettingPassword] = useState(false);
  const [forgotPasswordStep, setForgotPasswordStep] = useState<"idle" | "verify-code" | "new-password">("idle");

  const initials = getInitials(user.firstName || "U", user.lastName || "S");

  useEffect(() => {
    if (!showSidebar) {
      return;
    }

    setFirstName(user.firstName);
    setLastName(user.lastName);
    setSpecialty(user.speciality);
    setFirstNameError("");
    setLastNameError("");
    void syncMinutesLeft(dispatch);

    const loadProfile = async () => {
      const session = (await ensureIdentitySession()) || getIdentitySession();
      const userId = session?.userId?.trim();
      if (!userId) {
        return;
      }

      setIsLoadingProfile(true);
      try {
        const profile = await fetchEndUserProfile(userId);
        const fields = mapEndUserToUserFields(profile);
        dispatch(updateProfile(fields));
        setFirstName(fields.firstName);
        setLastName(fields.lastName);
        setSpecialty(fields.speciality);
      } catch (error) {
        toast.error(
          formatAuthError(error, "Could not refresh profile. You can still edit locally.")
        );
      } finally {
        setIsLoadingProfile(false);
      }
    };

    void loadProfile();
    // Refresh only when the sidebar opens; form fields are seeded from current Redux user.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showSidebar, dispatch]);

  const specialtyOptions: string[] = [...SPECIALTIES];
  if (specialty && !specialtyOptions.includes(specialty)) {
    specialtyOptions.unshift(specialty);
  }

  const handleSave = async () => {
    let hasError = false;

    const firstNameValidationError = getPersonNameError(firstName, "First name");
    if (firstNameValidationError) {
      setFirstNameError(firstNameValidationError);
      hasError = true;
    }
    const lastNameValidationError = getPersonNameError(lastName, "Last name");
    if (lastNameValidationError) {
      setLastNameError(lastNameValidationError);
      hasError = true;
    }
    if (!specialty) {
      toast.error("Please select a specialty");
      hasError = true;
    }
    if (hasError) return;

    try {
      setIsSavingProfile(true);
      const session = (await ensureIdentitySession()) || getIdentitySession();
      const userId = session?.userId?.trim();
      if (!userId) {
        toast.error("Your session is missing a user id. Please sign in again.");
        return;
      }

      const profile = await updateEndUserProfile(userId, {
        first_name: firstName.trim(),
        last_name: lastName.trim(),
        role: specialty,
      });

      const fields = mapEndUserToUserFields(profile);
      dispatch(updateProfile(fields));
      setFirstName(fields.firstName);
      setLastName(fields.lastName);
      setSpecialty(fields.speciality);
      toast.success("Profile updated successfully.");
    } catch (e) {
      toast.error(formatAuthError(e, "Failed to update profile"));
    } finally {
      setIsSavingProfile(false);
    }
  };

  const resetPasswordDialog = () => {
    setOldPassword("");
    setNewPassword("");
    setConfirmPassword("");
    setResetCode("");
    setResetNewPassword("");
    setResetConfirmPassword("");
    setShowOldPw(false);
    setShowNewPw(false);
    setShowConfirmPw(false);
    setShowResetNewPw(false);
    setShowResetConfirmPw(false);
    setForgotPasswordStep("idle");
    setPwError("");
    setPwSuccess("");
  };

  const isValidPasswordCheck = isValidPassword;

  const handleChangePassword = async () => {
    setPwSuccess("");
    setPwError("");
    const trimmedOldPassword = trimAuthInput(oldPassword);
    const trimmedNewPassword = trimAuthInput(newPassword);
    const trimmedConfirmPassword = trimAuthInput(confirmPassword);

    if (!trimmedOldPassword || !trimmedNewPassword || !trimmedConfirmPassword) {
      setPwError("All fields are required");
      return;
    }
    if (trimmedOldPassword === trimmedNewPassword) {
      setPwError("New password must be different from the current password");
      return;
    }
    if (!isValidPasswordCheck(trimmedNewPassword)) {
      setPwError(PASSWORD_REQUIREMENTS_MSG);
      return;
    }
    if (trimmedNewPassword !== trimmedConfirmPassword) {
      setPwError("Passwords do not match");
      return;
    }

    try {
      setIsChangingPassword(true);
      const session = (await ensureIdentitySession()) || getIdentitySession();
      if (!session?.accessToken) {
        setPwError("Your session has expired. Please sign in again.");
        return;
      }

      await identityApi<{ success: boolean; message: string }>("/api/identity/change-password", {
        access_token: session.accessToken,
        current_password: trimmedOldPassword,
        new_password: trimmedNewPassword,
      });

      setPwSuccess("Password changed successfully.");
      setTimeout(() => {
        setChangePasswordOpen(false);
        resetPasswordDialog();
      }, 800);
    } catch (e) {
      setPwError(formatAuthError(e, "Failed to change password"));
    } finally {
      setIsChangingPassword(false);
    }
  };

  const handleForgotPassword = async () => {
    setPwError("");
    setPwSuccess("");

    if (!user.email) {
      setPwError("No email is available for this account.");
      return;
    }

    try {
      setIsResettingPassword(true);
      await identityApi<{ success: boolean; message: string }>("/api/identity/forgot-password", {
        email: user.email,
      });

      setForgotPasswordStep("verify-code");
      setPwSuccess("If an account exists for this email, a password reset code has been sent.");
    } catch (e) {
      setPwError(formatAuthError(e, "Failed to start password reset"));
    } finally {
      setIsResettingPassword(false);
    }
  };

  const handleVerifyResetCode = async () => {
    setPwError("");
    setPwSuccess("");

    if (!user.email) {
      setPwError("No email is available for this account.");
      return;
    }

    const trimmedResetCode = trimAuthInput(resetCode);

    if (!trimmedResetCode) {
      setPwError("Please enter the reset code.");
      return;
    }

    setForgotPasswordStep("new-password");
    setPwSuccess("Enter a new password below to finish resetting.");
  };

  const handleConfirmForgotPassword = async () => {
    setPwError("");
    setPwSuccess("");

    if (!user.email) {
      setPwError("No email is available for this account.");
      return;
    }

    const trimmedResetCode = trimAuthInput(resetCode);
    const trimmedResetNewPassword = trimAuthInput(resetNewPassword);
    const trimmedResetConfirmPassword = trimAuthInput(resetConfirmPassword);

    if (!trimmedResetNewPassword || !trimmedResetConfirmPassword) {
      setPwError("All password fields are required");
      return;
    }

    if (!isValidPasswordCheck(trimmedResetNewPassword)) {
      setPwError(PASSWORD_REQUIREMENTS_MSG);
      return;
    }

    if (trimmedResetNewPassword !== trimmedResetConfirmPassword) {
      setPwError("Passwords do not match");
      return;
    }

    try {
      setIsResettingPassword(true);
      await identityApi<{ success: boolean; message: string }>("/api/identity/reset-password", {
        email: user.email,
        code: trimmedResetCode,
        new_password: trimmedResetNewPassword,
      });

      setPwSuccess("Password reset successfully. Use the new password the next time you sign in.");
      setTimeout(() => {
        setChangePasswordOpen(false);
        resetPasswordDialog();
      }, 800);
    } catch (e) {
      if (isInvalidResetCodeError(e)) {
        setForgotPasswordStep("verify-code");
        setPwError("Your reset code is no longer valid. Please enter the code again.");
        return;
      }
      setPwError(formatAuthError(e, "Failed to reset password"));
    } finally {
      setIsResettingPassword(false);
    }
  };

  const handleLogout = async () => {
    try {
      const session = getIdentitySession();
      const email = user.email || session?.email;
      if (email) {
        await identityApi("/api/identity/logout", { email });
      }
    } catch {
      // Continue local logout even if remote revoke fails.
    }
    clearIdentitySession();
    await chargeVisitMinutesIfNeeded(dispatch, recordingTime, visitMinutesCharged);
    dispatch(logout());
    dispatch(endVisit());
    router.push("/login");
  };

  if (!showSidebar) return null;

  return (
    <>
      {/* Overlay */}
      <div
        className="fixed inset-0 bg-black/20 z-40"
        onClick={() => dispatch(setShowUserSidebar(false))}
      />
      {/* Sidebar panel */}
      <div className="fixed right-0 top-0 bottom-0 w-full sm:w-[320px] md:w-[400px] border-l border-slate-100 bg-white flex flex-col z-50 shadow-xl">
        {/* Gradient header */}
        <div className="bg-gradient-to-r from-brand-pink to-brand-orange p-4 sm:p-6 text-white relative">
          <button
            type="button"
            onClick={() => dispatch(setShowUserSidebar(false))}
            className="absolute top-3 right-3 sm:top-4 sm:right-4 p-1.5 rounded-full hover:bg-white/20 transition-colors"
            aria-label="Close profile"
          >
            <X className="h-5 w-5" />
          </button>
          <div className="flex items-center gap-3 sm:gap-4 pr-8">
            <div className="h-12 w-12 sm:h-16 sm:w-16 rounded-full ring-4 ring-white/30 bg-white flex items-center justify-center text-black text-lg sm:text-2xl font-bold flex-shrink-0">
              {initials}
            </div>
            <div className="min-w-0">
              <h3 className="font-bold text-base sm:text-xl truncate">
                {user.firstName} {user.lastName}
              </h3>
              <p className="text-white/80 text-sm truncate">{user.speciality}</p>
            </div>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 p-4 sm:p-6 overflow-y-auto">
          <div className="space-y-3 flex flex-col gap-2">
            {/* First Name */}
            <div className="space-y-2 relative">
              <label className="text-xs sm:text-sm font-medium text-slate-700">First Name</label>
              <input
                type="text"
                value={firstName}
                onChange={(e) => {
                  setFirstName(e.target.value);
                  setFirstNameError("");
                }}
                disabled={isLoadingProfile || isSavingProfile}
                className={`w-full p-2 sm:p-3 border rounded-xl text-xs sm:text-sm focus:outline-none focus:ring-1 focus:ring-brand-blue focus:border-brand-blue disabled:opacity-60 ${firstNameError ? "border-red-500" : "border-slate-200"}`}
              />
              {firstNameError && <p className="text-red-500 text-xs">{firstNameError}</p>}
            </div>

            {/* Last Name */}
            <div className="space-y-2 relative">
              <label className="text-xs sm:text-sm font-medium text-slate-700">Last Name</label>
              <input
                type="text"
                value={lastName}
                onChange={(e) => {
                  setLastName(e.target.value);
                  setLastNameError("");
                }}
                disabled={isLoadingProfile || isSavingProfile}
                className={`w-full p-2 sm:p-3 border rounded-xl text-xs sm:text-sm focus:outline-none focus:ring-1 focus:ring-brand-blue focus:border-brand-blue disabled:opacity-60 ${lastNameError ? "border-red-500" : "border-slate-200"}`}
              />
              {lastNameError && <p className="text-red-500 text-xs">{lastNameError}</p>}
            </div>

            {/* Specialty / role */}
            <div className="space-y-2">
              <label className="text-xs sm:text-sm font-medium text-slate-700">Specialty</label>
              <Select
                value={specialty}
                onValueChange={(value) => {
                  setSpecialty(value);
                }}
                disabled={isLoadingProfile || isSavingProfile}
              >
                <SelectTrigger className="!h-10 sm:!h-12 text-xs sm:text-sm">
                  <SelectValue placeholder="Select specialty" />
                </SelectTrigger>
                <SelectContent>
                  {specialtyOptions.map((s) => (
                    <SelectItem key={s} value={s}>{s}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Email (disabled) */}
            <div className="space-y-2">
              <label className="text-xs sm:text-sm font-medium text-slate-700">Email</label>
              <input
                type="email"
                value={user.email}
                disabled
                className="w-full p-2 sm:p-3 border border-slate-200 rounded-xl text-xs sm:text-sm bg-slate-50 text-slate-400 cursor-not-allowed"
              />
            </div>

            {/* Save Changes */}
            <button
              onClick={() => void handleSave()}
              disabled={isSavingProfile || isLoadingProfile}
              className="w-full !mt-3 bg-brand-blue hover:bg-brand-pink text-white rounded-xl h-10 sm:h-11 text-sm sm:text-base flex items-center justify-center transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {isSavingProfile ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <Save className="h-4 w-4 mr-2" />
              )}
              {isSavingProfile ? "Saving..." : isLoadingProfile ? "Loading..." : "Save Changes"}
            </button>

            {/* Change Password */}
            <button
              onClick={() => setChangePasswordOpen(true)}
              className="w-full flex items-center justify-center space-x-2 rounded-xl h-10 sm:h-11 border border-slate-200 bg-transparent hover:bg-slate-100 text-black !mt-3 text-sm sm:text-base transition-colors"
            >
              <LockKeyhole className="h-4 w-4 mr-2" />
              Change Password
            </button>
          </div>
        </div>

        {/* Footer */}
        <div className="p-4 sm:p-6 border-t border-slate-100">
          <div className="text-xs text-slate-400 mb-3 text-center">
            Minutes Left –{" "}
            {Number.isInteger(user.totalMinutesLeft)
              ? user.totalMinutesLeft
              : user.totalMinutesLeft.toFixed(1)}
          </div>
          <button
            onClick={handleLogout}
            className="w-full flex items-center justify-center space-x-2 rounded-xl h-10 sm:h-11 border border-slate-200 text-sm sm:text-base hover:bg-slate-50 transition-colors"
          >
            <LogOut className="h-4 w-4 mr-2" />
            <span>Log Out</span>
          </button>
        </div>
      </div>

      {/* Change Password Dialog */}
      <Dialog
        open={changePasswordOpen}
        onOpenChange={(open) => {
          setChangePasswordOpen(open);
          if (!open) {
            resetPasswordDialog();
          }
        }}
      >
        <DialogContent
          className="w-11/12 sm:w-full max-w-[425px] p-6"
          hiddenTitle="Change password"
          hiddenDescription="Form to update account password"
        >
          <h2 className="text-slate-700 text-lg font-medium mb-4">Change Password</h2>
          {pwError && (
            <div className="bg-red-100 rounded-md p-2 border border-red-200 mb-2">
              <p className="text-xs text-black">{pwError}</p>
            </div>
          )}
          {pwSuccess && (
            <div className="bg-green-100 rounded-md p-2 border border-green-200 mb-2">
              <p className="text-xs text-green-900">{pwSuccess}</p>
            </div>
          )}
          <div className="space-y-3">
            {forgotPasswordStep === "idle" ? (
              <>
                <div>
                  <label className="text-xs sm:text-sm text-slate-700 block mb-1">Old Password</label>
                  <div className="relative">
                    <input
                      type={showOldPw ? "text" : "password"}
                      placeholder="••••••••"
                      autoComplete="new-password"
                      name="change-password-current"
                      data-lpignore="true"
                      value={oldPassword}
                      onChange={(e) => setOldPassword(e.target.value)}
                      className="w-full h-9 sm:h-10 rounded-md border border-slate-200 px-3 pr-10 text-xs sm:text-sm focus:outline-none focus:border-brand-blue"
                    />
                    <button
                      type="button"
                      onClick={() => setShowOldPw(!showOldPw)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400"
                      aria-label={showOldPw ? "Hide old password" : "Show old password"}
                    >
                      {showOldPw ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                </div>
                <div>
                  <label className="text-xs sm:text-sm font-medium text-slate-700 flex items-center gap-2 mb-1">
                    New Password
                    <InfoTooltip text="Password must be at least 8 characters and include lowercase, uppercase, number, and special character" />
                  </label>
                  <div className="relative">
                    <input
                      type={showNewPw ? "text" : "password"}
                      placeholder="••••••••"
                      autoComplete="new-password"
                      name="change-password-new"
                      data-lpignore="true"
                      value={newPassword}
                      onChange={(e) => setNewPassword(e.target.value)}
                      className="w-full h-9 sm:h-10 rounded-md border border-slate-200 px-3 pr-10 text-xs sm:text-sm focus:outline-none focus:border-brand-blue"
                    />
                    <button
                      type="button"
                      onClick={() => setShowNewPw(!showNewPw)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400"
                      aria-label={showNewPw ? "Hide new password" : "Show new password"}
                    >
                      {showNewPw ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                </div>
                <div>
                  <label className="text-xs sm:text-sm font-medium text-slate-700 block mb-1">
                    Confirm Password
                  </label>
                  <div className="relative">
                    <input
                      type={showConfirmPw ? "text" : "password"}
                      placeholder="••••••••"
                      autoComplete="new-password"
                      name="change-password-confirm"
                      data-lpignore="true"
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                      className="w-full h-9 sm:h-10 rounded-md border border-slate-200 px-3 pr-10 text-xs sm:text-sm focus:outline-none focus:border-brand-blue"
                    />
                    <button
                      type="button"
                      onClick={() => setShowConfirmPw(!showConfirmPw)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400"
                      aria-label={showConfirmPw ? "Hide confirm password" : "Show confirm password"}
                    >
                      {showConfirmPw ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                </div>
              </>
            ) : forgotPasswordStep === "verify-code" ? (
              <>
                <div className="rounded-md border border-blue-100 bg-blue-50 px-3 py-2 text-xs text-slate-700">
                  Enter the reset code sent to {user.email}.
                </div>
                <div>
                  <label className="text-xs sm:text-sm text-slate-700 block mb-1">Reset Code</label>
                  <input
                    type="text"
                    placeholder="Enter code"
                    value={resetCode}
                    onChange={(e) => setResetCode(e.target.value)}
                    className="w-full h-9 sm:h-10 rounded-md border border-slate-200 px-3 text-xs sm:text-sm focus:outline-none focus:border-brand-blue"
                  />
                </div>
              </>
            ) : (
              <>
                <div>
                  <label className="text-xs sm:text-sm font-medium text-slate-700 flex items-center gap-2 mb-1">
                    New Password
                    <InfoTooltip text="Password must be at least 8 characters and include lowercase, uppercase, number, and special character" />
                  </label>
                  <div className="relative">
                    <input
                      type={showResetNewPw ? "text" : "password"}
                      placeholder="••••••••"
                      autoComplete="new-password"
                      name="reset-password-new"
                      data-lpignore="true"
                      value={resetNewPassword}
                      onChange={(e) => setResetNewPassword(e.target.value)}
                      className="w-full h-9 sm:h-10 rounded-md border border-slate-200 px-3 pr-10 text-xs sm:text-sm focus:outline-none focus:border-brand-blue"
                    />
                    <button
                      type="button"
                      onClick={() => setShowResetNewPw(!showResetNewPw)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400"
                      aria-label={showResetNewPw ? "Hide new reset password" : "Show new reset password"}
                    >
                      {showResetNewPw ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                </div>
                <div>
                  <label className="text-xs sm:text-sm font-medium text-slate-700 block mb-1">
                    Confirm Password
                  </label>
                  <div className="relative">
                    <input
                      type={showResetConfirmPw ? "text" : "password"}
                      placeholder="••••••••"
                      autoComplete="new-password"
                      name="reset-password-confirm"
                      data-lpignore="true"
                      value={resetConfirmPassword}
                      onChange={(e) => setResetConfirmPassword(e.target.value)}
                      className="w-full h-9 sm:h-10 rounded-md border border-slate-200 px-3 pr-10 text-xs sm:text-sm focus:outline-none focus:border-brand-blue"
                    />
                    <button
                      type="button"
                      onClick={() => setShowResetConfirmPw(!showResetConfirmPw)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400"
                      aria-label={showResetConfirmPw ? "Hide confirm reset password" : "Show confirm reset password"}
                    >
                      {showResetConfirmPw ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
          <div className="flex gap-4 mt-6 flex-col sm:flex-row sm:items-center sm:justify-between">
            <button
              type="button"
              onClick={
                forgotPasswordStep === "idle"
                  ? handleForgotPassword
                  : forgotPasswordStep === "verify-code"
                    ? () => {
                        setForgotPasswordStep("idle");
                        setPwError("");
                        setPwSuccess("");
                        setResetCode("");
                      }
                    : () => {
                        setForgotPasswordStep("verify-code");
                        setPwError("");
                        setPwSuccess("");
                        setResetNewPassword("");
                        setResetConfirmPassword("");
                        setShowResetNewPw(false);
                        setShowResetConfirmPw(false);
                      }
              }
              className="text-left text-sm text-brand-blue hover:underline disabled:cursor-not-allowed disabled:opacity-60"
              disabled={isChangingPassword || isResettingPassword}
            >
              {forgotPasswordStep === "idle"
                ? "Forgot Password?"
                : forgotPasswordStep === "verify-code"
                  ? "Back To Change Password"
                  : "Back To Verify Code"}
            </button>
            <div className="flex gap-4 flex-col sm:flex-row justify-end">
            <button
              onClick={() => {
                setChangePasswordOpen(false);
                resetPasswordDialog();
              }}
              className="rounded-md border border-slate-200 px-4 py-2 text-sm sm:text-base hover:bg-slate-50"
              disabled={isChangingPassword || isResettingPassword}
            >
              Cancel
            </button>
            <button
              onClick={
                forgotPasswordStep === "idle"
                  ? handleChangePassword
                  : forgotPasswordStep === "verify-code"
                    ? handleVerifyResetCode
                    : handleConfirmForgotPassword
              }
              className="bg-brand-blue hover:bg-brand-pink text-white rounded-md px-4 py-2 text-sm sm:text-base transition-colors"
              disabled={isChangingPassword || isResettingPassword}
            >
              {isChangingPassword || isResettingPassword
                ? forgotPasswordStep === "idle"
                  ? "Updating..."
                  : forgotPasswordStep === "verify-code"
                    ? "Verifying..."
                    : "Submitting..."
                : forgotPasswordStep === "idle"
                  ? "Confirm"
                  : forgotPasswordStep === "verify-code"
                    ? "Verify Code"
                    : "Reset Password"}
            </button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
