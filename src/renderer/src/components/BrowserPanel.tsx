// BrowserPanel — hosts an Electron <webview> for agent-controlled browsing.
// Ported from zcode UnifiedBrowserView + BrowserToolbar + BrowserViewportSurface.
//
// Layout states (mirroring zcode's side pane):
//   collapsed — shrinks to a 40px strip on the right edge; webview stays
//               mounted (display:none) so the CDP guest keeps running.
//   expanded  — browser takes the full content width (chat hidden in App).
//   normal    — width is drag-resizable via the handle on the left edge,
//               stored as a fraction of the content area (default 50%,
//               clamped 25%–65%) so it adapts to any window size.
//
// Chrome (top to bottom): title bar (page title + collapse/expand/more/close)
// → toolbar (back/forward/reload/address/zoom) → webview surface.
//
// Key fix: webview is created imperatively via document.createElement to avoid
// React 19 custom-element attribute issues. Event listeners are attached BEFORE
// the element enters the DOM, so did-attach is never missed. The container div
// is never unmounted while the panel is open — only hidden with CSS.

import { useEffect, useRef, useState, type FormEvent, type PointerEvent } from 'react'
import { useBrowserStore } from '../store/browserStore'

interface WebviewElement extends HTMLElement {
  src: string
  partition: string
  getWebContentsId(): number
  loadURL(url: string): Promise<void>
  goBack(): void
  goForward(): void
  reload(): void
  canGoBack(): boolean
  canGoForward(): boolean
  setZoomFactor(factor: number): void
  openDevTools(): void
  executeJavaScript(code: string): Promise<unknown>
}

interface BrowserPanelProps {
  sessionId: string
}

const ZOOM_MIN = 0.25
const ZOOM_MAX = 2
const ZOOM_STEP = 0.1

function clampZoom(z: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(z * 100) / 100))
}

// --- Inline SVG icons (24 viewBox, stroke currentColor — matches app style) ---

function IconChevronLeft(props: { className?: string }): React.JSX.Element {
  return (
    <svg
      className="h-4 w-4"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <path d="m15 18-6-6 6-6" />
    </svg>
  )
}

function IconChevronRight(props: { className?: string }): React.JSX.Element {
  return (
    <svg
      className="h-4 w-4"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <path d="m9 18 6-6-6-6" />
    </svg>
  )
}

function IconReload(props: { className?: string }): React.JSX.Element {
  return (
    <svg
      className="h-4 w-4"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
      <path d="M8 16H3v5" />
    </svg>
  )
}

/** Square with a filled bar on the right edge — zcode's "collapse pane" glyph. */
function IconPanelCollapse(props: { className?: string }): React.JSX.Element {
  return (
    <svg
      className="h-4 w-4"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <path d="M15 3v18" />
      <path d="m9 15-3-3 3-3" />
    </svg>
  )
}

/** Square with a filled left bar + arrow in — zcode's "expand pane" glyph. */
function IconPanelExpand(props: { className?: string }): React.JSX.Element {
  return (
    <svg
      className="h-4 w-4"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <path d="M9 3v18" />
      <path d="m15 9 3 3-3 3" />
    </svg>
  )
}

function IconMaximize(props: { className?: string }): React.JSX.Element {
  return (
    <svg
      className="h-4 w-4"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <path d="M8 3H5a2 2 0 0 0-2 2v3" />
      <path d="M21 8V5a2 2 0 0 0-2-2h-3" />
      <path d="M3 16v3a2 2 0 0 0 2 2h3" />
      <path d="M16 21h3a2 2 0 0 0 2-2v-3" />
    </svg>
  )
}

function IconMinimize(props: { className?: string }): React.JSX.Element {
  return (
    <svg
      className="h-4 w-4"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <path d="M8 3v3a2 2 0 0 1-2 2H3" />
      <path d="M21 8h-3a2 2 0 0 1-2-2V3" />
      <path d="M3 16h3a2 2 0 0 1 2 2v3" />
      <path d="M16 21v-3a2 2 0 0 1 2-2h3" />
    </svg>
  )
}

function IconMoreHorizontal(props: { className?: string }): React.JSX.Element {
  return (
    <svg
      className="h-4 w-4"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <circle cx="12" cy="12" r="1" />
      <circle cx="19" cy="12" r="1" />
      <circle cx="5" cy="12" r="1" />
    </svg>
  )
}

function IconClose(props: { className?: string }): React.JSX.Element {
  return (
    <svg
      className="h-4 w-4"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  )
}

