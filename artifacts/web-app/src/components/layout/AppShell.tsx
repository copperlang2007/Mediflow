import { useState } from "react";
import { Link, useLocation } from "wouter";
import { useUser, useClerk } from "@clerk/react";
import { useGetMe } from "@workspace/api-client-react";
import { cn } from "@/lib/utils";

type Role =
  | "super_admin"
  | "agency_admin"
  | "compliance_manager"
  | "agent_support"
  | "viewer"
  | "agent";

const ALL_ROLES: Role[] = [
  "super_admin", "agency_admin", "compliance_manager",
  "agent_support", "viewer", "agent",
];

const ROLE_LABELS: Record<Role, string> = {
  super_admin: "Super Admin",
  agency_admin: "Agency Admin",
  compliance_manager: "Compliance Mgr",
  agent_support: "Agent Support",
  viewer: "Viewer",
  agent: "Agent",
};

const ROLE_COLORS: Record<Role, string> = {
  super_admin: "bg-purple-100 text-purple-800",
  agency_admin: "bg-blue-100 text-blue-800",
  compliance_manager: "bg-teal-100 text-teal-800",
  agent_support: "bg-sky-100 text-sky-800",
  viewer: "bg-slate-100 text-slate-700",
  agent: "bg-green-100 text-green-800",
};
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  LayoutDashboard,
  Users,
  FileText,
  Award,
  PhoneCall,
  CheckSquare,
  FolderOpen,
  ShieldCheck,
  Settings,
  Menu,
  X,
  Bell,
  ChevronRight,
  LogOut,
  User,
  Building2,
  ChevronLeft,
  RefreshCcw,
} from "lucide-react";
import NotificationPanel from "@/components/notifications/NotificationPanel";
import { useSSENotifications } from "@/hooks/useSSENotifications";

type NavItemDef = {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  roles: Role[];
};

type NavGroup = { group: string; items: NavItemDef[] };

const navItems: NavGroup[] = [
  {
    group: "Core",
    items: [
      { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard, roles: ALL_ROLES },
      {
        href: "/agents", label: "Agents", icon: Users,
        roles: ["super_admin", "agency_admin", "compliance_manager", "agent_support"],
      },
    ],
  },
  {
    group: "Compliance",
    items: [
      { href: "/licensing", label: "Licensing", icon: FileText, roles: ALL_ROLES },
      { href: "/certifications", label: "Certifications", icon: Award, roles: ALL_ROLES },
      {
        href: "/renewals", label: "Renewals", icon: RefreshCcw,
        roles: ["super_admin", "agency_admin", "compliance_manager"],
      },
    ],
  },
  {
    group: "Sales",
    items: [
      {
        href: "/crm", label: "CRM", icon: PhoneCall,
        roles: ["super_admin", "agency_admin", "compliance_manager", "agent_support"],
      },
      { href: "/tasks", label: "Tasks", icon: CheckSquare, roles: ALL_ROLES },
    ],
  },
  {
    group: "Resources",
    items: [
      { href: "/documents", label: "Documents", icon: FolderOpen, roles: ALL_ROLES },
      {
        href: "/compliance", label: "Audit & Compliance", icon: ShieldCheck,
        roles: ["super_admin", "agency_admin", "compliance_manager"],
      },
    ],
  },
];

function NavItem({
  href,
  label,
  icon: Icon,
  collapsed,
}: {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  collapsed: boolean;
}) {
  const [location] = useLocation();
  const isActive = location === href || (href !== "/dashboard" && location.startsWith(href));

  if (collapsed) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Link href={href}>
            <div
              className={cn(
                "flex items-center justify-center h-10 w-10 rounded-lg mx-auto transition-colors cursor-pointer",
                isActive
                  ? "bg-sidebar-primary text-sidebar-primary-foreground"
                  : "text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
              )}
            >
              <Icon className="h-5 w-5" />
            </div>
          </Link>
        </TooltipTrigger>
        <TooltipContent side="right" className="font-medium">
          {label}
        </TooltipContent>
      </Tooltip>
    );
  }

  return (
    <Link href={href}>
      <div
        className={cn(
          "flex items-center gap-3 px-3 h-10 rounded-lg transition-colors cursor-pointer",
          isActive
            ? "bg-sidebar-primary text-sidebar-primary-foreground font-medium"
            : "text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
        )}
      >
        <Icon className="h-5 w-5 shrink-0" />
        <span className="text-sm truncate">{label}</span>
        {isActive && <ChevronRight className="h-3.5 w-3.5 ml-auto shrink-0 opacity-60" />}
      </div>
    </Link>
  );
}

