import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../store/store";
import { postMessage } from "../api/vscodeApi";
import { ModelSelector } from "./ModelSelector";
import { VariantSelector } from "./VariantSelector";
import { AgentSelector } from "./AgentSelector";
import { ContextChips } from "./ContextChips";
import { formatCost, formatTokenCount } from "../utils";
import { buildSendOptions } from "../compose";
import type { AttachedContext, CommandInfo, MessageAttachment } from "../api/types";

interface ChatInputProps {
  sessionId: string;
}

interface MentionState {
  active: boolean;
  start: number;
  query: string;
}

const NO_MENTION: MentionState = { active: false, start: -1, query: "" };

export function ChatInput({ sessionId }: ChatInputProps): React.ReactElement {
  const text = useStore((s) => s.drafts[sessionId] ?? "");
  const setDraft = useStore((s) => s.setDraft);
  const setText = (t: string) => setDraft(sessionId, t);

  const [dropFile, setDropFile] = useState(false);
  const [dropSelection, setDropSelection] = useState(false);
  const [sending, setSending] = useState(false);
  const [mentionAttachments, setMentionAttachments] = useState<MessageAttachment[]>([]);
  const [cursorPos, setCursorPos] = useState(0);
  const [slashSelected, setSlashSelected] = useState(0);
  const [slashDismissed, setSlashDismissed] = useState(false);
  const [mentionSelected, setMentionSelected] = useState(0);
  const [mentionDismissed, setMentionDismissed] = useState(false);
  const [selTarget, setSelTarget] = useState<number | null>(null);
  const [attachOpen, setAttachOpen] = useState(false);
  const [attachQuery, setAttachQuery] = useState("");
  const [narrow, setNarrow] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const attachRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  const activeFilePath = useStore((s) => s.activeFilePath);
  const activeFileName = useStore((s) => s.activeFileName);
  const selection = useStore((s) => s.selection);
  const status = useStore((s) => s.sessionStatus[sessionId]);
  const totalTokens = useStore((s) => s.totalTokens);
  const totalCost = useStore((s) => s.totalCost);
  const commands = useStore((s) => s.commands);
  const agents = useStore((s) => s.agents);
  const selectedAgent = useStore((s) => s.selectedAgent);
  const mentionResults = useStore((s) => s.mentionResults);
  const attachResults = useStore((s) => s.attachResults);
  const enqueueMessage = useStore((s) => s.enqueueMessage);
  const sendOnEnter = useStore((s) => s.settings.sendOnEnter);
  const isBusy = status?.type === "busy";
  const hasQuestion = useStore(
    (s) => s.pendingQuestions.some((q) => q.sessionID === sessionId),
  );

  useEffect(() => {
    if (sending && isBusy) {
      setSending(false);
    }
  }, [sending, isBusy]);

  useEffect(() => {
    setMentionAttachments([]);
  }, [sessionId]);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0;
      setNarrow(w < 800);
    });
    ro.observe(el);
    setNarrow(el.clientWidth < 800);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (!sending) return;
    const timer = setTimeout(() => setSending(false), 5000);
    return () => clearTimeout(timer);
  }, [sending]);

  useEffect(() => {
    setSending(false);
  }, [sessionId]);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [text]);

  useEffect(() => {
    if (commands.length === 0) {
      postMessage({ type: "getCommands" });
    }
  }, []);

  useEffect(() => {
    if (selTarget !== null && textareaRef.current) {
      textareaRef.current.selectionStart = selTarget;
      textareaRef.current.selectionEnd = selTarget;
      setSelTarget(null);
    }
  }, [selTarget, text]);

  const slashQuery = useMemo(() => {
    if (!text.startsWith("/")) return null;
    const rest = text.slice(1);
    if (rest.includes(" ")) return null;
    return rest;
  }, [text]);

  useEffect(() => {
    if (slashQuery !== null) setSlashDismissed(false);
  }, [slashQuery]);

  const mention = useMemo<MentionState>(() => {
    const before = text.slice(0, cursorPos);
    const atIdx = before.lastIndexOf("@");
    if (atIdx === -1) return NO_MENTION;
    const segment = before.slice(atIdx + 1);
    if (/\s/.test(segment)) return NO_MENTION;
    return { active: true, start: atIdx, query: segment };
  }, [text, cursorPos]);

  useEffect(() => {
    if (mention.active) setMentionDismissed(false);
  }, [mention.active, mention.query]);

  const filteredCommands = useMemo<CommandInfo[]>(() => {
    if (slashQuery === null) return [];
    const q = slashQuery.toLowerCase();
    return commands
      .filter((c) => !q || c.name.toLowerCase().startsWith(q))
      .slice(0, 50);
  }, [commands, slashQuery]);

  const filteredFiles = useMemo<string[]>(() => {
    if (!mention.active) return [];
    return mentionResults.slice(0, 50);
  }, [mentionResults, mention.active]);

  useEffect(() => {
    setSlashSelected(0);
  }, [slashQuery]);

  useEffect(() => {
    setMentionSelected(0);
  }, [mention.query, mentionResults]);

  useEffect(() => {
    if (!mention.active) return;
    const q = mention.query;
    useStore.setState({ mentionFileQuery: q });
    const timer = setTimeout(() => {
      postMessage({ type: "findFiles", query: q, source: "mention" });
    }, 200);
    return () => clearTimeout(timer);
  }, [mention.active, mention.query]);

  useEffect(() => {
    if (!attachOpen) return;
    const handler = (e: MouseEvent) => {
      if (attachRef.current && !attachRef.current.contains(e.target as Node)) setAttachOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [attachOpen]);

  useEffect(() => {
    if (!attachOpen) {
      setAttachQuery("");
      useStore.setState({ attachFileQuery: null, attachResults: [] });
      return;
    }
    const q = attachQuery.trim();
    useStore.setState({ attachFileQuery: q });
    const timer = setTimeout(() => {
      postMessage({ type: "findFiles", query: q, source: "attach" });
    }, 200);
    return () => clearTimeout(timer);
  }, [attachOpen, attachQuery]);

  const insertMention = (path: string) => {
    const insert = "@" + path + " ";
    const next = text + (text && !text.endsWith(" ") ? " " : "") + insert;
    setText(next);
    setCursorPos(next.length);
    setSelTarget(next.length);
    setMentionAttachments((prev) => {
      if (prev.some((a) => a.url === path)) return prev;
      const base = path.split(/[\\/]/).pop() ?? path;
      return [...prev, { url: path, filename: base, mime: "text/plain" }];
    });
    setAttachOpen(false);
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  const slashVisible = slashQuery !== null && !slashDismissed && filteredCommands.length > 0;
  const mentionVisible = mention.active && !mentionDismissed && filteredFiles.length > 0;
  const slashSel = Math.min(slashSelected, Math.max(0, filteredCommands.length - 1));
  const mentionSel = Math.min(mentionSelected, Math.max(0, filteredFiles.length - 1));

  const fileIncluded = activeFilePath && !dropFile;
  const selectionIncluded = selection && !dropSelection;
  const hasContext = !!fileIncluded || !!selectionIncluded;

  const buildContext = (): AttachedContext | undefined => {
    if (!hasContext) return undefined;
    const ctx: AttachedContext = {};
    if (fileIncluded) ctx.filePath = activeFilePath ?? undefined;
    if (selectionIncluded) ctx.selection = selection ?? undefined;
    return ctx;
  };

  const activeAttachments = (trimmed: string): MessageAttachment[] | undefined => {
    if (mentionAttachments.length === 0) return undefined;
    const present = mentionAttachments.filter((a) => {
      const tag = `@${a.url}`;
      const idx = trimmed.indexOf(tag);
      if (idx === -1) return false;
      const after = trimmed[idx + tag.length];
      return !after || /[\s,;!?)"'\]]/.test(after);
    });
    return present.length > 0 ? present : undefined;
  };

  const dispatchSend = (trimmed: string) => {
    postMessage({
      type: "sendMessage",
      sessionId,
      text: trimmed,
      context: buildContext(),
      options: buildSendOptions(),
      attachments: activeAttachments(trimmed),
    });
  };

  const runSlash = (command: string, args: string) => {
    if (command === "compact") {
      // /compact routes to the summarize endpoint (the real opencode compact),
      // not session.command (which doesn't know "compact" and fails).
      const model = useStore.getState().selectedModel;
      if (!model) {
        useStore.setState({
          errorMessage: "Select a model first — /compact summarizes using the current model.",
        });
      } else {
        postMessage({ type: "compactSession", sessionId, model });
      }
    } else {
      postMessage({ type: "executeCommand", sessionId, command, args });
    }
    setText("");
  };

  const cycleAgent = () => {
    const primary = agents.filter((a) => a.mode === "primary" || a.mode === "all");
    if (primary.length === 0) return;
    const cur = selectedAgent ? primary.findIndex((a) => a.name === selectedAgent) : -1;
    const next = primary[(cur + 1) % primary.length];
    if (!next) return;
    useStore.getState().setSelectedAgent(next.name);
    postMessage({ type: "selectAgent", agent: next.name });
  };

  const send = () => {
    const trimmed = text.trim();
    if (!trimmed || (!isBusy && sending)) return;
    if (trimmed.startsWith("/")) {
      const spaceIdx = trimmed.indexOf(" ");
      const command = spaceIdx === -1 ? trimmed.slice(1) : trimmed.slice(1, spaceIdx);
      const args = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1);
      runSlash(command, args);
      return;
    }
    if (isBusy) {
      // Generation in progress: don't dispatch immediately. Queue the message
      // client-side; it is injected at the next step boundary (see ChatView).
      enqueueMessage({
        text: trimmed,
        context: buildContext(),
        options: buildSendOptions(),
        attachments: activeAttachments(trimmed),
      });
      setText("");
      setMentionAttachments([]);
      return;
    }
    setSending(true);
    dispatchSend(trimmed);
    setText("");
    setMentionAttachments([]);
  };

  // Send straight to the server now — no abort. opencode is trusted to steer
  // the clarification in at a safe point rather than interrupt mid-thought.
  const forceSend = () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    dispatchSend(trimmed);
    setText("");
    setMentionAttachments([]);
  };

  const abort = () => {
    postMessage({ type: "abortSession", sessionId });
  };

  const selectCommand = (cmd: CommandInfo) => {
    const rest = slashQuery !== null ? text.slice(1 + slashQuery.length) : "";
    const newText = "/" + cmd.name + " " + rest;
    const cursor = 1 + cmd.name.length + 1;
    setText(newText);
    setSelTarget(cursor);
    setSlashDismissed(true);
  };

  const selectFile = (path: string) => {
    const before = text.slice(0, mention.start);
    const after = text.slice(cursorPos);
    const insert = "@" + path + " ";
    const newText = before + insert + after;
    const cursor = before.length + insert.length;
    setText(newText);
    setSelTarget(cursor);
    setMentionDismissed(true);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key === "Enter") {
      e.preventDefault();
      send();
      return;
    }

    if (
      sendOnEnter &&
      e.key === "Enter" &&
      !e.shiftKey &&
      !e.altKey &&
      !e.metaKey &&
      !e.ctrlKey &&
      !slashVisible &&
      !mentionVisible
    ) {
      e.preventDefault();
      send();
      return;
    }

    if (e.key === "Tab" && !mod && !e.altKey) {
      if (slashVisible) {
        const cmd = filteredCommands[slashSel];
        if (cmd) {
          e.preventDefault();
          runSlash(cmd.name, "");
          setSlashDismissed(true);
        }
        return;
      }
      if (!mentionVisible) {
        e.preventDefault();
        cycleAgent();
        return;
      }
    }

    if (
      e.key === "Escape" &&
      attachOpen &&
      !slashVisible &&
      !mentionVisible
    ) {
      e.preventDefault();
      setAttachOpen(false);
      return;
    }

    if (slashVisible) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSlashSelected((i) => (i + 1) % filteredCommands.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSlashSelected((i) => (i - 1 + filteredCommands.length) % filteredCommands.length);
        return;
      }
      if (e.key === "Enter") {
        const cmd = filteredCommands[slashSel];
        if (cmd) {
          e.preventDefault();
          selectCommand(cmd);
        }
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setSlashDismissed(true);
        return;
      }
    } else if (mentionVisible) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setMentionSelected((i) => (i + 1) % filteredFiles.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setMentionSelected((i) => (i - 1 + filteredFiles.length) % filteredFiles.length);
        return;
      }
      if (e.key === "Enter") {
        const file = filteredFiles[mentionSel];
        if (file) {
          e.preventDefault();
          selectFile(file);
        }
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setMentionDismissed(true);
        return;
      }
    }
  };

  const syncCursor = () => {
    const el = textareaRef.current;
    if (el) setCursorPos(el.selectionStart ?? 0);
  };

  const tokenTotal = totalTokens.input + totalTokens.output + totalTokens.reasoning;
  const showCharCount = text.length > 0;
  const lineCount = Math.max(1, text.split("\n").length);

  return (
    <div className="chat-input-wrap" ref={wrapRef}>
      <div className="chat-input-inner">
        {hasContext && (
          <ContextChips
            onRemove={(key) => {
              if (key === "file") setDropFile(true);
              if (key === "selection") setDropSelection(true);
            }}
          />
        )}
        <div className="chat-input-row">
          <div className={`attach-wrap ${attachOpen ? "open" : ""}`} ref={attachRef}>
            <button
              className={`icon-button attach-btn ${(fileIncluded || selectionIncluded) ? "active" : ""}`}
              title="Attach context"
              aria-label="Attach context"
              aria-expanded={attachOpen}
              onClick={() => setAttachOpen((v) => !v)}
            >
              <PaperclipIcon />
            </button>
            {attachOpen && (
              <div className="attach-popover">
                <div className="attach-section">
                  <div className="attach-section-title">Current context</div>
                  {activeFilePath ? (
                    <button
                      className={`attach-item ${fileIncluded ? "checked" : ""}`}
                      onClick={() => setDropFile((v) => !v)}
                    >
                      <span className="attach-check">{fileIncluded ? "✓" : ""}</span>
                      <span className="attach-item-icon">📄</span>
                      <span className="attach-item-label" title={activeFilePath}>{activeFileName ?? activeFilePath.split(/[\\/]/).pop()}</span>
                    </button>
                  ) : (
                    <div className="attach-empty">No active file</div>
                  )}
                  {selection && (
                    <button
                      className={`attach-item ${selectionIncluded ? "checked" : ""}`}
                      onClick={() => setDropSelection((v) => !v)}
                    >
                      <span className="attach-check">{selectionIncluded ? "✓" : ""}</span>
                      <span className="attach-item-icon">✂</span>
                      <span className="attach-item-label">Editor selection</span>
                    </button>
                  )}
                </div>
                <div className="attach-section">
                  <div className="attach-section-title">Attach a file</div>
                  <input
                    className="attach-search"
                    type="text"
                    placeholder="Search files…"
                    value={attachQuery}
                    autoFocus
                    onChange={(e) => setAttachQuery(e.target.value)}
                  />
                  <div className="attach-results">
                    {attachResults.length === 0 && attachQuery.trim() && (
                      <div className="attach-empty">No files match “{attachQuery}”.</div>
                    )}
                    {attachResults.slice(0, 30).map((f) => (
                      <button
                        key={f}
                        className="attach-result"
                        title={f}
                        onClick={() => insertMention(f)}
                      >
                        {f}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
          <div className="chat-input-textarea-wrap">
            {slashVisible && (
              <div className="slash-dropdown">
                {filteredCommands.map((cmd, i) => (
                  <div
                    key={cmd.name}
                    className={`slash-item ${i === slashSel ? "selected" : ""}`}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      selectCommand(cmd);
                    }}
                    onMouseEnter={() => setSlashSelected(i)}
                  >
                    <span className="slash-item-name">/{cmd.name}</span>
                    {cmd.description && <span className="slash-item-desc">{cmd.description}</span>}
                  </div>
                ))}
              </div>
            )}
            {mentionVisible && (
              <div className="slash-dropdown">
                {filteredFiles.map((file, i) => (
                  <div
                    key={file}
                    className={`slash-item ${i === mentionSel ? "selected" : ""}`}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      selectFile(file);
                    }}
                    onMouseEnter={() => setMentionSelected(i)}
                  >
                    <span className="slash-item-name slash-item-file">@{file}</span>
                  </div>
                ))}
              </div>
            )}
            <textarea
              ref={textareaRef}
              className="chat-input-textarea"
              placeholder={isBusy ? "Agent is working…" : sendOnEnter ? "Ask anything… (Enter to send, Shift+Enter for newline)" : "Ask anything… (⌘/Ctrl+Enter to send)"}
              value={text}
              rows={1}
              disabled={hasQuestion}
              onChange={(e) => {
                setText(e.target.value);
                setCursorPos(e.target.selectionStart ?? 0);
              }}
              onKeyDown={onKeyDown}
              onSelect={syncCursor}
              onClick={syncCursor}
              onKeyUp={syncCursor}
            />
          </div>
          <div className="chat-input-actions">
            {!narrow && <ModelSelector compact />}
            {!narrow && <VariantSelector />}
            {isBusy ? (
              text.trim() ? (
                <>
                  <button
                    className="send-btn"
                    onClick={send}
                    title="Queue — inject at the next step boundary"
                  >
                    <SendIcon />
                  </button>
                  <button
                    className="force-btn"
                    onClick={forceSend}
                    title="Send now — opencode steers it in at a safe point"
                  >
                    <SendIcon />
                  </button>
                </>
              ) : (
                <button className="abort-btn" onClick={abort} title="Stop generation">
                  <span className="abort-icon">■</span>
                </button>
              )
            ) : (
              <button
                className="send-btn"
                onClick={send}
                disabled={!text.trim() || sending}
                title={sending ? "Sending…" : "Send"}
              >
                {sending ? <SendingSpinner /> : <SendIcon />}
              </button>
            )}
          </div>
        </div>
          <div className="chat-input-meta">
          <div className="chat-input-meta-left">
            {showCharCount && !narrow && (
              <span className="meta-chip" title={`${lineCount} line(s)`}>
                {text.length} chars
              </span>
            )}
          </div>
          <div className="chat-input-meta-right">
            {narrow && <ModelSelector compact />}
            {narrow && <VariantSelector />}
            <AgentSelector compact />
            {totalCost > 0 && (
              <span className="meta-chip" title="Total cost (all sessions)">
                {formatCost(totalCost)}
              </span>
            )}
            {tokenTotal > 0 && (
              <span className="meta-chip" title="Total tokens (all sessions)">
                {formatTokenCount(tokenTotal)} tokens
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function PaperclipIcon(): React.ReactElement {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M12.5 7.5 L7.5 12.5 a3 3 0 1 1 -4.2 -4.2 L9 2.6 a2 2 0 1 1 2.8 2.8 L5.8 11.4 a1 1 0 1 1 -1.4 -1.4 L10 5.4"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  );
}

function SendIcon(): React.ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M2.5 8 H12.5 M8 3.5 L12.5 8 L8 12.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function SendingSpinner(): React.ReactElement {
  return <span className="send-spinner" aria-label="Sending" />;
}
