/**
 * Create your agency — the self-serve onboarding step.
 *
 * Shown once, to a Clerk-authenticated user who has no agencyBRIDGE account yet.
 * Submitting calls `POST /auth/provision`, which creates the organization and
 * makes this user its `agency_admin`. Until this screen existed, an org could
 * only be named by whoever ran the provisioning call by hand — which is what
 * made the product an agency-by-agency deployment rather than a self-serve SaaS.
 */
import { useState } from "react";
import { useUser, useAuth } from "@clerk/react";
import { useQueryClient } from "@tanstack/react-query";
import { Building2, Loader2, Mail } from "lucide-react";
import { toast } from "sonner";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/** Mirrors the server's `orgSlug` validation so we fail in the form, not the API. */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
}

export default function CreateOrganizationPage() {
  const { user } = useUser();
  const { getToken } = useAuth();
  const qc = useQueryClient();

  const defaultName = user?.fullName ? `${user.fullName}'s Agency` : "";
  const [orgName, setOrgName] = useState(defaultName);
  const [submitting, setSubmitting] = useState(false);
  // Set when the server reports this address already has a live invitation.
  // Creating an agency here would strand them in a second, empty org while the
  // invitation went unused — so the screen changes rather than toasting.
  const [pendingInvite, setPendingInvite] = useState(false);

  const trimmed = orgName.trim();
  const slug = slugify(trimmed);
  const valid = trimmed.length > 0 && trimmed.length <= 100 && slug.length > 0;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!valid || submitting || !user) return;

    setSubmitting(true);
    try {
      const token = await getToken();
      const base = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";
      const res = await fetch(`${base}/api/auth/provision`, {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          email: user.primaryEmailAddress?.emailAddress ?? "",
          fullName:
            user.fullName ??
            `${user.firstName ?? ""} ${user.lastName ?? ""}`.trim(),
          orgName: trimmed,
          orgSlug: slug,
        }),
      });

      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
          code?: string;
        };
        if (res.status === 409 && body.code === "invitation_pending") {
          setPendingInvite(true);
          setSubmitting(false);
          return;
        }
        throw new Error(body.error ?? "Could not create your agency");
      }

      // Drop every cached query: the caller had no org a moment ago, so any
      // cached 401 would otherwise stick around and bounce them straight back.
      qc.clear();
      await qc.invalidateQueries();
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Could not create your agency",
      );
      setSubmitting(false);
    }
  };

  if (pendingInvite) {
    return (
      <div className="flex min-h-[100dvh] items-center justify-center bg-gradient-to-br from-slate-900 via-blue-950 to-slate-900 px-4">
        <Card className="w-full max-w-md">
          <CardHeader className="space-y-3">
            <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-full bg-primary/10">
              <Mail className="h-5 w-5 text-primary" />
            </div>
            <CardTitle className="text-center text-xl">
              You have already been invited
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4 text-sm text-muted-foreground">
            <p>
              An agency has invited{" "}
              <span className="font-medium text-foreground break-all">
                {user?.primaryEmailAddress?.emailAddress}
              </span>{" "}
              to join them. Open the link in that invitation email to accept it.
            </p>
            <p>
              Creating a new agency here would leave you in an empty one of your
              own, and the invitation unused — so we have stopped short of that.
              If you meant to start your own agency instead, ask them to
              withdraw the invitation first.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-gradient-to-br from-slate-900 via-blue-950 to-slate-900 px-4">
      <Card className="w-full max-w-md">
        <CardHeader className="space-y-3">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10">
            <Building2 className="h-6 w-6 text-primary" />
          </div>
          <CardTitle className="text-2xl">Create your agency</CardTitle>
          <p className="text-sm text-muted-foreground">
            One more step. This names your workspace and makes you its
            administrator — you can invite the rest of your team afterwards.
          </p>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="space-y-5">
            <div className="space-y-2">
              <Label htmlFor="orgName">Agency name</Label>
              <Input
                id="orgName"
                value={orgName}
                onChange={(e) => setOrgName(e.target.value)}
                placeholder="Gunter Senior Benefits"
                maxLength={100}
                autoFocus
                disabled={submitting}
              />
              {slug && (
                <p className="text-xs text-muted-foreground">
                  Workspace URL: <code>{slug}</code>
                </p>
              )}
            </div>

            <Button
              type="submit"
              className="w-full"
              disabled={!valid || submitting}
            >
              {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {submitting ? "Setting up your workspace…" : "Create agency"}
            </Button>

            <p className="text-center text-xs text-muted-foreground">
              You'll start on the free Starter plan. No card required.
            </p>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
