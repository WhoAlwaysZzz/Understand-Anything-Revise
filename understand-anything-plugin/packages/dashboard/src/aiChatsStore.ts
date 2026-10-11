import { create } from "zustand";
import type { Turn } from "./ai/conversation";

/**
 * Saved Ask AI conversations, per graph node.
 *
 * Persisted to the project's data directory (`.ua/ai-chats.json`) via the
 * dashboard server's `/ai-chats.json` endpoint, one node at a time. When the
 * server can't store them — static demo build, the read-only standalone
 * viewer, a failed save — they live in this browser's localStorage instead,
 * keyed by project.
 *
 * Mirrors core's ai-chats.ts shape (redeclared: the dashboard may only
 * import core's browser-safe subpaths).
 */
export interface ChatSession {
  id: string;
  title: string;
  model?: string;
  /** The node context sent with the first question; reused when the chat is resumed. */
  context: string;
  createdAt: string;
  updatedAt: string;
  turns: Turn[];
}

export interface ChatIndexEntry {
  count: number;
  updatedAt: string;
}

export type ChatStorage = "server" | "local";

interface AiChatsState {
  /** Session count per node, for badges. */
  index: Record<string, ChatIndexEntry>;
  /** Sessions of the nodes loaded so far, newest first. */
  sessions: Record<string, ChatSession[]>;
  storage: ChatStorage;
  load: (accessToken: string, projectKey: string) => Promise<void>;
  loadNode: (nodeId: string) => Promise<ChatSession[]>;
  /** Insert or replace a session and move it to the top of its node's list. */
  saveSession: (nodeId: string, session: ChatSession) => void;
  deleteSession: (nodeId: string, sessionId: string) => void;
}

const DEMO_TOKEN = "__demo__";
const SAVE_DEBOUNCE_MS = 300;
const LOCAL_KEY_PREFIX = "ua-ai-chats:";
const MAX_SESSIONS_PER_NODE = 50;

let token: string | null = null;
let localKey = `${LOCAL_KEY_PREFIX}default`;
let readOnlyServer = false;
const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
const nodeLoads = new Map<string, Promise<ChatSession[]>>();

export function newSessionId(): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `${Date.now().toString(36)}-${rand}`;
}

function readLocal(): Record<string, ChatSession[]> {
  try {
    const raw = window.localStorage.getItem(localKey);
    const parsed = raw ? (JSON.parse(raw) as { nodes?: Record<string, ChatSession[]> }) : null;
    return parsed?.nodes && typeof parsed.nodes === "object" ? parsed.nodes : {};
  } catch {
    return {};
  }
}

function writeLocalNode(nodeId: string, sessions: ChatSession[]): void {
  const nodes = readLocal();
  if (sessions.length) nodes[nodeId] = sessions;
  else delete nodes[nodeId];
  try {
    window.localStorage.setItem(localKey, JSON.stringify({ version: 1, nodes }));
  } catch {
    // Probably over quota: keep the conversations, drop the bulky code context
    // (a resumed chat then rebuilds it from the current node).
    try {
      const slim = Object.fromEntries(
        Object.entries(nodes).map(([id, list]) => [
          id,
          list.map((s) => ({ ...s, context: "", turns: s.turns.map(({ context: _context, ...turn }) => turn) })),
        ]),
      );
      window.localStorage.setItem(localKey, JSON.stringify({ version: 1, nodes: slim }));
    } catch {
      // Storage full or blocked — nothing more we can do.
    }
  }
}

function indexOf(nodes: Record<string, ChatSession[]>): Record<string, ChatIndexEntry> {
  const index: Record<string, ChatIndexEntry> = {};
  for (const [nodeId, list] of Object.entries(nodes)) {
    if (list.length) index[nodeId] = { count: list.length, updatedAt: list[0].updatedAt };
  }
  return index;
}

function chatsUrl(nodeId?: string): string {
  const params = new URLSearchParams({ token: token ?? "" });
  if (nodeId) params.set("node", nodeId);
  return `/ai-chats.json?${params.toString()}`;
}

/** Newest first; sessions from `overlay` replace same-id ones from `base`. */
function mergeSessions(base: ChatSession[], overlay: ChatSession[]): ChatSession[] {
  const byId = new Map(base.map((s) => [s.id, s]));
  for (const s of overlay) byId.set(s.id, s);
  return [...byId.values()].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
}

