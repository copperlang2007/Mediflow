/**
 * Two-step verification with an authenticator app (TOTP), on Identity
 * Platform (ADR 0006).
 *
 * <TotpEnrollment> walks through: confirm password (Google requires a recent
 * sign-in before security changes), scan the QR code (or type the key), enter
 * a code. <Reauthenticate> is the confirm-password step on its own, including
 * the authenticator code when the user already has one.
 */
import { useEffect, useState } from "react";
import QRCode from "qrcode";
import {
  EmailAuthProvider,
  getMultiFactorResolver,
  multiFactor,
  reauthenticateWithCredential,
  TotpMultiFactorGenerator,
  type MultiFactorError,
  type MultiFactorResolver,
  type TotpSecret,
  type User,
} from "@firebase/auth";
import { Loader2, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authErrorMessage, firebaseAuth } from "@/lib/auth/firebase";

const ISSUER = "agencyBRIDGE";

function CodeInput({ id, value, onChange }: { id: string; value: string; onChange: (v: string) => void }) {
  return (
    <Input
      id={id}
      inputMode="numeric"
      autoComplete="one-time-code"
      pattern="[0-9 ]{6,7}"
      maxLength={7}
      required
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

/** Confirm the password (and the authenticator code, if one is set up) before a security change. */
export function Reauthenticate({ user, onDone, action = "Continue" }: { user: User; onDone: () => void; action?: string }) {
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [resolver, setResolver] = useState<MultiFactorResolver | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (resolver) {
        const hint = resolver.hints.find((h) => h.factorId === TotpMultiFactorGenerator.FACTOR_ID);
        if (!hint) throw new Error("no totp hint");
        await resolver.resolveSignIn(TotpMultiFactorGenerator.assertionForSignIn(hint.uid, code.replace(/\s/g, "")));
      } else {
        await reauthenticateWithCredential(user, EmailAuthProvider.credential(user.email ?? "", password));
      }
      onDone();
    } catch (err) {
      const auth = firebaseAuth();
      if ((err as { code?: string }).code === "auth/multi-factor-auth-required" && auth) {
        setResolver(getMultiFactorResolver(auth, err as MultiFactorError));
      } else {
        setError(authErrorMessage(err, "That didn't work. Try again."));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="space-y-3" onSubmit={submit}>
      {!resolver ? (
        <div className="space-y-1.5">
          <Label htmlFor="reauth-password">Your password</Label>
          <Input id="reauth-password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
          <p className="text-xs text-muted-foreground">For your security, confirm your password before changing sign-in settings.</p>
        </div>
      ) : (
        <div className="space-y-1.5">
          <Label htmlFor="reauth-code">Code from your authenticator app</Label>
          <CodeInput id="reauth-code" value={code} onChange={setCode} />
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <Button type="submit" disabled={busy}>
        {busy && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" aria-hidden="true" />}
        {action}
      </Button>
    </form>
  );
}

type Stage = "starting" | "reauth" | "scan" | "error";

/** Set up an authenticator app. Calls `onEnrolled` once Identity Platform has accepted the first code. */
export function TotpEnrollment({ user, onEnrolled }: { user: User; onEnrolled: () => void }) {
  const [stage, setStage] = useState<Stage>("starting");
  const [secret, setSecret] = useState<TotpSecret | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start() {
    setStage("starting");
    setError(null);
    try {
      const session = await multiFactor(user).getSession();
      const s = await TotpMultiFactorGenerator.generateSecret(session);
      setSecret(s);
      setQr(await QRCode.toDataURL(s.generateQrCodeUrl(user.email ?? "", ISSUER), { margin: 1, width: 200 }));
      setStage("scan");
    } catch (err) {
      if ((err as { code?: string }).code === "auth/requires-recent-login") {
        setStage("reauth");
      } else {
        setError(authErrorMessage(err, "Couldn't start setup. Try again."));
        setStage("error");
      }
    }
  }

  useEffect(() => {
    void start();
    // Runs once per user; `start` reads the latest user.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user.uid]);

  async function confirm(e: React.FormEvent) {
    e.preventDefault();
    if (!secret) return;
    setBusy(true);
    setError(null);
    try {
      await multiFactor(user).enroll(TotpMultiFactorGenerator.assertionForEnrollment(secret, code.replace(/\s/g, "")), "Authenticator app");
      onEnrolled();
    } catch (err) {
      setError(authErrorMessage(err, "That code didn't work. Try the current one."));
    } finally {
      setBusy(false);
    }
  }

  if (stage === "starting") {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Preparing setup…
      </p>
    );
  }
  if (stage === "reauth") return <Reauthenticate user={user} onDone={() => void start()} />;
  if (stage === "error") {
    return (
      <div className="space-y-2">
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
        <Button size="sm" variant="outline" onClick={() => void start()}>
          Try again
        </Button>
      </div>
    );
  }

  return (
    <form className="space-y-4" onSubmit={confirm}>
      <ol className="list-decimal space-y-1 pl-5 text-sm">
        <li>Open an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password, Authy…).</li>
        <li>Scan this code, or enter the key below by hand.</li>
        <li>Type the 6-digit code the app shows.</li>
      </ol>
      <div className="flex flex-wrap items-start gap-4">
        {qr && <img src={qr} alt="QR code for your authenticator app" width={200} height={200} className="rounded-md border bg-white" />}
        <div className="min-w-0 flex-1 space-y-1.5">
          <p className="text-xs text-muted-foreground">Key (if you can't scan):</p>
          <code className="block break-all rounded bg-muted px-2 py-1 text-sm">{secret?.secretKey}</code>
        </div>
      </div>
      <div className="max-w-xs space-y-1.5">
        <Label htmlFor="totp-code">6-digit code</Label>
        <CodeInput id="totp-code" value={code} onChange={setCode} />
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <Button type="submit" disabled={busy}>
        {busy ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" aria-hidden="true" /> : <ShieldCheck className="mr-1.5 h-4 w-4" aria-hidden="true" />}
        Turn on two-step verification
      </Button>
    </form>
  );
}
