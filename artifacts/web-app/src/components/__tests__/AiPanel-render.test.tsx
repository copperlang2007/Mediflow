// @vitest-environment jsdom
/**
 * Render-level tests for the floating AI Assistant panel.
 *
 * Note on which component this targets: there are TWO files in the codebase
 * called "AiAssistantPanel" — `components/ai-assistant.tsx` (flat file) and
 * `components/ai-assistant/AiAssistantPanel.tsx` (re-exported via
 * `components/ai-assistant/index.tsx`). When you import
 * `@/components/ai-assistant`, bundler module resolution picks the flat
 * `ai-assistant.tsx` file (it shadows the directory of the same name), so
 * the directory variant is effectively dead code. We import the same path
 * the rest of the app does, which gives us the real, in-use component.
 *
 * Coverage:
 *   - Closed state shows the floating button (Bot icon, "Open AI Assistant"
 *     title attribute).
 *   - Clicking the button opens the panel and renders the "MediFlow AI"
 *     header.
 *   - With pre-seeded localStorage the panel auto-restores its open state
 *     and chat history (this is the wiring exercised end-to-end here — the
 *     pure helpers themselves are covered by ai-assistant-storage.test.ts).
 *   - Clicking the collapse button closes the panel; the floating button
 *     remains visible.
 *
 * Streaming (SSE wire format) and slash-command execution are deliberately
 * out of scope — they need fetch + ReadableStream mocking and belong in
 * dedicated tests.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AiAssistantPanel } from "@/components/ai-assistant";
import { STORAGE_KEYS } from "@/components/ai-assistant-storage";

beforeEach(() => {
  window.localStorage.clear();
});
afterEach(() => {
  window.localStorage.clear();
});

describe("AiAssistantPanel render", () => {
  it("renders the floating launcher button when no persisted open-state exists", () => {
    render(<AiAssistantPanel />);

    // The launcher uses the title attribute — title becomes the accessible
    // name on a button with no other label.
    const launcher = screen.getByTitle("Open AI Assistant");
    expect(launcher).toBeInTheDocument();

    // Panel chrome should not be present yet.
    expect(screen.queryByText("MediFlow AI")).not.toBeInTheDocument();
  });

  it("opens the panel when the launcher is clicked and shows the header + empty-state suggestions", async () => {
    const user = userEvent.setup();
    render(<AiAssistantPanel context={{ pageType: "agent", agentId: "a-123" }} />);

    await user.click(screen.getByTitle("Open AI Assistant"));

    // Panel header has the product name.
    expect(screen.getByText("MediFlow AI")).toBeInTheDocument();
    // The empty-state placeholder shows at least one slash command suggestion.
    expect(screen.getByText("/compliance-check")).toBeInTheDocument();
    // The "What the AI knows" disclosure renders the agent-page headline.
    expect(screen.getByText(/Agent compliance snapshot/i)).toBeInTheDocument();
  });

  it("restores chat history from localStorage on mount", () => {
    // Pre-seed both the open flag and a tiny history (matching the on-disk
    // format the panel persists — see ai-assistant-storage.ts).
    window.localStorage.setItem(STORAGE_KEYS.open, "1");
    window.localStorage.setItem(
      STORAGE_KEYS.history,
      JSON.stringify([
        { role: "user", content: "hello there" },
        { role: "assistant", content: "hi back" },
      ]),
    );

    render(<AiAssistantPanel />);

    // Panel should auto-open from the persisted flag, so the header is here…
    expect(screen.getByText("MediFlow AI")).toBeInTheDocument();
    // …and both message bubbles render their content.
    expect(screen.getByText("hello there")).toBeInTheDocument();
    expect(screen.getByText("hi back")).toBeInTheDocument();
  });

  it("collapses the panel when the chevron-collapse button is clicked", async () => {
    const user = userEvent.setup();
    render(<AiAssistantPanel />);

    // Open it.
    await user.click(screen.getByTitle("Open AI Assistant"));
    expect(screen.getByText("MediFlow AI")).toBeInTheDocument();

    // The collapse button is unlabelled (it's just a ChevronDown icon). It
    // sits in the panel header alongside the title — find the panel root by
    // walking up from the title, then pick the last button inside it.
    // The launcher button is outside this subtree.
    const titleEl = screen.getByText("MediFlow AI");
    // Title → flex container → header → panel root.
    const panelRoot = titleEl.closest("div.fixed");
    expect(panelRoot).not.toBeNull();
    const buttons = within(panelRoot as HTMLElement).getAllByRole("button");
    // The last header button is the collapse trigger; click it.
    const collapseButton = buttons.find((b) => b.querySelector("svg.lucide-chevron-down"));
    expect(collapseButton).toBeDefined();
    await user.click(collapseButton as HTMLElement);

    // Header gone; floating launcher still visible.
    expect(screen.queryByText("MediFlow AI")).not.toBeInTheDocument();
    expect(screen.getByTitle("Open AI Assistant")).toBeInTheDocument();
  });
});
