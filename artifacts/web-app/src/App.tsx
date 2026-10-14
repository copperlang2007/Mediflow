import { lazy, Suspense } from "react";
import { AuthProvider, Show, authConfigured, useAuth, useSignOut, useUser } from "@/lib/auth";
import { IS_DEMO_BUILD } from "@/lib/demo/isDemo";
import { VerifyEmailNotice } from "@/components/auth/VerifyEmailNotice";
import { Switch, Route, useLocation, Router as WouterRouter, Redirect } from "wouter";
import { QueryClientProvider, useQueryClient, useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { queryClient } from "./lib/queryClient";
import { Toaster } from "@/components/ui/toaster";
import { Toaster as SonnerToaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Skeleton } from "@/components/ui/skeleton";
import { useGetMe } from "@workspace/api-client-react";
import { effectiveViewAsOrg, isPlatformView, isPlatformPath, type Role } from "@/components/layout/nav-config";
import AppShell from "@/components/layout/AppShell";
import ErrorBoundary from "@/components/ErrorBoundary";
import { DEV_CONSOLE_ENABLED } from "@/lib/devEnabled";
import { pendingInvitePath } from "@/lib/pendingInvite";
import { ThemeProvider } from "@/components/theme/ThemeToggle";
import { BrandMark } from "@/components/brand/BrandMark";
import Landing from "@/pages/landing";
import { BrandingProvider } from "@/lib/branding/BrandingProvider";
import { MfaEnrollmentGate } from "@/components/auth/MfaEnrollmentGate";
import { SessionGuard } from "@/components/auth/SessionGuard";

// Route-level lazy loading
const AgencyDashboard = lazy(() => import("@/pages/dashboard"));
const SuperAdminDashboard = lazy(() => import("@/pages/super-admin-dashboard"));
const AgentsPage = lazy(() => import("@/pages/agents"));
const AgentProfilePage = lazy(() => import("@/pages/agent-profile"));
const LicensingPage = lazy(() => import("@/pages/licensing"));
const CertificationsPage = lazy(() => import("@/pages/certifications"));
const CRMPage = lazy(() => import("@/pages/crm"));
const ContactDetailPage = lazy(() => import("@/pages/crm-contact"));
const TasksPage = lazy(() => import("@/pages/tasks"));
const DocumentsPage = lazy(() => import("@/pages/documents"));
const CompliancePage = lazy(() => import("@/pages/compliance"));
const ComplaintsPage = lazy(() => import("@/pages/complaints"));
const CallScoringPage = lazy(() => import("@/pages/call-scoring"));
const MarketingPage = lazy(() => import("@/pages/marketing"));
const CampaignsPage = lazy(() => import("@/pages/campaigns"));
const SettingsPage = lazy(() => import("@/pages/settings"));
const AccountSecurityPage = lazy(() => import("@/pages/account-security"));
const RenewalsPage = lazy(() => import("@/pages/renewals"));
const AepCockpitPage = lazy(() => import("@/pages/aep-cockpit"));
const ChurnRiskPage = lazy(() => import("@/pages/churn-risk"));
const ReportsPage = lazy(() => import("@/pages/reports"));
const AdminCompliancePage = lazy(() => import("@/pages/admin-compliance"));
const AdminHealthPage = lazy(() => import("@/pages/admin-health"));
const AdminQueuePage = lazy(() => import("@/pages/admin-queue"));
const QueueWallboardPage = lazy(() => import("@/pages/queue-wallboard"));
const AdminOnboardingPage = lazy(() => import("@/pages/admin-onboarding"));
const AdminCarriersPage = lazy(() => import("@/pages/admin-carriers"));
const ReadinessPage = lazy(() => import("@/pages/readiness"));
const LeaderboardPage = lazy(() => import("@/pages/leaderboard"));
const OnboardingPage = lazy(() => import("@/pages/onboarding"));
const SignPage = lazy(() => import("@/pages/sign"));
const DataMigrationPage = lazy(() => import("@/pages/data-migration"));
const CommissionsPage = lazy(() => import("@/pages/commissions"));
const CommissionStatementPage = lazy(() => import("@/pages/commission-statement"));
const MyCommissionsPage = lazy(() => import("@/pages/my-commissions"));
const MyClientsPage = lazy(() => import("@/pages/my-clients"));
const ClawbacksPage = lazy(() => import("@/pages/clawbacks"));
const NotFound = lazy(() => import("@/pages/not-found"));
const ForgotPasswordPage = lazy(() => import("@/pages/forgot-password"));
const BillingPage = lazy(() => import("@/pages/billing"));
const TeamPage = lazy(() => import("@/pages/team"));
const AcceptInvitePage = lazy(() => import("@/pages/accept-invite"));
const CreateOrganizationPage = lazy(() => import("@/pages/create-organization"));
const SignInPage = lazy(() => import("@/pages/sign-in"));
const SignUpPage = lazy(() => import("@/pages/sign-up"));
// --- stage2/portal-dialer ---
const ClientPortalPage = lazy(() => import("@/pages/ClientPortalPage"));
const DialerPage = lazy(() => import("@/pages/DialerPage"));
const SupervisorPage = lazy(() => import("@/pages/SupervisorPage"));
const QuotingPage = lazy(() => import("@/pages/QuotingPage"));
// --- stage2/new-pages-core ---
const PoliciesPage = lazy(() => import("@/pages/policies"));
const WorkflowsPage = lazy(() => import("@/pages/workflows"));
const ReconciliationPage = lazy(() => import("@/pages/reconciliation"));
const AgentBackofficePage = lazy(() => import("@/pages/agent-backoffice"));
const DataToolsPage = lazy(() => import("@/pages/data-tools"));
const KnowledgeBasePage = lazy(() => import("@/pages/knowledge-base"));
// --- stage2/calendar-branding ---
const CalendarPage = lazy(() => import("@/pages/calendar"));
const BrandingPage = lazy(() => import("@/pages/branding"));
const WorkspacesPage = lazy(() => import("@/pages/workspaces"));

// Dev console pages are only imported when the build-time flag is set, so
// production bundles never include this code.
const DevConsolePage = DEV_CONSOLE_ENABLED
  ? lazy(() => import("@/pages/dev"))
  : null;
const DevOpsPage = DEV_CONSOLE_ENABLED
  ? lazy(() => import("@/pages/dev/ops"))
  : null;
const DevDbPage = DEV_CONSOLE_ENABLED
  ? lazy(() => import("@/pages/dev/db"))
  : null;
const DevEnvPage = DEV_CONSOLE_ENABLED
  ? lazy(() => import("@/pages/dev/env"))
  : null;
const DevFeatureBuilderPage = DEV_CONSOLE_ENABLED
  ? lazy(() => import("@/pages/dev/feature-builder"))
  : null;

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

function PageLoadingFallback() {
  return (
    <div className="p-6 space-y-4 max-w-7xl mx-auto">
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-4 w-64" />
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4 mt-6">
        {[...Array(4)].map((_, i) => <Skeleton key={i} className="h-28 rounded-xl" />)}
      </div>
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6 mt-2">
        {[...Array(3)].map((_, i) => <Skeleton key={i} className="h-56 rounded-xl" />)}
      </div>
    </div>
  );
}

function DeploymentConfigRequired() {
  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-gradient-to-br from-navy-900 via-navy-800 to-navy-950 px-4">
      <div className="max-w-xl rounded-2xl border border-white/10 bg-white/10 p-8 text-center text-white shadow-2xl backdrop-blur">
        <div className="flex justify-center mb-6">
          <BrandMark size={64} tone="light" className="rounded-2xl" />
        </div>
        <p className="mb-3 text-sm font-semibold uppercase tracking-[0.24em] text-blue-200">Early access deployment</p>
        <h1 className="mb-4 text-4xl font-bold tracking-tight">agencyBRIDGE is deployed</h1>
        <p className="mb-6 text-base leading-7 text-blue-100">
          The web shell is rendering. Add the sign-in settings{" "}
          <code className="rounded bg-black/30 px-2 py-1 text-blue-50">VITE_FIREBASE_API_KEY</code>,{" "}
          <code className="rounded bg-black/30 px-2 py-1 text-blue-50">VITE_FIREBASE_AUTH_DOMAIN</code> and{" "}
          <code className="rounded bg-black/30 px-2 py-1 text-blue-50">VITE_FIREBASE_PROJECT_ID</code>{" "}
          to the build to enable sign-in.
        </p>
        <div className="rounded-xl border border-blue-300/20 bg-blue-950/50 p-4 text-left text-sm text-blue-100">
          <p className="font-semibold text-white">Demo readiness checklist</p>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            <li>Set up Identity Platform (email/password, TOTP) in the Google Cloud project.</li>
            <li>Point <code>ALLOWED_ORIGIN</code> at the Render URL.</li>
            <li>Attach the demo database before exercising API-backed pages.</li>
          </ul>
        </div>
      </div>
    </div>
  );
}

