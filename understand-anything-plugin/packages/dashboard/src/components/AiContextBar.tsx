import { useEffect, useRef, useState } from "react";
import type { GraphNode, KnowledgeGraph } from "@understand-anything/core/types";
import { useI18n } from "../contexts/I18nContext";
import { fmt } from "../locales";
import type { SourceMode } from "../ai/buildNodeContext";
import {
  estimateTokens,
  suggestContextItems,
  type ContextItem,
  type ContextSuggestion,
} from "../ai/contextItems";

/** An attached item waiting to go out with the next question. */
export interface PendingContext {
  key: string;
  item: ContextItem;
  label: string;
  status: "loading" | "ready" | "error";
  text?: string;
  error?: string;
}

const KIND_ICON: Record<ContextItem["kind"], string> = { node: "◆", file: "▤", search: "⌕" };

export function formatTokens(tokens: number): string {
  return tokens >= 1000 ? `${(tokens / 1000).toFixed(tokens >= 10_000 ? 0 : 1)}k` : String(tokens);
}

/** Keyboard-navigable suggestion list, shared by the picker and `@` mentions. */
export function SuggestionList({
  suggestions,
  activeIndex,
  onPick,
  onHover,
}: {
  suggestions: ContextSuggestion[];
  activeIndex: number;
  onPick: (s: ContextSuggestion) => void;
  onHover?: (index: number) => void;
}) {
  const { t } = useI18n();
  if (suggestions.length === 0) {
    return <div className="px-3 py-2 text-xs text-text-muted">{t.ai.contextNoMatches}</div>;
  }
  return (
    <ul role="listbox" className="max-h-64 overflow-auto py-1" data-testid="ai-context-suggestions">
      {suggestions.map((s, i) => (
        <li key={`${s.item.kind}:${s.label}:${i}`} role="option" aria-selected={i === activeIndex}>
          <button
            type="button"
            // Keep focus (and the caret) in the input that opened the list.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onPick(s)}
            onMouseEnter={() => onHover?.(i)}
            className={`w-full text-left px-3 py-1.5 flex items-baseline gap-2 text-xs ${
              i === activeIndex ? "bg-accent/15 text-text-primary" : "text-text-secondary hover:bg-elevated"
            }`}
          >
            <span className="text-accent shrink-0">{KIND_ICON[s.item.kind]}</span>
            <span className="font-mono truncate">{s.label}</span>
            <span className="ml-auto text-[10px] text-text-muted truncate max-w-[50%]">
              {s.item.kind === "search" ? t.ai.searchCode : s.detail}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/** Arrow keys / Enter / Tab / Escape over a suggestion list. Returns true when the key was handled. */
export function handleSuggestionKey(
  e: React.KeyboardEvent,
  count: number,
  active: number,
  setActive: (i: number) => void,
  pick: (i: number) => void,
  close: () => void,
): boolean {
  if (e.nativeEvent.isComposing) return false;
  if (e.key === "Escape") {
    close();
    return true;
  }
  if (count === 0) return false;
  if (e.key === "ArrowDown") setActive((active + 1) % count);
  else if (e.key === "ArrowUp") setActive((active - 1 + count) % count);
  else if (e.key === "Enter" || e.key === "Tab") pick(active);
  else return false;
  return true;
}

function AddContextPopover({
  graph,
  node,
  exclude,
  onAdd,
  onClose,
}: {
  graph: KnowledgeGraph;
  node: GraphNode;
  exclude: Set<string>;
  onAdd: (item: ContextItem) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const suggestions = suggestContextItems(graph, node, query, { limit: 10, exclude });
  useEffect(() => inputRef.current?.focus(), []);
  useEffect(() => setActive(0), [query]);
  const pick = (i: number) => {
    const s = suggestions[i];
    if (s) onAdd(s.item);
  };
  return (
    <div
      className="absolute bottom-full left-0 mb-1 w-[min(460px,calc(100vw-48px))] rounded-lg border border-border-medium bg-surface shadow-2xl z-10"
      data-testid="ai-context-popover"
    >
      <input
        ref={inputRef}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (handleSuggestionKey(e, suggestions.length, active, setActive, pick, onClose)) {
            e.preventDefault();
            e.stopPropagation();
          }
        }}
        onBlur={onClose}
        placeholder={t.ai.contextSearchPlaceholder}
        className="w-full bg-transparent border-b border-border-subtle px-3 py-2 text-xs text-text-primary placeholder-text-muted focus:outline-none"
      />
      <SuggestionList suggestions={suggestions} activeIndex={active} onPick={(s) => onAdd(s.item)} onHover={setActive} />
    </div>
  );
}

/**
 * What goes along with the next question: how much of the node's own source
 * (first question only), plus attached nodes, files, line ranges and code
 * searches, each with a rough token count.
 */
export default function AiContextBar({
  graph,
  node,
  sourceMode,
  onSourceModeChange,
  baseContextChars,
  pending,
  onAdd,
  onRemove,
}: {
  graph: KnowledgeGraph;
  node: GraphNode;
  /** Undefined once the chat has started: the node context is already fixed. */
  sourceMode?: SourceMode;
  onSourceModeChange: (mode: SourceMode) => void;
  baseContextChars: number;
  pending: PendingContext[];
  onAdd: (item: ContextItem) => void;
  onRemove: (key: string) => void;
}) {
  const { t } = useI18n();
  const a = t.ai;
  const [pickerOpen, setPickerOpen] = useState(false);
  const pendingChars = pending.reduce((sum, p) => sum + (p.text?.length ?? 0), 0);
  const tokens = Math.ceil((baseContextChars + pendingChars) / 4);
  const modes: Array<[SourceMode, string]> = [
    ["excerpt", a.sourceExcerpt],
    ["full", a.sourceFull],
    ["none", a.sourceNone],
  ];

  return (
    <div className="flex flex-wrap items-center gap-1.5 mb-2 text-[11px]" data-testid="ai-context-bar">
      {sourceMode && node.filePath && (
        <div className="flex items-center gap-1 mr-1" title={a.sourceLabel}>
          <span className="text-text-muted">{a.sourceLabel}:</span>
          <div className="flex rounded border border-border-subtle overflow-hidden">
            {modes.map(([mode, label]) => (
              <button
                key={mode}
                type="button"
                onClick={() => onSourceModeChange(mode)}
                data-testid={`ai-source-${mode}`}
                className={`px-1.5 py-0.5 ${
                  sourceMode === mode ? "bg-accent/20 text-accent" : "text-text-muted hover:text-text-primary"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      )}
      {pending.map((p) => (
        <span
          key={p.key}
          className={`inline-flex items-center gap-1 max-w-[260px] rounded border px-1.5 py-0.5 ${
            p.status === "error" ? "border-red-400/50 text-red-400" : "border-accent/30 bg-accent/5 text-text-secondary"
          }`}
          title={p.status === "error" ? `${a.contextFailed}: ${p.error ?? ""}` : p.label}
          data-testid="ai-context-chip"
        >
          <span className="text-accent">{KIND_ICON[p.item.kind]}</span>
          <span className="font-mono truncate">{p.label}</span>
          <span className="text-text-muted shrink-0">
            {p.status === "loading" ? "…" : p.status === "error" ? "!" : formatTokens(estimateTokens(p.text ?? ""))}
          </span>
          <button
            type="button"
            onClick={() => onRemove(p.key)}
            aria-label={a.removeContext}
            title={a.removeContext}
            className="text-text-muted hover:text-text-primary"
          >
            ×
          </button>
        </span>
      ))}
      <div className="relative">
        <button
          type="button"
          // Don't blur the open picker's input first, or this click would reopen it.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setPickerOpen((open) => !open)}
          data-testid="ai-add-context"
          title={a.contextHint}
          className="rounded border border-dashed border-border-medium px-1.5 py-0.5 text-text-muted hover:text-accent hover:border-accent/40"
        >
          + {a.addContext}
        </button>
        {pickerOpen && (
          <AddContextPopover
            graph={graph}
            node={node}
            exclude={new Set(pending.map((p) => p.key))}
            onAdd={onAdd}
            onClose={() => setPickerOpen(false)}
          />
        )}
      </div>
      {tokens > 0 && (
        <span className="ml-auto text-text-muted" title={a.contextHint}>
          {fmt(a.contextTokens, { tokens: formatTokens(tokens) })}
        </span>
      )}
    </div>
  );
}
