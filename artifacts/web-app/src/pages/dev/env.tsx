/**
 * Dev console — masked env viewer.
 *
 * The server masks any secret-looking key (SECRET/TOKEN/KEY/PASSWORD/DSN/URL)
 * before sending values, so this page never has access to raw secret values
 * — it just renders what the server returned. The isSecret flag is purely
 * cosmetic.
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { customFetch } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { KeyRound, Search } from "lucide-react";

type EnvEntry = { key: string; value: string; isSecret: boolean };

export default function DevEnvPage() {
  const [query, setQuery] = useState("");

  const { data, isLoading } = useQuery<EnvEntry[]>({
    queryKey: ["/api/dev/env"],
    queryFn: () => customFetch<EnvEntry[]>("/api/dev/env"),
    staleTime: 60_000,
  });

  const filtered = useMemo(() => {
    if (!data) return [];
    const q = query.trim().toLowerCase();
    if (!q) return data;
    return data.filter(
      (e) =>
        e.key.toLowerCase().includes(q) ||
        e.value.toLowerCase().includes(q),
    );
  }, [data, query]);

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      <header className="space-y-1">
        <div className="flex items-center gap-2">
          <KeyRound className="h-5 w-5 text-primary" />
          <h1 className="text-2xl font-bold tracking-tight">Environment</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          Server-side <code className="text-xs bg-muted px-1 rounded">process.env</code>.
          Secret-looking keys (SECRET/TOKEN/KEY/PASSWORD/DSN/URL) are masked
          server-side before transit; this page never sees raw secret values.
        </p>
      </header>

      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between flex-wrap gap-3">
            <CardTitle className="text-base">
              {data ? (
                <>
                  Variables{" "}
                  <span className="font-normal text-muted-foreground">
                    ({filtered.length} of {data.length})
                  </span>
                </>
              ) : (
                "Variables"
              )}
            </CardTitle>
            <div className="relative w-full sm:w-72">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Filter by key or value..."
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="pl-8"
              />
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-4 space-y-2">
              {[...Array(8)].map((_, i) => (
                <Skeleton key={i} className="h-6 w-full" />
              ))}
            </div>
          ) : filtered.length === 0 ? (
            <p className="text-sm text-muted-foreground p-6 text-center">
              {query ? "No matches." : "No environment variables exposed."}
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-1/3">Key</TableHead>
                  <TableHead>Value</TableHead>
                  <TableHead className="w-24">Secret</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((e) => (
                  <TableRow key={e.key}>
                    <TableCell className="font-mono text-xs">{e.key}</TableCell>
                    <TableCell className="font-mono text-xs break-all">
                      {e.value}
                    </TableCell>
                    <TableCell>
                      {e.isSecret ? (
                        <Badge
                          variant="destructive"
                          className="text-[10px]"
                          aria-label="masked secret"
                        >
                          masked
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="text-[10px]">
                          plain
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
    </div>
  );
}