/** Who is looking, and whether they are in the platform view (super admin, no agency open). */
function usePlatformState() {
  const { data: me, isLoading, isError, refetch } = useGetMe();
  let stored: string | null = null;
  try {
    stored = localStorage.getItem("mediflow:view-as-org");
  } catch {
    // storage unavailable — same as not viewing an agency
  }
  const viewAsOrg = effectiveViewAsOrg(stored, me?.orgId);
  if (stored && !viewAsOrg) {
    // A leftover key for the user's own agency; drop it so requests stop carrying it.
    try {
      localStorage.removeItem("mediflow:view-as-org");
    } catch {
      // nothing to clear
    }
  }
  const role = (me?.role ?? null) as Role | null;
  return {
    isLoading,
    // Without a known role we can't tell a super admin from anyone else.
    failed: isError && !me,
    refetch,
    platformView: isPlatformView(role, Boolean(viewAsOrg)),
  };
}

function AccountLoadError({ onRetry }: { onRetry: () => void }) {
  const { signOut } = useSignOut();
  return (
    <div role="alert" className="p-8 text-center text-sm text-muted-foreground">
      Could not load your account.{" "}
      <button type="button" className="underline underline-offset-2" onClick={onRetry}>
        Try again
      </button>
      {" · "}
      <button
        type="button"
        className="underline underline-offset-2"
        onClick={() => {
          try {
            localStorage.removeItem("mediflow:view-as-org");
          } catch {
            // storage unavailable — nothing to clear
          }
          void signOut();
        }}
      >
        Sign out
      </button>
    </div>
  );
}

