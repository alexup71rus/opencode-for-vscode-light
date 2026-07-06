import { memo, useEffect, useMemo, useState } from "react";
import { ToolCallView } from "./ToolCallView";
import { postMessage } from "../api/vscodeApi";
import { useStore } from "../store/store";
import { formatCost, formatTokenCount, totalTokens, basename } from "../utils";
import { buildSendOptions } from "../compose";
import { extractFileChanges } from "../changes";
import type { MessageWithParts, Part, TextPart } from "../api/types";

interface MessageBubbleProps {
  sessionId: string;
  message: MessageWithParts;
  /** True when this is the last user message in the session. Used to show Edit button. */
  isLastUser: boolean;
  /** Maps a subtask part id to its child session id (positional best-effort). */
  subtaskChild: Map<string, string>;
  /** Maps a `task` tool part id to its child session id (positional best-effort). */
  taskChild: Map<string, string>;
  /** True while the agent is actively producing this (last assistant) bubble.
   *  Renders the typing loader inline instead of a separate trailing bubble. */
  streaming?: boolean;
}

const INLINE_PATTERN = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\[[^\]]+\]\([^)]+\))/g;

function isSafeUrl(url: string): boolean {
  const trimmed = url.trim();
  if (trimmed.startsWith("#") || trimmed.startsWith("/") || trimmed.startsWith("./")) {
    return true;
  }
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === "http:" || parsed.protocol === "https:" || parsed.protocol === "mailto:";
  } catch {
    return false;
  }
}

function parseInline(text: string, keyBase: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  const pattern = new RegExp(INLINE_PATTERN.source, "g");
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let i = 0;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index));
    }
    const token = match[0];
    const key = `${keyBase}-${i}`;
    if (token.startsWith("`")) {
      nodes.push(
        <code key={key} className="md-inline-code">
          {token.slice(1, -1)}
        </code>,
      );
    } else if (token.startsWith("**")) {
      nodes.push(
        <strong key={key} className="md-bold">
          {token.slice(2, -2)}
        </strong>,
      );
    } else {
      const linkMatch = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token);
      if (linkMatch) {
        const rawHref = linkMatch[2];
        if (isSafeUrl(rawHref)) {
          nodes.push(
            <a key={key} className="md-link" href={rawHref} target="_blank" rel="noopener noreferrer">
              {linkMatch[1]}
            </a>,
          );
        } else {
          nodes.push(
            <span key={key} className="md-link-disabled">
              {linkMatch[1]}
            </span>,
          );
        }
      }
    }
    lastIndex = match.index + token.length;
    i++;
  }
  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }
  return nodes;
}

