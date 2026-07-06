import { useState, useMemo } from "react";
import { useStore } from "../store/store";
import { postMessage } from "../api/vscodeApi";
import type { QuestionRequest } from "../api/types";

interface QuestionOverlayProps {
  sessionId: string;
}

/**
 * Shows pending agent questions as a block that overlaps the composer, so it is
 * clear the user must answer (free-form is always available) rather than send a
 * normal message. One question visible at a time; navigation is via thin
 * clickable stripes, and single-select answers auto-advance to the next
 * question. Backed by GET /question polling + POST .../reply|/reject.
 */
export function QuestionOverlay({ sessionId }: QuestionOverlayProps): React.ReactElement | null {
  const allQuestions = useStore((s) => s.pendingQuestions);
  const requests = useMemo(
    () => allQuestions.filter((q) => q.sessionID === sessionId),
    [allQuestions, sessionId],
  );
  // selection[`${requestId}:${qi}`] = chosen option labels
  const [selection, setSelection] = useState<Record<string, string[]>>({});
  // custom[`${requestId}:${qi}`] = free-form typed answer (overrides selection)
  const [custom, setCustom] = useState<Record<string, string>>({});
  // current question index per request id
  const [pos, setPos] = useState<Record<string, number>>({});

  if (requests.length === 0) return null;

  const key = (rid: string, qi: number) => `${rid}:${qi}`;
  const customAllowed = (customFlag?: boolean) => customFlag !== false;

  const toggle = (rid: string, qi: number, label: string, multiple?: boolean) => {
    const k = key(rid, qi);
    setSelection((s) => {
      const cur = s[k] ?? [];
      if (multiple) {
        return { ...s, [k]: cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label] };
      }
      return { ...s, [k]: cur[0] === label ? [] : [label] };
    });
  };

  const isAnswered = (req: QuestionRequest, qi: number) => {
    const k = key(req.id, qi);
    return (custom[k]?.trim().length ?? 0) > 0 || (selection[k]?.length ?? 0) > 0;
  };

  const buildAnswers = (req: QuestionRequest): string[][] =>
    req.questions.map((_, qi) => {
      const k = key(req.id, qi);
      const c = custom[k]?.trim();
      if (c) return [c];
      return selection[k] ?? [];
    });

  const submit = (req: QuestionRequest) => {
    postMessage({ type: "replyQuestion", requestId: req.id, answers: buildAnswers(req) });
  };

  const dismiss = (req: QuestionRequest) => {
    postMessage({ type: "rejectQuestion", requestId: req.id });
  };

  return (
    <div className="question-overlay" role="dialog" aria-label="Agent question">
      <div className="question-overlay-inner">
        {requests.map((req) => {
          const allAnswered = req.questions.every((_, qi) => isAnswered(req, qi));
          const total = req.questions.length;
          const current = Math.min(pos[req.id] ?? 0, total - 1);
          const setIdx = (next: number) =>
            setPos((p) => ({ ...p, [req.id]: Math.max(0, Math.min(total - 1, next)) }));
            const q = req.questions[current];
            const k = key(req.id, current);
            const sel = selection[k] ?? [];
            const isLast = current === total - 1;
            const currentAnswered = isAnswered(req, current);
            // Primary action is context-aware: advance to the next question
            // until the last one, where it submits the whole batch. Wired to
            // the bottom button and to Cmd/Ctrl+Enter in the textarea.
            const onPrimary = () => {
              if (isLast) {
                if (allAnswered) submit(req);
              } else if (currentAnswered) {
                setIdx(current + 1);
              }
            };
            return (
            <div className="question-request" key={req.id}>
              <div className="question-request-head">
                <span className="question-request-icon" aria-hidden="true">?</span>
                <span className="question-request-title">Agent needs your input</span>
              </div>

              {total > 1 && (
                <QuestionStripes
                  total={total}
                  current={current}
                  answered={Array.from({ length: total }, (_, i) => isAnswered(req, i))}
                  onSelect={setIdx}
                />
              )}

              <QuestionBody
                q={q}
                sel={sel}
                multiple={q.multiple}
                customAllowed={customAllowed(q.custom)}
                customValue={custom[k] ?? ""}
                onToggle={(label) => {
                  const wasSelected = sel.includes(label);
                  toggle(req.id, current, label, q.multiple);
                  // Single-select auto-advance: when the user picks an option
                  // (not deselects) and a later question exists, jump to it so
                  // they can keep answering without manual navigation.
                  if (!q.multiple && !wasSelected && current < total - 1) {
                    setIdx(current + 1);
                  }
                }}
                onCustom={(v) => setCustom((c) => ({ ...c, [k]: v }))}
                onNavKey={(dir) => setIdx(current + dir)}
                onSubmit={onPrimary}
              />

              <div className="question-actions">
                <button className="btn btn-sm" onClick={() => dismiss(req)} title="Reject — let the agent proceed without an answer">
                  Dismiss
                </button>
                {current > 0 && (
                  <button className="btn btn-sm" onClick={() => setIdx(current - 1)} title="Back to previous question">
                    Back
                  </button>
                )}
                {isLast ? (
                  <button
                    className="btn btn-primary btn-sm"
                    onClick={() => submit(req)}
                    disabled={!allAnswered}
                    title={allAnswered ? "Send answers" : "Answer every question first"}
                  >
                    Submit
                  </button>
                ) : (
                  <button
                    className="btn btn-primary btn-sm"
                    onClick={() => setIdx(current + 1)}
                    disabled={!currentAnswered}
                    title={currentAnswered ? "Next question" : "Answer this question to continue"}
                  >
                    Next
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

interface QuestionStripesProps {
  total: number;
  current: number;
  answered: boolean[];
  onSelect: (i: number) => void;
}

/**
 * Thin horizontal segments (one per question) that double as a progress
 * indicator and a click target for navigation. States:
 *  - answered: green fill
 *  - current:  accent fill, slightly thicker
 *  - pending:  muted
 * Replaces the former pill-tab + arrow-row combo to save vertical space and
 * avoid duplicating navigation.
 */
function QuestionStripes({ total, current, answered, onSelect }: QuestionStripesProps): React.ReactElement {
  return (
    <div className="question-stripes" role="tablist">
      {Array.from({ length: total }, (_, i) => {
        const isCurrent = i === current;
        const isAnswered = answered[i];
        const cls = [
          "question-stripe",
          isCurrent ? "current" : "",
          isAnswered ? "done" : "",
        ].filter(Boolean).join(" ");
        return (
          <button
            key={i}
            type="button"
            role="tab"
            aria-selected={isCurrent}
            className={cls}
            onClick={() => onSelect(i)}
            title={`Question ${i + 1}${isAnswered ? " (answered)" : ""}`}
            aria-label={`Question ${i + 1}${isAnswered ? ", answered" : ""}`}
          >
            <span className="question-stripe-bar" />
          </button>
        );
      })}
    </div>
  );
}

interface QuestionBodyProps {
  q: QuestionRequest["questions"][number];
  sel: string[];
  multiple?: boolean;
  customAllowed: boolean;
  customValue: string;
  onToggle: (label: string) => void;
  onCustom: (v: string) => void;
  onNavKey: (dir: number) => void;
  onSubmit: () => void;
}

function QuestionBody({
  q, sel, multiple, customAllowed, customValue, onToggle, onCustom, onNavKey, onSubmit,
}: QuestionBodyProps): React.ReactElement {
  // Arrow-key navigation between questions when the custom textarea isn't focused
  // and no option is being edited. Left/Right move between tabs; the textarea
  // keeps its own caret behaviour.
  const onCustomKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      onSubmit();
      return;
    }
    if (e.key === "ArrowLeft" && e.shiftKey && e.altKey) {
      e.preventDefault();
      onNavKey(-1);
      return;
    }
    if (e.key === "ArrowRight" && e.shiftKey && e.altKey) {
      e.preventDefault();
      onNavKey(1);
      return;
    }
  };

  return (
    <div className="question-item">
      <div className="question-header">{q.header}</div>
      <div className="question-text">{q.question}</div>
      <div className="question-options">
        {q.options.map((opt) => {
          const active = sel.includes(opt.label);
          return (
            <button
              key={opt.label}
              type="button"
              className={`question-option ${active ? "selected" : ""}`}
              title={opt.description}
              onClick={() => onToggle(opt.label)}
            >
              <span className="question-option-mark" aria-hidden="true">
                {multiple ? (active ? "☒" : "☐") : active ? "●" : "○"}
              </span>
              <span className="question-option-body">
                <span className="question-option-label">{opt.label}</span>
                {opt.description && (
                  <span className="question-option-desc">{opt.description}</span>
                )}
              </span>
            </button>
          );
        })}
      </div>
      {customAllowed && (
        <textarea
          className="question-custom"
          rows={2}
          placeholder="Or type your own answer…"
          value={customValue}
          onChange={(e) => onCustom(e.target.value)}
          onKeyDown={onCustomKey}
        />
      )}
    </div>
  );
}
