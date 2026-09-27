/**
 * Agent-facing onboarding wizard entry.
 *
 * Locates the Agent row linked to the currently-signed-in user, fetches the
 * active onboarding run, and dispatches to the appropriate wizard step.
 *
 * The wizard step is driven by the URL hash (`#step=profile`) so refreshes
 * don't bounce the agent back to step 1. If the hash is absent we derive
 * the natural step from the run + carrier-request state via
 * `wizardStepForRun()`.
 */
import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { useGetMe, useGetAgents, getGetAgentsQueryKey } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Check, ClipboardCheck, Handshake, UserX } from "lucide-react";
import { EmptyState, PageHeader } from "@/components/shared";
import { cn } from "@/lib/utils";
import {
  useOnboarding,
  wizardStepForRun,
  type WizardStep,
} from "@/lib/onboarding/api";
import { WelcomeStep } from "./steps/WelcomeStep";
import { ProfileStep } from "./steps/ProfileStep";
import { CarriersStep } from "./steps/CarriersStep";
import { ReviewStep } from "./steps/ReviewStep";
import { PoaDecisionStep } from "./steps/PoaDecisionStep";
import { SigningStep } from "./steps/SigningStep";
import { DoneStep } from "./steps/DoneStep";

const STEP_ORDER: WizardStep[] = [
  "welcome",
  "profile",
  "carriers",
  "review",
  "poa",
  "signing",
  "done",
];

const STEP_LABEL: Record<WizardStep, string> = {
  welcome: "Welcome",
  profile: "Your profile",
  carriers: "Carriers",
  review: "Review",
  poa: "Authorize",
  signing: "Sign",
  done: "Done",
};

/** Read `?step=…` query-param without forcing a wouter remount. */
function useStepParam(): [WizardStep | null, (s: WizardStep) => void] {
  const [location, setLocation] = useLocation();
  const [step, setStepState] = useState<WizardStep | null>(() => {
    const sp = new URLSearchParams(window.location.search);
    const v = sp.get("step");
    return (STEP_ORDER as string[]).includes(v ?? "") ? (v as WizardStep) : null;
  });

  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    const v = sp.get("step");
    if ((STEP_ORDER as string[]).includes(v ?? "")) {
      setStepState(v as WizardStep);
    } else {
      setStepState(null);
    }
    // wouter `location` changes on path; we read search ourselves.
  }, [location]);

  const setStep = (s: WizardStep) => {
    const sp = new URLSearchParams(window.location.search);
    sp.set("step", s);
    const next = `${location.split("?")[0]}?${sp.toString()}`;
    setLocation(next);
    setStepState(s);
  };

  return [step, setStep];
}

