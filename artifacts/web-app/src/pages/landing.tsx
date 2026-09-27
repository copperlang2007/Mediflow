import {
  ArrowRight,
  Award,
  BarChart2,
  CheckSquare,
  DollarSign,
  FileText,
  KeyRound,
  Radio,
  ShieldCheck,
  Sparkles,
  Users,
  ClipboardList,
} from "lucide-react";
import { BrandLockup, BrandMark } from "@/components/brand/BrandMark";

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

/*
 * Public landing page in the agencyBRIDGE style.
 *
 * Copy rule: describe only what this product actually does today. No
 * certifications, customer counts, testimonials or savings figures — if a
 * claim cannot be pointed at in the running app, it does not go here.
 */

const FEATURES = [
  {
    icon: Users,
    title: "Clients & leads in one list",
    body: "Contacts, leads, a sales pipeline and a shared inbox, so everyone sees the same client history.",
  },
  {
    icon: FileText,
    title: "Licensing kept current",
    body: "State licenses and carrier certifications with expiry reminders before anything lapses.",
  },
  {
    icon: Award,
    title: "AHIP and Ready-to-Sell",
    body: "See who has finished AHIP and which agents are cleared to sell before AEP starts.",
  },
  {
    icon: DollarSign,
    title: "Commissions you can check",
    body: "Upload carrier statements, match them to your book, and track clawbacks and missed payments.",
  },
  {
    icon: CheckSquare,
    title: "Tasks that don't slip",
    body: "Assign follow-ups with due dates. Overdue work is flagged right in the menu.",
  },
  {
    icon: Radio,
    title: "Live call queue",
    body: "Route inbound leads to available agents and watch the queue on a wallboard.",
  },
];

const PREVIEW_ROWS = [
  { icon: Users, label: "Clients & Leads", tone: "bg-sky-400/20 text-sky-200" },
  { icon: ClipboardList, label: "Agent onboarding & contracting", tone: "bg-teal-400/20 text-teal-200" },
  { icon: FileText, label: "Licensing & certifications", tone: "bg-sky-400/20 text-sky-200" },
  { icon: DollarSign, label: "Commissions & clawbacks", tone: "bg-emerald-400/20 text-emerald-200" },
  { icon: BarChart2, label: "Reports & leaderboard", tone: "bg-amber-400/20 text-amber-200" },
];

