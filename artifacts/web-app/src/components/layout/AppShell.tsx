import { useState } from "react";
import { Link, useLocation } from "wouter";
import { useUser, useClerk } from "@clerk/react";
import {
  useGetMe,
  useGetAgent,
  useGetContact,
  useGetDashboardStats,
  getGetDashboardStatsQueryKey,
} from "@workspace/api-client-react";
import type { AiContext } from "@/components/ai-assistant";
import { cn } from "@/lib/utils";

type Role =
  | "super_admin"
  | "agency_admin"
  | "compliance_manager"
  | "agent_support"
  | "viewer"
  | "agent"
  | "developer";

const ALL_ROLES: Role[] = [
  "super_admin", "agency_admin", "compliance_manager",
  "agent_support", "viewer", "agent", "developer",
];

const ROLE_LABELS: Record<Role, string> = {
  super_admin: "Super Admin",
  agency_admin: "Agency Admin",
  compliance_manager: "Compliance Mgr",
  agent_support: "Agent Support",
  viewer: "Viewer",
  agent: "Agent",
  developer: "Developer",
};

const ROLE_COLORS: Record<Role, string> = {
  super_admin: "bg-purple-100 text-purple-800",
  agency_admin: "bg-blue-100 text-blue-800",
  compliance_manager: "bg-teal-100 text-teal-800",
  agent_support: "bg-sky-100 text-sky-800",
  viewer: "bg-slate-100 text-slate-700",
  agent: "bg-green-100 text-green-800",
  developer: "bg-orange-100 text-orange-800",
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
  Zap,
  BarChart2,
  Lock,
  Database,
  DollarSign,
  Wrench,
  KeyRound,
  Handshake,
  ClipboardCheck,
} from "lucide-react";
import { DEV_CONSOLE_ENABLED } from "@/lib/devEnabled";
import NotificationPanel from "@/components/notifications/NotificationPanel";
import { useSSENotifications } from "@/hooks/useSSENotifications";
import { AiAssistantPanel } from "@/components/ai-assistant";

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
      {
        href: "/onboarding", label: "My onboarding", icon: ClipboardCheck,
        roles: ["agent"],
      },
      {
        href: "/admin-onboarding", label: "Contracting", icon: Handshake,
        roles: ["super_admin", "agency_admin", "compliance_manager"],
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
      {
        href: "/commissions", label: "Commissions", icon: DollarSign,
        roles: ["super_admin", "agency_admin", "compliance_manager", "agent_support"],
      },
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
  {
    group: "Analytics",
    items: [
      {
        href: "/reports", label: "Reports", icon: BarChart2,
        roles: ["super_admin", "agency_admin", "compliance_manager", "agent_support"],
      },
    ],
  },
  {
    group: "Settings",
    items: [
      {
        href: "/automations", label: "Automations", icon: Zap,
        roles: ["super_admin", "agency_admin"],
      },
      {
        href: "/admin-carriers", label: "Carriers", icon: Building2,
        roles: ["super_admin", "agency_admin"],
      },
      {
        href: "/admin-compliance", label: "HIPAA / SOC 2", icon: Lock,
        roles: ["super_admin", "agency_admin", "compliance_manager"],
      },
      {
        href: "/data-migration", label: "Data Migration", icon: Database,
        roles: ["super_admin", "agency_admin"],
      },
    ],
  },
];

