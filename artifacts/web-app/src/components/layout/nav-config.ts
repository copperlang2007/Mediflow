/**
 * Sidebar navigation — single source of truth for the app shell.
 *
 * Grouped into plain-language sections an insurance agent would recognise.
 * Every item carries the SAME role list it had before the agencyBRIDGE
 * re-skin; only the grouping and some labels changed. (Server-side RBAC in
 * api-server `lib/permissions.ts` is the real gate — this only hides links.)
 *
 * Upcoming pages are listed with `upcoming: true`. They are filtered out of
 * the rendered nav (see `visibleNavGroups`) until their route exists — to
 * switch one on, build the page, add its <Route> in App.tsx, then delete the
 * `upcoming` flag here.
 */
import type { ComponentType } from "react";
import {
  Activity,
  ArrowLeftRight,
  Award,
  BarChart2,
  BookOpen,
  Boxes,
  Briefcase,
  Building2,
  CalendarClock,
  CalendarDays,
  CheckSquare,
  ClipboardCheck,
  CreditCard,
  Database,
  DollarSign,
  FileStack,
  FileText,
  FolderOpen,
  Globe,
  Handshake,
  Headphones,
  KeyRound,
  LayoutDashboard,
  Lock,
  Mail,
  Megaphone,
  MonitorPlay,
  Palette,
  Phone,
  Radio,
  RefreshCcw,
  RotateCcw,
  Scale,
  Search,
  Settings,
  ShieldAlert,
  ShieldCheck,
  Target,
  TrendingDown,
  Trophy,
  UserCog,
  UserPlus,
  Users,
  Wallet,
  Workflow,
  Wrench,
} from "lucide-react";

export type Role =
  | "super_admin"
  | "agency_admin"
  | "compliance_manager"
  | "agent_support"
  | "viewer"
  | "agent"
  | "developer";

export const ALL_ROLES: Role[] = [
  "super_admin", "agency_admin", "compliance_manager",
  "agent_support", "viewer", "agent", "developer",
];

export const ROLE_LABELS: Record<Role, string> = {
  super_admin: "Super Admin",
  agency_admin: "Agency Admin",
  compliance_manager: "Compliance Manager",
  agent_support: "Agent Support",
  viewer: "Viewer",
  agent: "Agent",
  developer: "Developer",
};

const ADMINS: Role[] = ["super_admin", "agency_admin"];
const ADMIN_COMPLIANCE: Role[] = ["super_admin", "agency_admin", "compliance_manager"];
const BACK_OFFICE: Role[] = ["super_admin", "agency_admin", "compliance_manager", "agent_support"];

export type NavItemDef = {
  href: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
  roles: Role[];
  /** Page not built yet — hidden from the sidebar until stage 2 wires it. */
  upcoming?: boolean;
  /** Which live badge to show next to the label, if any. */
  badge?: "overdueTasks";
};

export type NavGroup = { group: string; items: NavItemDef[] };

