import { useState } from "react";
import { useStore, type QueuedMessage } from "../store/store";
import { postMessage } from "../api/vscodeApi";

export function QueueBar(): React.ReactElement | null {
  const sessionId = useStore((s) => s.activeSessionId);
  const queuedMessages = useStore((s) =>
    sessionId ? (s.queuedMessagesBySession[sessionId] ?? []) : [],
  );
  const removeQueuedMessage = useStore((s) => s.removeQueuedMessage);
  const reorderQueuedMessages = useStore((s) => s.reorderQueuedMessages);
  const setDraft = useStore((s) => s.setDraft);
  const [expanded, setExpanded] = useState(false);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);

  if (queuedMessages.length === 0) return null;
  const total = queuedMessages.length;
  const visible = expanded ? queuedMessages : queuedMessages.slice(0, 1);
  const hidden = total - visible.length;

  // Send straight to the server now — same "send now" path as the composer's
  // force button, reusing the context/options/attachments captured at enqueue
  // time so the message goes out exactly as it was queued.
  const forceSendQueued = (q: QueuedMessage) => {
    if (!sessionId) return;
    postMessage({
      type: "sendMessage",
      sessionId,
      text: q.text,
      context: q.context,
      options: q.options,
      attachments: q.attachments,
    });
    removeQueuedMessage(sessionId, q.id);
  };

  // Hand the message back to the composer for editing.
  const editQueued = (q: QueuedMessage) => {
    if (!sessionId) return;
    setDraft(sessionId, q.text);
    removeQueuedMessage(sessionId, q.id);
  };

  const onDrop = (targetId: string) => {
    if (sessionId && dragId && dragId !== targetId) {
      reorderQueuedMessages(sessionId, dragId, targetId);
    }
    setDragId(null);
    setOverId(null);
  };

  return (
    <div className={`queue-bar ${expanded ? "open" : ""}`}>
      <div className="queue-bar-head">
        <span className="queue-bar-label">
          Queued · {total}
          <span className="queue-bar-hint" title="Sent when the agent finishes its answer">
            sent after the current turn
          </span>
        </span>
        {total > 1 && (
          <button
            className="queue-bar-toggle"
            title={expanded ? "Collapse to next message" : `Show all ${total}`}
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded ? "Collapse" : `Show all ${total}`}
          </button>
        )}
      </div>

      <div className="queue-list">
        {visible.map((q, i) => (
          <div
            key={q.id}
            className={`queue-card${dragId === q.id ? " dragging" : ""}${overId === q.id ? " drag-over" : ""}`}
            draggable={expanded && total > 1}
            onDragStart={() => setDragId(q.id)}
            onDragEnd={() => {
              setDragId(null);
              setOverId(null);
            }}
            onDragOver={(e) => {
              if (!dragId || dragId === q.id) return;
              e.preventDefault();
              setOverId(q.id);
            }}
            onDrop={() => onDrop(q.id)}
          >
            {expanded && total > 1 && (
              <span className="queue-card-grip" title="Drag to reorder" aria-hidden="true">
                <span className="codicon codicon-gripper" />
              </span>
            )}
            <span className="queue-card-index" aria-hidden="true">
              {i + 1}
            </span>
            <span className="queue-card-text">{q.text}</span>
            <div className="queue-card-actions">
              <button
                type="button"
                className="queue-item-action"
                title="Send now"
                aria-label="Send now"
                onClick={() => forceSendQueued(q)}
              >
                <span className="codicon codicon-send" aria-hidden="true" />
              </button>
              <button
                type="button"
                className="queue-item-action"
                title="Edit in composer"
                aria-label="Edit in composer"
                onClick={() => editQueued(q)}
              >
                <span className="codicon codicon-edit" aria-hidden="true" />
              </button>
              <button
                type="button"
                className="queue-item-action queue-item-action-danger"
                title="Remove from queue"
                aria-label="Remove from queue"
                onClick={() => sessionId && removeQueuedMessage(sessionId, q.id)}
              >
                <span className="codicon codicon-close" aria-hidden="true" />
              </button>
            </div>
          </div>
        ))}
        {!expanded && hidden > 0 && (
          <button className="queue-more" onClick={() => setExpanded(true)}>
            +{hidden} more queued
          </button>
        )}
      </div>
    </div>
  );
}