export default function AppShell({ children }: { children: React.ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);
  const { user } = useUser();
  const { signOut } = useClerk();
  const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

  const { unreadCount } = useSSENotifications();
  const { data: me } = useGetMe();
  const userRole = (me?.role ?? null) as Role | null;

  // Filter nav groups to items allowed for this user's role.
  // While role is loading, show all to avoid flicker.
  const filteredNavItems = navItems
    .map((group) => ({
      ...group,
      items: group.items.filter(
        (item) => !userRole || item.roles.includes(userRole),
      ),
    }))
    .filter((group) => group.items.length > 0);

  const sidebarContent = (
    <div className={cn("flex flex-col h-full", collapsed ? "items-center" : "")}>
      {/* Logo */}
      <div
        className={cn(
          "flex items-center gap-3 px-4 h-16 border-b border-sidebar-border shrink-0",
          collapsed && "justify-center px-0"
        )}
      >
        <img
          src={`${basePath}/logo.svg`}
          alt="MediFlow"
          className="h-8 w-8 shrink-0"
        />
        {!collapsed && (
          <div className="min-w-0">
            <p className="font-bold text-sidebar-foreground text-sm truncate">
              MediFlow
            </p>
            <p className="text-xs text-sidebar-foreground/50 truncate">Agency Platform</p>
          </div>
        )}
      </div>

      {/* Nav */}
      <ScrollArea className="flex-1 py-3">
        <div className={cn("space-y-5", collapsed ? "px-2" : "px-3")}>
          {filteredNavItems.map((group) => (
            <div key={group.group}>
              {!collapsed && (
                <p className="text-[10px] uppercase tracking-widest font-semibold text-sidebar-foreground/40 px-3 mb-1">
                  {group.group}
                </p>
              )}
              <div className="space-y-0.5">
                {group.items.map((item) => (
                  <NavItem
                    key={item.href}
                    href={item.href}
                    label={item.label}
                    icon={item.icon}
                    collapsed={collapsed}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      </ScrollArea>

      {/* Settings + User */}
      <div
        className={cn(
          "border-t border-sidebar-border py-3 shrink-0",
          collapsed ? "px-2" : "px-3"
        )}
      >
        <NavItem
          href="/settings"
          label="Settings"
          icon={Settings}
          collapsed={collapsed}
        />

        <div className={cn("mt-2", collapsed ? "flex justify-center" : "")}>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                className={cn(
                  "flex items-center gap-2 w-full rounded-lg transition-colors",
                  collapsed
                    ? "h-10 w-10 justify-center hover:bg-sidebar-accent"
                    : "px-3 h-12 hover:bg-sidebar-accent"
                )}
              >
                <Avatar className="h-7 w-7 shrink-0">
                  <AvatarImage src={user?.imageUrl} />
                  <AvatarFallback className="text-xs bg-sidebar-primary text-sidebar-primary-foreground">
                    {user?.firstName?.[0]}
                    {user?.lastName?.[0]}
                  </AvatarFallback>
                </Avatar>
                {!collapsed && (
                  <div className="min-w-0 text-left flex-1">
                    <p className="text-xs font-medium text-sidebar-foreground truncate">
                      {user?.fullName ?? "User"}
                    </p>
                    <p className="text-[11px] text-sidebar-foreground/50 truncate">
                      {user?.primaryEmailAddress?.emailAddress}
                    </p>
                  </div>
                )}
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" side="right" className="w-52">
              <DropdownMenuItem asChild>
                <Link href="/settings">
                  <User className="h-4 w-4 mr-2" />
                  Profile
                </Link>
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <Link href="/settings">
                  <Building2 className="h-4 w-4 mr-2" />
                  Organization
                </Link>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="text-destructive focus:text-destructive"
                onClick={() => signOut({ redirectUrl: basePath || "/" })}
              >
                <LogOut className="h-4 w-4 mr-2" />
                Sign Out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </div>
  );

  return (
    <div className="flex h-[100dvh] bg-background overflow-hidden">
      {/* Desktop sidebar */}
      <aside
        className={cn(
          "hidden lg:flex flex-col bg-sidebar border-r border-sidebar-border transition-all duration-200 shrink-0 relative",
          collapsed ? "w-16" : "w-60"
        )}
      >
        {sidebarContent}
        <button
          onClick={() => setCollapsed(!collapsed)}
          className="absolute -right-3 top-16 h-6 w-6 rounded-full bg-sidebar-accent border border-sidebar-border flex items-center justify-center text-sidebar-foreground/60 hover:text-sidebar-foreground transition-colors z-10"
        >
          {collapsed ? (
            <ChevronRight className="h-3.5 w-3.5" />
          ) : (
            <ChevronLeft className="h-3.5 w-3.5" />
          )}
        </button>
      </aside>

      {/* Mobile sidebar overlay */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/50 lg:hidden"
          onClick={() => setMobileOpen(false)}
        />
      )}
      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-50 w-60 bg-sidebar border-r border-sidebar-border lg:hidden transition-transform duration-200",
          mobileOpen ? "translate-x-0" : "-translate-x-full"
        )}
      >
        {sidebarContent}
      </aside>

      {/* Main */}
      <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
        {/* Top bar */}
        <header className="h-14 border-b border-border bg-background/95 backdrop-blur flex items-center px-4 gap-3 shrink-0">
          <Button
            variant="ghost"
            size="icon"
            className="lg:hidden"
            onClick={() => setMobileOpen(true)}
          >
            <Menu className="h-5 w-5" />
          </Button>

          <div className="flex-1" />

          {/* Role badge */}
          {userRole && (
            <Badge
              variant="secondary"
              className={cn(
                "text-xs font-medium hidden sm:inline-flex",
                ROLE_COLORS[userRole] ?? "bg-slate-100 text-slate-700",
              )}
            >
              {ROLE_LABELS[userRole] ?? userRole}
            </Badge>
          )}

          {/* Notification bell */}
          <div className="relative">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setNotifOpen(!notifOpen)}
              className="relative"
            >
              <Bell className="h-5 w-5" />
              {unreadCount > 0 && (
                <Badge className="absolute -top-1 -right-1 h-4 min-w-4 px-1 text-[10px] font-bold bg-destructive text-destructive-foreground border-0">
                  {unreadCount > 99 ? "99+" : unreadCount}
                </Badge>
              )}
            </Button>
            {notifOpen && (
              <NotificationPanel onClose={() => setNotifOpen(false)} />
            )}
          </div>
        </header>

        {/* Page content */}
        <main className="flex-1 overflow-y-auto">
          {children}
        </main>
      </div>
    </div>
  );
}
