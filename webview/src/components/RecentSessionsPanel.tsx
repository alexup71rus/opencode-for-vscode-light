import { useStore } from "../store/store";
import { postMessage } from "../api/vscodeApi";
import { timeAgo } from "../utils";

export function RecentSessionsPanel(): React.ReactElement | null {
  const sessions = useStore((s) => s.sessions);
  const pinnedSessions = useStore((s) => s.pinnedSessions);
  const hidden = useStore((s) => s.recentPanelHidden);
  const setRecentPanelHidden = useStore((s) => s.setRecentPanelHidden);

  if (hidden) return null;

  const pinnedSet = new Set(pinnedSessions);
  const ordered = [
    ...sessions.filter((s) => pinnedSet.has(s.id)).sort((a, b) => b.time.updated - a.time.updated),
    ...sessions.filter((s) => !pinnedSet.has(s.id)).sort((a, b) => b.time.updated - a.time.updated),
  ].slice(0, 3);

  if (ordered.length === 0) return null;

  return (
    <div className="recent-panel">
      <div className="recent-panel-head">
        <span className="recent-panel-title">Recent</span>
        <button
          className="recent-panel-close"
          title="Hide recent sessions (visible again from Settings)"
          aria-label="Hide recent sessions"
          onClick={() => setRecentPanelHidden(true)}
        >
          ✕
        </button>
      </div>
      <ul className="recent-panel-list">
        {ordered.map((s) => (
          <li key={s.id}>
            <button
              className="recent-panel-item"
              onClick={() => postMessage({ type: "openSession", sessionId: s.id })}
              title={s.title || "Untitled"}
            >
              <span className="recent-panel-item-title">{s.title || "Untitled"}</span>
              <span className="recent-panel-item-time">{timeAgo(s.time.updated)}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
