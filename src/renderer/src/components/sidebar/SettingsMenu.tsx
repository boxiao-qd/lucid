interface SettingsMenuProps {
  onOpenModelSettings: () => void
}

function SettingsMenu({ onOpenModelSettings }: SettingsMenuProps): React.JSX.Element {
  return (
    <div className="absolute bottom-full left-0 right-0 mb-1 z-50 overflow-hidden rounded-lg border border-stone-200 bg-white py-1 shadow-lg">
      <button
        onClick={onOpenModelSettings}
        className="flex w-full items-center gap-2.5 px-3 py-2 text-sm text-stone-700 transition-colors hover:bg-stone-100"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          className="h-4 w-4 text-stone-500"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <rect x="4" y="4" width="16" height="16" rx="2" />
          <rect x="9" y="9" width="6" height="6" />
          <path d="M9 2v2M9 20v2M15 2v2M15 20v2M2 9h2M2 15h2M20 9h2M20 15h2" />
        </svg>
        模型设置
      </button>
    </div>
  )
}

export default SettingsMenu
