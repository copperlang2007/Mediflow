/**
 * Password reset (ADR 0006). Identity Platform emails a reset link; the page
 * it opens sets the new password, then brings the user back to sign in. The
 * same confirmation is shown whether or not the address has a login, so this
 * page can't be used to find out who has an account.
 */
import { useState } from "react";
import { sendPasswordResetEmail } from "@firebase/auth";
import { ArrowLeft, CheckCircle, Loader2, Mail } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AuthFrame } from "@/components/auth/AuthFrame";
import { authErrorMessage, firebaseAuth } from "@/lib/auth/firebase";

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const auth = firebaseAuth();
    if (!auth) return;
    setBusy(true);
    setError(null);
    try {
      await sendPasswordResetEmail(auth, email.trim(), { url: `${window.location.origin}${basePath}/sign-in` });
      setSent(true);
    } catch (err) {
      const code = (err as { code?: string }).code;
      // Don't reveal whether the address has a login.
      if (code === "auth/user-not-found" || code === "auth/invalid-email") setSent(true);
      else setError(authErrorMessage(err, "Couldn't send the reset email. Try again."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthFrame subtitle="Reset your password">
      <div className="w-full space-y-4 rounded-2xl border border-white/10 bg-white/95 p-8 shadow-2xl backdrop-blur-xl dark:bg-card">
        {sent ? (
          <div className="space-y-3 text-center">
            <CheckCircle className="mx-auto h-10 w-10 text-green-600" aria-hidden="true" />
            <h1 className="font-display text-xl font-bold text-foreground">Check your email</h1>
            <p className="text-sm text-muted-foreground">
              If <span className="font-medium text-foreground break-all">{email.trim()}</span> has a login, a reset link is on
              its way. Open it to choose a new password, then sign in.
            </p>
          </div>
        ) : (
          <form className="space-y-4" onSubmit={submit}>
            <div>
              <h1 className="font-display text-xl font-bold text-foreground">Forgot your password?</h1>
              <p className="text-sm text-muted-foreground">Enter your email and we'll send you a link to reset it.</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="reset-email">Email</Label>
              <Input id="reset-email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <Button type="submit" className="w-full" disabled={busy}>
              {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" /> : <Mail className="mr-2 h-4 w-4" aria-hidden="true" />}
              Send reset link
            </Button>
          </form>
        )}
        <a href={`${basePath}/sign-in`} className="flex items-center justify-center gap-1 text-sm font-medium text-accent hover:underline">
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" /> Back to sign in
        </a>
      </div>
    </AuthFrame>
  );
}
