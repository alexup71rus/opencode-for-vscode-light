import { useEffect, useMemo, useState } from "react";
import { useStore } from "../store/store";
import { postMessage } from "../api/vscodeApi";
import { extractFileChanges, type FileChange } from "../changes";

interface ChangesListProps {
  sessionId: string;
}

function basename(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] ?? p;
}

export function ChangesList({ sessionId }: ChangesListProps): React.ReactElement {
  const messages = useStore((s) => s.messagesBySession[sessionId] ?? []);
  const baseline = useStore((s) => s.changesBaseline[sessionId]);
  const applyChanges = useStore((s) => s.applyChanges);
  const [open, setOpen] = useState(true);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const rows: FileChange[] = useMemo(
    () => extractFileChanges(messages, baseline),
    [messages, baseline],
  );

  const totalAdd = rows.reduce((n, r) => n + r.additions, 0);
  const totalDel = rows.reduce((n, r) => n + r.deletions, 0);

  useEffect(() => {
    if (!confirmOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setConfirmOpen(false);
      if (e.key === "Enter") {
        const lastId = messages[messages.length - 1]?.info.id;
        if (lastId) applyChanges(sessionId, lastId);
        setConfirmOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [confirmOpen, messages, applyChanges, sessionId]);

  const onConfirmApply = () => {
    const lastId = messages[messages.length - 1]?.info.id;
    if (lastId) applyChanges(sessionId, lastId);
    setConfirmOpen(false);
  };

  return (
    <div className="panel-section">
      <div className="changes-head">
        <button className="panel-header" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          <span className="panel-caret">{open ? "▾" : "▸"}</span>
          <span className="panel-title">Changes</span>
          {rows.length > 0 && (
            <span className="panel-count">
              <span className="delta-add">+{totalAdd}</span>
              <span className="delta-del">-{totalDel}</span>
            </span>
          )}
        </button>
        {open && rows.length > 0 && (
          <button
            className="changes-apply-btn"
            onClick={() => setConfirmOpen(true)}
            title="Mark current changes as applied and clear the list"
          >
            Apply
          </button>
        )}
      </div>
      {open && (
        <div className="changes-list">
          {rows.length === 0 && <div className="empty-hint">No file changes</div>}
          {rows.map((row) => (
            <button
              key={row.filePath}
              className="change-row"
              title={row.filePath}
              onClick={() =>
                postMessage({
                  type: "openFileDiff",
                  filePath: row.filePath,
                  edits: row.edits,
                  isNewFile: row.isNewFile,
                })
              }
            >
              <span className={`change-status change-status-${row.isNewFile ? "added" : "modified"}`} />
              <span className="change-delta">
                {row.additions > 0 && <span className="delta-add">+{row.additions}</span>}
                {row.deletions > 0 && <span className="delta-del">-{row.deletions}</span>}
              </span>
              <span className="change-file" title={row.filePath}>
                {basename(row.filePath)}
              </span>
            </button>
          ))}
        </div>
      )}
      {confirmOpen && (
        <div className="modal-overlay" onClick={() => setConfirmOpen(false)}>
          <div className="modal confirm-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <span className="modal-title">Apply changes?</span>
            </div>
            <div className="modal-body">
              <p className="confirm-text">
                Mark <strong>{rows.length}</strong> file {rows.length === 1 ? "change" : "changes"} as applied and hide
                them from this list?
              </p>
              <p className="confirm-hint">Files on disk are not modified.</p>
              <div className="confirm-actions">
                <button className="confirm-btn cancel" onClick={() => setConfirmOpen(false)}>
                  Cancel
                </button>
                <button className="confirm-btn primary" onClick={onConfirmApply} autoFocus>
                  Apply
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
