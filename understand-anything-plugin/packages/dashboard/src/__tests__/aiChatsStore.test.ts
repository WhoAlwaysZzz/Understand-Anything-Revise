import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAiChatsStore, type ChatSession } from "../aiChatsStore";

const session = (id: string, updatedAt: string): ChatSession => ({
  id,
  title: id,
  context: "CTX",
  createdAt: updatedAt,
  updatedAt,
  turns: [{ question: "q", answer: "a", status: "done" }],
});

beforeEach(() => {
  // Saves are debounced; fake timers keep them from firing (no fetch in tests).
  vi.useFakeTimers();
  useAiChatsStore.setState({ index: {}, sessions: {}, storage: "local" });
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("useAiChatsStore", () => {
  it("keeps the latest saved session first and updates the index", async () => {
    const store = useAiChatsStore.getState();
    await store.loadNode("n");
    store.saveSession("n", session("a", "2026-01-01T00:00:00Z"));
    store.saveSession("n", session("b", "2026-01-02T00:00:00Z"));
    store.saveSession("n", session("a", "2026-01-03T00:00:00Z"));
    const state = useAiChatsStore.getState();
    expect(state.sessions.n.map((s) => s.id)).toEqual(["a", "b"]);
    expect(state.index.n).toEqual({ count: 2, updatedAt: "2026-01-03T00:00:00Z" });
  });

  it("loads a node before the first save so its other sessions survive", async () => {
    useAiChatsStore.getState().saveSession("n", session("a", "2026-01-01T00:00:00Z"));
    await vi.waitFor(() => expect(useAiChatsStore.getState().sessions.n).toBeDefined());
    expect(useAiChatsStore.getState().sessions.n.map((s) => s.id)).toEqual(["a"]);
  });

  it("deletes a session and drops the node from the index when it was the last", async () => {
    const store = useAiChatsStore.getState();
    await store.loadNode("n");
    store.saveSession("n", session("a", "2026-01-01T00:00:00Z"));
    store.deleteSession("n", "a");
    expect(useAiChatsStore.getState().sessions.n).toEqual([]);
    expect(useAiChatsStore.getState().index.n).toBeUndefined();
  });
});
