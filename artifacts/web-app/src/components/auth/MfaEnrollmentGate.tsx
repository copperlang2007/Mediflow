import { LogOut, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { BrandMark } from "@/components/brand/BrandMark";
import { TotpEnrollment } from "@/components/auth/TotpEnrollment";
import { useSignOut, useUser } from "@/lib/auth";

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

/**
 * Mandatory MFA: shown instead of the app until the signed-in user signs in
 * with a second factor. The API answers every authenticated route with 403
 * mfa_required until then (requireAuth), so there is nothing else the user
 * could load.
 *
 * Setting up the authenticator app happens right here. The sign-in that is
 * open now was made without a second step, so once the app is set up the
 * user signs in again (password + code) and the API sees MFA on that sign-in.
 */
export function MfaEnrollmentGate() {
  const { firebaseUser } = useUser();
  const { signOut } = useSignOut();
  const afterEnrol = `${basePath}/sign-in?notice=mfa-on&redirect_url=${encodeURIComponent(`${basePath}/dashboard`)}`;

  return (
    <div className="min-h-[100dvh] bg-gradient-to-br from-navy-900 via-navy-800 to-navy-950 px-4 py-8">
      <div className="mx-auto max-w-2xl space-y-6">
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
                agencyBRIDGE holds Medicare beneficiaries' health information, so every account needs a second sign-in
                step: a code from an authenticator app on your phone. Set it up below, then sign in again with your
                password and a code.
              </p>
              <Button size="sm" variant="ghost" onClick={() => void signOut()}>
                <LogOut className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" /> Sign out
              </Button>
            </div>
          </div>
        </div>

        <div className="rounded-xl border bg-card p-6 text-card-foreground shadow-sm">
          {firebaseUser ? (
            <TotpEnrollment user={firebaseUser} onEnrolled={() => void signOut({ redirectUrl: afterEnrol })} />
          ) : (
            <p className="text-sm text-muted-foreground">Sign in again to set up two-step verification.</p>
          )}
        </div>
      </div>
    </div>
  );
}
