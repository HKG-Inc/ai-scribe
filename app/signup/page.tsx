"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import Link from "next/link";
import {
  User,
  Mail,
  Phone,
  Lock,
  Eye,
  EyeOff,
  Building2,
  Stethoscope,
  Info,
} from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { formatAuthError, trimAuthInput } from "@/lib/auth/errors";
import { getPersonNameError } from "@/lib/utils";
import {
  mapEndUserToUserFields,
  syncEndUserProfile,
  updateEndUserProfile,
} from "@/lib/auth/profile";
import {
  DEFAULT_SUBSCRIPTION_MINUTES,
  MINUTES_LEFT_ATTRIBUTE,
  parseMinutesLeft,
  syncMinutesLeft,
} from "@/lib/auth/minutes";
import { SPECIALTIES } from "@/lib/specialties";
import { useAppDispatch } from "@/store/hooks";
import { setLoggedIn, setUser } from "@/store/slices/userSlice";
import {
  consumePendingSignupProfile,
  decodeIdToken,
  ensureIdentitySession,
  hasValidIdentitySession,
  identityApi,
  savePendingSignupProfile,
  sessionFromLoginResponse,
  setIdentitySession,
} from "@/lib/auth/session";

const COUNTRY_CODES = [
  { code: "+1", country: "US/CA" },
  { code: "+44", country: "UK" },
  { code: "+91", country: "IN" },
  { code: "+61", country: "AU" },
  { code: "+49", country: "DE" },
];

interface FormData {
  firstName: string;
  lastName: string;
  email: string;
  countryCode: string;
  phone: string;
  specialty: string;
  clinicName: string;
  password: string;
  confirmPassword: string;
}

interface FormErrors {
  [key: string]: string;
}

function InfoTooltip({ text }: { text: string }) {
  return (
    <div className="relative group inline-flex">
      <Info className="h-4 w-4 text-slate-400 cursor-help" />
      <div className="absolute left-0 top-full mt-1 z-50 hidden group-hover:block bg-slate-800 text-white text-xs rounded-md px-2 py-1 w-[225px] text-justify shadow-lg">
        {text}
      </div>
    </div>
  );
}

