/**
 * /dev/feature-builder — AI-assisted feature scaffolding.
 *
 * Three-state UI driven against the dev-only backend at
 * /api/dev/feature-builder/{plan,apply}. Endpoints aren't part of the
 * OpenAPI spec on purpose, so we hit them via customFetch directly.
 *
 * State machine:
 *   "input"   → textarea + Plan button
 *   "plan"    → plan summary, file list, risks, Discard / Apply buttons
 *   "applying"→ spinner with a step indicator (no SSE; backend is one
 *               blocking POST that doesn't emit progress, so we cycle
 *               through expected steps for UX feel)
 *   "result"  → success card (with PR link) or typecheck-error fallback
 *
 * The human always reviews and merges the resulting PR — nothing is
 * pushed to main from this surface.
 */
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { customFetch } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  FilePlus,
  FilePen,
  Sparkles,
} from "lucide-react";

const MAX_DESCRIPTION = 4000;

type FilePlanEntry = {
  path: string;
  action: "create" | "modify";
  preview: string;
  reason: string;
};

type FeaturePlan = {
  summary: string;
  branchSlug: string;
  files: FilePlanEntry[];
  migrationsNeeded: boolean;
  rbacChanges: boolean;
  openApiChanges: boolean;
  testsIncluded: boolean;
  risks: string[];
};

type PlanResponse = { planId: string; plan: FeaturePlan };

type ApplyResponse = {
  branch: string;
  prUrl?: string;
  typecheckErrors?: string[];
  retries: number;
};

type UIState = "input" | "plan" | "applying" | "result";

const APPLY_STEPS = [
  "Generating file contents…",
  "Writing files…",
  "Running typecheck…",
  "Repair pass (if needed)…",
  "Committing…",
  "Pushing…",
  "Opening PR…",
];

/** Defensive shape check — backend is in flight and could return garbage. */
function isFeaturePlan(value: unknown): value is FeaturePlan {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.summary === "string" &&
    typeof v.branchSlug === "string" &&
    Array.isArray(v.files) &&
    v.files.every((f) => {
      if (!f || typeof f !== "object") return false;
      const fe = f as Record<string, unknown>;
      return (
        typeof fe.path === "string" &&
        (fe.action === "create" || fe.action === "modify") &&
        typeof fe.preview === "string" &&
        typeof fe.reason === "string"
      );
    }) &&
    typeof v.migrationsNeeded === "boolean" &&
    typeof v.rbacChanges === "boolean" &&
    typeof v.openApiChanges === "boolean" &&
    typeof v.testsIncluded === "boolean" &&
    Array.isArray(v.risks) &&
    v.risks.every((r) => typeof r === "string")
  );
}

function isPlanResponse(value: unknown): value is PlanResponse {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return typeof v.planId === "string" && isFeaturePlan(v.plan);
}

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function InputState({
  description,
  setDescription,
  onPlan,
  isPending,
  error,
}: {
  description: string;
  setDescription: (s: string) => void;
  onPlan: () => void;
  isPending: boolean;
  error: string | null;
}) {
  const [open, setOpen] = useState(false);
  const trimmed = description.trim();
  const overLimit = description.length > MAX_DESCRIPTION;
  const canSubmit = trimmed.length > 0 && !overLimit && !isPending;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Describe the feature</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <Textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Describe the feature you want. e.g. 'Add a way for agents to log vacation time so it shows on their profile and managers can see who's out this week.'"
          className="min-h-[180px] font-mono text-sm"
          maxLength={MAX_DESCRIPTION + 200}
          disabled={isPending}
        />
        <div className="flex items-center justify-between gap-3 text-xs">
          <span
            className={
              overLimit
                ? "text-destructive font-semibold"
                : "text-muted-foreground"
            }
          >
            {description.length} / {MAX_DESCRIPTION}
          </span>
          <Button
            onClick={onPlan}
            disabled={!canSubmit}
            data-testid="feature-builder-plan-button"
          >
            {isPending ? (
              <>
                <Spinner className="size-4" /> Planning…
              </>
            ) : (
              <>
                <Sparkles className="size-4" /> Plan
              </>
            )}
          </Button>
        </div>

        {error && (
          <div className="text-sm text-destructive border border-destructive/30 bg-destructive/5 rounded-md px-3 py-2">
            {error}
          </div>
        )}

        <Collapsible open={open} onOpenChange={setOpen}>
          <CollapsibleTrigger className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors">
            {open ? (
              <ChevronDown className="h-3.5 w-3.5" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" />
            )}
            What this does
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-2">
            <ul className="text-xs text-muted-foreground space-y-1.5 list-disc pl-5">
              <li>
                Sends your description + a snapshot of the codebase structure
                to the AI
              </li>
              <li>
                The AI returns a plan: which files to create/modify, branch
                name, risks
              </li>
              <li>
                On Apply, the AI writes the files, runs typecheck (with one
                repair retry), commits, pushes, and opens a PR
              </li>
              <li className="font-semibold text-foreground">
                You always review and merge the PR — nothing reaches main
                without you
              </li>
            </ul>
          </CollapsibleContent>
        </Collapsible>
      </CardContent>
    </Card>
  );
}

