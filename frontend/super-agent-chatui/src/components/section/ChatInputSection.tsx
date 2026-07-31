import { useState, useRef, useCallback, useEffect } from "react";
import { apiGet, apiPost } from "@/services/api-client";
import { useMessageStore } from "@/store/message-store";
import { useSkillList } from "@/hooks/useSkillList";
import { useSkillPicker } from "@/hooks/useSkillPicker";
import { SkillPicker } from "@/components/base/SkillPicker";
import { QueueList, type QueueItem } from "@/components/section/QueueList";
import type { SkillItem } from "@/types/api-types";

interface ChatInputSectionProps {
  sessionId: string;
}

export function ChatInputSection({ sessionId }: ChatInputSectionProps) {
  const [input, setInput] = useState("");
  const [queueItems, setQueueItems] = useState<QueueItem[]>([]);
  const composingRef = useRef(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const appendMessage = useMessageStore((s) => s.appendMessage);
  const clearPlan = useMessageStore((s) => s.clearPlan);
  const isStreaming = useMessageStore((s) => s.streamingMessageId !== null);
  const taskNotice = useMessageStore((s) => s.taskNotice);

  const { skills } = useSkillList();
  const picker = useSkillPicker(skills);

  // Initialize queue from backend on session switch
  useEffect(() => {
    let cancelled = false;
    setQueueItems([]);
    apiGet<{ queued_items: Array<{ content_preview: string; mode: string }> }>(`/sessions/${sessionId}/queue`)
      .then((data) => {
        if (cancelled) return;
        if (data.queued_items && data.queued_items.length > 0) {
          setQueueItems(data.queued_items.map((it, i) => ({
            content: it.content_preview,
            mode: it.mode,
            addedAt: Date.now() + i,
          })));
        }
      })
      .catch(() => { /* session may not have a queue yet — ignore */ });
    return () => { cancelled = true; };
  }, [sessionId]);

  // When the agent run ends, the backend drains the followup queue automatically —
  // clear local queue list to match.
  useEffect(() => {
    if (!isStreaming && queueItems.length > 0) {
      setQueueItems([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isStreaming]);

  const handleSend = useCallback(async () => {
    if (!input.trim()) return;
    const content = input.trim();
    setInput("");
    if (textareaRef.current) textareaRef.current.style.height = "auto";

    // Agent 在跑 — 入 followup 队列（用户可在 queue 列表点 steer 显式提升）
    if (isStreaming) {
      setQueueItems((prev) => [
        ...prev,
        { content, mode: "followup", addedAt: Date.now() },
      ]);
      try {
        await apiPost(`/sessions/${sessionId}/queue`, { content, mode: "followup" });
      } catch (e) {
        const store = useMessageStore.getState();
        store.setTaskNotice(`入队失败：${(e as Error).message}`);
        window.setTimeout(() => store.clearTaskNotice(), 3000);
        setQueueItems((prev) => prev.filter((it) => it.content !== content));
      }
      return;
    }

    clearPlan();
    appendMessage(sessionId, {
      id: `temp-${Date.now()}`,
      session_id: sessionId,
      role: "user",
      content,
      token_count: 0,
      is_compressed: false,
      created_at: new Date().toISOString(),
    });

    await apiPost("/messages", { session_id: sessionId, content });
  }, [input, sessionId, appendMessage, clearPlan, isStreaming]);

  const handleSteer = useCallback(async (content: string) => {
    // Call backend steer; backend dedupes matching content from the queue.
    // If agent not streaming, backend will downgrade to followup (returns mode=followup).
    try {
      const resp = await apiPost<{ mode: string; queue_depth: number }>(
        `/sessions/${sessionId}/queue`,
        { content, mode: "steer" },
      );
      const store = useMessageStore.getState();
      if (resp.mode === "steer") {
        // Steer succeeded — remove from local queue (backend already injected it)
        setQueueItems((prev) => prev.filter((it) => it.content !== content));
        store.setTaskNotice("信息补充已提交，agent 将结合此信息继续");
      } else {
        // Downgraded to followup — keep in queue
        store.setTaskNotice("agent 当前不在流式，已保留为 followup");
      }
      window.setTimeout(() => store.clearTaskNotice(), 3000);
    } catch (e) {
      const store = useMessageStore.getState();
      store.setTaskNotice(`信息补充失败：${(e as Error).message}`);
      window.setTimeout(() => store.clearTaskNotice(), 3000);
    }
  }, [sessionId]);

  const handleDismissQueue = useCallback((content: string) => {
    // Local-only dismiss — backend queue may still hold it, but it will be
    // drained when the run ends. This just hides it from the UI.
    setQueueItems((prev) => prev.filter((it) => it.content !== content));
  }, []);

  const handleCancel = useCallback(async () => {
    try {
      await apiPost(`/sessions/${sessionId}/cancel`, {});
    } catch (e) {
      const store = useMessageStore.getState();
      store.setTaskNotice(`取消失败：${(e as Error).message}`);
      window.setTimeout(() => store.clearTaskNotice(), 3000);
    }
  }, [sessionId]);

  const handleInput = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    setInput(value);
    const el = e.target;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 160) + "px";
    picker.onInputChange(value, el.selectionStart ?? value.length, composingRef.current);
  }, [picker]);

  const insertSkill = useCallback((skill: SkillItem) => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    const cursorPos = textarea.selectionStart;
    const value = input;
    const textBefore = value.slice(0, cursorPos);

    // Safari-compatible: no lookbehind
    const match = /(^|\s)(\/\S*)$/.exec(textBefore);
    if (!match) {
      picker.close();
      return;
    }

    const slashStart = cursorPos - match[2].length;
    const insertion = `/${skill.name} `;
    const newValue = value.slice(0, slashStart) + insertion + value.slice(cursorPos);

    setInput(newValue);
    picker.close();

    // Set cursor after inserted text once DOM updates
    const newCursor = slashStart + insertion.length;
    requestAnimationFrame(() => {
      if (textareaRef.current) {
        textareaRef.current.selectionStart = newCursor;
        textareaRef.current.selectionEnd = newCursor;
        textareaRef.current.focus();
      }
    });
  }, [input, picker]);

  const hasContent = input.trim().length > 0;
  const canSend = hasContent;

  return (
    <div className="px-4 pb-4 pt-2 relative" role="form" aria-label="消息输入">
      {picker.open && (
        <SkillPicker
          skills={picker.filteredSkills}
          query={picker.query}
          highlightIndex={picker.highlightIndex}
          onSelect={insertSkill}
          onClose={picker.close}
        />
      )}
      <QueueList items={queueItems} onSteer={handleSteer} onDismiss={handleDismissQueue} />
      {taskNotice && (
        <div className="mb-2 px-3 py-1.5 rounded-md glass text-xs font-mono text-[var(--color-text-secondary)] flex items-center gap-2">
          <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-primary)] animate-pulse-cyan shrink-0" />
          <span className="truncate">{taskNotice}</span>
        </div>
      )}
      <div
        className="glass rounded-xl p-3 glow-primary flex items-end gap-3 transition-shadow"
        style={{ boxShadow: canSend ? "var(--glow-primary)" : "none" }}
      >
        <textarea
          ref={textareaRef}
          value={input}
          onChange={handleInput}
          onCompositionStart={() => { composingRef.current = true; }}
          onCompositionEnd={(e) => {
            composingRef.current = false;
            // Re-run slash detection after IME commit
            const el = e.currentTarget;
            picker.onInputChange(el.value, el.selectionStart ?? el.value.length, false);
          }}
          onKeyDown={(e) => {
            if (picker.open) {
              if (e.key === "ArrowDown") { e.preventDefault(); picker.moveDown(); return; }
              if (e.key === "ArrowUp") { e.preventDefault(); picker.moveUp(); return; }
              if (e.key === "Escape") { e.preventDefault(); picker.close(); return; }
              if (e.key === "Tab" || (e.key === "Enter" && !composingRef.current && !e.nativeEvent.isComposing)) {
                e.preventDefault();
                const selected = picker.filteredSkills[picker.highlightIndex];
                if (selected) insertSkill(selected);
                return;
              }
            }
            if (e.key === "Enter" && !e.shiftKey && !composingRef.current && !e.nativeEvent.isComposing) {
              e.preventDefault();
              handleSend();
            }
          }}
          placeholder={isStreaming
            ? "补充消息入队... agent 运行中，Enter 入队，列表中点信息补充"
            : "输入消息... Shift+Enter 换行，/ 选择技能"}
          className="flex-1 bg-transparent text-[var(--color-text)] text-sm leading-relaxed
                     placeholder:text-[var(--color-text-tertiary)] resize-none outline-none
                     min-h-[24px] max-h-[160px]"
          rows={1}
          aria-label="消息输入框"
        />
        {isStreaming && (
          <button
            onClick={handleCancel}
            className="flex items-center justify-center w-9 h-9 rounded-lg
                       bg-[var(--color-error)]/15 text-[var(--color-error)]
                       hover:bg-[var(--color-error)]/25 active:scale-95
                       transition-all duration-200"
            aria-label="取消当前任务"
            type="button"
            title="取消当前任务"
          >
            <svg className="w-4 h-4" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M5 5l10 10M15 5L5 15" />
            </svg>
          </button>
        )}
        <button
          onClick={handleSend}
          disabled={!canSend}
          className={`flex items-center justify-center w-9 h-9 rounded-lg
                     transition-all duration-200
                     ${canSend
                       ? isStreaming
                         ? "bg-[var(--color-warning)] text-[var(--color-surface-dark)] shadow-[var(--glow-primary)] hover:opacity-90 active:scale-95"
                         : "bg-[var(--color-primary)] text-[var(--color-surface-dark)] shadow-[var(--glow-primary)] hover:bg-[var(--color-primary-hover)] active:scale-95"
                       : "bg-[var(--color-border-dim)] text-[var(--color-text-tertiary)] cursor-not-allowed"
                     }`}
          aria-label={isStreaming ? "入队" : "发送"}
          type="button"
          title={isStreaming ? "入队（agent 跑完后执行）" : "发送"}
        >
          <svg className="w-4 h-4" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 10l7-7M10 3l7 7M10 3v14" />
          </svg>
        </button>
      </div>
    </div>
  );
}
