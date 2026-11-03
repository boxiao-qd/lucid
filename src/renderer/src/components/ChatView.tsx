import { useState, useRef, useEffect, useMemo } from 'react'
import { useSessionStore } from '../store/sessionStore'
import { useAgentStore } from '../store/agentStore'
import { useSkillStore } from '../store/skillStore'
import { useExpertStore } from '../store/expertStore'
import PlanCard from './agent/PlanCard'
import ThinkingCard from './agent/ThinkingCard'
import { ToolCallItem } from './agent/ToolCallCard'
import QueueList from './agent/QueueList'
import ToolConfirmDialog from './agent/ToolConfirmDialog'
import { groupMessages, MessageGroup } from './MessageBlock'
import MarkdownRenderer from './MarkdownRenderer'
import ModelSelector from './ModelSelector'
import SkillSelector from './SkillSelector'
import ExpertSelector from './ExpertSelector'
import SecurityModeToggle from './SecurityModeToggle'
import logo from '../assets/logo.png'

// Paperclip icon for attachment upload
const UploadIcon = (): React.JSX.Element => (
  <svg
    width="18"
    height="18"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
  </svg>
)

// Upward arrow icon for send button
const SendIcon = (): React.JSX.Element => (
  <svg
    width="18"
    height="18"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.5"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <line x1="12" y1="19" x2="12" y2="5" />
    <polyline points="5 12 12 5 19 12" />
  </svg>
)

