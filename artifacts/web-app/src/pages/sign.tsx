/**
 * Mediflow E-Sign (Beta) signing window.
 *
 * Renders the unsigned carrier-contracting PDF, captures explicit consent
 * + a signature, then POSTs to `/esign/envelopes/:id/sign`.
 *
 * Demo-quality, not full ESIGN/UETA-defensible. The "Beta" badge is
 * non-negotiable per the brief.
 *
 * The server captures the actual audit IP + user-agent from request
 * headers; this page does NOT send either to the API — trusting the
 * client there defeats the purpose.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useParams, useLocation } from "wouter";
import { toast } from "sonner";
import SignaturePad from "signature_pad";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  ArrowLeft,
  CheckCircle2,
  Download,
  FileText,
  Info,
  Loader2,
  PenLine,
  Type as TypeIcon,
} from "lucide-react";
import { useEnvelope, useSignEnvelope } from "@/lib/onboarding/api";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
const CONSENT_VERSION = "v1-beta";

type SignMode = "type" | "draw";

function svgFromTypedName(name: string): string {
  // Trivial SVG that embeds the typed name in a cursive font. The backend
  // is the source of truth for the signed PDF visual; we just need to
  // produce an SVG string of provenance for the audit payload.
  const safe = name
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 80">',
    '<text x="10" y="55" font-family="\'Brush Script MT\',cursive"',
    ' font-size="44" fill="#1e3a8a">',
    safe,
    "</text>",
    "</svg>",
  ].join("");
}

export default function SignPage() {
  const params = useParams<{ envelopeId: string }>();
  const envelopeId = params.envelopeId ?? "";
  const [, setLocation] = useLocation();

  const { data: envelope, isLoading, error } = useEnvelope(envelopeId);
  const signEnvelope = useSignEnvelope(envelopeId);

  // Form state
  const [mode, setMode] = useState<SignMode>("type");
  const [typedName, setTypedName] = useState("");
  const [consent1, setConsent1] = useState(false);
  const [consent2, setConsent2] = useState(false);
  const [consent3, setConsent3] = useState(false);
  const [drawnSvg, setDrawnSvg] = useState<string | null>(null);
  const [scrolledToBottom, setScrolledToBottom] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [completed, setCompleted] = useState<{
    signedPdfDocumentId: string;
    integritySha256: string;
  } | null>(null);

  // Canvas refs
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const padRef = useRef<SignaturePad | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  // If the envelope is already completed when we land here, show the
  // confirmation immediately rather than re-presenting the form.
  useEffect(() => {
    if (
      envelope &&
      (envelope.status === "completed" || envelope.status === "signed") &&
      envelope.signedPdfDocumentId &&
      envelope.integritySha256
    ) {
      setCompleted({
        signedPdfDocumentId: envelope.signedPdfDocumentId,
        integritySha256: envelope.integritySha256,
      });
    }
  }, [envelope]);

  // Wire up signature_pad when the canvas mounts and the user is on the
  // draw tab. We initialise lazily so the canvas is in the DOM first.
  useEffect(() => {
    if (mode !== "draw") return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    // Match canvas backing-store to its CSS pixel size — otherwise lines
    // render fuzzy on HiDPI displays.
    const ratio = Math.max(window.devicePixelRatio || 1, 1);
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * ratio;
    canvas.height = rect.height * ratio;
    const ctx = canvas.getContext("2d");
    if (ctx) ctx.scale(ratio, ratio);

    const pad = new SignaturePad(canvas, {
      backgroundColor: "rgba(255,255,255,0)",
      penColor: "#1e3a8a",
    });
    padRef.current = pad;
    return () => {
      pad.off();
      padRef.current = null;
    };
  }, [mode]);

  const handleClearDraw = () => {
    padRef.current?.clear();
    setDrawnSvg(null);
  };

  const captureDrawnSignature = (): string | null => {
    const pad = padRef.current;
    if (!pad || pad.isEmpty()) return null;
    return pad.toSVG();
  };

  // Track that the user has actually scrolled to the bottom of the PDF
  // iframe before we'll let them tick the consent boxes. We can't read the
  // iframe document (different origin / asset stream), so we fall back to
  // an explicit "I have scrolled" affordance plus a load event timer.
  const handleIframeLoad = () => {
    // After the PDF has loaded, give the user a small window before we
    // assume they've scrolled. The explicit checkbox below is the
    // canonical gate; this just relaxes the affordance after load.
  };

  // Radix Checkbox passes the new checked value (boolean | "indeterminate").
  // The old handler hard-set `true`, so once ticked the box could never be
  // unticked — leaving the user stuck with consent rows that stayed disabled
  // if they wanted to revise their attestation.
  const handleConfirmScroll = (v: boolean | "indeterminate") =>
    setScrolledToBottom(v === true);

  // Submission gating
  const consentsTicked = consent1 && consent2 && consent3;
  const typedNameTrimmed = typedName.trim();
  const hasSignature =
    mode === "type"
      ? typedNameTrimmed.length > 0
      : drawnSvg !== null || (padRef.current && !padRef.current.isEmpty());

  const canSubmit =
    scrolledToBottom &&
    consentsTicked &&
    typedNameTrimmed.length > 0 &&
    Boolean(hasSignature) &&
    !signEnvelope.isPending;

  const handleSubmit = async () => {
    setSubmitError(null);
    if (!canSubmit) return;

    let signatureSvg: string;
    if (mode === "draw") {
      const captured = captureDrawnSignature();
      if (!captured) {
        setSubmitError("Please draw your signature before signing.");
        return;
      }
      signatureSvg = captured;
    } else {
      signatureSvg = svgFromTypedName(typedNameTrimmed);
    }

    try {
      const res = await signEnvelope.mutateAsync({
        typedName: typedNameTrimmed,
        signatureSvg,
        consentToElectronicBusiness: true,
        intentToSign: true,
      });
      setCompleted({
        signedPdfDocumentId: res.signedPdfDocumentId,
        integritySha256: res.integritySha256,
      });
      toast.success("Document signed");
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to sign document";
      setSubmitError(message);
      // Do NOT clear the form — user can correct and retry.
    }
  };

  const pdfUrl = useMemo(() => {
    if (!envelope) return null;
    return `${BASE}/api/documents/${envelope.pdfDocumentId}/download`;
  }, [envelope]);

  // -- Confirmation view -----------------------------------------------------
  // Demo-friendly: a big visual checkmark, a clear "done with this carrier"
  // sentence, prominent "back to onboarding" CTA, and the integrity hash
  // tucked into a tooltip so the headline isn't a cryptographic string of
  // dread.
  if (completed) {
    const signedUrl = `${BASE}/api/esign/envelopes/${envelopeId}/signed-pdf`;
    return (
      <FullScreenShell>
        <Card
          className="max-w-2xl mx-auto"
          data-testid="sign-confirmation"
        >
          <CardContent className="py-8 sm:py-10 px-4 sm:px-8 space-y-6 text-center">
            <div className="mx-auto h-16 w-16 sm:h-20 sm:w-20 rounded-full bg-green-100 flex items-center justify-center">
              <CheckCircle2 className="h-10 w-10 sm:h-12 sm:w-12 text-green-600" />
            </div>
            <div className="space-y-1">
              <h2 className="text-xl sm:text-2xl font-semibold">
                You're done with this carrier
              </h2>
              <p className="text-sm text-muted-foreground max-w-md mx-auto">
                Your signature has been recorded. Your admin will submit the
                signed packet to the carrier's appointment desk.
              </p>
            </div>
            <div className="flex flex-col sm:flex-row gap-2 justify-center pt-2">
              <Button
                size="lg"
                onClick={() => setLocation("/onboarding")}
                data-testid="return-to-onboarding"
                className="w-full sm:w-auto"
              >
                <ArrowLeft className="h-4 w-4 mr-2" />
                Back to my onboarding
              </Button>
              <a
                href={signedUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center justify-center gap-2 rounded-md border bg-background px-4 py-2 text-sm font-medium hover:bg-muted w-full sm:w-auto"
                data-testid="download-signed-pdf"
              >
                <Download className="h-4 w-4" />
                Download signed PDF
              </a>
            </div>
            <details className="pt-4 border-t group">
              <summary
                className="text-[10px] text-muted-foreground hover:text-foreground inline-flex items-center gap-1 cursor-pointer list-none"
                data-testid="integrity-hash-trigger"
              >
                <Info className="h-3 w-3" />
                Integrity hash
              </summary>
              <div className="mt-2 rounded-md bg-muted/40 px-3 py-2 max-w-md mx-auto">
                <p className="text-[10px] font-medium text-muted-foreground mb-1">
                  SHA-256 of signed PDF
                </p>
                <p
                  className="font-mono text-[10px] break-all text-left"
                  data-testid="integrity-hash"
                >
                  {completed.integritySha256}
                </p>
              </div>
            </details>
          </CardContent>
        </Card>
      </FullScreenShell>
    );
  }

  // -- Loading / error -------------------------------------------------------
  // Skeleton matches the real layout (doc viewer, consent block, signature
  // pad, action buttons) so the page doesn't reflow when data lands.
  if (isLoading) {
    return (
      <FullScreenShell>
        <div
          className="max-w-3xl mx-auto space-y-6"
          data-testid="sign-loading"
        >
          <Card>
            <CardContent className="py-6 space-y-3">
              <Skeleton className="h-5 w-48" />
              <Skeleton className="h-4 w-72" />
              <Skeleton className="h-[300px] w-full sm:h-[500px] rounded-md" />
              <Skeleton className="h-4 w-64" />
            </CardContent>
          </Card>
          <Card>
            <CardContent className="py-6 space-y-3">
              <Skeleton className="h-5 w-32" />
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-3/4" />
            </CardContent>
          </Card>
          <Card>
            <CardContent className="py-6 space-y-3">
              <Skeleton className="h-5 w-32" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-24 w-full" />
            </CardContent>
          </Card>
        </div>
      </FullScreenShell>
    );
  }

  if (error || !envelope) {
    return (
      <FullScreenShell>
        <Card className="max-w-2xl mx-auto" data-testid="sign-error">
          <CardHeader>
            <CardTitle>Unable to load signing envelope</CardTitle>
            <CardDescription>
              {error instanceof Error ? error.message : "Envelope not found."}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button
              variant="outline"
              onClick={() => setLocation("/onboarding")}
            >
              <ArrowLeft className="h-4 w-4 mr-2" />
              Back to onboarding
            </Button>
          </CardContent>
        </Card>
      </FullScreenShell>
    );
  }

  if (envelope.status === "voided") {
    return (
      <FullScreenShell>
        <Card className="max-w-2xl mx-auto">
          <CardHeader>
            <CardTitle>This envelope has been voided</CardTitle>
            <CardDescription>
              It can no longer be signed. Contact your agency administrator
              if you need a replacement.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button onClick={() => setLocation("/onboarding")}>
              Back to onboarding
            </Button>
          </CardContent>
        </Card>
      </FullScreenShell>
    );
  }

  return (
    <FullScreenShell>
      <div className="max-w-3xl mx-auto space-y-6" data-testid="sign-page">
        {/* 1. Document viewer */}
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <FileText className="h-5 w-5 text-primary" />
              <CardTitle className="text-base">
                Review the document
              </CardTitle>
            </div>
            <CardDescription>
              Read the document below. You must confirm you've scrolled
              through it before signing.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {pdfUrl ? (
              <iframe
                ref={iframeRef}
                title="Carrier contracting document"
                src={pdfUrl}
                onLoad={handleIframeLoad}
                className="w-full h-[360px] sm:h-[500px] rounded-md border bg-muted"
                data-testid="pdf-viewer"
              />
            ) : (
              <div className="h-[200px] flex items-center justify-center text-sm text-muted-foreground border rounded-md">
                No document attached to this envelope.
              </div>
            )}
            <div className="flex items-center gap-2 pt-1">
              <Checkbox
                id="scroll-confirm"
                checked={scrolledToBottom}
                onCheckedChange={handleConfirmScroll}
                data-testid="scroll-confirm"
              />
              <Label
                htmlFor="scroll-confirm"
                className="text-sm cursor-pointer"
              >
                I have scrolled through and reviewed the document above.
              </Label>
            </div>
          </CardContent>
        </Card>

        {/* 2. Consent disclosures */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Consent</CardTitle>
            <CardDescription>
              You must agree to all three of the following before signing.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <ConsentRow
              id="consent-electronic"
              checked={consent1}
              disabled={!scrolledToBottom}
              onCheckedChange={(v) => setConsent1(v)}
              testId="consent-electronic"
              label="I agree to conduct business electronically and acknowledge that my electronic signature has the same legal effect as a handwritten signature."
            />
            <ConsentRow
              id="consent-understood"
              checked={consent2}
              disabled={!scrolledToBottom}
              onCheckedChange={(v) => setConsent2(v)}
              testId="consent-understood"
              label="I have read and understood this document and intend to sign it."
            />
            <ConsentRow
              id="consent-paper-copy"
              checked={consent3}
              disabled={!scrolledToBottom}
              onCheckedChange={(v) => setConsent3(v)}
              testId="consent-paper-copy"
              label="I understand I can request a paper copy of this document by contacting my agency administrator."
            />
            <p className="text-xs text-muted-foreground pt-1">
              You can withdraw consent at any time before clicking Sign by
              closing this window. No partial signature is stored.
            </p>
          </CardContent>
        </Card>

        {/* 3. Signature capture */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Your signature</CardTitle>
            <CardDescription>
              Type your full legal name. Optionally, draw your signature on
              the canvas as well.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="typed-name">
                Typed name <span className="text-destructive">*</span>
              </Label>
              <Input
                id="typed-name"
                value={typedName}
                onChange={(e) => setTypedName(e.target.value)}
                placeholder="e.g. Jane Q. Agent"
                autoComplete="name"
                data-testid="typed-name"
              />
              <p className="text-xs text-muted-foreground">
                Required even when drawing — used for audit-trail attribution.
              </p>
            </div>

            <Tabs
              value={mode}
              onValueChange={(v) => setMode(v as SignMode)}
              className="w-full"
            >
              <TabsList>
                <TabsTrigger value="type" data-testid="mode-type">
                  <TypeIcon className="h-4 w-4 mr-1" />
                  Type
                </TabsTrigger>
                <TabsTrigger value="draw" data-testid="mode-draw">
                  <PenLine className="h-4 w-4 mr-1" />
                  Draw
                </TabsTrigger>
              </TabsList>
              <TabsContent value="type" className="pt-3">
                <div
                  className="border rounded-md bg-white px-4 py-6 min-h-[88px] flex items-center"
                  data-testid="typed-preview"
                  aria-live="polite"
                >
                  <span
                    className="text-3xl text-blue-900"
                    style={{ fontFamily: "'Brush Script MT', cursive" }}
                  >
                    {typedNameTrimmed || (
                      <span className="text-muted-foreground text-base italic">
                        Your signature will preview here
                      </span>
                    )}
                  </span>
                </div>
              </TabsContent>
              <TabsContent value="draw" className="pt-3 space-y-2">
                <div className="border rounded-md bg-white">
                  <canvas
                    ref={canvasRef}
                    aria-label="Signature drawing canvas"
                    role="img"
                    className="w-full h-[160px] touch-none rounded-md"
                    data-testid="signature-canvas"
                    onPointerUp={() => {
                      // Snapshot the drawn signature on each stroke end so
                      // the gating UI re-renders without polling the pad.
                      const captured = captureDrawnSignature();
                      setDrawnSvg(captured);
                    }}
                  />
                </div>
                <div className="flex justify-end">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={handleClearDraw}
                    data-testid="clear-canvas"
                  >
                    Clear
                  </Button>
                </div>
              </TabsContent>
            </Tabs>
          </CardContent>
        </Card>

        {/* 4. Sign + complete */}
        <Card>
          <CardContent className="pt-6 space-y-3">
            {submitError && (
              <div
                role="alert"
                className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive"
                data-testid="submit-error"
              >
                {submitError}
              </div>
            )}
            <div className="flex flex-col-reverse sm:flex-row sm:items-center sm:justify-between gap-3">
              <Button
                variant="outline"
                onClick={() => setLocation("/onboarding")}
                data-testid="cancel-sign"
                className="w-full sm:w-auto"
              >
                <ArrowLeft className="h-4 w-4 mr-2" />
                Back to onboarding
              </Button>
              <Button
                size="lg"
                disabled={!canSubmit}
                onClick={handleSubmit}
                data-testid="submit-sign"
                className="w-full sm:w-auto"
              >
                {signEnvelope.isPending ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Signing…
                  </>
                ) : (
                  "Sign and complete"
                )}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Consent version {CONSENT_VERSION}. Your IP and device info
              are recorded by the server when you click Sign.
            </p>
          </CardContent>
        </Card>
      </div>
    </FullScreenShell>
  );
}

