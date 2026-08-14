import { useEffect, useMemo, useRef } from "react";
import type React from "react";
import { MessageBubble } from "@/components/base/MessageBubble";
import { ThinkingBlock } from "@/components/base/ThinkingBlock";
import { ToolCallBlock } from "@/components/base/ToolCallBlock";
import { DelegationProgress } from "@/components/base/DelegationProgress";
import { CompressionBubble } from "@/components/base/CompressionBubble";
import { PlanCard } from "@/components/base/PlanCard";
import { ToolConfirmPanel } from "@/components/base/ToolConfirmPanel";
import type { MessageItem } from "@/types/api-types";
import type { ThinkingBlockState, ToolCallBlockState, DelegationBlockState, ContextCompressionData, PlanState } from "@/store/message-store";
import { useMessageStore } from "@/store/message-store";
import { useAutoScroll } from "@/hooks/useAutoScroll";

interface MessageFlowProps {
  messages: MessageItem[];
  streamingDelta: string;
  streamingMessageId: string | null;
  userAckMessage: string | null;
  thinkingBlocks: Record<string, ThinkingBlockState>;
  toolCallBlocks: Record<string, ToolCallBlockState>;
  delegationBlocks: Record<string, DelegationBlockState>;
  compressionEvents: ContextCompressionData[];
  plan: PlanState | null;
  sessionId: string;
  isLoadingMore?: boolean;
  onScrollNearTop?: () => void;
  scrollRef?: React.RefObject<HTMLDivElement | null>;
}

