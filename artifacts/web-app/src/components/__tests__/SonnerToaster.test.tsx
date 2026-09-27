// @vitest-environment jsdom
import { render, screen, act, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { toast } from "sonner";
import { Toaster } from "@/components/ui/toaster";
import { Toaster as SonnerToaster } from "@/components/ui/sonner";

// Pages import `toast` straight from "sonner". These toasts only render when
// the sonner <Toaster /> is mounted — the Radix toaster ignores them.
describe("sonner Toaster", () => {
  afterEach(() => {
    act(() => { toast.dismiss(); });
    document.documentElement.classList.remove("dark");
  });

  it("renders a toast.success call", async () => {
    render(<><Toaster /><SonnerToaster /></>);
    act(() => { toast.success("x"); });
    expect(await screen.findByText("x")).toBeVisible();
  });

  it("follows the app's .dark class on <html>", async () => {
    render(<SonnerToaster />);
    act(() => { toast("themed"); });
    await screen.findByText("themed");
    const toaster = () => document.querySelector("[data-sonner-toaster]");
    expect(toaster()).toHaveAttribute("data-sonner-theme", "light");

    act(() => { document.documentElement.classList.add("dark"); });
    await waitFor(() => expect(toaster()).toHaveAttribute("data-sonner-theme", "dark"));
  });
});
