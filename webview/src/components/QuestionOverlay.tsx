import { useState } from "react";
import { useStore } from "../store/store";
import { postMessage } from "../api/vscodeApi";
import type { QuestionRequest } from "../api/types";

interface QuestionOverlayProps {
  sessionId: string;
}

/**
 * Shows pending agent questions as a block that overlaps the composer, so it is
 * clear the user must answer (free-form is always available) rather than send a
 * normal message. Backed by GET /question polling + POST .../reply|/reject.
 */
export function QuestionOverlay({ sessionId }: QuestionOverlayProps): React.ReactElement | null {
  const requests = useStore(
    (s) => s.pendingQuestions.filter((q) => q.sessionID === sessionId),
  );
  // selection[`${requestId}:${qi}`] = chosen option labels
  const [selection, setSelection] = useState<Record<string, string[]>>({});
  // custom[`${requestId}:${qi}`] = free-form typed answer (overrides selection)
  const [custom, setCustom] = useState<Record<string, string>>({});

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
          return (
            <div className="question-request" key={req.id}>
              <div className="question-request-head">
                <span className="question-request-icon" aria-hidden="true">?</span>
                <span className="question-request-title">Agent needs your input</span>
              </div>
              {req.questions.map((q, qi) => {
                const k = key(req.id, qi);
                const sel = selection[k] ?? [];
                return (
                  <div className="question-item" key={qi}>
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
                            onClick={() => toggle(req.id, qi, opt.label, q.multiple)}
                          >
                            <span className="question-option-mark" aria-hidden="true">
                              {q.multiple ? (active ? "☒" : "☐") : active ? "●" : "○"}
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
                    {customAllowed(q.custom) && (
                      <textarea
                        className="question-custom"
                        rows={2}
                        placeholder="Or type your own answer…"
                        value={custom[k] ?? ""}
                        onChange={(e) => setCustom((c) => ({ ...c, [k]: e.target.value }))}
                        onKeyDown={(e) => {
                          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                            e.preventDefault();
                            submit(req);
                          }
                        }}
                      />
                    )}
                  </div>
                );
              })}
              <div className="question-actions">
                <button
                  className="btn btn-primary btn-sm"
                  onClick={() => submit(req)}
                  disabled={!allAnswered}
                  title={allAnswered ? "Send answer" : "Answer every question (or dismiss)"}
                >
                  Answer
                </button>
                <button className="btn btn-sm" onClick={() => dismiss(req)} title="Reject — let the agent proceed without an answer">
                  Dismiss
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
