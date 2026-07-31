import { useState } from "react";

export interface QueueItem {
  content: string;
  mode: string;
  addedAt: number;
}

interface QueueListProps {
  items: QueueItem[];
  onSteer: (content: string) => void;
  onDismiss?: (content: string) => void;
}

export function QueueList({ items, onSteer, onDismiss }: QueueListProps) {
  if (items.length === 0) return null;

  return (
    <div className="mb-2 flex flex-col gap-1.5" role="region" aria-label="排队任务列表">
      {items.map((item, i) => (
        <QueueRow key={`${item.addedAt}-${i}`} item={item} onSteer={onSteer} onDismiss={onDismiss} />
      ))}
    </div>
  );
}

interface QueueRowProps {
  item: QueueItem;
  onSteer: (content: string) => void;
  onDismiss?: (content: string) => void;
}

function QueueRow({ item, onSteer, onDismiss }: QueueRowProps) {
  const [steering, setSteering] = useState(false);
  const [steered, setSteered] = useState(false);

  const handleSteer = async () => {
    setSteering(true);
    try {
      await onSteer(item.content);
      setSteered(true);
    } finally {
      setSteering(false);
    }
  };

  return (
    <div
      className="glass rounded-lg px-3 py-2 flex items-center gap-2 text-xs"
      style={{ opacity: steering || steered ? 0.6 : 1 }}
    >
      <span
        className="w-1.5 h-1.5 rounded-full bg-[var(--color-warning)] shrink-0 animate-pulse-cyan"
        aria-hidden="true"
      />
      <span className="text-[var(--color-text-tertiary)] font-mono shrink-0">
        {steered ? "已补充" : "排队"}
      </span>
      <span className="flex-1 truncate text-[var(--color-text-secondary)]" title={item.content}>
        {item.content}
      </span>
      {steered ? (
        <span className="text-[var(--color-text-tertiary)] font-mono shrink-0">✓</span>
      ) : (
        <>
          <button
            onClick={handleSteer}
            disabled={steering}
            className="shrink-0 px-2 py-0.5 rounded text-[0.65rem] font-mono
                       bg-[var(--color-warning)]/15 text-[var(--color-warning)]
                       hover:bg-[var(--color-warning)]/25
                       disabled:opacity-50 disabled:cursor-wait
                       transition-all"
            aria-label="信息补充"
            type="button"
          >
            {steering ? "补充中…" : "信息补充"}
          </button>
          {onDismiss && (
            <button
              onClick={() => onDismiss(item.content)}
              disabled={steering}
              className="shrink-0 w-5 h-5 rounded text-[var(--color-text-tertiary)]
                         hover:text-[var(--color-error)] hover:bg-[var(--color-error)]/10
                         disabled:opacity-50
                         transition-all flex items-center justify-center"
              aria-label="从队列移除"
              type="button"
              title="从队列移除"
            >
              <svg className="w-3 h-3" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M5 5l10 10M15 5L5 15" />
              </svg>
            </button>
          )}
        </>
      )}
    </div>
  );
}
