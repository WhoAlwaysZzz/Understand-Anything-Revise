import type { GraphNode, KnowledgeGraph } from "@understand-anything/core/types";
import { fuzzyScore } from "../utils/fuzzyMatch";
import { numberLines } from "./buildNodeContext";

/**
 * Extra code context the user attaches to an Ask AI question, on top of the
 * dialog's own node: another graph node, a file or a line range of one, or
 * the hits of a full-text code search.
 */
export type ContextItem =
  | { kind: "node"; nodeId: string }
  | { kind: "file"; path: string; lines?: [number, number] }
  | { kind: "search"; query: string };

/** One attached file is capped at ~15k tokens, everything attached to a question at ~50k. */
export const MAX_ATTACHED_FILE_CHARS = 60_000;
export const MAX_ATTACHED_TOTAL_CHARS = 200_000;
const MAX_SEARCH_LINES = 80;

export interface SearchHits {
  files: Array<{ path: string; matchCount: number; matches: Array<{ line: number; preview: string }> }>;
  totalMatches: number;
  truncated: boolean;
}

/** Where attached items get their text from (the dashboard server's endpoints, in the app). */
export interface ContextSources {
  nodesById: Map<string, GraphNode>;
  /** Full file text, or null when the server can't provide it. */
  readFile: (path: string) => Promise<string | null>;
  searchCode: (query: string) => Promise<SearchHits | null>;
}

export function contextItemKey(item: ContextItem): string {
  if (item.kind === "node") return `node:${item.nodeId}`;
  if (item.kind === "search") return `search:${item.query}`;
  return `file:${item.path}${item.lines ? `:${item.lines[0]}-${item.lines[1]}` : ""}`;
}

export function contextItemLabel(item: ContextItem, nodesById: Map<string, GraphNode>): string {
  if (item.kind === "node") return nodesById.get(item.nodeId)?.name ?? item.nodeId;
  if (item.kind === "search") return `"${item.query}"`;
  if (!item.lines) return item.path;
  return item.lines[0] === item.lines[1] ? `${item.path}:${item.lines[0]}` : `${item.path}:${item.lines[0]}-${item.lines[1]}`;
}

function splitLines(source: string): string[] {
  return source.split(/\r\n|\n|\r/);
}

function codeBlock(text: string): string {
  return `\`\`\`\n${text}\n\`\`\``;
}

/** Numbered lines `start..end` (1-based, inclusive, clamped to the file). */
function sliceLines(source: string, start: number, end: number): { text: string; start: number; end: number; total: number; truncated: boolean } {
  const lines = splitLines(source);
  const from = Math.min(Math.max(1, start), lines.length);
  const to = Math.min(Math.max(from, end), lines.length);
  const { text, truncated } = numberLines(lines.slice(from - 1, to).join("\n"), from, MAX_ATTACHED_FILE_CHARS);
  return { text, start: from, end: to, total: lines.length, truncated };
}

/** Render one item as a Markdown block. Throws when its source can't be read. */
export async function resolveContextItem(item: ContextItem, sources: ContextSources): Promise<string> {
  if (item.kind === "file") {
    const source = await sources.readFile(item.path);
    if (source === null) throw new Error(`Could not read ${item.path}`);
    if (item.lines) {
      const s = sliceLines(source, item.lines[0], item.lines[1]);
      return `## File: ${item.path} (lines ${s.start}-${s.end} of ${s.total}${s.truncated ? ", truncated" : ""})\n${codeBlock(s.text)}`;
    }
    const { text, truncated } = numberLines(source, 1, MAX_ATTACHED_FILE_CHARS);
    return `## File: ${item.path}${truncated ? " (truncated)" : ""}\n${codeBlock(text)}`;
  }

  if (item.kind === "node") {
    const node = sources.nodesById.get(item.nodeId);
    if (!node) throw new Error(`Node ${item.nodeId} is not in the graph`);
    const where = node.filePath ? ` — ${node.filePath}${node.lineRange ? `:${node.lineRange[0]}-${node.lineRange[1]}` : ""}` : "";
    const lines = [`## Node: ${node.name} (${node.type})${where}`, `summary: ${node.summary}`];
    if (node.filePath) {
      const source = await sources.readFile(node.filePath);
      if (source !== null) {
        if (node.lineRange) {
          lines.push(codeBlock(sliceLines(source, node.lineRange[0], node.lineRange[1]).text));
        } else {
          const { text, truncated } = numberLines(source, 1, MAX_ATTACHED_FILE_CHARS);
          lines.push(`${truncated ? "(truncated)\n" : ""}${codeBlock(text)}`);
        }
      }
    }
    return lines.join("\n");
  }

  const hits = await sources.searchCode(item.query);
  if (!hits) throw new Error(`Code search for "${item.query}" failed`);
  const header = `## Code search: "${item.query}" — ${hits.totalMatches}${hits.truncated ? "+" : ""} matches in ${hits.files.length} files`;
  if (hits.totalMatches === 0) return `${header}\n(no matches)`;
  const rows: string[] = [];
  outer: for (const file of hits.files) {
    for (const match of file.matches) {
      if (rows.length >= MAX_SEARCH_LINES) break outer;
      rows.push(`${file.path}:${match.line}  ${match.preview.trim()}`);
    }
  }
  const shown = rows.length < hits.totalMatches ? `\n(showing ${rows.length} of ${hits.totalMatches} matches)` : "";
  return `${header}\n${codeBlock(rows.join("\n"))}${shown}`;
}

