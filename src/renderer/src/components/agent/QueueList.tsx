// QueueList — shows queued tasks with steer + dismiss buttons.
// Queue list component — adapted to lucid stone palette.

import type { QueueItem } from '../../store/agentStore'

interface QueueListProps {
  items: QueueItem[]
  onSteer: (content: string) => void
  onDismiss: (content: string) => void
}

function QueueList({ items, onSteer, onDismiss }: QueueListProps): React.JSX.Element {
  if (items.length === 0) return <></>

  return (
    <div className="flex flex-col gap-2">
      {items.map((item, idx) => (
        <div
          key={idx}
          className="flex items-center gap-3 rounded-lg border border-stone-200 bg-stone-50 px-4 py-2.5"
        >
          <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-stone-400" />
          <span className="text-xs font-medium text-stone-400">排队</span>
          <span className="flex-1 truncate text-sm text-stone-600">{item.content}</span>
          {item.steered ? (
            <span className="text-xs text-stone-400">已补充 ✓</span>
          ) : (
            <button
              onClick={() => onSteer(item.content)}
              className="rounded bg-stone-200 px-2 py-0.5 text-xs text-stone-600 hover:bg-stone-300"
            >
              信息补充
            </button>
          )}
          <button
            onClick={() => onDismiss(item.content)}
            className="text-stone-400 hover:text-stone-700"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  )
}

export default QueueList