/**
 * /dashboard: a super admin gets the platform overview; viewing an agency (or
 * any other role) gets that agency's dashboard.
 */
function Dashboard() {
  const state = usePlatformState();
  if (state.isLoading) return <PageLoadingFallback />;
  if (state.failed) return <AccountLoadError onRetry={() => void state.refetch()} />;
  return state.platformView ? <SuperAdminDashboard /> : <AgencyDashboard />;
}

function HomeRedirect() {
  const { isLoaded, isSignedIn } = useAuth();
  // Sign-in state can take a moment; the public entry page must still render.
  if (!isLoaded) return <Landing />;
  return isSignedIn ? <Redirect to="/dashboard" /> : <Landing />;
}

/**
 * A super admin outside any agency may only open platform pages. A bookmarked
 * agency URL (e.g. /crm) would otherwise read and edit their home agency while
 * the screen says "platform".
 */
function PlatformRouteGuard({ children }: { children: React.ReactNode }) {
  const state = usePlatformState();
  const [location] = useLocation();
  // Platform pages (incl. /dashboard) never need the guard; everything else
  // waits for the role so an agency page can't mount under the platform view.
  if (isPlatformPath(location)) return <>{children}</>;
  if (state.isLoading) return <PageLoadingFallback />;
  if (state.failed) return <AccountLoadError onRetry={() => void state.refetch()} />;
  if (state.platformView) return <Redirect to="/dashboard" />;
  return <>{children}</>;
}

/** Platform view has no agency of its own, so it must not wear one agency's branding. */
function PlatformAwareBranding({ children }: { children: React.ReactNode }) {
  const { platformView } = usePlatformState();
  return <BrandingProvider disabled={platformView}>{children}</BrandingProvider>;
}

/**
 * Nothing in the signed-in area renders (or fetches) until we know who the
 * user is. Otherwise the shell, branding and per-page lookups start out as if
 * for an agency user and then flip once the role arrives.
 */
function RoleGate({ children }: { children: React.ReactNode }) {
  const state = usePlatformState();
  if (state.isLoading) return <PageLoadingFallback />;
  if (state.failed) return <AccountLoadError onRetry={() => void state.refetch()} />;
  return <>{children}</>;
}

function ProtectedLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <Show when="signed-in">
        <ProvisioningGate>
          <RoleGate>
            <PlatformAwareBranding>
              <AppShell>
                <ErrorBoundary>
                  <PlatformRouteGuard>
                    <Suspense fallback={<PageLoadingFallback />}>
                      {children}
                    </Suspense>
                  </PlatformRouteGuard>
                </ErrorBoundary>
              </AppShell>
            </PlatformAwareBranding>
          </RoleGate>
        </ProvisioningGate>
      </Show>
      <Show when="signed-out">
        <Redirect to="/" />
      </Show>
    </>
  );
}

