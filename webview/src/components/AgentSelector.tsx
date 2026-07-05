import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../store/store";
import { postMessage } from "../api/vscodeApi";
import type { AgentInfo } from "../api/types";

interface AgentSelectorProps {
  compact?: boolean;
}

const MODE_ORDER: Record<AgentInfo["mode"], number> = {
  primary: 0,
  all: 1,
  subagent: 2,
};

const MODE_LABEL: Record<AgentInfo["mode"], string> = {
  primary: "Primary",
  all: "All",
  subagent: "Subagent",
};

const AGENT_DOT_COLOR: Record<string, string> = {
  build: "var(--vscode-charts-orange, #e07b00)",
  plan: "var(--vscode-charts-yellow, #e2c607)",
};

function dotColorFor(name: string | undefined, serverColor?: string): string | undefined {
  if (serverColor) return serverColor;
  if (!name) return undefined;
  return AGENT_DOT_COLOR[name.toLowerCase()];
}

export function AgentSelector({ compact }: AgentSelectorProps): React.ReactElement | null {
  const agents = useStore((s) => s.agents);
  const selectedAgent = useStore((s) => s.selectedAgent);
  const agentsRequested = useStore((s) => s.agentsRequested);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (agents.length === 0 && !agentsRequested) {
      useStore.setState({ agentsRequested: true });
      postMessage({ type: "refreshAgents" });
    }
  }, [agents.length, agentsRequested]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  useEffect(() => {
    if (open) {
      setSearch("");
      requestAnimationFrame(() => searchRef.current?.focus());
    }
  }, [open]);

  const select = (name: string | null) => {
    useStore.getState().setSelectedAgent(name);
    postMessage({ type: "selectAgent", agent: name });
    setOpen(false);
  };

  const current = agents.find((a) => a.name === selectedAgent);
  const currentLabel = current?.name ?? "Agent";

  const grouped = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = q
      ? agents.filter(
          (a) =>
            a.name.toLowerCase().includes(q) ||
            (a.description?.toLowerCase().includes(q) ?? false),
        )
      : agents;
    const sorted = [...filtered].sort((a, b) => {
      const mo = MODE_ORDER[a.mode] - MODE_ORDER[b.mode];
      if (mo !== 0) return mo;
      return a.name.localeCompare(b.name);
    });
    const map = new Map<AgentInfo["mode"], AgentInfo[]>();
    for (const a of sorted) {
      const arr = map.get(a.mode) ?? [];
      arr.push(a);
      map.set(a.mode, arr);
    }
    return map;
  }, [agents, search]);

  if (agents.length === 0) return null;

  return (
    <div className={`agent-selector ${compact ? "compact" : ""}`} ref={ref}>
      <button
        className="agent-selector-button"
        onClick={() => setOpen((v) => !v)}
        title={current?.description ?? currentLabel}
      >
        <span
          className="agent-selector-dot"
          style={(() => {
            const c = dotColorFor(current?.name, current?.color);
            return c ? { background: c } : undefined;
          })()}
        />
        <span className="agent-selector-label">{currentLabel}</span>
        <span className="agent-selector-caret">▾</span>
      </button>
      {open && (
        <div className="agent-selector-dropdown">
          <div className="agent-search-wrap">
            <span className="agent-search-icon">
              <SearchIcon />
            </span>
            <input
              ref={searchRef}
              className="agent-search"
              type="text"
              placeholder="Search agents…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <div className="agent-groups-scroll">
            {[...grouped.entries()].map(([mode, items]) => (
              <div key={mode} className="agent-group">
                <div className="agent-group-title">{MODE_LABEL[mode]}</div>
                {items.map((a) => {
                  const isActive = a.name === selectedAgent;
                  return (
                    <button
                      key={a.name}
                      className={`agent-option ${isActive ? "active" : ""}`}
                      onClick={() => select(a.name)}
                      title={a.description}
                    >
                      <span
                        className="agent-option-dot"
                        style={(() => {
                          const c = dotColorFor(a.name, a.color);
                          return c ? { background: c } : undefined;
                        })()}
                      />
                      <span className="agent-option-text">
                        <span className="agent-option-name">{a.name}</span>
                        {a.description && (
                          <span className="agent-option-desc">{a.description}</span>
                        )}
                      </span>
                      {a.builtIn && <span className="agent-option-tag">built-in</span>}
                    </button>
                  );
                })}
              </div>
            ))}
            {grouped.size === 0 && (
              <div className="agent-empty">
                No agents match “{search}”
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function SearchIcon(): React.ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.4" />
      <path d="M10.5 10.5 L14 14" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}