function isBlockStart(ln: string): boolean {
  return (
    /^```/.test(ln) ||
    /^#{1,3}\s+/.test(ln) ||
    /^---+\s*$/.test(ln) ||
    /^>\s?/.test(ln) ||
    /^\s*[-*]\s+/.test(ln) ||
    /^\s*\d+\.\s+/.test(ln) ||
    /^\s*\|.*\|/.test(ln)
  );
}

function parseTableRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((c) => c.trim());
}

function isTableSeparator(line: string): boolean {
  const s = line.trim();
  if (!s.includes("-")) return false;
  if (!/^\|?[\s:|-]+$/.test(s)) return false;
  return true;
}

function tryParseTable(lines: string[], start: number): { header: string[]; body: string[][]; next: number } | null {
  if (start + 1 >= lines.length) return null;
  const headerLine = lines[start];
  const sepLine = lines[start + 1];
  if (!headerLine.includes("|")) return null;
  if (!isTableSeparator(sepLine)) return null;

  const header = parseTableRow(headerLine);
  const seps = parseTableRow(sepLine);
  if (header.length !== seps.length) return null;

  const body: string[][] = [];
  let idx = start + 2;
  while (idx < lines.length && lines[idx].includes("|") && lines[idx].trim() !== "") {
    body.push(parseTableRow(lines[idx]));
    idx++;
  }
  return { header, body, next: idx };
}

function renderMarkdown(text: string): React.ReactNode {
  const lines = text.split("\n");
  const blocks: React.ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];

    const fenceMatch = /^```(.*)$/.exec(line);
    if (fenceMatch) {
      const lang = fenceMatch[1].trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) {
        codeLines.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++;
      blocks.push(
        <div key={key++} className="md-code-block">
          {lang && <span className="md-code-lang">{lang}</span>}
          <pre className="md-code-pre">
            <code>{codeLines.join("\n")}</code>
          </pre>
        </div>,
      );
      continue;
    }

    const headerMatch = /^(#{1,3})\s+(.*)$/.exec(line);
    if (headerMatch) {
      const level = headerMatch[1].length;
      const content = parseInline(headerMatch[2], `h-${key}`);
      if (level === 1) {
        blocks.push(
          <h1 key={key++} className="md-h1">
            {content}
          </h1>,
        );
      } else if (level === 2) {
        blocks.push(
          <h2 key={key++} className="md-h2">
            {content}
          </h2>,
        );
      } else {
        blocks.push(
          <h3 key={key++} className="md-h3">
            {content}
          </h3>,
        );
      }
      i++;
      continue;
    }

    if (/^---+\s*$/.test(line)) {
      blocks.push(<hr key={key++} className="md-hr" />);
      i++;
      continue;
    }

    if (/^>\s?/.test(line)) {
      const quoteLines: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        quoteLines.push(lines[i].replace(/^>\s?/, ""));
        i++;
      }
      blocks.push(
        <blockquote key={key++} className="md-blockquote">
          {parseInline(quoteLines.join(" "), `bq-${key}`)}
        </blockquote>,
      );
      continue;
    }

    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, ""));
        i++;
      }
      blocks.push(
        <ul key={key++} className="md-ul">
          {items.map((it, idx) => (
            <li key={idx}>{parseInline(it, `ul-${key}-${idx}`)}</li>
          ))}
        </ul>,
      );
      continue;
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ""));
        i++;
      }
      blocks.push(
        <ol key={key++} className="md-ol">
          {items.map((it, idx) => (
            <li key={idx}>{parseInline(it, `ol-${key}-${idx}`)}</li>
          ))}
        </ol>,
      );
      continue;
    }

    if (line.trim() === "") {
      i++;
      continue;
    }

    const table = tryParseTable(lines, i);
    if (table) {
      blocks.push(
        <div key={key++} className="md-table-wrap">
          <table className="md-table">
            <thead>
              <tr>
                {table.header.map((h, ci) => (
                  <th key={ci}>{parseInline(h, `th-${key}-${ci}`)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {table.body.map((row, ri) => (
                <tr key={ri}>
                  {row.map((c, ci) => (
                    <td key={ci}>{parseInline(c, `td-${key}-${ri}-${ci}`)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      i = table.next;
      continue;
    }

    const paraLines: string[] = [];
    while (i < lines.length && lines[i].trim() !== "" && !isBlockStart(lines[i])) {
      paraLines.push(lines[i]);
      i++;
    }
    blocks.push(
      <p key={key++} className="md-p">
        {parseInline(paraLines.join(" "), `p-${key}`)}
      </p>,
    );
  }

  return <>{blocks}</>;
}

function ReasoningBlock({ part }: { part: Extract<Part, { type: "reasoning" }> }): React.ReactElement {
  const expandDefault = useStore((s) => s.settings.expandThinking);
  const [open, setOpen] = useState(expandDefault);
  const streaming = !part.time.end;
  return (
    <div className="reasoning-block">
      <button
        className="reasoning-header"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={streaming ? "Thinking, expand" : "Thought process, expand"}
      >
        <span className="reasoning-caret">{open ? "▾" : "▸"}</span>
        <span className="reasoning-label">{streaming ? "Thinking…" : "Thought process"}</span>
      </button>
      {open && <div className="reasoning-text">{part.text}</div>}
    </div>
  );
}

function SparkIcon(): React.ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M8 1.5 L9.6 6.4 L14.5 8 L9.6 9.6 L8 14.5 L6.4 9.6 L1.5 8 L6.4 6.4 Z"
        fill="currentColor"
      />
    </svg>
  );
}

function FileChipIcon(): React.ReactElement {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M3.5 2 H9.5 L12.5 5 V14 H3.5 Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
      <path d="M9.5 2 V5 H12.5" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  );
}

function MessageTimestamp({ ts }: { ts: number }): React.ReactElement {
  if (!ts) return <></>;
  const d = new Date(ts);
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return <span className="message-time">{time}</span>;
}

function textOf(message: MessageWithParts): string {
  return message.parts
    .filter((p): p is TextPart => p.type === "text" && !p.ignored)
    .map((p) => p.text)
    .join("\n")
    .trim();
}

// Compaction marker: a centered divider instead of a chat bubble. Matches the
// TUI's " Compaction " separator. The server emits a user message carrying a
// `compaction` part to trigger compaction; it is metadata, not a real prompt.
function CompactionDivider({ auto }: { auto: boolean }): React.ReactElement {
  return (
    <div className="compaction-divider" role="separator">
      <span className="compaction-divider-line" />
      <span className="compaction-divider-label">
        Context compacted{auto ? " · auto" : ""}
      </span>
      <span className="compaction-divider-line" />
    </div>
  );
}

// The compaction summary (assistant message with summary:true / mode:compaction)
// is a model-generated recap of the trimmed history. Render it muted and
// collapsible so it is distinguishable from a real answer and doesn't dominate.
function CompactionSummary({ text }: { text: string }): React.ReactElement {
  const [open, setOpen] = useState(false);
  return (
    <div className="compaction-summary">
      <button
        type="button"
        className="compaction-summary-toggle"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <span className="compaction-summary-badge">Compacted summary</span>
        <span className="compaction-summary-chevron">{open ? "Hide" : "Show"}</span>
      </button>
      {open && text && <div className="compaction-summary-body">{text}</div>}
    </div>
  );
}

export const MessageBubble = memo(function MessageBubble({
  sessionId,
  message,
  isLastUser,
  subtaskChild,
  taskChild,
  streaming,
}: MessageBubbleProps): React.ReactElement {
  const isUser = message.info.role === "user";
  const assistant = message.info.role === "assistant" ? message.info : null;
  const cost = assistant?.cost;
  const tokens = assistant?.tokens;
  const created = message.info.time.created;
  // Files this assistant turn touched — shown as a footer so the change set is
  // visible even with the sidebar closed. Derived from the message's tool
  // parts (the server's diff endpoints are empty on this opencode version).
  const changedFiles = useMemo(
    () => (isUser ? [] : extractFileChanges([message])),
    [isUser, message],
  );
  const fileExists = useStore((s) => s.fileExists);
  const checkFilesExist = useStore((s) => s.checkFilesExist);
  const changedPathsKey = changedFiles.map((cf) => cf.filePath).join("\n");
  useEffect(() => {
    if (!changedPathsKey) return;
    checkFilesExist(changedPathsKey.split("\n"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [changedPathsKey]);
  const [copied, setCopied] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  const body = textOf(message);

  const copy = async () => {
    if (!body) return;
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(body);
      } else {
        postMessage({ type: "copyText", text: body });
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      postMessage({ type: "copyText", text: body });
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    }
  };

  const retry = () => {
    if (!isUser || !body) return;
    // Resend the original user text under the user's selected model/agent, but
    // WITHOUT re-attaching the currently-active file/selection: that may have
    // changed since the message was first sent and would alter the result.
    postMessage({ type: "sendMessage", sessionId, text: body, options: buildSendOptions() });
  };

  const startEdit = () => {
    if (!isUser || !body) return;
    setDraft(body);
    setEditing(true);
  };

  const cancelEdit = () => {
    setEditing(false);
    setDraft("");
  };

  const saveEdit = () => {
    const trimmed = draft.trim();
    if (trimmed) {
      // Real "edit & resend": server reverts (truncates from this message +
      // reverts file changes) then sends the edited text as a new turn.
      postMessage({
        type: "editMessage",
        sessionId,
        messageID: message.info.id,
        text: trimmed,
        options: buildSendOptions(),
      });
    }
    setEditing(false);
    setDraft("");
  };

  // Compaction trigger (user message with a `compaction` part): render as a
  // separator, not a bubble — it's metadata, not a real user prompt.
  if (isUser && message.parts.some((p) => p.type === "compaction")) {
    const part = message.parts.find((p) => p.type === "compaction") as { auto?: boolean } | undefined;
    return <CompactionDivider auto={Boolean(part?.auto)} />;
  }

  // Compaction summary (assistant message, summary:true / mode:compaction):
  // muted + collapsible so it's distinguishable from a real assistant answer.
  if (assistant && (assistant.summary === true || assistant.mode === "compaction")) {
    return <CompactionSummary text={body ?? ""} />;
  }

  return (
    <div id={`msg-${message.info.id}`} className={`message message-${message.info.role}`}>
      <div className={`message-avatar ${isUser ? "message-avatar-user" : "message-avatar-ai"}`}>
        {isUser ? "U" : <SparkIcon />}
      </div>
      <div className="message-content">
        <div className="message-sender">
          {isUser ? "You" : assistant?.modelID || "Assistant"}
          <MessageTimestamp ts={created} />
        </div>
        <div className="message-parts">
          {editing && isUser ? (
            <div className="message-edit">
              <textarea
                className="message-edit-textarea"
                value={draft}
                autoFocus
                rows={Math.min(10, Math.max(2, draft.split("\n").length))}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                    e.preventDefault();
                    saveEdit();
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    cancelEdit();
                  }
                }}
              />
              <div className="message-edit-actions">
                <button className="btn btn-xs" onClick={cancelEdit}>
                  Cancel
                </button>
                <button className="btn btn-primary btn-xs" onClick={saveEdit} disabled={!draft.trim()}>
                  Save &amp; resend
                </button>
              </div>
            </div>
          ) : (
            message.parts.map((part, idx) => {
            switch (part.type) {
              case "text":
                if (part.ignored) return null;
                return (
                  <div key={part.id} className={`part-text ${isUser ? "part-text-user" : "part-text-md"}`}>
                    {isUser ? part.text : renderMarkdown(part.text)}
                  </div>
                );
              case "reasoning":
                return <ReasoningBlock key={part.id} part={part} />;
              case "tool":
                return (
                  <ToolCallView
                    key={part.id}
                    sessionId={sessionId}
                    part={part}
                    childSessionId={taskChild.get(part.id)}
                  />
                );
              case "step-start":
                // Skip a divider at the very top of a bubble (the merged run
                // starts with one); keep it between steps as the "chain".
                if (idx === 0) return null;
                return <div key={part.id} className="part-divider" />;
              case "step-finish":
                return null;
              case "file":
                return (
                  <span key={part.id} className="chip chip-file" title={part.source?.path ?? part.filename}>
                    <span className="chip-icon"><FileChipIcon /></span>
                    <span className="chip-label">{part.filename ?? basename(part.source?.path ?? "file")}</span>
                  </span>
                );
              case "subtask": {
                const childId = subtaskChild.get(part.id);
                const open = childId
                  ? () => postMessage({ type: "openSession", sessionId: childId })
                  : undefined;
                return (
                  <div
                    key={part.id}
                    className={`part-subtask ${open ? "clickable" : ""}`}
                    role={open ? "button" : undefined}
                    tabIndex={open ? 0 : undefined}
                    title={open ? "Open subagent chat" : undefined}
                    onClick={open}
                    onKeyDown={
                      open
                        ? (e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              open();
                            }
                          }
                        : undefined
                    }
                  >
                    <span className="subtask-badge">Subtask · {part.agent}</span>
                    <span className="subtask-desc">{part.description}</span>
                    {open && <span className="subtask-open">Open chat →</span>}
                  </div>
                );
              }
              case "agent":
                return (
                  <div key={part.id} className="part-agent">
                    <span className="agent-badge">@{part.name}</span>
                  </div>
                );
              case "retry":
                return (
                  <div key={part.id} className="part-retry">
                    Retry (attempt {part.attempt}): {part.error?.data?.message ?? "unknown error"}
                  </div>
                );
              default:
                return null;
            }
          })
          )}
          {streaming && !isUser && (
            <div className="typing-indicator" aria-label="Generating">
              <span className="dot" />
              <span className="dot" />
              <span className="dot" />
            </div>
          )}
          {!isUser && changedFiles.length > 0 && (
            <div className="changed-files">
              <div className="changed-files-label-row">
                <span className="changed-files-label">
                  {changedFiles.length === 1 ? "Changed file" : `${changedFiles.length} changed files`}
                </span>
                {changedFiles.length >= 2 && (
                  <button
                    className="changed-files-view-all"
                    title="Preview all diffs in a modal"
                    onClick={() => useStore.getState().openAllFilesDiffModal(changedFiles)}
                  >
                    View all
                  </button>
                )}
              </div>
              <div className="changed-files-chips">
                {changedFiles.map((cf) => (
                  <div
                    key={cf.filePath}
                    className={`changed-file-chip${fileExists[cf.filePath] === false ? " missing" : ""}`}
                    title={cf.filePath}
                  >
                    <button
                      className="changed-file-chip-main"
                      onClick={() =>
                        postMessage({
                          type: "openFileDiff",
                          filePath: cf.filePath,
                          edits: cf.edits,
                          isNewFile: cf.isNewFile,
                        })
                      }
                    >
                      <span className={`change-status change-status-${fileExists[cf.filePath] === false ? "deleted" : cf.isNewFile ? "added" : "modified"}`} />
                      <span className="changed-file-name">{basename(cf.filePath)}</span>
                      <span className="changed-file-delta">
                        {cf.additions > 0 && <span className="delta-add">+{cf.additions}</span>}
                        {cf.deletions > 0 && <span className="delta-del">-{cf.deletions}</span>}
                      </span>
                    </button>
                    <button
                      className="changed-file-chip-eye"
                      title="Preview diff in panel"
                      aria-label={`Preview ${basename(cf.filePath)} diff in panel`}
                      onClick={(e) => {
                        e.stopPropagation();
                        useStore.getState().openFileDiffModal(cf.filePath, cf.edits, cf.isNewFile);
                      }}
                    >
                      <span className="codicon codicon-eye" aria-hidden="true" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
        {(() => {
          const tok = tokens ? totalTokens(tokens) : 0;
          const hasCost = cost !== undefined && cost > 0;
          if (!hasCost && tok <= 0) return null;
          return (
            <div className="message-footer">
              {hasCost && <span className="message-cost">{formatCost(cost)}</span>}
              {tok > 0 && (
                <span className="message-tokens" title="Tokens (input + output + reasoning)">
                  {formatTokenCount(tok)}t
                </span>
              )}
            </div>
          );
        })()}
        {body && !editing && (
          <div className="message-actions">
            <button
              className="message-action-btn"
              title={copied ? "Copied!" : "Copy message"}
              aria-label={copied ? "Copied!" : "Copy message"}
              onClick={copy}
            >
              {copied ? <CheckIcon /> : <CopyIcon />}
              <span className="message-action-label">Copy</span>
            </button>
            {isUser && (
              <>
                <button
                  className="message-action-btn"
                  title="Resend — send again as a new turn"
                  aria-label="Resend — send again as a new turn"
                  onClick={retry}
                >
                  <RetryIcon />
                  <span className="message-action-label">Resend</span>
                </button>
                {isLastUser && (
                  <button
                    className="message-action-btn"
                    title="Edit & resend"
                    aria-label="Edit & resend"
                    onClick={startEdit}
                  >
                    <EditIcon />
                    <span className="message-action-label">Edit</span>
                  </button>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
});

function CopyIcon(): React.ReactElement {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="5" y="5" width="8.5" height="8.5" rx="1.2" stroke="currentColor" strokeWidth="1.2" />
      <path d="M3 11 V3.5 a1 1 0 0 1 1 -1 H11" stroke="currentColor" strokeWidth="1.2" fill="none" strokeLinecap="round" />
    </svg>
  );
}

function CheckIcon(): React.ReactElement {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M3 8.5 L6.5 12 L13 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function RetryIcon(): React.ReactElement {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M13 6 a5 5 0 1 0 0.5 4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" fill="none" />
      <path d="M13 3 V6.5 H9.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </svg>
  );
}

function EditIcon(): React.ReactElement {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M11.5 2 L14 4.5 L5.5 13 L2 14 L3 10.5 Z M10 3.5 L12.5 6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
