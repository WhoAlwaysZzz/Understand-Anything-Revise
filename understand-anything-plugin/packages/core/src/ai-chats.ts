/**
 * Saved "Ask AI" conversations, kept per graph node.
 *
 * Stored next to the knowledge graph as `ai-chats.json` in the project's data
 * directory (`.ua/` or legacy `.understand-anything/`), separate from
 * knowledge-graph.json so re-running /understand never overwrites them. Each
 * session keeps the node context it was started with, so it can be resumed
 * later with exactly the same prompt.
 *
 * Used by the dashboard dev server (vite.config.ts) and the standalone
 * viewer (which copies the compiled file), so this module must stay
 * self-contained: Node built-ins only, no other core imports.
 */
import fs from "node:fs";
import path from "node:path";
import type { IncomingMessage } from "node:http";

export const AI_CHATS_FILE_NAME = "ai-chats.json";
export const MAX_AI_CHATS_BODY_BYTES = 8 * 1024 * 1024;
const MAX_SESSIONS_PER_NODE = 50;
const MAX_TURNS_PER_SESSION = 200;
const MAX_ATTACHMENTS_PER_TURN = 30;
const MAX_TITLE_LENGTH = 200;
const MAX_TEXT_LENGTH = 200_000;
const MAX_CONTEXT_LENGTH = 400_000;
const MAX_SHORT_LENGTH = 500;

export type AiChatTurnStatus = "done" | "stopped" | "error";

/** What the user attached to a question — a label for display, not the text sent. */
export interface AiChatAttachment {
  kind: string;
  label: string;
}

export interface AiChatTurn {
  question: string;
  answer: string;
  status: AiChatTurnStatus;
  error?: string;
  stopReason?: string | null;
  servedBy?: string;
  /** Extra code context sent along with this question. */
  context?: string;
  attachments?: AiChatAttachment[];
  at: string;
}

export interface AiChatSession {
  id: string;
  title: string;
  model?: string;
  /** The node context sent with the first question. */
  context: string;
  createdAt: string;
  updatedAt: string;
  turns: AiChatTurn[];
}

export interface AiChatsDocument {
  version: 1;
  nodes: Record<string, AiChatSession[]>;
}

/** Per-node summary for badges: how many sessions, and when the last one changed. */
export interface AiChatsIndexEntry {
  count: number;
  updatedAt: string;
}

export class AiChatsError extends Error {}

export function emptyAiChats(): AiChatsDocument {
  return { version: 1, nodes: {} };
}

function str(value: unknown, max: number): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function optionalStr(value: unknown, max: number): string | undefined {
  return typeof value === "string" && value ? value.slice(0, max) : undefined;
}

function normalizeAttachments(raw: unknown): AiChatAttachment[] {
  if (!Array.isArray(raw)) return [];
  const out: AiChatAttachment[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const a = item as Record<string, unknown>;
    const label = str(a.label, MAX_SHORT_LENGTH);
    if (!label) continue;
    out.push({ kind: str(a.kind, 32) || "file", label });
    if (out.length >= MAX_ATTACHMENTS_PER_TURN) break;
  }
  return out;
}

function normalizeTurn(raw: unknown): AiChatTurn | null {
  if (!raw || typeof raw !== "object") return null;
  const t = raw as Record<string, unknown>;
  const question = str(t.question, MAX_TEXT_LENGTH);
  if (!question.trim()) return null;
  // A turn saved mid-stream (tab closed) is as good as stopped.
  const status: AiChatTurnStatus = t.status === "done" || t.status === "error" ? t.status : "stopped";
  const turn: AiChatTurn = {
    question,
    answer: str(t.answer, MAX_TEXT_LENGTH),
    status,
    at: typeof t.at === "string" ? t.at : new Date().toISOString(),
  };
  const error = optionalStr(t.error, 2_000);
  if (error) turn.error = error;
  if (t.stopReason === null) turn.stopReason = null;
  else if (typeof t.stopReason === "string") turn.stopReason = t.stopReason.slice(0, 64);
  const servedBy = optionalStr(t.servedBy, MAX_SHORT_LENGTH);
  if (servedBy) turn.servedBy = servedBy;
  const context = optionalStr(t.context, MAX_CONTEXT_LENGTH);
  if (context) turn.context = context;
  const attachments = normalizeAttachments(t.attachments);
  if (attachments.length) turn.attachments = attachments;
  return turn;
}

function normalizeSession(raw: unknown): AiChatSession | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as Record<string, unknown>;
  const id = str(s.id, 64);
  if (!id) return null;
  const turns = (Array.isArray(s.turns) ? s.turns : [])
    .map(normalizeTurn)
    .filter((t): t is AiChatTurn => t !== null)
    .slice(-MAX_TURNS_PER_SESSION);
  if (turns.length === 0) return null;
  const now = new Date().toISOString();
  const session: AiChatSession = {
    id,
    title: str(s.title, MAX_TITLE_LENGTH) || turns[0].question.slice(0, MAX_TITLE_LENGTH),
    context: str(s.context, MAX_CONTEXT_LENGTH),
    createdAt: typeof s.createdAt === "string" ? s.createdAt : turns[0].at,
    updatedAt: typeof s.updatedAt === "string" ? s.updatedAt : now,
    turns,
  };
  const model = optionalStr(s.model, MAX_SHORT_LENGTH);
  if (model) session.model = model;
  return session;
}

