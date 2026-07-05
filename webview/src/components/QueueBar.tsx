import { useState } from "react";
import { useStore } from "../store/store";

export function QueueBar(): React.ReactElement | null {
  const queuedMessages = useStore((s) => s.queuedMessages);
  const removeQueuedMessage = useStore((s) => s.removeQueuedMessage);
  const [expanded, setExpanded] = useState(false);

  if (queuedMessages.length === 0) return null;
  const first = queuedMessages[0];
  const more = queuedMessages.length - 1;

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
              <button
                className="queue-item-remove"
                title="Remove from queue"
                aria-label="Remove from queue"
                onClick={() => removeQueuedMessage(q.id)}
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
          onClick={() => removeQueuedMessage(first.id)}
        >
          ✕
        </button>
      </div>
    </div>
  );
}
