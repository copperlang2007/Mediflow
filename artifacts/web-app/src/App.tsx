import { lazy, Suspense } from "react";
import { ClerkProvider, SignIn, SignUp, Show, useClerk, useUser, useAuth } from "@clerk/react";
import { publishableKeyFromHost } from "@clerk/react/internal";
import { shadcn } from "@clerk/themes";
import { Switch, Route, useLocation, Router as WouterRouter, Redirect } from "wouter";
import { QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { queryClient } from "./lib/queryClient";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Skeleton } from "@/components/ui/skeleton";
import AppShell from "@/components/layout/AppShell";
import ErrorBoundary from "@/components/ErrorBoundary";
import { DEV_CONSOLE_ENABLED } from "@/lib/devEnabled";

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
const SettingsPage = lazy(() => import("@/pages/settings"));
const RenewalsPage = lazy(() => import("@/pages/renewals"));
const AepCockpitPage = lazy(() => import("@/pages/aep-cockpit"));
const ChurnRiskPage = lazy(() => import("@/pages/churn-risk"));
const AutomationsPage = lazy(() => import("@/pages/automations"));
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
    colorPrimary: "hsl(221, 83%, 43%)",
    colorForeground: "hsl(222, 47%, 11%)",
    colorMutedForeground: "hsl(215, 16%, 47%)",
    colorDanger: "hsl(0, 84%, 60%)",
    colorBackground: "hsl(0, 0%, 100%)",
    colorInput: "hsl(215, 20%, 88%)",
    colorInputForeground: "hsl(222, 47%, 11%)",
    colorNeutral: "hsl(215, 20%, 88%)",
    fontFamily: "'Inter', sans-serif",
    borderRadius: "0.5rem",
  },
  elements: {
    rootBox: "w-full flex justify-center",
    cardBox: "bg-white rounded-2xl w-[440px] max-w-full overflow-hidden shadow-xl border border-border",
    card: "!shadow-none !border-0 !bg-transparent !rounded-none",
    footer: "!shadow-none !border-0 !bg-transparent !rounded-none",
    headerTitle: "text-foreground font-semibold text-xl",
    headerSubtitle: "text-muted-foreground text-sm",
    socialButtonsBlockButtonText: "text-foreground font-medium",
    formFieldLabel: "text-foreground text-sm font-medium",
    footerActionLink: "text-primary font-medium hover:text-primary/80",
    footerActionText: "text-muted-foreground",
    dividerText: "text-muted-foreground text-xs",
    identityPreviewEditButton: "text-primary",
    formFieldSuccessText: "text-green-600",
    alertText: "text-foreground",
    logoBox: "flex justify-center py-2",
    logoImage: "h-12 w-auto",
    socialButtonsBlockButton: "border border-border hover:bg-secondary transition-colors",
    formButtonPrimary: "bg-primary text-primary-foreground hover:bg-primary/90 font-medium transition-colors",
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

function SignInPage() {
  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-gradient-to-br from-slate-900 via-blue-950 to-slate-900 px-4">
      <SignIn
        routing="path"
        path={`${basePath}/sign-in`}
        signUpUrl={`${basePath}/sign-up`}
      />
    </div>
  );
}

function SignUpPage() {
  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-gradient-to-br from-slate-900 via-blue-950 to-slate-900 px-4">
      <SignUp
        routing="path"
        path={`${basePath}/sign-up`}
        signInUrl={`${basePath}/sign-in`}
      />
    </div>
  );
}

