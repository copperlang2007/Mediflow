// @vitest-environment jsdom
/**
 * Substitution note: there is no `MaskedContactBadge` component in the
 * codebase, and the contact-display logic in pages/contacts.tsx is wired up
 * to React Query, Wouter routes, and Clerk auth — too tangled to render in
 * isolation without elaborate mocking. Per the task's substitution clause,
 * this file tests the UI Badge primitive (components/ui/badge.tsx) instead,
 * since it's the building block every status/PHI badge in the app composes
 * on top of, and it has zero external runtime deps.
 */
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Badge } from "@/components/ui/badge";

describe("Badge (substitute for MaskedContactBadge)", () => {
  it("renders its children", () => {
    render(<Badge>Active</Badge>);
    expect(screen.getByText("Active")).toBeInTheDocument();
  });

  it("applies the default variant classes when no variant is given", () => {
    render(<Badge data-testid="b">Default</Badge>);
    const el = screen.getByTestId("b");
    // Default variant uses bg-primary; just assert the marker class exists.
    expect(el.className).toMatch(/bg-primary/);
  });

  it("applies destructive-variant classes when variant='destructive'", () => {
    render(
      <Badge variant="destructive" data-testid="b">
        Lapsed
      </Badge>,
    );
    expect(screen.getByTestId("b").className).toMatch(/bg-destructive/);
  });

  it("merges custom className with the variant classes", () => {
    render(
      <Badge className="ml-4 custom-x" data-testid="b">
        Custom
      </Badge>,
    );
    const cls = screen.getByTestId("b").className;
    expect(cls).toMatch(/ml-4/);
    expect(cls).toMatch(/custom-x/);
    // Variant base-classes should still be present after merge.
    expect(cls).toMatch(/inline-flex/);
  });
});
