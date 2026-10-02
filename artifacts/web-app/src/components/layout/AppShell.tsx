import { useEffect, useState } from "react";
import { Link, useLocation } from "wouter";
import { useUser, useClerk } from "@clerk/react";
import {
  useGetMe,
  useGetAgent,
  useGetContact,
  useGetDashboardStats,
  getGetDashboardStatsQueryKey,
  getGetAgentQueryKey,
  getGetContactQueryKey,
} from "@workspace/api-client-react";
import type { AiContext } from "@/components/ai-assistant";
import { AiAssistantPanel, openAiAssistant } from "@/components/ai-assistant";
import { PresenceToggle } from "@/components/layout/PresenceToggle";
import { ViewAsAgencyControl, ViewAsAgencyDialog } from "@/components/layout/ViewAsAgencyControl";
import { GlobalSearch } from "@/components/layout/GlobalSearch";
import {
  DEV_NAV_GROUP,
  NAV_GROUPS,
  PLATFORM_NAV_GROUPS,
  ROLE_LABELS,
  activeNavHref,
  visibleNavGroups,
  type NavGroup,
  type NavItemDef,
  type Role,
} from "@/components/layout/nav-config";
import { BrandLockup } from "@/components/brand/BrandMark";
import { ThemeToggle } from "@/components/theme/ThemeToggle";
import { IS_DEMO_BUILD } from "@/lib/demo/isDemo";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Bell,
  Building2,
  ChevronDown,
  ChevronLeft,
  CreditCard,
  Eye,
  FlaskConical,
  HelpCircle,
  LayoutDashboard,
  LogOut,
  Menu,
  Search,
  Settings,
  ShieldCheck,
  Sparkles,
  User,
  UserPlus,
  X,
} from "lucide-react";
import { DEV_CONSOLE_ENABLED } from "@/lib/devEnabled";
import NotificationPanel from "@/components/notifications/NotificationPanel";
import { useSSENotifications } from "@/hooks/useSSENotifications";

// Roles that can read contacts server-side (permissions.ts `contact.read`).
// The global search box calls /api/contacts, so it is only shown to them.
const CONTACT_READERS: Role[] = [
  "super_admin", "agency_admin", "compliance_manager", "agent_support", "viewer", "developer",
];

const COLLAPSE_KEY = "mediflow:sidebar-collapsed";

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSE_KEY) === "1";
  } catch {
    return false;
  }
}

function NavLinkItem({
  item,
  active,
  collapsed,
  badgeCount,
  onNavigate,
}: {
  item: NavItemDef;
  active: boolean;
  collapsed: boolean;
  badgeCount?: number;
  onNavigate?: () => void;
}) {
  const Icon = item.icon;
  const showBadge = typeof badgeCount === "number" && badgeCount > 0;
  const badgeText = showBadge && badgeCount > 99 ? "99+" : showBadge ? String(badgeCount) : "";
  const badgeLabel = showBadge ? `${badgeCount} overdue ${item.label.toLowerCase()}` : undefined;

  const link = (
    <Link
      href={item.href}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      className={cn(
        "relative flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors",
        active
          ? "bg-sidebar-primary text-sidebar-primary-foreground shadow-sm"
          : "text-sidebar-foreground/75 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
        collapsed && "justify-center px-0 h-10 w-10 mx-auto",
      )}
    >
      <Icon className="h-[18px] w-[18px] shrink-0" />
      {!collapsed && <span className="truncate">{item.label}</span>}
      {showBadge && (
        <span
          aria-label={badgeLabel}
          className={cn(
            "min-w-[20px] h-5 px-1.5 rounded-full text-[11px] font-semibold leading-none flex items-center justify-center",
            collapsed ? "absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 text-[10px]" : "ml-auto",
            active
              ? "bg-white/25 text-white"
              : "bg-destructive text-destructive-foreground",
          )}
        >
          {badgeText}
        </span>
      )}
    </Link>
  );

  if (!collapsed) return link;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{link}</TooltipTrigger>
      <TooltipContent side="right" className="font-medium">
        {item.label}
        {showBadge && ` · ${badgeCount} overdue`}
      </TooltipContent>
    </Tooltip>
  );
}

