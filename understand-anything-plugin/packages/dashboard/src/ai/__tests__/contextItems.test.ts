import { describe, expect, it } from "vitest";
import type { GraphNode, KnowledgeGraph } from "@understand-anything/core/types";
import {
  MAX_ATTACHED_TOTAL_CHARS,
  contextItemKey,
  contextItemLabel,
  formatAttachedContext,
  parseLineRef,
  resolveContextItem,
  suggestContextItems,
  type ContextSources,
} from "../contextItems";

const node = (id: string, extra: Partial<GraphNode> = {}): GraphNode => ({
  id, type: "function", name: id, summary: `summary of ${id}`, tags: [], complexity: "simple", ...extra,
});

const graph: KnowledgeGraph = {
  version: "1",
  project: { name: "demo", languages: [], frameworks: [], description: "", analyzedAt: "", gitCommitHash: "" },
  nodes: [
    node("file:src/auth.ts", { type: "file", name: "auth.ts", filePath: "src/auth.ts" }),
    node("login", { filePath: "src/auth.ts", lineRange: [3, 4] }),
    node("hashPassword", { filePath: "src/crypto/hash.ts", lineRange: [1, 2] }),
    node("route", { filePath: "src/routes.ts" }),
  ],
  edges: [
    { source: "login", target: "hashPassword", type: "calls", direction: "forward", weight: 1 },
    { source: "route", target: "login", type: "calls", direction: "forward", weight: 1 },
  ],
  layers: [],
  tour: [],
};
const nodesById = new Map(graph.nodes.map((n) => [n.id, n]));

const files: Record<string, string> = {
  "src/auth.ts": "import x\n\nfunction login() {\n}\nexport { login }",
  "src/crypto/hash.ts": "export function hashPassword() {\n}",
};
const sources: ContextSources = {
  nodesById,
  readFile: async (path) => files[path] ?? null,
  searchCode: async (query) => ({
    files: [{ path: "src/auth.ts", matchCount: 1, matches: [{ line: 3, preview: `  function ${query}() {` }] }],
    totalMatches: 1,
    truncated: false,
  }),
};

describe("context item labels", () => {
  it("keys and labels each kind", () => {
    expect(contextItemKey({ kind: "file", path: "a.ts", lines: [1, 5] })).toBe("file:a.ts:1-5");
    expect(contextItemLabel({ kind: "file", path: "a.ts", lines: [7, 7] }, nodesById)).toBe("a.ts:7");
    expect(contextItemLabel({ kind: "node", nodeId: "login" }, nodesById)).toBe("login");
    expect(contextItemLabel({ kind: "search", query: "token" }, nodesById)).toBe('"token"');
  });

  it("parses path:line refs", () => {
    expect(parseLineRef("src/a.ts:40-10")).toEqual({ path: "src/a.ts", lines: [10, 40] });
    expect(parseLineRef("src/a.ts:12")).toEqual({ path: "src/a.ts", lines: [12, 12] });
    expect(parseLineRef("src/a.ts")).toBeNull();
  });
});

describe("resolveContextItem", () => {
  it("numbers a line range of a file", async () => {
    const text = await resolveContextItem({ kind: "file", path: "src/auth.ts", lines: [3, 4] }, sources);
    expect(text).toContain("## File: src/auth.ts (lines 3-4 of 5)");
    expect(text).toContain("    3  function login() {");
    expect(text).not.toContain("import x");
  });

  it("sends a node's summary and exactly its line range", async () => {
    const text = await resolveContextItem({ kind: "node", nodeId: "hashPassword" }, sources);
    expect(text).toContain("## Node: hashPassword (function) — src/crypto/hash.ts:1-2");
    expect(text).toContain("summary of hashPassword");
    expect(text).toContain("    1  export function hashPassword() {");
  });

  it("lists search hits as path:line rows", async () => {
    const text = await resolveContextItem({ kind: "search", query: "login" }, sources);
    expect(text).toContain('## Code search: "login" — 1 matches in 1 files');
    expect(text).toContain("src/auth.ts:3  function login() {");
  });

  it("fails when a file can't be read", async () => {
    await expect(resolveContextItem({ kind: "file", path: "missing.ts" }, sources)).rejects.toThrow("missing.ts");
  });
});

describe("formatAttachedContext", () => {
  it("returns nothing for no blocks and caps the total", () => {
    expect(formatAttachedContext([])).toBe("");
    const big = "x".repeat(MAX_ATTACHED_TOTAL_CHARS - 5);
    const out = formatAttachedContext(["## A\nshort", big, "## C\nnever"]);
    expect(out.startsWith("# Attached context")).toBe(true);
    expect(out).toContain("cut at");
    expect(out).not.toContain("never");
  });
});

describe("suggestContextItems", () => {
  it("offers the node's file and neighbours with no query", () => {
    const out = suggestContextItems(graph, nodesById.get("login")!, "");
    expect(out.map((s) => contextItemKey(s.item))).toEqual(["node:file:src/auth.ts", "node:hashPassword", "node:route"]);
  });

  it("fuzzy-matches nodes, offers line ranges and a code search", () => {
    const out = suggestContextItems(graph, nodesById.get("login")!, "hash.ts:1-2");
    expect(contextItemKey(out[0].item)).toBe("file:src/crypto/hash.ts:1-2");
    expect(contextItemKey(out[out.length - 1].item)).toBe("search:hash.ts:1-2");

    const byName = suggestContextItems(graph, null, "hashpw");
    expect(contextItemKey(byName[0].item)).toBe("node:hashPassword");
  });

  it("skips excluded and current items", () => {
    const out = suggestContextItems(graph, nodesById.get("login")!, "", { exclude: new Set(["node:route"]) });
    expect(out.map((s) => contextItemKey(s.item))).not.toContain("node:route");
    expect(out.map((s) => contextItemKey(s.item))).not.toContain("node:login");
  });
});
