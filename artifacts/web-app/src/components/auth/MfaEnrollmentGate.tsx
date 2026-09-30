import { useState } from "react";
import { UserProfile, useAuth, useClerk, useSession } from "@clerk/react";
import { Loader2, LogOut, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { BrandMark } from "@/components/brand/BrandMark";

// Clerk's app-wide appearance pins cardBox to the 440px sign-in width; the
// profile needs its sidebar and content pane, so let it fill the column.
const userProfileAppearance = {
  elements: {
    rootBox: "!w-full !block",
    cardBox: "!w-full !max-w-none min-h-[36rem] !rounded-xl !shadow-sm",
  },
};

/**
 * Mandatory MFA: shown instead of the app until the signed-in user has a
 * second factor on their agencyBRIDGE (Clerk) account. The API answers every
 * authenticated route with 403 mfa_required until then (requireAuth), so
 * there is nothing else the user could load.
 *
 * `onEnrolled` re-reads /auth/status. The session token carries the MFA flag,
 * so it is refreshed first; otherwise the old token would still say "off".
 */
export function MfaEnrollmentGate({ onEnrolled }: { onEnrolled: () => Promise<boolean> }) {
  const { session } = useSession();
  const { getToken } = useAuth();
  const { signOut } = useClerk();
  const [checking, setChecking] = useState(false);
  const [stillOff, setStillOff] = useState(false);

  const check = async () => {
    setChecking(true);
    setStillOff(false);
    try {
      await session?.reload();
      await getToken({ skipCache: true });
      setStillOff(!(await onEnrolled()));
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="min-h-[100dvh] bg-gradient-to-br from-navy-900 via-navy-800 to-navy-950 px-4 py-8">
      <div className="mx-auto max-w-5xl space-y-6">
        <div className="flex items-center gap-3 text-white">
          <BrandMark size={40} tone="light" decorative className="rounded-xl" />
          <span className="font-display text-xl font-bold tracking-tight">
            agency<span className="font-extrabold">BRIDGE</span>
          </span>
        </div>

        <div className="rounded-xl border border-amber-300/40 bg-amber-50 p-5 text-amber-950 dark:bg-amber-950/60 dark:text-amber-100">
          <div className="flex items-start gap-3">
            <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
            <div className="space-y-2 text-sm">
              <h1 className="text-base font-semibold">Turn on two-step verification to continue</h1>
              <p>
                agencyBRIDGE holds Medicare beneficiaries' health information, so every account needs a
                second sign-in step. Open <strong>Security</strong> below and add an authenticator app under{" "}
                <strong>Two-step verification</strong>. The code Google sends when you sign in with Google
                does not count here.
              </p>
              <div className="flex flex-wrap items-center gap-2 pt-1">
                <Button size="sm" onClick={check} disabled={checking}>
                  {checking && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
                  I've turned it on
                </Button>
                <Button size="sm" variant="ghost" onClick={() => signOut()}>
                  <LogOut className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" /> Sign out
                </Button>
              </div>
              {stillOff && (
                <p role="alert" className="font-medium">
                  Two-step verification isn't on yet. Finish adding the authenticator app, then try again.
                  If you just added it, sign out and back in.
                </p>
              )}
            </div>
          </div>
        </div>

        <UserProfile routing="hash" appearance={userProfileAppearance} />
      </div>
    </div>
  );
}
