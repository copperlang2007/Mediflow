/**
 * AI Assistant Panel — floating button + right-side drawer.
 * Maintains conversation history within the session.
 * Context-aware: reads current page via props and sends to /api/ai/chat.
 */

import { useState, useRef, useEffect } from "react";
import { Bot, X, Send, Loader2, Copy, Check, ChevronDown, ChevronRight, Eye, Sparkles, ClipboardPaste } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export interface AiContext {
  pageType: "dashboard" | "agent" | "contact" | "other";
  agentId?: string;
  contactId?: string;
  label?: string;
}

import {
  STORAGE_KEYS,
  readBool,
  writeBool,
  readHistory,
  writeHistory,
  type ChatMessage,
} from "./ai-assistant-storage";

const SLASH_COMMANDS = [
  { cmd: "/compliance-check", hint: "[agent name] — compliance gap report" },
  { cmd: "/draft-sms", hint: "[contact name] [goal] — SMS draft" },
  { cmd: "/draft-email", hint: "[contact name] [goal] — email draft" },
  { cmd: "/summarize", hint: "[contact name] — contact brief + next action" },
  { cmd: "/renewal-report", hint: "— agency-wide renewal narrative" },
  { cmd: "/offboarding-check", hint: "[agent name] — offboarding checklist" },
];

// What the server-side context builders read for each page type. Surfaced in
// the panel so users can see what live data the AI actually has visibility
// into when answering questions on the current page (see lib/aiContext.ts on
// the API).
const CONTEXT_DETAILS: Record<
  AiContext["pageType"],
  { headline: string; bullets: string[] } | null
> = {
  agent: {
    headline: "Agent compliance snapshot",
    bullets: [
      "Profile (name, status, NPN, hire date)",
      "State licenses + which expire within 90 days",
      "Carrier certifications + which need renewal",
      "Latest AHIP record",
      "Open tasks past their due date",
    ],
  },
  contact: {
    headline: "Contact Medicare profile",
    bullets: [
      "Profile (name, DOB, Medicare ID, plan, carrier, state)",
      "Health conditions & tags",
      "Last 5 activities",
      "Active outreach sequences",
      "Current enrollment-period window (AEP/OEP)",
    ],
  },
  dashboard: {
    headline: "Agency dashboard summary",
    bullets: [
      "Org name + total/active agents",
      "Licenses expiring in 30 days",
      "Contact counts by status",
      "New leads in the last 30 days",
    ],
  },
  other: null,
};

