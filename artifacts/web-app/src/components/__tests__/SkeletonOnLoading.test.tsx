// @vitest-environment jsdom
/**
 * Verifies the canonical "show <Skeleton/> while React Query is loading,
 * swap to data when the query resolves" pattern. Rather than coupling to a
 * specific page (every page that uses Skeleton also pulls in Wouter, Clerk,
 * and the real API client to mount), we declare a tiny inline component that
 * uses the same primitives the rest of the app does — `Skeleton` + `useQuery`
 * — and assert on the swap.
 */
import { describe, it, expect } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { Skeleton } from "@/components/ui/skeleton";

function AgentName({ id }: { id: string }) {
  const q = useQuery<{ name: string }>({
    queryKey: ["agent", id],
    queryFn: async () => ({ name: `Agent ${id}` }),
  });

  if (q.isLoading) {
    return <Skeleton data-testid="loading" className="h-4 w-32" />;
  }
  if (q.isError || !q.data) {
    return <span data-testid="error">failed</span>;
  }
  return <span data-testid="name">{q.data.name}</span>;
}

function makeClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        // Avoid background refetches during the test window.
        staleTime: Infinity,
      },
    },
  });
}

describe("Skeleton-on-loading pattern", () => {
  it("shows the Skeleton placeholder before the query resolves", () => {
    const client = makeClient();
    render(
      <QueryClientProvider client={client}>
        <AgentName id="42" />
      </QueryClientProvider>,
    );

    // First render is synchronous; the query is still pending.
    expect(screen.getByTestId("loading")).toBeInTheDocument();
    expect(screen.queryByTestId("name")).not.toBeInTheDocument();
  });

  it("swaps Skeleton for the resolved data after the query settles", async () => {
    const client = makeClient();
    render(
      <QueryClientProvider client={client}>
        <AgentName id="42" />
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("name")).toHaveTextContent("Agent 42");
    });
    expect(screen.queryByTestId("loading")).not.toBeInTheDocument();
  });

  it("renders the error branch (and not the Skeleton) when the query rejects", async () => {
    const client = makeClient();
    function Failing() {
      const q = useQuery({
        queryKey: ["boom"],
        queryFn: async () => {
          throw new Error("nope");
        },
      });
      if (q.isLoading) return <Skeleton data-testid="loading" />;
      if (q.isError) return <span data-testid="error">failed</span>;
      return <span data-testid="name">unreachable</span>;
    }

    render(
      <QueryClientProvider client={client}>
        <Failing />
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("error")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("loading")).not.toBeInTheDocument();
  });
});
