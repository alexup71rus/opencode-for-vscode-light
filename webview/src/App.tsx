import { useEffect, useRef, useState } from "react";
import { useVsCodeEvent } from "./hooks/useVsCodeEvent";
import { useStore } from "./store/store";
import { postMessage } from "./api/vscodeApi";
import { SessionList } from "./components/SessionList";
import { ChatView } from "./components/ChatView";
import { ChatInput } from "./components/ChatInput";
import { QueueBar } from "./components/QueueBar";
import { QuestionOverlay } from "./components/QuestionOverlay";
import { playCompleteSound, playAttentionSound } from "./utils/sound";
import { InspectPanel } from "./components/InspectPanel";
import { SettingsPanel } from "./components/SettingsPanel";
import { HelpModal } from "./components/HelpModal";

export default function App(): React.ReactElement {
  useVsCodeEvent();

  const serverStatus = useStore((s) => s.serverStatus);
  const errorMessage = useStore((s) => s.errorMessage);
  const activeSessionId = useStore((s) => s.activeSessionId);
  const activeStatus = useStore((s) =>
    activeSessionId ? s.sessionStatus[activeSessionId] : undefined,
  );
  const sessions = useStore((s) => s.sessions);

  // Play a soft cue when the active session finishes a turn (busy -> idle).
  const prevStatusRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    const prev = prevStatusRef.current;
    const cur = activeStatus?.type;
    prevStatusRef.current = cur;
    if (prev === "busy" && cur !== "busy" && cur !== undefined) {
      if (useStore.getState().settings.soundOnComplete) playCompleteSound();
    }
  }, [activeStatus]);

  // Changed-file count for the Inspect toggle badge. Derived from the active
  // session's tool calls (the server's /file/status endpoint is empty on
  // opencode 1.17.x), so it reflects what the agent actually touched.
  const changedFileCount = useStore((s) => {
    if (!activeSessionId) return 0;
    const msgs = s.messagesBySession[activeSessionId];
    if (!msgs) return 0;
    const files = new Set<string>();
    for (const m of msgs) {
      for (const p of m.parts) {
        if (p.type !== "tool") continue;
        const st = p.state as { status?: string; input?: Record<string, unknown> };
        if (st.status === "error") continue;
        const input = st.input;
        if (!input) continue;
        const tool = p.tool.toLowerCase();
        if (tool !== "edit" && tool !== "write" && tool !== "str_replace" && tool !== "replace") continue;
        const fp = (input.filePath ?? input.file_path ?? input.path) as string | undefined;
        if (fp) files.add(fp);
      }
    }
    return files.size;
  });
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  const rightPanelOpen = useStore((s) => s.rightPanelOpen);
  const sidebarWidth = useStore((s) => s.sidebarWidth);
  const rightWidth = useStore((s) => s.rightWidth);
  const setSidebarWidth = useStore((s) => s.setSidebarWidth);
  const setRightWidth = useStore((s) => s.setRightWidth);
  const toggleSidebar = useStore((s) => s.toggleSidebar);
  const toggleRightPanel = useStore((s) => s.toggleRightPanel);
  const setRightPanelOpen = useStore((s) => s.setRightPanelOpen);
  const setSettingsOpen = useStore((s) => s.setSettingsOpen);
  const setHelpOpen = useStore((s) => s.setHelpOpen);
  const pendingPermissions = useStore((s) => s.pendingPermissions);
  const pendingQuestions = useStore((s) => s.pendingQuestions);
  const autoApprove = useStore((s) => s.settings.autoApprove);
  const pinnedSessions = useStore((s) => s.pinnedSessions);
  const agents = useStore((s) => s.agents);
  const messagesBySession = useStore((s) => s.messagesBySession);

  const hasChanges = changedFileCount > 0;
  const activeSession = sessions.find((s) => s.id === activeSessionId);
  const parentSession = activeSession?.parentID
    ? sessions.find((s) => s.id === activeSession.parentID)
    : undefined;
  const activeIsChild = !!parentSession;
  // Session.agent isn't populated on v1; the subagent's name rides on its first
  // user message (the dispatch prompt), which carries the spawning agent.
  const childAgentLabel = activeIsChild
    ? (() => {
        const msgs = activeSessionId ? messagesBySession[activeSessionId] ?? [] : [];
        const firstUser = msgs.find((m) => m.info.role === "user");
        const agentName = firstUser?.info.role === "user" ? firstUser.info.agent : undefined;
        return agents.find((a) => a.name === agentName)?.name ?? agentName ?? "Subagent";
      })()
    : "";
  const headerTitle = activeIsChild
    ? `${parentSession!.title || "Untitled"} - ${childAgentLabel}`
    : activeSession?.title;

  const dragRef = useRef<null | (() => void)>(null);

  const startResize = (side: "left" | "right") => (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = side === "left" ? sidebarWidth : rightWidth;
    const setter = side === "left" ? setSidebarWidth : setRightWidth;
    const onMove = (ev: MouseEvent) => {
      const dx = ev.clientX - startX;
      const next = side === "left" ? startW + dx : startW - dx;
      setter(Math.max(160, Math.min(640, Math.round(next))), false);
    };
    const cleanup = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      dragRef.current = null;
    };
    const onUp = () => {
      // Persist once at the end of the drag (avoid localStorage-per-pixel).
      const finalW = side === "left" ? useStore.getState().sidebarWidth : useStore.getState().rightWidth;
      setter(finalW, true);
      cleanup();
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    dragRef.current = cleanup;
  };

  // If a panel unmounts mid-drag, release the listeners + body style.
  useEffect(() => () => dragRef.current?.(), []);

  const [bannerDismissed, setBannerDismissed] = useState(false);
  useEffect(() => {
    if (errorMessage) setBannerDismissed(false);
  }, [errorMessage]);

  useEffect(() => {
    postMessage({ type: "getContext" });
  }, []);

  useEffect(() => {
    if (!autoApprove) return;
    for (const perm of pendingPermissions) {
      postMessage({
        type: "replyPermission",
        sessionId: perm.sessionID,
        permissionId: perm.id,
        decision: "once",
      });
    }
  }, [autoApprove, pendingPermissions]);

  // Attention cue when something blocks the agent and needs the user — a
  // question, or a permission request that isn't auto-approved (YOLO). Tracks
  // counts so it only fires when a new item actually arrives.
  const prevQCountRef = useRef(0);
  const prevPCountRef = useRef(0);
  useEffect(() => {
    const qCount = pendingQuestions.length;
    const pCount = pendingPermissions.length;
    const grew =
      qCount > prevQCountRef.current ||
      (!autoApprove && pCount > prevPCountRef.current);
    prevQCountRef.current = qCount;
    prevPCountRef.current = pCount;
    if (grew && useStore.getState().settings.soundOnComplete) playAttentionSound();
  }, [pendingQuestions, pendingPermissions, autoApprove]);

  useEffect(() => {
    const isMac = navigator.platform.toLowerCase().includes("mac");
    const mod = isMac ? "metaKey" : "ctrlKey";
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing =
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable);

      if (e.key === "Escape") {
        if (useStore.getState().settingsOpen) {
          setSettingsOpen(false);
          return;
        }
        if (useStore.getState().helpOpen) {
          setHelpOpen(false);
          return;
        }
        const active = useStore.getState().activeSessionId;
        const status = active ? useStore.getState().sessionStatus[active] : undefined;
        if (!typing && status?.type === "busy") {
          e.preventDefault();
          postMessage({ type: "abortSession", sessionId: active! });
        }
        return;
      }

      if (e.key === "?" && !typing) {
        e.preventDefault();
        setHelpOpen(true);
        return;
      }

      if (e[mod] && e.shiftKey && (e.key === "S" || e.key === "s")) {
        e.preventDefault();
        toggleSidebar();
        return;
      }

      if (e[mod] && !e.shiftKey && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        postMessage({ type: "createSession" });
        return;
      }

      if (e[mod] && (e.key === "l" || e.key === "L") && !e.shiftKey) {
        e.preventDefault();
        const ta = document.querySelector<HTMLTextAreaElement>(".chat-input-textarea");
        ta?.focus();
        return;
      }

      if (e[mod] && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
        if (sessions.length === 0) return;
        e.preventDefault();
        // Navigation order mirrors the SessionList: pinned first (by updated),
        // then the rest (by updated) — keeps ↑/↓ consistent with the screen.
        const pinnedSet = new Set(pinnedSessions);
        const ordered = [
          ...sessions.filter((s) => pinnedSet.has(s.id)).sort((a, b) => b.time.updated - a.time.updated),
          ...sessions.filter((s) => !pinnedSet.has(s.id)).sort((a, b) => b.time.updated - a.time.updated),
        ];
        const currentPos = ordered.findIndex((s) => s.id === activeSessionId);
        let nextIdx: number;
        if (currentPos === -1) {
          nextIdx = e.key === "ArrowUp" ? 0 : ordered.length - 1;
        } else {
          nextIdx =
            e.key === "ArrowUp"
              ? Math.max(0, currentPos - 1)
              : Math.min(ordered.length - 1, currentPos + 1);
        }
        const next = ordered[nextIdx];
        if (next) postMessage({ type: "openSession", sessionId: next.id });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sessions, activeSessionId, pinnedSessions, setSettingsOpen, setHelpOpen, toggleSidebar]);

  const showError =
    !bannerDismissed &&
    (serverStatus === "error" || (!!errorMessage && serverStatus !== "starting"));

  const statusClass =
    serverStatus === "ready" ? "ok" : serverStatus === "starting" ? "pending" : "error";
  const statusLabel =
    serverStatus === "ready" ? "Connected" : serverStatus === "starting" ? "Starting…" : "Error";

  const isStarting = serverStatus === "starting";

  return (
    <div className="app-root">
      <header className="app-header">
        <div className="app-title" title={headerTitle ?? "OpenCode"}>
          <span className="app-title-mark" aria-hidden="true">✦</span>
          <span className="app-title-text">{headerTitle || "OpenCode"}</span>
        </div>
        <div className="header-right">
          <button
            className="header-new-chat"
            title="New chat (⌘K)"
            aria-label="New chat"
            onClick={() => postMessage({ type: "createSession" })}
          >
            <NewChatIcon />
            <span className="header-new-chat-label">New</span>
          </button>
          <span
            className={`header-status header-status-${statusClass}`}
            title={statusLabel}
            aria-label={statusLabel}
          >
            <span className="header-status-dot" aria-hidden="true" />
          </span>
          {autoApprove && (
            <span
              className="header-yolo"
              title="YOLO mode is on — tool requests are auto-approved (per request)"
              aria-label="YOLO mode on"
            >
              YOLO
            </span>
          )}
          <button
            className={`header-toggle ${sidebarOpen ? "active" : ""}`}
            title={sidebarOpen ? "Hide sessions" : "Show sessions"}
            aria-label={sidebarOpen ? "Hide sessions" : "Show sessions"}
            aria-pressed={sidebarOpen}
            onClick={toggleSidebar}
          >
            <PanelIcon />
          </button>
          <button
            className={`header-toggle ${rightPanelOpen ? "active" : ""}`}
            title={rightPanelOpen ? "Hide inspect panel" : "Show inspect panel"}
            aria-label={rightPanelOpen ? "Hide inspect panel" : "Show inspect panel"}
            aria-pressed={rightPanelOpen}
            onClick={toggleRightPanel}
          >
            <InspectIcon />
            {hasChanges && (
              <span className="header-toggle-badge">{changedFileCount}</span>
            )}
          </button>
          <button
            className="header-toggle"
            title="Help (Shift+?)"
            aria-label="Help"
            onClick={() => setHelpOpen(true)}
          >
            <HelpIcon />
          </button>
          <button
            className="header-toggle"
            title="Settings"
            aria-label="Settings"
            onClick={() => setSettingsOpen(true)}
          >
            <SlidersIcon />
          </button>
        </div>
      </header>

      {showError && (
        <div className="banner banner-error" role="alert">
          <span className="banner-icon" aria-hidden="true">⚠</span>
          <span className="banner-text">
            {serverStatus === "error" ? "OpenCode server error." : "Error."} {errorMessage ?? ""}
          </span>
          <button
            className="banner-retry"
            title="Retry connection"
            onClick={() => {
              setBannerDismissed(false);
              postMessage({ type: "retryConnection" });
            }}
          >
            Retry
          </button>
          <button
            className="banner-dismiss"
            title="Dismiss"
            aria-label="Dismiss error"
            onClick={() => setBannerDismissed(true)}
          >
            ✕
          </button>
        </div>
      )}

      <div className="app-body">
        {sidebarOpen ? (
          <>
            <aside className="app-sidebar" style={{ flexBasis: sidebarWidth }}>
              <SessionList />
            </aside>
            <div
              className="resize-handle"
              title="Drag to resize"
              onMouseDown={startResize("left")}
            />
          </>
        ) : null}

        <main className="app-main">
          {isStarting ? (
            <div className="app-loading">
              <div className="spinner" />
              <div className="app-loading-text">Starting OpenCode…</div>
            </div>
          ) : activeSessionId ? (
            <>
              <ChatView sessionId={activeSessionId} />
              {activeIsChild ? (
                <div className="subagent-back-bar">
                  <button
                    className="subagent-back-btn"
                    title="Back to main chat"
                    onClick={() => postMessage({ type: "openSession", sessionId: parentSession!.id })}
                  >
                    <span className="subagent-back-arrow" aria-hidden="true">←</span>
                    <span>Back to <strong>{parentSession!.title || "Untitled"}</strong></span>
                  </button>
                </div>
              ) : (
                <>
                  <QueueBar />
                  <ChatInput sessionId={activeSessionId} />
                  <QuestionOverlay sessionId={activeSessionId} />
                </>
              )}
            </>
          ) : (
            <div className="chat-empty">
              <div className="chat-empty-glow">✦</div>
              <div className="chat-empty-title">No active session</div>
              <div className="chat-empty-sub">Create a new session to start chatting with OpenCode.</div>
              <button
                className="btn btn-primary"
                onClick={() => postMessage({ type: "createSession" })}
              >
                + New Session
              </button>
            </div>
          )}
        </main>

        {rightPanelOpen && activeSessionId && (
          <>
            <div
              className="resize-handle"
              title="Drag to resize"
              onMouseDown={startResize("right")}
            />
            <aside className="app-right" style={{ flexBasis: rightWidth }}>
              <div className="app-right-head">
                <span className="app-right-title">Inspect</span>
                <button
                  className="panel-collapse-btn"
                  title="Hide panel"
                  onClick={toggleRightPanel}
                >
                  ✕
                </button>
              </div>
              <InspectPanel sessionId={activeSessionId} />
            </aside>
          </>
        )}
      </div>

      <SettingsPanel />
      <HelpModal />
    </div>
  );
}

