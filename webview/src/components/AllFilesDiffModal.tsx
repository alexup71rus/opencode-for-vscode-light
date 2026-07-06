import { useEffect, useMemo, useState } from "react";
import { useStore } from "../store/store";
import { postMessage } from "../api/vscodeApi";
import { buildDiffRows, type DiffRow } from "../diff";
import type { EditPatch, FileChange } from "../changes";
import { DiffRows } from "./DiffRows";
import { fileIconClass } from "../utils/fileIcon";

function basename(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] ?? p;
}

function dirname(p: string): string {
  const parts = p.split(/[\\/]/);
  parts.pop();
  return parts.join("/");
}

function statusFor(change: FileChange, exists: boolean | undefined): "modified" | "added" | "deleted" {
  if (exists === false && !change.isNewFile) return "deleted";
  if (change.isNewFile) return exists === false ? "deleted" : "added";
  return "modified";
}

/**
 * One hunk to render in an accordion body. For an edited file each edit patch
 * becomes its own hunk; for a `write` (new file) the single hunk is "" → the
 * written content. Hunks with identical old/new are skipped (no real change).
 */
function hunksFor(change: FileChange): EditPatch[] {
  if (change.isNewFile) return [{ oldStr: "", newStr: change.newContent ?? "" }];
  return change.edits;
}

interface AccordionProps {
  change: FileChange;
  exists: boolean | undefined;
  expanded: boolean;
  onToggle: () => void;
}

function Accordion({ change, exists, expanded, onToggle }: AccordionProps): React.ReactElement {
  const filePath = change.filePath;
  const status = statusFor(change, exists);
  const iconCls = fileIconClass(filePath);

  const hunks = useMemo(() => hunksFor(change), [change]);
  const blocks = useMemo<(DiffRow[] | null)[]>(() => {
    if (!expanded) return [];
    return hunks.map((h) => {
      if (h.oldStr === h.newStr) return null;
      return buildDiffRows(h.oldStr, h.newStr);
    });
  }, [hunks, expanded]);

  const additions = change.additions;
  const deletions = change.deletions;

  const openInEditor = (e: React.MouseEvent) => {
    e.stopPropagation();
    postMessage({
      type: "openFileDiff",
      filePath,
      edits: change.edits,
      isNewFile: change.isNewFile,
    });
  };

  return (
    <div className={`diff-accordion${expanded ? " expanded" : ""}`}>
      <div
        className="diff-accordion-head"
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        title={filePath}
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onToggle();
          }
        }}
      >
        <span className="diff-accordion-caret" aria-hidden="true">{expanded ? "▾" : "▸"}</span>
        <span className={`change-status change-status-${status}`} />
        {iconCls && <span className={`codicon ${iconCls} diff-accordion-icon`} aria-hidden="true" />}
        <span className="diff-accordion-name">
          <span className="diff-accordion-base">{basename(filePath)}</span>
          {dirname(filePath) && (
            <span className="diff-accordion-dir">{dirname(filePath)}</span>
          )}
        </span>
        <span className="diff-accordion-delta">
          {additions > 0 && <span className="delta-add">+{additions}</span>}
          {deletions > 0 && <span className="delta-del">-{deletions}</span>}
        </span>
        <button
          className="btn btn-xs diff-accordion-open"
          title="Open in VS Code diff editor"
          onClick={openInEditor}
        >
          Open in editor
        </button>
      </div>
      {expanded && (
        <div className="diff-accordion-body">
          {blocks.length === 0 || blocks.every((b) => b === null || b.length === 0) ? (
            <div className="diff-accordion-empty">No textual changes.</div>
          ) : (
            blocks.map((rows, i) =>
              rows && rows.length > 0 ? (
                <pre key={i} className="tool-pre diff-pre diff-accordion-pre">
                  <DiffRows rows={rows} />
                </pre>
              ) : null,
            )
          )}
        </div>
      )}
    </div>
  );
}

export function AllFilesDiffModal(): React.ReactElement | null {
  const modal = useStore((s) => s.allFilesDiffModal);
  const close = useStore((s) => s.closeAllFilesDiffModal);
  const fileExists = useStore((s) => s.fileExists);

  const changes = modal?.changes ?? [];

  // All accordions open by default; toggling is per-filepath.
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(changes.map((c) => c.filePath)));

  // Re-seed the expanded set whenever a different change set is opened, so
  // reopening the modal after new edits lands on a fully-expanded view again.
  useEffect(() => {
    setExpanded(new Set(changes.map((c) => c.filePath)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modal]);

  const totalAdd = changes.reduce((n, c) => n + c.additions, 0);
  const totalDel = changes.reduce((n, c) => n + c.deletions, 0);
  const allExpanded = changes.length > 0 && expanded.size === changes.length;

  const toggle = (filePath: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(filePath)) next.delete(filePath);
      else next.add(filePath);
      return next;
    });
  };

  const toggleAll = () => {
    if (allExpanded) setExpanded(new Set());
    else setExpanded(new Set(changes.map((c) => c.filePath)));
  };

  if (!modal) return null;

  return (
    <div className="modal-overlay" onClick={close}>
      <div className="modal all-diff-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div className="all-diff-title">
            <span className="modal-title">
              {changes.length === 1 ? "Changed file" : `${changes.length} changed files`}
            </span>
            <span className="all-diff-totals">
              {totalAdd > 0 && <span className="delta-add">+{totalAdd}</span>}
              {totalDel > 0 && <span className="delta-del">-{totalDel}</span>}
            </span>
          </div>
          <div className="all-diff-actions">
            <button className="btn btn-xs" onClick={toggleAll} disabled={changes.length === 0}>
              {allExpanded ? "Collapse all" : "Expand all"}
            </button>
            <button className="modal-close" title="Close" onClick={close}>
              ✕
            </button>
          </div>
        </div>
        <div className="modal-body all-diff-body">
          {changes.map((change) => (
            <Accordion
              key={change.filePath}
              change={change}
              exists={fileExists[change.filePath]}
              expanded={expanded.has(change.filePath)}
              onToggle={() => toggle(change.filePath)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
