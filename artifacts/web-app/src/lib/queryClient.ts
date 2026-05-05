import { QueryClient, QueryCache, MutationCache } from "@tanstack/react-query";
import { toast } from "sonner";

function toMessage(error: unknown): string {
  if (typeof error === "object" && error !== null && "message" in error) {
    return (error as { message: string }).message;
  }
  return "An unexpected error occurred";
}

export const queryClient = new QueryClient({
  queryCache: new QueryCache({
    onError: (error) => {
      toast.error(toMessage(error));
    },
  }),
  mutationCache: new MutationCache({
    onError: (error) => {
      toast.error(toMessage(error));
    },
  }),
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: (failureCount, error: unknown) => {
        if (typeof error === "object" && error !== null && "status" in error) {
          const status = (error as { status: number }).status;
          if (status === 401 || status === 403 || status === 404) return false;
        }
        return failureCount < 2;
      },
    },
  },
});
