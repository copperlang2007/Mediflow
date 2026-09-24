import { lazy, Suspense } from "react";
import { ClerkProvider, SignIn, SignUp, Show, useClerk, useUser, useAuth } from "@clerk/react";
import { publishableKeyFromHost } from "@clerk/react/internal";
import { shadcn } from "@clerk/themes";
import { Switch, Route, useLocation, Router as WouterRouter, Redirect } from "wouter";
import { QueryClientProvider, useQueryClient, useQuery } from "@tanstack/react-query";
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
const BillingPage = lazy(() => import("@/pages/billing"));
const TeamPage = lazy(() => import("@/pages/team"));
const AcceptInvitePage = lazy(() => import("@/pages/accept-invite"));
const CreateOrganizationPage = lazy(() => import("@/pages/create-organization"));

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
  const capabilities = [
    {
      number: "01",
      title: "Bring your agency together",
      description: "Keep your agents, onboarding steps, and everyday work in one place.",
    },
    {
      number: "02",
      title: "Stay ahead of the details",
      description: "See licensing, certifications, and compliance work alongside your team.",
    },
    {
      number: "03",
      title: "Make room to grow",
      description: "Connect your contacts, tasks, and agency reporting in a shared workspace.",
    },
  ];

  return (
    <div className="relative isolate min-h-[100dvh] overflow-hidden bg-[#091527] text-white">
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_82%_18%,rgba(59,130,246,0.24),transparent_34%),radial-gradient(circle_at_5%_72%,rgba(20,184,166,0.12),transparent_33%)]" />
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 opacity-20 [background-image:linear-gradient(rgba(255,255,255,.07)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,.07)_1px,transparent_1px)] [background-size:72px_72px]" />

      <div className="relative mx-auto flex min-h-[100dvh] max-w-7xl flex-col px-6 sm:px-10 lg:px-16">
        <header className="flex items-center justify-between border-b border-white/10 py-6">
          <div className="flex items-center gap-3">
            <img src={`${basePath}/logo.svg`} alt="" className="h-10 w-10" />
            <span className="text-xl font-semibold tracking-tight">MediFlow</span>
          </div>
          <span className="hidden text-sm text-slate-400 sm:inline">A clearer way to run your agency</span>
        </header>

        <main className="flex-1">
          <section className="grid gap-12 py-20 sm:py-24 lg:grid-cols-[1.2fr_.8fr] lg:items-center lg:gap-16 lg:py-32">
            <div>
              <p className="mb-6 inline-flex rounded-full border border-blue-300/20 bg-blue-400/10 px-4 py-2 text-xs font-semibold uppercase tracking-[0.18em] text-blue-200">
                Built for Medicare sales agencies
              </p>
              <h1 className="max-w-3xl text-5xl font-semibold leading-[1.08] tracking-tight sm:text-6xl lg:text-7xl">
                Your agency, <span className="text-blue-300">moving together.</span>
              </h1>
              <p className="mt-7 max-w-xl text-lg leading-8 text-slate-300">
                MediFlow brings agent onboarding, licensing, compliance, contacts, and daily work into one connected workspace.
              </p>
              <a
                href={`${basePath}/sign-in`}
                className="mt-9 inline-flex min-h-12 items-center justify-center rounded-xl bg-blue-500 px-8 py-3 text-base font-semibold text-white shadow-lg shadow-blue-950/40 transition-colors hover:bg-blue-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-blue-300"
              >
                Sign in
                <span aria-hidden="true" className="ml-3">→</span>
              </a>
              <p className="mt-4 text-sm text-slate-400">For existing MediFlow users</p>
            </div>

            <div className="relative rounded-[2rem] border border-white/15 bg-white/[0.06] p-6 shadow-2xl shadow-black/30 backdrop-blur sm:p-8">
              <div className="mb-7 flex items-center justify-between">
                <span className="text-sm font-medium text-slate-300">One connected workspace</span>
                <span className="flex gap-1.5" aria-hidden="true">
                  <span className="h-2 w-2 rounded-full bg-blue-300" />
                  <span className="h-2 w-2 rounded-full bg-teal-300" />
                  <span className="h-2 w-2 rounded-full bg-white/30" />
                </span>
              </div>
              <div className="space-y-3">
                {["Agent onboarding", "Licensing & certifications", "Compliance", "Contacts & tasks"].map((label, index) => (
                  <div key={label} className="flex items-center gap-4 rounded-2xl border border-white/10 bg-white/[0.06] px-4 py-4">
                    <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-sm font-semibold ${index % 2 === 0 ? "bg-blue-400/20 text-blue-200" : "bg-teal-400/20 text-teal-200"}`}>
                      0{index + 1}
                    </span>
                    <span className="font-medium text-slate-100">{label}</span>
                  </div>
                ))}
              </div>
              <p className="mt-7 border-t border-white/10 pt-6 text-sm leading-6 text-slate-400">
                Less time switching between tools. More clarity on what needs attention next.
              </p>
            </div>
          </section>

          <section className="border-t border-white/10 pb-20 pt-12">
            <p className="mb-8 text-xs font-semibold uppercase tracking-[0.22em] text-blue-300">Made for the work behind every sale</p>
            <div className="grid gap-8 sm:grid-cols-3">
              {capabilities.map(({ number, title, description }) => (
                <div key={number}>
                  <span className="text-sm font-medium text-teal-300">{number}</span>
                  <h2 className="mt-3 text-xl font-semibold tracking-tight">{title}</h2>
                  <p className="mt-3 max-w-sm text-sm leading-7 text-slate-400">{description}</p>
                </div>
              ))}
            </div>
          </section>
        </main>

        <footer className="border-t border-white/10 py-6 text-sm text-slate-500">
          © {new Date().getFullYear()} MediFlow
        </footer>
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
          <AppShell>
            <ErrorBoundary>
              <Suspense fallback={<PageLoadingFallback />}>
                {children}
              </Suspense>
            </ErrorBoundary>
          </AppShell>
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
 * Sits between Clerk sign-in and the app shell. A Clerk user with no MediFlow
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
          <ClerkQueryClientCacheInvalidator />
          <ErrorBoundary>
            <Switch>
              <Route path="/" component={HomeRedirect} />
              <Route path="/sign-in/*?" component={SignInPage} />
              <Route path="/sign-up/*?" component={SignUpPage} />
              {/*
                Deliberately OUTSIDE ProtectedLayout. An invitee has no MediFlow
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
    return <DeploymentConfigRequired />;
  }

  return (
    <WouterRouter base={basePath}>
      <ClerkProviderWithRoutes />
    </WouterRouter>
  );
}

export default App;
