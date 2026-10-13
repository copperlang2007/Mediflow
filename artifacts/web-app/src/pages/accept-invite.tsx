/**
 * Accept an invitation.
 *
 * The only screen in the app reachable by someone who is not yet a member of
 * any agency, which shapes every decision here:
 *
 *  - It sits OUTSIDE `ProtectedLayout`, so the provisioning gate never sees it.
 *    Routed through the gate, an invitee would be bounced to the create-your-
 *    agency screen and would end up founding a second, empty org — exactly the
 *    failure the invitation flow exists to prevent.
 *  - The invitation is previewed BEFORE sign-in. Someone deciding whether to
 *    create an account deserves to see which agency invited them and in what
 *    role first; asking them to sign up and then find out is backwards.
 *  - The token is the credential and travels only in the query string. It is
 *    never rendered, never logged, and the preview response carries nothing
 *    about the organization beyond its name.
 */
import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useUser, useAuth } from "@clerk/react";
import { useSearch } from "wouter";
import { toast } from "sonner";
import { Building2, Loader2, ShieldAlert, Check } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  clearPendingInvite,
  rememberPendingInvite,
  setPendingInviteExpiry,
} from "@/lib/pendingInvite";

interface InvitationPreview {
  email: string;
  role: string;
  roleLabel: string;
  organizationName: string;
  expiresAt: string;
}

/** Server-side `code` values this screen explains in plain language. */
const REASONS: Record<string, string> = {
  invalid: "This invitation link is not valid. Check that you copied all of it.",
  expired:
    "This invitation has expired. Ask whoever invited you to send a new one.",
  accepted: "This invitation has already been used.",
  revoked: "This invitation was withdrawn by the agency.",
};

/** Failures that mean this link can never work, as opposed to "try again". */
const TERMINAL_CODES = new Set([
  "invalid",
  "expired",
  "accepted",
  "revoked",
  "already_provisioned",
]);

const RETRY_MESSAGE =
  "We could not check this invitation just now. Please try again in a moment.";

class TransientLookupError extends Error {}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-gradient-to-br from-slate-900 via-blue-950 to-slate-900 px-4 py-10">
      <Card className="w-full max-w-md">{children}</Card>
    </div>
  );
}

