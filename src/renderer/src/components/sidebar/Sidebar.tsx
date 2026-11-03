import MenuBar from './MenuBar'
import SessionList from './SessionList'
import SettingsButton from './SettingsButton'
import { useUIStore } from '../../store/uiStore'

function Sidebar(): React.JSX.Element {
  const view = useUIStore((s) => s.view)
  const setView = useUIStore((s) => s.setView)

  return (
    <aside className="flex h-full w-64 flex-col border-r border-stone-200 bg-stone-50">
      <div className="flex flex-shrink-0 flex-col gap-1 border-b border-stone-200 p-2">
        <MenuBar />
        <button
          onClick={() => setView(view === 'files' ? 'chat' : 'files')}
          className={`flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors hover:bg-stone-200 ${
            view === 'files' ? 'bg-stone-200 font-medium text-stone-800' : 'text-stone-700'
          }`}
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
              d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"
            />
          </svg>
          我的文件
        </button>
        <button
          onClick={() => setView(view === 'skills' ? 'chat' : 'skills')}
          className={`flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors hover:bg-stone-200 ${
            view === 'skills' ? 'bg-stone-200 font-medium text-stone-800' : 'text-stone-700'
          }`}
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
              d="M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-5.714 2.143L13 21l-2.286-6.857L5 12l5.714-2.143L13 3z"
            />
          </svg>
          马克战甲
        </button>
        <button
          onClick={() => setView(view === 'extensions' ? 'chat' : 'extensions')}
          className={`flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors hover:bg-stone-200 ${
            view === 'extensions' ? 'bg-stone-200 font-medium text-stone-800' : 'text-stone-700'
          }`}
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
              d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4"
            />
          </svg>
          智能体扩展
        </button>
        <button
          onClick={() => setView(view === 'scheduled-tasks' ? 'chat' : 'scheduled-tasks')}
          className={`flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors hover:bg-stone-200 ${
            view === 'scheduled-tasks'
              ? 'bg-stone-200 font-medium text-stone-800'
              : 'text-stone-700'
          }`}
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
              d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
            />
          </svg>
          定时任务
        </button>
        <button
          onClick={() => setView(view === 'trace' ? 'chat' : 'trace')}
          className={`flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors hover:bg-stone-200 ${
            view === 'trace' ? 'bg-stone-200 font-medium text-stone-800' : 'text-stone-700'
          }`}
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
              d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"
            />
          </svg>
          智能体行为
        </button>
      </div>
      <SessionList />
      <SettingsButton />
    </aside>
  )
}

export default Sidebar