/**
 * Clean one node's session list: drops malformed or empty sessions and
 * duplicate ids, keeps the most recently updated ones up to the cap, newest
 * first. Throws AiChatsError when the list itself is not an array.
 */
export function normalizeSessions(raw: unknown): AiChatSession[] {
  if (!Array.isArray(raw)) throw new AiChatsError("`sessions` must be an array");
  const seen = new Set<string>();
  const sessions: AiChatSession[] = [];
  for (const item of raw) {
    const session = normalizeSession(item);
    if (!session || seen.has(session.id)) continue;
    seen.add(session.id);
    sessions.push(session);
  }
  sessions.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  return sessions.slice(0, MAX_SESSIONS_PER_NODE);
}

/** Validate and clean a whole document. Throws AiChatsError on a wrong top-level shape. */
export function normalizeAiChats(raw: unknown): AiChatsDocument {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new AiChatsError("AI chats must be a JSON object");
  }
  const nodesRaw = (raw as { nodes?: unknown }).nodes ?? {};
  if (!nodesRaw || typeof nodesRaw !== "object" || Array.isArray(nodesRaw)) {
    throw new AiChatsError("AI chats `nodes` must be an object keyed by node id");
  }
  const doc = emptyAiChats();
  for (const [nodeId, list] of Object.entries(nodesRaw as Record<string, unknown>)) {
    if (!nodeId || !Array.isArray(list)) continue;
    const sessions = normalizeSessions(list);
    if (sessions.length) doc.nodes[nodeId] = sessions;
  }
  return doc;
}

export function aiChatsIndex(doc: AiChatsDocument): Record<string, AiChatsIndexEntry> {
  const index: Record<string, AiChatsIndexEntry> = {};
  for (const [nodeId, sessions] of Object.entries(doc.nodes)) {
    if (sessions.length) index[nodeId] = { count: sessions.length, updatedAt: sessions[0].updatedAt };
  }
  return index;
}

export function readAiChats(dataDir: string): AiChatsDocument {
  const file = path.join(dataDir, AI_CHATS_FILE_NAME);
  if (!fs.existsSync(file)) return emptyAiChats();
  return normalizeAiChats(JSON.parse(fs.readFileSync(file, "utf-8")));
}

/** Write atomically (temp file + rename) so a crash never leaves half a file. */
export function writeAiChats(dataDir: string, doc: AiChatsDocument): void {
  const file = path.join(dataDir, AI_CHATS_FILE_NAME);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, "utf-8");
  fs.renameSync(tmp, file);
}

function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new AiChatsError("AI chats payload is too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

export interface AiChatsResponse {
  statusCode: number;
  payload: unknown;
}

/**
 * Shared handler for `/ai-chats.json`. The caller has already checked the
 * access token. Pass `writable: false` for read-only servers.
 *
 *   GET                 → { index: { nodeId: { count, updatedAt } }, writable }
 *   GET  ?node=<id>     → { nodeId, sessions, writable }
 *   PUT  ?node=<id>     body { sessions } — replaces that node's sessions
 *                       (an empty list removes them)
 */
export async function handleAiChatsRequest(
  req: IncomingMessage,
  url: URL,
  dataDir: string,
  { writable }: { writable: boolean },
): Promise<AiChatsResponse> {
  const nodeId = url.searchParams.get("node") ?? "";
  try {
    if (req.method === "GET" || req.method === "HEAD") {
      let doc: AiChatsDocument;
      try {
        doc = readAiChats(dataDir);
      } catch {
        // Never report a corrupt file as empty: the client would then save over it.
        return { statusCode: 500, payload: { error: `${AI_CHATS_FILE_NAME} could not be parsed; fix or remove it` } };
      }
      if (nodeId) return { statusCode: 200, payload: { nodeId, sessions: doc.nodes[nodeId] ?? [], writable } };
      return { statusCode: 200, payload: { version: 1, index: aiChatsIndex(doc), writable } };
    }
    if (req.method === "PUT") {
      if (!writable) return { statusCode: 405, payload: { error: "This server is read-only" } };
      if (!(req.headers["content-type"] ?? "").startsWith("application/json")) {
        return { statusCode: 415, payload: { error: "Expected application/json" } };
      }
      if (!nodeId) return { statusCode: 400, payload: { error: "Missing node" } };
      const body = JSON.parse(await readBody(req, MAX_AI_CHATS_BODY_BYTES)) as { sessions?: unknown };
      const sessions = normalizeSessions(body?.sessions);
      const doc = readAiChats(dataDir);
      if (sessions.length) doc.nodes[nodeId] = sessions;
      else delete doc.nodes[nodeId];
      writeAiChats(dataDir, doc);
      return { statusCode: 200, payload: { nodeId, sessions, writable } };
    }
    return { statusCode: 405, payload: { error: "Method not allowed" } };
  } catch (err) {
    if (err instanceof AiChatsError || err instanceof SyntaxError) {
      return { statusCode: 400, payload: { error: err.message } };
    }
    return { statusCode: 500, payload: { error: "Failed to read or write AI chats" } };
  }
}
