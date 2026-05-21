import { useMemo, useState } from "react";
import { toast } from "sonner";
import { useGetCarriers, useGetAgentLicenses } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { Plus, X } from "lucide-react";
import {
  type CarrierContractingRequest,
  type CarrierSelection,
  useSelectCarriers,
} from "@/lib/onboarding/api";
import { US_STATES } from "@/lib/onboarding/states";

type Selection = { carrierId: string; states: Set<string> };

/**
 * Build the initial selection map from already-persisted carrier requests.
 * If the agent is revisiting this step (e.g. via wizard nav), we want to
 * show their previous picks so they can amend rather than rebuild from
 * scratch. Cancelled requests are excluded.
 */
function selectionsFromRequests(
  existing: CarrierContractingRequest[],
): Map<string, Selection> {
  const map = new Map<string, Selection>();
  for (const r of existing) {
    if (r.status === "cancelled") continue;
    map.set(r.carrierId, {
      carrierId: r.carrierId,
      states: new Set(r.states),
    });
  }
  return map;
}

export function CarriersStep({
  agentId,
  existing,
  onContinue,
}: {
  agentId: string;
  existing: CarrierContractingRequest[];
  onContinue: () => void;
}) {
  const { data: carriers, isLoading: carriersLoading } = useGetCarriers();
  const { data: licensesData } = useGetAgentLicenses(agentId, { limit: 100 });

  // Pre-fill state pickers from the agent's existing state_licenses where
  // possible. Only ACTIVE licenses count (carriers won't appoint on a
  // pending/expired license).
  const licensedStates = useMemo(() => {
    const arr = licensesData?.data ?? [];
    return new Set(
      arr
        .filter((l) => l.status === "active")
        .map((l) => l.stateCode.toUpperCase()),
    );
  }, [licensesData]);

  const [selections, setSelections] = useState<Map<string, Selection>>(
    () => selectionsFromRequests(existing),
  );

  const { mutateAsync, isPending } = useSelectCarriers(agentId);

  const toggleCarrier = (carrierId: string, on: boolean) => {
    setSelections((prev) => {
      const next = new Map(prev);
      if (on) {
        const defaultStates = new Set(licensedStates);
        next.set(carrierId, { carrierId, states: defaultStates });
      } else {
        next.delete(carrierId);
      }
      return next;
    });
  };

  const toggleState = (carrierId: string, state: string) => {
    setSelections((prev) => {
      const next = new Map(prev);
      const current = next.get(carrierId);
      if (!current) return next;
      const newStates = new Set(current.states);
      if (newStates.has(state)) newStates.delete(state);
      else newStates.add(state);
      next.set(carrierId, { ...current, states: newStates });
      return next;
    });
  };

  const handleSubmit = async () => {
    const payload: CarrierSelection[] = [];
    for (const sel of selections.values()) {
      if (sel.states.size === 0) {
        toast.error(`Pick at least one state for each selected carrier`);
        return;
      }
      payload.push({ carrierId: sel.carrierId, states: [...sel.states] });
    }
    if (payload.length === 0) {
      toast.error("Pick at least one carrier to continue");
      return;
    }
    try {
      await mutateAsync({ selections: payload });
      toast.success(`Selected ${payload.length} carrier${payload.length === 1 ? "" : "s"}`);
      onContinue();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save selections");
    }
  };

  return (
    <Card data-testid="carriers-step">
      <CardHeader>
        <CardTitle>Choose carriers and states</CardTitle>
        <CardDescription>
          Pick which carriers you want appointments with. For each carrier,
          choose the states you want to write business in.
          {licensedStates.size > 0 && (
            <> States we've pre-checked are taken from your active licenses.</>
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {carriersLoading ? (
          <div className="space-y-3">
            {[...Array(3)].map((_, i) => <Skeleton key={i} className="h-20 w-full" />)}
          </div>
        ) : !carriers || carriers.length === 0 ? (
          <div className="rounded-lg border bg-muted/30 p-6 text-center text-sm text-muted-foreground">
            No carriers are configured in your organization yet. Ask your
            administrator to add carriers before you can continue.
          </div>
        ) : (
          <div className="space-y-3">
            {carriers.map((c) => {
              const sel = selections.get(c.id);
              const isSelected = Boolean(sel);
              return (
                <div
                  key={c.id}
                  className={`rounded-lg border p-3 transition-colors ${
                    isSelected ? "border-primary bg-primary/5" : "border-border"
                  }`}
                  data-testid={`carrier-row-${c.id}`}
                >
                  <label className="flex items-center gap-3 cursor-pointer">
                    <Checkbox
                      checked={isSelected}
                      onCheckedChange={(v) => toggleCarrier(c.id, Boolean(v))}
                      data-testid={`carrier-toggle-${c.id}`}
                    />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium">{c.name}</p>
                      {c.cmsContractNumber && (
                        <p className="text-xs text-muted-foreground">
                          CMS contract: {c.cmsContractNumber}
                        </p>
                      )}
                    </div>
                    {isSelected && sel && (
                      <Badge variant="secondary" className="text-xs">
                        {sel.states.size} state{sel.states.size === 1 ? "" : "s"}
                      </Badge>
                    )}
                  </label>

                  {isSelected && sel && (
                    <div className="mt-3 pl-7 space-y-2">
                      <p className="text-xs text-muted-foreground">
                        States to write business in:
                      </p>
                      <div className="flex flex-wrap gap-1.5">
                        {US_STATES.map((s) => {
                          const checked = sel.states.has(s.code);
                          const isLicensed = licensedStates.has(s.code);
                          return (
                            <button
                              type="button"
                              key={s.code}
                              onClick={() => toggleState(c.id, s.code)}
                              data-testid={`state-${c.id}-${s.code}`}
                              className={[
                                "text-[11px] px-2 py-0.5 rounded-md border transition-colors",
                                checked
                                  ? "bg-primary text-primary-foreground border-primary"
                                  : isLicensed
                                  ? "bg-green-50 text-green-700 border-green-200 hover:bg-green-100"
                                  : "bg-background text-muted-foreground border-border hover:bg-muted",
                              ].join(" ")}
                              title={s.name + (isLicensed ? " (licensed)" : "")}
                            >
                              {checked ? (
                                <span className="inline-flex items-center gap-0.5">
                                  {s.code}
                                  <X className="h-2.5 w-2.5" />
                                </span>
                              ) : (
                                <span className="inline-flex items-center gap-0.5">
                                  {s.code}
                                  <Plus className="h-2.5 w-2.5" />
                                </span>
                              )}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        <div className="flex justify-end gap-2 border-t pt-4">
          <Button
            disabled={isPending || selections.size === 0}
            onClick={handleSubmit}
            data-testid="carriers-continue"
          >
            {isPending
              ? "Saving…"
              : `Save and continue (${selections.size} carrier${selections.size === 1 ? "" : "s"})`}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
