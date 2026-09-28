/**
 * Team & seats.
 *
 * The front end for the invitation API. Until this screen existed an agency
 * could only ever contain the person who created it — the endpoints shipped
 * with no way to reach them.
 *
 * One thing drives the layout: **a seat is a login, and a pending invitation
 * holds one**. An admin deciding whether to invite needs the remaining count
 * in front of them, and needs to see that a sent-but-unaccepted invitation is
 * already costing a seat. So members and invitations share one table rather
 * than sitting in separate tabs — they are the same ledger.
 */
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  UserPlus,
  Mail,
  Copy,
  RotateCcw,
  Loader2,
  AlertTriangle,
  Users,
  Clock,
  Ban,
  Check,
} from "lucide-react";

import { apiRequest } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
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
import { PageHeader, SectionCard, StatusPill, EmptyState } from "@/components/shared";
import { PageShell, TableFrame } from "@/components/ops";

/** Roles an admin may hand out. Mirrors INVITABLE_ROLES on the server. */
const INVITABLE_ROLES = [
  { value: "agent", label: "Agent" },
  { value: "agent_support", label: "Agent Support" },
  { value: "compliance_manager", label: "Compliance Manager" },
  { value: "viewer", label: "Viewer" },
  { value: "agency_admin", label: "Agency Admin" },
] as const;

const ROLE_LABELS: Record<string, string> = {
  super_admin: "Super Admin",
  agency_admin: "Agency Admin",
  compliance_manager: "Compliance Manager",
  agent_support: "Agent Support",
  viewer: "Viewer",
  agent: "Agent",
  developer: "Developer",
};

interface SeatUsage {
  limit: number;
  activeUsers: number;
  pendingInvitations: number;
  used: number;
  available: number;
}

interface Invitation {
  id: string;
  email: string;
  role: string;
  status: "pending" | "accepted" | "revoked" | "expired";
  expiresAt: string;
  acceptedAt: string | null;
  revokedAt: string | null;
  invitedByUserId: string;
  createdAt: string;
}

interface Member {
  id: string;
  email: string;
  fullName: string;
  role: string;
  isActive: boolean;
  lastLoginAt: string | null;
}

/** A member and a pending invitation are the same thing to the invoice. */
type Row =
  | { kind: "member"; member: Member }
  | { kind: "invitation"; invitation: Invitation };

function errMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

function relativeDays(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  const days = Math.round(ms / 86_400_000);
  if (days < 0) return "expired";
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  return `in ${days} days`;
}

function SeatMeter({ seats }: { seats: SeatUsage }) {
  const pct = Math.min(100, (seats.used / Math.max(seats.limit, 1)) * 100);
  const full = seats.available === 0;

  return (
    <SectionCard
      title="Seats"
      description="Each person who can sign in uses one seat — so does an invitation that hasn't been accepted yet"
      icon={Users}
      contentClassName="space-y-3"
    >
        <div className="flex items-baseline justify-between">
          <span className="font-display text-3xl font-bold tabular-nums">
            {seats.used}
            <span className="text-muted-foreground text-base font-normal">
              {" / "}
              {seats.limit}
            </span>
          </span>
          <span
            className={
              full
                ? "text-sm font-medium text-destructive"
                : "text-sm text-muted-foreground"
            }
          >
            {full
              ? "No seats available"
              : `${seats.available} available`}
          </span>
        </div>

        <Progress value={pct} className="h-2.5" />

        <p className="text-xs text-muted-foreground">
          {seats.activeUsers} active{" "}
          {seats.activeUsers === 1 ? "member" : "members"}
          {seats.pendingInvitations > 0 && (
            <>
              {" · "}
              <span className="text-foreground">
                {seats.pendingInvitations} pending{" "}
                {seats.pendingInvitations === 1 ? "invitation" : "invitations"}
              </span>{" "}
              holding a seat
            </>
          )}
        </p>

        {full && (
          <Alert>
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription className="text-xs">
              Revoke a pending invitation, deactivate a member, or upgrade your
              plan to add more.
            </AlertDescription>
          </Alert>
        )}
    </SectionCard>
  );
}

