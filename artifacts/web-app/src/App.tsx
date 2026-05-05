import { useEffect, useRef } from "react";
import { ClerkProvider, SignIn, SignUp, Show, useClerk } from "@clerk/react";
import { publishableKeyFromHost } from "@clerk/react/internal";
import { shadcn } from "@clerk/themes";
import { Switch, Route, useLocation, Router as WouterRouter, Redirect } from "wouter";
import { QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { queryClient } from "./lib/queryClient";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import AppShell from "@/components/layout/AppShell";
import Dashboard from "@/pages/dashboard";
import AgentsPage from "@/pages/agents";
import LicensingPage from "@/pages/licensing";
import CertificationsPage from "@/pages/certifications";
import CRMPage from "@/pages/crm";
import TasksPage from "@/pages/tasks";
import DocumentsPage from "@/pages/documents";
import CompliancePage from "@/pages/compliance";
import SettingsPage from "@/pages/settings";
import NotFound from "@/pages/not-found";

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
    formFieldRow: "gap-2",
    main: "px-8 py-6",
  },
};

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
        <AppShell>{children}</AppShell>
      </Show>
      <Show when="signed-out">
        <Redirect to="/" />
      </Show>
    </>
  );
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
          <Switch>
            <Route path="/" component={HomeRedirect} />
            <Route path="/sign-in/*?" component={SignInPage} />
            <Route path="/sign-up/*?" component={SignUpPage} />
            <Route path="/dashboard">
              <ProtectedLayout><Dashboard /></ProtectedLayout>
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
            <Route path="/crm">
              <ProtectedLayout><CRMPage /></ProtectedLayout>
            </Route>
            <Route path="/tasks">
              <ProtectedLayout><TasksPage /></ProtectedLayout>
            </Route>
            <Route path="/documents">
              <ProtectedLayout><DocumentsPage /></ProtectedLayout>
            </Route>
            <Route path="/compliance">
              <ProtectedLayout><CompliancePage /></ProtectedLayout>
            </Route>
            <Route path="/settings">
              <ProtectedLayout><SettingsPage /></ProtectedLayout>
            </Route>
            <Route component={NotFound} />
          </Switch>
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
