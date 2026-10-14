/**
 * Account security (ADR 0006: Identity Platform): two-step verification and
 * password.
 *
 * Every user must sign in with a second factor before the server answers any
 * authenticated route (middlewares/requireAuth.ts); until then the app shows
 * MfaEnrollmentGate instead of this page. Here a user can replace their
 * authenticator app (new phone) and change their password. Both need a recent
 * sign-in, which <Reauthenticate> provides.
 */
import { useState } from "react";
import { multiFactor, updatePassword } from "@firebase/auth";
import { KeyRound, Loader2, ShieldCheck, ShieldAlert, Smartphone } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Reauthenticate, TotpEnrollment } from "@/components/auth/TotpEnrollment";
import { authErrorMessage } from "@/lib/auth/firebase";
import { useSignOut, useUser } from "@/lib/auth";
import { MIN_PASSWORD_LENGTH } from "@/pages/sign-up";

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");
const signInAgain = `${basePath}/sign-in?notice=mfa-on&redirect_url=${encodeURIComponent(`${basePath}/settings/security`)}`;

function Section({ icon: Icon, title, children }: { icon: typeof KeyRound; title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-4 rounded-xl border bg-card p-6 text-card-foreground shadow-sm">
      <h2 className="flex items-center gap-2 text-base font-semibold">
        <Icon className="h-4 w-4 text-accent" aria-hidden="true" /> {title}
      </h2>
      {children}
    </section>
  );
}

function TwoStep() {
  const { firebaseUser } = useUser();
  const { signOut } = useSignOut();
  const [mode, setMode] = useState<"view" | "confirm" | "enrol">("view");
  const [error, setError] = useState<string | null>(null);
  if (!firebaseUser) return null;
  const factors = multiFactor(firebaseUser).enrolledFactors;

  async function removeAndReplace() {
    setError(null);
    try {
      for (const f of multiFactor(firebaseUser!).enrolledFactors) await multiFactor(firebaseUser!).unenroll(f);
      setMode("enrol");
    } catch (err) {
      setError(authErrorMessage(err, "Couldn't remove the old authenticator. Try again."));
      setMode("view");
    }
  }

  if (mode === "enrol") return <TotpEnrollment user={firebaseUser} onEnrolled={() => void signOut({ redirectUrl: signInAgain })} />;
  if (mode === "confirm") return <Reauthenticate user={firebaseUser} action="Remove and set up a new one" onDone={() => void removeAndReplace()} />;

  return factors.length ? (
    <div className="space-y-3">
      <div className="flex items-start gap-3 rounded-lg border border-emerald-300 bg-emerald-50 p-4 text-sm text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200">
        <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
        <div>
          <p className="font-medium">Two-step verification is on.</p>
          <ul className="mt-1 list-disc pl-5">
            {factors.map((f) => (
              <li key={f.uid}>
                {f.displayName ?? "Authenticator app"}, added {new Date(f.enrollmentTime).toLocaleDateString()}
              </li>
            ))}
          </ul>
        </div>
      </div>
      <Button variant="outline" size="sm" onClick={() => setMode("confirm")}>
        <Smartphone className="mr-1.5 h-4 w-4" aria-hidden="true" /> New phone? Replace authenticator app
      </Button>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  ) : (
    <div className="space-y-4">
      <div className="flex items-start gap-3 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
        <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
        <p>Two-step verification is not set up. agencyBRIDGE requires it for every account.</p>
      </div>
      <TotpEnrollment user={firebaseUser} onEnrolled={() => void signOut({ redirectUrl: signInAgain })} />
    </div>
  );
}

function ChangePassword() {
  const { firebaseUser } = useUser();
  const [confirmed, setConfirmed] = useState(false);
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  if (!firebaseUser) return null;
  if (!confirmed) return <Reauthenticate user={firebaseUser} action="Continue" onDone={() => setConfirmed(true)} />;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (password.length < MIN_PASSWORD_LENGTH) return setMessage({ ok: false, text: `Use at least ${MIN_PASSWORD_LENGTH} characters.` });
    if (password !== again) return setMessage({ ok: false, text: "The two passwords don't match." });
    setBusy(true);
    setMessage(null);
    try {
      await updatePassword(firebaseUser!, password);
      setPassword("");
      setAgain("");
      setMessage({ ok: true, text: "Password changed." });
    } catch (err) {
      setMessage({ ok: false, text: authErrorMessage(err, "Couldn't change the password. Try again.") });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="max-w-sm space-y-3" onSubmit={submit}>
      <div className="space-y-1.5">
        <Label htmlFor="new-password">New password</Label>
        <Input id="new-password" type="password" autoComplete="new-password" required minLength={MIN_PASSWORD_LENGTH} value={password} onChange={(e) => setPassword(e.target.value)} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="new-password-again">Confirm new password</Label>
        <Input id="new-password-again" type="password" autoComplete="new-password" required value={again} onChange={(e) => setAgain(e.target.value)} />
      </div>
      {message && (
        <p role={message.ok ? "status" : "alert"} className={message.ok ? "text-sm text-emerald-700" : "text-sm text-destructive"}>
          {message.text}
        </p>
      )}
      <Button type="submit" disabled={busy}>
        {busy && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" aria-hidden="true" />}
        Change password
      </Button>
    </form>
  );
}

export default function AccountSecurityPage() {
  const { user } = useUser();
  return (
    <div className="mx-auto max-w-3xl space-y-6 p-4 md:p-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Account security</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Signed in as <span className="font-medium text-foreground">{user?.primaryEmailAddress?.emailAddress}</span>.
        </p>
      </div>
      <Section icon={ShieldCheck} title="Two-step verification">
        <TwoStep />
      </Section>
      <Section icon={KeyRound} title="Password">
        <ChangePassword />
      </Section>
    </div>
  );
}
