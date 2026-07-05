import { useStore } from "../store/store";
import { formatTokenCount, findLastAssistantWithTokens } from "../utils";

interface Props {
  sessionId: string;
}

function tone(pct: number): { ring: string; text: string } {
  if (pct >= 90) {
    return {
      ring: "var(--vscode-charts-red, #f14c4c)",
      text: "var(--vscode-charts-red, #f14c4c)",
    };
  }
  if (pct >= 70) {
    return {
      ring: "var(--vscode-charts-orange, #e07b00)",
      text: "var(--vscode-charts-orange, #e07b00)",
    };
  }
  return {
    ring: "var(--vscode-charts-green, #4ec94e)",
    text: "var(--vscode-foreground, inherit)",
  };
}

const TRACK_COLOR = "color-mix(in srgb, var(--vscode-foreground, #888) 30%, transparent)";

export function ContextIndicator({ sessionId }: Props): React.ReactElement | null {
  const messages = useStore((s) => s.messagesBySession[sessionId]);
  const providers = useStore((s) => s.providers);
  const rightPanelOpen = useStore((s) => s.rightPanelOpen);

  const last = findLastAssistantWithTokens(messages);
  if (!last || rightPanelOpen) return null;
  const t = last.tokens;
  if (!t) return null;
  const provider = providers.find((p) => p.id === last.providerID);
  const model = provider?.models.find((m) => m.modelID === last.modelID);
  const limit = model?.limit.context ?? 0;
  if (limit === 0) return null;

  const fresh = t.input + t.cache.write;
  const cached = t.cache.read;
  const used = fresh + cached;
  const pct = Math.min(100, Math.round((used / limit) * 100));
  const colors = tone(pct);

  const r = 11;
  const c = 2 * Math.PI * r;
  const dash = (pct / 100) * c;

  return (
    <div className="ctx-indicator" tabIndex={0} aria-label={`Context ${pct}% used`}>
      <svg className="ctx-indicator-ring" width="26" height="26" viewBox="0 0 26 26" aria-hidden="true">
        <circle cx="13" cy="13" r={r} fill="none" stroke={TRACK_COLOR} strokeWidth="3" />
        {pct > 0 && (
          <circle
            cx="13"
            cy="13"
            r={r}
            fill="none"
            stroke={colors.ring}
            strokeWidth="3"
            strokeDasharray={`${dash} ${c}`}
            strokeLinecap="butt"
            transform="rotate(-90 13 13)"
          />
        )}
        <text x="13" y="16.5" textAnchor="middle" fontSize="7.5" fontWeight="600" fill={colors.text} className="ctx-indicator-text">
          {pct}
        </text>
      </svg>
      <div className="ctx-indicator-tooltip" role="tooltip">
        <div className="ctx-tip-row ctx-tip-total">
          <span>Context</span>
          <span>
            {formatTokenCount(used)} / {formatTokenCount(limit)} ({pct}%)
          </span>
        </div>
        <div className="ctx-tip-row">
          <span className="ctx-dot ctx-dot-new" />
          <span>Fresh input</span>
          <span>{formatTokenCount(fresh)}</span>
        </div>
        <div className="ctx-tip-row">
          <span className="ctx-dot ctx-dot-cache" />
          <span>Cached</span>
          <span>{formatTokenCount(cached)}</span>
        </div>
        {t.reasoning > 0 && (
          <div className="ctx-tip-row ctx-tip-aux">
            <span className="ctx-dot ctx-dot-reason" />
            <span>Reasoning (output)</span>
            <span>{formatTokenCount(t.reasoning)}</span>
          </div>
        )}
        <div className="ctx-tip-row ctx-tip-foot">
          <span>From the last assistant message</span>
        </div>
      </div>
    </div>
  );
}