export default function SignupPage() {
  const router = useRouter();
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
        // No active session; allow access to signup.
      }
    };

    void redirectAuthenticatedUser();

    return () => {
      isMounted = false;
    };
  }, [router]);

  const [isLoading, setIsLoading] = useState(false);
  const [serverError, setServerError] = useState("");
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);

  const [form, setForm] = useState<FormData>({
    firstName: "",
    lastName: "",
    email: "",
    countryCode: "+1",
    phone: "",
    specialty: "",
    clinicName: "",
    password: "",
    confirmPassword: "",
  });

  const [errors, setErrors] = useState<FormErrors>({});

  const validate = (data: FormData): boolean => {
    const newErrors: FormErrors = {};
    const password = trimAuthInput(data.password);
    const confirmPassword = trimAuthInput(data.confirmPassword);

    const firstNameError = getPersonNameError(data.firstName, "First name");
    if (firstNameError) {
      newErrors.firstName = firstNameError;
    }
    const lastNameError = getPersonNameError(data.lastName, "Last name");
    if (lastNameError) {
      newErrors.lastName = lastNameError;
    }
    if (!data.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) {
      newErrors.email = "Valid email is required";
    }
    if (!data.phone || !/^\d+$/.test(data.phone)) {
      newErrors.phone = "Valid phone number is required";
    }
    if (!data.specialty) {
      newErrors.specialty = "Please select a specialty";
    }
    if (!data.clinicName || data.clinicName.length < 2) {
      newErrors.clinicName = "Clinic name must be at least 2 characters";
    }
    if (
      !password ||
      password.length < 8 ||
      !/[a-z]/.test(password) ||
      !/[A-Z]/.test(password) ||
      !/[0-9]/.test(password) ||
      !/[^a-zA-Z0-9]/.test(password)
    ) {
      newErrors.password =
        "Password must be 8+ chars with lowercase, uppercase, number, and special character";
    }
    if (password !== confirmPassword) {
      newErrors.confirmPassword = "Passwords do not match";
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setServerError("");
    const trimmedForm = {
      ...form,
      email: trimAuthInput(form.email),
      password: trimAuthInput(form.password),
      confirmPassword: trimAuthInput(form.confirmPassword),
    };

    if (!validate(trimmedForm)) return;

    setIsLoading(true);

    try {
      const phoneNumber = trimmedForm.phone ? `${trimmedForm.countryCode}${trimmedForm.phone}` : "";
      const result = await identityApi<{
        user_sub: string | null;
        user_id: string;
        email: string;
        confirmed: boolean;
      }>("/api/identity/signup", {
        email: trimmedForm.email,
        password: trimmedForm.password,
        first_name: trimmedForm.firstName,
        last_name: trimmedForm.lastName,
        attributes: {
          role: trimmedForm.specialty,
        },
      });

      savePendingSignupProfile({
        firstName: trimmedForm.firstName,
        lastName: trimmedForm.lastName,
        email: trimmedForm.email,
        phone: phoneNumber,
        speciality: trimmedForm.specialty,
        clinicName: trimmedForm.clinicName,
      });

      if (!result.confirmed) {
        router.push(`/signup/verify?email=${encodeURIComponent(trimmedForm.email)}`);
        return;
      }

      const loginResult = await identityApi<{
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
        email: trimmedForm.email,
        password: trimmedForm.password,
      });

      if (loginResult.status === "challenge" || loginResult.challenge_name) {
        router.push(`/login?email=${encodeURIComponent(trimmedForm.email)}`);
        return;
      }

      if (
        loginResult.status !== "authenticated" ||
        !loginResult.id_token ||
        !loginResult.access_token ||
        !loginResult.refresh_token ||
        !loginResult.expires_in
      ) {
        router.push(`/login?email=${encodeURIComponent(trimmedForm.email)}`);
        return;
      }

      const session = sessionFromLoginResponse(
        {
          id_token: loginResult.id_token,
          access_token: loginResult.access_token,
          refresh_token: loginResult.refresh_token,
          expires_in: loginResult.expires_in,
          token_type: loginResult.token_type || "Bearer",
          user_sub: loginResult.user_sub,
          user_id: loginResult.user_id,
        },
        trimmedForm.email
      );
      setIdentitySession(session);

      try {
        if (session.userId) {
          const profile = await updateEndUserProfile(session.userId, {
            first_name: trimmedForm.firstName,
            last_name: trimmedForm.lastName,
            role: trimmedForm.specialty,
          });
          const fields = mapEndUserToUserFields(profile);
          const claims = decodeIdToken(loginResult.id_token);
          const pending = consumePendingSignupProfile();
          dispatch(
            setUser({
              ...fields,
              phone: pending?.phone || phoneNumber,
              clinicName: pending?.clinicName ?? trimmedForm.clinicName,
              totalMinutesLeft: parseMinutesLeft(
                claims?.[MINUTES_LEFT_ATTRIBUTE] as string | undefined
              ),
              totalMinutesAllowed: DEFAULT_SUBSCRIPTION_MINUTES,
            })
          );
        } else {
          const claims = decodeIdToken(loginResult.id_token);
          const pending = consumePendingSignupProfile();
          dispatch(
            setUser({
              firstName: claims?.given_name ?? pending?.firstName ?? trimmedForm.firstName,
              lastName: claims?.family_name ?? pending?.lastName ?? trimmedForm.lastName,
              email: claims?.email ?? trimmedForm.email,
              phone: pending?.phone || phoneNumber,
              speciality:
                (claims?.role as string | undefined) ??
                (claims?.["custom:role"] as string | undefined) ??
                pending?.speciality ??
                trimmedForm.specialty,
              clinicName: pending?.clinicName ?? trimmedForm.clinicName,
              totalMinutesLeft: parseMinutesLeft(
                claims?.[MINUTES_LEFT_ATTRIBUTE] as string | undefined
              ),
              totalMinutesAllowed: DEFAULT_SUBSCRIPTION_MINUTES,
            })
          );
        }
      } catch {
        const claims = decodeIdToken(loginResult.id_token);
        const pending = consumePendingSignupProfile();
        dispatch(
          setUser({
            firstName: claims?.given_name ?? pending?.firstName ?? trimmedForm.firstName,
            lastName: claims?.family_name ?? pending?.lastName ?? trimmedForm.lastName,
            email: claims?.email ?? trimmedForm.email,
            phone: pending?.phone || phoneNumber,
            speciality:
              (claims?.role as string | undefined) ??
              (claims?.["custom:role"] as string | undefined) ??
              pending?.speciality ??
              trimmedForm.specialty,
            clinicName: pending?.clinicName ?? trimmedForm.clinicName,
            totalMinutesLeft: parseMinutesLeft(
              claims?.[MINUTES_LEFT_ATTRIBUTE] as string | undefined
            ),
            totalMinutesAllowed: DEFAULT_SUBSCRIPTION_MINUTES,
          })
        );
      }

      dispatch(setLoggedIn(true));
      void syncMinutesLeft(dispatch);
      void syncEndUserProfile(dispatch).catch(() => {
        // Profile already seeded above.
      });
      router.push("/recording");
    } catch (error) {
      setServerError(formatAuthError(error, "Sign up failed. Please try again."));
    } finally {
      setIsLoading(false);
    }
  };

  const updateField = (field: keyof FormData, value: string) => {
    setForm((prev) => ({ ...prev, [field]: value }));
    if (errors[field]) {
      setErrors((prev) => ({ ...prev, [field]: "" }));
    }
  };

  return (
    <div className="min-h-screen bg-white flex items-center justify-center p-4 overflow-hidden relative">
      {/* Background radial gradients */}
      <div className="absolute inset-0 -z-10 overflow-hidden">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_right,rgba(140,198,63,0.1),transparent_40%)]" />
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_bottom_left,rgba(229,100,159,0.1),transparent_40%)]" />
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(41,171,226,0.1),transparent_40%)]" />
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_bottom_right,rgba(247,148,29,0.1),transparent_40%)]" />
      </div>

      <div className="w-full max-w-2xl animate-fade-in-up py-8">
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
            Create Your Account
          </h1>
          <p className="text-slate-600 mt-2">
            Join HIKIGAI AIScribe and streamline your medical transcription
          </p>
        </div>

        {/* Form card */}
        <div className="bg-white p-8 rounded-2xl shadow-[0_8px_30px_rgb(0,0,0,0.06)]">
          {serverError && (
            <div className="text-center mb-4 p-3 text-sm text-red-500 bg-red-50 rounded-lg border border-red-200">
              {serverError}
            </div>
          )}

          <form className="space-y-5" onSubmit={handleSubmit}>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
              {/* First Name */}
              <div className="space-y-2">
                <label className="text-sm font-medium text-slate-700">First Name</label>
                <div className="relative">
                  <User className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
                  <input
                    type="text"
                    placeholder="First Name"
                    value={form.firstName}
                    onChange={(e) => updateField("firstName", e.target.value)}
                    className={`pl-10 h-12 rounded-xl border w-full text-sm placeholder:text-slate-400 focus:outline-none focus:border-brand-blue focus:ring-1 focus:ring-brand-blue ${errors.firstName ? "border-red-500" : "border-slate-200"}`}
                  />
                  {errors.firstName && (
                    <p className="text-red-500 text-xs mt-1">{errors.firstName}</p>
                  )}
                </div>
              </div>

              {/* Last Name */}
              <div className="space-y-2">
                <label className="text-sm font-medium text-slate-700">Last Name</label>
                <div className="relative">
                  <User className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
                  <input
                    type="text"
                    placeholder="Last Name"
                    value={form.lastName}
                    onChange={(e) => updateField("lastName", e.target.value)}
                    className={`pl-10 h-12 rounded-xl border w-full text-sm placeholder:text-slate-400 focus:outline-none focus:border-brand-blue focus:ring-1 focus:ring-brand-blue ${errors.lastName ? "border-red-500" : "border-slate-200"}`}
                  />
                  {errors.lastName && (
                    <p className="text-red-500 text-xs mt-1">{errors.lastName}</p>
                  )}
                </div>
              </div>

              {/* Email */}
              <div className="space-y-2 md:col-span-2">
                <label className="text-sm font-medium text-slate-700">Email Address</label>
                <div className="relative">
                  <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
                  <input
                    type="email"
                    placeholder="Email Address"
                    value={form.email}
                    onChange={(e) => updateField("email", e.target.value)}
                    className={`pl-10 h-12 rounded-xl border w-full text-sm placeholder:text-slate-400 focus:outline-none focus:border-brand-blue focus:ring-1 focus:ring-brand-blue ${errors.email ? "border-red-500" : "border-slate-200"}`}
                  />
                  {errors.email && (
                    <p className="text-red-500 text-xs mt-1">{errors.email}</p>
                  )}
                </div>
              </div>

              {/* Phone — with country code */}
              <div className="space-y-2 md:col-span-2">
                <label className="text-sm font-medium text-slate-700">Phone Number</label>
                <div className="flex gap-2">
                  <div className="w-1/3">
                    <Select
                      value={form.countryCode}
                      onValueChange={(v) => updateField("countryCode", v)}
                    >
                      <SelectTrigger className="!h-12">
                        <SelectValue placeholder="+1" />
                      </SelectTrigger>
                      <SelectContent>
                        {COUNTRY_CODES.map((c) => (
                          <SelectItem key={c.code} value={c.code}>
                            {c.code} ({c.country})
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="relative w-2/3">
                    <Phone className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
                    <input
                      type="tel"
                      placeholder="Phone Number"
                      value={form.phone}
                      onChange={(e) =>
                        updateField("phone", e.target.value.replace(/\D/g, ""))
                      }
                      className={`pl-10 h-12 rounded-xl border w-full text-sm placeholder:text-slate-400 focus:outline-none focus:border-brand-blue focus:ring-1 focus:ring-brand-blue ${errors.phone ? "border-red-500" : "border-slate-200"}`}
                    />
                  </div>
                </div>
                {errors.phone && (
                  <p className="text-red-500 text-xs mt-1">{errors.phone}</p>
                )}
              </div>

              {/* Specialty */}
              <div className="space-y-2">
                <label className="text-sm font-medium text-slate-700">Specialty</label>
                <Select
                  value={form.specialty}
                  onValueChange={(v) => updateField("specialty", v)}
                >
                  <SelectTrigger className={`!h-12 ${errors.specialty ? "border-red-500" : ""}`}>
                    <div className="flex items-center gap-2">
                      <Stethoscope className="h-4 w-4 text-slate-400" />
                      <SelectValue placeholder="Specialty" />
                    </div>
                  </SelectTrigger>
                  <SelectContent>
                    {SPECIALTIES.map((s) => (
                      <SelectItem key={s} value={s}>
                        {s}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {errors.specialty && (
                  <p className="text-red-500 text-xs mt-1">{errors.specialty}</p>
                )}
              </div>

              {/* Clinic Name */}
              <div className="space-y-2">
                <label className="text-sm font-medium text-slate-700">Clinic Name</label>
                <div className="relative">
                  <Building2 className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
                  <input
                    type="text"
                    placeholder="Clinic Name"
                    value={form.clinicName}
                    onChange={(e) => updateField("clinicName", e.target.value)}
                    className={`pl-10 h-12 rounded-xl border w-full text-sm placeholder:text-slate-400 focus:outline-none focus:border-brand-blue focus:ring-1 focus:ring-brand-blue ${errors.clinicName ? "border-red-500" : "border-slate-200"}`}
                  />
                  {errors.clinicName && (
                    <p className="text-red-500 text-xs mt-1">{errors.clinicName}</p>
                  )}
                </div>
              </div>

              {/* Password */}
              <div className="space-y-2">
                <label className="text-sm font-medium text-slate-700 flex items-center gap-2">
                  Password
                  <InfoTooltip text="Password must be at least 8 characters and include lowercase, uppercase, number, and special character" />
                </label>
                <div className="relative">
                  <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
                  <input
                    type="password"
                    placeholder="Password"
                    value={form.password}
                    onChange={(e) => updateField("password", e.target.value)}
                    className={`pl-10 h-12 rounded-xl border w-full text-sm placeholder:text-slate-400 focus:outline-none focus:border-brand-blue focus:ring-1 focus:ring-brand-blue ${errors.password ? "border-red-500" : "border-slate-200"}`}
                  />
                  {errors.password && (
                    <p className="text-red-500 text-xs mt-1">{errors.password}</p>
                  )}
                </div>
              </div>

              {/* Confirm Password */}
              <div className="space-y-2">
                <label className="text-sm font-medium text-slate-700">Confirm Password</label>
                <div className="relative">
                  <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
                  <input
                    type={showConfirmPassword ? "text" : "password"}
                    placeholder="Confirm Password"
                    value={form.confirmPassword}
                    onChange={(e) => updateField("confirmPassword", e.target.value)}
                    className={`pl-10 pr-10 h-12 rounded-xl border w-full text-sm placeholder:text-slate-400 focus:outline-none focus:border-brand-blue focus:ring-1 focus:ring-brand-blue ${errors.confirmPassword ? "border-red-500" : "border-slate-200"}`}
                  />
                  <button
                    type="button"
                    onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                  >
                    {showConfirmPassword ? (
                      <EyeOff className="h-4 w-4" />
                    ) : (
                      <Eye className="h-4 w-4" />
                    )}
                  </button>
                  {errors.confirmPassword && (
                    <p className="text-red-500 text-xs mt-1">{errors.confirmPassword}</p>
                  )}
                </div>
              </div>
            </div>

            {/* Submit CTA */}
            <div className="pt-4">
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
                  Create Account
                </button>
              </div>
            </div>
          </form>

          <div className="mt-8 text-center">
            <span className="text-slate-600">Already have an account? </span>
            <Link
              href="/login"
              className="text-brand-pink hover:text-brand-orange transition-colors font-medium"
            >
              Sign in
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
