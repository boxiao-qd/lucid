import { useState, useRef, useEffect } from 'react'
import SettingsMenu from './SettingsMenu'
import ModelSettingsModal from '../settings/ModelSettingsModal'

function SettingsButton(): React.JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false)
  const [modalOpen, setModalOpen] = useState(false)
  const wrapperRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!menuOpen) return
    const handleClick = (e: MouseEvent): void => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [menuOpen])

  return (
    <div ref={wrapperRef} className="relative flex-shrink-0 border-t border-stone-200 p-3">
      <button
        onClick={() => setMenuOpen((v) => !v)}
        className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-stone-700 transition-colors hover:bg-stone-200"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          className="h-4 w-4"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37z"
          />
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
          />
        </svg>
        设置
      </button>

      {menuOpen && (
        <SettingsMenu
          onOpenModelSettings={() => {
            setMenuOpen(false)
            setModalOpen(true)
          }}
        />
      )}

      {modalOpen && <ModelSettingsModal onClose={() => setModalOpen(false)} />}
    </div>
  )
}

export default SettingsButton
