import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useDashboardStore, type AiDialogView } from "../store";
import { useAnnotationsStore } from "../annotationsStore";
import { useI18n } from "../contexts/I18nContext";
import { fmt } from "../locales";
import { useAiChatsStore, newSessionId, type ChatSession } from "../aiChatsStore";
import { fetchAiConfig, streamAiChat, type PublicAiConfig } from "../ai/aiClient";
import { toMessages, type Turn } from "../ai/conversation";
import { buildNodeContext, buildSystemPrompt, type SourceMode } from "../ai/buildNodeContext";
import {
  contextItemKey,
  contextItemLabel,
  formatAttachedContext,
  resolveContextItem,
  suggestContextItems,
  type ContextItem,
  type ContextSources,
  type ContextSuggestion,
  type SearchHits,
} from "../ai/contextItems";
import MarkdownContent from "./MarkdownContent";
import AiSettingsForm from "./AiSettingsForm";
import AiChatHistory from "./AiChatHistory";
import AiContextBar, { SuggestionList, handleSuggestionKey, type PendingContext } from "./AiContextBar";

function useFileSource(accessToken: string, filePath: string | undefined): string | null | undefined {
  const [source, setSource] = useState<{ path: string; text: string | null } | null>(null);
  useEffect(() => {
    if (!filePath || accessToken === "__demo__") return;
    let cancelled = false;
    const params = new URLSearchParams({ token: accessToken, path: filePath });
    fetch(`/file-content.json?${params.toString()}`)
      .then((res) => (res.ok ? (res.json() as Promise<{ content?: string }>) : null))
      .then((data) => !cancelled && setSource({ path: filePath, text: data?.content ?? null }))
      .catch(() => !cancelled && setSource({ path: filePath, text: null }));
    return () => {
      cancelled = true;
    };
  }, [accessToken, filePath]);
  if (!filePath || accessToken === "__demo__") return null;
  return source?.path === filePath ? source.text : undefined; // undefined = still loading
}

async function fetchFileText(accessToken: string, filePath: string): Promise<string | null> {
  try {
    const params = new URLSearchParams({ token: accessToken, path: filePath });
    const res = await fetch(`/file-content.json?${params.toString()}`);
    if (!res.ok) return null;
    return ((await res.json()) as { content?: string }).content ?? null;
  } catch {
    return null;
  }
}

async function fetchSearchHits(accessToken: string, query: string): Promise<SearchHits | null> {
  try {
    const params = new URLSearchParams({ token: accessToken, q: query });
    const res = await fetch(`/search-content.json?${params.toString()}`);
    return res.ok ? ((await res.json()) as SearchHits) : null;
  } catch {
    return null;
  }
}

/** The chat being shown, mirrored outside React state so a reply streaming in keeps saving after a switch. */
interface ActiveChat {
  nodeId: string;
  id: string;
  title: string;
  context: string;
  createdAt: string;
  model?: string;
  turns: Turn[];
}

function toSession(chat: ActiveChat): ChatSession {
  return {
    id: chat.id,
    title: chat.title,
    ...(chat.model ? { model: chat.model } : {}),
    context: chat.context,
    createdAt: chat.createdAt,
    updatedAt: new Date().toISOString(),
    turns: chat.turns,
  };
}

/** `@query` right before the caret, if the user is typing a mention. */
function mentionAt(value: string, caret: number): { start: number; query: string } | null {
  const m = /(^|\s)@([^\s@]*)$/.exec(value.slice(0, caret));
  return m ? { start: caret - m[2].length - 1, query: m[2] } : null;
}

function SmallButton({ onClick, children, testId }: { onClick: () => void; children: React.ReactNode; testId?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      className="text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded border border-border-subtle text-text-muted hover:text-accent hover:border-accent/40 transition-colors"
    >
      {children}
    </button>
  );
}

function FlashButton({ label, doneLabel, onClick, testId }: { label: string; doneLabel: string; onClick: () => void; testId?: string }) {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const timer = window.setTimeout(() => setDone(false), 1500);
    return () => window.clearTimeout(timer);
  }, [done]);
  return (
    <SmallButton
      testId={testId}
      onClick={() => {
        onClick();
        setDone(true);
      }}
    >
      {done ? doneLabel : label}
    </SmallButton>
  );
}

