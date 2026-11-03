import { useSessionStore } from '../../store/sessionStore'

function MenuBar(): React.JSX.Element {
  const createSession = useSessionStore((s) => s.createSession)

  return (
    <button
      onClick={() => void createSession()}
      className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-stone-700 transition-colors hover:bg-stone-200"
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        className="h-4 w-4"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
      >
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
      </svg>
      新建任务
    </button>
  )
}

export default MenuBar