export default function Landing() {
  return (
    <div className="min-h-[100dvh] bg-background text-foreground font-body">
      {/* Top navigation */}
      <header className="sticky top-0 z-30 border-b border-border bg-card/90 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-6">
          <BrandLockup size={36} wordmarkClassName="text-lg text-foreground" />
          <nav className="flex items-center gap-2 sm:gap-4">
            <a
              href="#features"
              className="hidden sm:inline text-sm font-medium text-muted-foreground hover:text-foreground"
            >
              Features
            </a>
            <a
              href={`${basePath}/sign-in`}
              className="text-sm font-medium text-foreground hover:text-accent px-2"
            >
              Sign in
            </a>
            <a
              href={`${basePath}/sign-up`}
              className="inline-flex h-10 items-center rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground shadow-sm hover:bg-primary/90"
            >
              Create your agency
            </a>
          </nav>
        </div>
      </header>

      <main>
        {/* Hero */}
        <section className="relative isolate overflow-hidden bg-gradient-to-br from-navy-950 via-navy-900 to-navy-700 text-white">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 opacity-25 [background-image:linear-gradient(rgba(255,255,255,.06)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,.06)_1px,transparent_1px)] [background-size:64px_64px]"
          />
          <div
            aria-hidden="true"
            className="pointer-events-none absolute -right-40 -top-40 h-[28rem] w-[28rem] rounded-full bg-sky-500/15 blur-3xl"
          />
          <div className="relative mx-auto grid max-w-6xl gap-12 px-4 py-20 sm:px-6 lg:grid-cols-[1.1fr_.9fr] lg:items-center lg:py-28">
            <div>
              <p className="mb-6 inline-flex items-center gap-2 rounded-full border border-white/20 bg-white/10 px-3 py-1 text-xs font-semibold">
                <Sparkles className="h-3.5 w-3.5" />
                Built for Medicare agencies
              </p>
              <h1 className="font-display text-5xl font-bold leading-[1.05] tracking-tight sm:text-6xl">
                Your agency, <span className="text-sky-300">moving together.</span>
              </h1>
              <p className="mt-6 max-w-xl text-lg leading-8 text-white/75">
                agencyBRIDGE puts your clients, agents, licensing, commissions and daily tasks in one
                place — so you spend less time hunting for information and more time with clients.
              </p>
              <div className="mt-9 flex flex-wrap items-center gap-3">
                <a
                  href={`${basePath}/sign-in`}
                  className="inline-flex min-h-12 items-center justify-center rounded-lg bg-white px-7 text-base font-semibold text-navy-900 shadow-lg transition-colors hover:bg-navy-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-sky-300"
                >
                  Sign in
                  <ArrowRight className="ml-2 h-4 w-4" />
                </a>
                <a
                  href={`${basePath}/sign-up`}
                  className="inline-flex min-h-12 items-center justify-center rounded-lg border border-white/30 px-6 text-base font-semibold text-white transition-colors hover:bg-white/10"
                >
                  Create your agency
                </a>
              </div>
              <ul className="mt-8 flex flex-wrap gap-x-6 gap-y-2 text-sm text-white/65">
                <li className="flex items-center gap-2">
                  <KeyRound className="h-4 w-4" /> Each person sees only what their role allows
                </li>
                <li className="flex items-center gap-2">
                  <ShieldCheck className="h-4 w-4" /> Changes are recorded in an audit log
                </li>
              </ul>
            </div>

            {/* Product preview — module names only, no invented numbers */}
            <div className="relative">
              <div className="rounded-2xl border border-white/15 bg-navy-950/60 shadow-2xl shadow-black/40 backdrop-blur">
                <div className="flex items-center gap-2 border-b border-white/10 px-4 py-3">
                  <span className="h-2.5 w-2.5 rounded-full bg-white/25" />
                  <span className="h-2.5 w-2.5 rounded-full bg-white/25" />
                  <span className="h-2.5 w-2.5 rounded-full bg-white/25" />
                  <span className="ml-2 text-xs text-white/60">agencyBRIDGE · Your workspace</span>
                </div>
                <div className="flex">
                  <div className="hidden sm:flex flex-col items-center gap-3 border-r border-white/10 px-3 py-4">
                    <BrandMark size={28} tone="light" decorative />
                    {[Users, FileText, DollarSign, CheckSquare].map((Icon, i) => (
                      <span
                        key={i}
                        className={`flex h-8 w-8 items-center justify-center rounded-lg ${i === 0 ? "bg-sky-500/80 text-white" : "text-white/50"}`}
                      >
                        <Icon className="h-4 w-4" />
                      </span>
                    ))}
                  </div>
                  <div className="flex-1 space-y-2.5 p-4">
                    {PREVIEW_ROWS.map(({ icon: Icon, label, tone }) => (
                      <div
                        key={label}
                        className="flex items-center gap-3 rounded-xl border border-white/10 bg-white/[0.04] px-3 py-3"
                      >
                        <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${tone}`}>
                          <Icon className="h-4 w-4" />
                        </span>
                        <span className="text-sm font-medium text-white/90">{label}</span>
                      </div>
                    ))}
                    <div className="flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2.5 text-xs text-white/70">
                      <Sparkles className="h-3.5 w-3.5 text-sky-300" />
                      AI assistant built in — ask about a client or an agent from any page
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Features */}
        <section id="features" className="mx-auto max-w-6xl px-4 py-20 sm:px-6">
          <p className="text-xs font-semibold uppercase tracking-wider text-accent">
            Made for the work behind every sale
          </p>
          <h2 className="mt-2 font-display text-3xl font-bold tracking-tight sm:text-4xl">
            One workspace for the whole agency
          </h2>
          <p className="mt-3 max-w-2xl text-muted-foreground">
            Owners, agents, support staff and compliance each get the screens they need — nothing
            more to learn than that.
          </p>
          <div className="mt-10 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map(({ icon: Icon, title, body }) => (
              <div key={title} className="rounded-xl border border-border bg-card p-6 shadow-sm">
                <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-navy-100 text-navy-800">
                  <Icon className="h-5 w-5" />
                </span>
                <h3 className="mt-4 font-display text-lg font-semibold">{title}</h3>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">{body}</p>
              </div>
            ))}
          </div>
        </section>

        {/* Closing CTA */}
        <section className="mx-auto max-w-6xl px-4 pb-20 sm:px-6">
          <div className="flex flex-col items-start justify-between gap-6 rounded-2xl bg-gradient-to-br from-navy-800 via-navy-700 to-navy-600 p-8 text-white shadow-lg sm:flex-row sm:items-center">
            <div>
              <h2 className="font-display text-2xl font-bold">Already part of an agency on agencyBRIDGE?</h2>
              <p className="mt-1 text-white/75">Sign in to pick up where you left off.</p>
            </div>
            <a
              href={`${basePath}/sign-in`}
              className="inline-flex min-h-12 items-center rounded-lg bg-white px-6 font-semibold text-navy-900 hover:bg-navy-50"
            >
              Sign in <ArrowRight className="ml-2 h-4 w-4" />
            </a>
          </div>
        </section>
      </main>

      <footer className="border-t border-border bg-card">
        <div className="mx-auto flex max-w-6xl flex-col items-start justify-between gap-3 px-4 py-6 text-sm text-muted-foreground sm:flex-row sm:items-center sm:px-6">
          <BrandLockup size={28} wordmarkClassName="text-sm text-foreground" />
          <span>© {new Date().getFullYear()} agencyBRIDGE</span>
        </div>
      </footer>
    </div>
  );
}