function ConsentRow({
  id,
  checked,
  disabled,
  onCheckedChange,
  label,
  testId,
}: {
  id: string;
  checked: boolean;
  disabled: boolean;
  onCheckedChange: (v: boolean) => void;
  label: string;
  testId: string;
}) {
  return (
    <div className="flex items-start gap-3">
      <Checkbox
        id={id}
        checked={checked}
        disabled={disabled}
        onCheckedChange={(v) => onCheckedChange(v === true)}
        data-testid={testId}
        className="mt-0.5"
      />
      <Label
        htmlFor={id}
        className="text-sm leading-relaxed cursor-pointer font-normal"
      >
        {label}
      </Label>
    </div>
  );
}

function FullScreenShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-muted/30">
      <header className="border-b bg-background sticky top-0 z-10">
        <div className="max-w-3xl mx-auto flex items-center justify-between px-4 py-3">
          <div className="flex items-center gap-2">
            <FileText className="h-5 w-5 text-primary" />
            <span className="font-semibold">Mediflow E-Sign</span>
            <Tooltip>
              <TooltipTrigger asChild>
                <Badge
                  variant="outline"
                  className="ml-1 cursor-help border-amber-400 bg-amber-50 text-amber-900"
                  data-testid="beta-badge"
                >
                  <Info className="h-3 w-3 mr-1" />
                  Beta
                </Badge>
              </TooltipTrigger>
              <TooltipContent className="max-w-xs">
                This is our in-house signing flow. Production-grade hardening
                in progress.
              </TooltipContent>
            </Tooltip>
          </div>
        </div>
      </header>
      <main className="px-3 sm:px-4 py-4 sm:py-6">{children}</main>
    </div>
  );
}