function PageContextDisclosure({ context }: { context?: AiContext }) {
  const [expanded, setExpanded] = useState(false);
  const details = context ? CONTEXT_DETAILS[context.pageType] : null;
  const idLine =
    context?.pageType === "agent"
      ? `agentId: ${context.agentId ?? "—"}`
      : context?.pageType === "contact"
      ? `contactId: ${context.contactId ?? "—"}`
      : null;

  return (
    <div className="border-b border-border bg-muted/30 shrink-0">
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        className="w-full flex items-center gap-2 px-4 py-2 text-left hover:bg-muted/50 transition-colors"
        aria-expanded={expanded}
      >
        <Eye className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          What the AI knows
        </span>
        <span className="text-[11px] text-muted-foreground/70 truncate">
          · {details ? details.headline : "Generic page — no live context"}
        </span>
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground ml-auto shrink-0" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground ml-auto shrink-0" />
        )}
      </button>
      {expanded && (
        <div className="px-4 pb-3 pt-1 space-y-2">
          {context?.label && (
            <p className="text-xs">
              <span className="text-muted-foreground">Subject: </span>
              <span className="font-medium">{context.label}</span>
            </p>
          )}
          {idLine && (
            <p className="text-[11px] text-muted-foreground font-mono">{idLine}</p>
          )}
          {details ? (
            <>
              <p className="text-[11px] text-muted-foreground">
                The assistant has live read-only access to:
              </p>
              <ul className="space-y-0.5">
                {details.bullets.map((b) => (
                  <li
                    key={b}
                    className="text-xs pl-3 relative before:content-['•'] before:absolute before:left-0 before:text-muted-foreground"
                  >
                    {b}
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="text-xs text-muted-foreground">
              On this page no record-specific data is injected. The assistant
              still has general agency knowledge but won't see live database
              values for a particular agent or contact.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function MessageContent({ content }: { content: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    await navigator.clipboard.writeText(content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const lines = content.split("\n");
  const formatted = lines.map((line, i) => {
    if (line.startsWith("## ")) return <h2 key={i} className="font-semibold text-sm mt-3 mb-1">{line.slice(3)}</h2>;
    if (line.startsWith("### ")) return <h3 key={i} className="font-medium text-xs mt-2 mb-0.5 text-foreground/80">{line.slice(4)}</h3>;
    if (line.startsWith("**") && line.endsWith("**")) return <p key={i} className="font-semibold text-sm">{line.slice(2, -2)}</p>;
    if (line.startsWith("  • ") || line.startsWith("  ⚠ ")) return <p key={i} className="text-xs pl-3 py-0.5">{line.trim()}</p>;
    if (line.startsWith("- ") || line.startsWith("* ")) return <p key={i} className="text-xs pl-3 py-0.5 before:content-['•'] before:mr-2">{line.slice(2)}</p>;
    if (line === "") return <div key={i} className="h-1" />;
    return <p key={i} className="text-sm leading-relaxed">{line}</p>;
  });

  return (
    <div className="group relative">
      <div className="space-y-0.5">{formatted}</div>
      <button
        onClick={copy}
        className="absolute top-0 right-0 opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded hover:bg-muted"
      >
        {copied ? <Check className="h-3 w-3 text-green-500" /> : <Copy className="h-3 w-3 text-muted-foreground" />}
      </button>
    </div>
  );
}

export function AiAssistantPanel({ context }: { context?: AiContext }) {
  // Lazy initializers restore persisted state from localStorage so the panel
  // remembers whether it was open and the chat history survives navigation
  // and full page refreshes.
  const [open, setOpen] = useState<boolean>(() =>
    readBool(STORAGE_KEYS.open, false),
  );
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>(() => readHistory());
  const [streaming, setStreaming] = useState(false);
  const [showCommands, setShowCommands] = useState(false);

  useEffect(() => {
    writeBool(STORAGE_KEYS.open, open);
  }, [open]);

  // Persist history whenever it settles (skip while a response is streaming
  // — we'd otherwise write on every token, and partial messages aren't
  // useful to restore).
  useEffect(() => {
    if (streaming) return;
    writeHistory(messages);
  }, [messages, streaming]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  useEffect(() => {
    if (input.startsWith("/") && !input.includes(" ")) {
      setShowCommands(true);
    } else {
      setShowCommands(false);
    }
  }, [input]);

  const sendMessage = async () => {
    const msg = input.trim();
    if (!msg || streaming) return;

    const draftType: "sms" | "email" | undefined =
      msg.startsWith("/draft-sms") ? "sms" :
      msg.startsWith("/draft-email") ? "email" :
      undefined;

    setInput("");
    setShowCommands(false);

    const newHistory: ChatMessage[] = [
      ...messages,
      { role: "user", content: msg },
    ];
    setMessages([...newHistory, { role: "assistant", content: "", isStreaming: true, draftType }]);
    setStreaming(true);

    abortRef.current = new AbortController();

    try {
      const resp = await fetch(`${import.meta.env.BASE_URL}api/ai/chat`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: msg,
          history: messages.map((m) => ({ role: m.role, content: m.content })),
          context: context
            ? { pageType: context.pageType, agentId: context.agentId, contactId: context.contactId }
            : undefined,
        }),
        signal: abortRef.current.signal,
      });

      if (!resp.ok || !resp.body) {
        setMessages((prev) => {
          const copy = [...prev];
          const last = copy[copy.length - 1];
          if (last?.isStreaming) copy[copy.length - 1] = { ...last, content: "Failed to connect to AI service.", isStreaming: false };
          return copy;
        });
        return;
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let fullContent = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          try {
            const data = JSON.parse(line.slice(6)) as { content?: string; done?: boolean; error?: string };
            if (data.error) {
              fullContent += `\n\n_Error: ${data.error}_`;
            } else if (data.content) {
              fullContent += data.content;
            }
            setMessages((prev) => {
              const copy = [...prev];
              const last = copy[copy.length - 1];
              if (last?.isStreaming) {
                copy[copy.length - 1] = { ...last, content: fullContent, isStreaming: !data.done };
              }
              return copy;
            });
          } catch {
            // skip malformed SSE line
          }
        }
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        setMessages((prev) => {
          const copy = [...prev];
          const last = copy[copy.length - 1];
          if (last?.isStreaming) copy[copy.length - 1] = { ...last, content: "Connection failed. Please try again.", isStreaming: false };
          return copy;
        });
      }
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void sendMessage();
    }
  };

  const clearHistory = () => {
    setMessages([]);
    writeHistory([]);
  };

  const filteredCommands = SLASH_COMMANDS.filter((c) =>
    input === "/" ? true : c.cmd.startsWith(input.split(" ")[0] ?? "/"),
  );

  return (
    <>
      {/* Floating button */}
      <button
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "fixed bottom-6 right-6 z-50 h-14 w-14 rounded-full shadow-lg flex items-center justify-center transition-all",
          "bg-primary text-primary-foreground hover:bg-primary/90",
          open && "rotate-12",
        )}
        title="Open AI Assistant"
      >
        {open ? <X className="h-5 w-5" /> : <Bot className="h-6 w-6" />}
      </button>

      {/* Panel */}
      {open && (
        <div className="fixed bottom-24 right-6 z-50 w-[420px] max-w-[calc(100vw-3rem)] rounded-2xl border border-border bg-background shadow-2xl flex flex-col overflow-hidden" style={{ height: "560px" }}>
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 bg-primary text-primary-foreground shrink-0">
            <div className="flex items-center gap-2">
              <Sparkles className="h-4 w-4" />
              <span className="font-semibold text-sm">MediFlow AI</span>
              {context?.label && (
                <Badge variant="secondary" className="text-[10px] bg-primary-foreground/20 text-primary-foreground border-0 ml-1">
                  {context.label}
                </Badge>
              )}
            </div>
            <div className="flex items-center gap-1">
              {messages.length > 0 && (
                <button onClick={clearHistory} className="text-xs text-primary-foreground/70 hover:text-primary-foreground px-2 py-0.5 rounded transition-colors">
                  Clear
                </button>
              )}
              <button onClick={() => setOpen(false)} className="p-1 rounded hover:bg-primary-foreground/10 transition-colors">
                <ChevronDown className="h-4 w-4" />
              </button>
            </div>
          </div>

          {/* Page context disclosure — shows what live data the AI sees */}
          <PageContextDisclosure context={context} />

          {/* Messages */}
          <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-4 min-h-0">
            {messages.length === 0 && (
              <div className="space-y-3 py-4">
                <div className="text-center">
                  <Bot className="h-10 w-10 mx-auto mb-2 text-primary/40" />
                  <p className="text-sm text-muted-foreground">Ask me anything about your agents, contacts, or compliance status.</p>
                </div>
                <div className="space-y-1.5">
                  {SLASH_COMMANDS.slice(0, 4).map((c) => (
                    <button
                      key={c.cmd}
                      onClick={() => setInput(c.cmd + " ")}
                      className="w-full text-left text-xs px-3 py-2 rounded-lg border border-border hover:bg-muted transition-colors"
                    >
                      <span className="font-mono text-primary font-medium">{c.cmd}</span>
                      <span className="text-muted-foreground ml-1">{c.hint}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {messages.map((msg, i) => (
              <div key={i} className={cn("flex gap-2", msg.role === "user" ? "justify-end" : "justify-start")}>
                {msg.role === "assistant" && (
                  <div className="h-6 w-6 rounded-full bg-primary/10 flex items-center justify-center shrink-0 mt-0.5">
                    <Bot className="h-3.5 w-3.5 text-primary" />
                  </div>
                )}
                <div className="flex flex-col gap-1 max-w-[85%]">
                  <div
                    className={cn(
                      "rounded-2xl px-3 py-2 text-sm",
                      msg.role === "user"
                        ? "bg-primary text-primary-foreground rounded-br-sm"
                        : "bg-muted rounded-bl-sm",
                    )}
                  >
                    {msg.role === "assistant" ? (
                      <MessageContent content={msg.content || (msg.isStreaming ? "…" : "")} />
                    ) : (
                      <p>{msg.content}</p>
                    )}
                    {msg.isStreaming && (
                      <span className="inline-block h-3 w-1 bg-current opacity-70 animate-pulse ml-0.5" />
                    )}
                  </div>
                  {msg.role === "assistant" && msg.draftType && !msg.isStreaming && msg.content && (
                    <button
                      onClick={() => {
                        window.dispatchEvent(
                          new CustomEvent("mediflow:insert-draft", {
                            detail: { content: msg.content, draftType: msg.draftType },
                          })
                        );
                      }}
                      className="self-start flex items-center gap-1.5 text-[11px] px-2.5 py-1 rounded-full border border-primary/30 bg-primary/5 text-primary hover:bg-primary/10 transition-colors font-medium"
                    >
                      <ClipboardPaste className="h-3 w-3" />
                      Use this in {msg.draftType === "sms" ? "SMS" : "Email"} compose
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>

          {/* Slash command suggestions */}
          {showCommands && filteredCommands.length > 0 && (
            <div className="border-t border-border bg-background">
              {filteredCommands.map((c) => (
                <button
                  key={c.cmd}
                  onClick={() => { setInput(c.cmd + " "); textareaRef.current?.focus(); }}
                  className="w-full text-left text-xs px-4 py-2.5 hover:bg-muted transition-colors flex gap-2"
                >
                  <span className="font-mono text-primary font-medium w-40 shrink-0">{c.cmd}</span>
                  <span className="text-muted-foreground">{c.hint}</span>
                </button>
              ))}
            </div>
          )}

          {/* Input */}
          <div className="border-t border-border p-3 shrink-0">
            <div className="flex gap-2">
              <Textarea
                ref={textareaRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Ask a question or type / for commands…"
                className="min-h-[40px] max-h-[120px] resize-none text-sm py-2"
                rows={1}
                disabled={streaming}
              />
              <Button
                size="icon"
                onClick={() => void sendMessage()}
                disabled={!input.trim() || streaming}
                className="h-10 w-10 shrink-0 self-end"
              >
                {streaming ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              </Button>
            </div>
            <p className="text-[10px] text-muted-foreground mt-1.5 text-center">AI can make mistakes. Always verify important information.</p>
          </div>
        </div>
      )}
    </>
  );
}
