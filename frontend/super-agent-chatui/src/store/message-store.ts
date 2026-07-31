import { create } from "zustand";
import type { MessageItem } from "@/types/api-types";
import type { ContextCompressionData } from "@/types/sse-events";

export interface ThinkingBlockState {
  messageId: string;
  phase: "streaming" | "collapsed" | "expanded";
  content: string;
}

export interface ToolCallBlockState {
  toolCallId: string;
  toolName: string;
  phase: "loading" | "completed_collapsed" | "completed_expanded" | "error";
  args?: string;
  result?: string;
  isError?: boolean;
}

export interface DelegationBlockState {
  childSessionId: string;
  subagentName: string;
  goal: string;
  status: "running" | "completed" | "failed";
  progressNote?: string;
  elapsedSeconds?: number;
  summary?: string;
  isError?: boolean;
}

export { type ContextCompressionData };

export interface PlanStepState {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed";
  level: number;
  activeForm?: string;
}

export interface PlanState {
  planId: string;
  steps: PlanStepState[];
  status: "executing" | "completed";
}

interface MessageState {
  messages: Record<string, MessageItem[]>;
  streamingMessageId: string | null;
  streamingDelta: string;
  userAckMessage: string | null;
  taskNotice: string | null;
  thinkingBlocks: Record<string, ThinkingBlockState>;
  toolCallBlocks: Record<string, ToolCallBlockState>;
  delegationBlocks: Record<string, DelegationBlockState>;
  compressionEvents: Record<string, ContextCompressionData[]>;
  toolCallIdsByMessage: Record<string, string[]>;
  plan: PlanState | null;
  setMessages: (sessionId: string, messages: MessageItem[]) => void;
  appendMessage: (sessionId: string, message: MessageItem) => void;
  setStreaming: (messageId: string | null) => void;
  appendDelta: (delta: string) => void;
  resetDelta: () => void;
  setUserAck: (message: string) => void;
  clearUserAck: () => void;
  setTaskNotice: (message: string) => void;
  clearTaskNotice: () => void;
  startThinking: (messageId: string) => void;
  appendThinkingDelta: (messageId: string, delta: string) => void;
  endThinking: (messageId: string) => void;
  collapseThinking: (messageId: string) => void;
  toggleThinking: (messageId: string) => void;
  startToolCall: (toolCallId: string, toolName: string) => void;
  updateToolCallArgs: (toolCallId: string, args: string) => void;
  setToolResult: (toolCallId: string, result: string, isError: boolean) => void;
  toggleToolCall: (toolCallId: string) => void;
  startDelegation: (childSessionId: string, subagentName: string, goal: string, context?: string) => void;
  updateDelegation: (childSessionId: string, status: string, progressNote?: string, elapsedSeconds?: number) => void;
  endDelegation: (childSessionId: string, summary: string, isError: boolean) => void;
  appendCompressionEvent: (sessionId: string, data: ContextCompressionData) => void;
  // Re-key streaming blocks from temporary assistant_id to the final DB message id
  rekeyMessageBlocks: (streamingId: string, finalId: string) => void;
  // Restore tool call blocks from loaded history (bypasses streamingMessageId association)
  loadHistoricalToolCalls: (messageId: string, toolCalls: Array<{ id: string; name: string; arguments: string }>, toolResults: Record<string, { result: string; isError: boolean }>) => void;
  // Prepend older messages (scroll-up history pagination) — preserves current messages
  prependMessages: (sessionId: string, messages: MessageItem[]) => void;
  // Plan-execute-observe-review-adjust cycle
  setPlan: (plan: PlanState | ((prev: PlanState | null) => PlanState | null)) => void;
  updatePlanStep: (stepIndex: number, status: "pending" | "in_progress" | "completed") => void;
  clearPlan: () => void;
}

