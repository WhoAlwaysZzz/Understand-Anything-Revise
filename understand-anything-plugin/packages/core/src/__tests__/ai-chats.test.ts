import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage } from "node:http";
import {
  AI_CHATS_FILE_NAME,
  AiChatsError,
  handleAiChatsRequest,
  normalizeAiChats,
  normalizeSessions,
  readAiChats,
} from "../ai-chats.js";

function request(method: string, body?: unknown, contentType = "application/json"): IncomingMessage {
  const stream = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  return Object.assign(stream, { method, headers: { "content-type": contentType } }) as unknown as IncomingMessage;
}

function url(query = ""): URL {
  return new URL(`http://127.0.0.1/ai-chats.json${query}`);
}

function session(id: string, updatedAt: string, question = "why?") {
  return {
    id,
    title: "",
    context: "# Node: a",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt,
    turns: [{ question, answer: "because", status: "done", at: "2026-01-01T00:00:00Z" }],
  };
}

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ua-ai-chats-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("normalizeSessions", () => {
  it("drops empty sessions and duplicate ids, sorts newest first and fills in the title", () => {
    const sessions = normalizeSessions([
      session("a", "2026-01-01T00:00:00Z", "first question"),
      session("b", "2026-03-01T00:00:00Z"),
      session("a", "2026-05-01T00:00:00Z"),
      { id: "c", turns: [] },
      { turns: [{ question: "no id" }] },
      "nope",
    ]);
    expect(sessions.map((s) => s.id)).toEqual(["b", "a"]);
    expect(sessions[1].title).toBe("first question");
  });

  it("turns a turn saved mid-stream into a stopped one and keeps attachment labels", () => {
    const [s] = normalizeSessions([
      {
        ...session("a", "2026-01-01T00:00:00Z"),
        turns: [
          {
            question: "q",
            answer: "partial",
            status: "streaming",
            stopReason: null,
            context: "# Attached\nsrc/a.ts",
            attachments: [{ kind: "file", label: "src/a.ts" }, { kind: "file" }],
          },
          { question: "   ", answer: "dropped" },
        ],
      },
    ]);
    expect(s.turns).toHaveLength(1);
    expect(s.turns[0]).toMatchObject({
      status: "stopped",
      stopReason: null,
      context: "# Attached\nsrc/a.ts",
      attachments: [{ kind: "file", label: "src/a.ts" }],
    });
  });

  it("rejects a non-array", () => {
    expect(() => normalizeSessions({})).toThrow(AiChatsError);
  });
});

describe("normalizeAiChats", () => {
  it("drops nodes without sessions", () => {
    const doc = normalizeAiChats({ nodes: { a: [session("x", "2026-01-01T00:00:00Z")], b: [], c: "nope" } });
    expect(Object.keys(doc.nodes)).toEqual(["a"]);
  });
});

describe("handleAiChatsRequest", () => {
  it("returns an empty index when there is no file yet", async () => {
    const res = await handleAiChatsRequest(request("GET"), url(), dir, { writable: true });
    expect(res).toEqual({ statusCode: 200, payload: { version: 1, index: {}, writable: true } });
  });

  it("saves one node's sessions without touching the others", async () => {
    await handleAiChatsRequest(request("PUT", { sessions: [session("x", "2026-01-01T00:00:00Z")] }), url("?node=a"), dir, {
      writable: true,
    });
    const put = await handleAiChatsRequest(
      request("PUT", { sessions: [session("y", "2026-02-01T00:00:00Z")] }),
      url("?node=b"),
      dir,
      { writable: true },
    );
    expect(put.statusCode).toBe(200);
    expect(Object.keys(readAiChats(dir).nodes).sort()).toEqual(["a", "b"]);

    const index = await handleAiChatsRequest(request("GET"), url(), dir, { writable: true });
    expect(index.payload).toMatchObject({
      index: { a: { count: 1, updatedAt: "2026-01-01T00:00:00Z" }, b: { count: 1, updatedAt: "2026-02-01T00:00:00Z" } },
    });

    const node = await handleAiChatsRequest(request("GET"), url("?node=b"), dir, { writable: true });
    expect((node.payload as { sessions: Array<{ id: string }> }).sessions.map((s) => s.id)).toEqual(["y"]);
  });

  it("removes a node when its list is emptied", async () => {
    await handleAiChatsRequest(request("PUT", { sessions: [session("x", "2026-01-01T00:00:00Z")] }), url("?node=a"), dir, {
      writable: true,
    });
    await handleAiChatsRequest(request("PUT", { sessions: [] }), url("?node=a"), dir, { writable: true });
    expect(readAiChats(dir).nodes).toEqual({});
  });

  it("refuses writes on read-only servers, without a node, or with the wrong content type", async () => {
    const body = { sessions: [] };
    expect((await handleAiChatsRequest(request("PUT", body), url("?node=a"), dir, { writable: false })).statusCode).toBe(405);
    expect((await handleAiChatsRequest(request("PUT", body), url(), dir, { writable: true })).statusCode).toBe(400);
    expect(
      (await handleAiChatsRequest(request("PUT", body, "text/plain"), url("?node=a"), dir, { writable: true })).statusCode,
    ).toBe(415);
  });

  it("never reports or overwrites a corrupt file", async () => {
    fs.writeFileSync(path.join(dir, AI_CHATS_FILE_NAME), "{ not json");
    expect((await handleAiChatsRequest(request("GET"), url(), dir, { writable: true })).statusCode).toBe(500);
    const put = await handleAiChatsRequest(request("PUT", { sessions: [] }), url("?node=a"), dir, { writable: true });
    expect(put.statusCode).toBe(400);
    expect(fs.readFileSync(path.join(dir, AI_CHATS_FILE_NAME), "utf-8")).toBe("{ not json");
  });
});
