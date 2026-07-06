import { useMemo } from "react";
import { useStore } from "../store/store";
import { postMessage } from "../api/vscodeApi";

interface PermissionOverlayProps {
  sessionId: string;
}

/**
 * Shows pending tool-call approvals as a bottom sheet over the composer,
 * mirroring QuestionOverlay. One approval is shown at a time (the oldest
 * pending); acting on it (Allow / Reject) replies and removes it, so the next
 * pending becomes current. Includes a circular Stop button (reuses .abort-btn)
 * that aborts the whole session — distinct from Reject, which only blocks the
 * individual call and lets the chat continue.
 *
 * Backed by the permission.asked event -> sessionService normalization, and
 * POST /session/:id/permissions/:permissionID via replyPermission.
 */
export function PermissionOverlay({ sessionId }: PermissionOverlayProps): React.ReactElement | null {
  const all = useStore((s) => s.pendingPermissions);
  const perms = useMemo(
    () => all.filter((p) => p.sessionID === sessionId),
    [all, sessionId],
  );
  if (perms.length === 0) return null;

  const current = perms[0]!;
  const total = perms.length;
  const command =
    (current.metadata?.command as string | undefined) ??
    (Array.isArray(current.pattern) ? current.pattern.join(" ") : (current.pattern ?? ""));
  const alwaysHint = current.always;

  const reply = (decision: "once" | "always" | "reject") => {
    postMessage({ type: "replyPermission", sessionId, permissionId: current.id, decision });
  };
  const stop = () => postMessage({ type: "abortSession", sessionId });

  return (
    <div className="permission-overlay" role="dialog" aria-label="Tool approval required">
      <div className="permission-overlay-inner">
        <div className="permission-request">
          <div className="permission-request-head">
            <span className="permission-request-icon" aria-hidden="true">⚠</span>
            <span className="permission-request-title">
              Approval required · <strong>{current.type}</strong>
            </span>
          </div>

          {total > 1 && (
            <div className="permission-stripes" aria-label={`${total} approvals pending`}>
              {Array.from({ length: total }, (_, i) => (
                <span key={i} className={`permission-stripe${i === 0 ? " current" : ""}`} />
              ))}
            </div>
          )}

          {command && <pre className="permission-command">{command}</pre>}

          {alwaysHint && alwaysHint.length > 0 && (
            <div className="permission-always">
              Always allow → <code>{alwaysHint.join(", ")}</code>
            </div>
          )}

          <div className="permission-actions">
            <button
              className="abort-btn"
              onClick={stop}
              title="Stop generation — aborts the running session"
              aria-label="Stop generation"
            >
              <span className="abort-icon" aria-hidden="true">■</span>
            </button>
            <span className="permission-actions-spacer" />
            <button
              className="btn btn-sm"
              onClick={() => reply("reject")}
              title="Block this call — the chat continues"
            >
              Reject
            </button>
            <button
              className="btn btn-sm"
              onClick={() => reply("always")}
              title={alwaysHint?.length ? `Always allow: ${alwaysHint.join(", ")}` : "Always allow this kind of call"}
            >
              Always allow
            </button>
            <button
              className="btn btn-primary btn-sm"
              onClick={() => reply("once")}
              title="Allow just this call"
            >
              Allow once
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
