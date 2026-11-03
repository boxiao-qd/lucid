import { useEffect, useState } from 'react'

export default function WindowControls(): React.JSX.Element | null {
  const [isMax, setIsMax] = useState(false)

  useEffect(() => {
    if (window.api.platform !== 'win32') return
    void window.api.window.isMaximized().then(setIsMax)
    const interval = setInterval(() => {
      void window.api.window.isMaximized().then(setIsMax)
    }, 500)
    return () => clearInterval(interval)
  }, [])

  if (window.api.platform !== 'win32') return null

  return (
    <div
      className="flex h-full items-center"
      style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
    >
      <button
        onClick={() => void window.api.window.minimize()}
        className="flex h-9 w-12 items-center justify-center text-stone-500 hover:bg-stone-200/70"
        title="最小化"
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
          <rect x="1.5" y="5.5" width="9" height="1.2" fill="currentColor" />
        </svg>
      </button>
      <button
        onClick={() => void window.api.window.toggleMaximize()}
        className="flex h-9 w-12 items-center justify-center text-stone-500 hover:bg-stone-200/70"
        title={isMax ? '还原' : '最大化'}
      >
        {isMax ? (
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <rect
              x="2.4"
              y="1.5"
              width="7"
              height="7"
              stroke="currentColor"
              strokeWidth="1.1"
              fill="none"
            />
            <rect
              x="1.5"
              y="2.6"
              width="7"
              height="7"
              fill="white"
              stroke="currentColor"
              strokeWidth="1.1"
            />
          </svg>
        ) : (
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <rect
              x="1.5"
              y="1.5"
              width="9"
              height="9"
              stroke="currentColor"
              strokeWidth="1.1"
              fill="none"
            />
          </svg>
        )}
      </button>
      <button
        onClick={() => void window.api.window.close()}
        className="flex h-9 w-12 items-center justify-center text-stone-500 hover:bg-red-500 hover:text-white"
        title="关闭"
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
          <path
            d="M2 2 L10 10 M10 2 L2 10"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinecap="round"
          />
        </svg>
      </button>
    </div>
  )
}
