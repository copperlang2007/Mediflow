/**
 * Sign in (ADR 0006): email + password with Identity Platform, then the
 * 6-digit code from the user's authenticator app when they have one enrolled
 * (everyone does, once past the mandatory MFA screen). On success the browser
 * goes to `redirect_url` (same-site paths only) or the dashboard.
 */
import { useState } from "react";
import { useSearch } from "wouter";
import {
  getMultiFactorResolver,
  signInWithEmailAndPassword,
  TotpMultiFactorGenerator,
  type MultiFactorError,
  type MultiFactorResolver,
} from "@firebase/auth";
import { Loader2, LogIn } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AuthFrame, redirectTarget } from "@/components/auth/AuthFrame";
import { authErrorMessage, firebaseAuth } from "@/lib/auth/firebase";

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

export default function SignInPage() {
  const search = useSearch();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [resolver, setResolver] = useState<MultiFactorResolver | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const keep = search ? `?${search}` : "";
  const notice = new URLSearchParams(search).get("notice");

  const done = () => window.location.assign(redirectTarget(search));

  async function submitPassword(e: React.FormEvent) {
    e.preventDefault();
    const auth = firebaseAuth();
    if (!auth) return;
    setBusy(true);
    setError(null);
    try {
      await signInWithEmailAndPassword(auth, email.trim(), password);
      done();
    } catch (err) {
      if ((err as { code?: string }).code === "auth/multi-factor-auth-required") {
        const r = getMultiFactorResolver(auth, err as MultiFactorError);
        if (r.hints.some((h) => h.factorId === TotpMultiFactorGenerator.FACTOR_ID)) {
          setResolver(r);
        } else {
          setError("Your account's second step isn't supported here. Ask your agency administrator to reset it.");
        }
      } else {
        setError(authErrorMessage(err, "Sign-in failed. Try again."));
      }
    } finally {
      setBusy(false);
    }
  }

  async function submitCode(e: React.FormEvent) {
    e.preventDefault();
    if (!resolver) return;
    const hint = resolver.hints.find((h) => h.factorId === TotpMultiFactorGenerator.FACTOR_ID);
    if (!hint) return;
    setBusy(true);
    setError(null);
    try {
      await resolver.resolveSignIn(TotpMultiFactorGenerator.assertionForSignIn(hint.uid, code.replace(/\s/g, "")));
      done();
    } catch (err) {
      setError(authErrorMessage(err, "That code didn't work. Try the current one."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthFrame subtitle="Medicare Agency Management Platform">
      <div className="w-full rounded-2xl border border-white/10 bg-white/95 p-8 shadow-2xl backdrop-blur-xl dark:bg-card">
        {!resolver ? (
          <form className="space-y-4" onSubmit={submitPassword}>
            <div>
              <h1 className="font-display text-xl font-bold text-foreground">Welcome back</h1>
              <p className="text-sm text-muted-foreground">Sign in to agencyBRIDGE to continue</p>
            </div>
            {notice === "mfa-on" && (
              <p role="status" className="rounded-md border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-900">
                Two-step verification is on. Sign in again with your password and a code from your authenticator app.
              </p>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="signin-email">Email</Label>
              <Input id="signin-email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label htmlFor="signin-password">Password</Label>
                <a href={`${basePath}/forgot-password`} className="text-xs font-medium text-accent hover:underline">
                  Forgot password?
                </a>
              </div>
              <Input id="signin-password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
            </div>
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <Button type="submit" className="w-full" disabled={busy}>
              {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" /> : <LogIn className="mr-2 h-4 w-4" aria-hidden="true" />}
              Sign in
            </Button>
            <p className="text-center text-sm text-muted-foreground">
              New here, or first time since the sign-in upgrade?{" "}
              <a href={`${basePath}/sign-up${keep}`} className="font-semibold text-accent hover:underline">
                Create your login
              </a>
            </p>
          </form>
        ) : (
          <form className="space-y-4" onSubmit={submitCode}>
            <div>
              <h1 className="font-display text-xl font-bold text-foreground">Two-step verification</h1>
              <p className="text-sm text-muted-foreground">Enter the 6-digit code from your authenticator app.</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="signin-code">Code</Label>
              <Input
                id="signin-code"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9 ]{6,7}"
                maxLength={7}
                required
                autoFocus
                value={code}
                onChange={(e) => setCode(e.target.value)}
              />
            </div>
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <Button type="submit" className="w-full" disabled={busy}>
              {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
              Verify and sign in
            </Button>
            <button type="button" className="w-full text-center text-sm text-muted-foreground underline-offset-2 hover:underline" onClick={() => { setResolver(null); setCode(""); setError(null); }}>
              Back
            </button>
          </form>
        )}
      </div>
    </AuthFrame>
  );
}
