import { useEffect, useState } from "react";
import { useStore } from "../store/store";
import { postMessage } from "../api/vscodeApi";
import { formatTokenCount } from "../utils";
import { ChangesList } from "./ChangesList";
import { SkillsView } from "./SkillsView";
import type { AssistantMessage, McpServerStatus, MessageWithParts } from "../api/types";

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

  const last = findLastAssistantWithTokens(messages);
  if (!last) return null;

  const tokens = last.tokens;
  const used =
    tokens.input + tokens.cache.read + tokens.cache.write;

  const provider = providers.find((p) => p.id === last.providerID);
  const model = provider?.models.find((m) => m.modelID === last.modelID);
  const limit = model?.limit.context ?? 0;
  const pct = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;

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
              <div className="context-bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
                <div className="context-bar-fill" style={{ width: `${pct}%` }} />
              </div>
              <div className="context-usage-label">
                {used.toLocaleString()} / {limit.toLocaleString()} ({pct}%)
              </div>
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

function findLastAssistantWithTokens(
  messages: MessageWithParts[] | undefined,
): AssistantMessage | null {
  if (!messages) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const info = messages[i].info;
    if (info.role === "assistant" && info.tokens) {
      const t = info.tokens;
      if (t.input + t.output + t.reasoning + t.cache.read + t.cache.write > 0) {
        return info;
      }
    }
  }
  return null;
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
