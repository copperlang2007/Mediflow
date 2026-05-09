import { describe, it, expect, beforeEach } from "vitest";
import {
  readBool,
  writeBool,
  readHistory,
  writeHistory,
  STORAGE_KEYS,
  HISTORY_CAP,
  type ChatMessage,
} from "../ai-assistant-storage";

// Minimal in-memory localStorage stand-in so the helpers can be tested under
// node without jsdom. Matches the small surface area the helpers use.
function createMockStorage() {
  const data = new Map<string, string>();
  return {
    getItem: (k: string) => (data.has(k) ? (data.get(k) as string) : null),
    setItem: (k: string, v: string) => {
      data.set(k, v);
    },
  };
}

describe("ai-assistant-storage", () => {
  let storage: ReturnType<typeof createMockStorage>;
  beforeEach(() => {
    storage = createMockStorage();
  });

  describe("readBool / writeBool", () => {
    it("falls back to the supplied default when no value is stored", () => {
      expect(readBool("anything", true, storage)).toBe(true);
      expect(readBool("anything", false, storage)).toBe(false);
    });

    it("round-trips true/false", () => {
      writeBool(STORAGE_KEYS.open, true, storage);
      expect(readBool(STORAGE_KEYS.open, false, storage)).toBe(true);
      writeBool(STORAGE_KEYS.open, false, storage);
      expect(readBool(STORAGE_KEYS.open, true, storage)).toBe(false);
    });
  });

  describe("readHistory / writeHistory", () => {
    it("returns [] when nothing is stored", () => {
      expect(readHistory(storage)).toEqual([]);
    });

    it("round-trips a simple chat history", () => {
      const messages: ChatMessage[] = [
        { role: "user", content: "Hi" },
        { role: "assistant", content: "Hello!" },
      ];
      writeHistory(messages, storage);
      expect(readHistory(storage)).toEqual(messages);
    });

    it("strips transient flags like isStreaming on persist", () => {
      writeHistory(
        [{ role: "assistant", content: "...", isStreaming: true }],
        storage,
      );
      const restored = readHistory(storage);
      expect(restored).toHaveLength(1);
      expect(restored[0]).not.toHaveProperty("isStreaming");
    });

    it("trims history to HISTORY_CAP newest entries", () => {
      const overflow: ChatMessage[] = Array.from({ length: HISTORY_CAP + 5 }, (_, i) => ({
        role: i % 2 === 0 ? "user" : "assistant",
        content: `msg ${i}`,
      }));
      writeHistory(overflow, storage);
      const restored = readHistory(storage);
      expect(restored).toHaveLength(HISTORY_CAP);
      // Should keep the *last* HISTORY_CAP messages, not the first.
      expect(restored[0].content).toBe(`msg 5`);
      expect(restored[restored.length - 1].content).toBe(`msg ${HISTORY_CAP + 4}`);
    });

    it("ignores entries with unknown roles", () => {
      storage.setItem(
        STORAGE_KEYS.history,
        JSON.stringify([
          { role: "system", content: "ignored" },
          { role: "user", content: "kept" },
          "not an object",
          { role: "assistant" }, // missing content
        ]),
      );
      const restored = readHistory(storage);
      expect(restored).toEqual([{ role: "user", content: "kept", draftType: undefined }]);
    });

    it("returns [] when stored value is malformed JSON", () => {
      storage.setItem(STORAGE_KEYS.history, "not json");
      expect(readHistory(storage)).toEqual([]);
    });
  });
});
