// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { toast } from "sonner";
import { Toaster } from "@/components/ui/sonner";

describe("sonner Toaster", () => {
  it("shows messages sent with toast() from sonner", async () => {
    render(<Toaster />);
    act(() => {
      toast.success("Contact created");
    });
    expect(await screen.findByText("Contact created")).toBeInTheDocument();
  });

  it("is mounted once in the app root", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const app = fs.readFileSync(path.resolve(__dirname, "../App.tsx"), "utf8");
    expect(app).toMatch(/import \{ Toaster as SonnerToaster \} from "@\/components\/ui\/sonner"/);
    expect(app.match(/<SonnerToaster \/>/g)?.length).toBe(1);
  });
});