export const useMessageStore = create<MessageState>((set, get) => ({
  messages: {},
  streamingMessageId: null,
  streamingDelta: "",
  userAckMessage: null,
  taskNotice: null,
  thinkingBlocks: {},
  toolCallBlocks: {},
  delegationBlocks: {},
  compressionEvents: {},
  toolCallIdsByMessage: {},
  plan: null,
  setMessages: (sessionId, messages) =>
    set((s) => ({ messages: { ...s.messages, [sessionId]: messages } })),
  appendMessage: (sessionId, message) =>
    set((s) => ({
      messages: {
        ...s.messages,
        [sessionId]: [...(s.messages[sessionId] || []), message],
      },
    })),
  setStreaming: (messageId) =>
    set((s) => {
      if (messageId === null) {
        // Streaming ended — clean up all streaming state to prevent cross-session leaks
        const oldStreamingId = s.streamingMessageId;
        const cleanedThinkingBlocks = { ...s.thinkingBlocks };
        const cleanedToolCallIdsByMessage = { ...s.toolCallIdsByMessage };
        if (oldStreamingId) {
          delete cleanedThinkingBlocks[oldStreamingId];
          delete cleanedToolCallIdsByMessage[oldStreamingId];
        }
        return {
          streamingMessageId: null,
          streamingDelta: "",
          delegationBlocks: {},
          thinkingBlocks: cleanedThinkingBlocks,
          toolCallIdsByMessage: cleanedToolCallIdsByMessage,
        };
      }
      // Streaming started — reset delta, keep existing blocks for completed messages
      return {
        streamingMessageId: messageId,
        streamingDelta: "",
      };
    }),
  appendDelta: (delta) =>
    set((s) => ({ streamingDelta: s.streamingDelta + delta })),
  resetDelta: () => set({ streamingDelta: "" }),
  setUserAck: (message) => set({ userAckMessage: message }),
  clearUserAck: () => set({ userAckMessage: null }),
  setTaskNotice: (message) => set({ taskNotice: message }),
  clearTaskNotice: () => set({ taskNotice: null }),

  // ThinkingBlock actions
  startThinking: (messageId) =>
    set((s) => ({
      thinkingBlocks: {
        ...s.thinkingBlocks,
        [messageId]: { messageId, phase: "streaming", content: "" },
      },
    })),
  appendThinkingDelta: (messageId, delta) =>
    set((s) => {
      const block = s.thinkingBlocks[messageId];
      if (!block) return s;
      return {
        thinkingBlocks: {
          ...s.thinkingBlocks,
          [messageId]: { ...block, content: block.content + delta },
        },
      };
    }),
  endThinking: (messageId) =>
    set((s) => {
      const block = s.thinkingBlocks[messageId];
      if (!block) return s;
      return {
        thinkingBlocks: {
          ...s.thinkingBlocks,
          [messageId]: { ...block, phase: "collapsed" },
        },
      };
    }),
  collapseThinking: (messageId) =>
    set((s) => {
      const block = s.thinkingBlocks[messageId];
      if (!block) return s;
      return {
        thinkingBlocks: {
          ...s.thinkingBlocks,
          [messageId]: { ...block, phase: "collapsed" },
        },
      };
    }),
  toggleThinking: (messageId) =>
    set((s) => {
      const block = s.thinkingBlocks[messageId];
      if (!block) return s;
      const nextPhase = block.phase === "collapsed" ? "expanded" : "collapsed";
      return {
        thinkingBlocks: {
          ...s.thinkingBlocks,
          [messageId]: { ...block, phase: nextPhase },
        },
      };
    }),

  // ToolCallBlock actions
  startToolCall: (toolCallId, toolName) =>
    set((s) => {
      const mid = s.streamingMessageId;
      const existing = mid ? (s.toolCallIdsByMessage[mid] || []) : [];
      return {
        toolCallBlocks: {
          ...s.toolCallBlocks,
          [toolCallId]: { toolCallId, toolName, phase: "loading" },
        },
        // Associate this toolCallId with the current streaming message
        toolCallIdsByMessage: mid
          ? { ...s.toolCallIdsByMessage, [mid]: [...existing, toolCallId] }
          : s.toolCallIdsByMessage,
      };
    }),
  updateToolCallArgs: (toolCallId, args) =>
    set((s) => {
      const block = s.toolCallBlocks[toolCallId];
      if (!block) return s;
      return {
        toolCallBlocks: {
          ...s.toolCallBlocks,
          [toolCallId]: { ...block, args },
        },
      };
    }),
  setToolResult: (toolCallId, result, isError) =>
    set((s) => {
      const block = s.toolCallBlocks[toolCallId];
      if (!block) return s;
      return {
        toolCallBlocks: {
          ...s.toolCallBlocks,
          [toolCallId]: {
            ...block,
            phase: isError ? "error" : "completed_collapsed",
            result,
            isError,
          },
        },
      };
    }),
  toggleToolCall: (toolCallId) =>
    set((s) => {
      const block = s.toolCallBlocks[toolCallId];
      if (!block) return s;
      const nextPhase =
        block.phase === "completed_collapsed"
          ? "completed_expanded"
          : "completed_collapsed";
      return {
        toolCallBlocks: {
          ...s.toolCallBlocks,
          [toolCallId]: { ...block, phase: nextPhase },
        },
      };
    }),

  loadHistoricalToolCalls: (messageId, toolCalls, toolResults) =>
    set((s) => {
      const newToolCallBlocks = { ...s.toolCallBlocks };
      for (const tc of toolCalls) {
        const res = toolResults[tc.id];
        newToolCallBlocks[tc.id] = {
          toolCallId: tc.id,
          toolName: tc.name,
          args: tc.arguments,
          phase: res ? (res.isError ? "error" : "completed_collapsed") : "loading",
          result: res?.result,
          isError: res?.isError,
        };
      }
      const existingIds = s.toolCallIdsByMessage[messageId] || [];
      const newIds = toolCalls.map((tc) => tc.id);
      const mergedIds = [...new Set([...existingIds, ...newIds])];
      return {
        toolCallBlocks: newToolCallBlocks,
        toolCallIdsByMessage: { ...s.toolCallIdsByMessage, [messageId]: mergedIds },
      };
    }),

  rekeyMessageBlocks: (streamingId, finalId) =>
    set((s) => {
      if (streamingId === finalId) return s;
      const toolCallIds = s.toolCallIdsByMessage[streamingId] || [];
      const updatedToolCallIdsByMessage = { ...s.toolCallIdsByMessage };
      delete updatedToolCallIdsByMessage[streamingId];
      if (toolCallIds.length > 0) updatedToolCallIdsByMessage[finalId] = toolCallIds;

      const thinkingBlock = s.thinkingBlocks[streamingId];
      const updatedThinkingBlocks = { ...s.thinkingBlocks };
      if (thinkingBlock) {
        delete updatedThinkingBlocks[streamingId];
        updatedThinkingBlocks[finalId] = { ...thinkingBlock, messageId: finalId };
      }
      return { toolCallIdsByMessage: updatedToolCallIdsByMessage, thinkingBlocks: updatedThinkingBlocks };
    }),

  appendCompressionEvent: (sessionId, data) =>
    set((s) => ({
      compressionEvents: {
        ...s.compressionEvents,
        [sessionId]: [...(s.compressionEvents[sessionId] || []), data],
      },
    })),

  // DelegationBlock actions
  startDelegation: (childSessionId, subagentName, goal) =>
    set((s) => ({
      delegationBlocks: {
        ...s.delegationBlocks,
        [childSessionId]: { childSessionId, subagentName, goal, status: "running" },
      },
    })),
  updateDelegation: (childSessionId, status, progressNote, elapsedSeconds) =>
    set((s) => {
      const block = s.delegationBlocks[childSessionId];
      if (!block) return s;
      return {
        delegationBlocks: {
          ...s.delegationBlocks,
          [childSessionId]: { ...block, status: status as "running" | "completed" | "failed", progressNote, elapsedSeconds },
        },
      };
    }),
  endDelegation: (childSessionId, summary, isError) =>
    set((s) => {
      const block = s.delegationBlocks[childSessionId];
      if (!block) return s;
      return {
        delegationBlocks: {
          ...s.delegationBlocks,
          [childSessionId]: { ...block, status: isError ? "failed" : "completed", summary, isError },
        },
      };
    }),
  // Plan-execute-observe-review-adjust cycle
  setPlan: (plan) => set((s) => ({ plan: typeof plan === 'function' ? (plan as (prev: PlanState | null) => PlanState | null)(s.plan) : plan })),
  updatePlanStep: (stepIndex, status) =>
    set((s) => {
      if (!s.plan) return s;
      const steps = s.plan.steps.map((step, i) =>
        i === stepIndex ? { ...step, status } : step
      );
      return { plan: { ...s.plan, steps } };
    }),
  clearPlan: () => set({ plan: null }),
  prependMessages: (sessionId, messages) =>
    set((s) => ({
      messages: {
        ...s.messages,
        [sessionId]: [...messages, ...(s.messages[sessionId] || [])],
      },
    })),
}));