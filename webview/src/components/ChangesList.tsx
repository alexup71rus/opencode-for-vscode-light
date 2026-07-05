import { useMemo, useState } from "react";
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
  const [open, setOpen] = useState(true);

  // The server's /file/status and /session/{id}/diff endpoints are empty on
  // opencode 1.17.x, so derive the change set from the session's own tool
  // calls — the same source the inline diffs use.
  const rows: FileChange[] = useMemo(() => extractFileChanges(messages), [messages]);

  const totalAdd = rows.reduce((n, r) => n + r.additions, 0);
  const totalDel = rows.reduce((n, r) => n + r.deletions, 0);

  return (
    <div className="panel-section">
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
    </div>
  );
}
