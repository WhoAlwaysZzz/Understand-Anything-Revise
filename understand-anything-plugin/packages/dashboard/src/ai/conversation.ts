import type { ChatMessage } from "./aiClient";

/** What the user attached to a question, as shown under it. */
export interface TurnAttachment {
  kind: string;
  label: string;
}

export interface Turn {
  question: string;
  answer: string;
  status: "streaming" | "done" | "stopped" | "error";
  error?: string;
  stopReason?: string | null;
  servedBy?: string;
  /** Extra code context (attached files, nodes, search hits) sent with this question. */
  context?: string;
  attachments?: TurnAttachment[];
  /** When the question was asked (ISO). */
  at?: string;
}

/**
 * Provider messages for a conversation: turns without an answer (failed) are
 * dropped so roles keep alternating, the node context rides on the first
 * question that is sent, and each question carries the context attached to it.
 */
export function toMessages(context: string, turns: Turn[]): ChatMessage[] {
  const last = turns.length - 1;
  const kept = turns.filter((turn, i) => i === last || (turn.status !== "streaming" && turn.answer));
  return kept.flatMap((turn, i) => {
    const blocks = [i === 0 ? context : "", turn.context ?? ""].filter((block) => block.trim());
    const question: ChatMessage = {
      role: "user",
      content: blocks.length ? `${blocks.join("\n\n")}\n\n# Question\n${turn.question}` : turn.question,
    };
    return i === kept.length - 1 ? [question] : [question, { role: "assistant" as const, content: turn.answer }];
  });
}
