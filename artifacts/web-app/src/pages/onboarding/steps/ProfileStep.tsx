import { useMemo, useState } from "react";
import { z } from "zod";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  type AgentContractingProfile,
  type ProfilePatch,
  usePatchOnboardingProfile,
} from "@/lib/onboarding/api";
import { US_STATES } from "@/lib/onboarding/states";

/**
 * Client-side validation. Mirrors `ProfilePatchSchema` in routes/onboarding.ts.
 * We accept partial submission (any field nullable/optional) so the agent can
 * save progress, but require core PII (name, address, phone, email, DOB) and
 * SSN before the wizard advances past this step.
 */
const ProfileFormSchema = z.object({
  ssn: z
    .string()
    .refine((v) => v === "" || v.replace(/\D/g, "").length === 9, {
      message: "SSN must be 9 digits",
    }),
  dob: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD").or(z.literal("")),
  homeAddressLine1: z.string().max(200),
  homeAddressLine2: z.string().max(200),
  homeCity: z.string().max(100),
  homeState: z.string().max(2),
  homeZip: z.string().max(10),
  mailingSameAsHome: z.boolean(),
  mailingAddressLine1: z.string().max(200),
  mailingAddressLine2: z.string().max(200),
  mailingCity: z.string().max(100),
  mailingState: z.string().max(2),
  mailingZip: z.string().max(10),
  phone: z.string().max(30),
  email: z.string().email("Enter a valid email").or(z.literal("")),
  entityType: z.enum(["individual", "llc", "corp", "partnership", ""]),
  businessName: z.string().max(200),
  businessEin: z
    .string()
    .refine((v) => v === "" || v.replace(/\D/g, "").length === 9, {
      message: "EIN must be 9 digits",
    }),
  eAndOCarrier: z.string().max(200),
  eAndOPolicyNumber: z.string().max(100),
  eAndOExpiresOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$|^$/, "Use YYYY-MM-DD"),
  backgroundCheckAuthorized: z.boolean(),
});

// Exported for unit tests.
export const __ProfileFormSchema = ProfileFormSchema;

type FormState = z.infer<typeof ProfileFormSchema>;

function profileToForm(p: AgentContractingProfile | null): FormState {
  return {
    // SSN/EIN are NEVER pre-populated — not the masked sentinel (which the
    // user might accidentally submit) and not the plaintext privileged roles
    // receive (which would sit in a visible input). The placeholder says
    // "On file — leave blank to keep"; SSN/EIN must not be re-rendered after
    // submission.
    ssn: "",
    dob: p?.dob ?? "",
    homeAddressLine1: p?.homeAddressLine1 ?? "",
    homeAddressLine2: p?.homeAddressLine2 ?? "",
    homeCity: p?.homeCity ?? "",
    homeState: p?.homeState ?? "",
    homeZip: p?.homeZip ?? "",
    mailingSameAsHome: p?.mailingSameAsHome ?? true,
    mailingAddressLine1: p?.mailingAddressLine1 ?? "",
    mailingAddressLine2: p?.mailingAddressLine2 ?? "",
    mailingCity: p?.mailingCity ?? "",
    mailingState: p?.mailingState ?? "",
    mailingZip: p?.mailingZip ?? "",
    phone: p?.phone ?? "",
    email: p?.email ?? "",
    entityType: (p?.entityType ?? "") as FormState["entityType"],
    businessName: p?.businessName ?? "",
    businessEin: "",
    eAndOCarrier: p?.eAndOCarrier ?? "",
    eAndOPolicyNumber: p?.eAndOPolicyNumber ?? "",
    eAndOExpiresOn: p?.eAndOExpiresOn ?? "",
    backgroundCheckAuthorized: p?.backgroundCheckAuthorized ?? false,
  };
}

// Exported for unit tests.
export function formToPatch(form: FormState, existing: AgentContractingProfile | null): ProfilePatch {
  const patch: ProfilePatch = {};
  // Only include fields where the value differs from the existing
  // server-side value AND the form value is non-empty (we never CLEAR a
  // field from the wizard — that's an admin operation).
  if (form.ssn && form.ssn !== existing?.ssn) patch.ssn = form.ssn;
  if (form.businessEin && form.businessEin !== existing?.ein) {
    patch.businessEin = form.businessEin;
  }
  if (form.dob) patch.dob = form.dob;
  if (form.homeAddressLine1) patch.homeAddressLine1 = form.homeAddressLine1;
  if (form.homeAddressLine2) patch.homeAddressLine2 = form.homeAddressLine2;
  if (form.homeCity) patch.homeCity = form.homeCity;
  if (form.homeState) patch.homeState = form.homeState;
  if (form.homeZip) patch.homeZip = form.homeZip;
  patch.mailingSameAsHome = form.mailingSameAsHome;
  if (!form.mailingSameAsHome) {
    if (form.mailingAddressLine1) patch.mailingAddressLine1 = form.mailingAddressLine1;
    if (form.mailingAddressLine2) patch.mailingAddressLine2 = form.mailingAddressLine2;
    if (form.mailingCity) patch.mailingCity = form.mailingCity;
    if (form.mailingState) patch.mailingState = form.mailingState;
    if (form.mailingZip) patch.mailingZip = form.mailingZip;
  }
  if (form.phone) patch.phone = form.phone;
  if (form.email) patch.email = form.email;
  if (form.entityType) patch.entityType = form.entityType;
  if (form.businessName) patch.businessName = form.businessName;
  if (form.eAndOCarrier) patch.eAndOCarrier = form.eAndOCarrier;
  if (form.eAndOPolicyNumber) patch.eAndOPolicyNumber = form.eAndOPolicyNumber;
  if (form.eAndOExpiresOn) patch.eAndOExpiresOn = form.eAndOExpiresOn;
  return patch;
}