function useAiContext(): AiContext {
  const [location] = useLocation();
  const agentMatch = location.match(/^\/agents\/([^/]+)/);
  const contactMatch = location.match(/^\/crm\/contacts\/([^/]+)/);

  const agentId = agentMatch?.[1];
  const contactId = contactMatch?.[1];

  // `enabled` is explicit because the generated hooks treat "" as a valid
  // id and would otherwise fetch on every page. Disabled queries never
  // fetch, so the placeholder "" key is inert.
  const { data: agent } = useGetAgent(agentId ?? "", {
    query: {
      queryKey: getGetAgentQueryKey(agentId ?? ""),
      enabled: Boolean(agentId),
    },
  });
  const { data: contact } = useGetContact(contactId ?? "", {
    query: {
      queryKey: getGetContactQueryKey(contactId ?? ""),
      enabled: Boolean(contactId),
    },
  });

  if (agentId) {
    const label = agent ? `Agent: ${agent.firstName} ${agent.lastName}` : "Agent";
    return { pageType: "agent", agentId, label };
  }
  if (contactId) {
    const label = contact ? `Contact: ${contact.firstName} ${contact.lastName}` : "Contact";
    return { pageType: "contact", contactId, label };
  }
  if (location === "/dashboard" || location.startsWith("/dashboard")) {
    return { pageType: "dashboard", label: "Dashboard" };
  }
  return { pageType: "other" };
}

/** Slim banner shown on every page of a demo build. */
function DemoBanner() {
  return (
    <div
      role="status"
      className="flex items-center gap-3 px-4 sm:px-6 py-2 bg-sky-500/10 border-b border-sky-500/30 text-sky-900 dark:text-sky-200 text-sm shrink-0"
    >
      <FlaskConical className="h-4 w-4 shrink-0" />
      <span className="font-semibold">Demo</span>
      <span className="min-w-0 text-sky-800/80 dark:text-sky-300/80">
        Sample agency, invented data.<span className="hidden sm:inline"> Nothing here is a real person.</span>
      </span>
    </div>
  );
}

