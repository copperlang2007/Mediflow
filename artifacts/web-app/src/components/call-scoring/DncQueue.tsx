import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { customFetch } from "@workspace/api-client-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { EmptyState, SectionCard, StatusPill } from "@/components/shared";
import { PhoneOff } from "lucide-react";
import { DncResolveControls } from "./DncResolveControls";
import {
  PAGE_SIZE,
  Pager,
  QK,
  SPEAKER_LABEL,
  callLabel,
  fmtClock,
  fmtDate,
  type CsDncItem,
} from "./shared";

interface DncList {
  items: CsDncItem[];
  total: number;
  note: string;
}

export function DncQueue({
  onOpenCall,
}: {
  onOpenCall: (transcriptId: string) => void;
}) {
  const [status, setStatus] = useState<"open" | "resolved">("open");
  const [offset, setOffset] = useState(0);
  const { data, isLoading, isError } = useQuery({
    queryKey: [...QK, "dnc", status, offset],
    queryFn: () =>
      customFetch<DncList>(
        `/api/call-scoring/dnc-review?status=${status}&limit=${PAGE_SIZE}&offset=${offset}`,
      ),
  });
  const chooseStatus = (s: "open" | "resolved") => {
    setOffset(0);
    setStatus(s);
  };

  return (
    <SectionCard
      title="Possible do-not-contact requests"
      description="Wording on a call that may be a request to stop contact. Nothing is added to the do-not-contact list until you confirm it here."
      actions={
        <div className="flex gap-1">
          <Button
            size="sm"
            variant={status === "open" ? "default" : "outline"}
            onClick={() => chooseStatus("open")}
          >
            To review
          </Button>
          <Button
            size="sm"
            variant={status === "resolved" ? "default" : "outline"}
            onClick={() => chooseStatus("resolved")}
          >
            Handled
          </Button>
        </div>
      }
    >
      {isLoading ? (
        <div className="space-y-3">
          {[0, 1].map((i) => (
            <Skeleton key={i} className="h-28 w-full" />
          ))}
        </div>
      ) : isError ? (
        <p role="alert" className="text-sm text-destructive">
          The list could not be loaded.
        </p>
      ) : !data || (data.items.length === 0 && offset === 0) ? (
        status === "open" ? (
          <EmptyState
            icon={PhoneOff}
            title="No possible requests waiting"
            description="When a scored call has wording like “stop calling me” or “take me off your list”, it shows up here for you to confirm or dismiss."
          />
        ) : (
          <EmptyState
            icon={PhoneOff}
            title="Nothing handled yet"
            description="Requests you confirm or dismiss will be listed here with who decided and when."
          />
        )
      ) : (
        <>
          <ul className="space-y-3">
            {data.items.map((item) => (
              <li
                key={item.findingId}
                className="rounded-lg border border-border p-4"
                data-testid="dnc-item"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-xs text-muted-foreground">
                      {SPEAKER_LABEL[item.speaker]}
                      {item.startSeconds !== null
                        ? ` · at ${fmtClock(item.startSeconds)}`
                        : ""}{" "}
                      · {callLabel(item)}
                      {item.agent ? ` · Agent ${item.agent.name}` : ""}
                    </p>
                    <blockquote className="mt-1 border-l-2 border-warning pl-3 text-sm font-medium">
                      “{item.quote ?? "(text no longer available)"}”
                    </blockquote>
                    {item.speakerMode !== "labelled" && (
                      <p className="mt-1 text-xs text-muted-foreground">
                        This file has no speaker labels, so it is not certain
                        the client said this.
                      </p>
                    )}
                  </div>
                  <StatusPill
                    tone={
                      item.status === "open"
                        ? "warning"
                        : item.status === "opt_out_added"
                          ? "danger"
                          : "neutral"
                    }
                  >
                    {item.status === "open"
                      ? "To review"
                      : item.status === "opt_out_added"
                        ? "Added to list"
                        : "Dismissed"}
                  </StatusPill>
                </div>
                <div className="mt-2 text-sm text-muted-foreground">
                  {item.contact ? (
                    <>
                      Client:{" "}
                      <span className="text-foreground">
                        {item.contact.name}
                      </span>
                      {item.contact.phoneLast4
                        ? ` · phone ends ${item.contact.phoneLast4}`
                        : ""}
                    </>
                  ) : item.contactMatch === "phone_ambiguous" ? (
                    "More than one client uses this phone number. Pick one below."
                  ) : (
                    "Not linked to a client. You can still add the phone number."
                  )}
                </div>
                <div className="mt-3">
                  {item.status === "open" ? (
                    <DncResolveControls
                      findingId={item.findingId}
                      contact={item.contact}
                      candidates={item.candidates}
                      moreCandidates={item.moreCandidates ?? false}
                      numbers={item.numbers ?? []}
                      channel={item.channel ?? "phone"}
                      emailOnFile={item.emailOnFile ?? null}
                    />
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      {item.resolution?.action === "add_opt_out"
                        ? "Added to the do-not-contact list"
                        : "Dismissed"}{" "}
                      by {item.resolution?.reviewerName ?? "a reviewer"} on{" "}
                      {fmtDate(item.resolution?.at)}
                      {item.resolution?.note
                        ? `: ${item.resolution.note}`
                        : "."}
                    </p>
                  )}
                </div>
                <Button
                  size="sm"
                  variant="link"
                  className="mt-1 px-0"
                  onClick={() => onOpenCall(item.transcriptId)}
                >
                  Open the call
                </Button>
              </li>
            ))}
          </ul>
          <Pager
            offset={offset}
            total={data.total}
            shown={data.items.length}
            onChange={setOffset}
            label="Requests"
          />
        </>
      )}
    </SectionCard>
  );
}
