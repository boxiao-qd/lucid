import { useEffect, useLayoutEffect, useRef, useState, useCallback } from "react";
import { useParams } from "react-router-dom";
import { useMessageStore } from "@/store/message-store";
import { useSessionStore } from "@/store/session-store";
import { useSSEStore } from "@/store/sse-store";
import { useUIStore } from "@/store/ui-store";
import { SSEManager } from "@/services/sse-manager";
import { apiGet } from "@/services/api-client";
import { ChatInputSection } from "@/components/section/ChatInputSection";
import { MessageFlow } from "@/components/section/MessageFlow";
import type { MessageItem } from "@/types/api-types";

export function ChatSessionPage() {
  const { sessionId } = useParams<{ sessionId: string }>();

  // Individual selectors — only subscribe to fields used in the render tree
  const messages = useMessageStore((s) => s.messages);
  const streamingDelta = useMessageStore((s) => s.streamingDelta);
  const streamingMessageId = useMessageStore((s) => s.streamingMessageId);
  const userAckMessage = useMessageStore((s) => s.userAckMessage);
  const thinkingBlocks = useMessageStore((s) => s.thinkingBlocks);
  const toolCallBlocks = useMessageStore((s) => s.toolCallBlocks);
  const delegationBlocks = useMessageStore((s) => s.delegationBlocks);
  const compressionEvents = useMessageStore((s) => s.compressionEvents);
  const plan = useMessageStore((s) => s.plan);

  const { activeSessionId } = useSessionStore();
  const { setConnected, pushEvent } = useSSEStore();
  const setAutoScroll = useUIStore((s) => s.setAutoScroll);
  const [loading, setLoading] = useState(true);
  const [hasMore, setHasMore] = useState(false);
  const [beforeCursor, setBeforeCursor] = useState<string | null>(null);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const savedScrollHeightRef = useRef<number | null>(null);
  const loadingMoreRef = useRef(false);
  const sseRef = useRef<SSEManager | null>(null);
  const streamingMessageIdRef = useRef(streamingMessageId);
  useEffect(() => {
    streamingMessageIdRef.current = streamingMessageId;
  }, [streamingMessageId]);

  // Load messages on mount
  useEffect(() => {
    if (!sessionId) return;
    const store = useMessageStore.getState();
    setAutoScroll(true);
    setLoading(true);
    apiGet<{ messages: MessageItem[]; has_more: boolean }>(`/messages/${sessionId}`)
      .then((data) => {
        store.setMessages(sessionId, data.messages);
        setHasMore(data.has_more);
        if (data.has_more && data.messages.length > 0) {
          setBeforeCursor(data.messages[0].id);
        }
        const toolResultsByCallId: Record<string, { result: string; isError: boolean }> = {};
        for (const m of data.messages) {
          if (m.role === "tool" && m.tool_call_id && m.content != null) {
            const isError = m.content.trim().startsWith('{"error"');
            toolResultsByCallId[m.tool_call_id] = { result: m.content, isError };
          }
        }
        const pendingToolCalls: Array<{ id: string; name: string; arguments: string }> = [];
        for (const m of data.messages) {
          if (m.role === "assistant" && m.tool_calls && m.tool_calls.length > 0) {
            pendingToolCalls.push(...m.tool_calls);
          }
          if (m.role === "assistant" && m.content?.trim() && pendingToolCalls.length > 0) {
            store.loadHistoricalToolCalls(m.id, pendingToolCalls.splice(0), toolResultsByCallId);
          }
        }
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [sessionId, setAutoScroll]);

  // Restore scroll position after older messages are prepended
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || savedScrollHeightRef.current === null) return;
    el.scrollTop += el.scrollHeight - savedScrollHeightRef.current;
    savedScrollHeightRef.current = null;
  });

  const loadMoreHistory = useCallback(() => {
    if (!sessionId || !hasMore || loadingMoreRef.current || !beforeCursor) return;
    loadingMoreRef.current = true;
    setIsLoadingMore(true);
    if (scrollRef.current) {
      savedScrollHeightRef.current = scrollRef.current.scrollHeight;
    }
    const store = useMessageStore.getState();
    apiGet<{ messages: MessageItem[]; has_more: boolean }>(`/messages/${sessionId}?before=${beforeCursor}`)
      .then((data) => {
        if (data.messages.length > 0) {
          store.prependMessages(sessionId, data.messages);
          setHasMore(data.has_more);
          setBeforeCursor(data.has_more ? data.messages[0].id : null);
        } else {
          setHasMore(false);
        }
      })
      .catch(() => {
        savedScrollHeightRef.current = null;
      })
      .finally(() => {
        loadingMoreRef.current = false;
        setIsLoadingMore(false);
      });
  }, [sessionId, hasMore, beforeCursor]);

  // Connect SSE — use getState() for store actions to avoid unstable deps
  useEffect(() => {
    if (!sessionId) return;
    const store = useMessageStore.getState();
    store.setStreaming(null);
    store.clearUserAck();
    store.clearPlan();
    setHasMore(false);
    setBeforeCursor(null);

    const manager = new SSEManager(
      sessionId,
      (event) => {
        if (event.session_id !== sessionId) return;
        const s = useMessageStore.getState();
        pushEvent(event);

        if (event.type === "stream_start" && event.data) {
          const d = event.data as { message_id: string };
          s.setStreaming(d.message_id);
          // A new run is starting — clear any lingering task notice
          // ("已加入队列" etc.) so it doesn't outlive the queue state.
          s.clearTaskNotice();
        }
        if (event.type === "user_ack" && event.data) {
          const d = event.data as { message_id: string; message: string };
          s.setUserAck(d.message);
        }
        if (event.type === "text_delta" && event.data) {
          const d = event.data as { message_id: string; delta: string };
          if (!streamingMessageIdRef.current) s.setStreaming(d.message_id);
          s.appendDelta(d.delta);
        }
        if (event.type === "thinking_start" && event.data) {
          s.startThinking((event.data as { message_id: string }).message_id);
        }
        if (event.type === "thinking_delta" && event.data) {
          const d = event.data as { message_id: string; delta: string };
          s.appendThinkingDelta(d.message_id, d.delta);
        }
        if (event.type === "thinking_end" && event.data) {
          s.endThinking((event.data as { message_id: string }).message_id);
        }
        if (event.type === "tool_call_start" && event.data) {
          const d = event.data as { tool_call_id: string; tool_name: string };
          s.startToolCall(d.tool_call_id, d.tool_name);
        }
        if (event.type === "tool_call_end" && event.data) {
          const d = event.data as { tool_call_id: string; tool_name: string; args: string };
          s.updateToolCallArgs(d.tool_call_id, d.args);
        }
        if (event.type === "tool_result" && event.data) {
          const d = event.data as { tool_call_id: string; tool_name: string; result: string; is_error: boolean };
          s.setToolResult(d.tool_call_id, d.result, d.is_error);
        }
        if (event.type === "delegation_start" && event.data) {
          const d = event.data as { child_session_id: string; subagent_name: string; goal: string; context?: string };
          s.startDelegation(d.child_session_id, d.subagent_name, d.goal, d.context);
        }
        if (event.type === "delegation_update" && event.data) {
          const d = event.data as { child_session_id: string; status: string; progress_note?: string; elapsed_seconds?: number };
          s.updateDelegation(d.child_session_id, d.status, d.progress_note, d.elapsed_seconds);
        }
        if (event.type === "delegation_end" && event.data) {
          const d = event.data as { child_session_id: string; subagent_name: string; summary: string; is_error: boolean };
          s.endDelegation(d.child_session_id, d.summary, d.is_error);
        }
        if (event.type === "context_compression" && event.data) {
          const d = event.data as { tokens_before: number; tokens_after: number; compressed_count: number; summary_preview: string };
          s.appendCompressionEvent(sessionId!, d);
        }
        // TodoWrite task list events
        if (event.type === "plan_created" && event.data) {
          const d = event.data as { plan_id: string; steps: Array<{ id: string; content: string; status: "pending" | "in_progress" | "completed"; level: number; activeForm?: string }> };
          s.setPlan({ planId: d.plan_id, steps: d.steps, status: "executing" });
        }
        if (event.type === "plan_adjusted" && event.data) {
          const d = event.data as { plan_id: string; steps: Array<{ id: string; content: string; status: "pending" | "in_progress" | "completed"; level: number; activeForm?: string }> };
          s.setPlan({ planId: d.plan_id, steps: d.steps, status: "executing" });
        }
        if (event.type === "plan_step_start" && event.data) {
          const d = event.data as { plan_id: string; step_index: number; activeForm: string };
          s.updatePlanStep(d.step_index, "in_progress");
        }
        if (event.type === "plan_step_complete" && event.data) {
          const d = event.data as { plan_id: string; step_index: number };
          s.updatePlanStep(d.step_index, "completed");
        }
        if (event.type === "plan_complete") {
          const currentPlan = useMessageStore.getState().plan;
          if (currentPlan) {
            s.setPlan({ ...currentPlan, status: "completed" });
          }
        }
        // Task lifecycle (cancel / queue / steer) — show transient notice
        if (event.type === "task_queued" && event.data) {
          const d = event.data as { queue_depth: number; mode: string };
          const modeLabel: Record<string, string> = {
            followup: "排队等待",
            steer: "信息补充",
            collect: "收集",
            interrupt: "中断",
          };
          const label = modeLabel[d.mode] || d.mode;
          s.setTaskNotice(`已加入队列（第 ${d.queue_depth} 位，${label}），将在当前任务后执行`);
          window.setTimeout(() => s.clearTaskNotice(), 3000);
        }
        if (event.type === "task_steered" && event.data) {
          const d = event.data as { run_id: string; content_preview: string };
          s.setTaskNotice("信息补充已提交，agent 将结合此信息继续");
          window.setTimeout(() => s.clearTaskNotice(), 3000);
        }
        if (event.type === "task_cancelled" && event.data) {
          const d = event.data as { run_id: string; reason: string };
          s.setTaskNotice(`任务已取消（原因：${d.reason}）`);
          window.setTimeout(() => s.clearTaskNotice(), 3000);
        }
        if (event.type === "tool_confirm_request" && event.data) {
          const d = event.data as {
            confirmation_id: string;
            tool_name: string;
            content: string;
            tool_call_id: string;
          };
          s.setPendingConfirmation(d);
        }
        if (event.type === "message_done") {
          const d = event.data as {
            message_id: string;
            streaming_message_id?: string;
            content?: string;
            role: string;
            token_count: number;
          };
          if (d.role === "assistant") {
            const state = useMessageStore.getState();
            const delta = state.streamingDelta;
            const sId = d.streaming_message_id || d.message_id;
            const thinkingBlock = state.thinkingBlocks[sId];
            s.collapseThinking(d.message_id);
            s.collapseThinking(sId);
            s.rekeyMessageBlocks(sId, d.message_id);
            s.appendMessage(sessionId!, {
              id: d.message_id,
              session_id: sessionId!,
              role: "assistant",
              content: delta || d.content || "",
              reasoning_content: thinkingBlock?.content || undefined,
              token_count: d.token_count,
              is_compressed: false,
              created_at: new Date().toISOString(),
            });
          } else if (d.role === "user" && d.content) {
            // A user message was saved by the backend. For normal sends the
            // frontend already has a temp message with the same content as
            // the last message in the list — skip to avoid duplicates. For
            // queued-then-drained tasks there is no temp message, so this is
            // the moment to display it (the last message is the assistant's
            // final reply from the previous task).
            const existing = useMessageStore.getState().messages[sessionId!] || [];
            const last = existing[existing.length - 1];
            const isDup = !!last && last.role === "user" && last.content === d.content;
            if (!isDup) {
              s.appendMessage(sessionId!, {
                id: d.message_id,
                session_id: sessionId!,
                role: "user",
                content: d.content,
                token_count: d.token_count,
                is_compressed: false,
                created_at: new Date().toISOString(),
              });
            }
          }
          s.setStreaming(null);
          s.clearUserAck();
        }
      },
      () => setConnected(true),
      () => setConnected(false),
    );
    sseRef.current = manager;
    manager.connect();
    return () => {
      manager.disconnect();
      sseRef.current = null;
    };
  }, [sessionId, pushEvent, setConnected]);

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center">
          <div className="w-2 h-2 rounded-full bg-[var(--color-primary)] animate-pulse-cyan mx-auto" />
          <p className="text-[var(--color-text-tertiary)] font-mono text-xs mt-3">LOADING</p>
        </div>
      </div>
    );
  }

  const sessionMessages = messages[sessionId!] || [];

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <MessageFlow
        messages={sessionMessages}
        streamingDelta={streamingDelta}
        streamingMessageId={streamingMessageId}
        userAckMessage={userAckMessage}
        thinkingBlocks={thinkingBlocks}
        toolCallBlocks={toolCallBlocks}
        delegationBlocks={delegationBlocks}
        compressionEvents={compressionEvents[sessionId!] || []}
        plan={plan}
        sessionId={sessionId!}
        isLoadingMore={isLoadingMore}
        onScrollNearTop={hasMore ? loadMoreHistory : undefined}
        scrollRef={scrollRef}
      />
      <ChatInputSection sessionId={sessionId!} />
    </div>
  );
}