/**
 * Provisioning gate.
 *
 * Sits between sign-in and the app shell. A signed-in person with no
 * agencyBRIDGE account is sent to the create-your-agency screen instead of
 * being silently provisioned into an auto-named org — that screen is what
 * makes sign-up genuinely self-serve. An email that is not verified yet comes
 * first: the server creates or links an account only for a verified email.
 *
 * Renders nothing but a spinner while the status call is in flight, so the
 * shell never flashes for a user who is about to be redirected.
 */
function ProvisioningGate({ children }: { children: React.ReactNode }) {
  const { isSignedIn, isLoaded } = useUser();
  const { getToken } = useAuth();

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ["auth", "status"],
    enabled: isLoaded && Boolean(isSignedIn),
    // The answer changes exactly once per account (at provisioning) and the
    // create-agency screen clears the cache itself, so there is nothing to
    // gain from refetching on every window focus.
    staleTime: Infinity,
    retry: 1,
    queryFn: async () => {
      const token = await getToken();
      const base = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";
      const res = await fetch(`${base}/api/auth/status`, {
        credentials: "include",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) throw new Error("Could not load account status");
      return res.json() as Promise<{ provisioned: boolean; active: boolean; emailVerified?: boolean; mfaRequired?: boolean; mfaEnrolled?: boolean }>;
    },
  });

  if (!isLoaded || isLoading) {
    return <PageLoadingFallback />;
  }

  // A failed status call must not strand the user on a blank screen. Fall
  // through to the shell: its own queries will surface the real error.
  if (isError) return <>{children}</>;

  if (data && !data.provisioned) {
    // Someone who followed an invitation link and then signed up has not lost
    // their invitation just because sign-up dropped the URL. Creating an agency
    // here would make the invitation unusable ("already belongs to an agency").
    const inviteBack = pendingInvitePath();
    if (inviteBack) return <Redirect to={inviteBack} />;
    if (!data.emailVerified) {
      return (
        <div className="flex min-h-[100dvh] items-center justify-center bg-gradient-to-br from-navy-900 via-navy-800 to-navy-950 px-4">
          <div className="w-full max-w-md rounded-2xl border bg-card p-6 text-card-foreground shadow-2xl">
            <VerifyEmailNotice onVerified={() => void refetch()} />
          </div>
        </div>
      );
    }
    return (
      <Suspense fallback={<PageLoadingFallback />}>
        <CreateOrganizationPage />
      </Suspense>
    );
  }

  // Mandatory MFA: the API refuses every authenticated route until the user
  // has a second factor, so show enrollment instead of an app full of 403s.
  if (data?.mfaRequired && !data.mfaEnrolled) {
    return <MfaEnrollmentGate />;
  }

  return <>{children}</>;
}

/** Drops every cached answer when the signed-in person changes, so nobody sees the previous user's data. */
function SignedInUserCacheInvalidator() {
  const { userId } = useAuth();
  const qc = useQueryClient();
  const prevUserIdRef = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    if (prevUserIdRef.current !== undefined && prevUserIdRef.current !== userId) {
      qc.clear();
    }
    prevUserIdRef.current = userId;
  }, [userId, qc]);

  return null;
}

