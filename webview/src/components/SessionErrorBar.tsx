import { useStore } from "../store/store";

interface Props {
  sessionId: string;
}

/**
 * Session-scoped status strip shown just above the composer. Surfaces two
 * things that are specific to the active chat (unlike the global app banner,
 * which is for system/connection failures):
 *
 *  - `retry`: the agent hit a transient error (e.g. network blip) and opencode
 *    is retrying the turn. Rendered as a calm "reconnecting" line so a dropped
 *    connection reads as recoverable rather than fatal.
 *  - session error: a `session.error` the server emitted for THIS session,
 *    dismissible and auto-cleared when the session next goes busy.
 */
export function SessionErrorBar({ sessionId }: Props): React.ReactElement | null {
  const status = useStore((s) => s.sessionStatus[sessionId]);
  const error = useStore((s) => s.sessionErrors[sessionId]);
  const dismissSessionError = useStore((s) => s.dismissSessionError);

  if (status?.type === "retry") {
    const attempt = status.attempt;
    return (
      <div className="session-strip session-strip-retry" role="status">
        <span className="session-strip-spinner" aria-hidden="true" />
        <span className="session-strip-text">
          Connection issue — retrying{attempt ? ` (attempt ${attempt})` : ""}…
          {status.message ? <span className="session-strip-detail"> {status.message}</span> : null}
        </span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="session-strip session-strip-error" role="alert">
        <span className="session-strip-icon" aria-hidden="true">⚠</span>
        <span className="session-strip-text">{error}</span>
        <button
          className="session-strip-dismiss"
          title="Dismiss"
          aria-label="Dismiss error"
          onClick={() => dismissSessionError(sessionId)}
        >
          ✕
        </button>
      </div>
    );
  }

  return null;
}