export default function TeamPage() {
  const qc = useQueryClient();
  const [inviteOpen, setInviteOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<string>("agent");
  // The surfaced accept link is tied to the invitation that owns it. A single
  // URL slot was not enough: clearing it on any emailed resend took away a
  // *different* invitation's still-valid link, since the server rotates only
  // the token of the row it resent.
  const [lastInvite, setLastInvite] = useState<{
    id: string;
    url: string;
  } | null>(null);
  const [deactivating, setDeactivating] = useState<Member | null>(null);
  const [revoking, setRevoking] = useState<Invitation | null>(null);

  const invitations = useQuery({
    queryKey: ["invitations"],
    queryFn: () =>
      apiRequest<{ data: Invitation[]; seats: SeatUsage }>("/api/invitations"),
  });

  const members = useQuery({
    queryKey: ["users", "team"],
    queryFn: () =>
      apiRequest<{ data: Member[]; total: number }>("/api/users?limit=200"),
  });

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["invitations"] });
    void qc.invalidateQueries({ queryKey: ["users", "team"] });
  };

  const invite = useMutation({
    mutationFn: () =>
      apiRequest<{
        invitation: Invitation;
        acceptUrl: string;
        emailSent: boolean;
      }>("/api/invitations", {
        method: "POST",
        body: JSON.stringify({ email: email.trim(), role }),
      }),
    onSuccess: (res) => {
      setInviteOpen(false);
      setEmail("");
      setRole("agent");
      refresh();
      if (res.emailSent) {
        toast.success(`Invitation sent to ${res.invitation.email}`);
      } else {
        // Email is not configured on this deployment. The link is the only way
        // the invitee gets in, so surface it rather than silently succeeding.
        setLastInvite({ id: res.invitation.id, url: res.acceptUrl });
        toast.success("Invitation created — copy the link to share it");
      }
    },
    onError: (err) => toast.error(errMessage(err, "Could not send invitation")),
  });

  const resend = useMutation({
    mutationFn: (id: string) =>
      apiRequest<{ acceptUrl: string; emailSent: boolean }>(
        `/api/invitations/${id}/resend`,
        { method: "POST" },
      ),
    onSuccess: (res, id) => {
      refresh();
      if (res.emailSent) {
        // A resend rotates this invitation's token, so a link on screen FOR
        // THIS invitation is now dead and must go. Another invitation's link
        // is untouched by it and must stay.
        setLastInvite((cur) => (cur?.id === id ? null : cur));
        toast.success("Invitation resent");
      } else {
        setLastInvite({ id, url: res.acceptUrl });
        toast.success("New link generated — the previous one no longer works");
      }
    },
    onError: (err) => toast.error(errMessage(err, "Could not resend")),
  });

  const revoke = useMutation({
    mutationFn: (id: string) =>
      apiRequest(`/api/invitations/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      setRevoking(null);
      refresh();
      toast.success("Invitation revoked — the seat is free");
    },
    onError: (err) => {
      setRevoking(null);
      toast.error(errMessage(err, "Could not revoke"));
    },
  });

  const setActive = useMutation({
    mutationFn: (vars: { id: string; isActive: boolean }) =>
      apiRequest(`/api/users/${vars.id}/active`, {
        method: "PATCH",
        body: JSON.stringify({ isActive: vars.isActive }),
      }),
    onSuccess: (_res, vars) => {
      setDeactivating(null);
      refresh();
      toast.success(
        vars.isActive
          ? "Member reactivated"
          : "Member deactivated — the seat is free",
      );
    },
    onError: (err) => {
      setDeactivating(null);
      toast.error(errMessage(err, "Could not update member"));
    },
  });

  const loading = invitations.isLoading || members.isLoading;

  if (loading) {
    return (
      <PageShell>
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-40 rounded-xl" />
        <Skeleton className="h-72 rounded-xl" />
      </PageShell>
    );
  }

  if (invitations.isError || members.isError || !invitations.data) {
    return (
      <PageShell>
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Team unavailable</AlertTitle>
          <AlertDescription>
            {errMessage(
              invitations.error ?? members.error,
              "Could not load your team. Refresh, or contact support if this persists.",
            )}
          </AlertDescription>
        </Alert>
      </PageShell>
    );
  }

  const seats = invitations.data.seats;
  const pending = invitations.data.data.filter((i) => i.status === "pending");
  const memberList = members.data?.data ?? [];

  const rows: Row[] = [
    ...memberList.map((member): Row => ({ kind: "member", member })),
    ...pending.map((invitation): Row => ({ kind: "invitation", invitation })),
  ];

  const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  const noSeats = seats.available === 0;

  return (
    <PageShell>
      <PageHeader
        title="Team"
        subtitle="Who can sign in to your agency, and what each seat costs you."
      >
        <Button onClick={() => setInviteOpen(true)} disabled={noSeats}>
          <UserPlus className="mr-2 h-4 w-4" />
          Invite member
        </Button>
      </PageHeader>

      <SeatMeter seats={seats} />

      {lastInvite && (
        <Alert>
          <Mail className="h-4 w-4" />
          <AlertTitle>Share this link</AlertTitle>
          <AlertDescription className="space-y-2">
            <p className="text-xs">
              Email is not configured on this deployment, so the invitation was
              not delivered. This link is shown once.
            </p>
            <div className="flex items-center gap-2">
              <code className="flex-1 truncate rounded bg-muted px-2 py-1 text-xs">
                {lastInvite.url}
              </code>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  void navigator.clipboard
                    .writeText(lastInvite.url)
                    .then(() => toast.success("Link copied"))
                    .catch(() => toast.error("Could not copy — select it manually"));
                }}
              >
                <Copy className="mr-1.5 h-3.5 w-3.5" />
                Copy
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      )}

      <SectionCard
        title="Members & invitations"
        description="Everyone with a login, plus invitations still waiting to be accepted"
        icon={UserPlus}
      >
          <TableFrame className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={4} className="p-0">
                      <EmptyState
                        compact
                        icon={Users}
                        title="No members yet. Invite someone to get started."
                      />
                    </TableCell>
                  </TableRow>
                )}

                {rows.map((row) =>
                  row.kind === "member" ? (
                    <TableRow key={`m-${row.member.id}`}>
                      <TableCell>
                        <div className="flex items-center gap-3">
                          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-navy-100 text-navy-800 text-xs font-semibold dark:bg-secondary dark:text-secondary-foreground" aria-hidden>
                            {row.member.fullName.split(" ").map((n) => n[0]).join("").slice(0, 2).toUpperCase()}
                          </span>
                          <div>
                            <div className="font-medium">{row.member.fullName}</div>
                            <div className="text-xs text-muted-foreground">
                              {row.member.email}
                            </div>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell className="text-sm">
                        {ROLE_LABELS[row.member.role] ?? row.member.role}
                      </TableCell>
                      <TableCell>
                        {row.member.isActive ? (
                          <StatusPill tone="success">Active</StatusPill>
                        ) : (
                          <StatusPill tone="neutral">Deactivated</StatusPill>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        {row.member.isActive ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setDeactivating(row.member)}
                          >
                            <Ban className="mr-1.5 h-3.5 w-3.5" />
                            Deactivate
                          </Button>
                        ) : (
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={noSeats || setActive.isPending}
                            title={
                              noSeats
                                ? "No seats available — free one first"
                                : undefined
                            }
                            onClick={() =>
                              setActive.mutate({
                                id: row.member.id,
                                isActive: true,
                              })
                            }
                          >
                            <Check className="mr-1.5 h-3.5 w-3.5" />
                            Reactivate
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ) : (
                    <TableRow key={`i-${row.invitation.id}`}>
                      <TableCell>
                        <div className="font-medium text-muted-foreground pl-12">
                          {row.invitation.email}
                        </div>
                        <div className="text-xs text-muted-foreground pl-12">
                          Invited, not yet accepted
                        </div>
                      </TableCell>
                      <TableCell className="text-sm">
                        {ROLE_LABELS[row.invitation.role] ??
                          row.invitation.role}
                      </TableCell>
                      <TableCell>
                        <StatusPill tone="warning" className="gap-1">
                          <Clock className="h-3 w-3" />
                          Expires {relativeDays(row.invitation.expiresAt)}
                        </StatusPill>
                      </TableCell>
                      <TableCell className="text-right whitespace-nowrap">
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={resend.isPending}
                          onClick={() => resend.mutate(row.invitation.id)}
                        >
                          <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
                          Resend
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setRevoking(row.invitation)}
                        >
                          Revoke
                        </Button>
                      </TableCell>
                    </TableRow>
                  ),
                )}
              </TableBody>
            </Table>
          </TableFrame>
      </SectionCard>

      {/* Invite dialog */}
      <Dialog open={inviteOpen} onOpenChange={setInviteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Invite a member</DialogTitle>
            <DialogDescription>
              They will receive a link to join this agency. The invitation holds
              a seat until it is accepted, revoked, or expires.
            </DialogDescription>
          </DialogHeader>

          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (emailValid && !invite.isPending) invite.mutate();
            }}
          >
            <div className="space-y-2">
              <Label htmlFor="invite-email">Email address</Label>
              <Input
                id="invite-email"
                type="email"
                autoComplete="off"
                placeholder="colleague@youragency.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="invite-role">Role</Label>
              <Select value={role} onValueChange={setRole}>
                <SelectTrigger id="invite-role">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {INVITABLE_ROLES.map((r) => (
                    <SelectItem key={r.value} value={r.value}>
                      {r.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                onClick={() => setInviteOpen(false)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={!emailValid || invite.isPending}>
                {invite.isPending && (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                )}
                Send invitation
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Deactivate confirmation */}
      <AlertDialog
        open={deactivating !== null}
        onOpenChange={(open) => !open && setDeactivating(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Deactivate {deactivating?.fullName}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              They will no longer be able to sign in, and the seat returns to
              your plan. Their record, assigned contacts, and history are kept —
              you can reactivate them later if a seat is free.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() =>
                deactivating &&
                setActive.mutate({ id: deactivating.id, isActive: false })
              }
            >
              Deactivate
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Revoke confirmation */}
      <AlertDialog
        open={revoking !== null}
        onOpenChange={(open) => !open && setRevoking(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke this invitation?</AlertDialogTitle>
            <AlertDialogDescription>
              The link sent to {revoking?.email} will stop working immediately,
              and the seat it holds returns to your plan.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => revoking && revoke.mutate(revoking.id)}
            >
              Revoke
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </PageShell>
  );
}
