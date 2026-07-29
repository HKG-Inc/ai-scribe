"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import { apiFetch, cn, getPersonNameError } from "@/lib/utils";
import {
  Check,
  X,
  AlertCircle,
  User,
  Building2,
  Mail,
  Phone,
  Brain,
  Bookmark,
  BarChart3,
  GraduationCap,
  Loader2,
  ArrowLeft,
} from "lucide-react";
import { toast } from "sonner";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useAppSelector } from "@/store/hooks";

const countryCodes = [
  { code: "+1", country: "US/CA" },
  { code: "+44", country: "UK" },
  { code: "+91", country: "IN" },
  { code: "+61", country: "AU" },
  { code: "+971", country: "UAE" },
];

const featuresCardsData = [
  {
    title: "AI-powered clinical decision support",
    description: "Intelligent recommendations based on patient data and evidence-based medicine",
    icon: Brain,
    color: "bg-brandLight-blue",
  },
  {
    title: "Comprehensive patient dashboard",
    description: "Centralized view of patient history, medications, and care plans",
    icon: Bookmark,
    color: "bg-brandLight-pink",
  },
  {
    title: "Advanced analytics and reporting",
    description: "Real-time insights into practice performance and patient outcomes",
    icon: BarChart3,
    color: "bg-brandLight-green",
  },
  {
    title: "Multi-device accessibility",
    description: "Access from any device with secure cloud-based platform",
    icon: GraduationCap,
    color: "bg-brandLight-orange",
  },
];

interface FormData {
  fullName: string;
  clinicalName: string;
  workEmail: string;
  countryCode: string;
  phoneNumber: string;
}

