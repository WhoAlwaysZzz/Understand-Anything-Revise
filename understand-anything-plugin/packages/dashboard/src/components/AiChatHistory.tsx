import { useI18n } from "../contexts/I18nContext";
import { fmt } from "../locales";
import type { ChatSession } from "../aiChatsStore";

/** The node's saved Ask AI chats, newest first. */
export default function AiChatHistory({
  sessions,
  activeId,
  storageLocal,
  onOpen,
  onDelete,
}: {
  sessions: ChatSession[] | undefined;
  activeId: string | null;
  storageLocal: boolean;
  onOpen: (session: ChatSession) => void;
  onDelete: (session: ChatSession) => void;
}) {
  const { t } = useI18n();
  const a = t.ai;
  return (
    <div className="flex-1 overflow-auto px-5 py-4" data-testid="ai-history">
      <div className="text-[11px] uppercase tracking-wider text-text-muted mb-3">{a.historyTitle}</div>
      {sessions === undefined && <p className="text-sm text-text-muted">{a.loadingConfig}</p>}
      {sessions?.length === 0 && <p className="text-sm text-text-muted">{a.historyEmpty}</p>}
      <ul className="space-y-2">
        {sessions?.map((s) => (
          <li
            key={s.id}
            className={`group flex items-start gap-2 rounded-lg border px-3 py-2 ${
              s.id === activeId ? "border-accent/40 bg-accent/5" : "border-border-subtle hover:border-border-medium"
            }`}
          >
            <button type="button" onClick={() => onOpen(s)} className="min-w-0 flex-1 text-left" data-testid="ai-history-item">
              <div className="text-sm text-text-primary truncate">{s.title}</div>
              <div className="text-[11px] text-text-muted truncate">
                {new Date(s.updatedAt).toLocaleString()} · {fmt(a.turnsCount, { count: s.turns.length })}
                {s.model ? ` · ${s.model}` : ""}
              </div>
            </button>
            <button
              type="button"
              onClick={() => {
                if (window.confirm(a.deleteChatConfirm)) onDelete(s);
              }}
              title={a.deleteChat}
              aria-label={a.deleteChat}
              className="p-1 rounded text-text-muted opacity-60 group-hover:opacity-100 hover:text-red-400"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 7h12M9 7V4h6v3m-8 0l1 13h8l1-13" />
              </svg>
            </button>
          </li>
        ))}
      </ul>
      {storageLocal && sessions && sessions.length > 0 && <p className="mt-3 text-[11px] text-text-muted">{a.savedLocally}</p>}
    </div>
  );
}