function NewChatIcon(): React.ReactElement {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M2.5 4.5 a1.5 1.5 0 0 1 1.5 -1.5 h6 a1.5 1.5 0 0 1 1.5 1.5 v0.5"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        fill="none"
      />
      <path
        d="M2.5 6.5 v3 a1.5 1.5 0 0 0 1.5 1.5 h1 v2 l2.5 -2 h2.5 a1.5 1.5 0 0 0 1.5 -1.5 v-1"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
      <line x1="11.5" y1="2.2" x2="11.5" y2="5.2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <line x1="10" y1="3.7" x2="13" y2="3.7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function PanelIcon(): React.ReactElement {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="2" y="3" width="12" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
      <line x1="6.5" y1="3" x2="6.5" y2="13" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

function InspectIcon(): React.ReactElement {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="2" y="3" width="12" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
      <line x1="9.5" y1="3" x2="9.5" y2="13" stroke="currentColor" strokeWidth="1.2" />
      <line x1="2" y1="6.5" x2="14" y2="6.5" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

function SlidersIcon(): React.ReactElement {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <line x1="2" y1="4" x2="14" y2="4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <line x1="2" y1="8" x2="14" y2="8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <line x1="2" y1="12" x2="14" y2="12" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <circle cx="6" cy="4" r="1.8" fill="var(--vscode-editor-background, #1e1e1e)" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="10" cy="8" r="1.8" fill="var(--vscode-editor-background, #1e1e1e)" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="5" cy="12" r="1.8" fill="var(--vscode-editor-background, #1e1e1e)" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}

function HelpIcon(): React.ReactElement {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="6.2" stroke="currentColor" strokeWidth="1.2" />
      <path d="M6.2 6.2 a1.8 1.8 0 1 1 2.6 1.6 c-0.7 0.4 -1 0.8 -1 1.6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" fill="none" />
      <circle cx="8" cy="11.4" r="0.7" fill="currentColor" />
    </svg>
  );
}
