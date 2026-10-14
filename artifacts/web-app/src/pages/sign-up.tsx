/**
 * Create a login (ADR 0006). Email + password with Identity Platform, then a
 * verification email: the server only creates an agency, accepts an
 * invitation or links an earlier account once the email is verified. Anyone
 * who had an account before the sign-in upgrade signs up again here with the
 * same email; their agency, role and history come back once it is verified.
 */
import { useState } from "react";
import { useSearch } from "wouter";
import { createUserWithEmailAndPassword, sendEmailVerification, updateProfile } from "@firebase/auth";
import { Loader2, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AuthFrame, redirectTarget } from "@/components/auth/AuthFrame";
import { authErrorMessage, firebaseAuth } from "@/lib/auth/firebase";

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");
export const MIN_PASSWORD_LENGTH = 12;

export default function SignUpPage() {
  const search = useSearch();
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const keep = search ? `?${search}` : "";

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const auth = firebaseAuth();
    if (!auth) return;
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`Use at least ${MIN_PASSWORD_LENGTH} characters for your password.`);
      return;
    }
    if (password !== confirm) {
      setError("The two passwords don't match.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { user } = await createUserWithEmailAndPassword(auth, email.trim(), password);
      if (fullName.trim()) await updateProfile(user, { displayName: fullName.trim() });
      const next = redirectTarget(search);
      // The link in the email brings them back to where they were heading.
      await sendEmailVerification(user, { url: `${window.location.origin}${next}` });
      window.location.assign(next);
    } catch (err) {
      setError(authErrorMessage(err, "Couldn't create your login. Try again."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthFrame subtitle="Create your agencyBRIDGE login">
      <form className="w-full space-y-4 rounded-2xl border border-white/10 bg-white/95 p-8 shadow-2xl backdrop-blur-xl dark:bg-card" onSubmit={submit}>
        <div>
          <h1 className="font-display text-xl font-bold text-foreground">Create your login</h1>
          <p className="text-sm text-muted-foreground">
            Already had an account? Use the same email address and everything comes back once you verify it.
          </p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="signup-name">Your name</Label>
          <Input id="signup-name" autoComplete="name" required maxLength={100} value={fullName} onChange={(e) => setFullName(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="signup-email">Work email</Label>
          <Input id="signup-email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="signup-password">Password</Label>
          <Input id="signup-password" type="password" autoComplete="new-password" required minLength={MIN_PASSWORD_LENGTH} value={password} onChange={(e) => setPassword(e.target.value)} />
          <p className="text-xs text-muted-foreground">At least {MIN_PASSWORD_LENGTH} characters.</p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="signup-confirm">Confirm password</Label>
          <Input id="signup-confirm" type="password" autoComplete="new-password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </div>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <Button type="submit" className="w-full" disabled={busy}>
          {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" /> : <UserPlus className="mr-2 h-4 w-4" aria-hidden="true" />}
          Create login
        </Button>
        <p className="text-center text-sm text-muted-foreground">
          Already have a login?{" "}
          <a href={`${basePath}/sign-in${keep}`} className="font-semibold text-accent hover:underline">
            Sign in
          </a>
        </p>
      </form>
    </AuthFrame>
  );
}
