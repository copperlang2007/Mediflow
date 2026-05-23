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
import { Button } from "@/components/ui/button";
import { ArrowRight, CheckCircle2 } from "lucide-react";
import {
  useOnboarding,
  wizardStepForRun,
  type WizardStep,
} from "@/lib/onboarding/api";
import { WelcomeStep } from "./steps/WelcomeStep";
import { ProfileStep } from "./steps/ProfileStep";
import { CarriersStep } from "./steps/CarriersStep";
import { ReviewStep } from "./steps/ReviewStep";
import { SigningStep } from "./steps/SigningStep";
import { DoneStep } from "./steps/DoneStep";

const STEP_ORDER: WizardStep[] = [
  "welcome",
  "profile",
  "carriers",
  "review",
  "signing",
  "done",
];

const STEP_LABEL: Record<WizardStep, string> = {
  welcome: "Welcome",
  profile: "Your profile",
  carriers: "Carriers",
  review: "Review",
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
        className="p-4 sm:p-6 space-y-6 max-w-4xl mx-auto"
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
        <Skeleton className="h-48 w-full rounded-lg" />
      </div>
    );
  }

  if (!isAgent) {
    return (
      <div className="p-6 max-w-3xl mx-auto">
        <Card>
          <CardContent className="py-10 text-center space-y-3">
            <h1 className="text-xl font-semibold">Onboarding wizard</h1>
            <p className="text-sm text-muted-foreground">
              This wizard is for agents who are filling out their own
              contracting paperwork. As an admin, you can manage agent
              onboarding from the{" "}
              <a className="text-primary underline" href="../admin-onboarding">
                admin onboarding dashboard
              </a>
              .
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!myAgent) {
    return (
      <div className="p-6 max-w-3xl mx-auto">
        <Card>
          <CardContent className="py-10 text-center space-y-3">
            <h1 className="text-xl font-semibold">No agent profile found</h1>
            <p className="text-sm text-muted-foreground">
              Your user account isn't linked to an agent record yet. Please
              ask your administrator to invite you as an agent.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!onboarding) {
    return (
      <div className="p-6 max-w-3xl mx-auto">
        <Card>
          <CardContent className="py-10 text-center space-y-3">
            <h1 className="text-xl font-semibold">
              You don't have an active onboarding run
            </h1>
            <p className="text-sm text-muted-foreground">
              Your administrator hasn't started a contracting onboarding for
              you yet. Once they do, you'll see the wizard here.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const stepIndex = STEP_ORDER.indexOf(activeStep);

  return (
    <div className="p-4 sm:p-6 max-w-4xl mx-auto space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-bold">Carrier contracting onboarding</h1>
        <p className="text-sm text-muted-foreground">
          Step {stepIndex + 1} of {STEP_ORDER.length}: {STEP_LABEL[activeStep]}
        </p>
      </header>

      <ol className="flex items-center gap-2 flex-wrap" aria-label="Progress">
        {STEP_ORDER.map((s, idx) => {
          const isActive = s === activeStep;
          const isDone = idx < stepIndex;
          return (
            <li key={s} className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setStepOverride(s)}
                className={[
                  "flex items-center gap-2 text-xs px-2.5 py-1.5 rounded-full border transition-colors",
                  isActive
                    ? "bg-primary text-primary-foreground border-primary"
                    : isDone
                    ? "bg-green-50 text-green-700 border-green-200"
                    : "bg-muted text-muted-foreground border-border",
                ].join(" ")}
                data-testid={`onboarding-step-${s}`}
              >
                {isDone ? (
                  <CheckCircle2 className="h-3.5 w-3.5" />
                ) : (
                  <span className="font-semibold">{idx + 1}</span>
                )}
                {STEP_LABEL[s]}
              </button>
              {idx < STEP_ORDER.length - 1 && (
                <ArrowRight className="h-3 w-3 text-muted-foreground/50" />
              )}
            </li>
          );
        })}
      </ol>

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
            onContinue={() => setStepOverride("signing")}
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