/**
 * Chat with any configured model about one graph node. The node's summary,
 * relationships and source go along with the first question; more code
 * (other nodes, files, line ranges, code search hits) can be attached to any
 * question. Chats are saved per node and reopen with the node.
 */
export default function AskAiDialog({ accessToken }: { accessToken: string }) {
  const { t, localeKey } = useI18n();
  const a = t.ai;
  const dialog = useDashboardStore((s) => s.aiDialog);
  const closeAiDialog = useDashboardStore((s) => s.closeAiDialog);
  const graph = useDashboardStore((s) => s.graph);
  const nodesById = useDashboardStore((s) => s.nodesById);
  const node = useDashboardStore((s) => (s.aiDialog?.nodeId ? s.nodesById.get(s.aiDialog.nodeId) : undefined));
  const annotation = useAnnotationsStore((s) => (node ? s.annotations[node.id] : undefined));
  const savedSessions = useAiChatsStore((s) => (node ? s.sessions[node.id] : undefined));
  const savedCount = useAiChatsStore((s) => (node ? s.index[node.id]?.count ?? 0 : 0));
  const chatsLocal = useAiChatsStore((s) => s.storage === "local");

  // undefined = loading, null = no backend (demo / viewer)
  const [config, setConfig] = useState<PublicAiConfig | null | undefined>(undefined);
  const [view, setView] = useState<AiDialogView>(dialog?.view ?? "chat");
  const [turns, setTurns] = useState<Turn[]>([]);
  // The chat on screen. Its context is the one sent with the first question,
  // reused for follow-ups (and on resume) so a mid-chat note edit doesn't
  // rewrite history.
  const activeRef = useRef<ActiveChat | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  // Set when a saved chat was reopened (rather than started in this dialog).
  const [resumedFrom, setResumedFrom] = useState<string | null>(null);
  const [sourceMode, setSourceMode] = useState<SourceMode>("excerpt");
  const [pending, setPending] = useState<PendingContext[]>([]);
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [draft, setDraft] = useState("");
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const caretRef = useRef<number | null>(null);
  const source = useFileSource(accessToken, node?.filePath);
  const nodeId = node?.id;

  useEffect(() => {
    let cancelled = false;
    void fetchAiConfig(accessToken).then((c) => !cancelled && setConfig(c));
    return () => {
      cancelled = true;
    };
  }, [accessToken]);

  const fileCache = useRef(new Map<string, Promise<string | null>>());
  const sources = useMemo<ContextSources>(
    () => ({
      nodesById,
      readFile: (path) => {
        let text = fileCache.current.get(path);
        if (!text) {
          text = accessToken === "__demo__" ? Promise.resolve(null) : fetchFileText(accessToken, path);
          fileCache.current.set(path, text);
        }
        return text;
      },
      searchCode: (query) => (accessToken === "__demo__" ? Promise.resolve(null) : fetchSearchHits(accessToken, query)),
    }),
    [accessToken, nodesById],
  );

  const attach = useCallback(
    (item: ContextItem) => {
      const key = contextItemKey(item);
      const label = contextItemLabel(item, nodesById);
      setPending((list) => (list.some((p) => p.key === key) ? list : [...list, { key, item, label, status: "loading" }]));
      resolveContextItem(item, sources)
        .then((text) => setPending((list) => list.map((p) => (p.key === key ? { ...p, status: "ready", text } : p))))
        .catch((err: unknown) =>
          setPending((list) =>
            list.map((p) => (p.key === key ? { ...p, status: "error", error: err instanceof Error ? err.message : String(err) } : p)),
          ),
        );
    },
    [nodesById, sources],
  );

  const showChat = useCallback((chat: ActiveChat | null, resumed = false) => {
    activeRef.current = chat;
    setResumedFrom(resumed && chat ? chat.createdAt : null);
    setActiveId(chat?.id ?? null);
    setTurns(chat?.turns ?? []);
  }, []);

  // A different node (or the settings command) starts over, then reopens the
  // node's latest saved chat unless the dialog was opened with code attached.
  const initialAttach = dialog?.attach;
  useEffect(() => {
    abortRef.current?.abort();
    showChat(null);
    setDraft("");
    setMention(null);
    setHistoryOpen(false);
    setSourceMode("excerpt");
    setPending([]);
    setView(dialog?.view ?? "chat");
    for (const item of initialAttach ?? []) attach(item);
    if (!nodeId) return;
    let cancelled = false;
    void useAiChatsStore
      .getState()
      .loadNode(nodeId)
      .then((sessions) => {
        if (cancelled || initialAttach?.length || activeRef.current || !sessions[0]) return;
        const latest = sessions[0];
        showChat({ nodeId, ...latest, turns: latest.turns.map((turn) => (turn.status === "streaming" ? { ...turn, status: "stopped" } : turn)) }, true);
      });
    return () => {
      cancelled = true;
    };
    // Deliberately not keyed on `attach`: re-running when it changes identity would wipe the chat.
  }, [nodeId, dialog?.view, initialAttach]);

  useEffect(() => () => abortRef.current?.abort(), []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [turns]);

  const showSettings = config !== undefined && config !== null && (view !== "chat" || !config.configured || !node);

  useEffect(() => {
    if (config && !showSettings && !historyOpen) inputRef.current?.focus();
  }, [config, showSettings, historyOpen]);

  const freshContext = useMemo(() => {
    if (!graph || !node) return "";
    return buildNodeContext({
      graph,
      node,
      source: source ?? null,
      userNote: annotation?.note,
      userTags: annotation?.tags,
      localeKey,
      sourceMode,
    });
  }, [graph, node, source, annotation, localeKey, sourceMode]);
  const system = useMemo(() => buildSystemPrompt(localeKey), [localeKey]);
  // A resumed chat keeps the context it started with (unless it was dropped to save space).
  const chatContext = activeRef.current?.context || freshContext;
  const started = turns.length > 0;

  const busy = turns.some((turn) => turn.status === "streaming");
  const pendingLoading = pending.some((p) => p.status === "loading");
  const attachedContext = useMemo(
    () => formatAttachedContext(pending.filter((p) => p.status === "ready").map((p) => p.text ?? "")),
    [pending],
  );

  const persist = (chat: ActiveChat) => useAiChatsStore.getState().saveSession(chat.nodeId, toSession(chat));

  const ask = (question: string) => {
    const q = question.trim();
    if (!q || busy || !node || !config?.configured || source === undefined || pendingLoading) return;
    const ready = pending.filter((p) => p.status === "ready");
    const now = new Date().toISOString();
    const turn: Turn = {
      question: q,
      answer: "",
      status: "streaming",
      at: now,
      ...(attachedContext ? { context: attachedContext } : {}),
      ...(ready.length ? { attachments: ready.map((p) => ({ kind: p.item.kind, label: p.label })) } : {}),
    };
    const previous = activeRef.current && activeRef.current.turns.length > 0 ? activeRef.current : null;
    const chat: ActiveChat = previous
      ? { ...previous, context: previous.context || freshContext, model: config.model || previous.model, turns: [...previous.turns, turn] }
      : { nodeId: node.id, id: newSessionId(), title: q.slice(0, 200), context: freshContext, createdAt: now, model: config.model || undefined, turns: [turn] };
    const index = chat.turns.length - 1;
    activeRef.current = chat;
    setActiveId(chat.id);
    setTurns(chat.turns);
    setDraft("");
    setMention(null);
    setPending([]);
    persist(chat);

    const controller = new AbortController();
    abortRef.current = controller;
    const patch = (p: Partial<Turn> | ((turn: Turn) => Partial<Turn>)) => {
      chat.turns = chat.turns.map((turn, i) => (i === index ? { ...turn, ...(typeof p === "function" ? p(turn) : p) } : turn));
      if (activeRef.current?.id === chat.id) {
        activeRef.current = chat;
        setTurns(chat.turns);
      }
    };
    streamAiChat(
      accessToken,
      { system, messages: toMessages(chat.context, chat.turns) },
      (delta) => patch((turn) => ({ answer: turn.answer + delta })),
      controller.signal,
    )
      .then((done) => patch({ status: "done", stopReason: done.stopReason, servedBy: done.servedBy }))
      .catch((err: unknown) => {
        if (controller.signal.aborted) patch({ status: "stopped" });
        else patch({ status: "error", error: err instanceof Error ? err.message : String(err) });
      })
      .finally(() => persist(chat));
  };

  const newChat = () => {
    showChat(null);
    setHistoryOpen(false);
    setSourceMode("excerpt");
  };

  const openSession = (session: ChatSession) => {
    setHistoryOpen(false);
    if (!node || session.id === activeRef.current?.id) return;
    showChat({ nodeId: node.id, ...session, turns: session.turns.map((turn) => (turn.status === "streaming" ? { ...turn, status: "stopped" } : turn)) }, true);
  };

  const deleteSession = (session: ChatSession) => {
    if (!node) return;
    useAiChatsStore.getState().deleteSession(node.id, session.id);
    if (session.id === activeRef.current?.id) showChat(null);
  };

  const saveToNotes = (answer: string) => {
    if (!node) return;
    const store = useAnnotationsStore.getState();
    const current = store.annotations[node.id]?.note ?? "";
    const heading = fmt(a.noteHeading, { date: new Date().toLocaleString() });
    store.setNote(node.id, `${current.trim() ? `${current.trimEnd()}\n\n` : ""}### ${heading}\n\n${answer.trim()}`);
  };

  const fullPrompt = (question: string) =>
    [system, "---", chatContext, attachedContext, `# Question\n${question.trim() || a.quickExplain}`]
      .filter((part) => part.trim())
      .join("\n\n");

  // `@` mentions: suggestions for the text typed after the `@`.
  const mentionSuggestions = useMemo<ContextSuggestion[]>(
    () =>
      mention && graph
        ? suggestContextItems(graph, node ?? null, mention.query, { exclude: new Set(pending.map((p) => p.key)) })
        : [],
    [mention, graph, node, pending],
  );

  const onDraftChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setDraft(e.target.value);
    const next = mentionAt(e.target.value, e.target.selectionStart ?? e.target.value.length);
    setMention(next);
    if (next?.query !== mention?.query) setMentionIndex(0);
  };

  const pickMention = (s: ContextSuggestion) => {
    if (!mention) return;
    const end = mention.start + 1 + mention.query.length;
    const replacement = s.item.kind === "search" ? `"${s.item.query}" ` : `@${s.label} `;
    const next = `${draft.slice(0, mention.start)}${replacement}${draft.slice(end)}`;
    setDraft(next);
    setMention(null);
    attach(s.item);
    caretRef.current = mention.start + replacement.length;
  };

  // Put the caret after an inserted mention once React has written the new value.
  useLayoutEffect(() => {
    if (caretRef.current === null) return;
    inputRef.current?.setSelectionRange(caretRef.current, caretRef.current);
    caretRef.current = null;
  }, [draft]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (mention) {
      const handled = handleSuggestionKey(
        e,
        mentionSuggestions.length,
        mentionIndex,
        setMentionIndex,
        (i) => mentionSuggestions[i] && pickMention(mentionSuggestions[i]),
        () => setMention(null),
      );
      if (handled) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      ask(draft);
    }
  };

  if (!dialog) return null;
  const quickPrompts = [a.quickExplain, a.quickUsage, a.quickRisks, a.quickTests];
  const modelLabel = config?.model || "AI";
  const historyAvailable = !!node && !showSettings && config !== undefined;
  const sendDisabled = source === undefined || pendingLoading;

  const contextBar =
    graph && node ? (
      <AiContextBar
        graph={graph}
        node={node}
        sourceMode={started ? undefined : sourceMode}
        onSourceModeChange={setSourceMode}
        baseContextChars={started ? 0 : chatContext.length}
        pending={pending}
        onAdd={attach}
        onRemove={(key) => setPending((list) => list.filter((p) => p.key !== key))}
      />
    ) : null;

  const transcript = turns.map((turn, i) => (
    <div key={i} className="space-y-2">
      <div className="flex flex-col items-end gap-1">
        <div className="max-w-[85%] rounded-lg bg-accent/10 border border-accent/20 px-3 py-2 text-sm text-text-primary whitespace-pre-wrap">
          {turn.question}
        </div>
        {turn.attachments?.length ? (
          <div className="flex flex-wrap justify-end gap-1 max-w-[85%]">
            {turn.attachments.map((att, j) => (
              <span key={j} className="text-[10px] font-mono text-text-muted border border-border-subtle rounded px-1.5 py-0.5 truncate max-w-[240px]">
                {att.label}
              </span>
            ))}
          </div>
        ) : null}
      </div>
      <div className="text-sm text-text-secondary leading-relaxed" data-testid="ai-answer">
        {turn.answer ? (
          <MarkdownContent content={turn.answer} />
        ) : (
          turn.status === "streaming" && <span className="text-text-muted animate-pulse">{a.thinking}</span>
        )}
      </div>
      {turn.status === "error" && <p className="text-xs text-red-400">{turn.error}</p>}
      {turn.status === "stopped" && <p className="text-xs text-text-muted">{a.stopped}</p>}
      {turn.stopReason === "max_tokens" || turn.stopReason === "length" ? (
        <p className="text-xs text-amber-400">{a.truncated}</p>
      ) : null}
      {turn.status !== "streaming" && turn.answer && (
        <div className="flex items-center gap-2">
          <FlashButton
            label={a.copy}
            doneLabel={a.copied}
            onClick={() => void navigator.clipboard?.writeText(turn.answer)}
          />
          <FlashButton
            label={a.saveToNotes}
            doneLabel={a.savedToNotes}
            onClick={() => saveToNotes(turn.answer)}
            testId="ai-save-note"
          />
          {turn.servedBy && turn.servedBy !== config?.model && (
            <span className="text-[10px] font-mono text-text-muted">{fmt(a.servedBy, { model: turn.servedBy })}</span>
          )}
        </div>
      )}
    </div>
  ));

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      onMouseDown={closeAiDialog}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={a.ask}
        data-testid="ask-ai-dialog"
        className="w-full max-w-[780px] h-[min(820px,calc(100vh-32px))] flex flex-col rounded-xl border border-border-medium bg-surface shadow-2xl overflow-hidden"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            closeAiDialog();
          }
        }}
      >
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border-subtle shrink-0">
          <span className="text-accent text-sm">✦</span>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-heading text-text-primary truncate">
              {node ? `${a.ask} · ${node.name}` : a.settings}
            </div>
            {node?.filePath && <div className="text-[11px] font-mono text-text-muted truncate">{node.filePath}</div>}
          </div>
          {config?.configured && node && (
            <span className="hidden sm:inline text-[10px] font-mono text-text-muted border border-border-subtle rounded px-1.5 py-0.5 max-w-[180px] truncate">
              {modelLabel}
            </span>
          )}
          {historyAvailable && (savedCount > 0 || historyOpen) && (
            <SmallButton onClick={() => setHistoryOpen(!historyOpen)} testId="ai-history-toggle">
              {historyOpen ? a.backToChat : `${a.history} · ${savedCount}`}
            </SmallButton>
          )}
          {(turns.length > 0 || historyOpen) && !showSettings && (
            <SmallButton onClick={newChat} testId="ai-new-chat">{a.newChat}</SmallButton>
          )}
          {config && node && (
            <button
              type="button"
              onClick={() => setView(view === "chat" ? "settings" : "chat")}
              title={a.settings}
              aria-label={a.settings}
              data-testid="ai-settings-toggle"
              className={`p-1 rounded hover:bg-elevated ${showSettings ? "text-accent" : "text-text-muted hover:text-text-primary"}`}
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.3 4.3c.4-1.7 3-1.7 3.4 0a1.7 1.7 0 002.6 1.1c1.5-.9 3.3.8 2.4 2.4a1.7 1.7 0 001 2.5c1.8.4 1.8 3 0 3.4a1.7 1.7 0 00-1 2.6c.9 1.5-.9 3.3-2.4 2.4a1.7 1.7 0 00-2.6 1c-.4 1.8-3 1.8-3.4 0a1.7 1.7 0 00-2.5-1c-1.6.9-3.3-.9-2.4-2.4a1.7 1.7 0 00-1.1-2.6c-1.7-.4-1.7-3 0-3.4a1.7 1.7 0 001.1-2.5c-.9-1.6.8-3.3 2.4-2.4 1 .6 2.3.1 2.5-1.1z" />
                <circle cx="12" cy="12" r="3" strokeWidth={2} />
              </svg>
            </button>
          )}
          <button
            type="button"
            onClick={closeAiDialog}
            title={a.close}
            aria-label={a.close}
            className="p-1 rounded text-text-muted hover:text-text-primary hover:bg-elevated"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {config === undefined && (
          <div className="flex-1 flex items-center justify-center text-sm text-text-muted">{a.loadingConfig}</div>
        )}

        {historyOpen && historyAvailable && (
          <AiChatHistory
            sessions={savedSessions}
            activeId={activeId}
            storageLocal={chatsLocal}
            onOpen={openSession}
            onDelete={deleteSession}
          />
        )}

        {config === null && !historyOpen && (
          <div className="flex-1 overflow-auto p-5 space-y-4">
            {turns.length > 0 && <div className="space-y-5 pb-4 border-b border-border-subtle">{transcript}</div>}
            <p className="text-sm text-text-secondary leading-relaxed">{a.noBackend}</p>
            {node && (
              <>
                {contextBar}
                <textarea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  placeholder={a.quickExplain}
                  rows={3}
                  className="w-full bg-elevated border border-border-subtle rounded-lg px-3 py-2 text-sm text-text-primary placeholder-text-muted focus:outline-none focus:border-accent/50 resize-none"
                />
                <FlashButton
                  label={a.copyPrompt}
                  doneLabel={a.copied}
                  onClick={() => void navigator.clipboard?.writeText(fullPrompt(draft))}
                />
              </>
            )}
          </div>
        )}

        {showSettings && config && (
          <div className="flex-1 overflow-auto p-5">
            {!config.configured && <p className="text-sm text-text-secondary mb-4">{a.notConfigured}</p>}
            <AiSettingsForm
              accessToken={accessToken}
              config={config}
              expandEmbeddings={view === "embeddings"}
              onSaved={(saved) => {
                setConfig(saved);
                if (saved.configured && node) setView("chat");
              }}
              onCancel={config.configured && node ? () => setView("chat") : undefined}
            />
          </div>
        )}

        {config && !showSettings && node && !historyOpen && (
          <>
            <div ref={scrollRef} className="flex-1 overflow-auto px-5 py-4 space-y-5" data-testid="ai-transcript">
              {turns.length === 0 && (
                <div className="space-y-3">
                  <p className="text-[11px] text-text-muted">{fmt(a.contextNote, { model: modelLabel })}</p>
                  <p className="text-[11px] text-text-muted">{a.contextHint}</p>
                  <div className="flex flex-wrap gap-2">
                    {quickPrompts.map((prompt) => (
                      <button
                        key={prompt}
                        type="button"
                        onClick={() => ask(prompt)}
                        disabled={sendDisabled}
                        className="text-xs text-left px-3 py-1.5 rounded-lg border border-border-subtle bg-elevated/60 text-text-secondary hover:text-accent hover:border-accent/40 transition-colors"
                      >
                        {prompt}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {turns.length > 0 && resumedFrom && (
                <p className="text-[11px] text-text-muted" data-testid="ai-resumed">
                  {fmt(a.resumedChat, { date: new Date(resumedFrom).toLocaleString() })}
                </p>
              )}
              {transcript}
            </div>
            <div className="border-t border-border-subtle p-3 shrink-0">
              {contextBar}
              <div className="relative flex items-end gap-2">
                {mention && (
                  <div className="absolute bottom-full left-0 mb-1 w-[min(460px,100%)] rounded-lg border border-border-medium bg-surface shadow-2xl z-10">
                    <SuggestionList
                      suggestions={mentionSuggestions}
                      activeIndex={mentionIndex}
                      onPick={pickMention}
                      onHover={setMentionIndex}
                    />
                  </div>
                )}
                <textarea
                  ref={inputRef}
                  value={draft}
                  onChange={onDraftChange}
                  onKeyDown={onKeyDown}
                  onBlur={() => setMention(null)}
                  placeholder={a.placeholder}
                  rows={2}
                  data-testid="ai-input"
                  className="flex-1 bg-elevated border border-border-subtle rounded-lg px-3 py-2 text-sm text-text-primary placeholder-text-muted focus:outline-none focus:border-accent/50 resize-none"
                />
                {busy ? (
                  <button
                    type="button"
                    onClick={() => abortRef.current?.abort()}
                    className="px-3 py-2 rounded-lg text-xs font-semibold border border-border-medium text-text-secondary hover:text-text-primary"
                  >
                    {a.stop}
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => ask(draft)}
                    disabled={!draft.trim() || sendDisabled}
                    data-testid="ai-send"
                    className="px-3 py-2 rounded-lg text-xs font-semibold bg-accent/20 text-accent border border-accent/40 hover:bg-accent/30 disabled:opacity-40"
                  >
                    {a.send}
                  </button>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
