/**
 * Dev console landing page.
 *
 * Compact: header with build info + four cards linking to the sub-tools.
 * The Feature Builder card is a Phase 2 placeholder so the slot is visible
 * but the surface isn't shipped yet.
 */
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { customFetch } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Activity, Database, KeyRound, Sparkles } from "lucide-react";

type BuildInfo = { commit: string; builtAt: string; env: string };

type CardDef = {
  href: string;
  title: string;
  description: string;
  icon: React.ComponentType<{ className?: string }>;
  comingSoon?: boolean;
};

const CARDS: CardDef[] = [
  {
    href: "/dev/ops",
    title: "Ops",
    description: "Queues, recent errors, and worker health.",
    icon: Activity,
  },
  {
    href: "/dev/db",
    title: "Database",
    description: "Read-only schema browser and migration status.",
    icon: Database,
  },
  {
    href: "/dev/env",
    title: "Environment",
    description: "Masked view of server environment variables.",
    icon: KeyRound,
  },
  {
    href: "/dev/feature-builder",
    title: "Feature Builder",
    description: "AI-assisted scaffolding for new endpoints and pages.",
    icon: Sparkles,
    comingSoon: true,
  },
];

function shortCommit(commit: string): string {
  if (!commit || commit === "unknown") return "unknown";
  return commit.slice(0, 7);
}

function formatBuildTime(builtAt: string): string {
  if (!builtAt || builtAt === "unknown") return "unknown";
  const d = new Date(builtAt);
  if (Number.isNaN(d.getTime())) return builtAt;
  return d.toLocaleString();
}

export default function DevConsolePage() {
  const { data: build, isLoading } = useQuery<BuildInfo>({
    queryKey: ["/api/dev/ops/build"],
    queryFn: () => customFetch<BuildInfo>("/api/dev/ops/build"),
    staleTime: 60_000,
  });

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      <header className="space-y-2">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <h1 className="text-2xl font-bold tracking-tight">Dev Console</h1>
          {isLoading ? (
            <Skeleton className="h-6 w-40" />
          ) : build ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Badge variant="outline" className="font-mono">
                {shortCommit(build.commit)}
              </Badge>
              <Badge variant="outline">{build.env}</Badge>
              <span>built {formatBuildTime(build.builtAt)}</span>
            </div>
          ) : null}
        </div>
        <p className="text-sm text-muted-foreground">
          Internal tooling. Read-only by default. Gated by{" "}
          <code className="text-xs bg-muted px-1 rounded">ENABLE_DEV_CONSOLE</code>.
        </p>
      </header>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {CARDS.map((card) => {
          const Icon = card.icon;
          const inner = (
            <Card
              className={
                card.comingSoon
                  ? "opacity-70"
                  : "hover:bg-accent/40 transition-colors cursor-pointer"
              }
            >
              <CardHeader className="pb-2">
                <div className="flex items-center gap-3">
                  <div className="h-9 w-9 rounded-lg bg-primary/10 text-primary flex items-center justify-center">
                    <Icon className="h-5 w-5" />
                  </div>
                  <CardTitle className="text-base">{card.title}</CardTitle>
                  {card.comingSoon && (
                    <Badge variant="secondary" className="ml-auto text-[10px]">
                      Coming in Phase 2
                    </Badge>
                  )}
                </div>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground">{card.description}</p>
              </CardContent>
            </Card>
          );

          if (card.comingSoon) {
            return <div key={card.href}>{inner}</div>;
          }
          return (
            <Link key={card.href} href={card.href}>
              {inner}
            </Link>
          );
        })}
      </div>
    </div>
  );
}
