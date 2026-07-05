import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useStore } from "../store/store";
import { postMessage } from "../api/vscodeApi";
import { formatTokenCount, findLastAssistantWithTokens } from "../utils";
import { ChangesList } from "./ChangesList";
import { SkillsView } from "./SkillsView";
import type { McpServerStatus } from "../api/types";

interface InspectPanelProps {
  sessionId: string;
}

export function InspectPanel({ sessionId }: InspectPanelProps): React.ReactElement {
  useEffect(() => {
    postMessage({ type: "refreshInspect" });
  }, [sessionId]);

  return (
    <>
      <ContextUsage sessionId={sessionId} />
      <TodoChecklist sessionId={sessionId} />
      <ChangesList sessionId={sessionId} />
      <McpServers />
      <LspServers />
      <SkillsView />
    </>
  );
}

function ContextUsage({ sessionId }: { sessionId: string }): React.ReactElement | null {
  const messages = useStore((s) => s.messagesBySession[sessionId]);
  const providers = useStore((s) => s.providers);
  const [open, setOpen] = useState(true);
  const legendOpen = useStore((s) => s.contextLegendOpen);
  const setLegendOpen = useStore((s) => s.setContextLegendOpen);
  const [segHover, setSegHover] = useState<{ key: string; x: number; y: number } | null>(null);

  const last = findLastAssistantWithTokens(messages);
  if (!last) return null;

  const tokens = last.tokens;
  if (!tokens) return null;
  const fresh = tokens.input + tokens.cache.write;
  const cached = tokens.cache.read;
  const used = fresh + cached;

  const provider = providers.find((p) => p.id === last.providerID);
  const model = provider?.models.find((m) => m.modelID === last.modelID);
  const limit = model?.limit.context ?? 0;
  const pct = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;

  const segs = [
    { key: "fresh", value: fresh, color: "var(--vscode-charts-blue, #4aa5ff)", label: "Fresh input" },
    { key: "cache", value: cached, color: "var(--vscode-charts-purple, #b079e0)", label: "Cached" },
  ];

  return (
    <div className="panel-section">
      <button className="panel-header" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="panel-caret">{open ? "▾" : "▸"}</span>
        <span className="panel-title">Context</span>
        {limit > 0 && <span className="panel-count">{pct}%</span>}
      </button>
      {open && (
        <div className="context-usage">
          {limit > 0 ? (
            <>
              <div className="context-bar-wrap">
                <div className="context-bar context-bar-segmented" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
                  {segs.map((s) => {
                    const w = limit > 0 ? (s.value / limit) * 100 : 0;
                    return (
                      <div
                        key={s.key}
                        className="context-bar-seg"
                        style={{ width: `${w}%`, background: s.color }}
                        onMouseEnter={(e) => {
                          const r = e.currentTarget.getBoundingClientRect();
                          setSegHover({ key: s.key, x: r.left + r.width / 2, y: r.bottom + 6 });
                        }}
                        onMouseLeave={() => setSegHover((h) => (h?.key === s.key ? null : h))}
                      />
                    );
                  })}
                </div>
              </div>
              {segHover &&
                createPortal(
                  (() => {
                    const s = segs.find((x) => x.key === segHover.key);
                    if (!s) return null;
                    const segPctOfLimit = limit > 0 ? Math.round((s.value / limit) * 100) : 0;
                    const segPctOfUsed = used > 0 ? Math.round((s.value / used) * 100) : 0;
                    return (
                      <div
                        className="context-seg-tooltip"
                        role="tooltip"
                        style={{ position: "fixed", left: segHover.x, top: segHover.y, transform: "translateX(-50%)" }}
                      >
                        <div className="context-seg-tooltip-head">
                          <span className="context-legend-dot" style={{ background: s.color }} />
                          <span>{s.label}</span>
                        </div>
                        <div className="context-seg-tooltip-row">{formatTokenCount(s.value)} tokens</div>
                        <div className="context-seg-tooltip-row">{segPctOfUsed}% of context</div>
                        <div className="context-seg-tooltip-row">{segPctOfLimit}% of limit</div>
                      </div>
                    );
                  })(),
                  document.body,
                )}
              <div className="context-usage-label">
                {used.toLocaleString()} / {limit.toLocaleString()} ({pct}%)
              </div>
              <div className="context-legend-toggle-row">
                <button
                  type="button"
                  className="context-legend-toggle"
                  onClick={() => setLegendOpen(!legendOpen)}
                  aria-expanded={legendOpen}
                >
                  {legendOpen ? "Hide legend" : "Show legend"}
                </button>
              </div>
              {legendOpen && (
                <ul className="context-legend">
                  {segs.map((s) => {
                    const segPctOfLimit = limit > 0 ? Math.round((s.value / limit) * 100) : 0;
                    return (
                      <li key={s.key} className="context-legend-row" title={`${s.label}: ${formatTokenCount(s.value)} (${segPctOfLimit}% of limit)`}>
                        <span className="context-legend-dot" style={{ background: s.color }} />
                        <span className="context-legend-label">{s.label}</span>
                        <span className="context-legend-value">{formatTokenCount(s.value)}</span>
                        <span className="context-legend-pct">{segPctOfLimit}%</span>
                      </li>
                    );
                  })}
                  {tokens.reasoning > 0 && (
                    <li
                      className="context-legend-row context-legend-aux"
                      title={`Reasoning (output, not counted toward input context): ${formatTokenCount(tokens.reasoning)}`}
                    >
                      <span className="context-legend-dot" style={{ background: "var(--vscode-charts-orange, #e07b00)" }} />
                      <span className="context-legend-label">Reasoning (output)</span>
                      <span className="context-legend-value">{formatTokenCount(tokens.reasoning)}</span>
                      <span className="context-legend-pct" aria-hidden="true">—</span>
                    </li>
                  )}
                </ul>
              )}
            </>
          ) : (
            <div className="context-usage-label">{formatTokenCount(used)} tokens</div>
          )}
        </div>
      )}
    </div>
  );
}

