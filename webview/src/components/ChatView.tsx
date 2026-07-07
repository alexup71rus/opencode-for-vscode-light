import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../store/store";
import { postMessage } from "../api/vscodeApi";
import type { AttachedContext, MessageWithParts } from "../api/types";
import { buildSendOptions } from "../compose";
import { MessageBubble } from "./MessageBubble";
import { MessageNavRail } from "./MessageNavRail";
import { VirtualizedBubbles } from "./VirtualizedBubbles";
import { Logo } from "./Logo";
import { ContextIndicator } from "./ContextIndicator";

interface ChatViewProps {
  sessionId: string;
}

const EXAMPLE_PROMPTS = [
  "Explain how this codebase is structured",
  "Find potential bugs in the open file",
  "Write a unit test for the selected code",
  "Refactor this function for readability",
];

const NEAR_BOTTOM_THRESHOLD = 120;

// Rough pre-measurement height for a bubble. Only needs to keep the scrollbar
// approximately right until the real offsetHeight is observed; the virtualizer
// corrects every bubble as soon as it enters the render window.
function estimateBubbleHeight(b: { message: MessageWithParts }): number {
  let chars = 0;
  let tools = 0;
  for (const p of b.message.parts) {
    if (p.type === "text") chars += p.text.length;
    else if (p.type === "reasoning") chars += (p.text?.length ?? 0);
    else if (p.type === "tool") tools++;
  }
  return Math.max(96, Math.min(2400, 80 + chars * 0.2 + tools * 70));
}

function buildContext(): AttachedContext | undefined {
  const { activeFilePath, selection } = useStore.getState();
  if (!activeFilePath && !selection) return undefined;
  const ctx: AttachedContext = {};
  if (activeFilePath) ctx.filePath = activeFilePath;
  if (selection) ctx.selection = selection;
  return ctx;
}

// Merge a run of consecutive same-role messages into one bubble. opencode emits
// one assistant message per model step, so a single answer arrives as a chain;
// collapsing it yields "one message with a chain inside" (step-start parts keep
// acting as dividers between steps). Single-message runs return the original
// object so React.memo(MessageBubble) keeps holding.
function mergeRun(run: MessageWithParts[]): MessageWithParts {
  if (run.length === 1) return run[0];
  const first = run[0];
  const info = { ...first.info };
  if (info.role === "assistant") {
    let cost = 0;
    let input = 0;
    let output = 0;
    let reasoning = 0;
    let cacheRead = 0;
    let cacheWrite = 0;
    let completed: number | undefined;
    for (const m of run) {
      const a = m.info;
      if (a.role !== "assistant") continue;
      cost += a.cost ?? 0;
      input += a.tokens.input;
      output += a.tokens.output;
      reasoning += a.tokens.reasoning;
      cacheRead += a.tokens.cache.read;
      cacheWrite += a.tokens.cache.write;
      info.modelID = a.modelID;
      completed = a.time.completed ?? completed;
    }
    info.cost = cost;
    info.tokens = { input, output, reasoning, cache: { read: cacheRead, write: cacheWrite } };
    if (completed !== undefined) info.time = { ...info.time, completed };
  }
  return { info, parts: run.flatMap((m) => m.parts) };
}