export const NAV_GROUPS: NavGroup[] = [
  {
    group: "Main",
    items: [
      { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard, roles: ALL_ROLES },
      { href: "/crm", label: "Clients & Leads", icon: Users, roles: BACK_OFFICE },
      // An agent's own clients, with the PHI they need to service them.
      { href: "/my-clients", label: "My Clients", icon: Users, roles: ["agent"] },
      // Book of business (enrollments). Server gate: contact:read.
      { href: "/policies", label: "Policies", icon: FileStack, roles: BACK_OFFICE },
      { href: "/tasks", label: "Tasks", icon: CheckSquare, roles: ALL_ROLES, badge: "overdueTasks" },
      { href: "/onboarding", label: "My Onboarding", icon: ClipboardCheck, roles: ["agent"] },
      { href: "/calendar", label: "Calendar", icon: CalendarDays, roles: ALL_ROLES },
      { href: "/dialer", label: "Softphone", icon: Phone, roles: BACK_OFFICE },
      { href: "/supervisor", label: "Supervisor", icon: Headphones, roles: ADMINS },
    ],
  },
  {
    group: "Sales Tools",
    items: [
      { href: "/admin/queue", label: "Live Call Queue", icon: Radio, roles: ADMINS },
      { href: "/admin/queue/wall", label: "Queue Wallboard", icon: MonitorPlay, roles: ADMINS },
      { href: "/readiness", label: "Ready to Sell", icon: Target, roles: ADMIN_COMPLIANCE },
      { href: "/aep", label: "AEP Center", icon: CalendarClock, roles: ADMIN_COMPLIANCE },
      { href: "/quoting", label: "Quoting Engine", icon: Search, roles: BACK_OFFICE },
      // The one automation page (/automations redirects here). Rule edits are owner-only server-side.
      { href: "/workflows", label: "Workflow Automation", icon: Workflow, roles: ADMINS },
      // Same audience as the `communication:read` permission; sending is admin-only server-side.
      { href: "/campaigns", label: "Omnichannel Campaigns", icon: Mail, roles: BACK_OFFICE },
    ],
  },
  {
    group: "Clients & Service",
    items: [
      { href: "/churn", label: "Retention & Churn Risk", icon: TrendingDown, roles: ADMIN_COMPLIANCE },
      { href: "/documents", label: "Documents", icon: FolderOpen, roles: ALL_ROLES },
      { href: "/client-portal", label: "Client Portal", icon: Globe, roles: ADMINS },
      // Every staff role reads; owners write (kb_article RBAC).
      { href: "/knowledge-base", label: "Knowledge Base", icon: BookOpen, roles: ALL_ROLES },
    ],
  },
  {
    group: "Commissions",
    items: [
      { href: "/commissions", label: "Commissions", icon: DollarSign, roles: BACK_OFFICE },
      { href: "/my-commissions", label: "My Commissions", icon: Wallet, roles: ["agent"] },
      { href: "/clawbacks", label: "Clawbacks", icon: RotateCcw, roles: BACK_OFFICE },
      // Same audience as Commissions (commission:read); uploads stay owner-only.
      { href: "/reconciliation", label: "Reconciliation", icon: Scale, roles: BACK_OFFICE },
    ],
  },
  {
    group: "Compliance",
    items: [
      { href: "/licensing", label: "Licensing", icon: FileText, roles: ALL_ROLES },
      { href: "/certifications", label: "Certifications", icon: Award, roles: ALL_ROLES },
      { href: "/renewals", label: "License Renewals", icon: RefreshCcw, roles: ADMIN_COMPLIANCE },
      { href: "/compliance", label: "Audit & Compliance", icon: ShieldCheck, roles: ADMIN_COMPLIANCE },
      { href: "/complaints", label: "Complaints", icon: ShieldAlert, roles: ADMIN_COMPLIANCE },
      { href: "/marketing", label: "Marketing Approval", icon: Megaphone, roles: ADMIN_COMPLIANCE },
    ],
  },
  {
    group: "Management",
    items: [
      { href: "/agents", label: "Agents", icon: UserCog, roles: BACK_OFFICE },
      { href: "/admin-onboarding", label: "Contracting", icon: Handshake, roles: ADMIN_COMPLIANCE },
      { href: "/leaderboard", label: "Leaderboard", icon: Trophy, roles: ADMIN_COMPLIANCE },
      { href: "/reports", label: "Reports", icon: BarChart2, roles: BACK_OFFICE },
      // Staff pick any agent (agent:read); agents see only their own.
      { href: "/backoffice", label: "Agent Back Office", icon: Briefcase, roles: ALL_ROLES },
    ],
  },
  {
    group: "Admin",
    items: [
      // Seat management is an owner concern — same audience as billing.
      { href: "/settings/team", label: "Team", icon: UserPlus, roles: ADMINS },
      { href: "/admin-carriers", label: "Carriers", icon: Building2, roles: ADMINS },
      // Narrower on purpose: billing is the agency's money, and the RBAC
      // matrix restricts it to the same two roles server-side.
      { href: "/settings/billing", label: "Billing", icon: CreditCard, roles: ADMINS },
      { href: "/admin-compliance", label: "Security & HIPAA checklist", icon: Lock, roles: ADMIN_COMPLIANCE },
      // Import / Export hub; the import wizards stay at /data-migration.
      { href: "/data-tools", label: "Import / Export", icon: ArrowLeftRight, roles: ADMINS },
      { href: "/admin/health", label: "System Health", icon: Activity, roles: ADMINS },
      { href: "/branding", label: "Branding", icon: Palette, roles: ADMINS },
      // Platform owner only: create and list every agency on the platform.
      { href: "/admin/workspaces", label: "Workspaces", icon: Boxes, roles: ["super_admin"] },
      { href: "/settings", label: "Settings", icon: Settings, roles: ALL_ROLES },
    ],
  },
];

/** Developer console group — only added when DEV_CONSOLE_ENABLED is on. */
export const DEV_NAV_GROUP: NavGroup = {
  group: "Developer",
  items: [
    { href: "/dev", label: "Dev Console", icon: Wrench, roles: ["developer", "super_admin"] },
    { href: "/dev/db", label: "Schema", icon: Database, roles: ["developer", "super_admin"] },
    { href: "/dev/env", label: "Environment", icon: KeyRound, roles: ["developer", "super_admin"] },
  ],
};

/**
 * The groups/items a given role should see. While the role is still loading
 * (`null`) every live item is shown, matching the previous behaviour, so the
 * sidebar does not flicker empty. Upcoming items are always excluded.
 */
export function visibleNavGroups(role: Role | null, groups: NavGroup[] = NAV_GROUPS): NavGroup[] {
  return groups
    .map((group) => ({
      ...group,
      items: group.items.filter(
        (item) => !item.upcoming && (!role || item.roles.includes(role)),
      ),
    }))
    .filter((group) => group.items.length > 0);
}

/**
 * Which nav href should be highlighted for the current path: the longest
 * item href that equals the path or is a parent segment of it. Using the
 * longest match stops "/admin/queue" lighting up on "/admin/queue/wall" and
 * "/settings" lighting up on "/settings/team".
 */
export function activeNavHref(location: string, groups: NavGroup[]): string | null {
  let best: string | null = null;
  for (const group of groups) {
    for (const item of group.items) {
      const match = location === item.href || location.startsWith(`${item.href}/`);
      if (match && (!best || item.href.length > best.length)) best = item.href;
    }
  }
  return best;
}