export default function PricingPage() {
  const router = useRouter();
  const user = useAppSelector((state) => state.user);

  let extractedCountryCode = "+1";
  if (user.phone) {
    const matchingCountry = countryCodes.find((country) => user.phone.startsWith(country.code));
    extractedCountryCode = matchingCountry ? matchingCountry.code : "+1";
  }

  const derivedFormData: FormData = {
    fullName: `${user.firstName || ""} ${user.lastName || ""}`.trim(),
    clinicalName: user.clinicName || "",
    workEmail: user.email || "",
    countryCode: extractedCountryCode,
    phoneNumber: user.phone
      ? user.phone.replace(extractedCountryCode, "").replace(/\D/g, "")
      : "",
  };

  const [formData, setFormData] = useState<FormData | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const activeFormData = formData ?? derivedFormData;

  const handleInputChange = (field: keyof FormData, value: string) => {
    setFormData((prev) => ({ ...(prev ?? derivedFormData), [field]: value }));
  };

  const getValidCountryCode = (code: string) => {
    const isValidCode = countryCodes.some((country) => country.code === code);
    return isValidCode ? code : "+1";
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (
      !activeFormData.fullName ||
      !activeFormData.clinicalName ||
      !activeFormData.workEmail ||
      !activeFormData.phoneNumber
    ) {
      toast.error("Please fill in all required fields");
      return;
    }

    const fullNameError = getPersonNameError(activeFormData.fullName, "Full name");
    if (fullNameError) {
      toast.error(fullNameError);
      return;
    }

    setIsSubmitting(true);
    try {
      const phoneNumber = `${activeFormData.countryCode}${activeFormData.phoneNumber}`;
      const description = [
        "A user requested a AI_Scribe call-back from the premium page.",
        "",
        `Clinic: ${activeFormData.clinicalName}`,
        `Phone: ${phoneNumber}`,
        `Work Email: ${activeFormData.workEmail}`,
      ].join("\n");

      const helpPayload = new FormData();
      helpPayload.append("name", activeFormData.fullName);
      helpPayload.append("email", activeFormData.workEmail);
      helpPayload.append("category", "Premium Upgrade");
      helpPayload.append("subject", "AI Scribe Call Me Request");
      helpPayload.append("description", description);

      const [helpResponse, callResponse] = await Promise.all([
        apiFetch("/api/help/contact", {
          method: "POST",
          body: helpPayload,
        }),
        apiFetch("/api/bland-call", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            phone_number: phoneNumber,
            request_data: {
              email: activeFormData.workEmail,
              name: activeFormData.fullName,
            },
          }),
        }),
      ]);

      if (!helpResponse.ok) {
        const errorData = await helpResponse.json().catch(() => ({}));
        throw new Error(errorData.error || "Failed to submit request. Please try again.");
      }

      if (!callResponse.ok) {
        console.warn("Call request could not be queued, but support was notified by email.");
      }

      toast.success("Thank you! We will call you shortly.", {
        duration: 5000,
        style: { background: "#e8f3da" },
      });
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Network error. Please check your connection and try again.",
        {
          duration: 5000,
          style: { background: "#f3dada" },
        }
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-background">
      <header className="bg-white border-b border-slate-100 py-4 px-6 flex justify-between items-center sticky top-0 z-10 shadow-sm">
        <div className="flex items-center">
          <Image
            src="https://hebbkx1anhila5yf.public.blob.vercel-storage.com/image-3iYmNCbNrAz3xweW1kCvDFAA44QRiG.png"
            alt="HIKIGAI AIScribe Logo"
            width={36}
            height={36}
            className="mr-3"
            priority
          />
          <h1 className="text-xl font-bold bg-clip-text text-transparent bg-brand-gradient cursor-default">
            HIKIGAI AIScribe
          </h1>
        </div>

        <button
          type="button"
          className="bg-brandLight-blue text-black rounded-full hover:bg-brand-blue hover:text-white absolute left-6 top-20 border border-slate-200 h-10 w-10 flex items-center justify-center"
          onClick={() => router.back()}
        >
          <ArrowLeft className="w-4 h-4" />
        </button>
      </header>

      <main className="max-w-6xl mx-auto px-6 py-12">
        <div className="text-center mb-16">
          <h1 className="text-4xl font-bold leading-normal mb-2">
            <span className="bg-clip-text text-transparent bg-brand-gradient cursor-default">
              Upgrade to Hikigai CarePilot
            </span>
          </h1>
          <p className="text-xl text-muted-foreground mb-12">
            Take your HIKIGAI AIScribe experience to the next level.
          </p>

          <div className="grid md:grid-cols-2 gap-8 items-start mb-16">
            <div className="relative">
              <div className="aspect-video bg-gradient-to-br from-orange-100 to-orange-200 rounded-lg overflow-hidden relative">
                <video
                  src="https://storage.googleapis.com/hikigai-video-assets/Launchpad%20EHR%20with%20CarePilot.mp4"
                  controls
                  muted
                  loop
                  className="w-full h-full object-cover"
                />
                <span className="absolute top-4 left-4 bg-orange-600 text-white rounded-full px-2 py-1 text-xs">
                  CarePilot
                </span>
              </div>
              <p className="text-sm text-muted-foreground mt-4 text-left">
                Intelligent web platform to empower healthcare professionals with AI-powered
                clinical decision support, patient management tools, and advanced analytics for
                improved care delivery.
              </p>
            </div>

            <div className="space-y-4">
              {featuresCardsData.map((feature) => (
                <div key={feature.title} className={cn("border-none py-4 rounded-xl", feature.color)}>
                  <div className="px-4 flex items-start gap-6 h-full">
                    <div className="flex items-center justify-center h-full self-center ml-2">
                      <feature.icon className="w-6 h-6 text-black" />
                    </div>
                    <div className="text-left">
                      <h3 className="font-semibold text-black mb-1">{feature.title}</h3>
                      <p className="text-sm text-gray-600">{feature.description}</p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        <section className="mb-14">
          <div className="text-center mb-12">
            <h2 className="text-3xl font-bold mb-4">Why Upgrade?</h2>
            <p className="text-lg text-muted-foreground max-w-4xl mx-auto">
              HIKIGAI AIScribe saves you time by transcribing doctor-patient conversations and
              generating clinical notes. But with <span className="bg-clip-text text-transparent bg-brand-gradient font-semibold whitespace-nowrap">CarePilot</span>, you unlock <span className="bg-clip-text text-transparent bg-brand-gradient font-semibold whitespace-nowrap">end-to-end automation</span> from pre-visit insights to seamless <span className="bg-clip-text text-transparent bg-brand-gradient font-semibold whitespace-nowrap">EHR integration</span>. CarePilot is more than a scribe. It is your intelligent clinical assistant.
            </p>
          </div>

          <div className="grid md:grid-cols-2 gap-6 max-w-5xl mx-auto">
            <div className="relative bg-white rounded-xl border border-slate-200">
              <div className="p-6">
                <div className="text-center mb-6">
                  <h3 className="text-2xl font-bold mb-2">HIKIGAI AIScribe (Free)</h3>
                  <span className="text-slate-500 border border-slate-300 bg-transparent py-1 px-6 rounded-full text-xs">
                    Your Current Plan
                  </span>
                </div>

                <div className="space-y-4">
                  <div className="flex items-center gap-3"><AlertCircle className="w-5 h-5 text-orange-500 flex-shrink-0" /><span className="text-sm">Limited to 2500 consultation minutes</span></div>
                  <div className="flex items-center gap-3"><X className="w-5 h-5 text-red-500 flex-shrink-0" /><span className="text-sm">Cannot connect to external EHRs</span></div>
                  <div className="flex items-center gap-3"><AlertCircle className="w-5 h-5 text-orange-500 flex-shrink-0" /><span className="text-sm">Manual copy-paste notes into EHR</span></div>
                  <div className="flex items-center gap-3"><X className="w-5 h-5 text-red-500 flex-shrink-0" /><span className="text-sm">No Patient Prep available</span></div>
                  <div className="flex items-center gap-3"><X className="w-5 h-5 text-red-500 flex-shrink-0" /><span className="text-sm">No built-in chatbot</span></div>
                  <div className="flex items-center gap-3"><X className="w-5 h-5 text-red-500 flex-shrink-0" /><span className="text-sm">Does not show Alerts</span></div>
                  <div className="flex items-center gap-3"><Check className="w-5 h-5 text-green-500 flex-shrink-0" /><span className="text-sm">Saves you ~1 hour/day</span></div>
                  <div className="flex items-center gap-3"><Check className="w-5 h-5 text-green-500 flex-shrink-0" /><span className="text-sm">Generates Structured Medical Notes</span></div>
                  <div className="flex items-center gap-3"><Check className="w-5 h-5 text-green-500 flex-shrink-0" /><span className="text-sm">Captures medications as mentioned</span></div>
                </div>
              </div>
            </div>

            <div className="relative bg-green-50 border-green-200 rounded-xl border">
              <div className="p-6">
                <div className="text-center mb-6">
                  <h3 className="text-2xl font-bold mb-2">CarePilot</h3>
                  <span className="text-black border border-green-600 bg-transparent py-1 px-6 rounded-full text-xs">
                    Premium Version
                  </span>
                </div>

                <div className="space-y-4">
                  <div className="flex items-center gap-3"><Check className="w-5 h-5 text-green-600 flex-shrink-0" /><span className="text-sm font-medium">Unlimited consultations - no limits.</span></div>
                  <div className="flex items-center gap-3"><Check className="w-5 h-5 text-green-600 flex-shrink-0" /><span className="text-sm font-medium">Works with any EHR system</span></div>
                  <div className="flex items-center gap-3"><Check className="w-5 h-5 text-green-600 flex-shrink-0" /><span className="text-sm font-medium">Notes are auto-synced to your EHR - no extra steps</span></div>
                  <div className="flex items-center gap-3"><Check className="w-5 h-5 text-green-600 flex-shrink-0" /><span className="text-sm font-medium">Shows patient prep insights + medical history</span></div>
                  <div className="flex items-center gap-3"><Check className="w-5 h-5 text-green-600 flex-shrink-0" /><span className="text-sm font-medium">Includes a Medical Assistant Chatbot</span></div>
                  <div className="flex items-center gap-3"><Check className="w-5 h-5 text-green-600 flex-shrink-0" /><span className="text-sm font-medium">Flags Clinical and Preventive Alerts</span></div>
                  <div className="flex items-center gap-3"><Check className="w-5 h-5 text-green-600 flex-shrink-0" /><span className="text-sm font-medium">Saves you ~2+ hours/day</span></div>
                  <div className="flex items-center gap-3"><Check className="w-5 h-5 text-green-600 flex-shrink-0" /><span className="text-sm font-medium">Generates Structured Medical Notes + Suggest Differential Diagnosis</span></div>
                  <div className="flex items-center gap-3"><Check className="w-5 h-5 text-green-600 flex-shrink-0" /><span className="text-sm font-medium">Captures medications as mentioned + flags adverse reactions</span></div>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="max-w-md mx-auto">
          <div className="text-center mb-10">
            <h2 className="text-2xl font-bold mb-2">Contact Me</h2>
            <p className="text-muted-foreground">Have questions about Hikigai CarePilot?</p>
          </div>

          <div className="bg-white rounded-xl border border-slate-200">
            <div className="px-6 py-0 pb-4">
              <form className="space-y-4" onSubmit={handleSubmit}>
                <div>
                  <label htmlFor="fullName" className="text-sm font-medium text-slate-700">Full Name*</label>
                  <div className="relative mt-1">
                    <User className="absolute left-3 top-3 w-4 h-4 text-muted-foreground" />
                    <input
                      id="fullName"
                      placeholder="Enter your full name"
                      className="pl-10 h-10 rounded-xl border border-slate-200 w-full text-sm"
                      value={activeFormData.fullName}
                      onChange={(e) => handleInputChange("fullName", e.target.value)}
                      disabled={isSubmitting}
                    />
                  </div>
                </div>

                <div>
                  <label htmlFor="clinicalName" className="text-sm font-medium text-slate-700">Clinical Name*</label>
                  <div className="relative mt-1">
                    <Building2 className="absolute left-3 top-3 w-4 h-4 text-muted-foreground" />
                    <input
                      id="clinicalName"
                      placeholder="Enter your clinic name"
                      className="pl-10 h-10 rounded-xl border border-slate-200 w-full text-sm"
                      value={activeFormData.clinicalName}
                      onChange={(e) => handleInputChange("clinicalName", e.target.value)}
                      disabled={isSubmitting}
                    />
                  </div>
                </div>

                <div>
                  <label htmlFor="workEmail" className="text-sm font-medium text-slate-700">Work Email*</label>
                  <div className="relative mt-1">
                    <Mail className="absolute left-3 top-3 w-4 h-4 text-muted-foreground" />
                    <input
                      id="workEmail"
                      type="email"
                      placeholder="Enter your work email"
                      className="pl-10 h-10 rounded-xl border border-slate-200 w-full text-sm"
                      value={activeFormData.workEmail}
                      onChange={(e) => handleInputChange("workEmail", e.target.value)}
                      disabled={isSubmitting}
                    />
                  </div>
                </div>

                <div>
                  <label htmlFor="phoneNumber" className="text-sm font-medium text-slate-700">Phone Number*</label>
                  <div className="flex gap-2 mt-1">
                    <Select
                      value={getValidCountryCode(activeFormData.countryCode)}
                      onValueChange={(value) => value.length && handleInputChange("countryCode", value)}
                      disabled={isSubmitting}
                    >
                      <SelectTrigger className="w-24">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {countryCodes.map((country) => (
                          <SelectItem key={country.code} value={country.code}>
                            {country.code} {country.country}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <div className="relative flex-1">
                      <Phone className="absolute left-3 top-3 w-4 h-4 text-muted-foreground" />
                      <input
                        id="phoneNumber"
                        placeholder="Enter your phone number"
                        className="pl-10 h-10 rounded-xl border border-slate-200 w-full text-sm"
                        required
                        value={activeFormData.phoneNumber}
                        onChange={(e) => handleInputChange("phoneNumber", e.target.value.replace(/\D/g, ""))}
                        disabled={isSubmitting}
                      />
                    </div>
                  </div>
                </div>

                <div className="pt-4">
                  <div className="relative group">
                    <div className="absolute -inset-0.5 bg-brand-gradient rounded-xl blur opacity-10 group-hover:opacity-100 transition duration-1000 group-hover:duration-200" />
                    <button
                      type="submit"
                      disabled={isSubmitting}
                      className="relative w-full h-10 bg-brandLight-blue text-black hover:text-white hover:bg-brand-blue rounded-xl text-base font-medium text-sm leading-none transition-all duration-300 border-none disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center"
                    >
                      {isSubmitting ? (
                        <>
                          <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                          CALLING...
                        </>
                      ) : (
                        <>
                          <Phone className="w-4 h-4 mr-2" fill="currentColor" />
                          CALL ME
                        </>
                      )}
                    </button>
                  </div>
                </div>
              </form>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}
