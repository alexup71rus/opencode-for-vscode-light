import { useEffect, useState } from "react";
import { useStore } from "../store/store";
import { postMessage } from "../api/vscodeApi";
import { formatDuration } from "../utils";
import { fileIconClass } from "../utils/fileIcon";
import { buildDiffRows, extractFilePath, asString } from "../diff";
import type { DiffRow } from "../diff";
import { DiffRows } from "./DiffRows";
import type { ToolPart } from "../api/types";

interface ToolCallViewProps {
  sessionId: string;
  part: ToolPart;
  /** For `task` tool calls: the spawned subagent session, if resolvable. */
  childSessionId?: string;
}

const STATUS_LABEL: Record<ToolPart["state"]["status"], string> = {
  pending: "queued",
  running: "running",
  completed: "done",
  error: "failed",
};

function shortToolName(tool: string): string {
  if (tool.length <= 16) return tool;
  return `${tool.slice(0, 15)}…`;
}

const TODO_STATUS_ICON: Record<string, string> = {
  completed: "✓",
  in_progress: "◐",
  pending: "○",
  cancelled: "✕",
};

function todoStatusIcon(status: string): string {
  return TODO_STATUS_ICON[status] ?? "○";
}

/** Readable checklist for a todowrite tool call (replaces raw JSON dump). */
function TodoWriteView({ input }: { input: { [key: string]: unknown } | null | undefined }): React.ReactElement {
  const raw = input?.todos;
  const todos = Array.isArray(raw)
    ? (raw as Array<Record<string, unknown>>).map((t) => ({
        content: typeof t.content === "string" ? t.content : String(t.content ?? ""),
        status: typeof t.status === "string" ? t.status : "pending",
        priority: typeof t.priority === "string" ? t.priority : "medium",
      }))
    : [];
  const done = todos.filter((t) => t.status === "completed").length;
  return (
    <div className="tool-section">
      <div className="tool-section-head">
        <div className="tool-section-label">Todos</div>
        <span className="diff-stats">{done}/{todos.length} done</span>
      </div>
      <ul className="todowrite-list">
        {todos.map((t, i) => (
          <li key={i} className={`todowrite-item todo-status-${t.status}`}>
            <span className="todowrite-icon">{todoStatusIcon(t.status)}</span>
            <span className="todowrite-content">{t.content}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function renderFileDiff(
  tool: string,
  input: { [key: string]: unknown } | null | undefined,
): React.ReactElement | null {
  if (!input || typeof input !== "object") return null;
  const t = tool.toLowerCase();
  const isEdit = t === "edit" || t === "str_replace" || t === "replace";
  const isWrite = t === "write";
  if (!isEdit && !isWrite) return null;

  const filePath = extractFilePath(input);
  let rows: DiffRow[];
  let label: string;
  if (isEdit) {
    const oldStr = asString(input.oldString) ?? asString(input.old_str) ?? "";
    const newStr = asString(input.newString) ?? asString(input.new_str) ?? "";
    rows = buildDiffRows(oldStr, newStr);
    label = "Diff";
  } else {
    const content = asString(input.content) ?? "";
    rows = buildDiffRows("", content);
    label = "New file";
  }

  const additions = rows.filter((r) => r.type === "add").length;
  const deletions = rows.filter((r) => r.type === "del").length;

  return (
    <div className="tool-section">
      <div className="tool-section-head">
        <div className="tool-section-label">{label}</div>
        {(additions > 0 || deletions > 0) && (
          <span className="diff-stats">
            {additions > 0 && <span className="diff-add-count">+{additions}</span>}
            {deletions > 0 && <span className="diff-del-count">-{deletions}</span>}
          </span>
        )}
      </div>
      {filePath && <div className="diff-path">{filePath}</div>}
      <pre className="tool-pre diff-pre">
        <DiffRows rows={rows} />
      </pre>
      {filePath && (
        <button
          className="btn btn-xs diff-open-btn"
          onClick={() =>
            postMessage({
              type: "openFileDiff",
              filePath,
              edits: isEdit
                ? [
                    {
                      oldStr: asString(input.oldString) ?? asString(input.old_str) ?? "",
                      newStr: asString(input.newString) ?? asString(input.new_str) ?? "",
                    },
                  ]
                : [],
              isNewFile: isWrite,
            })
          }
        >
          Open diff
        </button>
      )}
    </div>
  );
}

const CODE_KEYS = new Set([
  "command", "cmd", "content", "prompt", "description", "body", "script", "text", "code", "instructions",
]);

const LABEL_OVERRIDES: Record<string, string> = {
  command: "Command",
  cmd: "Command",
  content: "Content",
  prompt: "Prompt",
  description: "Description",
  body: "Body",
  filepath: "File path",
  file_path: "File path",
  path: "Path",
  url: "URL",
  pattern: "Pattern",
  query: "Query",
  include: "Include",
  oldstring: "Old",
  old_str: "Old",
  newstring: "New",
  new_str: "New",
  subagent_type: "Subagent",
  timeout: "Timeout",
  offset: "Offset",
  limit: "Limit",
  range: "Range",
};

function prettyKey(key: string): string {
  return LABEL_OVERRIDES[key.toLowerCase()] ?? key;
}

function renderFieldValue(key: string, value: unknown): React.ReactElement {
  const lk = key.toLowerCase();
  if (typeof value === "string") {
    if (CODE_KEYS.has(lk) || value.includes("\n") || value.length > 100) {
      return <pre className="tool-pre">{value}</pre>;
    }
    return <span className="tool-field-value">{value}</span>;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return <span className="tool-field-value">{String(value)}</span>;
  }
  if (value === null) {
    return <span className="tool-field-value tool-field-null">null</span>;
  }
  return <pre className="tool-pre">{JSON.stringify(value, null, 2)}</pre>;
}

/** Render every key of a tool input as a labeled field (no raw JSON dump). */
function renderToolInput(
  input: { [key: string]: unknown } | null | undefined,
): React.ReactElement | null {
  if (!input || typeof input !== "object") return null;
  const raw = Object.entries(input).filter(([, v]) => v !== undefined && v !== "");

  // Collapse a read tool's offset/limit into one compact "Range" field so it
  // doesn't occupy two lines for a single conceptual entity.
  const offEntry = raw.find(([k]) => k.toLowerCase() === "offset");
  const limEntry = raw.find(([k]) => k.toLowerCase() === "limit");
  let entries: Array<[string, unknown]>;
  if (offEntry || limEntry) {
    const rest = raw.filter(
      ([k]) => k.toLowerCase() !== "offset" && k.toLowerCase() !== "limit",
    );
    const off = offEntry ? Number(offEntry[1]) : undefined;
    const lim = limEntry ? Number(limEntry[1]) : undefined;
    let range: string;
    if (off && off > 0 && lim && lim > 0) range = `lines ${off}–${off + lim}`;
    else if (lim && lim > 0) range = `first ${lim} lines`;
    else if (off && off > 0) range = `from line ${off}`;
    else range = String((limEntry ?? offEntry)?.[1] ?? "");
    entries = [...rest, ["range", range]];
  } else {
    entries = raw;
  }

  if (entries.length === 0) return null;
  return (
    <div className="tool-section">
      <div className="tool-section-label">Input</div>
      <div className="tool-fields">
        {entries.map(([key, value]) => (
          <div className="tool-field" key={key}>
            <span className="tool-field-key">{prettyKey(key)}</span>
            {renderFieldValue(key, value)}
          </div>
        ))}
      </div>
    </div>
  );
}

export function ToolCallView({ sessionId, part, childSessionId }: ToolCallViewProps): React.ReactElement {
  const { state, tool } = part;
  const status = state.status;
  const t = tool.toLowerCase();
  const isBash = t === "bash";
  const isEdit = t === "edit" || t === "str_replace" || t === "replace" || t === "write";
  const isSubagent = !!childSessionId;

  const autoExpandBash = useStore((s) => s.settings.autoExpandBash);
  const autoExpandEdit = useStore((s) => s.settings.autoExpandEdit);
  const autoExpandError = useStore((s) => s.settings.autoExpandError);

  const [expanded, setExpanded] = useState(
    () => (autoExpandBash && isBash) || (autoExpandEdit && isEdit),
  );
  // Auto-open when a tool errors, even if the user collapsed it earlier.
  useEffect(() => {
    if (autoExpandError && status === "error") setExpanded(true);
  }, [autoExpandError, status]);

  const title =
    status === "completed"
      ? state.title
      : status === "running" && state.title
        ? state.title
        : "";

  const duration =
    status === "completed" || status === "error"
      ? state.time.end - state.time.start
      : status === "running"
        ? Date.now() - state.time.start
        : 0;

  const inputView =
    t === "question"
      ? (
        <div className="tool-section">
          <div className="tool-section-label">Waiting for your answer in the panel below…</div>
        </div>
      )
      : t === "todowrite"
        ? <TodoWriteView input={state.input} />
        : renderFileDiff(tool, state.input) ?? renderToolInput(state.input);
  // todowrite echoes the same todos as output; read dumps the whole file;
  // edit/write just confirm "applied/wrote successfully" — all noise on
  // success, so suppress them and keep Output only when the call errored.
  const SUPPRESS_OUTPUT = new Set(["todowrite", "read", "edit", "write"]);
  const output =
    status === "error"
      ? state.error
      : status === "completed" && SUPPRESS_OUTPUT.has(t)
        ? ""
        : status === "completed"
          ? state.output
          : "";

  const filePath = extractFilePath(state.input ?? {});
  const iconCls = filePath ? fileIconClass(filePath) : null;
  const hasDetail = inputView !== null || Boolean(output);

  const category = isSubagent ? "subagent" : isBash ? "bash" : isEdit ? "edit" : "other";

  return (
    <div className={`tool-call tool-${status} cat-${category} ${expanded ? "expanded" : ""}`}>
      <div
        className={`tool-call-row ${hasDetail ? "clickable" : ""}`}
        onClick={() => hasDetail && setExpanded((v) => !v)}
        role={hasDetail ? "button" : undefined}
        tabIndex={hasDetail ? 0 : undefined}
        aria-expanded={hasDetail ? expanded : undefined}
        aria-label={hasDetail ? `${tool} — ${STATUS_LABEL[status]}` : undefined}
      >
        <span className={`tool-status-dot tool-status-${status}`} />
        {category !== "other" && category !== "edit" && (
          <span className={`tool-cat tool-cat-${category}`} aria-hidden="true">
            {category === "subagent" ? "⇉" : "$"}
          </span>
        )}
        <span className="tool-name" title={tool}>{shortToolName(tool)}</span>
        {iconCls && (
          <span className={`codicon ${iconCls} tool-file-icon`} title={filePath} aria-hidden="true" />
        )}
        {title && <span className="tool-title">{title}</span>}
        {childSessionId && (
          <button
            className="tool-subagent-btn"
            title="Open subagent chat"
            onClick={(e) => {
              e.stopPropagation();
              postMessage({ type: "openSession", sessionId: childSessionId });
            }}
          >
            Open chat →
          </button>
        )}
        <span className="tool-meta">
          {duration > 0 && <span className="tool-duration">{formatDuration(duration)}</span>}
          <span className="tool-state-label">{STATUS_LABEL[status]}</span>
          {hasDetail && <span className="tool-caret">{expanded ? "▾" : "▸"}</span>}
        </span>
      </div>

      {expanded && hasDetail && (
        <div className="tool-call-detail">
              {inputView}
                  {output && (
                    <div className="tool-section">
                      <div className="tool-section-head">
                        <div className="tool-section-label">{status === "error" ? "Error" : "Output"}</div>
                        <button
                          className="tool-copy-btn"
                          title="Copy output"
                          onClick={() => postMessage({ type: "copyText", text: output })}
                        >
                          Copy
                        </button>
                      </div>
                      <pre className={`tool-pre ${status === "error" ? "tool-pre-error" : ""}`}>{output}</pre>
                    </div>
                  )}
        </div>
      )}
    </div>
  );
}