export const useAiChatsStore = create<AiChatsState>()((set, get) => {
  function scheduleSave(nodeId: string) {
    const pending = saveTimers.get(nodeId);
    if (pending) clearTimeout(pending);
    saveTimers.set(
      nodeId,
      setTimeout(() => {
        saveTimers.delete(nodeId);
        const sessions = get().sessions[nodeId] ?? [];
        if (get().storage === "local") {
          writeLocalNode(nodeId, sessions);
          return;
        }
        fetch(chatsUrl(nodeId), {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessions }),
        })
          .then((res) => {
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
          })
          .catch((err: unknown) => {
            console.warn("[ai-chats] could not save to the server, keeping chats in this browser:", err);
            set({ storage: "local" });
            writeLocalNode(nodeId, get().sessions[nodeId] ?? []);
          });
      }, SAVE_DEBOUNCE_MS),
    );
  }

  function setNode(nodeId: string, list: ChatSession[]) {
    const sessions = { ...get().sessions, [nodeId]: list };
    const index = { ...get().index };
    if (list.length) index[nodeId] = { count: list.length, updatedAt: list[0].updatedAt };
    else delete index[nodeId];
    set({ sessions, index });
  }

  async function fetchNode(nodeId: string): Promise<ChatSession[]> {
    if (get().storage === "local" && !readOnlyServer) return readLocal()[nodeId] ?? [];
    try {
      const res = await fetch(chatsUrl(nodeId));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const doc = (await res.json()) as { sessions?: ChatSession[] };
      const list = doc.sessions ?? [];
      return get().storage === "local" ? mergeSessions(list, readLocal()[nodeId] ?? []) : list;
    } catch {
      // Don't let a later PUT replace sessions we failed to read: stay local.
      if (!readOnlyServer) set({ storage: "local" });
      return readLocal()[nodeId] ?? [];
    }
  }

  return {
    index: {},
    sessions: {},
    storage: "server",

    load: async (accessToken, projectKey) => {
      token = accessToken;
      localKey = `${LOCAL_KEY_PREFIX}${projectKey}`;
      readOnlyServer = false;
      nodeLoads.clear();
      set({ sessions: {} });
      if (accessToken === DEMO_TOKEN) {
        set({ index: indexOf(readLocal()), storage: "local" });
        return;
      }
      try {
        const res = await fetch(chatsUrl());
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const doc = (await res.json()) as { index?: Record<string, ChatIndexEntry>; writable?: boolean };
        if (doc.writable) {
          set({ index: doc.index ?? {}, storage: "server" });
        } else {
          // Read-only server: committed chats, plus the ones kept in this browser.
          readOnlyServer = true;
          const local = indexOf(readLocal());
          const index = { ...(doc.index ?? {}) };
          for (const [id, entry] of Object.entries(local)) {
            const server = index[id];
            index[id] = server
              ? { count: Math.max(server.count, entry.count), updatedAt: entry.updatedAt > server.updatedAt ? entry.updatedAt : server.updatedAt }
              : entry;
          }
          set({ index, storage: "local" });
        }
      } catch {
        set({ index: indexOf(readLocal()), storage: "local" });
      }
    },

    loadNode: (nodeId) => {
      const cached = get().sessions[nodeId];
      if (cached) return Promise.resolve(cached);
      // One fetch per node, so callers queued on it run in order.
      let loading = nodeLoads.get(nodeId);
      if (!loading) {
        loading = fetchNode(nodeId).then((list) => {
          nodeLoads.delete(nodeId);
          // A save may have landed while we were fetching; it wins.
          const current = get().sessions[nodeId];
          if (current) return current;
          setNode(nodeId, list);
          return list;
        });
        nodeLoads.set(nodeId, loading);
      }
      return loading;
    },

    saveSession: (nodeId, session) => {
      // Never write a node's list before reading it: the PUT replaces the whole list.
      if (!get().sessions[nodeId]) {
        void get().loadNode(nodeId).then(() => get().saveSession(nodeId, session));
        return;
      }
      const others = (get().sessions[nodeId] ?? []).filter((s) => s.id !== session.id);
      setNode(nodeId, [session, ...others].slice(0, MAX_SESSIONS_PER_NODE));
      scheduleSave(nodeId);
    },

    deleteSession: (nodeId, sessionId) => {
      if (!get().sessions[nodeId]) return;
      setNode(
        nodeId,
        (get().sessions[nodeId] ?? []).filter((s) => s.id !== sessionId),
      );
      scheduleSave(nodeId);
    },
  };
});
