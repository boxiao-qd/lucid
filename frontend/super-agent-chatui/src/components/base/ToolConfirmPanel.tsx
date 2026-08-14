import { useState } from "react";
import { useMessageStore } from "@/store/message-store";
import { confirmToolExecution } from "@/services/api-client";

interface ToolConfirmPanelProps {
  sessionId: string;
}

export function ToolConfirmPanel({ sessionId }: ToolConfirmPanelProps) {
  const pending = useMessageStore((s) => s.pendingConfirmation);
  const clear = useMessageStore((s) => s.clearPendingConfirmation);
  const [showCustom, setShowCustom] = useState(false);
  const [customText, setCustomText] = useState("");
  const [submitting, setSubmitting] = useState(false);

  if (!pending) return null;

  async function submit(action: string, text: string = "") {
    if (submitting) return;
    setSubmitting(true);
    try {
      await confirmToolExecution(sessionId, {
        confirmation_id: pending!.confirmation_id,
        action,
        text,
      });
    } catch {
      // Even on error, clear the panel so the agent loop's timeout handles it
    }
    clear();
    setShowCustom(false);
    setCustomText("");
    setSubmitting(false);
  }

  const toolLabel = pending.tool_name === "terminal" ? "终端命令" : "代码执行";

  return (
    <div className="flex justify-start my-2" role="alertdialog" aria-live="assertive">
      <div className="rounded-lg glass glow-primary px-4 py-3 max-w-[85%] w-full
                      border border-[var(--color-warning)]/40">
        {/* ── Header ─────────────────────────────────────────────── */}
        <div className="flex items-center gap-2 mb-2">
          <svg className="w-4 h-4 text-[var(--color-warning)] shrink-0" viewBox="0 0 16 16" fill="none">
            <path d="M8 1.5L1.5 13.5h13L8 1.5z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
            <path d="M8 6v3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            <circle cx="8" cy="11.5" r="0.8" fill="currentColor" />
          </svg>
          <span className="font-mono text-xs text-[var(--color-warning)]">
            需要确认：{toolLabel}
          </span>
        </div>

        {/* ── Command/code content ──────────────────────────────── */}
        <div className="mb-3 max-h-48 overflow-y-auto rounded-md bg-black/30 border border-white/5 p-2.5">
          <pre className="font-mono text-xs text-[var(--color-text-primary)] whitespace-pre-wrap break-all">
            {pending.content}
          </pre>
        </div>

        {/* ── Action buttons ────────────────────────────────────── */}
        {!showCustom ? (
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => submit("approve_once")}
              disabled={submitting}
              className="px-3 py-1.5 rounded-md text-xs font-mono
                         bg-[var(--color-primary)]/15 border border-[var(--color-primary)]/30
                         text-[var(--color-primary)]
                         hover:bg-[var(--color-primary)]/25
                         disabled:opacity-50 transition-colors"
            >
              同意本次
            </button>
            <button
              onClick={() => submit("approve_session")}
              disabled={submitting}
              className="px-3 py-1.5 rounded-md text-xs font-mono
                         bg-[var(--color-primary)]/10 border border-[var(--color-primary)]/20
                         text-[var(--color-primary)]
                         hover:bg-[var(--color-primary)]/20
                         disabled:opacity-50 transition-colors"
            >
              同意本会话
            </button>
            <button
              onClick={() => submit("reject")}
              disabled={submitting}
              className="px-3 py-1.5 rounded-md text-xs font-mono
                         bg-[var(--color-error)]/15 border border-[var(--color-error)]/30
                         text-[var(--color-error)]
                         hover:bg-[var(--color-error)]/25
                         disabled:opacity-50 transition-colors"
            >
              拒绝
            </button>
            <button
              onClick={() => setShowCustom(true)}
              disabled={submitting}
              className="px-3 py-1.5 rounded-md text-xs font-mono
                         bg-white/5 border border-white/10
                         text-[var(--color-text-secondary)]
                         hover:bg-white/10
                         disabled:opacity-50 transition-colors"
            >
              补充信息
            </button>
          </div>
        ) : (
          <div className="space-y-2">
            <textarea
              value={customText}
              onChange={(e) => setCustomText(e.target.value)}
              placeholder="输入补充信息，智能体将收到此文本而非执行命令…"
              rows={3}
              className="w-full rounded-md bg-black/30 border border-white/10 p-2.5
                         font-mono text-xs text-[var(--color-text-primary)]
                         placeholder:text-[var(--color-text-tertiary)]
                         focus:outline-none focus:border-[var(--color-primary)]/40
                         resize-none"
              autoFocus
            />
            <div className="flex gap-2">
              <button
                onClick={() => submit("custom", customText)}
                disabled={submitting || !customText.trim()}
                className="px-3 py-1.5 rounded-md text-xs font-mono
                           bg-[var(--color-primary)]/15 border border-[var(--color-primary)]/30
                           text-[var(--color-primary)]
                           hover:bg-[var(--color-primary)]/25
                           disabled:opacity-50 transition-colors"
              >
                提交
              </button>
              <button
                onClick={() => { setShowCustom(false); setCustomText(""); }}
                disabled={submitting}
                className="px-3 py-1.5 rounded-md text-xs font-mono
                           bg-white/5 border border-white/10
                           text-[var(--color-text-secondary)]
                           hover:bg-white/10
                           disabled:opacity-50 transition-colors"
              >
                取消
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
