/**
 * White-Label Branding (stage2/calendar-branding) — modelled on the
 * agencyBRIDGE BrandingPage, but edited field by field instead of via a zip
 * kit. Saves to PUT /api/organizations/me/branding; the BrandingProvider then
 * repaints the whole app for every user in the agency.
 *
 * Custom domains are not built — the page says "Coming soon".
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  Globe2,
  ImageIcon,
  LayoutDashboard,
  Loader2,
  Palette,
  RotateCcw,
  Type as TypeIcon,
  Upload,
  Users,
  XCircle,
} from "lucide-react";
import { useGetMe } from "@workspace/api-client-react";
import { PageHeader, SectionCard, StatusPill } from "@/components/shared";
import { BrandLockup } from "@/components/brand/BrandMark";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { apiFetch } from "@/lib/api";
import {
  BRANDING_QUERY_KEY,
  BrandingPreviewProvider,
  brandingVars,
  resolveBranding,
  type BrandingData,
} from "@/lib/branding/BrandingProvider";
import {
  BODY_FONTS,
  BRANDING_DEFAULTS,
  CONTRAST_AA,
  DISPLAY_FONTS,
  HEX_RE,
  SIDEBAR_TEXT,
  contrastLevel,
  contrastRatio,
  googleFontsHref,
} from "@/lib/branding/rules";
import { cn } from "@/lib/utils";

const OWNER_ROLES = new Set(["super_admin", "agency_admin"]);
const UPLOAD_TYPES = ["image/png", "image/jpeg", "image/webp", "image/x-icon", "image/vnd.microsoft.icon"];
const MAX_UPLOAD_BYTES = 1024 * 1024;

interface Draft {
  productName: string;
  tagline: string;
  emailFromName: string;
  primaryColor: string;
  accentColor: string;
  displayFont: string;
  bodyFont: string;
  logoUrl: string;
  markUrl: string;
  faviconUrl: string;
}

function draftFrom(d: BrandingData | undefined): Draft {
  return {
    productName: d?.productName ?? "",
    tagline: d?.tagline ?? "",
    emailFromName: d?.emailFromName ?? "",
    primaryColor: d?.primaryColor ?? "",
    accentColor: d?.accentColor ?? "",
    displayFont: d?.displayFont ?? BRANDING_DEFAULTS.displayFont,
    bodyFont: d?.bodyFont ?? BRANDING_DEFAULTS.bodyFont,
    logoUrl: d?.logoUrl ?? "",
    markUrl: d?.markUrl ?? "",
    faviconUrl: d?.faviconUrl ?? "",
  };
}

const nul = (v: string) => (v.trim() ? v.trim() : null);

async function uploadAsset(file: File): Promise<string> {
  if (!UPLOAD_TYPES.includes(file.type)) {
    throw new Error("Upload a PNG, JPEG, WebP or ICO image. (SVG logos can be linked by https URL.)");
  }
  if (file.size > MAX_UPLOAD_BYTES) throw new Error("Images must be 1 MB or smaller.");
  const headers = { "Content-Type": "application/json" };
  const req = await apiFetch<{ uploadURL: string; objectPath: string }>("/api/storage/uploads/request-url", {
    method: "POST",
    headers,
    body: JSON.stringify({ name: file.name, size: file.size, contentType: file.type }),
  });
  const put = await fetch(req.uploadURL, { method: "PUT", body: file, headers: { "Content-Type": file.type } });
  if (!put.ok) throw new Error("The upload did not reach storage. Try again.");
  const confirmed = await apiFetch<{ objectPath: string }>("/api/storage/uploads/confirm", {
    method: "POST",
    headers,
    body: JSON.stringify({ objectPath: req.objectPath, visibility: "private" }),
  });
  return confirmed.objectPath;
}

function ContrastBadge({ hex }: { hex: string }) {
  if (!HEX_RE.test(hex)) return null;
  const { ratio, level } = contrastLevel(hex);
  const Icon = level === "good" ? CheckCircle2 : level === "large-only" ? AlertTriangle : XCircle;
  const text =
    level === "good" ? "Readable" : level === "large-only" ? "Large text only" : "Too light to read";
  return (
    <StatusPill tone={level === "good" ? "success" : level === "large-only" ? "warning" : "danger"}>
      <Icon className="mr-1 h-3 w-3" />
      {text} · {ratio.toFixed(1)}:1
    </StatusPill>
  );
}

function ColorField({
  id,
  label,
  help,
  value,
  fallback,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  help: string;
  value: string;
  fallback: string;
  disabled: boolean;
  onChange: (v: string) => void;
}) {
  const effective = HEX_RE.test(value) ? value : fallback;
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor={id}>{label}</Label>
        {value && <ContrastBadge hex={value} />}
      </div>
      <div className="flex items-center gap-2">
        <input
          type="color"
          aria-label={`${label} picker`}
          value={effective}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          className="h-9 w-12 cursor-pointer rounded-md border border-input bg-transparent p-0.5"
        />
        <Input
          id={id}
          value={value}
          disabled={disabled}
          placeholder={`${fallback} (default)`}
          onChange={(e) => onChange(e.target.value.trim())}
          className={cn("font-mono", value && !HEX_RE.test(value) && "border-destructive")}
          maxLength={7}
        />
        {value && !disabled && (
          <Button type="button" variant="ghost" size="sm" onClick={() => onChange("")}>Default</Button>
        )}
      </div>
      <p className="text-xs text-muted-foreground">{help}</p>
    </div>
  );
}

function AssetField({
  label,
  help,
  value,
  disabled,
  onChange,
  previewBg,
}: {
  label: string;
  help: string;
  value: string;
  disabled: boolean;
  onChange: (v: string) => void;
  previewBg?: string;
}) {
  const { toast } = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const src = resolveBranding({ logoUrl: value || null }).logoSrc;
  return (
    <div className="rounded-lg border border-border p-3">
      <div className="flex items-start gap-3">
        <div
          className={cn(
            "flex h-14 w-20 shrink-0 items-center justify-center overflow-hidden rounded-md border border-dashed border-border",
            previewBg,
          )}
        >
          {src ? (
            <img src={src} alt="" className="max-h-12 max-w-[72px] object-contain" />
          ) : (
            <ImageIcon className="h-5 w-5 text-muted-foreground/50" />
          )}
        </div>
        <div className="min-w-0 flex-1 space-y-1.5">
          <p className="text-sm font-medium">{label}</p>
          <p className="text-xs text-muted-foreground">{help}</p>
          <div className="flex flex-wrap items-center gap-2">
            <input
              ref={fileRef}
              type="file"
              accept={UPLOAD_TYPES.join(",")}
              className="hidden"
              onChange={async (e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (!file) return;
                setBusy(true);
                try {
                  onChange(await uploadAsset(file));
                } catch (err) {
                  toast({
                    title: "Upload failed",
                    description: err instanceof Error ? err.message : "File storage may not be set up on this server.",
                    variant: "destructive",
                  });
                } finally {
                  setBusy(false);
                }
              }}
            />
            <Button type="button" size="sm" variant="outline" disabled={disabled || busy} onClick={() => fileRef.current?.click()}>
              {busy ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Upload className="mr-1.5 h-3.5 w-3.5" />}
              Upload
            </Button>
            {value && !disabled && (
              <Button type="button" size="sm" variant="ghost" onClick={() => onChange("")}>Remove</Button>
            )}
          </div>
          <Input
            value={value}
            disabled={disabled}
            placeholder="…or paste an https:// image URL"
            onChange={(e) => onChange(e.target.value.trim())}
            className="h-8 text-xs"
            aria-label={`${label} URL`}
          />
        </div>
      </div>
    </div>
  );
}

function PreviewSurface({ draft }: { draft: Draft }) {
  const resolved = useMemo(
    () =>
      resolveBranding({
        productName: nul(draft.productName),
        tagline: nul(draft.tagline),
        primaryColor: HEX_RE.test(draft.primaryColor) ? draft.primaryColor.toLowerCase() : null,
        accentColor: HEX_RE.test(draft.accentColor) ? draft.accentColor.toLowerCase() : null,
        displayFont: draft.displayFont,
        bodyFont: draft.bodyFont,
        logoUrl: nul(draft.logoUrl),
        markUrl: nul(draft.markUrl),
        faviconUrl: nul(draft.faviconUrl),
      }),
    [draft],
  );

  // Preview-only font loading for unsaved choices.
  useEffect(() => {
    const href = googleFontsHref([draft.displayFont, draft.bodyFont]);
    const id = "branding-preview-fonts";
    let link = document.getElementById(id) as HTMLLinkElement | null;
    if (!href) {
      link?.remove();
      return;
    }
    if (!link) {
      link = document.createElement("link");
      link.id = id;
      link.rel = "stylesheet";
      document.head.appendChild(link);
    }
    if (link.href !== href) link.href = href;
  }, [draft.displayFont, draft.bodyFont]);

  const vars = brandingVars(resolved, "light") as CSSProperties;
  const display = `'${resolved.displayFont}', system-ui, sans-serif`;
  const body = `'${resolved.bodyFont}', system-ui, sans-serif`;

  return (
    <BrandingPreviewProvider value={resolved}>
      <div className="overflow-hidden rounded-xl border border-border shadow-sm" style={vars} aria-label="Live preview">
        <div className="flex min-h-[300px]" style={{ fontFamily: body }}>
          <div className="w-44 shrink-0 bg-sidebar p-3 text-sidebar-foreground">
            <BrandLockup
              size={30}
              tone="light"
              subtitle={BRANDING_DEFAULTS.tagline}
              wordmarkClassName="text-white text-xs"
              subtitleClassName="text-sidebar-foreground"
            />
            <div className="mt-5 space-y-1 text-xs">
              <div className="flex items-center gap-2 rounded-md bg-sidebar-primary px-2 py-1.5 font-medium text-sidebar-primary-foreground">
                <LayoutDashboard className="h-3.5 w-3.5" /> Dashboard
              </div>
              <div className="flex items-center gap-2 rounded-md px-2 py-1.5">
                <Users className="h-3.5 w-3.5" /> Clients & Leads
              </div>
            </div>
          </div>
          <div className="flex-1 space-y-3 bg-[#f4f7fb] p-4 text-[#0f172a]">
            <p className="text-lg font-bold" style={{ fontFamily: display }}>Page heading</p>
            <div
              className="rounded-lg p-3 text-white"
              style={{ backgroundImage: "linear-gradient(135deg, var(--kpi-navy-from), var(--kpi-navy-to))" }}
            >
              <p className="text-[11px] text-white/75">Headline card</p>
              <p className="text-xl font-bold" style={{ fontFamily: display }}>Aa Bb Cc</p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground">Primary button</span>
              <span className="text-xs font-medium text-accent underline">Accent link</span>
            </div>
            <p className="text-[11px] text-[#475569]">Sample content for the preview only.</p>
          </div>
        </div>
      </div>
    </BrandingPreviewProvider>
  );
}

function ComingSoon({ icon: Icon, title, children }: { icon: typeof Globe2; title: string; children: ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-border bg-card/60 p-4">
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted text-accent">
          <Icon className="h-5 w-5" />
        </div>
        <div>
          <p className="flex items-center gap-2 text-sm font-semibold">
            {title}
            <span className="rounded-full bg-warning/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-700 dark:text-warning">
              Coming soon
            </span>
          </p>
          <p className="mt-1 text-xs text-muted-foreground">{children}</p>
        </div>
      </div>
    </div>
  );
}

export default function BrandingPage() {
  const { data: me } = useGetMe();
  const canEdit = me?.role ? OWNER_ROLES.has(me.role as string) : false;
  const qc = useQueryClient();
  const { toast } = useToast();

  const { data, isLoading, isError } = useQuery({
    queryKey: BRANDING_QUERY_KEY,
    queryFn: () => apiFetch<BrandingData>("/api/organizations/me/branding"),
  });

  const [draft, setDraft] = useState<Draft>(() => draftFrom(undefined));
  const [serverWarnings, setServerWarnings] = useState<string[]>([]);
  const [resetOpen, setResetOpen] = useState(false);
  useEffect(() => {
    if (data) setDraft(draftFrom(data));
  }, [data]);

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => ({ ...d, [k]: v }));

  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(draftFrom(data)), [draft, data]);
  const invalidColor =
    (draft.primaryColor && !HEX_RE.test(draft.primaryColor)) || (draft.accentColor && !HEX_RE.test(draft.accentColor));
  const tooLight = [draft.primaryColor, draft.accentColor].some(
    (c) => HEX_RE.test(c) && contrastLevel(c).level === "fail",
  );
  const sidebarStaysDefault = HEX_RE.test(draft.primaryColor) && contrastRatio(draft.primaryColor, SIDEBAR_TEXT) < CONTRAST_AA;

  const save = useMutation({
    mutationFn: () =>
      apiFetch<BrandingData>("/api/organizations/me/branding", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          productName: nul(draft.productName),
          tagline: nul(draft.tagline),
          emailFromName: nul(draft.emailFromName),
          primaryColor: nul(draft.primaryColor),
          accentColor: nul(draft.accentColor),
          displayFont: draft.displayFont === BRANDING_DEFAULTS.displayFont ? null : draft.displayFont,
          bodyFont: draft.bodyFont === BRANDING_DEFAULTS.bodyFont ? null : draft.bodyFont,
          logoUrl: nul(draft.logoUrl),
          markUrl: nul(draft.markUrl),
          faviconUrl: nul(draft.faviconUrl),
        }),
      }),
    onSuccess: (saved) => {
      qc.setQueryData(BRANDING_QUERY_KEY, saved);
      setServerWarnings(saved.warnings ?? []);
      toast({ title: "Branding saved", description: "Everyone in your agency sees it on their next page load." });
    },
    onError: (err: Error) => toast({ title: "Could not save branding", description: err.message, variant: "destructive" }),
  });

  const reset = useMutation({
    mutationFn: () => apiFetch<BrandingData>("/api/organizations/me/branding", { method: "DELETE" }),
    onSuccess: (fresh) => {
      qc.setQueryData(BRANDING_QUERY_KEY, fresh);
      setServerWarnings([]);
      setResetOpen(false);
      toast({ title: "Branding reset", description: "Your agency is back on the default agencyBRIDGE look." });
    },
    onError: (err: Error) => toast({ title: "Could not reset", description: err.message, variant: "destructive" }),
  });

  const disabled = !canEdit || save.isPending || isLoading;

  return (
    <div className="space-y-6">
      <PageHeader
        title="White-Label Branding"
        subtitle="Apply your agency's colors, logo, mark, favicon and product name across the app."
      >
        {canEdit && (
          <>
            <Button variant="outline" onClick={() => setResetOpen(true)} disabled={!data || data.isDefault || reset.isPending}>
              <RotateCcw className="mr-1.5 h-4 w-4" /> Reset to default
            </Button>
            <Button onClick={() => save.mutate()} disabled={!dirty || Boolean(invalidColor) || tooLight || save.isPending}>
              {save.isPending && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
              Save changes
            </Button>
          </>
        )}
      </PageHeader>

      {!canEdit && me && (
        <div className="flex items-start gap-3 rounded-xl border border-warning/40 bg-warning/10 px-4 py-3 text-sm">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
          <span>Only agency owners can change branding. You can see what is applied below.</span>
        </div>
      )}
      {isError && (
        <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          Could not load your branding. Refresh to try again.
        </p>
      )}
      {serverWarnings.length > 0 && (
        <div className="rounded-xl border border-warning/40 bg-warning/10 px-4 py-3 text-sm">
          {serverWarnings.map((w) => (
            <p key={w} className="flex items-start gap-2"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />{w}</p>
          ))}
        </div>
      )}

      <div className="grid grid-cols-1 items-start gap-6 xl:grid-cols-[1.25fr_1fr]">
        <div className="space-y-6">
          <SectionCard title="Identity" icon={Palette} description="The name people see in the sidebar, browser tab and emails.">
            {isLoading ? (
              <Skeleton className="h-40" />
            ) : (
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="b-name">Product name</Label>
                  <Input id="b-name" value={draft.productName} maxLength={40} disabled={disabled} placeholder="agencyBRIDGE (default)" onChange={(e) => set("productName", e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="b-tag">Tagline</Label>
                  <Input id="b-tag" value={draft.tagline} maxLength={80} disabled={disabled} placeholder="Agency Platform (default)" onChange={(e) => set("tagline", e.target.value)} />
                </div>
                <div className="space-y-1.5 sm:col-span-2">
                  <Label htmlFor="b-from">Email sender name</Label>
                  <Input id="b-from" value={draft.emailFromName} maxLength={60} disabled={disabled} placeholder={data?.orgName ?? "Your agency"} onChange={(e) => set("emailFromName", e.target.value)} />
                  <p className="text-xs text-muted-foreground">Used as the "From" name on appointment reminders sent to your clients.</p>
                </div>
              </div>
            )}
          </SectionCard>

          <SectionCard title="Colors" icon={Palette} description="Checked against a white background so text and buttons stay readable.">
            <div className="grid gap-5 sm:grid-cols-2">
              <ColorField
                id="b-primary"
                label="Primary"
                help="Buttons, headings and — when dark enough — the sidebar."
                value={draft.primaryColor}
                fallback={BRANDING_DEFAULTS.primaryColor}
                disabled={disabled}
                onChange={(v) => set("primaryColor", v)}
              />
              <ColorField
                id="b-accent"
                label="Accent"
                help="Links, highlights and the active menu item."
                value={draft.accentColor}
                fallback={BRANDING_DEFAULTS.accentColor}
                disabled={disabled}
                onChange={(v) => set("accentColor", v)}
              />
            </div>
            {tooLight && (
              <p role="alert" className="mt-4 text-sm text-destructive">
                One of your colors is too light to read on white (under 3:1). Pick a darker shade to save.
              </p>
            )}
            {sidebarStaysDefault && !tooLight && (
              <p className="mt-4 text-xs text-muted-foreground">
                Your primary color is too light for white sidebar text, so the sidebar keeps the default navy.
              </p>
            )}
          </SectionCard>

          <SectionCard title="Typography" icon={TypeIcon} description="Chosen from a set of well-hinted Google Fonts.">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label>Headings</Label>
                <Select value={draft.displayFont} onValueChange={(v) => set("displayFont", v)} disabled={disabled}>
                  <SelectTrigger aria-label="Heading font"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {DISPLAY_FONTS.map((f) => <SelectItem key={f} value={f}>{f}{f === BRANDING_DEFAULTS.displayFont ? " (default)" : ""}</SelectItem>)}
                  </SelectContent>
                </Select>
                <p className="text-lg font-bold" style={{ fontFamily: `'${draft.displayFont}'` }}>Medicare made simple</p>
              </div>
              <div className="space-y-1.5">
                <Label>Body text</Label>
                <Select value={draft.bodyFont} onValueChange={(v) => set("bodyFont", v)} disabled={disabled}>
                  <SelectTrigger aria-label="Body font"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {BODY_FONTS.map((f) => <SelectItem key={f} value={f}>{f}{f === BRANDING_DEFAULTS.bodyFont ? " (default)" : ""}</SelectItem>)}
                  </SelectContent>
                </Select>
                <p className="text-sm" style={{ fontFamily: `'${draft.bodyFont}'` }}>Your clients' coverage, reviewed on time, every year.</p>
              </div>
            </div>
          </SectionCard>

          <SectionCard title="Logo, mark & favicon" icon={ImageIcon} description="PNG, JPEG, WebP or ICO up to 1 MB. Stored in your agency's private file storage.">
            <div className="space-y-3">
              <AssetField label="Full logo" help="Replaces the mark and name in the sidebar. Wide images work best." value={draft.logoUrl} disabled={disabled} onChange={(v) => set("logoUrl", v)} />
              <AssetField label="Mark" help="Square icon shown next to the name and in the collapsed sidebar." value={draft.markUrl} disabled={disabled} onChange={(v) => set("markUrl", v)} previewBg="bg-navy-900" />
              <AssetField label="Favicon" help="The small icon in the browser tab." value={draft.faviconUrl} disabled={disabled} onChange={(v) => set("faviconUrl", v)} />
            </div>
          </SectionCard>
        </div>

        <div className="space-y-6 xl:sticky xl:top-20">
          <SectionCard
            title="Live preview"
            description={dirty ? "Unsaved changes — this is how the app will look." : "What every signed-in user in your agency sees right now."}
          >
            <PreviewSurface draft={draft} />
            <div className="mt-3 flex items-center justify-between text-xs text-muted-foreground">
              <span>{data?.isDefault ? "Default agencyBRIDGE identity — nothing customised yet." : "Custom branding is applied."}</span>
              {data?.updatedAt && <span>Last saved {new Date(data.updatedAt).toLocaleDateString()}</span>}
            </div>
          </SectionCard>

          <ComingSoon icon={Globe2} title="Custom domain">
            Serving the app from your own address (for example portal.youragency.com) is on the way. Until then,
            your branding applies at the usual address.
          </ComingSoon>
        </div>
      </div>

      <AlertDialog open={resetOpen} onOpenChange={setResetOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reset branding to the default?</AlertDialogTitle>
            <AlertDialogDescription>
              Your agency goes back to the agencyBRIDGE name, colors, fonts and logo for everyone. Uploaded files are not deleted.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => reset.mutate()}>Reset</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