function TodoChecklist({ sessionId }: { sessionId: string }): React.ReactElement | null {
  const todos = useStore((s) => s.todosBySession[sessionId]);
  const [open, setOpen] = useState(true);

  const list = todos ?? [];
  if (list.length === 0) return null;

  return (
    <div className="panel-section">
      <button className="panel-header" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="panel-caret">{open ? "▾" : "▸"}</span>
        <span className="panel-title">Todo</span>
        <span className="panel-count">{list.length}</span>
      </button>
      {open && (
        <ul className="todo-list">
          {list.map((todo) => (
            <li key={todo.id} className={`todo-item todo-status-${todo.status}`}>
              <span className="todo-icon" aria-hidden="true">
                {todoIcon(todo.status)}
              </span>
              <span className="todo-content">{todo.content}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function McpServers(): React.ReactElement | null {
  const mcpStatus = useStore((s) => s.mcpStatus);
  const [open, setOpen] = useState(true);

  const entries = Object.entries(mcpStatus);
  if (entries.length === 0) return null;

  return (
    <div className="panel-section">
      <button className="panel-header" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="panel-caret">{open ? "▾" : "▸"}</span>
        <span className="panel-title">MCP servers</span>
        <span className="panel-count">{entries.length}</span>
      </button>
      {open && (
        <ul className="status-list">
          {entries.map(([name, status]) => (
            <li key={name} className="status-item" title={mcpTooltip(status)}>
              <span className={`status-dot status-dot-${statusTone(status.status)}`} />
              <span className="status-name">{name}</span>
              <span className="status-label">{status.status}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function LspServers(): React.ReactElement | null {
  const lspStatus = useStore((s) => s.lspStatus);
  const [open, setOpen] = useState(true);

  if (lspStatus.length === 0) return null;

  return (
    <div className="panel-section">
      <button className="panel-header" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="panel-caret">{open ? "▾" : "▸"}</span>
        <span className="panel-title">LSP servers</span>
        <span className="panel-count">{lspStatus.length}</span>
      </button>
      {open && (
        <ul className="status-list">
          {lspStatus.map((server) => (
            <li key={server.id || server.name} className="status-item" title={server.root}>
              <span
                className={`status-dot status-dot-${server.status === "connected" ? "ok" : "error"}`}
              />
              <span className="status-name">{server.name}</span>
              <span className="status-label">{server.status}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function todoIcon(status: string): string {
  switch (status) {
    case "completed":
      return "✓";
    case "in_progress":
      return "◐";
    case "cancelled":
      return "✕";
    case "pending":
    default:
      return "○";
  }
}

function statusTone(status: string): "ok" | "error" | "warn" | "off" {
  switch (status) {
    case "connected":
      return "ok";
    case "failed":
    case "needs_client_registration":
      return "error";
    case "needs_auth":
      return "warn";
    case "disabled":
    default:
      return "off";
  }
}

function mcpTooltip(status: McpServerStatus): string {
  return status.error ? `${status.status}: ${status.error}` : status.status;
}
