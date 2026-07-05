import { memo, useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../store/store";
import type { MessageWithParts, TextPart } from "../api/types";

interface MessageNavRailProps {
  sessionId: string;
  /** id of the message sitting at the top of the chat viewport (drives the
   * active dot). With chat virtualization on, off-screen messages are unmounted,
   * so the active dot can't rely on an IntersectionObserver over DOM nodes. */
  topMessageId: string | null;
  onJump: (messageId: string) => void;
}

function previewOf(message: MessageWithParts): string {
  const text = message.parts
    .filter((p): p is TextPart => p.type === "text" && !p.ignored)
    .map((p) => p.text)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= 50) return text;
  return `${text.slice(0, 50)}…`;
}

export const MessageNavRail = memo(function MessageNavRail({
  sessionId,
  topMessageId,
  onJump,
}: MessageNavRailProps): React.ReactElement | null {
  const messages = useStore((s) => s.messagesBySession[sessionId] ?? []);
  const userMessages = messages.filter((m) => m.info.role === "user");
  const lastActiveIdRef = useRef<string | null>(null);
  const [hover, setHover] = useState<{ text: string; left: number; top: number } | null>(null);
  const railRef = useRef<HTMLDivElement>(null);

  // Active dot = the last user message at or above the message currently at the
  // top of the viewport. Derived from the virtualizer's reported topMessageId so
  // it stays correct even when distant messages are unmounted.
  const activeId = useMemo(() => {
    if (messages.length === 0) return null;
    if (topMessageId) {
      const idx = messages.findIndex((m) => m.info.id === topMessageId);
      const from = idx >= 0 ? idx : messages.length - 1;
      for (let i = from; i >= 0; i--) {
        if (messages[i].info.role === "user") {
          lastActiveIdRef.current = messages[i].info.id;
          return messages[i].info.id;
        }
      }
    }
    return lastActiveIdRef.current;
  }, [messages, topMessageId]);

  // Keep the rail scroll position anchored to the bottom as new user messages
  // arrive (mirrors the chat's stick-to-bottom). Without this the rail stays at
  // scrollTop 0 while dots pile up below the fold — the "always at top" bug.
  // Pin in rAF so the newly-added dot has been laid out before we measure.
  useEffect(() => {
    const el = railRef.current;
    if (!el) return;
    const id = requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
    return () => cancelAnimationFrame(id);
  }, [sessionId, userMessages.length]);

  // As the chat scrolls, bring the newly-active dot into view within the rail.
  // Manual scrollTop math (not scrollIntoView) so we don't also scroll the chat.
  useEffect(() => {
    if (!activeId) return;
    const rail = railRef.current;
    if (!rail) return;
    const dot = rail.querySelector<HTMLElement>(`[data-msg-id="${activeId}"]`);
    if (!dot) return;
    const railRect = rail.getBoundingClientRect();
    const dotRect = dot.getBoundingClientRect();
    const dotTopRel = dotRect.top - railRect.top + rail.scrollTop;
    const dotBottomRel = dotTopRel + dotRect.height;
    if (dotTopRel < rail.scrollTop) {
      rail.scrollTop = dotTopRel;
    } else if (dotBottomRel > rail.scrollTop + rail.clientHeight) {
      rail.scrollTop = dotBottomRel - rail.clientHeight;
    }
  }, [activeId]);

  // Reset sticky-active state + tooltip when switching sessions.
  useEffect(() => {
    lastActiveIdRef.current = null;
    setHover(null);
  }, [sessionId]);

  // Only render as a helpful aid when there is more than one message to jump between.
  if (userMessages.length < 2) return null;

  const jumpTo = (messageId: string) => onJump(messageId);

  return (
    <div className="msg-nav-rail" role="navigation" aria-label="Jump to message" ref={railRef}>
      {userMessages.map((m, idx) => {
        const preview = previewOf(m);
        const isActive = m.info.id === activeId;
        return (
          <button
            key={m.info.id}
            type="button"
            className={`msg-nav-dot ${isActive ? "active" : ""}`}
            data-msg-id={m.info.id}
            title={preview || `Message ${idx + 1}`}
            aria-label={preview || `Message ${idx + 1}`}
            onClick={() => jumpTo(m.info.id)}
            onMouseEnter={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              setHover({
                text: preview || `Message ${idx + 1}`,
                left: r.right + 8,
                top: r.top + r.height / 2,
              });
            }}
            onMouseLeave={() => setHover(null)}
          />
        );
      })}
      {hover && (
        <span className="msg-nav-tooltip" style={{ left: hover.left, top: hover.top }} role="tooltip">
          {hover.text}
        </span>
      )}
    </div>
  );
});
