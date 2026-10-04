/**
 * Name-based pickers that replace raw ID text boxes.
 *
 * Each one reads an existing, org-scoped list endpoint (agents, users,
 * sequences, pipelines) and stores the same ID the old text box did, so the
 * saved data is unchanged. An ID that isn't in the list (for example a rule
 * saved before the agent left) is kept and shown as "Unknown", never dropped.
 */
import {
  useGetAgents,
  useGetPipelines,
  useGetSequences,
  useGetUsers,
  getGetAgentsQueryKey,
  getGetUsersQueryKey,
} from "@workspace/api-client-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";

const NONE = "__none__";

export interface PickerOption {
  value: string;
  label: string;
  hint?: string;
}

interface BasePickerProps {
  value: string | null | undefined;
  onChange: (value: string) => void;
  /** Label for the "nothing chosen" option; when omitted a choice is required. */
  noneLabel?: string;
  placeholder?: string;
  className?: string;
  triggerClassName?: string;
  "aria-label"?: string;
  disabled?: boolean;
}

export function EntityPicker({
  value,
  onChange,
  options,
  loading,
  noneLabel,
  placeholder = "Choose…",
  emptyLabel = "Nothing to choose from yet",
  triggerClassName,
  className,
  disabled,
  ...rest
}: BasePickerProps & { options: PickerOption[]; loading?: boolean; emptyLabel?: string }) {
  const current = value ?? "";
  const known = options.some((o) => o.value === current);
  return (
    <div className={className}>
      <Select
        value={current === "" ? (noneLabel ? NONE : undefined) : current}
        onValueChange={(v) => onChange(v === NONE ? "" : v)}
        disabled={disabled}
      >
        <SelectTrigger className={cn("h-8 text-xs", triggerClassName)} aria-label={rest["aria-label"]}>
          <SelectValue placeholder={loading ? "Loading…" : placeholder} />
        </SelectTrigger>
        <SelectContent className="max-h-72">
          {noneLabel && (
            <SelectItem value={NONE} className="text-xs">
              {noneLabel}
            </SelectItem>
          )}
          {current !== "" && !known && !loading && (
            <SelectItem value={current} className="text-xs">
              Unknown ({current.slice(0, 8)}…)
            </SelectItem>
          )}
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value} className="text-xs">
              {o.label}
              {o.hint && <span className="ml-1.5 text-muted-foreground">{o.hint}</span>}
            </SelectItem>
          ))}
          {!loading && options.length === 0 && (
            <div className="px-2 py-1.5 text-xs text-muted-foreground">{emptyLabel}</div>
          )}
        </SelectContent>
      </Select>
    </div>
  );
}

const AGENT_PARAMS = { limit: 1000, sortBy: "name", sortDir: "asc" } as const;

export function AgentPicker({ showEmail, ...props }: BasePickerProps & { showEmail?: boolean }) {
  const { data, isLoading } = useGetAgents(AGENT_PARAMS, {
    query: { queryKey: getGetAgentsQueryKey(AGENT_PARAMS), staleTime: 60_000 },
  });
  // `showEmail` adds the email after the name, for forms where the choice is
  // money-bearing (commission attribution) and two agents may share a name.
  const options = (data?.agents ?? []).map((a) => {
    const name = `${a.firstName} ${a.lastName}`.trim();
    return {
      value: a.id,
      label: name || a.email,
      hint: showEmail && name && a.email ? a.email : undefined,
    };
  });
  return (
    <EntityPicker {...props} options={options} loading={isLoading} placeholder={props.placeholder ?? "Choose an agent"} emptyLabel="No agents yet" />
  );
}

const USER_PARAMS = { isActive: true, limit: 200 } as const;

export function UserPicker(props: BasePickerProps) {
  const { data, isLoading } = useGetUsers(USER_PARAMS, {
    query: { queryKey: getGetUsersQueryKey(USER_PARAMS), staleTime: 60_000 },
  });
  const options = (data?.data ?? []).map((u) => ({ value: u.id, label: u.fullName || u.email }));
  return (
    <EntityPicker {...props} options={options} loading={isLoading} placeholder={props.placeholder ?? "Choose a person"} emptyLabel="No team members yet" />
  );
}

export function SequencePicker(props: BasePickerProps) {
  const { data, isLoading } = useGetSequences();
  const options = (data ?? []).map((s) => ({
    value: s.sequence.id,
    label: s.sequence.name,
    hint: s.sequence.status !== "active" ? `(${s.sequence.status})` : undefined,
  }));
  return (
    <EntityPicker {...props} options={options} loading={isLoading} placeholder={props.placeholder ?? "Choose a sequence"} emptyLabel="No sequences yet" />
  );
}

export function PipelineStagePicker(props: BasePickerProps) {
  const { data, isLoading } = useGetPipelines();
  const pipelines = data ?? [];
  const options = pipelines.flatMap((p) =>
    [...p.stages]
      .sort((a, b) => a.orderIndex - b.orderIndex)
      .map((s) => ({ value: s.id, label: pipelines.length > 1 ? `${p.name} · ${s.name}` : s.name })),
  );
  return (
    <EntityPicker {...props} options={options} loading={isLoading} placeholder={props.placeholder ?? "Choose a stage"} emptyLabel="No pipeline stages yet" />
  );
}