export default function OnboardingPage() {
  const { data: me, isLoading: meLoading } = useGetMe();
  // Find the Agent row linked to the current Clerk user.
  // For non-agent roles, we expose a hint that they should use the admin
  // dashboard instead of this self-service wizard.
  const isAgent = me?.role === "agent";
  const { data: agentsData, isLoading: agentsLoading } = useGetAgents(
    { limit: 200 },
    { query: { enabled: Boolean(me), queryKey: getGetAgentsQueryKey({ limit: 200 }) } },
  );

  const myAgent = useMemo(() => {
    if (!me || !agentsData) return null;
    return agentsData.agents.find((a) => a.userId === me.id) ?? null;
  }, [me, agentsData]);

  const { data: onboarding, isLoading: obLoading } = useOnboarding(
    myAgent?.id,
  );

  const [stepOverride, setStepOverride] = useStepParam();

  const naturalStep: WizardStep | null = useMemo(() => {
    if (!onboarding) return null;
    return wizardStepForRun(onboarding.run, onboarding.carrierRequests);
  }, [onboarding]);

  const activeStep: WizardStep =
    stepOverride ?? naturalStep ?? "welcome";

  if (meLoading || agentsLoading || obLoading) {
    // Skeleton mirrors the real layout (header + progress pills + step card)
    // so the page shape stops jumping when data lands.
    return (
      <div
        className="p-4 sm:p-6 lg:p-8 space-y-6 max-w-5xl mx-auto"
        data-testid="onboarding-loading"
      >
        <div className="space-y-2">
          <Skeleton className="h-7 w-3/4 sm:w-64" />
          <Skeleton className="h-4 w-1/2 sm:w-48" />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {[...Array(STEP_ORDER.length)].map((_, i) => (
            <Skeleton key={i} className="h-7 w-24" />
          ))}
        </div>
        <Skeleton className="h-48 w-full rounded-xl" />
      </div>
    );
  }

  if (!isAgent) {
    return (
      <div className="p-4 sm:p-6 lg:p-8 max-w-3xl mx-auto">
        <Card>
          <EmptyState
            icon={Handshake}
            title={<h1>Onboarding wizard</h1>}
            description="This wizard is for agents filling out their own contracting paperwork. As an admin, you manage agent onboarding from the Contracting page."
            action={{ label: "Go to Contracting", href: "/admin-onboarding" }}
          />
        </Card>
      </div>
    );
  }

  if (!myAgent) {
    return (
      <div className="p-4 sm:p-6 lg:p-8 max-w-3xl mx-auto">
        <Card>
          <EmptyState
            icon={UserX}
            title={<h1>No agent profile found</h1>}
            description="Your user account isn't linked to an agent record yet. Please ask your administrator to invite you as an agent."
          />
        </Card>
      </div>
    );
  }

  if (!onboarding) {
    return (
      <div className="p-4 sm:p-6 lg:p-8 max-w-3xl mx-auto">
        <Card>
          <EmptyState
            icon={ClipboardCheck}
            title={<h1>You don't have an active onboarding run</h1>}
            description="Your administrator hasn't started a contracting onboarding for you yet. Once they do, you'll see the wizard here."
          />
        </Card>
      </div>
    );
  }

  const stepIndex = STEP_ORDER.indexOf(activeStep);

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-5xl mx-auto space-y-6">
      <PageHeader
        eyebrow={`Step ${stepIndex + 1} of ${STEP_ORDER.length}`}
        title="Getting contracted with carriers"
        subtitle={`${STEP_LABEL[activeStep]} — we'll walk you through it one step at a time. Your answers are saved as you go.`}
      />

      <nav className="rounded-xl border border-border bg-card px-4 py-4 shadow-sm overflow-x-auto" aria-label="Onboarding steps">
        <ol className="flex min-w-max items-start" aria-label="Progress">
          {STEP_ORDER.map((s, idx) => {
            const isActive = s === activeStep;
            const isDone = idx < stepIndex;
            return (
              <li key={s} className="flex items-start">
                <button
                  type="button"
                  onClick={() => setStepOverride(s)}
                  aria-current={isActive ? "step" : undefined}
                  className="group flex w-20 flex-col items-center gap-1.5 rounded-lg px-1 py-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  data-testid={`onboarding-step-${s}`}
                >
                  <span
                    className={cn(
                      "flex h-8 w-8 items-center justify-center rounded-full border-2 text-sm font-semibold transition-colors",
                      isActive
                        ? "border-primary bg-primary text-primary-foreground"
                        : isDone
                          ? "border-success bg-success text-white"
                          : "border-border bg-card text-muted-foreground group-hover:border-accent",
                    )}
                  >
                    {isDone ? <Check className="h-4 w-4" /> : idx + 1}
                  </span>
                  <span className={cn(
                    "text-center text-xs leading-tight",
                    isActive ? "font-semibold text-foreground" : isDone ? "text-success" : "text-muted-foreground",
                  )}>
                    {STEP_LABEL[s]}
                  </span>
                </button>
                {idx < STEP_ORDER.length - 1 && (
                  <span
                    aria-hidden
                    className={cn("mt-4 h-0.5 w-6 sm:w-10 rounded-full", idx < stepIndex ? "bg-success" : "bg-border")}
                  />
                )}
              </li>
            );
          })}
        </ol>
      </nav>

      <div className="space-y-4">
        {activeStep === "welcome" && (
          <WelcomeStep onContinue={() => setStepOverride("profile")} />
        )}
        {activeStep === "profile" && (
          <ProfileStep
            agentId={myAgent.id}
            profile={onboarding.profile}
            onContinue={() => setStepOverride("carriers")}
          />
        )}
        {activeStep === "carriers" && (
          <CarriersStep
            agentId={myAgent.id}
            existing={onboarding.carrierRequests}
            onContinue={() => setStepOverride("review")}
          />
        )}
        {activeStep === "review" && (
          <ReviewStep
            agentId={myAgent.id}
            profile={onboarding.profile}
            carrierRequests={onboarding.carrierRequests}
            onBack={() => setStepOverride("carriers")}
            onContinue={() => setStepOverride("poa")}
          />
        )}
        {activeStep === "poa" && (
          <PoaDecisionStep
            agentId={myAgent.id}
            carrierRequests={onboarding.carrierRequests}
            onContinue={() => setStepOverride("done")}
          />
        )}
        {activeStep === "signing" && (
          <SigningStep
            agentId={myAgent.id}
            carrierRequests={onboarding.carrierRequests}
            onContinue={() => setStepOverride("done")}
          />
        )}
        {activeStep === "done" && (
          <DoneStep
            run={onboarding.run}
            carrierRequests={onboarding.carrierRequests}
          />
        )}
      </div>
    </div>
  );
}

export { STEP_ORDER, STEP_LABEL };