function DeploymentConfigRequired() {
  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-gradient-to-br from-slate-900 via-blue-950 to-slate-900 px-4">
      <div className="max-w-xl rounded-2xl border border-white/10 bg-white/10 p-8 text-center text-white shadow-2xl backdrop-blur">
        <div className="flex justify-center mb-6">
          <img src={`${basePath}/logo.svg`} alt="MediFlow" className="h-16 w-16" />
        </div>
        <p className="mb-3 text-sm font-semibold uppercase tracking-[0.24em] text-blue-200">Early access deployment</p>
        <h1 className="mb-4 text-4xl font-bold tracking-tight">MediFlow is deployed</h1>
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

function Landing() {
  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-gradient-to-br from-slate-900 via-blue-950 to-slate-900 px-4">
      <div className="text-center text-white max-w-lg">
        <div className="flex justify-center mb-6">
          <img src={`${basePath}/logo.svg`} alt="MediFlow" className="h-16 w-16" />
        </div>
        <h1 className="text-4xl font-bold mb-3 tracking-tight">MediFlow</h1>
        <p className="text-lg text-blue-200 mb-8">
          Medicare Sales Agency Platform — Agent lifecycle, CRM, compliance, and automation in one place.
        </p>
        <div className="flex flex-col sm:flex-row gap-3 justify-center">
          <a
            href={`${basePath}/sign-in`}
            className="px-6 py-3 rounded-lg bg-white text-blue-900 font-semibold hover:bg-blue-50 transition-colors"
          >
            Sign In
          </a>
          <a
            href={`${basePath}/sign-up`}
            className="px-6 py-3 rounded-lg bg-blue-600 text-white font-semibold hover:bg-blue-700 border border-blue-500 transition-colors"
          >
            Get Started
          </a>
        </div>
      </div>
    </div>
  );
}

function HomeRedirect() {
  return (
    <>
      <Show when="signed-in">
        <Redirect to="/dashboard" />
      </Show>
      <Show when="signed-out">
        <Landing />
      </Show>
    </>
  );
}

function ProtectedLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <Show when="signed-in">
        <AppShell>
          <ErrorBoundary>
            <Suspense fallback={<PageLoadingFallback />}>
              {children}
            </Suspense>
          </ErrorBoundary>
        </AppShell>
      </Show>
      <Show when="signed-out">
        <Redirect to="/" />
      </Show>
    </>
  );
}

function ProvisionUser() {
  const { user, isSignedIn } = useUser();
  const { getToken } = useAuth();
  const qc = useQueryClient();

  useEffect(() => {
    if (!isSignedIn || !user) return;

    let cancelled = false;
    const run = async () => {
      try {
        const token = await getToken();
        const base = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";
        await fetch(`${base}/api/auth/provision`, {
          method: "POST",
          credentials: "include",
          headers: {
            "Content-Type": "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({
            email: user.primaryEmailAddress?.emailAddress ?? "",
            fullName:
              user.fullName ??
              `${user.firstName ?? ""} ${user.lastName ?? ""}`.trim(),
          }),
        });
        if (!cancelled) {
          void qc.invalidateQueries({ queryKey: ["users", "me"] });
        }
      } catch {
        // will retry on the next sign-in
      }
    };

    void run();
    return () => {
      cancelled = true;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSignedIn, user?.id]);

  return null;
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
            subtitle: "Sign in to MediFlow to continue",
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
          <ProvisionUser />
          <ClerkQueryClientCacheInvalidator />
          <ErrorBoundary>
            <Switch>
              <Route path="/" component={HomeRedirect} />
              <Route path="/sign-in/*?" component={SignInPage} />
              <Route path="/sign-up/*?" component={SignUpPage} />
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
              <Route path="/aep">
                <ProtectedLayout><AepCockpitPage /></ProtectedLayout>
              </Route>
              <Route path="/churn">
                <ProtectedLayout><ChurnRiskPage /></ProtectedLayout>
              </Route>
              <Route path="/automations">
                <ProtectedLayout><AutomationsPage /></ProtectedLayout>
              </Route>
              <Route path="/reports">
                <ProtectedLayout><ReportsPage /></ProtectedLayout>
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
              <Route path="/settings">
                <ProtectedLayout><SettingsPage /></ProtectedLayout>
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
          <Toaster />
        </TooltipProvider>
      </QueryClientProvider>
    </ClerkProvider>
  );
}

function App() {
  if (!clerkPubKey) {
    return <DeploymentConfigRequired />;
  }

  return (
    <WouterRouter base={basePath}>
      <ClerkProviderWithRoutes />
    </WouterRouter>
  );
}

export default App;
