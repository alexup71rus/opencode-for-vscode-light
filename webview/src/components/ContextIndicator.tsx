import { useStore } from "../store/store";
import { formatTokenCount } from "../utils";
import type { AssistantMessage, MessageWithParts } from "../api/types";

interface Props {
  sessionId: string;
}

interface Breakdown {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  output: number;
  total: number;
  limit: number;
  pct: number;
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

function tone(pct: number): { ring: string; track: string; text: string } {
  if (pct >= 90) {
    return {
      ring: "var(--vscode-charts-red, #f14c4c)",
      track: "color-mix(in srgb, var(--vscode-charts-red, #f14c4c) 25%, transparent)",
      text: "var(--vscode-charts-red, #f14c4c)",
    };
  }
  if (pct >= 70) {
    return {
      ring: "var(--vscode-charts-orange, #e07b00)",
      track: "color-mix(in srgb, var(--vscode-charts-orange, #e07b00) 25%, transparent)",
      text: "var(--vscode-charts-orange, #e07b00)",
    };
  }
  return {
    ring: "var(--vscode-charts-green, #4ec94e)",
    track: "color-mix(in srgb, var(--vscode-charts-green, #4ec94e) 22%, transparent)",
    text: "inherit",
  };
}

export function ContextIndicator({ sessionId }: Props): React.ReactElement | null {
  const messages = useStore((s) => s.messagesBySession[sessionId]);
  const providers = useStore((s) => s.providers);
  const rightPanelOpen = useStore((s) => s.rightPanelOpen);

  const last = findLastAssistantWithTokens(messages);
  if (!last || rightPanelOpen) return null;
  const t = last.tokens;
  const provider = providers.find((p) => p.id === last.providerID);
  const model = provider?.models.find((m) => m.modelID === last.modelID);
  const limit = model?.limit.context ?? 0;
  if (limit === 0) return null;

  const input = t.input + t.cache.write;
  const cacheRead = t.cache.read;
  const reasoning = t.reasoning;
  const total = input + cacheRead + reasoning;
  const pct = Math.min(100, Math.round((total / limit) * 100));
  const b: Breakdown = {
    input,
    cacheRead,
    cacheWrite: t.cache.write,
    reasoning,
    output: t.output,
    total,
    limit,
    pct,
  };

  const r = 11;
  const c = 2 * Math.PI * r;
  const dash = (b.pct / 100) * c;
  const colors = tone(b.pct);

  return (
    <div className="ctx-indicator" tabIndex={0} aria-label={`Context ${b.pct}% used`}>
      <svg className="ctx-indicator-ring" width="26" height="26" viewBox="0 0 26 26">
        <circle cx="13" cy="13" r={r} fill="none" stroke={colors.track} strokeWidth="3" />
        <circle
          cx="13"
          cy="13"
          r={r}
          fill="none"
          stroke={colors.ring}
          strokeWidth="3"
          strokeDasharray={`${dash} ${c}`}
          strokeLinecap="round"
          transform="rotate(-90 13 13)"
        />
        <text x="13" y="16" textAnchor="middle" fontSize="7" fill={colors.text} className="ctx-indicator-text">
          {b.pct}
        </text>
      </svg>
      <div className="ctx-indicator-tooltip" role="tooltip">
        <div className="ctx-tip-row ctx-tip-total">
          <span>Context</span>
          <span>
            {formatTokenCount(b.total)} / {formatTokenCount(b.limit)} ({b.pct}%)
          </span>
        </div>
        <div className="ctx-tip-row">
          <span className="ctx-dot ctx-dot-new" />
          <span>New input</span>
          <span>{formatTokenCount(b.input)}</span>
        </div>
        <div className="ctx-tip-row">
          <span className="ctx-dot ctx-dot-cache" />
          <span>Cached</span>
          <span>{formatTokenCount(b.cacheRead)}</span>
        </div>
        {b.reasoning > 0 && (
          <div className="ctx-tip-row">
            <span className="ctx-dot ctx-dot-reason" />
            <span>Reasoning</span>
            <span>{formatTokenCount(b.reasoning)}</span>
          </div>
        )}
        <div className="ctx-tip-row ctx-tip-foot">
          <span>From the last assistant message</span>
        </div>
      </div>
    </div>
  );
}

