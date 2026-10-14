import { useState } from "react";
import { sendEmailVerification } from "@firebase/auth";
import { Loader2, LogOut, MailCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { authErrorMessage, firebaseAuth } from "@/lib/auth/firebase";
import { useSignOut, useUser } from "@/lib/auth";

/**
 * "Verify your email" (ADR 0006). The server creates an agency, accepts an
 * invitation or links an earlier account only for a verified email, so this
 * comes first. `onVerified` runs once the refreshed sign-in says it is verified.
 */
export function VerifyEmailNotice({ onVerified }: { onVerified: () => void }) {
  const { user, firebaseUser, refresh } = useUser();
  const { signOut } = useSignOut();
  const [busy, setBusy] = useState<"check" | "resend" | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function check() {
    setBusy("check");
    setMessage(null);
    try {
      await refresh();
      // Read after the reload: the hook value above is from before it.
      if (firebaseAuth()?.currentUser?.emailVerified) onVerified();
      else setMessage("Not verified yet. Open the link in the email we sent, then try again.");
    } catch (err) {
      setMessage(authErrorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  async function resend() {
    if (!firebaseUser) return;
    setBusy("resend");
    setMessage(null);
    try {
      await sendEmailVerification(firebaseUser, { url: window.location.href });
      setMessage("Sent. Check your inbox (and spam folder).");
    } catch (err) {
      setMessage(authErrorMessage(err, "Couldn't send the email. Wait a minute and try again."));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-4 text-sm">
      <div className="flex items-start gap-3">
        <MailCheck className="mt-0.5 h-5 w-5 shrink-0 text-accent" aria-hidden="true" />
        <div className="space-y-1">
          <h2 className="text-base font-semibold text-foreground">Verify your email address</h2>
          <p className="text-muted-foreground">
            We sent a link to <span className="font-medium text-foreground break-all">{user?.primaryEmailAddress?.emailAddress}</span>.
            Open it, then come back here.
          </p>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => void check()} disabled={busy !== null}>
          {busy === "check" && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" aria-hidden="true" />}
          I've verified it
        </Button>
        <Button variant="outline" onClick={() => void resend()} disabled={busy !== null}>
          {busy === "resend" && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" aria-hidden="true" />}
          Send it again
        </Button>
        <Button variant="ghost" onClick={() => void signOut()}>
          <LogOut className="mr-1.5 h-4 w-4" aria-hidden="true" /> Use a different email
        </Button>
      </div>
      {message && (
        <p role="status" className="text-muted-foreground">
          {message}
        </p>
      )}
    </div>
  );
}
