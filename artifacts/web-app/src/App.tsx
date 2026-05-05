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
const SettingsPage = lazy(() => import("@/pages/settings"));
const RenewalsPage = lazy(() => import("@/pages/renewals"));
const AutomationsPage = lazy(() => import("@/pages/automations"));
const ReportsPage = lazy(() => import("@/pages/reports"));
const AdminCompliancePage = lazy(() => import("@/pages/admin-compliance"));
const DataMigrationPage = lazy(() => import("@/pages/data-migration"));
const NotFound = lazy(() => import("@/pages/not-found"));
const ForgotPasswordPage = lazy(() => import("@/pages/forgot-password"));

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

if (!clerkPubKey) {
  throw new Error("Missing VITE_CLERK_PUBLISHABLE_KEY");
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
              <Route path="/automations">
                <ProtectedLayout><AutomationsPage /></ProtectedLayout>
              </Route>
              <Route path="/reports">
                <ProtectedLayout><ReportsPage /></ProtectedLayout>
              </Route>
              <Route path="/admin-compliance">
                <ProtectedLayout><AdminCompliancePage /></ProtectedLayout>
              </Route>
              <Route path="/data-migration">
                <ProtectedLayout><DataMigrationPage /></ProtectedLayout>
              </Route>
              <Route path="/compliance">
                <ProtectedLayout><CompliancePage /></ProtectedLayout>
              </Route>
              <Route path="/settings">
                <ProtectedLayout><SettingsPage /></ProtectedLayout>
              </Route>
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
  return (
    <WouterRouter base={basePath}>
      <ClerkProviderWithRoutes />
    </WouterRouter>
  );
}

export default App;
