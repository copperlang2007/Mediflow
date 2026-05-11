// @vitest-environment jsdom
/**
 * Tests for the Pagination primitives in components/ui/pagination.tsx.
 * These are stateless presentational components that compose into a full
 * pagination UI — we verify the ARIA shape and active-state attribute.
 */
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationLink,
  PaginationPrevious,
  PaginationNext,
  PaginationEllipsis,
} from "@/components/ui/pagination";

function renderSamplePager(activePage = 2) {
  render(
    <Pagination>
      <PaginationContent>
        <PaginationItem>
          <PaginationPrevious href="#prev" />
        </PaginationItem>
        {[1, 2, 3].map((n) => (
          <PaginationItem key={n}>
            <PaginationLink href={`#${n}`} isActive={n === activePage}>
              {n}
            </PaginationLink>
          </PaginationItem>
        ))}
        <PaginationItem>
          <PaginationEllipsis />
        </PaginationItem>
        <PaginationItem>
          <PaginationNext href="#next" />
        </PaginationItem>
      </PaginationContent>
    </Pagination>,
  );
}

describe("Pagination", () => {
  it("renders a <nav> with aria-label='pagination'", () => {
    renderSamplePager();
    const nav = screen.getByRole("navigation", { name: /pagination/i });
    expect(nav).toBeInTheDocument();
  });

  it("marks the active page with aria-current='page' and leaves others without it", () => {
    renderSamplePager(2);
    const active = screen.getByRole("link", { name: "2" });
    expect(active).toHaveAttribute("aria-current", "page");

    const one = screen.getByRole("link", { name: "1" });
    const three = screen.getByRole("link", { name: "3" });
    expect(one).not.toHaveAttribute("aria-current");
    expect(three).not.toHaveAttribute("aria-current");
  });

  it("renders Previous and Next labels with accessible names", () => {
    renderSamplePager();
    expect(screen.getByRole("link", { name: /go to previous page/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /go to next page/i })).toBeInTheDocument();
  });

  it("renders the ellipsis with sr-only fallback text for screen readers", () => {
    renderSamplePager();
    expect(screen.getByText(/more pages/i)).toBeInTheDocument();
  });
});
