import { useSessionStore } from '../../store/sessionStore'

function SessionList(): React.JSX.Element {
  const sessions = useSessionStore((s) => s.sessions)
  const currentId = useSessionStore((s) => s.currentId)
  const selectSession = useSessionStore((s) => s.selectSession)
  const deleteSession = useSessionStore((s) => s.deleteSession)

  const handleDelete = (e: React.MouseEvent, id: string): void => {
    e.stopPropagation()
    void deleteSession(id)
  }

  return (
    <div className="flex-1 overflow-y-auto p-2">
      {sessions.length === 0 ? (
        <div className="flex h-full items-center justify-center text-sm text-stone-400">
          暂无会话
        </div>
      ) : (
        <ul className="space-y-1">
          {sessions.map((s) => (
            <li
              key={s.id}
              onClick={() => void selectSession(s.id)}
              className={`group flex cursor-pointer items-center justify-between rounded-md px-3 py-2 text-sm transition-colors hover:bg-stone-200 ${
                s.id === currentId ? 'bg-stone-200 font-medium' : ''
              }`}
            >
              <span className="truncate">{s.title}</span>
              <button
                onClick={(e) => handleDelete(e, s.id)}
                className="ml-2 flex-shrink-0 rounded p-0.5 text-stone-400 opacity-0 transition-opacity hover:text-stone-700 group-hover:opacity-100"
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
                  <polyline points="3 6 5 6 21 6" />
                  <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                </svg>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export default SessionList
