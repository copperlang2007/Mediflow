import { UserProfile, useUser } from "@clerk/react";
import { ShieldCheck, ShieldAlert } from "lucide-react";

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

// The app-wide Clerk appearance (App.tsx) pins cardBox to 440px for the
// sign-in card. UserProfile has a sidebar plus a content pane, so at that
// width it collapses and truncates. Let it fill the page column instead.
// Classes from both appearances are applied, hence the `!` overrides.
const userProfileAppearance = {
  elements: {
    rootBox: "!w-full !block",
    cardBox: "!w-full !max-w-none min-h-[40rem] !rounded-xl !shadow-sm",
  },
};

/**
 * Account security: where a user enrolls MFA.
 *
 * Every user must have MFA enrolled in agencyBRIDGE's sign-in provider (Clerk)
 * before the server answers any authenticated route (middlewares/requireAuth.ts);
 * until then the app shows MfaEnrollmentGate instead of this page. A second
 * factor on the Google account used to sign in does not count: the server
 * reads Clerk's own two-factor flag, so the factor has to be added here.
 */
export default function AccountSecurityPage() {
  const { user } = useUser();
  const enrolled = Boolean(user?.twoFactorEnabled);

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-4 md:p-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Account security</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Manage your password, connected accounts and two-step verification.
        </p>
      </div>

      {enrolled ? (
        <div className="flex items-start gap-3 rounded-lg border border-emerald-300 bg-emerald-50 p-4 text-sm text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200">
          <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0" />
          <div>
            <p className="font-medium">Two-step verification is on for your agencyBRIDGE account.</p>
            <p className="mt-1">
              If a page still asks you to enable MFA, sign out and back in once so your session picks it up.
            </p>
          </div>
        </div>
      ) : (
        <div className="flex items-start gap-3 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
          <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0" />
          <div>
            <p className="font-medium">Two-step verification is not set up for your agencyBRIDGE account.</p>
            <p className="mt-1">
              agencyBRIDGE requires it for every account. The code Google sends when you sign in with Google
              protects your Google account only; it does not count here. Open <strong>Security</strong> below,
              add an authenticator app under <strong>Two-step verification</strong>, then sign out and back in.
            </p>
          </div>
        </div>
      )}

      <UserProfile
        routing="path"
        path={`${basePath}/settings/security`}
        appearance={userProfileAppearance}
      />
    </div>
  );
}
