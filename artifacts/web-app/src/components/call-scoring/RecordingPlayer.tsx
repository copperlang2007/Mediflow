/**
 * "Listen to the recording" on a call. Nothing is fetched until the person
 * presses the button, so only real listens are logged. The link works for
 * about ten minutes; when it ends the player says so and a new press gets a
 * fresh one. There is no download button.
 */
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { customFetch } from "@workspace/api-client-react";
import { Headphones } from "lucide-react";
import { Button } from "@/components/ui/button";
import { apiMessage } from "./shared";

interface ListenLink {
  url: string;
  expiresInSeconds: number;
  contentType: string | null;
}

export function RecordingPlayer({ transcriptId }: { transcriptId: string }) {
  const [link, setLink] = useState<ListenLink | null>(null);
  const [linkEnded, setLinkEnded] = useState(false);
  const [unsupported, setUnsupported] = useState(false);
  const listen = useMutation({
    mutationFn: () => customFetch<ListenLink>(`/api/call-scoring/transcripts/${transcriptId}/audio`),
    onSuccess: (data) => {
      setLink(data);
      setLinkEnded(false);
      setUnsupported(false);
    },
  });

  return (
    <div className="space-y-2 rounded-lg border border-border bg-muted/30 p-3 text-sm" data-testid="recording-player">
      {link ? (
        <audio
          controls
          autoPlay
          controlsList="nodownload"
          src={link.url}
          aria-label="Call recording"
          className="w-full"
          onError={(e) => {
            const el = e.currentTarget;
            const type = link?.contentType;
            setLink(null);
            // 4 = MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED (literal: jsdom may not define the constant).
            // Chromium also raises 4 for 403/404/expired links, so only blame the format when the browser says it cannot play that type.
            if (el.error?.code === 4 && !!type && el.canPlayType(type) === "") setUnsupported(true);
            else setLinkEnded(true);
          }}
        />
      ) : (
        <Button size="sm" variant="outline" disabled={listen.isPending} onClick={() => listen.mutate()}>
          <Headphones className="mr-1 h-4 w-4" />
          Listen to the recording
        </Button>
      )}
      <p className="text-xs text-muted-foreground">Each time you listen is recorded in the audit log. The link works for about {Math.round((link?.expiresInSeconds ?? 600) / 60)} minutes.</p>
      {listen.isError && (
        <p role="alert" className="text-sm text-destructive">
          {apiMessage(listen.error, "The recording could not be loaded. Nothing was changed.")}
        </p>
      )}
      {unsupported && (
        <p role="alert" className="text-sm text-warning">
          This recording is in a format your browser cannot play (for example AMR). Ask your agency admin to open it in another player.
        </p>
      )}
      {linkEnded && (
        <p role="alert" className="text-sm text-warning">
          The recording could not be loaded, usually because its ten-minute link ended (it can also be an audio format your browser cannot decode). Press Listen again to get a new one; if it fails again, ask your agency admin to check the recording.
        </p>
      )}
    </div>
  );
}