function NavItem({
  href,
  label,
  icon: Icon,
  collapsed,
  badgeCount,
  badgeLabel,
}: {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  collapsed: boolean;
  badgeCount?: number;
  badgeLabel?: string;
}) {
  const [location] = useLocation();
  const isActive = location === href || (href !== "/dashboard" && location.startsWith(href));
  const showBadge = typeof badgeCount === "number" && badgeCount > 0;
  const badgeText = showBadge && badgeCount > 99 ? "99+" : showBadge ? String(badgeCount) : "";

  if (collapsed) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Link href={href}>
            <div
              className={cn(
                "relative flex items-center justify-center h-10 w-10 rounded-lg mx-auto transition-colors cursor-pointer",
                isActive
                  ? "bg-sidebar-primary text-sidebar-primary-foreground"
                  : "text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
              )}
            >
              <Icon className="h-5 w-5" />
              {showBadge && (
                <span
                  aria-label={badgeLabel ?? `${badgeCount} ${label}`}
                  className="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 rounded-full bg-destructive text-destructive-foreground text-[10px] font-semibold leading-none flex items-center justify-center"
                >
                  {badgeText}
                </span>
              )}
            </div>
          </Link>
        </TooltipTrigger>
        <TooltipContent side="right" className="font-medium">
          {label}
          {showBadge && ` · ${badgeCount} overdue`}
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
        {showBadge && (
          <span
            aria-label={badgeLabel ?? `${badgeCount} ${label}`}
            className={cn(
              "ml-auto min-w-[20px] h-5 px-1.5 rounded-full text-[11px] font-semibold leading-none flex items-center justify-center",
              isActive
                ? "bg-sidebar-primary-foreground/20 text-sidebar-primary-foreground"
                : "bg-destructive text-destructive-foreground",
            )}
          >
            {badgeText}
          </span>
        )}
        {!showBadge && isActive && (
          <ChevronRight className="h-3.5 w-3.5 ml-auto shrink-0 opacity-60" />
        )}
      </div>
    </Link>
  );
}

function useAiContext(): AiContext {
  const [location] = useLocation();
  const agentMatch = location.match(/^\/agents\/([^/]+)/);
  const contactMatch = location.match(/^\/crm\/contacts\/([^/]+)/);

  const agentId = agentMatch?.[1];
  const contactId = contactMatch?.[1];

  const { data: agent } = useGetAgent(agentId ?? "");
  const { data: contact } = useGetContact(contactId ?? "");

  if (agentId) {
    const label = agent
      ? `Agent: ${agent.firstName} ${agent.lastName}`
      : "Agent";
    return { pageType: "agent", agentId, label };
  }
  if (contactId) {
    const label = contact
      ? `Contact: ${contact.firstName} ${contact.lastName}`
      : "Contact";
    return { pageType: "contact", contactId, label };
  }
  if (location === "/dashboard" || location.startsWith("/dashboard")) {
    return { pageType: "dashboard", label: "Dashboard" };
  }
  return { pageType: "other" };
}

export default function AppShell({ children }: { children: React.ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);
  const { user } = useUser();
  const { signOut } = useClerk();
  const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");
  const aiContext = useAiContext();

  const { unreadCount } = useSSENotifications();
  const { data: me } = useGetMe();
  const userRole = (me?.role ?? null) as Role | null;

  // Overdue tasks badge for the Tasks nav item. Refresh once a minute so the
  // count rolls over as items pass their due date without a hard refresh.
  const { data: dashboardStats } = useGetDashboardStats({
    query: {
      queryKey: getGetDashboardStatsQueryKey(),
      refetchInterval: 60_000,
      staleTime: 30_000,
    },
  });
  const overdueTaskCount = dashboardStats?.overdueTasks ?? 0;

  // Dev nav group — only added at runtime when the build-time flag is
  // set AND the user has a developer/super_admin role. The build-time
  // flag means production bundles never even contain the dev pages, but
  // we still gate the group by role so a stray developer-flag staging
  // build doesn't show the nav to ordinary users.
  const showDevNav =
    DEV_CONSOLE_ENABLED &&
    (userRole === "developer" || userRole === "super_admin");

  const navItemsWithDev: NavGroup[] = showDevNav
    ? [
        ...navItems,
        {
          group: "Dev",
          items: [
            {
              href: "/dev",
              label: "Dev Console",
              icon: Wrench,
              roles: ["developer", "super_admin"],
            },
            {
              href: "/dev/db",
              label: "Schema",
              icon: Database,
              roles: ["developer", "super_admin"],
            },
            {
              href: "/dev/env",
              label: "Environment",
              icon: KeyRound,
              roles: ["developer", "super_admin"],
            },
          ],
        },
      ]
    : navItems;

  // Filter nav groups to items allowed for this user's role.
  // While role is loading, show all to avoid flicker.
  const filteredNavItems = navItemsWithDev
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
                    badgeCount={item.href === "/tasks" ? overdueTaskCount : undefined}
                    badgeLabel={
                      item.href === "/tasks"
                        ? `${overdueTaskCount} overdue tasks`
                        : undefined
                    }
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

      {/* Floating AI Assistant */}
      <AiAssistantPanel context={aiContext} />
    </div>
  );
}
