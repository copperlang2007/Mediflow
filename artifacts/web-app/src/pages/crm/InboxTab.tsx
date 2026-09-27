import { useState, useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type {
  ThreadWithContact, InboxResponseDataItem,
} from "@workspace/api-client-react";
import {
  useGetThreads, useGetInbox, useReplyInThread, useMarkMessageRead, useGetThreadMessages,
  getGetThreadMessagesQueryKey,
  getGetInboxQueryKey, getGetThreadsQueryKey,
} from "@workspace/api-client-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { MessageSquare, Send, CheckCircle2 } from "lucide-react";
import { toast } from "sonner";
import { formatDistanceToNow } from "date-fns";
import { cn } from "@/lib/utils";

export default function InboxTab() {
  const qc = useQueryClient();
  const [channelFilter, setChannelFilter] = useState("all");
  const [replyBody, setReplyBody] = useState("");
  const [replySubject, setReplySubject] = useState("");
  const [selectedThread, setSelectedThread] = useState<string | null>(null);

  const { data: inboxData, isLoading } = useGetInbox({
    channel: channelFilter === "all" ? undefined : channelFilter as "sms",
    limit: 50,
  });
  const { data: threadsRaw } = useGetThreads({
    channel: channelFilter === "all" ? undefined : channelFilter as "sms",
    limit: 50,
  });
  const { mutateAsync: reply, isPending: replying } = useReplyInThread();
  const { mutateAsync: markRead } = useMarkMessageRead();

  const inboxItems: InboxResponseDataItem[] = inboxData?.data ?? [];
  const threadList: ThreadWithContact[] = threadsRaw ?? [];

  // Selected thread metadata (for header + channel awareness in the reply box).
  const activeThreadRow = threadList.find((t) => t.thread.id === selectedThread);
  const activeThread = activeThreadRow?.thread;
  const activeChannel = activeThread?.channel ?? "sms";
  const activeContactName = activeThreadRow
    ? `${activeThreadRow.contactFirstName ?? ""} ${activeThreadRow.contactLastName ?? ""}`.trim()
    : "";

  // Full message history for the selected thread.
  const { data: threadMessages, isLoading: messagesLoading } = useGetThreadMessages(
    selectedThread ?? "",
    { limit: 200 },
    {
      query: {
        queryKey: selectedThread
          ? getGetThreadMessagesQueryKey(selectedThread, { limit: 200 })
          : ["thread-messages-empty"],
        enabled: !!selectedThread,
        // Auto-refresh while viewing a conversation so newly received inbound
        // messages appear without manual reload. Stops once another thread
        // is selected.
        refetchInterval: 15_000,
        staleTime: 5_000,
      },
    },
  );

  // Auto-mark inbound unread messages in the open thread as read.
  const messages = threadMessages ?? [];
  useEffect(() => {
    if (!selectedThread) return;
    const inboxByMsgId = new Map(
      inboxItems.map((row) => {
        const r = row as Record<string, unknown>;
        const msg = r.message as { id?: string } | undefined;
        return [String(msg?.id ?? ""), r] as const;
      }),
    );
    for (const m of messages) {
      const item = inboxByMsgId.get(m.id);
      if (item) {
        // Background auto-mark on open: a failure just leaves it unread.
        void markRead({ id: m.id })
          .then(() => qc.invalidateQueries({ queryKey: getGetInboxQueryKey() }))
          .catch(() => {});
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedThread, messages.length, inboxItems.length]);

  const handleReply = async () => {
    if (!selectedThread || !replyBody.trim()) return;
    try {
      await reply({
        id: selectedThread,
        data: {
          body: replyBody,
          ...(activeChannel === "email" && replySubject ? { subject: replySubject } : {}),
        },
      });
      toast.success("Reply sent");
      setReplyBody("");
      setReplySubject("");
      void qc.invalidateQueries({ queryKey: getGetInboxQueryKey() });
      void qc.invalidateQueries({ queryKey: getGetThreadsQueryKey() });
      void qc.invalidateQueries({
        queryKey: getGetThreadMessagesQueryKey(selectedThread, { limit: 200 }),
      });
    } catch {
      toast.error("Failed to send reply");
    }
  };

  const handleMarkRead = async (msgId: string) => {
    try {
      await markRead({ id: msgId });
      void qc.invalidateQueries({ queryKey: getGetInboxQueryKey() });
    } catch { toast.error("Failed to mark as read"); }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Select value={channelFilter} onValueChange={setChannelFilter}>
          <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All channels</SelectItem>
            <SelectItem value="sms">SMS</SelectItem>
            <SelectItem value="email">Email</SelectItem>
          </SelectContent>
        </Select>
        {inboxData && <Badge variant="secondary">{inboxData.total} unread</Badge>}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
        {/* Thread list */}
        <div className="lg:col-span-2 space-y-2">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Conversations</p>
          {isLoading ? (
            <div className="space-y-2">{[...Array(4)].map((_, i) => <Skeleton key={i} className="h-16 rounded-lg" />)}</div>
          ) : threadList.length === 0 ? (
            <div className="flex flex-col items-center py-12 text-center">
              <MessageSquare className="h-10 w-10 text-muted-foreground/20 mb-2" />
              <p className="text-sm text-muted-foreground">No conversations yet</p>
            </div>
          ) : (
            threadList.map((row) => {
              const rowExtra = row as ThreadWithContact & { unreadCount?: number; lastMessage?: string };
              const unread = rowExtra.unreadCount ?? 0;
              return (
                <div
                  key={row.thread.id}
                  className={cn("p-3 rounded-lg border cursor-pointer transition-colors", selectedThread === row.thread.id ? "bg-primary/5 border-primary/20" : "bg-card hover:bg-muted/20")}
                  onClick={() => setSelectedThread(row.thread.id)}
                >
                  <div className="flex items-center gap-2">
                    <div className={cn("h-2 w-2 rounded-full flex-shrink-0", row.thread.channel === "sms" ? "bg-blue-500" : "bg-purple-500")} />
                    <p className="font-medium text-sm">{row.contactFirstName} {row.contactLastName}</p>
                    {unread > 0 && <Badge className="ml-auto text-xs bg-red-500 text-white border-0">{unread}</Badge>}
                  </div>
                  {rowExtra.lastMessage && <p className="text-xs text-muted-foreground truncate mt-0.5 pl-4">{rowExtra.lastMessage}</p>}
                  <p className="text-xs text-muted-foreground/60 mt-0.5 pl-4 uppercase tracking-wide">{row.thread.channel}</p>
                </div>
              );
            })
          )}
        </div>

        {/* Conversation panel */}
        <div className="lg:col-span-3">
          {selectedThread ? (
            <div className="border rounded-xl bg-card flex flex-col h-[640px]">
              {/* Header */}
              <div className="flex items-center gap-2 px-4 py-3 border-b">
                <div
                  className={cn(
                    "h-2 w-2 rounded-full",
                    activeChannel === "sms" ? "bg-blue-500" : "bg-purple-500",
                  )}
                />
                <p className="text-sm font-medium">{activeContactName || "Conversation"}</p>
                <Badge variant="outline" className="text-[10px] uppercase tracking-wide ml-1">
                  {activeChannel}
                </Badge>
                <span className="ml-auto text-xs text-muted-foreground">
                  {messages.length} message{messages.length !== 1 ? "s" : ""}
                </span>
              </div>

              {/* Conversation */}
              <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3 bg-muted/10">
                {messagesLoading ? (
                  <div className="space-y-2">
                    {[...Array(3)].map((_, i) => (
                      <Skeleton key={i} className="h-12 w-3/4 rounded-lg" />
                    ))}
                  </div>
                ) : messages.length === 0 ? (
                  <div className="text-center text-xs text-muted-foreground py-12">
                    No messages in this thread yet — send the first reply below.
                  </div>
                ) : (
                  messages.map((m) => {
                    const isOutbound = m.direction === "outbound";
                    return (
                      <div
                        key={m.id}
                        className={cn(
                          "flex",
                          isOutbound ? "justify-end" : "justify-start",
                        )}
                      >
                        <div
                          className={cn(
                            "max-w-[78%] rounded-2xl px-3.5 py-2 text-sm leading-relaxed",
                            isOutbound
                              ? "bg-primary text-primary-foreground rounded-br-sm"
                              : "bg-background border rounded-bl-sm",
                          )}
                        >
                          {m.subject && activeChannel === "email" && (
                            <p
                              className={cn(
                                "font-semibold text-xs mb-1",
                                isOutbound ? "text-primary-foreground/90" : "text-foreground",
                              )}
                            >
                              {m.subject}
                            </p>
                          )}
                          <p className="whitespace-pre-line break-words">{m.body}</p>
                          <p
                            className={cn(
                              "text-[10px] mt-1 flex items-center gap-1.5",
                              isOutbound
                                ? "text-primary-foreground/70 justify-end"
                                : "text-muted-foreground",
                            )}
                          >
                            <span>
                              {formatDistanceToNow(new Date(m.sentAt ?? m.createdAt))} ago
                            </span>
                            {isOutbound && (
                              <span className="capitalize">· {m.status}</span>
                            )}
                          </p>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>

              {/* Reply composer */}
              <div className="border-t p-3 space-y-2">
                {activeChannel === "email" && (
                  <Input
                    placeholder="Subject (optional)"
                    value={replySubject}
                    onChange={(e) => setReplySubject(e.target.value)}
                    className="h-8 text-sm"
                  />
                )}
                <div className="flex gap-2 items-end">
                  <Textarea
                    placeholder={`Reply by ${activeChannel.toUpperCase()}…`}
                    rows={2}
                    value={replyBody}
                    onChange={(e) => setReplyBody(e.target.value)}
                    className="resize-none text-sm"
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                        e.preventDefault();
                        void handleReply();
                      }
                    }}
                  />
                  <Button
                    size="sm"
                    onClick={handleReply}
                    disabled={replying || !replyBody.trim()}
                    className="shrink-0"
                  >
                    <Send className="h-4 w-4 mr-1" />
                    {replying ? "Sending…" : "Send"}
                  </Button>
                </div>
                <p className="text-[10px] text-muted-foreground text-center">
                  ⌘/Ctrl + Enter to send
                </p>
              </div>
            </div>
          ) : (
            <div className="border rounded-xl bg-muted/20 p-8 flex flex-col items-center justify-center text-center h-48">
              <MessageSquare className="h-10 w-10 text-muted-foreground/20 mb-2" />
              <p className="text-sm text-muted-foreground">Select a conversation to view full history and reply</p>
            </div>
          )}

          {!selectedThread && inboxItems.length > 0 && (
            <div className="mt-4 space-y-2">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Unread Messages</p>
              {inboxItems.map((rowRaw) => {
                const row = rowRaw as Record<string, unknown>;
                const msg = row.message as Record<string, unknown> | undefined;
                if (!msg) return null;
                return (
                  <div key={String(msg.id)} className="p-3 rounded-lg border bg-card">
                    <div className="flex items-start gap-3">
                      <div className="flex-1">
                        <div className="flex items-center gap-2">
                          <p className="text-sm font-medium">{String(row.contactFirstName ?? "")} {String(row.contactLastName ?? "")}</p>
                          <Badge variant="outline" className="text-xs capitalize">{String(row.channel ?? "")}</Badge>
                        </div>
                        <p className="text-sm mt-1">{String(msg.body ?? "")}</p>
                        <p className="text-xs text-muted-foreground mt-1">{formatDistanceToNow(new Date(String(msg.createdAt)))} ago</p>
                      </div>
                      <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => handleMarkRead(String(msg.id))}>
                        <CheckCircle2 className="h-3 w-3 mr-1" />Read
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
