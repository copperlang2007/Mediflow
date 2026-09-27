import { lazy, Suspense } from "react";
import { ClerkProvider, SignIn, SignUp, Show, useClerk, useUser, useAuth } from "@clerk/react";
import { publishableKeyFromHost } from "@clerk/react/internal";
import { shadcn } from "@clerk/themes";
import { Switch, Route, useLocation, Router as WouterRouter, Redirect } from "wouter";
import { QueryClientProvider, useQueryClient, useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { queryClient } from "./lib/queryClient";
import { Toaster } from "@/components/ui/toaster";
import { Toaster as SonnerToaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Skeleton } from "@/components/ui/skeleton";
import AppShell from "@/components/layout/AppShell";
import ErrorBoundary from "@/components/ErrorBoundary";
import { DEV_CONSOLE_ENABLED } from "@/lib/devEnabled";
import { ThemeProvider } from "@/components/theme/ThemeToggle";
import { BrandMark } from "@/components/brand/BrandMark";
import Landing from "@/pages/landing";
import { BrandingProvider } from "@/lib/branding/BrandingProvider";

// Route-level lazy loading
const Dashboard = lazy(() => import("@/pages/dashboard"));
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
const MarketingPage = lazy(() => import("@/pages/marketing"));
const CampaignsPage = lazy(() => import("@/pages/campaigns"));
const SettingsPage = lazy(() => import("@/pages/settings"));
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
const ClawbacksPage = lazy(() => import("@/pages/clawbacks"));
const NotFound = lazy(() => import("@/pages/not-found"));
const ForgotPasswordPage = lazy(() => import("@/pages/forgot-password"));
const BillingPage = lazy(() => import("@/pages/billing"));
const TeamPage = lazy(() => import("@/pages/team"));
const AcceptInvitePage = lazy(() => import("@/pages/accept-invite"));
const CreateOrganizationPage = lazy(() => import("@/pages/create-organization"));
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

const clerkPubKey = publishableKeyFromHost(
  window.location.hostname,
  import.meta.env.VITE_CLERK_PUBLISHABLE_KEY,
);

const clerkProxyUrl = import.meta.env.VITE_CLERK_PROXY_URL;

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

function stripBase(path: string): string {
  return basePath && path.startsWith(basePath)
    ? path.slice(basePath.length) || "/"
    : path;
}

const clerkAppearance = {
  theme: shadcn,
  cssLayerName: "clerk",
  options: {
    logoPlacement: "inside" as const,
    logoLinkUrl: basePath || "/",
    logoImageUrl: `${window.location.origin}${basePath}/logo.svg`,
    socialButtonsPlacement: "bottom" as const,
    socialButtonsVariant: "blockButton" as const,
  },
  variables: {
    colorPrimary: "hsl(222, 62%, 15%)",
    colorForeground: "hsl(222, 47%, 11%)",
    colorMutedForeground: "hsl(215, 16%, 42%)",
    colorDanger: "hsl(0, 84%, 60%)",
    colorBackground: "hsl(0, 0%, 100%)",
    colorInput: "hsl(214, 25%, 88%)",
    colorInputForeground: "hsl(222, 47%, 11%)",
    colorNeutral: "hsl(214, 25%, 88%)",
    fontFamily: "'Figtree', system-ui, sans-serif",
    borderRadius: "0.625rem",
  },
  elements: {
    rootBox: "w-full flex justify-center",
    cardBox: "bg-white/95 backdrop-blur-xl rounded-2xl w-[440px] max-w-full overflow-hidden shadow-2xl border border-white/10",
    card: "!shadow-none !border-0 !bg-transparent !rounded-none",
    footer: "!shadow-none !border-0 !bg-transparent !rounded-none",
    headerTitle: "text-foreground font-display font-bold text-xl",
    headerSubtitle: "text-muted-foreground text-sm",
    socialButtonsBlockButtonText: "text-foreground font-medium",
    formFieldLabel: "text-foreground text-sm font-medium",
    footerActionLink: "text-accent font-semibold hover:text-accent/80",
    footerActionText: "text-muted-foreground",
    dividerText: "text-muted-foreground text-xs",
    identityPreviewEditButton: "text-accent",
    formFieldSuccessText: "text-green-600",
    alertText: "text-foreground",
    logoBox: "!hidden",
    logoImage: "h-12 w-auto",
    socialButtonsBlockButton: "border border-border hover:bg-secondary transition-colors",
    formButtonPrimary: "bg-gradient-to-r from-navy-700 to-navy-900 text-white hover:from-navy-800 hover:to-navy-950 font-semibold shadow-md transition-colors",
    formFieldInput: "border-input bg-background text-foreground rounded-md",
    footerAction: "border-t border-border bg-muted/30",
    dividerLine: "bg-border",
    alert: "border border-border rounded-lg",
    otpCodeFieldInput: "border-input bg-background text-foreground",
    main: "px-8 py-6",
  },
};

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

/**
 * Navy backdrop + brand header shared by the Clerk sign-in / sign-up screens
 * (agencyBRIDGE login look). Clerk's own card renders in the middle, so
 * MFA, password reset and every other Clerk step keep working unchanged.
 */
function AuthFrame({ subtitle, children }: { subtitle: string; children: React.ReactNode }) {
  return (
    <div className="relative flex min-h-[100dvh] items-center justify-center overflow-hidden bg-gradient-to-br from-navy-900 via-navy-800 to-navy-950 px-4 py-10">
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute -top-40 -right-40 h-96 w-96 rounded-full bg-blue-500/10 blur-3xl" />
        <div className="absolute -bottom-40 -left-40 h-96 w-96 rounded-full bg-indigo-500/10 blur-3xl" />
      </div>
      <div className="relative flex w-full max-w-md flex-col items-center">
        <a href={basePath || "/"} className="mb-8 flex flex-col items-center text-center" aria-label="agencyBRIDGE home">
          <BrandMark size={64} tone="light" decorative className="mb-4 rounded-2xl shadow-lg shadow-blue-500/30" />
          <span className="font-display text-2xl font-bold tracking-tight text-white">
            agency<span className="font-extrabold">BRIDGE</span>
          </span>
          <span className="mt-1 text-sm text-blue-200/70">{subtitle}</span>
        </a>
        {children}
        <p className="mt-6 text-center text-xs text-blue-200/60">
          Your agency administrator manages who can sign in and what they can see.
        </p>
      </div>
    </div>
  );
}

function SignInPage() {
  return (
    <AuthFrame subtitle="Medicare Agency Management Platform">
      <SignIn
        routing="path"
        path={`${basePath}/sign-in`}
        signUpUrl={`${basePath}/sign-up`}
      />
    </AuthFrame>
  );
}

function SignUpPage() {
  return (
    <AuthFrame subtitle="Set up your agency workspace">
      <SignUp
        routing="path"
        path={`${basePath}/sign-up`}
        signInUrl={`${basePath}/sign-in`}
      />
    </AuthFrame>
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
          The web shell is rendering. Add <code className="rounded bg-black/30 px-2 py-1 text-blue-50">VITE_CLERK_PUBLISHABLE_KEY</code>
          {" "}in the deployment environment to enable the authenticated walkthrough.
        </p>
        <div className="rounded-xl border border-blue-300/20 bg-blue-950/50 p-4 text-left text-sm text-blue-100">
          <p className="font-semibold text-white">Demo readiness checklist</p>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            <li>Set Clerk publishable and secret keys.</li>
            <li>Point <code>ALLOWED_ORIGIN</code> at the Render URL.</li>
            <li>Attach the demo database before exercising API-backed pages.</li>
          </ul>
        </div>
      </div>
    </div>
  );
}

function HomeRedirect() {
  const { isLoaded, isSignedIn } = useAuth();
  // Clerk can be slow or unreachable; the public entry page must still render.
  if (!isLoaded) return <Landing />;
  return isSignedIn ? <Redirect to="/dashboard" /> : <Landing />;
}

function ProtectedLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <Show when="signed-in">
        <ProvisioningGate>
          <BrandingProvider>
            <AppShell>
              <ErrorBoundary>
                <Suspense fallback={<PageLoadingFallback />}>
                  {children}
                </Suspense>
              </ErrorBoundary>
            </AppShell>
          </BrandingProvider>
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
 * Sits between Clerk sign-in and the app shell. A Clerk user with no agencyBRIDGE
 * account is sent to the create-your-agency screen instead of being silently
 * provisioned into an auto-named org — that screen is what makes sign-up
 * genuinely self-serve.
 *
 * Renders nothing but a spinner while the status call is in flight, so the
 * shell never flashes for a user who is about to be redirected.
 */
function ProvisioningGate({ children }: { children: React.ReactNode }) {
  const { isSignedIn, isLoaded } = useUser();
  const { getToken } = useAuth();

  const { data, isLoading, isError } = useQuery({
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
      return res.json() as Promise<{ provisioned: boolean; active: boolean }>;
    },
  });

  if (!isLoaded || isLoading) {
    return <PageLoadingFallback />;
  }

  // A failed status call must not strand the user on a blank screen. Fall
  // through to the shell: its own queries will surface the real error.
  if (isError) return <>{children}</>;

  if (data && !data.provisioned) {
    return (
      <Suspense fallback={<PageLoadingFallback />}>
        <CreateOrganizationPage />
      </Suspense>
    );
  }

  return <>{children}</>;
}

