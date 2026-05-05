import { useUser } from "@clerk/react";
import { useGetMe, useGetMyOrganization } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Settings, User, Building2, Shield } from "lucide-react";

export default function SettingsPage() {
  const { user: clerkUser } = useUser();
  const { data: me, isLoading: meLoading } = useGetMe();
  const { data: org, isLoading: orgLoading } = useGetMyOrganization();

  return (
    <div className="p-6 space-y-5 max-w-3xl mx-auto">
      <div>
        <h1 className="text-2xl font-bold">Settings</h1>
        <p className="text-sm text-muted-foreground mt-0.5">Manage your profile and organization</p>
      </div>

      {/* Profile */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <User className="h-4 w-4 text-primary" />
            Your Profile
          </CardTitle>
        </CardHeader>
        <CardContent>
          {meLoading ? (
            <div className="flex items-center gap-4">
              <Skeleton className="h-16 w-16 rounded-full" />
              <div className="space-y-2 flex-1">
                <Skeleton className="h-4 w-48" />
                <Skeleton className="h-3 w-36" />
              </div>
            </div>
          ) : me ? (
            <div className="flex items-center gap-4">
              <Avatar className="h-16 w-16">
                <AvatarImage src={clerkUser?.imageUrl} />
                <AvatarFallback className="text-lg bg-primary/10 text-primary">
                  {me.fullName.split(" ").map((n) => n[0]).join("").slice(0, 2)}
                </AvatarFallback>
              </Avatar>
              <div>
                <p className="font-semibold text-lg">{me.fullName}</p>
                <p className="text-sm text-muted-foreground">{me.email}</p>
                <Badge variant="secondary" className="mt-1 text-xs capitalize">
                  {me.role.replace("_", " ")}
                </Badge>
              </div>
            </div>
          ) : null}
        </CardContent>
      </Card>

      {/* Organization */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <Building2 className="h-4 w-4 text-primary" />
            Organization
          </CardTitle>
        </CardHeader>
        <CardContent>
          {orgLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-4 w-48" />
              <Skeleton className="h-3 w-32" />
            </div>
          ) : org ? (
            <div className="space-y-3">
              <div>
                <p className="font-semibold">{org.name}</p>
                <p className="text-sm text-muted-foreground">/{org.slug}</p>
              </div>
              <Separator />
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Plan</span>
                <Badge variant="secondary" className="capitalize">{org.planTier}</Badge>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Created</span>
                <span>{new Date(org.createdAt).toLocaleDateString()}</span>
              </div>
            </div>
          ) : null}
        </CardContent>
      </Card>

      {/* Security */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <Shield className="h-4 w-4 text-primary" />
            Security
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Manage your password, MFA, and active sessions through the account settings below.
          </p>
          <div className="mt-3 p-3 rounded-lg bg-muted/50 text-xs text-muted-foreground">
            Authentication is managed by Clerk. All sessions are secured with HTTPS and short-lived tokens.
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
