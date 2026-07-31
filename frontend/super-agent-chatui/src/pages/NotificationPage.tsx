import { useEffect } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { useNotificationStore } from "@/store/notification-store";
import { getAccessToken } from "@/services/api-client";

const remarkPlugins = [remarkGfm];
const rehypePlugins = [rehypeHighlight];

function getFileIcon(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  const icons: Record<string, string> = {
    pptx: "📊", ppt: "📊", md: "📝", pdf: "📄", xlsx: "📈", xls: "📈",
    csv: "📋", docx: "📃", doc: "📃", txt: "📝", json: "📋",
    html: "🌐", png: "🖼️", jpg: "🖼️", jpeg: "🖼️", gif: "🖼️", svg: "🖼️",
    py: "🐍", js: "📜", ts: "📜", zip: "📦", xml: "📋",
  };
  return icons[ext] ?? "📎";
}

async function downloadFile(fileId: string, fileName: string) {
  const token = getAccessToken();
  const headers: Record<string, string> = {};
  if (token) headers["Authorization"] = `Bearer ${token}`;
  try {
    const resp = await fetch(`/bx/api/v1/files/${fileId}/download`, { headers });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ message: "Download failed" }));
      throw new Error(err.detail || err.message || `HTTP ${resp.status}`);
    }
    const blob = await resp.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  } catch (e) {
    alert(`Download failed: ${e instanceof Error ? e.message : "Unknown error"}`);
  }
}

export function NotificationPage() {
  const { notifications, loading, selectedId, fetchNotifications, markRead, markAllRead, deleteNotification, select } = useNotificationStore();

  useEffect(() => {
    fetchNotifications();
  }, []);

  const selectedNotif = notifications.find((n) => n.id === selectedId);

  return (
    <div className="flex h-full bg-[var(--color-surface)]">
      {/* ── List panel ───────────────────────────────────────────────── */}
      <div className="w-[320px] md:w-[360px] border-r border-[var(--color-border-dim)] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-[var(--color-border-dim)]">
          <h2 className="text-lg font-mono font-semibold text-[var(--color-text)]">
            Notifications
          </h2>
          {notifications.some((n) => n.is_read === 0) && (
            <button
              onClick={markAllRead}
              className="text-xs text-[var(--color-primary)] hover:underline font-mono"
            >
              Mark all read
            </button>
          )}
        </div>

        {/* List */}
        <div className="flex-1 overflow-y-auto">
          {loading && <p className="p-4 text-sm text-[var(--color-text-dim)] font-mono">Loading...</p>}
          {!loading && notifications.length === 0 && (
            <p className="p-4 text-sm text-[var(--color-text-dim)] font-mono">No notifications yet</p>
          )}
          {notifications.map((n) => (
            <button
              key={n.id}
              onClick={() => {
                select(n.id);
                if (n.is_read === 0) markRead(n.id);
              }}
              className={`w-full text-left p-3 border-b border-[var(--color-border-dim)]
                         hover:bg-[var(--color-surface-dark)] transition-colors
                         ${selectedId === n.id ? "bg-[var(--color-primary-dim)] border-l-[3px] border-l-[var(--color-primary)] pl-[9px]" : "border-l-[3px] border-l-transparent pl-3"}
                         ${n.is_read === 0 ? "font-semibold" : "opacity-70"}`}
            >
              <div className="flex items-start gap-2">
                {/* Unread dot */}
                {n.is_read === 0 && (
                  <span className="w-2 h-2 mt-1.5 rounded-full bg-[var(--color-primary)] shrink-0" />
                )}
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-mono text-[var(--color-text)] truncate">{n.title}</p>
                  <p className="text-xs text-[var(--color-text-dim)] font-mono mt-0.5">
                    {n.source === "cron" ? "Cron" : n.source} &middot; {new Date(n.created_at).toLocaleString()}
                  </p>
                </div>
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* ── Detail panel ───────────────────────────────────────────── */}
      <div className="flex-1 flex flex-col">
        {selectedNotif ? (
          <>
            <div className="flex items-center justify-between px-6 py-3 border-b border-[var(--color-border-dim)] bg-[var(--color-surface-dark)]">
              <div className="flex items-center gap-2">
                <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-primary)] shadow-[0_0_6px_rgba(0,229,255,0.4)]" />
                <h3 className="text-sm font-mono font-semibold text-[var(--color-primary)] tracking-wide uppercase">
                  {selectedNotif.title}
                </h3>
              </div>
              <button
                onClick={() => deleteNotification(selectedNotif.id)}
                className="text-xs text-[var(--color-text-tertiary)] hover:text-[var(--color-error)] font-mono transition-colors"
              >
                Delete
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-6">
              <div className="notif-detail">
                <div className="md-content max-w-none">
                  <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins}>
                    {selectedNotif.content}
                  </ReactMarkdown>
                </div>
              {selectedNotif.file_id && selectedNotif.file_name && (
                <div className="mt-6 rounded-lg border-2 border-[var(--color-primary)] bg-[var(--color-primary-dim)] p-4">
                  <div className="flex items-center gap-3">
                    <span className="text-2xl">
                      {getFileIcon(selectedNotif.file_name)}
                    </span>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs text-[var(--color-text-dim)] font-mono uppercase tracking-wide">
                        Attached File
                      </p>
                      <p className="text-sm font-mono font-semibold text-[var(--color-text)] truncate">
                        {selectedNotif.file_name}
                      </p>
                    </div>
                    <button
                      onClick={() => downloadFile(selectedNotif.file_id!, selectedNotif.file_name!)}
                      className="shrink-0 px-4 py-2 rounded-md bg-[var(--color-primary)] text-white text-sm font-mono font-semibold
                                 hover:brightness-110 active:scale-95 transition-all"
                    >
                      Download
                    </button>
                  </div>
                </div>
              )}
              {selectedNotif.file_id && !selectedNotif.file_name && (
                <div className="mt-6 rounded-lg border-2 border-[var(--color-primary)] bg-[var(--color-primary-dim)] p-4">
                  <div className="flex items-center gap-3">
                    <span className="text-2xl">📎</span>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs text-[var(--color-text-dim)] font-mono uppercase tracking-wide">
                        Attached File
                      </p>
                      <p className="text-sm font-mono text-[var(--color-text-dim)]">
                        File available for download
                      </p>
                    </div>
                    <button
                      onClick={() => downloadFile(selectedNotif.file_id!, "download")}
                      className="shrink-0 px-4 py-2 rounded-md bg-[var(--color-primary)] text-white text-sm font-mono font-semibold
                                 hover:brightness-110 active:scale-95 transition-all"
                    >
                      Download
                    </button>
                  </div>
                </div>
              )}
              </div>
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center">
              <p className="text-sm text-[var(--color-text-tertiary)] font-mono">Select a notification to view</p>
              <p className="text-xs text-[var(--color-text-tertiary)] font-mono mt-1 opacity-50">// awaiting input</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}