import { useMemo } from "react";
import { useStore } from "../store/store";
import { postMessage } from "../api/vscodeApi";

interface PermissionOverlayProps {
  sessionId: string;
}

export function PermissionOverlay({ sessionId }: PermissionOverlayProps): React.ReactElement | null {
  const all = useStore((s) => s.pendingPermissions);
  const autoApprove = useStore((s) => s.settings.autoApprove);
  const perms = useMemo(
    () => all.filter((p) => p.sessionID === sessionId),
    [all, sessionId],
  );
  // In YOLO mode the auto-approve effect replies instantly to every pending
  // permission; rendering the overlay for the roundtrip window produces a
  // flash. Suppress it entirely — the permission still flows through the store
  // so the auto-approve effect can reply, it just never becomes visible.
  if (autoApprove || perms.length === 0) return null;

  const current = perms[0]!;
  const total = perms.length;
  const command =
    (current.metadata?.command as string | undefined) ??
    (Array.isArray(current.pattern) ? current.pattern.join(" ") : (current.pattern ?? ""));
  const alwaysHint = current.always;

  const reply = (decision: "once" | "always" | "reject") => {
    postMessage({ type: "replyPermission", sessionId, permissionId: current.id, decision });
  };

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
              className="btn btn-sm"
              onClick={() => reply("reject")}
              title="Reject — deny the tool and stop the run"
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
