/**
 * Dev console — read-only schema browser.
 *
 * Three-pane layout:
 *   - Left: table list (clickable)
 *   - Top-right: columns of the selected table
 *   - Bottom-right: indexes of the selected table
 *
 * Below: a Migrations section listing journal entries and their applied
 * status (where available).
 *
 * No mutating actions exist on this page — it's pure introspection.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { customFetch } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { Database } from "lucide-react";

type TableRowDto = { name: string; rowCount: number | null };
type ColumnDto = {
  name: string;
  type: string;
  nullable: boolean;
  default: string | null;
};
type IndexDto = { name: string; columns: string[]; unique: boolean };
type MigrationDto = { idx: number; tag: string; applied?: boolean };

function formatRowCount(n: number | null): string {
  if (n === null) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toLocaleString();
}

function TableList({
  tables,
  selected,
  onSelect,
  isLoading,
}: {
  tables: TableRowDto[] | undefined;
  selected: string | null;
  onSelect: (name: string) => void;
  isLoading: boolean;
}) {
  if (isLoading) {
    return (
      <div className="space-y-1 p-2">
        {[...Array(8)].map((_, i) => (
          <Skeleton key={i} className="h-8 w-full" />
        ))}
      </div>
    );
  }
  if (!tables || tables.length === 0) {
    return (
      <p className="text-sm text-muted-foreground p-4">No tables found.</p>
    );
  }
  return (
    <ScrollArea className="h-full">
      <div className="p-2 space-y-0.5">
        {tables.map((t) => (
          <button
            key={t.name}
            onClick={() => onSelect(t.name)}
            className={cn(
              "w-full flex items-center justify-between px-3 py-1.5 rounded-md text-sm text-left transition-colors",
              selected === t.name
                ? "bg-primary text-primary-foreground"
                : "hover:bg-accent",
            )}
          >
            <span className="font-mono text-xs truncate">{t.name}</span>
            <span
              className={cn(
                "text-[10px] tabular-nums shrink-0 ml-2",
                selected === t.name
                  ? "text-primary-foreground/80"
                  : "text-muted-foreground",
              )}
            >
              {formatRowCount(t.rowCount)}
            </span>
          </button>
        ))}
      </div>
    </ScrollArea>
  );
}

function ColumnsTable({ name }: { name: string | null }) {
  const { data, isLoading } = useQuery<ColumnDto[]>({
    queryKey: ["/api/dev/db/tables", name, "columns"],
    queryFn: () =>
      customFetch<ColumnDto[]>(
        `/api/dev/db/tables/${encodeURIComponent(name!)}/columns`,
      ),
    enabled: !!name,
  });

  if (!name) {
    return (
      <p className="text-sm text-muted-foreground p-4">
        Select a table to see its columns.
      </p>
    );
  }
  if (isLoading) {
    return (
      <div className="p-3 space-y-2">
        {[...Array(5)].map((_, i) => (
          <Skeleton key={i} className="h-6 w-full" />
        ))}
      </div>
    );
  }
  if (!data || data.length === 0) {
    return <p className="text-sm text-muted-foreground p-4">No columns.</p>;
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead>Type</TableHead>
          <TableHead>Nullable</TableHead>
          <TableHead>Default</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {data.map((c) => (
          <TableRow key={c.name}>
            <TableCell className="font-mono text-xs">{c.name}</TableCell>
            <TableCell className="text-xs">{c.type}</TableCell>
            <TableCell>
              {c.nullable ? (
                <Badge variant="secondary" className="text-[10px]">
                  yes
                </Badge>
              ) : (
                <Badge variant="outline" className="text-[10px]">
                  no
                </Badge>
              )}
            </TableCell>
            <TableCell className="font-mono text-xs text-muted-foreground">
              {c.default ?? "—"}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function IndexesTable({ name }: { name: string | null }) {
  const { data, isLoading } = useQuery<IndexDto[]>({
    queryKey: ["/api/dev/db/tables", name, "indexes"],
    queryFn: () =>
      customFetch<IndexDto[]>(
        `/api/dev/db/tables/${encodeURIComponent(name!)}/indexes`,
      ),
    enabled: !!name,
  });

  if (!name) {
    return null;
  }
  if (isLoading) {
    return (
      <div className="p-3 space-y-2">
        {[...Array(3)].map((_, i) => (
          <Skeleton key={i} className="h-6 w-full" />
        ))}
      </div>
    );
  }
  if (!data || data.length === 0) {
    return (
      <p className="text-sm text-muted-foreground p-4">No indexes.</p>
    );
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead>Columns</TableHead>
          <TableHead>Unique</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {data.map((idx) => (
          <TableRow key={idx.name}>
            <TableCell className="font-mono text-xs">{idx.name}</TableCell>
            <TableCell className="font-mono text-xs">
              {idx.columns.join(", ")}
            </TableCell>
            <TableCell>
              {idx.unique ? (
                <Badge variant="default" className="text-[10px]">
                  unique
                </Badge>
              ) : (
                <Badge variant="outline" className="text-[10px]">
                  no
                </Badge>
              )}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function MigrationsSection() {
  const { data, isLoading } = useQuery<MigrationDto[]>({
    queryKey: ["/api/dev/db/migrations"],
    queryFn: () => customFetch<MigrationDto[]>("/api/dev/db/migrations"),
    staleTime: 30_000,
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Migrations</CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-2">
            {[...Array(4)].map((_, i) => (
              <Skeleton key={i} className="h-6 w-full" />
            ))}
          </div>
        ) : !data || data.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No migrations recorded.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-12">#</TableHead>
                <TableHead>Tag</TableHead>
                <TableHead className="w-32">Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.map((m) => (
                <TableRow key={`${m.idx}-${m.tag}`}>
                  <TableCell className="tabular-nums text-xs text-muted-foreground">
                    {m.idx}
                  </TableCell>
                  <TableCell className="font-mono text-xs">{m.tag}</TableCell>
                  <TableCell>
                    {m.applied === undefined ? (
                      <Badge variant="outline" className="text-[10px]">
                        unknown
                      </Badge>
                    ) : m.applied ? (
                      <Badge variant="default" className="text-[10px]">
                        applied
                      </Badge>
                    ) : (
                      <Badge variant="secondary" className="text-[10px]">
                        pending
                      </Badge>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

export default function DevDbPage() {
  const [selected, setSelected] = useState<string | null>(null);

  const { data: tables, isLoading: tablesLoading } = useQuery<TableRowDto[]>({
    queryKey: ["/api/dev/db/tables"],
    queryFn: () => customFetch<TableRowDto[]>("/api/dev/db/tables"),
    staleTime: 60_000,
  });

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6">
      <header className="space-y-1">
        <div className="flex items-center gap-2">
          <Database className="h-5 w-5 text-primary" />
          <h1 className="text-2xl font-bold tracking-tight">Schema Browser</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          Read-only view of the application&apos;s Postgres schema. Row counts
          are approximate (sourced from{" "}
          <code className="text-xs bg-muted px-1 rounded">pg_class.reltuples</code>).
        </p>
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-[260px_1fr] gap-4">
        <Card className="h-[640px] overflow-hidden">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">
              Tables{" "}
              {tables ? (
                <span className="text-muted-foreground font-normal">
                  ({tables.length})
                </span>
              ) : null}
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0 h-[calc(100%-3.5rem)]">
            <TableList
              tables={tables}
              selected={selected}
              onSelect={setSelected}
              isLoading={tablesLoading}
            />
          </CardContent>
        </Card>

        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">
                Columns{" "}
                {selected ? (
                  <span className="font-mono text-sm text-muted-foreground">
                    {selected}
                  </span>
                ) : null}
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <ColumnsTable name={selected} />
            </CardContent>
          </Card>

          {selected && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Indexes</CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <IndexesTable name={selected} />
              </CardContent>
            </Card>
          )}
        </div>
      </div>

      <MigrationsSection />
    </div>
  );
}
