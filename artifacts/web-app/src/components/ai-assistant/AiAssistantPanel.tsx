/**
 * Floating AI Assistant Panel
 * Context-aware chat panel that SSE-streams responses from POST /ai/chat.
 * Supports slash commands, markdown rendering, copy, and clear history.
 */
import { useState, useRef, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import {
  Bot,
  X,
  Send,
  Loader2,
  Copy,
  Check,
  ChevronDown,
  Sparkles,
  Trash2,
  Minimize2,
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

export type AiContext =
  | { pageType: "agent"; agentId: string }
  | { pageType: "contact"; contactId: string }
  | { pageType: "dashboard" }
  | { pageType: "other" };

type ChatMessage = { role: "user" | "assistant"; content: string };

// ─── Markdown renderer (lightweight — bold, code blocks, bullet lists, headers) ─
function MarkdownContent({ text }: { text: string }) {
  const lines = text.split("\n");
  const result: React.ReactNode[] = [];
  let codeBuffer: string[] = [];
  let inCode = false;
  let key = 0;

  const renderInline = (line: string): React.ReactNode => {
    const parts = line.split(/(`[^`]+`|\*\*[^*]+\*\*)/g);
    return parts.map((part, i) => {
      if (part.startsWith("`") && part.endsWith("`") && part.length > 2)
        return <code key={i} className="bg-muted px-1 py-0.5 rounded text-xs font-mono">{part.slice(1, -1)}</code>;
      if (part.startsWith("**") && part.endsWith("**") && part.length > 4)
        return <strong key={i}>{part.slice(2, -2)}</strong>;
      return part;
    });
  };

  for (const line of lines) {
    if (line.startsWith("```")) {
      if (inCode) {
        result.push(<pre key={key++} className="bg-muted rounded-lg p-3 text-xs font-mono overflow-x-auto my-2 whitespace-pre-wrap">{codeBuffer.join("\n")}</pre>);
        codeBuffer = [];
      }
      inCode = !inCode;
      continue;
    }
    if (inCode) { codeBuffer.push(line); continue; }

    if (line.startsWith("## ")) {
      result.push(<h2 key={key++} className="font-bold text-sm mt-3 mb-1">{renderInline(line.slice(3))}</h2>);
    } else if (line.startsWith("# ")) {
      result.push(<h1 key={key++} className="font-bold text-base mt-3 mb-1">{renderInline(line.slice(2))}</h1>);
    } else if (line.startsWith("- ") || line.startsWith("* ")) {
      result.push(<li key={key++} className="ml-4 list-disc text-sm leading-relaxed">{renderInline(line.slice(2))}</li>);
    } else if (/^\d+\.\s/.test(line)) {
      result.push(<li key={key++} className="ml-4 list-decimal text-sm leading-relaxed">{renderInline(line.replace(/^\d+\.\s/, ""))}</li>);
    } else if (line.trim() === "") {
      result.push(<br key={key++} />);
    } else {
      result.push(<p key={key++} className="text-sm leading-relaxed">{renderInline(line)}</p>);
    }
  }

  return <div className="space-y-0.5">{result}</div>;
}

// ─── Message bubble ────────────────────────────────────────────────────────────
function MessageBubble({ msg, isStreaming }: { msg: ChatMessage; isStreaming?: boolean }) {
  const [copied, setCopied] = useState(false);

  const copy = () => {
    void navigator.clipboard.writeText(msg.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (msg.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="bg-primary text-primary-foreground rounded-2xl rounded-br-sm px-3.5 py-2 max-w-[85%] text-sm leading-relaxed">
          {msg.content}
        </div>
      </div>
    );
  }

  return (
    <div className="flex gap-2 items-start group">
      <div className="h-6 w-6 rounded-full bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center shrink-0 mt-0.5">
        <Bot className="h-3.5 w-3.5 text-white" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="bg-muted/60 rounded-2xl rounded-bl-sm px-3.5 py-2.5 max-w-full">
          {isStreaming && msg.content === "" ? (
            <div className="flex gap-1 py-0.5">
              <span className="h-1.5 w-1.5 bg-muted-foreground/60 rounded-full animate-bounce [animation-delay:0ms]" />
              <span className="h-1.5 w-1.5 bg-muted-foreground/60 rounded-full animate-bounce [animation-delay:150ms]" />
              <span className="h-1.5 w-1.5 bg-muted-foreground/60 rounded-full animate-bounce [animation-delay:300ms]" />
            </div>
          ) : (
            <MarkdownContent text={msg.content} />
          )}
        </div>
        {msg.content && !isStreaming && (
          <button onClick={copy} className="opacity-0 group-hover:opacity-100 transition-opacity mt-1 ml-1 flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
            {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
            {copied ? "Copied" : "Copy"}
          </button>
        )}
      </div>
    </div>
  );
}

// ─── Slash command hints ───────────────────────────────────────────────────────
const SLASH_COMMANDS = [
  { cmd: "/compliance-check", hint: "[agent name] — compliance gap report" },
  { cmd: "/draft-sms", hint: "[contact] [goal] — draft SMS outreach" },
  { cmd: "/draft-email", hint: "[contact] [goal] — draft email outreach" },
  { cmd: "/summarize", hint: "[contact name] — contact summary + next action" },
  { cmd: "/renewal-report", hint: "— agency-wide renewal status narrative" },
  { cmd: "/offboarding-check", hint: "[agent name] — offboarding checklist" },
];

function SlashHints({ input, onSelect }: { input: string; onSelect: (cmd: string) => void }) {
  if (!input.startsWith("/")) return null;
  const matches = SLASH_COMMANDS.filter((c) => c.cmd.startsWith(input.split(" ")[0].toLowerCase()));
  if (!matches.length) return null;
  return (
    <div className="border border-border rounded-lg bg-popover shadow-md overflow-hidden">
      {matches.map((m) => (
        <button
          key={m.cmd}
          onClick={() => onSelect(m.cmd + " ")}
          className="w-full flex items-start gap-2 px-3 py-2 text-left hover:bg-accent transition-colors"
        >
          <span className="text-xs font-mono font-bold text-primary">{m.cmd}</span>
          <span className="text-xs text-muted-foreground">{m.hint}</span>
        </button>
      ))}
    </div>
  );
}

// ─── Context badge ─────────────────────────────────────────────────────────────
function ContextBadge({ context }: { context: AiContext }) {
  if (context.pageType === "agent") return <Badge variant="secondary" className="text-xs">Agent context</Badge>;
  if (context.pageType === "contact") return <Badge variant="secondary" className="text-xs">Contact context</Badge>;
  if (context.pageType === "dashboard") return <Badge variant="secondary" className="text-xs">Dashboard context</Badge>;
  return null;
}

// ─── Main panel ───────────────────────────────────────────────────────────────
export function AiAssistantPanel({ context }: { context: AiContext }) {
  const [open, setOpen] = useState(false);
  const [minimized, setMinimized] = useState(false);
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const base = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";

  const scrollToBottom = useCallback(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, []);

  useEffect(() => { scrollToBottom(); }, [messages, scrollToBottom]);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || streaming) return;

    setInput("");
    const newMessages: ChatMessage[] = [...messages, { role: "user", content: text }];
    setMessages(newMessages);
    setStreaming(true);

    const placeholderMessages: ChatMessage[] = [...newMessages, { role: "assistant", content: "" }];
    setMessages(placeholderMessages);

    const abort = new AbortController();
    abortRef.current = abort;

    try {
      const res = await fetch(`${base}/api/ai/chat`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        signal: abort.signal,
        body: JSON.stringify({
          message: text,
          history: newMessages.slice(-20).map((m) => ({ role: m.role, content: m.content })),
          context: {
            pageType: context.pageType,
            ...("agentId" in context ? { agentId: context.agentId } : {}),
            ...("contactId" in context ? { contactId: context.contactId } : {}),
          },
        }),
      });

      if (!res.ok || !res.body) {
        throw new Error(`HTTP ${res.status}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let assistantText = "";

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
            if (data.content) {
              assistantText += data.content;
              setMessages((prev) => {
                const next = [...prev];
                next[next.length - 1] = { role: "assistant", content: assistantText };
                return next;
              });
            }
            if (data.done || data.error) break;
          } catch {
            // ignore malformed SSE lines
          }
        }
      }
    } catch (err) {
      if ((err as { name?: string }).name !== "AbortError") {
        setMessages((prev) => {
          const next = [...prev];
          next[next.length - 1] = { role: "assistant", content: "Sorry, I had trouble connecting to the AI service. Please try again." };
          return next;
        });
      }
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  }, [input, messages, streaming, context, base]);

  const stop = () => {
    abortRef.current?.abort();
  };

  const clear = () => {
    stop();
    setMessages([]);
    setStreaming(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  // If panel is closed
  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="fixed bottom-6 right-6 h-14 w-14 rounded-full bg-gradient-to-br from-blue-600 to-indigo-700 text-white shadow-lg hover:shadow-xl hover:scale-105 transition-all flex items-center justify-center z-50 group"
        title="Open AI Assistant"
      >
        <Sparkles className="h-6 w-6" />
        <span className="absolute -top-8 right-0 bg-foreground text-background text-xs px-2 py-1 rounded opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap">
          MediFlow AI
        </span>
      </button>
    );
  }

  return (
    <div
      className={cn(
        "fixed bottom-6 right-6 z-50 flex flex-col bg-background border border-border rounded-2xl shadow-2xl transition-all duration-200 overflow-hidden",
        minimized ? "w-72 h-14" : "w-[380px] h-[580px] max-h-[calc(100dvh-5rem)]"
      )}
    >
      {/* Header */}
      <div className="flex items-center gap-2.5 px-4 h-14 border-b border-border bg-gradient-to-r from-blue-600 to-indigo-700 text-white shrink-0">
        <Bot className="h-5 w-5 shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold leading-tight">MediFlow AI</p>
          {!minimized && <ContextBadge context={context} />}
        </div>
        <div className="flex items-center gap-1">
          {messages.length > 0 && !minimized && (
            <button onClick={clear} title="Clear chat" className="h-7 w-7 rounded-lg flex items-center justify-center hover:bg-white/20 transition-colors">
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          )}
          <button onClick={() => setMinimized(!minimized)} title={minimized ? "Expand" : "Minimize"} className="h-7 w-7 rounded-lg flex items-center justify-center hover:bg-white/20 transition-colors">
            {minimized ? <ChevronDown className="h-4 w-4" /> : <Minimize2 className="h-3.5 w-3.5" />}
          </button>
          <button onClick={() => setOpen(false)} title="Close" className="h-7 w-7 rounded-lg flex items-center justify-center hover:bg-white/20 transition-colors">
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      {!minimized && (
        <>
          {/* Messages */}
          <ScrollArea className="flex-1 px-4 py-3" ref={scrollRef as React.RefObject<HTMLDivElement>}>
            {messages.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center text-center py-6 gap-4">
                <div className="h-12 w-12 rounded-full bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center">
                  <Bot className="h-6 w-6 text-white" />
                </div>
                <div>
                  <p className="font-semibold text-sm">MediFlow AI</p>
                  <p className="text-xs text-muted-foreground mt-1 max-w-52">
                    Ask me anything about your agents, contacts, compliance, or outreach. Try a slash command:
                  </p>
                </div>
                <div className="w-full space-y-1">
                  {SLASH_COMMANDS.slice(0, 3).map((c) => (
                    <button
                      key={c.cmd}
                      onClick={() => { setInput(c.cmd + " "); textareaRef.current?.focus(); }}
                      className="w-full text-left px-3 py-1.5 rounded-lg bg-muted/50 hover:bg-muted transition-colors text-xs"
                    >
                      <span className="font-mono text-primary font-bold">{c.cmd}</span>
                      <span className="text-muted-foreground ml-1">{c.hint}</span>
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="space-y-3 pb-2">
                {messages.map((msg, i) => (
                  <MessageBubble
                    key={i}
                    msg={msg}
                    isStreaming={streaming && i === messages.length - 1 && msg.role === "assistant"}
                  />
                ))}
              </div>
            )}
          </ScrollArea>

          {/* Slash hints */}
          {input.startsWith("/") && (
            <div className="px-3 pb-1">
              <SlashHints input={input} onSelect={(cmd) => { setInput(cmd); textareaRef.current?.focus(); }} />
            </div>
          )}

          {/* Input */}
          <div className="px-3 pb-3 pt-2 border-t border-border shrink-0">
            <div className="flex gap-2 items-end">
              <Textarea
                ref={textareaRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Ask anything or type / for commands…"
                rows={1}
                className="resize-none text-sm min-h-[36px] max-h-28 py-2 overflow-y-auto"
                style={{ fieldSizing: "content" } as React.CSSProperties}
              />
              {streaming ? (
                <Button size="icon" variant="outline" onClick={stop} className="h-9 w-9 shrink-0" title="Stop">
                  <Loader2 className="h-4 w-4 animate-spin" />
                </Button>
              ) : (
                <Button size="icon" onClick={() => void send()} disabled={!input.trim()} className="h-9 w-9 shrink-0 bg-blue-600 hover:bg-blue-700">
                  <Send className="h-4 w-4" />
                </Button>
              )}
            </div>
            <p className="text-[10px] text-muted-foreground mt-1.5 text-center">
              Shift+Enter for new line · Enter to send
            </p>
          </div>
        </>
      )}
    </div>
  );
}