/** Join resolved blocks under one heading, cutting the total at MAX_ATTACHED_TOTAL_CHARS. */
export function formatAttachedContext(blocks: string[]): string {
  const kept: string[] = [];
  let size = 0;
  for (const block of blocks) {
    if (!block.trim()) continue;
    if (size + block.length > MAX_ATTACHED_TOTAL_CHARS) {
      const room = MAX_ATTACHED_TOTAL_CHARS - size;
      if (room > 500) kept.push(`${block.slice(0, room)}\n…`);
      kept.push(`(attached context cut at ${MAX_ATTACHED_TOTAL_CHARS} characters)`);
      break;
    }
    kept.push(block);
    size += block.length;
  }
  return kept.length ? `# Attached context\n\n${kept.join("\n\n")}` : "";
}

/** Rough token count for display (~4 characters per token). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** `src/a.ts:10-40` or `src/a.ts:12` → path + range. */
export function parseLineRef(text: string): { path: string; lines: [number, number] } | null {
  const m = /^(.+?):(\d+)(?:-(\d+))?$/.exec(text.trim());
  if (!m) return null;
  const start = Number(m[2]);
  const end = m[3] ? Number(m[3]) : start;
  if (start < 1 || end < 1) return null;
  return { path: m[1], lines: [Math.min(start, end), Math.max(start, end)] };
}

export interface ContextSuggestion {
  item: ContextItem;
  label: string;
  /** Node type, file path or "search". */
  detail: string;
}

function nodeSuggestion(node: GraphNode): ContextSuggestion {
  return { item: { kind: "node", nodeId: node.id }, label: node.name, detail: node.filePath && node.filePath !== node.name ? `${node.type} · ${node.filePath}` : node.type };
}

/**
 * What the picker (and `@` mentions) offer. With no query: the node's own
 * file and its graph neighbours. With a query: a `path:10-40` line range when
 * the path is in the graph, fuzzy-matched nodes, and a code search for the
 * query text. Items whose key is in `exclude` are skipped.
 */
export function suggestContextItems(
  graph: KnowledgeGraph,
  node: GraphNode | null,
  query: string,
  { limit = 8, exclude = new Set<string>() }: { limit?: number; exclude?: Set<string> } = {},
): ContextSuggestion[] {
  const out: ContextSuggestion[] = [];
  const seen = new Set(exclude);
  if (node) seen.add(contextItemKey({ kind: "node", nodeId: node.id }));
  const push = (s: ContextSuggestion) => {
    const key = contextItemKey(s.item);
    if (seen.has(key) || out.length >= limit) return;
    seen.add(key);
    out.push(s);
  };
  const q = query.trim();

  if (!q) {
    if (!node) return out;
    if (node.filePath && node.type !== "file") {
      const fileNode = graph.nodes.find((n) => n.type === "file" && n.filePath === node.filePath);
      push(fileNode ? nodeSuggestion(fileNode) : { item: { kind: "file", path: node.filePath }, label: node.filePath, detail: "file" });
    }
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    for (const e of graph.edges) {
      if (e.source !== node.id && e.target !== node.id) continue;
      const other = byId.get(e.source === node.id ? e.target : e.source);
      if (other) push(nodeSuggestion(other));
    }
    return out;
  }

  const ref = parseLineRef(q);
  if (ref) {
    const paths = [...new Set(graph.nodes.map((n) => n.filePath).filter((p): p is string => !!p))];
    const exact = paths.find((p) => p === ref.path);
    const suffix = paths.filter((p) => p.endsWith(`/${ref.path}`));
    const path = exact ?? (suffix.length === 1 ? suffix[0] : undefined);
    if (path) {
      const item: ContextItem = { kind: "file", path, lines: ref.lines };
      push({ item, label: contextItemLabel(item, new Map()), detail: "lines" });
    }
  }

  const scored: Array<{ node: GraphNode; score: number }> = [];
  for (const n of graph.nodes) {
    // fuzzyScore returns exactly -1 for "no match".
    const nameScore = fuzzyScore(q, n.name);
    const pathScore = n.filePath ? fuzzyScore(q, n.filePath) : -1;
    if (nameScore === -1 && pathScore === -1) continue;
    const score = Math.max(nameScore === -1 ? -Infinity : nameScore, pathScore === -1 ? -Infinity : pathScore - 2);
    scored.push({ node: n, score });
  }
  scored.sort((a, b) => b.score - a.score);
  const room = q.length >= 2 ? limit - 1 : limit;
  for (const { node: n } of scored) {
    if (out.length >= room) break;
    push(nodeSuggestion(n));
  }
  if (q.length >= 2) push({ item: { kind: "search", query: q }, label: `"${q}"`, detail: "search" });
  return out;
}