function IconExternalLink(props: { className?: string }): React.JSX.Element {
  return (
    <svg
      className="h-4 w-4"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <path d="M15 3h6v6" />
      <path d="M10 14 21 3" />
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
    </svg>
  )
}

function IconDevtools(props: { className?: string }): React.JSX.Element {
  return (
    <svg
      className="h-4 w-4"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <path d="m8 6-6 6 6 6" />
      <path d="m16 6 6 6-6 6" />
    </svg>
  )
}

function IconGlobe(props: { className?: string }): React.JSX.Element {
  return (
    <svg
      className="h-4 w-4"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <circle cx="12" cy="12" r="10" />
      <path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" />
      <path d="M2 12h20" />
    </svg>
  )
}

function IconFitToWindow(props: { className?: string }): React.JSX.Element {
  return (
    <svg
      className="h-4 w-4"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <path d="M3 12h18" />
      <path d="m7 8-4 4 4 4" />
      <path d="m17 8 4 4-4 4" />
    </svg>
  )
}

function BrowserPanel({ sessionId }: BrowserPanelProps): React.JSX.Element {
  // Layout state lives in the store so App can react to `expanded`.
  // Width is a fraction of the content area — proportional at any window size.
  const collapsed = useBrowserStore((s) => s.collapsed)
  const expanded = useBrowserStore((s) => s.expanded)
  const fraction = useBrowserStore((s) => s.fraction)
  const toggleCollapse = useBrowserStore((s) => s.toggleCollapse)
  const toggleExpanded = useBrowserStore((s) => s.toggleExpanded)
  const setFraction = useBrowserStore((s) => s.setFraction)

  const containerRef = useRef<HTMLDivElement | null>(null)
  const webviewRef = useRef<WebviewElement | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const [addressValue, setAddressValue] = useState('about:blank')
  const [currentUrl, setCurrentUrl] = useState('about:blank')
  const [title, setTitle] = useState('')
  const [favicon, setFavicon] = useState('')
  const [faviconFailed, setFaviconFailed] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [canGoBack, setCanGoBack] = useState(false)
  const [canGoForward, setCanGoForward] = useState(false)
  const [zoom, setZoom] = useState(1)
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement | null>(null)

  // --- Webview lifecycle (created once per sessionId, never unmounted
  // while the panel is open — collapse only hides it with CSS) ---

  useEffect(() => {
    const container = containerRef.current
    if (!container) {
      console.error('[BrowserPanel] container ref is null — component not mounted properly')
      return
    }
    console.log(`[BrowserPanel] mount: sessionId=${sessionId}, creating webview...`)

    // Create webview imperatively — React 19 may not properly set attributes
    // on <webview> (a non-standard element without a dash). Creating it via
    // DOM API ensures Electron processes all attributes correctly.
    // All attributes must be set via setAttribute BEFORE appending to DOM.
    const wv = document.createElement('webview') as WebviewElement
    wv.setAttribute('partition', 'persist:lucid-browser')
    wv.setAttribute('src', 'about:blank')
    wv.setAttribute('allowpopups', '')
    wv.style.width = '100%'
    wv.style.height = '100%'
    wv.style.display = 'inline-flex'
    webviewRef.current = wv

    let attachRetryId: ReturnType<typeof setTimeout> | undefined
    // 5s timeout to detect if did-attach never fires (webviewTag not enabled?)
    const attachTimeoutId = setTimeout(() => {
      console.error('[BrowserPanel] did-attach did NOT fire within 5s')
    }, 5000)

    const handleDidAttach = (): void => {
      console.log('[BrowserPanel] did-attach event fired')
      if (attachTimeoutId) clearTimeout(attachTimeoutId)
      if (typeof wv.getWebContentsId !== 'function') return
      const reportId = (wcId: number): void => {
        if (wcId > 0) void window.api.browser.attachGuest(sessionId, wcId)
      }
      try {
        reportId(wv.getWebContentsId())
      } catch {
        // webContentsId may not be ready immediately — retry once.
        attachRetryId = setTimeout(() => {
          try {
            reportId(wv.getWebContentsId())
          } catch {
            /* give up — ensureGuest timeout will surface the failure */
          }
        }, 100)
      }
    }

    const handleDidNavigate = (e: Event): void => {
      const ev = e as unknown as { url: string }
      setCurrentUrl(ev.url)
      setAddressValue(ev.url)
      setCanGoBack(wv.canGoBack?.() ?? false)
      setCanGoForward(wv.canGoForward?.() ?? false)
    }

    const handlePageTitleUpdated = (e: Event): void => {
      setTitle((e as unknown as { title: string }).title)
    }
    const handleFaviconUpdated = (e: Event): void => {
      const ev = e as unknown as { favicons?: string[] }
      setFavicon(ev.favicons?.[0] ?? '')
      setFaviconFailed(false)
    }
    const handleStartLoading = (): void => setIsLoading(true)
    const handleStopLoading = (): void => {
      setIsLoading(false)
      setCanGoBack(wv.canGoBack?.() ?? false)
      setCanGoForward(wv.canGoForward?.() ?? false)
    }

    wv.addEventListener('did-attach', handleDidAttach)
    wv.addEventListener('did-navigate', handleDidNavigate as EventListener)
    wv.addEventListener('did-navigate-in-page', handleDidNavigate as EventListener)
    wv.addEventListener('page-title-updated', handlePageTitleUpdated as EventListener)
    wv.addEventListener('page-favicon-updated', handleFaviconUpdated as EventListener)
    wv.addEventListener('did-start-loading', handleStartLoading)
    wv.addEventListener('did-stop-loading', handleStopLoading)

    container.appendChild(wv)
    console.log('[BrowserPanel] webview appended to DOM')

    return (): void => {
      if (attachTimeoutId) clearTimeout(attachTimeoutId)
      if (attachRetryId) clearTimeout(attachRetryId)
      wv.removeEventListener('did-attach', handleDidAttach)
      wv.removeEventListener('did-navigate', handleDidNavigate as EventListener)
      wv.removeEventListener('did-navigate-in-page', handleDidNavigate as EventListener)
      wv.removeEventListener('page-title-updated', handlePageTitleUpdated as EventListener)
      wv.removeEventListener('page-favicon-updated', handleFaviconUpdated as EventListener)
      wv.removeEventListener('did-start-loading', handleStartLoading)
      wv.removeEventListener('did-stop-loading', handleStopLoading)
      try {
        container.removeChild(wv)
      } catch {
        /* already removed */
      }
      void window.api.browser.detachGuest(sessionId)
    }
  }, [sessionId])

  // Close the "more" dropdown on outside clicks.
  useEffect(() => {
    if (!menuOpen) return
    const onPointerDown = (e: PointerEvent<Document>): void => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false)
      }
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [menuOpen])

  // Apply zoom to the webview whenever it changes.
  useEffect(() => {
    try {
      webviewRef.current?.setZoomFactor?.(zoom)
    } catch {
      /* webview may not be ready — next zoom change retries */
    }
  }, [zoom])

  // --- Resize handle (drag the panel's left edge) ---

  const handleResizePointerDown = (e: PointerEvent<HTMLDivElement>): void => {
    if (collapsed || expanded) return
    e.preventDefault()
    const target = e.currentTarget
    target.setPointerCapture(e.pointerId)
    const startX = e.clientX
    const contentW = rootRef.current?.parentElement?.clientWidth ?? 0
    if (contentW <= 0) return
    const startPx = fraction * contentW
    const computeFraction = (clientX: number): number => {
      // Dragging the left edge leftwards widens the panel. Store as a
      // fraction so the split survives window resize / smaller windows.
      return (startPx + (startX - clientX)) / contentW
    }
    const onMove = (ev: PointerEvent<HTMLDivElement>): void => {
      setFraction(computeFraction(ev.clientX), false)
    }
    const onUp = (ev: PointerEvent<HTMLDivElement>): void => {
      target.releasePointerCapture(ev.pointerId)
      target.removeEventListener('pointermove', onMove)
      target.removeEventListener('pointerup', onUp)
      target.removeEventListener('pointercancel', onUp)
      // Persist the final fraction (onMove's store updates skipped persistence).
      setFraction(computeFraction(ev.clientX), true)
    }
    target.addEventListener('pointermove', onMove)
    target.addEventListener('pointerup', onUp)
    target.addEventListener('pointercancel', onUp)
  }

  // --- Zoom ---

  const zoomIn = (): void => setZoom((z) => clampZoom(z + ZOOM_STEP))
  const zoomOut = (): void => setZoom((z) => clampZoom(z - ZOOM_STEP))
  const resetZoom = (): void => setZoom(1)

  /** Fit the page's full content width into the visible panel. */
  const fitToWindow = (): void => {
    const wv = webviewRef.current
    const panelW = containerRef.current?.clientWidth ?? 0
    if (!wv || panelW === 0) return
    void wv
      .executeJavaScript(
        'Math.max(document.documentElement.scrollWidth, document.body ? document.body.scrollWidth : 0)'
      )
      .then((raw) => {
        const scrollW = typeof raw === 'number' ? raw : 0
        if (scrollW > 0 && scrollW > panelW) setZoom(clampZoom(panelW / scrollW))
        else if (scrollW > 0 && scrollW <= panelW) setZoom(1)
      })
      .catch(() => {
        /* page may not be ready */
      })
  }

  // --- Toolbar actions ---

  const handleGoBack = (): void => {
    webviewRef.current?.goBack()
  }
  const handleGoForward = (): void => {
    webviewRef.current?.goForward()
  }
  const handleReload = (): void => {
    webviewRef.current?.reload()
  }

  const handleSubmit = (e: FormEvent<HTMLFormElement>): void => {
    e.preventDefault()
    const url = addressValue.trim()
    if (!url) return
    const normalized = /^https?:\/\//i.test(url) ? url : `https://${url}`
    void webviewRef.current?.loadURL?.(normalized)
  }

  const handleOpenExternal = (): void => {
    if (currentUrl && currentUrl !== 'about:blank') {
      window.open(currentUrl, '_blank')
    }
  }

  const handleOpenDevtools = (): void => {
    try {
      webviewRef.current?.openDevTools?.()
    } catch {
      /* guest not ready */
    }
  }

  const handleClose = (): void => {
    void window.api.browser.close(sessionId)
  }

  // --- Render ---

  const panelStyle: React.CSSProperties = collapsed
    ? { width: 40 }
    : expanded
      ? { width: '100%' }
      : { width: `${(fraction * 100).toFixed(1)}%` }

  return (
    <div
      ref={rootRef}
      className="relative flex h-full flex-shrink-0 border-l border-stone-200 bg-white"
      style={panelStyle}
    >
      {/* Drag-resize handle on the left edge */}
      {!collapsed && !expanded && (
        <div
          role="separator"
          aria-orientation="vertical"
          onPointerDown={handleResizePointerDown}
          className="absolute inset-y-0 left-0 z-10 w-1 cursor-ew-resize bg-transparent transition-colors hover:bg-stone-300"
          title="拖拽调整浏览器宽度"
        />
      )}

      {/* Full panel chrome — hidden (not unmounted) when collapsed so the
          webview guest keeps running and CDP automation keeps working. */}
      <div className={collapsed ? 'hidden' : 'flex h-full min-w-0 flex-1 flex-col'}>
        {/* Title bar — page title + lifecycle actions */}
        <div className="flex h-9 flex-shrink-0 items-center gap-2 border-b border-stone-100 px-2">
          <div className="flex min-w-0 flex-1 items-center gap-2 pl-1">
            {favicon && !faviconFailed ? (
              <img
                src={favicon}
                alt=""
                onError={() => setFaviconFailed(true)}
                className="h-4 w-4 flex-shrink-0 rounded-sm"
              />
            ) : (
              <IconGlobe className="h-4 w-4 flex-shrink-0 text-stone-400" />
            )}
            <span className="truncate text-xs font-medium text-stone-600" title={title}>
              {title || '浏览器'}
            </span>
            {isLoading && (
              <span className="h-3 w-3 flex-shrink-0 animate-spin rounded-full border-2 border-stone-200 border-t-blue-500" />
            )}
          </div>
          {/* Collapse */}
          <button
            type="button"
            onClick={toggleCollapse}
            className="flex h-7 w-7 items-center justify-center rounded-md text-stone-500 hover:bg-stone-100"
            title="收起浏览器"
          >
            <IconPanelCollapse />
          </button>
          {/* Expand / restore */}
          <button
            type="button"
            onClick={toggleExpanded}
            className="flex h-7 w-7 items-center justify-center rounded-md text-stone-500 hover:bg-stone-100"
            title={expanded ? '恢复浏览器' : '扩大浏览器'}
          >
            {expanded ? <IconMinimize /> : <IconMaximize />}
          </button>
          {/* More actions */}
          <div ref={menuRef} className="relative">
            <button
              type="button"
              onClick={() => setMenuOpen((v) => !v)}
              className="flex h-7 w-7 items-center justify-center rounded-md text-stone-500 hover:bg-stone-100"
              title="更多浏览器操作"
            >
              <IconMoreHorizontal />
            </button>
            {menuOpen && (
              <div className="absolute right-0 top-8 z-20 w-44 rounded-lg border border-stone-200 bg-white py-1 shadow-lg">
                <button
                  type="button"
                  onClick={() => {
                    setMenuOpen(false)
                    handleOpenExternal()
                  }}
                  disabled={!currentUrl || currentUrl === 'about:blank'}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-stone-600 hover:bg-stone-50 disabled:opacity-40"
                >
                  <IconExternalLink className="h-3.5 w-3.5" />
                  在默认浏览器中打开
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setMenuOpen(false)
                    handleOpenDevtools()
                  }}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-stone-600 hover:bg-stone-50"
                >
                  <IconDevtools className="h-3.5 w-3.5" />
                  打开调试工具
                </button>
              </div>
            )}
          </div>
          {/* Close */}
          <button
            type="button"
            onClick={handleClose}
            className="flex h-7 w-7 items-center justify-center rounded-md text-stone-500 hover:bg-stone-100"
            title="关闭浏览器面板"
          >
            <IconClose />
          </button>
        </div>

        {/* Navigation toolbar */}
        <form
          className="flex h-10 flex-shrink-0 items-center gap-1.5 border-b border-stone-200 px-2"
          onSubmit={handleSubmit}
        >
          <button
            type="button"
            onClick={handleGoBack}
            disabled={!canGoBack}
            className="flex h-7 w-7 items-center justify-center rounded-md text-stone-600 hover:bg-stone-100 disabled:cursor-default disabled:opacity-30"
            title="后退"
          >
            <IconChevronLeft />
          </button>
          <button
            type="button"
            onClick={handleGoForward}
            disabled={!canGoForward}
            className="flex h-7 w-7 items-center justify-center rounded-md text-stone-600 hover:bg-stone-100 disabled:cursor-default disabled:opacity-30"
            title="前进"
          >
            <IconChevronRight />
          </button>
          <button
            type="button"
            onClick={handleReload}
            className="flex h-7 w-7 items-center justify-center rounded-md text-stone-600 hover:bg-stone-100"
            title="刷新"
          >
            <IconReload className={`h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} />
          </button>
          {/* Address bar */}
          <div className="relative min-w-0 flex-1">
            <input
              type="text"
              value={addressValue}
              onChange={(e) => setAddressValue(e.target.value)}
              placeholder="输入网址后回车"
              spellCheck={false}
              className="h-7 w-full rounded-full border border-stone-200 bg-stone-50 px-4 text-center text-xs text-stone-700 outline-none focus:border-blue-300 focus:bg-white focus:text-left"
            />
          </div>
          {/* Zoom controls */}
          <button
            type="button"
            onClick={zoomOut}
            className="flex h-7 w-7 items-center justify-center rounded-md text-stone-600 hover:bg-stone-100"
            title="缩小"
          >
            <svg
              className="h-4 w-4"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M5 12h14" />
            </svg>
          </button>
          <button
            type="button"
            onClick={resetZoom}
            className="h-7 min-w-[3rem] rounded-md px-1 text-center text-xs tabular-nums text-stone-600 hover:bg-stone-100"
            title="恢复 100%"
          >
            {Math.round(zoom * 100)}%
          </button>
          <button
            type="button"
            onClick={zoomIn}
            className="flex h-7 w-7 items-center justify-center rounded-md text-stone-600 hover:bg-stone-100"
            title="放大"
          >
            <svg
              className="h-4 w-4"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M5 12h14" />
              <path d="M12 5v14" />
            </svg>
          </button>
          <button
            type="button"
            onClick={fitToWindow}
            className="flex h-7 w-7 items-center justify-center rounded-md text-stone-600 hover:bg-stone-100"
            title="适应窗口宽度"
          >
            <IconFitToWindow />
          </button>
        </form>

        {/* Webview surface — persistent container, never unmounted */}
        <div ref={containerRef} className="relative min-h-0 flex-1 overflow-hidden bg-white" />
      </div>

      {/* Collapsed strip — click to re-expand. Webview stays alive in the
          hidden chrome above, so agent automation is unaffected. */}
      {collapsed && (
        <button
          type="button"
          onClick={toggleCollapse}
          className="flex h-full w-10 flex-col items-center gap-3 border-l border-stone-200 pt-3 text-stone-500 hover:bg-stone-50 hover:text-stone-700"
          title="打开浏览器"
        >
          <IconPanelExpand />
          <span
            className="text-xs font-medium"
            style={{ writingMode: 'vertical-rl', letterSpacing: '0.25em' }}
          >
            浏览器
          </span>
        </button>
      )}
    </div>
  )
}

export default BrowserPanel