export default function AppShell({ children }: { children: React.ReactNode }) {
  const [collapsed, setCollapsed] = useState<boolean>(readCollapsed);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [viewAsOpen, setViewAsOpen] = useState(false);
  const [location] = useLocation();
  const { user } = useUser();
  const { signOut } = useClerk();
  const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");
  const aiContext = useAiContext();

  const viewingAgency = Boolean(localStorage.getItem("mediflow:view-as-org"));
  const { unreadCount } = useSSENotifications(0, !viewingAgency);
  const { data: me } = useGetMe();
  const userRole = (me?.role ?? null) as Role | null;

  useEffect(() => {
    if (userRole && userRole !== "super_admin" && localStorage.getItem("mediflow:view-as-org")) {
      localStorage.removeItem("mediflow:view-as-org");
      window.location.reload();
    }
  }, [userRole]);

  useEffect(() => {
    try {
      localStorage.setItem(COLLAPSE_KEY, collapsed ? "1" : "0");
    } catch {
      // storage unavailable — collapse still works for this page view
    }
  }, [collapsed]);

  // Close the mobile drawer whenever the route changes.
  useEffect(() => {
    setMobileOpen(false);
  }, [location]);

  // Overdue tasks badge for the Tasks nav item. Refresh once a minute so the
  // count rolls over as items pass their due date without a hard refresh.
  const { data: dashboardStats } = useGetDashboardStats({
    query: {
      // Shared with the dashboard page on purpose: one request, and this poll
      // keeps the page's stats live. Silence only applies while no other
      // (non-silent) component is watching — see isSilent in queryClient.
      queryKey: getGetDashboardStatsQueryKey(),
      refetchInterval: 60_000,
      staleTime: 30_000,
      // Nav badge only; a failed background poll shouldn't toast every minute.
      meta: { silent: true },
    },
  });
  const overdueTaskCount = dashboardStats?.overdueTasks ?? 0;

  // Dev nav group — only added when the build-time flag is set AND the user
  // has a developer/super_admin role.
  const showDevNav =
    DEV_CONSOLE_ENABLED && (userRole === "developer" || userRole === "super_admin");
  const platformView = userRole === "super_admin" && !viewingAgency;
  const baseGroups = platformView ? PLATFORM_NAV_GROUPS : NAV_GROUPS;
  const allGroups: NavGroup[] = showDevNav ? [...baseGroups, DEV_NAV_GROUP] : baseGroups;
  const groups = visibleNavGroups(userRole, allGroups);
  const activeHref = activeNavHref(location, groups);

  const canSearch = !userRole || CONTACT_READERS.includes(userRole);
  const isOwner = userRole === "super_admin" || userRole === "agency_admin";
  const isSuperAdmin = userRole === "super_admin";
  const roleLabel = userRole ? (ROLE_LABELS[userRole] ?? userRole) : null;
  const initials =
    `${user?.firstName?.[0] ?? ""}${user?.lastName?.[0] ?? ""}`.toUpperCase() || "U";

  const doSignOut = () => {
    localStorage.removeItem("mediflow:view-as-org");
    void signOut({ redirectUrl: basePath || "/" });
  };

  const renderSidebar = (isCollapsed: boolean, onNavigate?: () => void) => (
    <div className="flex h-full flex-col">
      {/* Logo */}
      <div
        className={cn(
          "flex h-16 items-center gap-3 border-b border-sidebar-border shrink-0",
          isCollapsed ? "justify-center px-2" : "px-4",
        )}
      >
        <Link href="/dashboard" onClick={onNavigate} className="min-w-0" aria-label="agencyBRIDGE — go to dashboard">
          <BrandLockup
            size={36}
            tone="light"
            compact={isCollapsed}
            subtitle="Agency Platform"
            wordmarkClassName="text-white text-sm"
            subtitleClassName="text-sidebar-foreground"
          />
        </Link>
      </div>

      {/* Nav */}
      <ScrollArea className="flex-1">
        <nav aria-label="Main navigation" className={cn("py-4 space-y-6", isCollapsed ? "px-2" : "px-3")}>
          {groups.map((group) => (
            <div key={group.group} className="space-y-1">
              {isCollapsed ? (
                <div className="mx-auto mb-2 h-px w-6 bg-sidebar-border" aria-hidden="true" />
              ) : (
                <p className="px-3 mb-2 text-[10px] font-semibold uppercase tracking-wider text-sidebar-foreground/50">
                  {group.group}
                </p>
              )}
              {group.items.map((item) => (
                <NavLinkItem
                  key={item.href}
                  item={item}
                  active={item.href === activeHref}
                  collapsed={isCollapsed}
                  onNavigate={onNavigate}
                  badgeCount={item.badge === "overdueTasks" ? overdueTaskCount : undefined}
                />
              ))}
            </div>
          ))}
        </nav>
      </ScrollArea>

      {/* Footer: presence (agents) + collapse */}
      <div className={cn("border-t border-sidebar-border p-3 shrink-0 space-y-1", isCollapsed && "px-2")}>
        {/* Agents mark themselves Available/Away for inbound lead routing. */}
        {userRole === "agent" && (
          <div className={isCollapsed ? "flex justify-center" : ""}>
            <PresenceToggle collapsed={isCollapsed} />
          </div>
        )}
        {!onNavigate && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setCollapsed(!collapsed)}
            aria-label={isCollapsed ? "Expand menu" : "Collapse menu"}
            className={cn(
              "w-full text-sidebar-foreground/70 hover:text-sidebar-foreground hover:bg-sidebar-accent",
              isCollapsed && "justify-center px-0",
            )}
          >
            <ChevronLeft className={cn("h-4 w-4 transition-transform", isCollapsed && "rotate-180")} />
            {!isCollapsed && <span className="ml-2">Collapse</span>}
          </Button>
        )}
      </div>
    </div>
  );

  return (
    <div className="flex h-[100dvh] bg-background overflow-hidden">
      {/* Desktop sidebar */}
      <aside
        className={cn(
          "hidden lg:flex flex-col bg-sidebar text-sidebar-foreground border-r border-sidebar-border shrink-0 transition-[width] duration-300 ease-in-out",
          collapsed ? "w-[76px]" : "w-64",
        )}
      >
        {renderSidebar(collapsed)}
      </aside>

      {/* Mobile sidebar */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm lg:hidden"
          onClick={() => setMobileOpen(false)}
        />
      )}
      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-50 w-64 bg-sidebar text-sidebar-foreground border-r border-sidebar-border lg:hidden transition-transform duration-300",
          mobileOpen ? "translate-x-0" : "-translate-x-full",
        )}
        aria-hidden={!mobileOpen}
      >
        {renderSidebar(false, () => setMobileOpen(false))}
        <button
          onClick={() => setMobileOpen(false)}
          className="absolute top-4 right-3 z-10 p-1.5 rounded-md bg-sidebar-accent text-sidebar-accent-foreground hover:opacity-80"
          aria-label="Close menu"
        >
          <X className="h-4 w-4" />
        </button>
      </aside>

      {/* Main column */}
      <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
        {IS_DEMO_BUILD && <DemoBanner />}

        {/* Top bar */}
        <header className="h-16 border-b border-border bg-card/80 backdrop-blur-sm flex items-center gap-3 px-4 sm:px-6 shrink-0">
          <Button
            variant="ghost"
            size="icon"
            className="lg:hidden shrink-0"
            onClick={() => setMobileOpen(true)}
            aria-label="Open menu"
          >
            <Menu className="h-5 w-5" />
          </Button>

          {/* Search: inline from md up; an icon that opens a search sheet below. */}
          {canSearch ? (
            <>
              <GlobalSearch className="hidden md:block" />
              <Button
                variant="ghost"
                size="icon"
                className="md:hidden shrink-0"
                onClick={() => setSearchOpen(true)}
                aria-label="Search clients"
                title="Search clients"
              >
                <Search className="h-5 w-5" />
              </Button>
              <div className="flex-1 md:hidden" />
            </>
          ) : (
            <div className="flex-1" />
          )}

          {/* Role chip only where there's room; otherwise it's in the account menu. */}
          {roleLabel && (
            <div className="hidden xl:flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-muted/60 border border-border shrink-0">
              <ShieldCheck className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="text-xs font-medium text-muted-foreground whitespace-nowrap">{roleLabel}</span>
            </div>
          )}

          <div className="flex min-w-0 items-center gap-0.5 sm:gap-2 ml-auto shrink-0">
            <ViewAsAgencyControl enabled={isSuperAdmin} />

            {/* Notifications */}
            {!viewingAgency && (
              <div className="relative">
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => setNotifOpen(!notifOpen)}
                  className="relative"
                  aria-label={unreadCount > 0 ? `Notifications, ${unreadCount} unread` : "Notifications"}
                  title="Notifications"
                >
                  <Bell className="h-5 w-5" />
                  {unreadCount > 0 && (
                    <span className="absolute -top-0.5 -right-0.5 h-4 min-w-4 px-1 rounded-full text-[10px] font-bold leading-4 text-center bg-destructive text-destructive-foreground ring-2 ring-card">
                      {unreadCount > 99 ? "99+" : unreadCount}
                    </span>
                  )}
                </Button>
                {notifOpen && <NotificationPanel onClose={() => setNotifOpen(false)} />}
              </div>
            )}

            <ThemeToggle />

            {/* Help */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" aria-label="Help" title="Help">
                  <HelpCircle className="h-5 w-5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-60">
                <DropdownMenuLabel>Need a hand?</DropdownMenuLabel>
                <DropdownMenuSeparator />
                {!viewingAgency && (
                  <DropdownMenuItem onClick={() => openAiAssistant()} className="cursor-pointer">
                    <Sparkles className="h-4 w-4 mr-2" />
                    Ask the AI assistant
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem asChild>
                  <Link href="/dashboard">
                    <LayoutDashboard className="h-4 w-4 mr-2" />
                    Back to my dashboard
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <Link href="/settings">
                    <Settings className="h-4 w-4 mr-2" />
                    Account settings
                  </Link>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            {/* User menu */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  className="flex shrink-0 items-center gap-2.5 rounded-full pl-1 pr-1 xl:pr-3 py-1 hover:bg-muted/60 transition-colors"
                  aria-label="Account menu"
                >
                  <Avatar className="h-9 w-9 border-2 border-accent/20">
                    <AvatarImage src={user?.imageUrl} />
                    <AvatarFallback className="bg-navy-gradient text-white text-sm font-semibold">
                      {initials}
                    </AvatarFallback>
                  </Avatar>
                  <span className="hidden xl:flex flex-col items-start leading-tight min-w-0">
                    <span className="text-sm font-semibold truncate max-w-40">{user?.fullName ?? "User"}</span>
                    {roleLabel && <span className="text-[11px] text-muted-foreground">{roleLabel}</span>}
                  </span>
                  <ChevronDown className="h-3.5 w-3.5 text-muted-foreground hidden xl:block" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-64 max-w-[calc(100vw-1rem)]">
                <DropdownMenuLabel className="font-normal">
                  <p className="text-sm font-semibold truncate">{user?.fullName ?? "User"}</p>
                  <p className="text-xs text-muted-foreground truncate">
                    {user?.primaryEmailAddress?.emailAddress}
                  </p>
                  {roleLabel && (
                    <p className="mt-1.5 inline-flex items-center gap-1 rounded-full border border-border bg-muted/60 px-2 py-0.5 text-[11px] font-medium text-muted-foreground xl:hidden">
                      <ShieldCheck className="h-3 w-3" />
                      {roleLabel}
                    </p>
                  )}
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                {isSuperAdmin && !viewingAgency && (
                  <DropdownMenuItem
                    className="cursor-pointer xl:hidden"
                    onClick={() => setViewAsOpen(true)}
                  >
                    <Eye className="h-4 w-4 mr-2" />
                    View an agency…
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem asChild>
                  <Link href="/settings">
                    <User className="h-4 w-4 mr-2" />
                    Profile
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <Link href="/settings">
                    <Building2 className="h-4 w-4 mr-2" />
                    Agency settings
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <Link href="/settings/security">
                    <ShieldCheck className="h-4 w-4 mr-2" />
                    Account security
                  </Link>
                </DropdownMenuItem>
                {isOwner && (
                  <>
                    <DropdownMenuItem asChild>
                      <Link href="/settings/team">
                        <UserPlus className="h-4 w-4 mr-2" />
                        Team
                      </Link>
                    </DropdownMenuItem>
                    <DropdownMenuItem asChild>
                      <Link href="/settings/billing">
                        <CreditCard className="h-4 w-4 mr-2" />
                        Billing
                      </Link>
                    </DropdownMenuItem>
                  </>
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  className="text-destructive focus:text-destructive cursor-pointer"
                  onClick={doSignOut}
                >
                  <LogOut className="h-4 w-4 mr-2" />
                  Sign out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </header>

        {/* Page content. Bottom padding keeps the last card clear of the
            floating AI button (56px at bottom-6) and any device safe area. */}
        <main
          className={cn(
            "flex-1 overflow-y-auto overflow-x-hidden",
            !viewingAgency && "pb-[calc(5.5rem+env(safe-area-inset-bottom))]",
          )}
        >
          {children}
        </main>
      </div>

      {/* Small-screen search sheet (the inline box shows from md up). */}
      {canSearch && (
        <Sheet open={searchOpen} onOpenChange={setSearchOpen}>
          <SheetContent side="top" className="p-4 pt-12">
            <SheetTitle className="sr-only">Search clients</SheetTitle>
            <SheetDescription className="sr-only">Find a client by name, phone or email.</SheetDescription>
            {searchOpen && (
              <GlobalSearch autoFocus className="max-w-none" onNavigate={() => setSearchOpen(false)} />
            )}
          </SheetContent>
        </Sheet>
      )}

      {isSuperAdmin && <ViewAsAgencyDialog open={viewAsOpen} onOpenChange={setViewAsOpen} />}

      {/* Floating AI Assistant (existing /api/ai/chat feature) */}
      {!viewingAgency && <AiAssistantPanel context={aiContext} />}
    </div>
  );
}
