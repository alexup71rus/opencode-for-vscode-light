import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../store/store";
import { postMessage } from "../api/vscodeApi";
import { dayBucket } from "../utils";
import type { MessageWithParts, SessionWithMeta } from "../api/types";

// Pagination caps. Top-level chats show 30 then "Load more". Subagent threads
// always show active (busy) children plus those spawned in the current or
// previous assistant turn; the older ones page in by 3. Each "Load more" click
// reveals exactly one page so the list grows predictably.
const ROOT_PAGE = 30;
const KID_PAGE = 3;

// Count subagent invocations in the last two assistant turns (turn boundary =
// a user message). Used to decide which children are "recent" and thus always
// visible: the newest N children pair positionally with the newest N invocations.
function recentSubagentCount(messages: MessageWithParts[], subagentTools: Set<string>): number {
  if (messages.length === 0) return 0;
  let userSeen = 0;
  let fromIdx = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].info.role === "user") {
      userSeen++;
      if (userSeen === 2) {
        fromIdx = i;
        break;
      }
    }
  }
  let count = 0;
  for (let i = fromIdx; i < messages.length; i++) {
    for (const p of messages[i].parts) {
      if (p.type === "subtask") count++;
      else if (p.type === "tool" && subagentTools.has(p.tool)) count++;
    }
  }
  return count;
}

