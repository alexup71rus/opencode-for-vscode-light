import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../store/store";
import { postMessage } from "../api/vscodeApi";
import { computeLineDiff, type DiffRow } from "../diff";

/** Skip running the O(n*m) diff for large files; show a notice instead. */
const LINE_LIMIT = 3000;

function basename(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] ?? p;
}

/** Start-row index of each change block (a maximal run of non-context rows). */
function changeBlocks(rows: DiffRow[]): number[] {
  const starts: number[] = [];
  for (let i = 0; i < rows.length; i++) {
    const changed = rows[i].type !== "ctx";
    const prevCtx = i === 0 || rows[i - 1].type === "ctx";
    if (changed && prevCtx) starts.push(i);
  }
  return starts;
}

export function FileDiffModal(): React.ReactElement | null {
  const diffModal = useStore((s) => s.diffModal);
  const close = useStore((s) => s.closeFileDiffModal);

  const ready = diffModal?.status === "ready" ? diffModal : null;
  const before = ready?.before ?? "";
  const after = ready?.after ?? "";
  const filePath = diffModal?.filePath ?? "";

  const rows = useMemo(
    () => (ready ? computeLineDiff(before, after) : []),
    [ready, before, after],
  );
  const tooLarge = useMemo(
    () => Math.max(before.split("\n").length, after.split("\n").length) > LINE_LIMIT,
    [before, after],
  );
  const blocks = useMemo(() => (tooLarge ? [] : changeBlocks(rows)), [rows, tooLarge]);

  const additions = tooLarge ? 0 : rows.filter((r) => r.type === "add").length;
  const deletions = tooLarge ? 0 : rows.filter((r) => r.type === "del").length;

  const [cursor, setCursor] = useState(0);
  const rowRefs = useRef<(HTMLDivElement | null)[]>([]);

  // Reset cursor + stale refs when the file changes.
  useEffect(() => {
    setCursor(0);
    rowRefs.current = [];
  }, [filePath]);

  // On open (and whenever the diff content changes), jump to the first change.
  useEffect(() => {
    if (blocks.length === 0) return;
    const raf = requestAnimationFrame(() => {
      rowRefs.current[blocks[0]]?.scrollIntoView({ block: "start" });
    });
    return () => cancelAnimationFrame(raf);
  }, [blocks]);

  const jump = (dir: -1 | 1) => {
    if (blocks.length === 0) return;
    const next = Math.max(0, Math.min(blocks.length - 1, cursor + dir));
    if (next === cursor) return;
    setCursor(next);
    rowRefs.current[blocks[next]]?.scrollIntoView({ block: "start", behavior: "smooth" });
  };

  if (!diffModal) return null;

  const openInEditor = () => {
    postMessage({
      type: "openFileDiff",
      filePath: diffModal.filePath,
      edits: diffModal.edits,
      isNewFile: diffModal.isNewFile,
    });
  };

  const showNav =
    diffModal.status === "ready" && !tooLarge && additions + deletions > 0 && blocks.length > 0;
  const atFirst = cursor <= 0;
  const atLast = cursor >= blocks.length - 1;

  return (
    <div className="modal-overlay" onClick={close}>
      <div className="modal diff-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div className="diff-modal-title">
            <span className="modal-title">{basename(diffModal.filePath)}</span>
            <span className="diff-modal-path" title={diffModal.filePath}>{diffModal.filePath}</span>
          </div>
          <div className="diff-modal-actions">
            {showNav && (
              <div className="diff-nav" title="Jump between change blocks">
                <button
                  className="diff-nav-btn"
                  title="Previous change"
                  aria-label="Previous change"
                  disabled={atFirst}
                  onClick={() => jump(-1)}
                >
                  <span className="codicon codicon-chevron-up" aria-hidden="true" />
                </button>
                <span className="diff-nav-count">{Math.min(cursor + 1, blocks.length)}/{blocks.length}</span>
                <button
                  className="diff-nav-btn"
                  title="Next change"
                  aria-label="Next change"
                  disabled={atLast}
                  onClick={() => jump(1)}
                >
                  <span className="codicon codicon-chevron-down" aria-hidden="true" />
                </button>
              </div>
            )}
            <button
              className="btn btn-xs"
              title="Open in VS Code diff editor"
              onClick={openInEditor}
            >
              Open in editor
            </button>
            <button className="modal-close" title="Close" onClick={close}>
              ✕
            </button>
          </div>
        </div>
        <div className="modal-body">
          {diffModal.status === "loading" && (
            <div className="diff-modal-loading">Loading diff…</div>
          )}
          {diffModal.status === "error" && (
            <div className="diff-modal-error">{diffModal.message}</div>
          )}
          {diffModal.status === "ready" && tooLarge && (
            <div className="diff-modal-notice">
              File is too large to render inline. Use <strong>Open in editor</strong> for the full diff.
            </div>
          )}
          {diffModal.status === "ready" && !tooLarge && additions === 0 && deletions === 0 && (
            <div className="diff-modal-notice">
              No textual changes detected — the file may have been edited since this change.
            </div>
          )}
          {diffModal.status === "ready" && !tooLarge && (additions > 0 || deletions > 0) && (
            <>
              <div className="diff-stats">
                {additions > 0 && <span className="diff-add-count">+{additions}</span>}
                {deletions > 0 && <span className="diff-del-count">-{deletions}</span>}
              </div>
              <pre className="tool-pre diff-pre diff-modal-pre">
                {rows.map((row, idx) => (
                  <div
                    key={idx}
                    ref={(el) => {
                      rowRefs.current[idx] = el;
                    }}
                    className={row.type === "add" ? "diff-add" : row.type === "del" ? "diff-del" : "diff-ctx"}
                  >
                    {row.type === "add" ? "+" : row.type === "del" ? "-" : " "}
                    {row.text}
                  </div>
                ))}
              </pre>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
