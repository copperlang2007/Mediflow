/**
 * Pure helpers for persisting the AI assistant panel's open state and chat
 * history to localStorage. Extracted out of ai-assistant.tsx so they can be
 * unit-tested without React or DOM machinery.
 */

export type ChatMessage = {
  role: "user" | "assistant";
  content: string;
  isStreaming?: boolean;
  draftType?: "sms" | "email";
};

export const STORAGE_KEYS = {
  open: "mediflow.ai-panel.open",
  history: "mediflow.ai-panel.history",
} as const;

// Cap persisted history to keep localStorage small; older messages drop off.
export const HISTORY_CAP = 50;

type StorageLike = Pick<Storage, "getItem" | "setItem">;

function getStorage(): StorageLike | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function readBool(key: string, fallback: boolean, storage?: StorageLike | null): boolean {
  const s = storage ?? getStorage();
  if (!s) return fallback;
  try {
    const v = s.getItem(key);
    return v === null ? fallback : v === "1";
  } catch {
    return fallback;
  }
}

export function writeBool(key: string, value: boolean, storage?: StorageLike | null): void {
  const s = storage ?? getStorage();
  if (!s) return;
  try {
    s.setItem(key, value ? "1" : "0");
  } catch {
    // localStorage may be unavailable; ignore.
  }
}

export function readHistory(storage?: StorageLike | null): ChatMessage[] {
  const s = storage ?? getStorage();
  if (!s) return [];
  try {
    const raw = s.getItem(STORAGE_KEYS.history);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (m): m is ChatMessage =>
          typeof m === "object" &&
          m !== null &&
          (((m as { role?: unknown }).role === "user") ||
            ((m as { role?: unknown }).role === "assistant")) &&
          typeof (m as { content?: unknown }).content === "string",
      )
      // Drop the streaming flag — anything mid-stream when the page closed is
      // gone; we don't want to render a perpetually-streaming bubble.
      .map((m) => ({ role: m.role, content: m.content, draftType: m.draftType }));
  } catch {
    return [];
  }
}

export function writeHistory(messages: ChatMessage[], storage?: StorageLike | null): void {
  const s = storage ?? getStorage();
  if (!s) return;
  try {
    const trimmed =
      messages.length > HISTORY_CAP ? messages.slice(-HISTORY_CAP) : messages;
    // Strip transient flags so we don't persist a "still streaming" bubble.
    const sanitized = trimmed.map((m) => ({
      role: m.role,
      content: m.content,
      ...(m.draftType ? { draftType: m.draftType } : {}),
    }));
    s.setItem(STORAGE_KEYS.history, JSON.stringify(sanitized));
  } catch {
    // ignore
  }
}
