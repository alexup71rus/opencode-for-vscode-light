import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useStore } from "../store/store";
import { postMessage } from "../api/vscodeApi";
import { computeLineDiff, type DiffRow } from "../diff";

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

/** Split text into plain + highlighted segments around every query match. */
function highlightMatches(text: string, queryLower: string): ReactNode {
  if (!queryLower) return text;
  const lower = text.toLowerCase();
  const nodes: ReactNode[] = [];
  let i = 0;
  let key = 0;
  while (i <= text.length) {
    const found = lower.indexOf(queryLower, i);
    if (found === -1) {
      if (i < text.length) nodes.push(text.slice(i));
      break;
    }
    if (found > i) nodes.push(text.slice(i, found));
    nodes.push(<mark key={key++}>{text.slice(found, found + queryLower.length)}</mark>);
    i = found + queryLower.length;
  }
  return <>{nodes}</>;
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
  const blocks = useMemo(() => changeBlocks(rows), [rows]);

  const additions = rows.filter((r) => r.type === "add").length;
  const deletions = rows.filter((r) => r.type === "del").length;

  const [cursor, setCursor] = useState(0);
  const rowRefs = useRef<(HTMLDivElement | null)[]>([]);

  // --- In-modal search (Ctrl/Cmd+F) ---
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [matchIdx, setMatchIdx] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);

  const queryLower = query.trim().toLowerCase();
  const matches = useMemo(() => {
    if (!queryLower) return [] as number[];
    const result: number[] = [];
    for (let i = 0; i < rows.length; i++) {
      if (rows[i].text.toLowerCase().includes(queryLower)) result.push(i);
    }
    return result;
  }, [rows, queryLower]);

  // Reset cursor + stale refs + search when the file changes.
  useEffect(() => {
    setCursor(0);
    rowRefs.current = [];
    setSearchOpen(false);
    setQuery("");
    setMatchIdx(0);
  }, [filePath]);

  // On open (and whenever the diff content changes), jump to the first change.
  useEffect(() => {
    if (blocks.length === 0) return;
    const raf = requestAnimationFrame(() => {
      rowRefs.current[blocks[0]]?.scrollIntoView({ block: "start" });
    });
    return () => cancelAnimationFrame(raf);
  }, [blocks]);

  // Ctrl/Cmd+F opens the search bar; refocuses if already open.
  // Only active while the modal is open to avoid hijacking Ctrl+F elsewhere.
  const isOpen = !!diffModal;
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "f") {
        e.preventDefault();
        e.stopPropagation();
        if (!searchOpen) {
          setSearchOpen(true);
        } else {
          searchRef.current?.focus();
          searchRef.current?.select();
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [searchOpen, isOpen]);

  // Focus the input when the search bar appears.
  useEffect(() => {
    if (searchOpen) searchRef.current?.focus();
  }, [searchOpen]);

  // Reset to first match when the query changes; scroll to it.
  useEffect(() => {
    setMatchIdx(0);
  }, [queryLower]);

  useEffect(() => {
    if (matches.length === 0) return;
    const rowIdx = matches[Math.min(matchIdx, matches.length - 1)];
    rowRefs.current[rowIdx]?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [matches, matchIdx]);

  const jump = (dir: -1 | 1) => {
    if (blocks.length === 0) return;
    const next = Math.max(0, Math.min(blocks.length - 1, cursor + dir));
    if (next === cursor) return;
    setCursor(next);
    rowRefs.current[blocks[next]]?.scrollIntoView({ block: "start", behavior: "smooth" });
  };

  const searchJump = (dir: -1 | 1) => {
    if (matches.length === 0) return;
    setMatchIdx((i) => (i + dir + matches.length) % matches.length);
  };

  const closeSearch = () => {
    setSearchOpen(false);
    setQuery("");
    setMatchIdx(0);
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
    diffModal.status === "ready" && additions + deletions > 0 && blocks.length > 0;
  const atFirst = cursor <= 0;
  const atLast = cursor >= blocks.length - 1;

  const onSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (query) setQuery("");
      else closeSearch();
    } else if (e.key === "Enter") {
      e.preventDefault();
      searchJump(e.shiftKey ? -1 : 1);
    }
  };

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
              className="diff-nav-btn"
              title="Find (Ctrl+F)"
              aria-label="Find"
              onClick={() => {
                setSearchOpen(true);
                searchRef.current?.focus();
              }}
            >
              <span className="codicon codicon-search" aria-hidden="true" />
            </button>
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
        {searchOpen && ready && (
          <div className="diff-search-bar">
            <input
              ref={searchRef}
              className="diff-search-input"
              placeholder="Find…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onSearchKeyDown}
            />
            <span className="diff-search-count">
              {matches.length > 0
                ? `${Math.min(matchIdx + 1, matches.length)}/${matches.length}`
                : query.trim() ? "0/0" : ""}
            </span>
            <button
              className="diff-nav-btn"
              title="Previous match (Shift+Enter)"
              aria-label="Previous match"
              disabled={matches.length === 0}
              onClick={() => searchJump(-1)}
            >
              <span className="codicon codicon-chevron-up" aria-hidden="true" />
            </button>
            <button
              className="diff-nav-btn"
              title="Next match (Enter)"
              aria-label="Next match"
              disabled={matches.length === 0}
              onClick={() => searchJump(1)}
            >
              <span className="codicon codicon-chevron-down" aria-hidden="true" />
            </button>
            <button
              className="diff-nav-btn"
              title="Close search (Esc)"
              aria-label="Close search"
              onClick={closeSearch}
            >
              <span className="codicon codicon-close" aria-hidden="true" />
            </button>
          </div>
        )}
        <div className="modal-body">
          {diffModal.status === "loading" && (
            <div className="diff-modal-loading">Loading diff…</div>
          )}
          {diffModal.status === "error" && (
            <div className="diff-modal-error">{diffModal.message}</div>
          )}
          {diffModal.status === "ready" && additions === 0 && deletions === 0 && (
            <div className="diff-modal-notice">
              No textual changes detected — the file may have been edited since this change.
            </div>
          )}
          {diffModal.status === "ready" && (additions > 0 || deletions > 0) && (
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
                    {highlightMatches(row.text, queryLower)}
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