function ClerkQueryClientCacheInvalidator() {
  const { addListener } = useClerk();
  const qc = useQueryClient();
  const prevUserIdRef = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    const unsubscribe = addListener(({ user }) => {
      const userId = user?.id ?? null;
      if (prevUserIdRef.current !== undefined && prevUserIdRef.current !== userId) {
        qc.clear();
      }
      prevUserIdRef.current = userId;
    });
    return unsubscribe;
  }, [addListener, qc]);

  return null;
}

function ClerkProviderWithRoutes() {
  const [, setLocation] = useLocation();

  return (
    <ClerkProvider
      publishableKey={clerkPubKey}
      proxyUrl={clerkProxyUrl}
      appearance={clerkAppearance}
      signInUrl={`${basePath}/sign-in`}
      signUpUrl={`${basePath}/sign-up`}
      localization={{
        signIn: {
          start: {
            title: "Welcome back",
            subtitle: "Sign in to agencyBRIDGE to continue",
          },
        },
        signUp: {
          start: {
            title: "Create your account",
            subtitle: "Start managing your Medicare agency",
          },
        },
      }}
      routerPush={(to) => setLocation(stripBase(to))}
      routerReplace={(to) => setLocation(stripBase(to), { replace: true })}
    >
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <ClerkQueryClientCacheInvalidator />
          <ErrorBoundary>
            <Switch>
              <Route path="/" component={HomeRedirect} />
              <Route path="/sign-in/*?" component={SignInPage} />
              <Route path="/sign-up/*?" component={SignUpPage} />
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
          </ErrorBoundary>
          {/* Radix toaster: used by the few pages on hooks/use-toast. */}
          <Toaster />
          {/* Sonner toaster: most pages call toast() from "sonner". */}
          <SonnerToaster />
        </TooltipProvider>
      </QueryClientProvider>
    </ClerkProvider>
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

  if (!clerkPubKey) {
    return (
      <ThemeProvider>
        <DeploymentConfigRequired />
      </ThemeProvider>
    );
  }

  return (
    <ThemeProvider>
      <WouterRouter base={basePath}>
        <ClerkProviderWithRoutes />
      </WouterRouter>
    </ThemeProvider>
  );
}

export default App;