export default function AcceptInvitePage() {
  const search = useSearch();
  const token = new URLSearchParams(search).get("token") ?? "";

  const { user, isSignedIn, isLoaded } = useUser();
  const { getToken } = useAuth();
  const qc = useQueryClient();

  const [fullName, setFullName] = useState("");
  const [touchedName, setTouchedName] = useState(false);

  // Sign-up can drop this URL (the verification email opens another tab, MFA
  // enrolment redirects). Remember the link so the provisioning gate can send
  // the person back here instead of to "Create your agency".
  useEffect(() => {
    if (token) rememberPendingInvite(token);
  }, [token]);

  const preview = useQuery({
    queryKey: ["invitation-preview", token],
    enabled: token.length > 0,
    retry: false,
    queryFn: async () => {
      const base = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";
      let res: Response;
      try {
        res = await fetch(
          `${base}/api/invitations/lookup?token=${encodeURIComponent(token)}`,
          { credentials: "include" },
        );
      } catch {
        // Offline or the request was cut: the link itself may be fine.
        throw new TransientLookupError(RETRY_MESSAGE);
      }
      const body = (await res.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;
      if (!res.ok) {
        const code = typeof body.code === "string" ? body.code : "";
        const terminal =
          TERMINAL_CODES.has(code) ||
          res.status === 400 ||
          res.status === 404 ||
          res.status === 410;
        if (!terminal) {
          // Rate limit or a server hiccup says nothing about the link, so keep
          // it: forgetting it here would strand a good invitee after sign-up.
          throw new TransientLookupError(RETRY_MESSAGE);
        }
        // A link that can never work must not keep pulling the person back.
        clearPendingInvite(token);
        throw new Error(REASONS[code] ?? REASONS.invalid);
      }
      return body as unknown as InvitationPreview;
    },
  });

  const previewExpiry = preview.data?.expiresAt;
  useEffect(() => {
    if (token && previewExpiry) setPendingInviteExpiry(token, previewExpiry);
  }, [token, previewExpiry]);

  const accept = useMutation({
    // The name travels as a mutation variable rather than being read from
    // state inside the closure. Reading state worked, but only because React
    // Query happens to re-read `mutationFn` after the setState flush — the
    // submit handler sets the name and fires in the same tick. That is an
    // ordering accident, and the failure it would eventually produce is an
    // empty `fullName` on the most common path: an invitee who accepts without
    // editing the prefilled name.
    mutationFn: async (name: string) => {
      const clerkToken = await getToken();
      const base = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";
      const res = await fetch(`${base}/api/invitations/accept`, {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          ...(clerkToken ? { Authorization: `Bearer ${clerkToken}` } : {}),
        },
        body: JSON.stringify({ token, fullName: name.trim() }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
          code?: string;
        };
        // Link used, withdrawn, expired, or this account already has an
        // agency: retrying cannot help, so stop sending the person back.
        if (body.code && TERMINAL_CODES.has(body.code)) {
          clearPendingInvite(token);
        }
        throw new Error(body.error ?? "Could not accept this invitation");
      }
      return res.json();
    },
    onSuccess: () => {
      clearPendingInvite(token);
      // The caller had no org a moment ago; any cached 401 would bounce them
      // straight back out of the app they have just been let into.
      qc.clear();
      window.location.href = `${import.meta.env.BASE_URL?.replace(/\/$/, "") ?? ""}/dashboard`;
    },
    onError: (err) =>
      toast.error(
        err instanceof Error ? err.message : "Could not accept this invitation",
      ),
  });

  if (!token) {
    return (
      <Shell>
        <CardHeader>
          <div className="mx-auto mb-2 flex h-11 w-11 items-center justify-center rounded-full bg-destructive/10">
            <ShieldAlert className="h-5 w-5 text-destructive" />
          </div>
          <CardTitle className="text-center">Invitation link missing</CardTitle>
        </CardHeader>
        <CardContent className="text-center text-sm text-muted-foreground">
          This page needs the full link from your invitation email.
        </CardContent>
      </Shell>
    );
  }

  if (preview.isLoading || !isLoaded) {
    return (
      <Shell>
        <CardHeader className="space-y-3">
          <Skeleton className="mx-auto h-11 w-11 rounded-full" />
          <Skeleton className="mx-auto h-6 w-48" />
        </CardHeader>
        <CardContent className="space-y-3">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-10 w-full" />
        </CardContent>
      </Shell>
    );
  }

  if (preview.isError || !preview.data) {
    return (
      <Shell>
        <CardHeader>
          <div className="mx-auto mb-2 flex h-11 w-11 items-center justify-center rounded-full bg-destructive/10">
            <ShieldAlert className="h-5 w-5 text-destructive" />
          </div>
          <CardTitle className="text-center">Invitation unavailable</CardTitle>
        </CardHeader>
        <CardContent className="text-center text-sm text-muted-foreground">
          {preview.error instanceof Error
            ? preview.error.message
            : REASONS.invalid}
          {preview.error instanceof TransientLookupError && (
            <div className="mt-4">
              <Button variant="secondary" onClick={() => preview.refetch()}>
                Try again
              </Button>
            </div>
          )}
        </CardContent>
      </Shell>
    );
  }

  const invitation = preview.data;
  const signInUrl = `/sign-in?redirect_url=${encodeURIComponent(
    window.location.pathname + window.location.search,
  )}`;
  const signUpUrl = `/sign-up?redirect_url=${encodeURIComponent(
    window.location.pathname + window.location.search,
  )}`;

  const effectiveName = touchedName
    ? fullName
    : (fullName || user?.fullName || "");
  const nameValid = effectiveName.trim().length > 0;

  return (
    <Shell>
      <CardHeader className="space-y-3">
        <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-full bg-primary/10">
          <Building2 className="h-5 w-5 text-primary" />
        </div>
        <CardTitle className="text-center text-xl">
          Join {invitation.organizationName}
        </CardTitle>
        <p className="text-center text-sm text-muted-foreground">
          You have been invited as a{" "}
          <span className="font-medium text-foreground">
            {invitation.roleLabel}
          </span>
          .
        </p>
      </CardHeader>

      <CardContent className="space-y-4">
        <div className="rounded-lg border bg-muted/40 px-3 py-2 text-sm">
          <div className="text-xs text-muted-foreground">
            Invitation sent to
          </div>
          <div className="font-medium break-all">{invitation.email}</div>
        </div>

        {!isSignedIn ? (
          <>
            <p className="text-sm text-muted-foreground">
              Sign in or create an account to accept. Use{" "}
              <span className="font-medium text-foreground break-all">
                {invitation.email}
              </span>{" "}
              if you can, so your colleagues recognise you.
            </p>
            <div className="grid gap-2">
              <Button asChild>
                <a href={signUpUrl}>Create an account</a>
              </Button>
              <Button asChild variant="secondary">
                <a href={signInUrl}>I already have an account</a>
              </Button>
            </div>
          </>
        ) : (
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (nameValid && !accept.isPending) {
                accept.mutate(effectiveName);
              }
            }}
          >
            <div className="space-y-2">
              <Label htmlFor="accept-name">Your name</Label>
              <Input
                id="accept-name"
                value={effectiveName}
                maxLength={100}
                placeholder="Jane Doe"
                onChange={(e) => {
                  setTouchedName(true);
                  setFullName(e.target.value);
                }}
              />
              <p className="text-xs text-muted-foreground">
                How you will appear to the rest of the agency.
              </p>
            </div>

            <Button
              type="submit"
              className="w-full"
              disabled={!nameValid || accept.isPending}
            >
              {accept.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Check className="mr-2 h-4 w-4" />
              )}
              Accept invitation
            </Button>

            <p className="text-center text-xs text-muted-foreground">
              Signed in as {user?.primaryEmailAddress?.emailAddress}.{" "}
              <a href={signInUrl} className="underline">
                Use a different account
              </a>
              {" · "}
              <button
                type="button"
                className="underline"
                onClick={() => {
                  clearPendingInvite(token);
                  window.location.href = `${import.meta.env.BASE_URL?.replace(/\/$/, "") ?? ""}/`;
                }}
              >
                Not now, forget this invitation
              </button>
            </p>
          </form>
        )}
      </CardContent>
    </Shell>
  );
}