export function MessageFlow({
  messages,
  streamingDelta,
  streamingMessageId,
  userAckMessage,
  thinkingBlocks,
  toolCallBlocks,
  delegationBlocks,
  compressionEvents,
  plan,
  sessionId,
  isLoadingMore,
  onScrollNearTop,
  scrollRef: externalScrollRef,
}: MessageFlowProps) {
  const toggleThinking = useMessageStore((s) => s.toggleThinking);
  const toggleToolCall = useMessageStore((s) => s.toggleToolCall);
  const toolCallIdsByMessage = useMessageStore((s) => s.toolCallIdsByMessage);
  const { autoScroll, scrollRef, handleScroll, scrollToBottom } = useAutoScroll({
    onNearTop: onScrollNearTop,
    scrollRef: externalScrollRef,
  });
  const bottomRef = useRef<HTMLDivElement | null>(null);

  // Hide internal messages: tool execution results and empty intermediate assistant calls
  // Keep system messages that are compression summaries (identified by prefix)
  const visibleMessages = useMemo(() => messages.filter((msg) => {
    if (msg.role === "tool") return false;
    if (msg.role === "assistant" && !msg.content?.trim() && !msg.reasoning_content) return false;
    return true;
  }), [messages]);

  // Auto-scroll to bottom when history loads or streaming updates
  useEffect(() => {
    if (autoScroll) {
      scrollToBottom();
    }
  }, [visibleMessages.length, streamingDelta, autoScroll, scrollToBottom]);

  return (
    <div
      ref={scrollRef}
      onScroll={handleScroll}
      className="flex-1 overflow-y-auto p-4 space-y-4"
      role="log"
      aria-label="对话消息流"
      aria-live="polite"
    >
      {visibleMessages.length === 0 && !streamingMessageId && (
        <div className="text-center py-16">
          <div className="text-[var(--color-text-tertiary)] font-mono text-xs tracking-widest">
            AWAITING INPUT
          </div>
          <div className="mt-3 w-16 h-px mx-auto bg-[var(--color-border)]" />
          <div className="mt-4 text-[var(--color-primary)] opacity-40 font-mono text-xs">
            super-agent ready
          </div>
        </div>
      )}
      {/* ── Load-more spinner (scroll-up pagination) ───────────────── */}
      {isLoadingMore && (
        <div className="flex justify-center py-2" aria-label="加载更多消息">
          <div className="flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-primary)] animate-bounce" style={{ animationDelay: "0ms" }} />
            <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-primary)] animate-bounce" style={{ animationDelay: "150ms" }} />
            <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-primary)] animate-bounce" style={{ animationDelay: "300ms" }} />
          </div>
        </div>
      )}
      {visibleMessages.map((msg) => {
        // History path: render compression system messages as CompressionBubble
        if (msg.role === "system" && msg.content?.startsWith("[Compressed context]:")) {
          const summary = msg.content.slice("[Compressed context]:".length).trim();
          return (
            <CompressionBubble
              key={msg.id}
              summaryPreview={summary}
            />
          );
        }

        const msgThinkingBlock = thinkingBlocks[msg.id];
        // Show tool call blocks for both streaming and persisted assistant messages
        const msgToolCallIds = toolCallIdsByMessage[msg.id] || [];
        const msgToolCallBlocks = msgToolCallIds.length > 0
          ? msgToolCallIds.map((id) => toolCallBlocks[id]).filter(Boolean)
          : undefined;

        return (
          <MessageBubble
            key={msg.id}
            message={msg}
            thinkingBlock={msgThinkingBlock}
            toolCallBlocks={msgToolCallBlocks}
          />
        );
      })}
      {/* ── Plan card: anchored below conversation, above active streaming ── */}
      {plan && <PlanCard plan={plan} />}
      {/* ── Live compression events (SSE path, not yet persisted as messages) ── */}
      {compressionEvents.map((ev, idx) => (
        <CompressionBubble
          key={`compression-live-${idx}`}
          tokensBefore={ev.tokens_before}
          tokensAfter={ev.tokens_after}
          compressedCount={ev.compressed_count}
          summaryPreview={ev.summary_preview}
        />
      ))}
      {/* ── Streaming delta bubble ───────────────────────────────────── */}
      {streamingMessageId && streamingDelta && (
        <div className="flex justify-start" role="status" aria-live="assertive">
          <div className="rounded-lg glass glow-primary px-4 py-3 max-w-[85%] text-sm md-content">
            {streamingDelta}
            <span className="animate-blink text-[var(--color-primary)] ml-0.5">█</span>
          </div>
        </div>
      )}
      {/* ── User acknowledgement ──────────────────────────────────── */}
      {streamingMessageId && userAckMessage && (
        <div className="flex justify-start" role="status" aria-live="polite">
          <div className="rounded-lg glass px-4 py-2.5 max-w-[85%] text-sm
                          border border-[var(--color-primary)]/20 text-[var(--color-text-secondary)]
                          flex items-center gap-2">
            <svg className="w-4 h-4 text-[var(--color-primary)] shrink-0" viewBox="0 0 16 16" fill="none">
              <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.2" />
              <path d="M5 8l2 2 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <span className="font-mono text-xs">{userAckMessage}</span>
          </div>
        </div>
      )}
      {/* ── Tool confirmation panel (terminal / code_execute) ────── */}
      <ToolConfirmPanel sessionId={sessionId} />
      {/* ── Loading indicator: streaming started but no content yet ─── */}
      {streamingMessageId && !streamingDelta && !thinkingBlocks[streamingMessageId] && !visibleMessages.find((m) => m.id === streamingMessageId) && (
        <div className="flex justify-start" role="status" aria-live="polite">
          <div className="rounded-lg glass px-4 py-3 flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-primary)] animate-bounce" style={{ animationDelay: "0ms" }} />
            <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-primary)] animate-bounce" style={{ animationDelay: "150ms" }} />
            <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-primary)] animate-bounce" style={{ animationDelay: "300ms" }} />
          </div>
        </div>
      )}
      {/* ── Streaming thinking blocks (unassigned) ───────────────────── */}
      {streamingMessageId && thinkingBlocks[streamingMessageId] && !visibleMessages.find((m) => m.id === streamingMessageId) && (
        <ThinkingBlock
          messageId={streamingMessageId}
          phase={thinkingBlocks[streamingMessageId].phase}
          content={thinkingBlocks[streamingMessageId].content}
          onToggle={() => toggleThinking(streamingMessageId)}
        />
      )}
      {/* ── Streaming tool call blocks (only current message's calls) ─── */}
      {streamingMessageId && !visibleMessages.find((m) => m.id === streamingMessageId) && (toolCallIdsByMessage[streamingMessageId] || []).length > 0 && (
        <div className="space-y-1">
          {(toolCallIdsByMessage[streamingMessageId] || []).map((id) => {
            const block = toolCallBlocks[id];
            if (!block) return null;
            return (
              <ToolCallBlock
                key={block.toolCallId}
                toolCallId={block.toolCallId}
                toolName={block.toolName}
                phase={block.phase}
                args={block.args}
                result={block.result}
                isError={block.isError}
                onToggle={() => toggleToolCall(block.toolCallId)}
              />
            );
          })}
        </div>
      )}
      {/* ── Delegation blocks (only those linked to current session's messages) ── */}
      {streamingMessageId && Object.values(delegationBlocks).filter(b => b.status === "running").length > 0 && (
        <div className="space-y-1">
          {Object.values(delegationBlocks).filter(b => b.status === "running").map((block) => (
            <DelegationProgress
              key={block.childSessionId}
              childSessionId={block.childSessionId}
              subagentName={block.subagentName}
              goal={block.goal}
              status={block.status}
              progressNote={block.progressNote}
              elapsedSeconds={block.elapsedSeconds}
              summary={block.summary}
              isError={block.isError}
            />
          ))}
        </div>
      )}
      {/* ── Bottom sentinel for auto-scroll ───────────────────────── */}
      <div ref={bottomRef} aria-hidden="true" />
    </div>
  );
}