function AppRoutes() {
  return (
    <AuthProvider>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <SignedInUserCacheInvalidator />
          <ErrorBoundary>
            <SessionGuard>
            <Switch>
              <Route path="/" component={HomeRedirect} />
              <Route path="/sign-in/*?">
                <Suspense fallback={null}><SignInPage /></Suspense>
              </Route>
              <Route path="/sign-up/*?">
                <Suspense fallback={null}><SignUpPage /></Suspense>
              </Route>
              {/*
                Deliberately OUTSIDE ProtectedLayout. An invitee has no agencyBRIDGE
                account yet, so the provisioning gate would send them to the
                create-your-agency screen — and they would found a second, empty
                org instead of joining the one that invited them.
              */}
              <Route path="/accept-invite">
                <Suspense fallback={null}><AcceptInvitePage /></Suspense>
              </Route>
              <Route path="/forgot-password">
                <Suspense fallback={null}><ForgotPasswordPage /></Suspense>
              </Route>
              <Route path="/dashboard">
                <ProtectedLayout><Dashboard /></ProtectedLayout>
              </Route>
              <Route path="/agents/:id">
                <ProtectedLayout><AgentProfilePage /></ProtectedLayout>
              </Route>
              <Route path="/agents">
                <ProtectedLayout><AgentsPage /></ProtectedLayout>
              </Route>
              <Route path="/licensing">
                <ProtectedLayout><LicensingPage /></ProtectedLayout>
              </Route>
              <Route path="/certifications">
                <ProtectedLayout><CertificationsPage /></ProtectedLayout>
              </Route>
              <Route path="/crm/contacts/:id">
                <ProtectedLayout><ContactDetailPage /></ProtectedLayout>
              </Route>
              <Route path="/crm">
                <ProtectedLayout><CRMPage /></ProtectedLayout>
              </Route>
              <Route path="/tasks">
                <ProtectedLayout><TasksPage /></ProtectedLayout>
              </Route>
              <Route path="/documents">
                <ProtectedLayout><DocumentsPage /></ProtectedLayout>
              </Route>
              <Route path="/renewals">
                <ProtectedLayout><RenewalsPage /></ProtectedLayout>
              </Route>
              <Route path="/complaints">
                <ProtectedLayout><ComplaintsPage /></ProtectedLayout>
              </Route>
              <Route path="/call-scoring">
                <ProtectedLayout><CallScoringPage /></ProtectedLayout>
              </Route>
              <Route path="/marketing">
                <ProtectedLayout><MarketingPage /></ProtectedLayout>
              </Route>
              <Route path="/campaigns">
                <ProtectedLayout><CampaignsPage /></ProtectedLayout>
              </Route>
              <Route path="/aep">
                <ProtectedLayout><AepCockpitPage /></ProtectedLayout>
              </Route>
              <Route path="/churn">
                <ProtectedLayout><ChurnRiskPage /></ProtectedLayout>
              </Route>
              {/* One automation page: the old /automations URL now lands on Workflow Automation. */}
              <Route path="/automations">
                <Redirect to="/workflows" replace />
              </Route>
              <Route path="/reports">
                <ProtectedLayout><ReportsPage /></ProtectedLayout>
              </Route>
              <Route path="/settings/billing">
                <ProtectedLayout><BillingPage /></ProtectedLayout>
              </Route>
              <Route path="/settings/security/*?">
                <ProtectedLayout><AccountSecurityPage /></ProtectedLayout>
              </Route>
              <Route path="/settings/team">
                <ProtectedLayout><TeamPage /></ProtectedLayout>
              </Route>
              {/*
                ADMIN ROUTES — convention going forward: `/admin/<feature>` (nested).
                Pre-existing `/admin-<feature>` routes (admin-onboarding, admin-carriers,
                admin-compliance) are NOT being migrated for URL stability — links may be
                bookmarked or embedded in onboarding emails. New admin routes should use
                `/admin/<feature>`.
              */}
              <Route path="/admin-compliance">
                <ProtectedLayout><AdminCompliancePage /></ProtectedLayout>
              </Route>
              <Route path="/admin/health">
                <ProtectedLayout><AdminHealthPage /></ProtectedLayout>
              </Route>
              <Route path="/admin/queue/wall">
                <ProtectedLayout><QueueWallboardPage /></ProtectedLayout>
              </Route>
              <Route path="/admin/queue">
                <ProtectedLayout><AdminQueuePage /></ProtectedLayout>
              </Route>
              <Route path="/readiness">
                <ProtectedLayout><ReadinessPage /></ProtectedLayout>
              </Route>
              <Route path="/leaderboard">
                <ProtectedLayout><LeaderboardPage /></ProtectedLayout>
              </Route>
              <Route path="/admin-onboarding/:agentId">
                <ProtectedLayout><AdminOnboardingPage /></ProtectedLayout>
              </Route>
              <Route path="/admin-onboarding">
                <ProtectedLayout><AdminOnboardingPage /></ProtectedLayout>
              </Route>
              <Route path="/admin-carriers">
                <ProtectedLayout><AdminCarriersPage /></ProtectedLayout>
              </Route>
              <Route path="/onboarding">
                <ProtectedLayout><OnboardingPage /></ProtectedLayout>
              </Route>
              <Route path="/sign/:envelopeId">
                <ProtectedLayout><SignPage /></ProtectedLayout>
              </Route>
              <Route path="/data-migration">
                <ProtectedLayout><DataMigrationPage /></ProtectedLayout>
              </Route>
              <Route path="/compliance">
                <ProtectedLayout><CompliancePage /></ProtectedLayout>
              </Route>
              <Route path="/my-commissions">
                <ProtectedLayout><MyCommissionsPage /></ProtectedLayout>
              </Route>
              <Route path="/commissions/statements/:id">
                <ProtectedLayout><CommissionStatementPage /></ProtectedLayout>
              </Route>
              <Route path="/commissions">
                <ProtectedLayout><CommissionsPage /></ProtectedLayout>
              </Route>
              <Route path="/clawbacks">
                <ProtectedLayout><ClawbacksPage /></ProtectedLayout>
              </Route>
              {/* --- stage2/portal-dialer --- */}
              <Route path="/client-portal">
                <ProtectedLayout><ClientPortalPage /></ProtectedLayout>
              </Route>
              <Route path="/dialer">
                <ProtectedLayout><DialerPage /></ProtectedLayout>
              </Route>
              <Route path="/supervisor">
                <ProtectedLayout><SupervisorPage /></ProtectedLayout>
              </Route>
              <Route path="/quoting">
                <ProtectedLayout><QuotingPage /></ProtectedLayout>
              </Route>
              <Route path="/settings">
                <ProtectedLayout><SettingsPage /></ProtectedLayout>
              </Route>
              {/* --- stage2/new-pages-core --- */}
              <Route path="/policies">
                <ProtectedLayout><PoliciesPage /></ProtectedLayout>
              </Route>
              <Route path="/workflows">
                <ProtectedLayout><WorkflowsPage /></ProtectedLayout>
              </Route>
              <Route path="/reconciliation">
                <ProtectedLayout><ReconciliationPage /></ProtectedLayout>
              </Route>
              <Route path="/my-clients">
                <ProtectedLayout><MyClientsPage /></ProtectedLayout>
              </Route>
              <Route path="/backoffice">
                <ProtectedLayout><AgentBackofficePage /></ProtectedLayout>
              </Route>
              <Route path="/data-tools">
                <ProtectedLayout><DataToolsPage /></ProtectedLayout>
              </Route>
              <Route path="/knowledge-base">
                <ProtectedLayout><KnowledgeBasePage /></ProtectedLayout>
              </Route>
              {/* --- stage2/calendar-branding --- */}
              <Route path="/calendar">
                <ProtectedLayout><CalendarPage /></ProtectedLayout>
              </Route>
              <Route path="/branding">
                <ProtectedLayout><BrandingPage /></ProtectedLayout>
              </Route>
              <Route path="/admin/workspaces">
                <ProtectedLayout><WorkspacesPage /></ProtectedLayout>
              </Route>
              {DEV_CONSOLE_ENABLED && DevOpsPage && (
                <Route path="/dev/ops">
                  <ProtectedLayout><DevOpsPage /></ProtectedLayout>
                </Route>
              )}
              {DEV_CONSOLE_ENABLED && DevDbPage && (
                <Route path="/dev/db">
                  <ProtectedLayout><DevDbPage /></ProtectedLayout>
                </Route>
              )}
              {DEV_CONSOLE_ENABLED && DevEnvPage && (
                <Route path="/dev/env">
                  <ProtectedLayout><DevEnvPage /></ProtectedLayout>
                </Route>
              )}
              {DEV_CONSOLE_ENABLED && DevFeatureBuilderPage && (
                <Route path="/dev/feature-builder">
                  <ProtectedLayout><DevFeatureBuilderPage /></ProtectedLayout>
                </Route>
              )}
              {DEV_CONSOLE_ENABLED && DevConsolePage && (
                <Route path="/dev">
                  <ProtectedLayout><DevConsolePage /></ProtectedLayout>
                </Route>
              )}
              <Route>
                <Suspense fallback={null}>
                  <NotFound />
                </Suspense>
              </Route>
            </Switch>
            </SessionGuard>
          </ErrorBoundary>
          {/* Radix toaster: used by the few pages on hooks/use-toast. */}
          <Toaster />
          {/* Pages call `toast` from "sonner" directly; this is its only mount. */}
          <SonnerToaster />
        </TooltipProvider>
      </QueryClientProvider>
    </AuthProvider>
  );
}

function App() {
  // Reset the one-time stale-asset retry only after React has actually
  // committed. Clearing it in the entry module can create a reload loop.
  useEffect(() => {
    try {
      sessionStorage.removeItem("mediflow:staleAssetReload");
    } catch {
      // Storage can be unavailable in restricted browser contexts.
    }
  }, []);

  if (!authConfigured && !IS_DEMO_BUILD) {
    return (
      <ThemeProvider>
        <DeploymentConfigRequired />
      </ThemeProvider>
    );
  }

  return (
    <ThemeProvider>
      <WouterRouter base={basePath}>
        <AppRoutes />
      </WouterRouter>
    </ThemeProvider>
  );
}

export default App;