function ChatView(): React.JSX.Element {
  const messages = useSessionStore((s) => s.messages)
  const currentId = useSessionStore((s) => s.currentId)
  const sendMessage = useSessionStore((s) => s.sendMessage)
  const [input, setInput] = useState('')
  const [attachments, setAttachments] = useState<{ dataUrl: string; name: string }[]>([])
  const scrollRef = useRef<HTMLDivElement>(null)
  const justSentRef = useRef(false)
  const prevSessionIdRef = useRef<string | null>(null)
  // Track whether the user has manually scrolled away from the bottom.
  // Updated via onScroll — fires during the user's scroll action, not
  // after new content is added (which would give stale measurements).
  const userScrolledUpRef = useRef(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  // Track IME composition state to prevent Enter (used to confirm a
  // candidate) from also triggering send.
  const compositionRef = useRef(false)

  // Skill state — selected skill chip + slash command dropdown
  const skills = useSkillStore((s) => s.skills)
  const selectedSlug = useSkillStore((s) => s.selectedSlug)
  const selectSkill = useSkillStore((s) => s.select)
  const [slashMenuOpen, setSlashMenuOpen] = useState(false)
  const [slashQuery, setSlashQuery] = useState('')
  const [slashIndex, setSlashIndex] = useState(0)

  // Expert state — selected expert for delegation
  const selectedAgentId = useExpertStore((s) => s.selectedAgentId)

  const selectedSkill = skills.find((s) => s.slug === selectedSlug)

  // Filtered skills for slash menu
  const slashResults = slashQuery
    ? skills.filter(
        (s) =>
          s.name.toLowerCase().includes(slashQuery.toLowerCase()) ||
          s.slug.toLowerCase().includes(slashQuery.toLowerCase())
      )
    : skills

  const isRunning = useAgentStore((s) => s.isRunning)
  const plan = useAgentStore((s) => s.plan)
  const streamItems = useAgentStore((s) => s.streamItems)
  const thinking = useAgentStore((s) => s.thinking)
  const userAckMessage = useAgentStore((s) => s.userAckMessage)
  const errorMessage = useAgentStore((s) => s.errorMessage)
  const taskNotice = useAgentStore((s) => s.taskNotice)
  const queue = useAgentStore((s) => s.queue)
  const isCompacting = useAgentStore((s) => s.isCompacting)
  const compactionResult = useAgentStore((s) => s.compactionResult)

  // Memoize grouped messages — without this, every streaming token triggers
  // an O(n) regroup of the entire message history.
  const groupedMessages = useMemo(() => groupMessages(messages), [messages])

  const showAgentSection =
    isRunning ||
    plan !== null ||
    streamItems.length > 0 ||
    thinking !== null ||
    userAckMessage !== null ||
    errorMessage !== null ||
    queue.length > 0 ||
    isCompacting ||
    compactionResult !== null

  const isEmpty = messages.length === 0 && !showAgentSection

  // Refresh — reload current session's messages from disk. Useful when SSE
  // events didn't reach the renderer (e.g. background scheduled task runs).
  const handleRefresh = async (): Promise<void> => {
    if (!currentId) return
    const msgs = await window.api.sessions.get(currentId)
    useSessionStore.setState({ messages: msgs })
    justSentRef.current = false
  }

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return

    // On session switch, force-scroll to the bottom so the latest
    // conversation is visible. Use rAF to ensure the DOM has laid out
    // the new messages before measuring scrollHeight.
    if (prevSessionIdRef.current !== currentId) {
      prevSessionIdRef.current = currentId
      userScrolledUpRef.current = false
      requestAnimationFrame(() => {
        el.scrollTop = el.scrollHeight
      })
      return
    }

    // When the user just sent a message, always force-scroll to the bottom
    // so they can see the new task and its output immediately.
    if (justSentRef.current) {
      el.scrollTop = el.scrollHeight
      justSentRef.current = false
      userScrolledUpRef.current = false
      return
    }

    // Only auto-scroll if the user hasn't scrolled up to read earlier
    // content. userScrolledUpRef is updated in real-time by onScroll,
    // so it reflects the user's actual position — not a stale measurement
    // taken after new DOM content has already changed scrollHeight.
    if (!userScrolledUpRef.current) {
      el.scrollTop = el.scrollHeight
    }
  }, [
    messages,
    currentId,
    showAgentSection,
    streamItems,
    plan,
    thinking,
    userAckMessage,
    errorMessage,
    queue
  ])

  const addFile = (file: File): void => {
    const reader = new FileReader()
    reader.onload = (): void => {
      const result = reader.result
      if (typeof result === 'string') {
        setAttachments((prev) => [...prev, { dataUrl: result, name: file.name }])
      }
    }
    reader.readAsDataURL(file)
  }

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const files = e.target.files
    if (!files) return
    for (const file of Array.from(files)) {
      addFile(file)
    }
    e.target.value = ''
  }

  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>): void => {
    const items = e.clipboardData?.items
    if (!items) return
    for (const item of Array.from(items)) {
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile()
        if (file) addFile(file)
      }
    }
  }

  const removeAttachment = (index: number): void => {
    setAttachments((prev) => prev.filter((_, i) => i !== index))
  }

  // Textarea change — detect `/skill-name` prefix to trigger slash menu,
  // and auto-convert a complete `/skill-name ` (followed by space) into a chip
  const onTextareaChange = (e: React.ChangeEvent<HTMLTextAreaElement>): void => {
    const value = e.target.value
    // Check for `/skill-name ` pattern (skill name + space + rest)
    const completeMatch = value.match(/^\/(\S+)\s([\s\S]*)$/)
    if (completeMatch) {
      const typedName = completeMatch[1].toLowerCase()
      const rest = completeMatch[2]
      const matched = skills.find(
        (s) => s.name.toLowerCase() === typedName || s.slug.toLowerCase() === typedName
      )
      if (matched) {
        // Convert to chip — set skill and keep the rest as input
        selectSkill(matched.slug)
        setInput(rest)
        setSlashMenuOpen(false)
        return
      }
    }
    setInput(value)
    // Only trigger slash menu when input is exactly `/xxx` (no spaces)
    const match = value.match(/^\/(\S*)$/)
    if (match) {
      setSlashQuery(match[1])
      setSlashMenuOpen(true)
      setSlashIndex(0)
    } else {
      setSlashMenuOpen(false)
    }
  }

  // Select a skill from the slash menu — clears the `/query` text and sets the chip
  const selectFromSlash = (skill: { slug: string; name: string }): void => {
    setInput('')
    setSlashMenuOpen(false)
    selectSkill(skill.slug)
  }

  const onSlashKeyDown = (e: React.KeyboardEvent): boolean => {
    if (!slashMenuOpen || slashResults.length === 0) return false
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSlashIndex((i) => (i + 1) % slashResults.length)
      return true
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSlashIndex((i) => (i - 1 + slashResults.length) % slashResults.length)
      return true
    }
    if (e.key === 'Tab') {
      e.preventDefault()
      const skill = slashResults[slashIndex]
      if (skill) selectFromSlash(skill)
      return true
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      const skill = slashResults[slashIndex]
      if (skill) selectFromSlash(skill)
      return true
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      setSlashMenuOpen(false)
      return true
    }
    return false
  }

  const send = async (): Promise<void> => {
    const text = input.trim()
    if (!text && attachments.length === 0) return
    setInput('')

    // Save attachments to disk — need a session ID
    let paths: string[] | undefined
    if (attachments.length > 0) {
      let sid = useSessionStore.getState().currentId
      if (!sid) {
        // Auto-create session — sendMessage would do this anyway,
        // but we need the ID now to save uploads
        const meta = await window.api.sessions.create()
        useSessionStore.setState((s) => ({
          sessions: [meta, ...s.sessions.filter((x) => x.id !== meta.id)],
          currentId: meta.id,
          messages: []
        }))
        sid = meta.id
      }
      paths = []
      for (const att of attachments) {
        const path = await window.api.uploads.save(sid, att.dataUrl, att.name)
        paths.push(path)
      }
    }
    setAttachments([])
    const skillSlug = useSkillStore.getState().selectedSlug ?? undefined
    const expertId = selectedAgentId ?? undefined

    // Prepend /skill-name to the message content so it shows in the chat
    // list and persists to the session file.
    let fullContent = text || '请分析以下文件'
    if (skillSlug) {
      const skill = useSkillStore.getState().skills.find((s) => s.slug === skillSlug)
      if (skill) {
        fullContent = `/${skill.name} ${fullContent}`
      }
    }

    justSentRef.current = true
    void sendMessage(fullContent, paths, skillSlug, expertId)
  }

  const stop = (): void => {
    if (currentId) void window.api.agent.cancel(currentId)
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    // Block Enter during IME composition (Chinese/Japanese/Korean input).
    // When the user presses Enter to confirm a candidate, the keydown fires
    // with isComposing=true or keyCode=229. compositionRef is a fallback for
    // browsers where the keydown fires right after compositionend.
    if (compositionRef.current || e.nativeEvent.isComposing || e.keyCode === 229) {
      return
    }
    // If slash menu is open, let onSlashKeyDown handle navigation
    if (onSlashKeyDown(e)) return
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  }

  const sendBtn = (
    <button
      onClick={send}
      disabled={!input.trim() && attachments.length === 0}
      className="flex h-8 w-8 items-center justify-center rounded-full bg-stone-700 text-white transition-colors hover:bg-stone-800 disabled:cursor-not-allowed disabled:bg-stone-300"
    >
      <SendIcon />
    </button>
  )

  const stopBtn = (
    <button
      onClick={stop}
      className="flex h-8 items-center rounded-full border border-stone-400 px-4 text-sm font-medium text-stone-600 transition-colors hover:bg-stone-100"
    >
      停止
    </button>
  )

  const uploadBtn = (
    <button
      onClick={() => fileInputRef.current?.click()}
      className="flex h-8 w-8 items-center justify-center rounded-full text-stone-400 transition-colors hover:bg-stone-100 hover:text-stone-600"
    >
      <UploadIcon />
    </button>
  )

  // Hidden file input — accepts images, PDF, Office docs (docx/xlsx only),
  // and common text/code formats. PPT, audio, and video are not accepted.
  const fileInput = (
    <input
      ref={fileInputRef}
      type="file"
      accept="image/*,.pdf,.docx,.xlsx,.txt,.md,.json,.csv,.log,.ts,.js,.tsx,.jsx,.py,.go,.rs,.java,.html,.css,.xml,.yml,.yaml,.sh,.sql"
      multiple
      onChange={handleFileSelect}
      className="hidden"
    />
  )

  // Thumbnail row for attached files — images show preview, other files show name
  const attachmentRow =
    attachments.length > 0 ? (
      <div className="flex flex-wrap gap-2 px-3 pb-1 pt-2">
        {attachments.map((att, i) => (
          <div key={i} className="relative">
            {att.dataUrl.startsWith('data:image/') ? (
              <img
                src={att.dataUrl}
                alt={`attachment-${i}`}
                className="h-16 w-16 rounded-lg border border-stone-200 object-cover"
              />
            ) : (
              <div className="flex h-16 items-center rounded-lg border border-stone-200 bg-stone-50 px-3">
                <span className="max-w-[120px] truncate text-xs text-stone-600">{att.name}</span>
              </div>
            )}
            <button
              onClick={() => removeAttachment(i)}
              className="absolute -right-1 -top-1 flex h-5 w-5 items-center justify-center rounded-full bg-stone-700 text-xs text-white hover:bg-stone-900"
            >
              ×
            </button>
          </div>
        ))}
      </div>
    ) : null

  // Skill chip — shows `/skill-name` with gray background when a skill is selected
  const skillChip =
    selectedSkill && !slashMenuOpen ? (
      <div className="flex flex-wrap gap-2 px-3 pb-1 pt-2">
        <span className="inline-flex items-center gap-1 rounded-full bg-stone-200 px-3 py-1 text-xs font-medium text-stone-700">
          /{selectedSkill.name}
          <button
            onClick={() => selectSkill(null)}
            className="text-stone-400 transition-colors hover:text-stone-600"
          >
            ×
          </button>
        </span>
      </div>
    ) : null

  // Slash command dropdown — appears when user types `/` to search skills
  const slashMenu =
    slashMenuOpen && slashResults.length > 0 ? (
      <div className="absolute bottom-full left-0 right-0 z-30 mb-1 max-h-[240px] overflow-y-auto rounded-lg border border-stone-200 bg-white py-1 shadow-lg">
        <div className="px-3 pb-1 text-xs font-medium uppercase tracking-wide text-stone-400">
          技能
        </div>
        {slashResults.map((s, i) => (
          <button
            key={s.slug}
            onClick={() => selectFromSlash(s)}
            className={`flex w-full items-start gap-2 px-3 py-1.5 text-left text-xs transition-colors hover:bg-stone-50 ${
              i === slashIndex ? 'bg-stone-50' : ''
            }`}
          >
            {s.emoji && <span className="flex-shrink-0">{s.emoji}</span>}
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium text-stone-700" title={s.name}>
                /{s.name}
              </div>
              <div className="truncate text-stone-400" title={s.description}>
                {s.description}
              </div>
            </div>
          </button>
        ))}
      </div>
    ) : null

  // Bottom toolbar: [upload] [model selector] [skill selector] [expert selector] ... [send/stop]
  const bottomBar = (
    <div className="flex items-center justify-between px-3 pb-2 pt-1">
      <div className="flex items-center gap-0.5">
        {uploadBtn}
        <ModelSelector />
        <SkillSelector />
        <ExpertSelector />
        <SecurityModeToggle />
      </div>
      <div className="flex items-center gap-2">
        {isRunning && stopBtn}
        {sendBtn}
      </div>
    </div>
  )

  // --- Hero (empty state) ---
  if (isEmpty) {
    return (
      <div className="flex h-full flex-1 flex-col items-center justify-center bg-white px-6 pb-[20vh]">
        <div className="mb-10 flex items-center gap-4">
          <img src={logo} className="h-20 w-20 rounded-xl" alt="logo" />
          <div className="flex items-baseline gap-5">
            <h1 className="text-4xl font-bold text-stone-800">Lucid</h1>
            <span className="text-lg text-stone-400">知行合一 · 澄澈清明</span>
          </div>
        </div>
        <div className="relative w-full max-w-3xl rounded-2xl border border-stone-200 bg-white shadow-sm focus-within:border-stone-400">
          {fileInput}
          {slashMenu}
          <textarea
            value={input}
            onChange={onTextareaChange}
            onKeyDown={onKeyDown}
            onPaste={handlePaste}
            onCompositionStart={() => {
              compositionRef.current = true
            }}
            onCompositionEnd={() => {
              // Delay clearing so the Enter that confirmed the composition
              // doesn't trigger send on the immediately following keydown.
              requestAnimationFrame(() => {
                compositionRef.current = false
              })
            }}
            rows={2}
            autoFocus
            placeholder="输入消息，Enter 发送，Shift+Enter 换行。输入 / 搜索技能"
            className="w-full resize-none px-4 pt-3 text-sm outline-none placeholder:text-stone-400"
          />
          {skillChip}
          {attachmentRow}
          {bottomBar}
        </div>
      </div>
    )
  }

  // --- Chat layout ---
  return (
    <div className="flex h-full flex-1 flex-col bg-white">
      {/* Refresh button — top-right floating */}
      <div className="flex justify-end px-4 pt-2">
        <button
          onClick={() => void handleRefresh()}
          className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-stone-400 transition-colors hover:bg-stone-100 hover:text-stone-600"
          title="刷新当前会话"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M23 4v6h-6" />
            <path d="M1 20v-6h6" />
            <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
          </svg>
          刷新
        </button>
      </div>
      <div
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget
          const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 150
          userScrolledUpRef.current = !isNearBottom
        }}
        className="flex-1 overflow-y-auto px-6 py-4"
      >
        <div className="mx-auto max-w-5xl space-y-3">
          {/* Persisted messages */}
          {groupedMessages.map((group) => (
            <MessageGroup key={group[0].id} messages={group} />
          ))}

          {/* Real-time agent section */}
          {showAgentSection && (
            <div className="space-y-3">
              {userAckMessage && (
                <div className="text-center text-xs text-stone-400">{userAckMessage}</div>
              )}
              {errorMessage && (
                <div className="rounded-lg border border-stone-300 bg-stone-50 px-4 py-2 text-sm text-stone-600">
                  {errorMessage}
                </div>
              )}
              {/* Sticky plan + thinking — pinned to top during scroll
                  so the user always sees the current plan and reasoning
                  status while content scrolls beneath. */}
              {(plan || (thinking && thinking.content.trim())) && (
                <div className="sticky top-0 z-10 bg-white py-1">
                  <div className="space-y-2">
                    {plan && <PlanCard />}
                    {thinking && <ThinkingCard />}
                  </div>
                </div>
              )}
              {/* Interleaved rendering: text narration and tool call cards in
                  temporal order, so the user sees "我要做什么 → 工具调用 →
                  拿到了什么 → 下一步" as a reading flow. */}
              {streamItems.map((item, i) => {
                if (item.type === 'text') {
                  const isLast = i === streamItems.length - 1
                  return (
                    <div key={i} className="w-full">
                      <MarkdownRenderer content={item.content ?? ''} />
                      {isLast && isRunning && (
                        <span className="mt-1 block h-1 w-2 animate-pulse rounded-full bg-stone-400" />
                      )}
                    </div>
                  )
                }
                return (
                  <div key={item.toolCallId ?? i} className="w-full">
                    <ToolCallItem id={item.toolCallId!} />
                  </div>
                )
              })}
              {queue.length > 0 && (
                <QueueList
                  items={queue}
                  onSteer={(content) => {
                    if (currentId) void window.api.agent.steer(currentId, content)
                    useAgentStore.getState().removeFromQueue(content)
                  }}
                  onDismiss={(content) => useAgentStore.getState().removeFromQueue(content)}
                />
              )}
              {isCompacting && (
                <div className="flex items-center gap-2 rounded-lg border border-blue-200 bg-blue-50 px-4 py-2 text-sm text-blue-700">
                  <svg
                    className="h-4 w-4 animate-spin text-blue-500"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <path d="M21 12a9 9 0 1 1-6.219-8.56" strokeLinecap="round" />
                  </svg>
                  正在压缩上下文...
                </div>
              )}
              {!isCompacting && compactionResult && (
                <div className="rounded-lg border border-stone-200 bg-stone-50 px-4 py-2 text-xs text-stone-500">
                  上下文已压缩（{compactionResult.tokensBefore} → ~{compactionResult.tokensAfter}{' '}
                  tokens
                  {compactionResult.memoriesExtracted > 0 &&
                    `，提取 ${compactionResult.memoriesExtracted} 条记忆`}
                  ）
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Input box — same card style as hero */}
      {taskNotice && (
        <div className="mx-auto max-w-5xl px-4 py-1 text-center text-xs text-stone-500">
          {taskNotice}
        </div>
      )}
      <ToolConfirmDialog />
      <div className="flex-shrink-0 p-4">
        <div className="relative mx-auto max-w-5xl rounded-2xl border border-stone-200 bg-white shadow-sm focus-within:border-stone-400">
          {fileInput}
          {slashMenu}
          <textarea
            value={input}
            onChange={onTextareaChange}
            onKeyDown={onKeyDown}
            onPaste={handlePaste}
            onCompositionStart={() => {
              compositionRef.current = true
            }}
            onCompositionEnd={() => {
              requestAnimationFrame(() => {
                compositionRef.current = false
              })
            }}
            rows={2}
            placeholder={
              isRunning
                ? '输入消息入队… Enter 入队，列表中可点信息补充'
                : '输入消息，Enter 发送，Shift+Enter 换行。输入 / 搜索技能'
            }
            className="w-full resize-none px-4 pt-3 text-sm outline-none placeholder:text-stone-400"
          />
          {skillChip}
          {attachmentRow}
          {bottomBar}
        </div>
      </div>
    </div>
  )
}

export default ChatView
