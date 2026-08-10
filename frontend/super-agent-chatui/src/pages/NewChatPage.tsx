import { useState, useRef, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { apiPost, apiUploadFile } from "@/services/api-client";
import { useSessionStore } from "@/store/session-store";
import { useSkillList } from "@/hooks/useSkillList";
import { useSkillPicker } from "@/hooks/useSkillPicker";
import { SkillPicker } from "@/components/base/SkillPicker";
import type { SkillItem, Attachment } from "@/types/api-types";

const SUGGESTIONS = [
  { label: "搜索资讯", prompt: "帮我搜索最新的AI行业动态" },
  { label: "代码分析", prompt: "帮我分析这段代码的问题" },
  { label: "文件处理", prompt: "帮我读取并整理这份文件的内容" },
  { label: "方案设计", prompt: "帮我设计一个技术方案" },
];

interface CreateSessionResp {
  session_id: string;
  title?: string;
  model: string;
  created_at: string;
}

export function NewChatPage() {
  const navigate = useNavigate();
  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const composingRef = useRef(false);
  const addSession = useSessionStore((s) => s.addSession);
  const setActiveSession = useSessionStore((s) => s.setActiveSession);

  const { skills } = useSkillList();
  const picker = useSkillPicker(skills);

  const handleSend = useCallback(async () => {
    if (!input.trim() && attachments.length === 0) return;
    const content = input.trim();
    const pendingAttachments = attachments;
    setInput("");
    setAttachments([]);
    if (textareaRef.current) textareaRef.current.style.height = "auto";

    const resp = await apiPost<CreateSessionResp>("/sessions", {
      title: content.slice(0, 50),
    });
    addSession({
      session_id: resp.session_id,
      title: resp.title,
      model: resp.model,
      created_at: resp.created_at,
      message_count: 0,
      is_active: false,
    });
    setActiveSession(resp.session_id);
    await apiPost<{ message_id: string }>("/messages", {
      session_id: resp.session_id,
      content,
      attachments: pendingAttachments,
    });
    navigate(`/chat/${resp.session_id}`);
  }, [input, attachments, navigate, addSession, setActiveSession]);

  const handleUploadImage = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    setUploading(true);
    try {
      for (const file of Array.from(files)) {
        if (!file.type.startsWith("image/")) continue;
        const resp = await apiUploadFile<{ url: string; name: string; type: string }>("/files/upload-image", file);
        setAttachments((prev) => [...prev, { url: resp.url, name: resp.name, type: "image" }]);
      }
    } catch (err) {
      console.error("图片上传失败:", err);
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }, []);

  const handleRemoveAttachment = useCallback((url: string) => {
    setAttachments((prev) => prev.filter((a) => a.url !== url));
  }, []);

  const handlePaste = useCallback(async (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const imageFiles: File[] = [];
    for (const item of Array.from(items)) {
      if (item.type.startsWith("image/")) {
        const file = item.getAsFile();
        if (file) imageFiles.push(file);
      }
    }
    if (imageFiles.length === 0) return;
    e.preventDefault();
    setUploading(true);
    try {
      for (const file of imageFiles) {
        const resp = await apiUploadFile<{ url: string; name: string; type: string }>("/files/upload-image", file);
        setAttachments((prev) => [...prev, { url: resp.url, name: resp.name, type: "image" }]);
      }
    } catch (err) {
      console.error("粘贴图片上传失败:", err);
    } finally {
      setUploading(false);
    }
  }, []);

  const handleSuggestion = useCallback((prompt: string) => {
    setInput(prompt);
    if (textareaRef.current) {
      textareaRef.current.focus();
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 160) + "px";
    }
  }, []);

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
    const match = /(^|\s)(\/\S*)$/.exec(textBefore);
    if (!match) { picker.close(); return; }
    const slashStart = cursorPos - match[2].length;
    const insertion = `/${skill.name} `;
    const newValue = value.slice(0, slashStart) + insertion + value.slice(cursorPos);
    setInput(newValue);
    picker.close();
    const newCursor = slashStart + insertion.length;
    requestAnimationFrame(() => {
      if (textareaRef.current) {
        textareaRef.current.selectionStart = newCursor;
        textareaRef.current.selectionEnd = newCursor;
        textareaRef.current.focus();
      }
    });
  }, [input, picker]);

  const hasContent = input.trim().length > 0 || attachments.length > 0;
  const canSend = hasContent && !uploading;

  return (
    <div className="flex-1 flex flex-col min-h-0 items-center justify-center px-4">
      {/* ── Hero section ─────────────────────────────────────────── */}
      <div className="mb-8 text-center">
        <div className="flex items-center justify-center gap-3 mb-4">
          <div className="w-1.5 h-1.5 rounded-full bg-[var(--color-primary)] animate-pulse-cyan" />
          <span className="font-mono text-xs tracking-[0.4em] text-[var(--color-text-tertiary)] uppercase">
            super-agent
          </span>
          <div className="w-1.5 h-1.5 rounded-full bg-[var(--color-primary)] animate-pulse-cyan" />
        </div>
        <h1 className="text-3xl font-semibold text-[var(--color-text)] tracking-tight">
          有什么可以帮你？
        </h1>
        <p className="mt-2 text-sm text-[var(--color-text-tertiary)]">
          输入指令开始对话，支持技能、代码、文件处理
        </p>
      </div>

      {/* ── Input area with animated gradient border ────────────── */}
      <div className="max-w-xl w-full">
        <div className="relative">
          {picker.open && (
            <SkillPicker
              skills={picker.filteredSkills}
              query={picker.query}
              highlightIndex={picker.highlightIndex}
              onSelect={insertSkill}
              onClose={picker.close}
            />
          )}
        <div
          className="border-gradient rounded-2xl p-5 flex items-end gap-3 transition-all duration-300"
          style={{ boxShadow: canSend ? "var(--glow-primary)" : "var(--shadow-md)" }}
        >
          {/* Image upload button */}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={handleUploadImage}
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            className="flex items-center justify-center w-10 h-10 rounded-xl shrink-0
                       bg-[var(--color-surface-raised)] text-[var(--color-text-secondary)]
                       hover:text-[var(--color-primary)]
                       active:scale-95 transition-all duration-200
                       disabled:opacity-50 disabled:cursor-not-allowed"
            aria-label="上传图片"
            type="button"
            title="上传图片（或直接粘贴）"
          >
            {uploading ? (
              <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21 12a9 9 0 11-6.219-8.562" strokeLinecap="round" />
              </svg>
            ) : (
              <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                <circle cx="8.5" cy="8.5" r="1.5" />
                <path d="M21 15l-5-5L5 21" />
              </svg>
            )}
          </button>
          {/* Image attachment preview thumbnails */}
          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-2 shrink-0">
              {attachments.map((att) => (
                <div key={att.url} className="relative group w-16 h-16 rounded-lg overflow-hidden border border-[var(--color-border-dim)]">
                  <img src={att.url} alt={att.name} className="w-full h-full object-cover" />
                  <button
                    onClick={() => handleRemoveAttachment(att.url)}
                    className="absolute top-0 right-0 w-5 h-5 flex items-center justify-center
                               bg-[var(--color-error)] text-white rounded-bl-lg
                               opacity-0 group-hover:opacity-100 transition-opacity"
                    aria-label="移除图片"
                    type="button"
                  >
                    <svg className="w-3 h-3" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                      <path d="M5 5l10 10M15 5L5 15" />
                    </svg>
                  </button>
                </div>
              ))}
            </div>
          )}
          <textarea
            ref={textareaRef}
            value={input}
            onChange={handleInput}
            onPaste={handlePaste}
            onCompositionStart={() => { composingRef.current = true; }}
            onCompositionEnd={(e) => {
              composingRef.current = false;
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
            placeholder="输入消息开始对话... Shift+Enter 换行，/ 选择技能"
            className="flex-1 bg-transparent text-[var(--color-text)] text-sm leading-relaxed
                       placeholder:text-[var(--color-text-tertiary)] resize-none outline-none
                       min-h-[28px] max-h-[160px]"
            rows={1}
            aria-label="新对话消息输入"
          />
          <button
            onClick={handleSend}
            disabled={!canSend}
            className={`flex items-center justify-center w-10 h-10 rounded-xl
                       transition-all duration-200
                       ${canSend
                         ? "bg-[var(--color-primary)] text-[var(--color-surface-dark)] shadow-[var(--glow-primary)] hover:bg-[var(--color-primary-hover)] active:scale-95"
                         : "bg-[var(--color-surface-raised)] text-[var(--color-text-tertiary)] cursor-not-allowed"
                       }`}
            aria-label="发送消息"
            type="button"
          >
            <svg className="w-4 h-4" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 10l7-7M10 3l7 7M10 3v14" />
            </svg>
          </button>
        </div>
        </div>

        {/* ── Quick suggestions ─────────────────────────────────────── */}
        <div className="flex flex-wrap justify-center gap-2 mt-5">
          {SUGGESTIONS.map((s) => (
            <button
              key={s.label}
              onClick={() => handleSuggestion(s.prompt)}
              className="rounded-lg px-3.5 py-2 text-xs font-mono
                         border border-[var(--color-border-dim)]
                         text-[var(--color-text-secondary)]
                         hover:text-[var(--color-primary)]
                         hover:border-[var(--color-primary)]
                         hover:shadow-[var(--glow-primary)]
                         transition-all duration-200 active:scale-95"
              type="button"
            >
              <span className="text-[var(--color-primary)] mr-1.5">·</span>
              {s.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}