export function SessionList(): React.ReactElement {
  const sessions = useStore((s) => s.sessions);
  const activeSessionId = useStore((s) => s.activeSessionId);
  const messagesBySession = useStore((s) => s.messagesBySession);
  const pinnedSessions = useStore((s) => s.pinnedSessions);
  const togglePin = useStore((s) => s.togglePin);
  const search = useStore((s) => s.sessionSearch);
  const setSearch = useStore((s) => s.setSessionSearch);
  const sessionStatus = useStore((s) => s.sessionStatus);
  const agents = useStore((s) => s.agents);
  const subagentToolNames = useMemo(() => {
    const names = new Set<string>(["task"]);
    for (const a of agents) {
      if (a.mode === "subagent" || a.mode === "all") names.add(a.name);
    }
    return names;
  }, [agents]);

  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const editInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editingId && editInputRef.current) {
      editInputRef.current.focus();
      editInputRef.current.select();
    }
  }, [editingId]);

  const matchesSearch = (ses: SessionWithMeta, q: string): boolean => {
    if (!q) return true;
    const needle = q.toLowerCase();
    if (ses.title.toLowerCase().includes(needle)) return true;
    const list = messagesBySession[ses.id];
    if (list) {
      for (const m of list) {
        if (m.info.role === "user") {
          for (const p of m.parts) {
            if (p.type === "text" && p.text.toLowerCase().includes(needle)) return true;
          }
        }
      }
    }
    return false;
  };

  const searching = search.trim().length > 0;

  // A session is a "child" (subagent thread) if it has a parentID pointing to a
  // session present in the list. Children are never shown as top-level entries;
  // they nest under their parent. Subagent threads are collapsed by default
  // (the chevron toggles them); the active session's ancestors are force-opened
  // so the current selection stays visible.
  const isChild = (s: SessionWithMeta) =>
    !!(s.parentID && sessions.some((x) => x.id === s.parentID));

  const childrenByParent = useMemo(() => {
    const map = new Map<string, SessionWithMeta[]>();
    for (const s of sessions) {
      if (s.parentID && sessions.some((x) => x.id === s.parentID)) {
        const arr = map.get(s.parentID) ?? [];
        arr.push(s);
        map.set(s.parentID, arr);
      }
    }
    for (const arr of map.values()) arr.sort((a, b) => b.time.created - a.time.created);
    return map;
  }, [sessions]);

  const filtered = useMemo(() => {
    const q = search.trim();
    return sessions.filter((s) => matchesSearch(s, q));
  }, [sessions, messagesBySession, search]);

  // Subagent children are collapsed by default; the user opens them via the
  // chevron. We force-open the ancestors of the active session so the current
  // selection is always visible.
  const [expandedKids, setExpandedKids] = useState<Record<string, boolean>>({});
  const [visibleRoots, setVisibleRoots] = useState(ROOT_PAGE);
  const [extraKids, setExtraKids] = useState<Record<string, number>>({});
  const forcedOpen = useMemo(() => {
    const set = new Set<string>();
    let cur = sessions.find((s) => s.id === activeSessionId);
    while (cur?.parentID) {
      set.add(cur.parentID);
      cur = sessions.find((s) => s.id === cur!.parentID);
    }
    return set;
  }, [sessions, activeSessionId]);
  const isParentOpen = (id: string) => forcedOpen.has(id) || !!expandedKids[id];
  const toggleKids = (id: string) =>
    setExpandedKids((m) => ({ ...m, [id]: !m[id] }));

  const pinnedSet = new Set(pinnedSessions);
  // Browsing: children are nested under their parent, so exclude them from the
  // top-level lists. Searching: show everything flat (find across all).
  const roots = searching ? filtered : filtered.filter((s) => !isChild(s));
  const pinned = roots.filter((s) => pinnedSet.has(s.id));
  const unpinned = roots.filter((s) => !pinnedSet.has(s.id));

  const sortedUnpinned = [...unpinned].sort((a, b) => b.time.updated - a.time.updated);
  const sortedPinned = [...pinned].sort((a, b) => b.time.updated - a.time.updated);
  // Cap the top-level list to a page of the most-recent chats (pinned are
  // always shown above, beyond the cap). Search ignores the cap — you want all
  // matches — so only slice while browsing.
  const cappedUnpinned = searching ? sortedUnpinned : sortedUnpinned.slice(0, visibleRoots);
  const hasMoreRoots = !searching && sortedUnpinned.length > cappedUnpinned.length;

  const groups = new Map<string, SessionWithMeta[]>();
  for (const ses of cappedUnpinned) {
    const bucket = dayBucket(ses.time.updated);
    const arr = groups.get(bucket) ?? [];
    arr.push(ses);
    groups.set(bucket, arr);
  }

  const startEdit = (ses: SessionWithMeta) => {
    setEditingId(ses.id);
    setEditValue(ses.title || "");
  };

  const commitEdit = () => {
    const id = editingId;
    const value = editValue.trim();
    if (id && value) {
      postMessage({ type: "renameSession", sessionId: id, title: value });
    }
    setEditingId(null);
    setEditValue("");
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditValue("");
  };

  const renderSession = (ses: SessionWithMeta, depth = 0) => {
    const isActive = ses.id === activeSessionId;
    const isConfirming = pendingDelete === ses.id;
    const isEditing = editingId === ses.id;
    const isPinned = pinnedSet.has(ses.id);
    const childDepth = depth;
    const hasKids = !searching && (childrenByParent.get(ses.id)?.length ?? 0) > 0;
    const kidsOpen = hasKids && isParentOpen(ses.id);
    return (
      <div
        key={ses.id}
        className={`session-item ${isActive ? "active" : ""} ${isConfirming ? "confirming" : ""} ${childDepth > 0 ? "session-item-child" : ""}`}
        style={childDepth > 0 ? { paddingLeft: 8 + childDepth * 14 } : undefined}
        onClick={() => {
          if (isConfirming) {
            setPendingDelete(null);
            return;
          }
          if (isEditing) return;
          if (pendingDelete) setPendingDelete(null);
          postMessage({ type: "openSession", sessionId: ses.id });
        }}
        onKeyDown={(e) => {
          if (isConfirming || isEditing) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            if (pendingDelete) setPendingDelete(null);
            postMessage({ type: "openSession", sessionId: ses.id });
          }
        }}
        role="button"
        tabIndex={0}
      >
        <div className="session-item-main">
          {isEditing ? (
            <input
              ref={editInputRef}
              className="session-rename-input"
              value={editValue}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => setEditValue(e.target.value)}
              onBlur={commitEdit}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  commitEdit();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  cancelEdit();
                }
              }}
            />
          ) : (
            <div
              className="session-item-title"
              title="Double-click to rename"
              onDoubleClick={(e) => {
                e.stopPropagation();
                startEdit(ses);
              }}
            >
              {childDepth > 0 && (
                <span className="session-child-mark" aria-hidden="true">
                  {sessionStatus[ses.id]?.type === "busy" ? (
                    <span className="session-child-live" />
                  ) : (
                    "↳"
                  )}
                </span>
              )}
              {ses.title || "Untitled"}
              {childDepth > 0 && ses.agent && <span className="session-child-agent">{ses.agent}</span>}
            </div>
          )}
        </div>
        {isConfirming ? (
          <div className="session-confirm" onClick={(e) => e.stopPropagation()}>
            <button
              className="btn btn-danger btn-xs"
              title="Confirm delete"
              onClick={() => {
                setPendingDelete(null);
                postMessage({ type: "deleteSession", sessionId: ses.id });
              }}
            >
              Delete
            </button>
            <button className="btn btn-xs" title="Cancel" onClick={() => setPendingDelete(null)}>
              No
            </button>
          </div>
        ) : (
          <div className="session-item-actions" onClick={(e) => e.stopPropagation()}>
            {hasKids && (
              <button
                className={`session-action-btn ${kidsOpen ? "active" : ""}`}
                title={kidsOpen ? "Collapse subagents" : "Expand subagents"}
                aria-label={kidsOpen ? "Collapse subagents" : "Expand subagents"}
                aria-expanded={kidsOpen}
                onClick={() => toggleKids(ses.id)}
              >
                <ChevronIcon open={kidsOpen} />
              </button>
            )}
            <button
              className={`session-action-btn ${isPinned ? "active" : ""}`}
              title={isPinned ? "Unpin" : "Pin to top"}
              aria-label={isPinned ? "Unpin session" : "Pin session"}
              onClick={() => togglePin(ses.id)}
            >
              <PinIcon filled={isPinned} />
            </button>
            <button
              className="session-action-btn"
              title="Rename"
              aria-label="Rename session"
              onClick={() => startEdit(ses)}
            >
              <EditIcon />
            </button>
            <button
              className="session-delete"
              title="Delete session"
              aria-label="Delete session"
              onClick={() => setPendingDelete(ses.id)}
            >
              <TrashIcon />
            </button>
          </div>
        )}
      </div>
    );
  };

  const renderTree = (ses: SessionWithMeta, depth = 0): React.ReactElement => {
    const allKids = searching ? [] : childrenByParent.get(ses.id) ?? [];
    const showKids = searching || isParentOpen(ses.id);
    if (!showKids || allKids.length === 0) {
      return <Fragment key={ses.id}>{renderSession(ses, depth)}</Fragment>;
    }
    // Always-visible ("guaranteed") children: the active selection, any child
    // still running (busy), and the most recent ones — those spawned in the
    // parent's current or previous assistant turn. The older, archival children
    // page in from the bottom in pages of KID_PAGE via "Load more". Children are
    // sorted newest-first, so the recent ones sit at the top and the oldest
    // collapse at the bottom under the button.
    const recentCount = recentSubagentCount(messagesBySession[ses.id] ?? [], subagentToolNames);
    let budget = KID_PAGE + (extraKids[ses.id] ?? 0);
    const visibleKids: SessionWithMeta[] = [];
    let hidden = 0;
    for (let i = 0; i < allKids.length; i++) {
      const k = allKids[i];
      const guaranteed =
        k.id === activeSessionId ||
        sessionStatus[k.id]?.type === "busy" ||
        i < recentCount;
      if (guaranteed || budget > 0) {
        if (!guaranteed) budget--;
        visibleKids.push(k);
      } else {
        hidden++;
      }
    }
    return (
      <Fragment key={ses.id}>
        {renderSession(ses, depth)}
        {visibleKids.map((k) => renderTree(k, depth + 1))}
        {hidden > 0 && (
          <div className="session-load-more-wrap" style={{ paddingLeft: 8 + (depth + 1) * 14 }}>
            <button
              className="session-load-more"
              onClick={() =>
                setExtraKids((m) => ({ ...m, [ses.id]: (m[ses.id] ?? 0) + KID_PAGE }))
              }
            >
              Load more ({hidden})
            </button>
          </div>
        )}
      </Fragment>
    );
  };

  const hasAny = sessions.length > 0;
  const hasMatches = filtered.length > 0;

  return (
    <div className="session-list-wrap">
      <div className="session-list-new">
        <button className="btn btn-primary new-session-btn" onClick={() => postMessage({ type: "createSession" })}>
          <span className="new-session-plus">+</span>
          <span>New chat</span>
        </button>
      </div>
      {hasAny && (
        <div className="session-search-wrap">
          <span className="session-search-icon">
            <SearchIcon />
          </span>
          <input
            className="session-search"
            type="text"
            placeholder="Search conversations…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {search && (
            <button className="session-search-clear" title="Clear" onClick={() => setSearch("")}>
              ✕
            </button>
          )}
        </div>
      )}
      <div className="session-list">
        {!hasAny ? (
          <div className="session-empty">
            <div className="session-empty-icon">💬</div>
            <div className="session-empty-title">No conversations yet</div>
            <div className="session-empty-sub">Start a new chat to begin.</div>
          </div>
        ) : !hasMatches ? (
          <div className="session-empty">
            <div className="session-empty-title">No matches</div>
            <div className="session-empty-sub">Nothing matches “{search}”.</div>
          </div>
        ) : (
          <>
            {sortedPinned.length > 0 && (
              <div className="session-group">
                <div className="session-group-title">Pinned</div>
                {sortedPinned.map((s) => renderTree(s))}
              </div>
            )}
            {[...groups.entries()].map(([bucket, items]) => (
              <div key={bucket} className="session-group">
                <div className="session-group-title">{bucket}</div>
                {items.map((s) => renderTree(s))}
              </div>
            ))}
            {hasMoreRoots && (
              <button
                className="session-load-more session-load-more-root"
                onClick={() => setVisibleRoots((v) => v + ROOT_PAGE)}
              >
                Load more ({sortedUnpinned.length - cappedUnpinned.length})
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function SearchIcon(): React.ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.4" />
      <path d="M10.5 10.5 L14 14" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function TrashIcon(): React.ReactElement {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M3 4.5 H13 M6.5 4.5 V3.2 H9.5 V4.5 M4.5 4.5 L5 13.5 H11 L11.5 4.5 M6.8 6.5 V11.5 M9.2 6.5 V11.5"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function PinIcon({ filled }: { filled: boolean }): React.ReactElement {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill={filled ? "currentColor" : "none"} aria-hidden="true">
      <path
        d="M9.5 1.5 L14.5 6.5 L11 7.2 L8.5 11 L7 9.5 L3.5 12.5 L3.5 12.5 L3.5 12.5 M3.5 12.5 L6.5 9 L5 7.5 L8.8 5"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function EditIcon(): React.ReactElement {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M11.5 2 L14 4.5 L5.5 13 L2 14 L3 10.5 Z M10 3.5 L12.5 6"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ChevronIcon({ open }: { open: boolean }): React.ReactElement {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      style={{ transform: open ? "rotate(90deg)" : "none", transition: "transform 0.12s ease" }}
    >
      <path
        d="M6 4 L10 8 L6 12"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