function PlanFlags({ plan }: { plan: FeaturePlan }) {
  const flags: Array<{ key: string; label: string; on: boolean; variant: "default" | "secondary" | "destructive" }> = [
    { key: "migrations", label: "Migrations", on: plan.migrationsNeeded, variant: "destructive" },
    { key: "rbac", label: "RBAC", on: plan.rbacChanges, variant: "destructive" },
    { key: "openapi", label: "OpenAPI", on: plan.openApiChanges, variant: "secondary" },
    { key: "tests", label: "Tests included", on: plan.testsIncluded, variant: "default" },
  ];
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {flags.map((f) =>
        f.on ? (
          <Badge key={f.key} variant={f.variant} className="text-[10px]">
            {f.label}
          </Badge>
        ) : (
          <Badge
            key={f.key}
            variant="outline"
            className="text-[10px] text-muted-foreground"
          >
            no {f.label.toLowerCase()}
          </Badge>
        ),
      )}
    </div>
  );
}

function FileRow({ entry }: { entry: FilePlanEntry }) {
  const [open, setOpen] = useState(false);
  const truncated =
    entry.preview.length > 140
      ? entry.preview.slice(0, 140) + "…"
      : entry.preview;
  const actionBadge =
    entry.action === "create" ? (
      <Badge className="bg-blue-500/15 text-blue-700 dark:text-blue-300 border-blue-500/30 hover:bg-blue-500/20 text-[10px] gap-1">
        <FilePlus className="h-3 w-3" /> create
      </Badge>
    ) : (
      <Badge className="bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30 hover:bg-amber-500/20 text-[10px] gap-1">
        <FilePen className="h-3 w-3" /> modify
      </Badge>
    );

  return (
    <>
      <TableRow
        className="cursor-pointer"
        onClick={() => setOpen((v) => !v)}
      >
        <TableCell className="font-mono text-xs align-top w-[40%] break-all">
          <div className="flex items-start gap-1.5">
            {open ? (
              <ChevronDown className="h-3.5 w-3.5 mt-0.5 shrink-0" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5 mt-0.5 shrink-0" />
            )}
            <span>{entry.path}</span>
          </div>
        </TableCell>
        <TableCell className="align-top w-[100px]">{actionBadge}</TableCell>
        <TableCell className="text-xs text-muted-foreground align-top font-mono">
          {open ? null : truncated}
        </TableCell>
        <TableCell className="text-xs align-top">{entry.reason}</TableCell>
      </TableRow>
      {open && (
        <TableRow>
          <TableCell colSpan={4} className="bg-muted/40 p-0">
            <pre className="text-[11px] font-mono p-3 overflow-x-auto whitespace-pre-wrap break-words">
              {entry.preview || "(empty preview)"}
            </pre>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

function PlanState({
  plan,
  onDiscard,
  onApply,
  applyError,
}: {
  plan: FeaturePlan;
  onDiscard: () => void;
  onApply: (mode: "pr" | "commit-only") => void;
  applyError: string | null;
}) {
  const grouped = useMemo(() => {
    const created = plan.files.filter((f) => f.action === "create");
    const modified = plan.files.filter((f) => f.action === "modify");
    return { created, modified };
  }, [plan.files]);

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">{plan.summary || "(no summary)"}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center gap-2 text-xs">
            <span className="text-muted-foreground">branch:</span>
            <Badge variant="outline" className="font-mono">
              {plan.branchSlug || "(no branch slug)"}
            </Badge>
          </div>
          <PlanFlags plan={plan} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-semibold">
            Files ({plan.files.length})
          </CardTitle>
        </CardHeader>
        <CardContent>
          {plan.files.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              The plan didn't list any files. Discard and try a more specific
              description.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Path</TableHead>
                  <TableHead>Action</TableHead>
                  <TableHead>Preview</TableHead>
                  <TableHead>Reason</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {grouped.created.length > 0 && (
                  <TableRow className="hover:bg-transparent">
                    <TableCell
                      colSpan={4}
                      className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold py-1.5"
                    >
                      New files
                    </TableCell>
                  </TableRow>
                )}
                {grouped.created.map((f) => (
                  <FileRow key={`new-${f.path}`} entry={f} />
                ))}
                {grouped.modified.length > 0 && (
                  <TableRow className="hover:bg-transparent">
                    <TableCell
                      colSpan={4}
                      className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold py-1.5"
                    >
                      Modified files
                    </TableCell>
                  </TableRow>
                )}
                {grouped.modified.map((f) => (
                  <FileRow key={`mod-${f.path}`} entry={f} />
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {plan.risks.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-amber-500" /> Risks
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="text-sm text-muted-foreground space-y-1.5 list-disc pl-5">
              {plan.risks.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {applyError && (
        <div className="text-sm text-destructive border border-destructive/30 bg-destructive/5 rounded-md px-3 py-2">
          {applyError}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button variant="ghost" onClick={onDiscard} data-testid="feature-builder-discard">
          Discard
        </Button>
        <Button
          variant="outline"
          onClick={() => onApply("commit-only")}
          data-testid="feature-builder-apply-commit"
        >
          Apply → commit only
        </Button>
        <Button
          onClick={() => onApply("pr")}
          data-testid="feature-builder-apply-pr"
        >
          Apply → Open PR
        </Button>
      </div>
    </div>
  );
}

function ApplyingState() {
  const [stepIndex, setStepIndex] = useState(0);
  const [elapsed, setElapsed] = useState(0);

  // Cycle through "expected" steps for UX. Backend is one blocking call
  // with no progress channel — this is purely cosmetic.
  useEffect(() => {
    const tick = window.setInterval(() => {
      setStepIndex((i) => Math.min(i + 1, APPLY_STEPS.length - 1));
    }, 4000);
    const timer = window.setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => {
      window.clearInterval(tick);
      window.clearInterval(timer);
    };
  }, []);

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <Spinner className="h-4 w-4" /> Applying… ({formatElapsed(elapsed)})
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ol className="space-y-2">
          {APPLY_STEPS.map((label, i) => {
            const done = i < stepIndex;
            const current = i === stepIndex;
            return (
              <li
                key={label}
                className={
                  "flex items-center gap-2 text-sm " +
                  (done
                    ? "text-muted-foreground"
                    : current
                      ? "text-foreground font-medium"
                      : "text-muted-foreground/50")
                }
              >
                <span
                  className={
                    "inline-block h-1.5 w-1.5 rounded-full shrink-0 " +
                    (done
                      ? "bg-muted-foreground"
                      : current
                        ? "bg-primary animate-pulse"
                        : "bg-muted")
                  }
                />
                {label}
              </li>
            );
          })}
        </ol>
        <p className="text-xs text-muted-foreground mt-4">
          This usually takes 30–90s. The page will update when the backend
          finishes — don't navigate away.
        </p>
      </CardContent>
    </Card>
  );
}

function SuccessCard({
  result,
  onReset,
}: {
  result: ApplyResponse;
  onReset: () => void;
}) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Applied</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="text-sm space-y-1.5">
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground text-xs">branch:</span>
            <Badge variant="outline" className="font-mono">
              {result.branch}
            </Badge>
          </div>
          {result.retries > 0 && (
            <div className="text-xs text-muted-foreground">
              Typecheck repair retries: {result.retries}
            </div>
          )}
        </div>
        <p className="text-sm text-muted-foreground">
          The change is on a branch, ready for your review. Nothing is merged
          to main until you say so.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          {result.prUrl && (
            <Button asChild>
              <a href={result.prUrl} target="_blank" rel="noopener noreferrer">
                <ExternalLink className="size-4" /> View PR
              </a>
            </Button>
          )}
          <Button variant="outline" onClick={onReset}>
            Start another
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function TypecheckErrorCard({
  result,
  onDiscard,
}: {
  result: ApplyResponse;
  onDiscard: () => void;
}) {
  const [open, setOpen] = useState(false);
  const errors = result.typecheckErrors ?? [];

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-semibold flex items-center gap-2 text-destructive">
          <AlertTriangle className="h-4 w-4" /> Typecheck failed
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          The generated changes didn't typecheck even after the AI's repair
          pass ({result.retries} retr{result.retries === 1 ? "y" : "ies"}). The
          branch <span className="font-mono text-foreground">{result.branch}</span>{" "}
          may exist on the remote — review or delete it manually. Not
          auto-retrying — your call.
        </p>

        <Collapsible open={open} onOpenChange={setOpen}>
          <CollapsibleTrigger className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors">
            {open ? (
              <ChevronDown className="h-3.5 w-3.5" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" />
            )}
            Show details ({errors.length})
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-2">
            <pre className="text-[11px] font-mono p-3 bg-muted/40 rounded-md overflow-x-auto max-h-[400px] whitespace-pre-wrap break-words">
              {errors.length > 0 ? errors.join("\n") : "(no error details returned)"}
            </pre>
          </CollapsibleContent>
        </Collapsible>

        <div className="flex justify-end">
          <Button variant="outline" onClick={onDiscard}>
            Discard
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

export default function FeatureBuilderPage() {
  const qc = useQueryClient();
  const [state, setState] = useState<UIState>("input");
  const [description, setDescription] = useState("");
  const [planId, setPlanId] = useState<string | null>(null);
  const [plan, setPlan] = useState<FeaturePlan | null>(null);
  const [applyResult, setApplyResult] = useState<ApplyResponse | null>(null);

  const planMutation = useMutation({
    mutationFn: async (descriptionText: string) => {
      const body = JSON.stringify({ description: descriptionText });
      const result = await customFetch<unknown>(
        "/api/dev/feature-builder/plan",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
        },
      );
      if (!isPlanResponse(result)) {
        throw new Error(
          "Plan generation failed — the backend returned an unexpected shape.",
        );
      }
      return result;
    },
    onSuccess: (res) => {
      setPlanId(res.planId);
      setPlan(res.plan);
      setState("plan");
    },
  });

  const applyMutation = useMutation({
    mutationFn: async (mode: "pr" | "commit-only") => {
      if (!planId) throw new Error("No plan to apply.");
      const result = await customFetch<unknown>(
        "/api/dev/feature-builder/apply",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ planId, mode }),
        },
      );
      if (
        !result ||
        typeof result !== "object" ||
        typeof (result as Record<string, unknown>).branch !== "string"
      ) {
        throw new Error(
          "Apply failed — the backend returned an unexpected shape.",
        );
      }
      return result as ApplyResponse;
    },
    onSuccess: (res) => {
      setApplyResult(res);
      setState("result");
      // The apply step may enqueue work or surface errors elsewhere —
      // refresh the ops dashboard so the next visit isn't stale.
      void qc.invalidateQueries({ queryKey: ["/api/dev/ops/queues"] });
      void qc.invalidateQueries({ queryKey: ["/api/dev/ops/recent-errors"] });
    },
  });

  const handleDiscard = () => {
    setState("input");
    setPlan(null);
    setPlanId(null);
    setApplyResult(null);
    planMutation.reset();
    applyMutation.reset();
  };

  const handlePlan = () => {
    if (!description.trim()) return;
    planMutation.mutate(description.trim());
  };

  const handleApply = (mode: "pr" | "commit-only") => {
    setState("applying");
    applyMutation.mutate(mode, {
      onError: () => {
        // Roll back to plan state so the user can retry or discard.
        setState("plan");
      },
    });
  };

  const planErrorMessage =
    planMutation.error instanceof Error
      ? planMutation.error.message
      : planMutation.error
        ? "Plan generation failed."
        : null;
  const applyErrorMessage =
    applyMutation.error instanceof Error
      ? applyMutation.error.message
      : applyMutation.error
        ? "Apply failed."
        : null;

  const hasTypecheckErrors =
    state === "result" &&
    applyResult &&
    applyResult.typecheckErrors &&
    applyResult.typecheckErrors.length > 0;

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      <header className="space-y-1.5">
        <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
          <Sparkles className="h-6 w-6 text-primary" /> Feature Builder
        </h1>
        <p className="text-sm text-muted-foreground">
          Plain-language → AI-drafted PR for human review.
        </p>
      </header>

      {state === "input" && (
        <InputState
          description={description}
          setDescription={setDescription}
          onPlan={handlePlan}
          isPending={planMutation.isPending}
          error={planErrorMessage}
        />
      )}

      {state === "plan" && plan && (
        <PlanState
          plan={plan}
          onDiscard={handleDiscard}
          onApply={handleApply}
          applyError={applyErrorMessage}
        />
      )}

      {state === "applying" && <ApplyingState />}

      {state === "result" && applyResult && hasTypecheckErrors && (
        <TypecheckErrorCard result={applyResult} onDiscard={handleDiscard} />
      )}
      {state === "result" && applyResult && !hasTypecheckErrors && (
        <SuccessCard result={applyResult} onReset={handleDiscard} />
      )}
    </div>
  );
}
