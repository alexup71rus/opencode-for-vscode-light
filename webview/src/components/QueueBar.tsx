import { useState } from "react";
import { useStore, type QueuedMessage } from "../store/store";
import { postMessage } from "../api/vscodeApi";

export function QueueBar(): React.ReactElement | null {
  const sessionId = useStore((s) => s.activeSessionId);
  const queuedMessages = useStore((s) =>
    sessionId ? (s.queuedMessagesBySession[sessionId] ?? []) : [],
  );
  const removeQueuedMessage = useStore((s) => s.removeQueuedMessage);
  const setDraft = useStore((s) => s.setDraft);
  const [expanded, setExpanded] = useState(false);

  if (queuedMessages.length === 0) return null;
  const first = queuedMessages[0];
  const more = queuedMessages.length - 1;

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

  const actions = (q: QueuedMessage) => (
    <>
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
    </>
  );

  if (expanded) {
    return (
      <div className="queue-bar open">
        <div className="queue-bar-head">
          <span className="queue-bar-label">Queued · {queuedMessages.length}</span>
          <button
            className="queue-bar-toggle"
            title="Collapse to one line"
            onClick={() => setExpanded(false)}
          >
            Collapse
          </button>
        </div>
        <div className="queue-bar-items">
          {queuedMessages.map((q) => (
            <div key={q.id} className="queue-item">
              <span className="queue-item-text">{q.text}</span>
              {actions(q)}
              <button
                className="queue-item-remove"
                title="Remove from queue"
                aria-label="Remove from queue"
                onClick={() => sessionId && removeQueuedMessage(sessionId, q.id)}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="queue-bar">
      <div className="queue-item queue-item-single">
        <span className="queue-bar-pill" title={`Queued — sent when the agent finishes its answer`}>
          Queued · {queuedMessages.length}
        </span>
        <span className="queue-item-text">{first.text}</span>
        {actions(first)}
        <button
          className="queue-bar-toggle"
          title={more > 0 ? `Show ${more} more` : "Expand"}
          onClick={() => setExpanded(true)}
        >
          {more > 0 ? `+${more} more` : "Expand"}
        </button>
        <button
          className="queue-item-remove"
          title="Remove from queue"
          aria-label="Remove from queue"
          onClick={() => sessionId && removeQueuedMessage(sessionId, first.id)}
        >
          ✕
        </button>
      </div>
    </div>
  );
}
