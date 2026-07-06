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
  const openFileDiffModal = useStore((s) => s.openFileDiffModal);
  const openAllFilesDiffModal = useStore((s) => s.openAllFilesDiffModal);
  const fileExists = useStore((s) => s.fileExists);
  const checkFilesExist = useStore((s) => s.checkFilesExist);
  const [open, setOpen] = useState(true);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const allRows: FileChange[] = useMemo(
    () => extractFileChanges(messages, baseline),
    [messages, baseline],
  );

  useEffect(() => {
    if (allRows.length === 0) return;
    checkFilesExist(allRows.map((r) => r.filePath));
  }, [allRows, checkFilesExist]);

  // Files that were created in-session (write tool → isNewFile) and have
  // since been removed from disk (e.g. via `rm` through the bash tool) are
  // dropped from the list entirely. opencode has no dedicated delete tool,
  // so disk presence (checked above via checkFilesExist) is the only signal
  // that a deletion happened. Pre-existing files that were deleted still
  // appear (isNewFile=false) with the "deleted" status, which is the
  // correct behaviour for surfacing real losses.
  const rows: FileChange[] = useMemo(
    () => allRows.filter((r) => !(r.isNewFile && fileExists[r.filePath] === false)),
    [allRows, fileExists],
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
          <div className="changes-head-actions">
            <button
              className="changes-head-btn"
              title="Preview all diffs in a modal"
              onClick={() => openAllFilesDiffModal(rows)}
            >
              View all
            </button>
            <button
              className="changes-apply-btn"
              onClick={() => setConfirmOpen(true)}
              title="Mark current changes as applied and clear the list"
            >
              Apply
            </button>
          </div>
        )}
      </div>
      {open && (
        <div className="changes-list">
          {rows.length === 0 && <div className="empty-hint">No file changes</div>}
          {rows.map((row) => (
            <div
              key={row.filePath}
              className={`change-row${fileExists[row.filePath] === false ? " missing" : ""}`}
              title={row.filePath}
            >
              <button
                className="change-main"
                onClick={() =>
                  postMessage({
                    type: "openFileDiff",
                    filePath: row.filePath,
                    edits: row.edits,
                    isNewFile: row.isNewFile,
                  })
                }
              >
                <span className={`change-status change-status-${fileExists[row.filePath] === false ? "deleted" : row.isNewFile ? "added" : "modified"}`} />
                <span className="change-delta">
                  {row.additions > 0 && <span className="delta-add">+{row.additions}</span>}
                  {row.deletions > 0 && <span className="delta-del">-{row.deletions}</span>}
                </span>
                <span className="change-file" title={row.filePath}>
                  {basename(row.filePath)}
                </span>
              </button>
              <button
                className="change-modal-btn"
                title="Preview diff in panel"
                aria-label={`Preview ${basename(row.filePath)} diff in panel`}
                onClick={(e) => {
                  e.stopPropagation();
                  openFileDiffModal(row.filePath, row.edits, row.isNewFile);
                }}
              >
                <span className="codicon codicon-eye" aria-hidden="true" />
              </button>
            </div>
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