export function ProfileStep({
  agentId,
  profile,
  onContinue,
}: {
  agentId: string;
  profile: AgentContractingProfile | null;
  onContinue: () => void;
}) {
  const [form, setForm] = useState<FormState>(() => profileToForm(profile));
  const [errors, setErrors] = useState<Record<string, string>>({});
  // Mirrors the per-form pattern in sign.tsx: keep an inline error message
  // alongside the toast so the agent doesn't lose context if they dismiss
  // the toast or it disappears too quickly.
  const [submitError, setSubmitError] = useState<string | null>(null);

  const { mutateAsync, isPending } = usePatchOnboardingProfile(agentId);

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => {
    setForm((p) => ({ ...p, [k]: v }));
  };

  const isEntityNonIndividual = useMemo(
    () => form.entityType === "llc" || form.entityType === "corp" || form.entityType === "partnership",
    [form.entityType],
  );

  const handleSave = async (advance: boolean) => {
    setSubmitError(null);
    const parsed = ProfileFormSchema.safeParse(form);
    if (!parsed.success) {
      const errs: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const k = issue.path[0];
        if (typeof k === "string") errs[k] = issue.message;
      }
      setErrors(errs);
      toast.error("Please fix the highlighted fields");
      setSubmitError("Please fix the highlighted fields above.");
      return;
    }
    setErrors({});
    try {
      const patch = formToPatch(parsed.data, profile);
      if (Object.keys(patch).length === 0) {
        toast.message("Nothing to save");
        if (advance) onContinue();
        return;
      }
      await mutateAsync(patch);
      toast.success("Profile saved");
      if (advance) onContinue();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to save profile";
      toast.error(msg);
      setSubmitError(msg);
    }
  };

  const ssnIsOnFile = profile?.ssn != null;
  const einIsOnFile = profile?.ein != null;

  return (
    <Card data-testid="profile-step">
      <CardHeader>
        <CardTitle>Your contracting profile</CardTitle>
        <CardDescription>
          Personal information needed for carrier appointments. SSN and EIN are
          encrypted at rest.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <section className="space-y-3">
          <h3 className="text-sm font-semibold">Identity</h3>
          <div className="grid sm:grid-cols-2 gap-3">
            <Field label="SSN" error={errors.ssn}>
              <Input
                value={form.ssn}
                onChange={(e) => set("ssn", e.target.value)}
                placeholder={ssnIsOnFile ? "On file — leave blank to keep" : "123-45-6789"}
                inputMode="numeric"
                autoComplete="off"
                data-testid="input-ssn"
              />
            </Field>
            <Field label="Date of birth" error={errors.dob}>
              <Input
                type="date"
                value={form.dob}
                onChange={(e) => set("dob", e.target.value)}
                data-testid="input-dob"
              />
            </Field>
          </div>
        </section>

        <section className="space-y-3">
          <h3 className="text-sm font-semibold">Home address</h3>
          <div className="grid sm:grid-cols-2 gap-3">
            <Field label="Address line 1" error={errors.homeAddressLine1} className="sm:col-span-2">
              <Input value={form.homeAddressLine1} onChange={(e) => set("homeAddressLine1", e.target.value)} />
            </Field>
            <Field label="Address line 2" error={errors.homeAddressLine2} className="sm:col-span-2">
              <Input value={form.homeAddressLine2} onChange={(e) => set("homeAddressLine2", e.target.value)} />
            </Field>
            <Field label="City" error={errors.homeCity}>
              <Input value={form.homeCity} onChange={(e) => set("homeCity", e.target.value)} />
            </Field>
            <Field label="State" error={errors.homeState}>
              <Select value={form.homeState} onValueChange={(v) => set("homeState", v)}>
                <SelectTrigger>
                  <SelectValue placeholder="Pick a state…" />
                </SelectTrigger>
                <SelectContent className="max-h-72">
                  {US_STATES.map((s) => (
                    <SelectItem key={s.code} value={s.code}>
                      {s.code} — {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="ZIP" error={errors.homeZip}>
              <Input value={form.homeZip} onChange={(e) => set("homeZip", e.target.value)} />
            </Field>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={form.mailingSameAsHome}
              onCheckedChange={(v) => set("mailingSameAsHome", Boolean(v))}
              data-testid="checkbox-mailing-same"
            />
            Mailing address same as home
          </label>
          {!form.mailingSameAsHome && (
            <div className="grid sm:grid-cols-2 gap-3 pl-6 border-l-2 border-muted">
              <Field label="Mailing line 1" error={errors.mailingAddressLine1} className="sm:col-span-2">
                <Input value={form.mailingAddressLine1} onChange={(e) => set("mailingAddressLine1", e.target.value)} />
              </Field>
              <Field label="Mailing line 2" error={errors.mailingAddressLine2} className="sm:col-span-2">
                <Input value={form.mailingAddressLine2} onChange={(e) => set("mailingAddressLine2", e.target.value)} />
              </Field>
              <Field label="City" error={errors.mailingCity}>
                <Input value={form.mailingCity} onChange={(e) => set("mailingCity", e.target.value)} />
              </Field>
              <Field label="State" error={errors.mailingState}>
                <Select value={form.mailingState} onValueChange={(v) => set("mailingState", v)}>
                  <SelectTrigger>
                    <SelectValue placeholder="Pick a state…" />
                  </SelectTrigger>
                  <SelectContent className="max-h-72">
                    {US_STATES.map((s) => (
                      <SelectItem key={s.code} value={s.code}>
                        {s.code} — {s.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field label="ZIP" error={errors.mailingZip}>
                <Input value={form.mailingZip} onChange={(e) => set("mailingZip", e.target.value)} />
              </Field>
            </div>
          )}
        </section>

        <section className="space-y-3">
          <h3 className="text-sm font-semibold">Contact</h3>
          <div className="grid sm:grid-cols-2 gap-3">
            <Field label="Phone" error={errors.phone}>
              <Input value={form.phone} onChange={(e) => set("phone", e.target.value)} />
            </Field>
            <Field label="Email" error={errors.email}>
              <Input type="email" value={form.email} onChange={(e) => set("email", e.target.value)} />
            </Field>
          </div>
        </section>

        <section className="space-y-3">
          <h3 className="text-sm font-semibold">Business entity</h3>
          <div className="grid sm:grid-cols-2 gap-3">
            <Field label="Entity type" error={errors.entityType}>
              <Select value={form.entityType || "individual"} onValueChange={(v) => set("entityType", v as FormState["entityType"])}>
                <SelectTrigger data-testid="select-entity-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="individual">Individual</SelectItem>
                  <SelectItem value="llc">LLC</SelectItem>
                  <SelectItem value="corp">Corporation</SelectItem>
                  <SelectItem value="partnership">Partnership</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            {isEntityNonIndividual && (
              <>
                <Field label="Business name" error={errors.businessName}>
                  <Input value={form.businessName} onChange={(e) => set("businessName", e.target.value)} />
                </Field>
                <Field label="EIN" error={errors.businessEin} className="sm:col-span-2">
                  <Input
                    value={form.businessEin}
                    onChange={(e) => set("businessEin", e.target.value)}
                    placeholder={einIsOnFile ? "On file — leave blank to keep" : "12-3456789"}
                    inputMode="numeric"
                  />
                </Field>
              </>
            )}
          </div>
        </section>

        <section className="space-y-3">
          <h3 className="text-sm font-semibold">E&O insurance</h3>
          <div className="grid sm:grid-cols-2 gap-3">
            <Field label="Carrier" error={errors.eAndOCarrier}>
              <Input value={form.eAndOCarrier} onChange={(e) => set("eAndOCarrier", e.target.value)} />
            </Field>
            <Field label="Policy #" error={errors.eAndOPolicyNumber}>
              <Input value={form.eAndOPolicyNumber} onChange={(e) => set("eAndOPolicyNumber", e.target.value)} />
            </Field>
            <Field label="Expires on" error={errors.eAndOExpiresOn}>
              <Input
                type="date"
                value={form.eAndOExpiresOn}
                onChange={(e) => set("eAndOExpiresOn", e.target.value)}
              />
            </Field>
          </div>
        </section>

        <section className="space-y-3">
          <label className="flex items-start gap-2 text-sm">
            <Checkbox
              checked={form.backgroundCheckAuthorized}
              onCheckedChange={(v) => set("backgroundCheckAuthorized", Boolean(v))}
              data-testid="checkbox-bgcheck"
            />
            <span>
              I authorize a background check as part of the carrier appointment
              process. (Required by most carriers.)
            </span>
          </label>
        </section>

        {submitError && (
          <div
            role="alert"
            className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive"
            data-testid="profile-submit-error"
          >
            {submitError}
          </div>
        )}

        <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2 border-t pt-4">
          <Button
            variant="outline"
            disabled={isPending}
            onClick={() => handleSave(false)}
            className="w-full sm:w-auto"
          >
            {isPending ? "Saving…" : "Save progress"}
          </Button>
          <Button
            disabled={isPending}
            onClick={() => handleSave(true)}
            data-testid="profile-continue"
            className="w-full sm:w-auto"
          >
            {isPending ? "Saving…" : "Save and continue"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function Field({
  label,
  error,
  children,
  className,
}: {
  label: string;
  error?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`space-y-1.5 ${className ?? ""}`}>
      <Label className="text-xs">{label}</Label>
      {children}
      {error && <p className="text-[11px] text-destructive">{error}</p>}
    </div>
  );
}