export function ChatView({ sessionId }: ChatViewProps): React.ReactElement {
  const messages = useStore((s) => s.messagesBySession[sessionId] ?? []);
  const status = useStore((s) => s.sessionStatus[sessionId]);
  const allSessions = useStore((s) => s.sessions);
  const shiftQueuedMessage = useStore((s) => s.shiftQueuedMessage);
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const stickToBottomRef = useRef(true);

  // Inject queued messages when the agent FINISHES its whole answer — i.e. the
  // session transitions busy -> idle. A "step" is only an intermediate model
  // iteration (the answer is a chain of steps / messages), so firing on
  // step-finish sent queued items mid-answer. Send one queued message per
  // completed turn; if several are queued they chain across turns.
  const prevStatusRef = useRef<{ session: string | null; type: string | null }>({
    session: null,
    type: null,
  });
  useEffect(() => {
    const prev = prevStatusRef.current;
    const cur = status?.type ?? "idle";
    if (prev.session !== sessionId) {
      prev.session = sessionId;
      prev.type = cur;
      return;
    }
    const wasBusy = prev.type === "busy";
    prev.type = cur;
    if (wasBusy && cur !== "busy") {
      if (useStore.getState().suppressQueueOnIdle) {
        useStore.setState({ suppressQueueOnIdle: false });
        return;
      }
      const q = shiftQueuedMessage(sessionId);
      if (q) {
        postMessage({
          type: "sendMessage",
          sessionId,
          text: q.text,
          context: q.context,
          options: q.options,
          attachments: q.attachments,
        });
      }
    }
  }, [status, sessionId, shiftQueuedMessage]);

  // Remember each session's scroll offset so returning to it (e.g. after
  // peeking into a subagent chat) restores the position instead of jumping
  // to the top.
  const scrollPositions = useRef<Map<string, number>>(new Map());
  // Per-session stickiness, remembered so the virtualizer can seed the correct
  // end on switch (stickToBottomRef itself lags one effect phase behind).
  const stickBySession = useRef<Map<string, boolean>>(new Map());
  const restoreOnLoad = useRef<Set<string>>(new Set());

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    scrollPositions.current.set(sessionId, el.scrollTop);
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    const atBottom = distance < NEAR_BOTTOM_THRESHOLD;
    stickToBottomRef.current = atBottom;
    stickBySession.current.set(sessionId, atBottom);
    setShowScrollBtn(!atBottom);
  };

  // Queue a one-shot restore whenever the active session changes.
  useEffect(() => {
    restoreOnLoad.current.add(sessionId);
  }, [sessionId]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    // First paint after switching into this session: restore the saved offset
    // (or stick to bottom on first open) instead of snapping on every token.
    if (restoreOnLoad.current.has(sessionId)) {
      if (messages.length > 0) {
        restoreOnLoad.current.delete(sessionId);
        const saved = scrollPositions.current.get(sessionId);
        if (saved !== undefined) {
          el.scrollTop = saved;
          const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
          stickToBottomRef.current = distance < NEAR_BOTTOM_THRESHOLD;
          setShowScrollBtn(!stickToBottomRef.current);
        } else {
          stickToBottomRef.current = true;
          bottomRef.current?.scrollIntoView({ behavior: "auto" });
        }
      }
      return;
    }
    if (stickToBottomRef.current) {
      // During streaming the messages array updates on every token; a smooth
      // scroll per token queues many animations and feels janky. Snap instead.
      const behavior: ScrollBehavior = status?.type === "busy" ? "auto" : "smooth";
      bottomRef.current?.scrollIntoView({ behavior });
    }
  }, [messages, status, sessionId]);

  const isBusy = status?.type === "busy";

  // Compaction-in-progress: the server sets session.time.compacting while the
  // compaction model is summarizing (cleared on session.updated when done).
  const activeSession = allSessions.find((s) => s.id === sessionId);
  const isCompacting = Boolean(activeSession?.time?.compacting);

  // Map each subagent invocation to its child session. The SDK emits no direct
  // part->child link, so we pair positionally: the i-th `subtask` part and the
  // i-th subagent tool call (in stream order) each map to the i-th child
  // session of this session (by time.created). A subagent tool call is detected
  // by its tool name — opencode exposes each subagent as a tool named after the
  // agent (see AgentInfo.mode), not a fixed "task". Reliable for the common
  // sequential case; the sidebar remains source of truth for parallel ambiguity.
  const agents = useStore((s) => s.agents);
  const subagentToolNames = useMemo(() => {
    const names = new Set<string>(["task"]);
    for (const a of agents) {
      if (a.mode === "subagent" || a.mode === "all") names.add(a.name);
    }
    return names;
  }, [agents]);

  // Children of this session (the subagent threads it spawned), oldest first.
  const children = allSessions
    .filter((s) => s.parentID === sessionId)
    .sort((a, b) => a.time.created - b.time.created);

  // The maps below are keyed on cheap string signatures of the relevant part
  // ids + child ids, so the Map refs stay stable while text streams in (no new
  // subagent part). This keeps React.memo(MessageBubble) effective per-token.
  const childSig = children.map((c) => c.id).join(",");
  const partSig = (() => {
    const ids: string[] = [];
    for (const m of messages) {
      for (const p of m.parts) {
        if (p.type === "subtask") ids.push("s:" + p.id);
        else if (p.type === "tool" && subagentToolNames.has(p.tool)) ids.push("t:" + p.id);
      }
    }
    return ids.join("|");
  })();

  // Positionally pair the i-th subtask part / i-th subagent tool call (stream
  // order) with the i-th child session. The SDK emits no direct part->child id,
  // so this is a best-effort match (reliable for the sequential case); the
  // sidebar remains the source of truth for parallel ambiguity.
  const { subtaskChild, taskChild } = useMemo(() => {
    const sub = new Map<string, string>();
    const task = new Map<string, string>();
    let sIdx = 0;
    let tIdx = 0;
    for (const m of messages) {
      for (const p of m.parts) {
        if (p.type === "subtask") {
          if (sIdx < children.length) sub.set(p.id, children[sIdx].id);
          sIdx++;
        } else if (p.type === "tool" && subagentToolNames.has(p.tool)) {
          if (tIdx < children.length) task.set(p.id, children[tIdx].id);
          tIdx++;
        }
      }
    }
    return { subtaskChild: sub, taskChild: task };
  }, [partSig, childSig]);

  // Group consecutive same-role messages into one bubble per run (the agent's
  // multi-step answer renders as a single message with internal step dividers).
  const bubbles = useMemo(() => {
    let lastUserId: string | null = null;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].info.role === "user") {
        lastUserId = messages[i].info.id;
        break;
      }
    }
    const runs: MessageWithParts[][] = [];
    for (const m of messages) {
      const last = runs[runs.length - 1];
      if (last && last[0].info.role === m.info.role) last.push(m);
      else runs.push([m]);
    }
    return runs.map((run) => ({
      key: run[0].info.id,
      message: mergeRun(run),
      isLastUser: run[0].info.role === "user" && run.some((m) => m.info.id === lastUserId),
    }));
  }, [messages]);

  const [topMessageId, setTopMessageId] = useState<string | null>(null);
  const scrollToKeyRef = useRef<((key: string) => void) | null>(null);
  // First visit (no recorded stickiness) seeds at the bottom — the common case.
  const seedAtBottom = stickBySession.current.get(sessionId) ?? true;

  const estimateHeight = useCallback((i: number) => estimateBubbleHeight(bubbles[i]), [bubbles]);

  const renderBubble = useCallback(
    (i: number) => {
      const b = bubbles[i];
      return (
        <MessageBubble
          sessionId={sessionId}
          message={b.message}
          isLastUser={b.isLastUser}
          subtaskChild={subtaskChild}
          taskChild={taskChild}
          streaming={isBusy && i === bubbles.length - 1 && b.message.info.role === "assistant"}
        />
      );
    },
    [bubbles, sessionId, isBusy, subtaskChild, taskChild],
  );

  const handleTopKey = useCallback(
    (key: string | null) => {
      const b = key ? bubbles.find((x) => x.key === key) : undefined;
      setTopMessageId(b?.message.info.id ?? null);
    },
    [bubbles],
  );

  const onJump = useCallback(
    (messageId: string) => {
      const b = bubbles.find(
        (x) => x.message.info.id === messageId || x.message.parts.some((p) => p.messageID === messageId),
      );
      if (b) scrollToKeyRef.current?.(b.key);
    },
    [bubbles],
  );

  if (messages.length === 0) {
    return (
      <div className="chat-empty">
        <div className="chat-empty-glow"><Logo size={56} /></div>
        <div className="chat-empty-title">How can I help?</div>
        <div className="chat-empty-sub">Ask anything, or include a file for context.</div>
        <div className="chat-empty-examples">
          {EXAMPLE_PROMPTS.map((prompt) => (
            <button
              key={prompt}
              className="example-prompt"
              onClick={() => postMessage({ type: "sendMessage", sessionId, text: prompt, context: buildContext(), options: buildSendOptions() })}
            >
              {prompt}
            </button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="chat-view">
      <MessageNavRail sessionId={sessionId} topMessageId={topMessageId} onJump={onJump} />
      <ContextIndicator sessionId={sessionId} />
      <div className="chat-main">
        <div className="chat-scroll" ref={scrollRef} onScroll={onScroll}>
          <VirtualizedBubbles
            items={bubbles}
            scrollRef={scrollRef}
            estimateHeight={estimateHeight}
            renderItem={renderBubble}
            stickToBottomRef={stickToBottomRef}
            seedAtBottom={seedAtBottom}
            bottomRef={bottomRef}
            onActiveVisibleKey={handleTopKey}
            scrollToKeyRef={scrollToKeyRef}
            trailing={
              isCompacting || (isBusy && bubbles[bubbles.length - 1]?.message.info.role !== "assistant") ? (
                <div className="message message-assistant">
                  <div className="message-avatar message-avatar-ai">
                    <SparkIcon />
                  </div>
                  <div className="message-content">
                    {isCompacting ? (
                      <div className="compacting-indicator">
                        <span className="compacting-spinner" />
                        Compacting context…
                      </div>
                    ) : (
                      <div className="typing-indicator">
                        <span className="dot" />
                        <span className="dot" />
                        <span className="dot" />
                      </div>
                    )}
                  </div>
                </div>
              ) : null
            }
          />
        </div>
      </div>
      {showScrollBtn && (
        <button
          className="scroll-bottom-btn"
          title="Scroll to bottom"
          onClick={() => {
            stickToBottomRef.current = true;
            setShowScrollBtn(false);
            bottomRef.current?.scrollIntoView({ behavior: "smooth" });
          }}
        >
          <ChevronDownIcon />
        </button>
      )}
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

function ChevronDownIcon(): React.ReactElement {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M3 6 L8 11 L13 6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
