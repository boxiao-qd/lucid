// SecurityModeToggle — switch between Safe / Unrestricted mode.
// In unrestricted mode, terminal and code_execute auto-approve without
// showing the confirmation dialog, and the workspace path boundary check
// is lifted so tools can read/write files outside ~/.lucid/workspace/.

import { useState, useRef, useEffect } from 'react'
import { useSettingsStore } from '../store/settingsStore'

function SecurityModeToggle(): React.JSX.Element {
  const securityMode = useSettingsStore((s) => s.securityMode)
  const setSecurityMode = useSettingsStore((s) => s.setSecurityMode)

  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onClick = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [open])

  const isUnrestricted = securityMode === 'unrestricted'

  const handleSelect = (mode: 'safe' | 'unrestricted'): void => {
    void setSecurityMode(mode)
    setOpen(false)
  }

  // Shield icon
  const ShieldIcon = (): React.JSX.Element => (
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
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    </svg>
  )

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className={`flex items-center gap-1 rounded-md px-2 py-1 text-xs transition-colors hover:bg-stone-100 ${
          isUnrestricted ? 'text-red-600' : 'text-stone-500'
        }`}
      >
        <ShieldIcon />
        <span>{isUnrestricted ? '无限制模式' : '安全模式'}</span>
        <span className="select-none text-stone-400">{open ? '▴' : '▾'}</span>
      </button>

      {open && (
        <div className="absolute bottom-full left-0 z-50 mb-1 w-[260px] rounded-lg border border-stone-200 bg-white py-1 shadow-lg">
          <button
            onClick={() => handleSelect('safe')}
            className="flex w-full flex-col items-start px-3 py-2 text-left hover:bg-stone-50"
          >
            <div className="flex w-full items-center justify-between text-xs font-medium text-stone-700">
              <span>安全模式</span>
              {securityMode === 'safe' && <span className="text-stone-400">✓</span>}
            </div>
            <div className="mt-0.5 text-[11px] leading-tight text-stone-400">
              执行命令和代码前需要确认；读写限定在 workspace 内
            </div>
          </button>
          <button
            onClick={() => handleSelect('unrestricted')}
            className="flex w-full flex-col items-start px-3 py-2 text-left hover:bg-stone-50"
          >
            <div className="flex w-full items-center justify-between text-xs font-medium text-stone-700">
              <span>无限制模式</span>
              {isUnrestricted && <span className="text-red-500">✓</span>}
            </div>
            <div className="mt-0.5 text-[11px] leading-tight text-stone-400">
              直接执行命令和代码，无需确认；可读写 workspace 外的文件
            </div>
          </button>
        </div>
      )}
    </div>
  )
}

export default SecurityModeToggle
