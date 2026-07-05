import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../store/store";
import { postMessage } from "../api/vscodeApi";
import { modelKey } from "../models";
import type { ModelSelection, ProviderInfo, ProviderModelInfo } from "../api/types";

interface ModelSelectorProps {
  compact?: boolean;
}

function formatLimit(n: number): string {
  if (n <= 0) return "?";
  if (n >= 1000) return `${Math.round(n / 1000)}K`;
  return String(n);
}

function modelTooltip(m: ProviderModelInfo): string {
  const parts: string[] = [];
  parts.push(`context ${formatLimit(m.limit.context)}`);
  parts.push(`output ${formatLimit(m.limit.output)}`);
  if (m.reasoning) parts.push("reasoning");
  if (m.toolCall) parts.push("tools");
  if (m.attachment) parts.push("attachments");
  if (m.cost) parts.push(`cost ${m.cost.input}/${m.cost.output}`);
  return `${m.name} — ${parts.join(" · ")}`;
}

export function ModelSelector({ compact }: ModelSelectorProps): React.ReactElement {
  const providers = useStore((s) => s.providers);
  const selectedModel = useStore((s) => s.selectedModel);
  const hiddenModels = useStore((s) => s.hiddenModels);
  const toggleModelHidden = useStore((s) => s.toggleModelHidden);
  const collapsedProviders = useStore((s) => s.collapsedProviders);
  const toggleProviderCollapsed = useStore((s) => s.toggleProviderCollapsed);
  const hiddenProviders = useStore((s) => s.hiddenProviders);
  const toggleProviderHidden = useStore((s) => s.toggleProviderHidden);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

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

  const select = (m: ModelSelection) => {
    useStore.getState().setSelectedModel(m);
    postMessage({ type: "selectModel", model: m });
    setOpen(false);
  };

  const currentLabel = (() => {
    if (!selectedModel) return "Select model";
    for (const p of providers) {
      const found = p.models.find(
        (m) => m.modelID === selectedModel.modelID && m.providerID === selectedModel.providerID,
      );
      if (found) return found.name;
    }
    return modelKey(selectedModel);
  })();

  const sortedProviders = useMemo<ProviderInfo[]>(() => {
    const q = search.trim().toLowerCase();
    const hidden = new Set(hiddenModels);
    const hiddenProv = new Set(hiddenProviders);
    const selectedKey = selectedModel ? modelKey(selectedModel) : null;
    const selectedProviderId = selectedModel?.providerID ?? null;
    const filtered = providers.map((p) => ({
      ...p,
      // Hide models the user opted out of, but never hide the currently
      // selected model so the dropdown always reflects the active choice.
      models: p.models.filter((m) => {
        const key = `${m.providerID}/${m.modelID}`;
        if (hidden.has(key) && key !== selectedKey) return false;
        if (!q) return true;
        return m.name.toLowerCase().includes(q) || m.modelID.toLowerCase().includes(q);
      }),
    }));
    return filtered
      .filter((p) => p.connected && p.models.length > 0)
      .filter((p) => p.id === selectedProviderId || !hiddenProv.has(p.id))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [providers, search, hiddenModels, hiddenProviders, selectedModel]);

  const isEmpty = providers.length === 0;
  const noMatches = providers.length > 0 && sortedProviders.length === 0;

  return (
    <div className={`model-selector ${compact ? "compact" : ""}`} ref={ref}>
      <button className="model-selector-button" onClick={() => setOpen((v) => !v)} title={currentLabel}>
        <span className="model-selector-label">{currentLabel}</span>
        <span className="model-selector-caret">▾</span>
      </button>
      {open && (
        <div className="model-selector-dropdown">
          <div className="model-search-wrap">
            <span className="model-search-icon">
              <SearchIcon />
            </span>
            <input
              ref={searchRef}
              className="model-search"
              type="text"
              placeholder="Search models…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <div className="model-groups-scroll">
            {isEmpty && (
              <div className="model-empty">
                No providers connected
                <button
                  type="button"
                  className="model-empty-refresh"
                  onClick={() => postMessage({ type: "refreshModels" })}
                >
                  Refresh models
                </button>
              </div>
            )}
            {noMatches && (
              <div className="model-empty">
                No models match “{search}”
              </div>
            )}
            {sortedProviders.map((provider) => {
              const collapsed = collapsedProviders.includes(provider.id);
              const providerHidden = hiddenProviders.includes(provider.id);
              const isSelectedProvider = selectedModel?.providerID === provider.id;
              return (
                <div key={provider.id} className="model-group">
                  <div className="model-group-header">
                    <button
                      type="button"
                      className="model-group-title"
                      onClick={() => toggleProviderCollapsed(provider.id)}
                      title={collapsed ? "Expand" : "Collapse"}
                    >
                      <span className="model-group-caret">{collapsed ? "▸" : "▾"}</span>
                      <span className="model-group-name">{provider.name}</span>
                      <span className="model-group-count">{provider.models.length}</span>
                    </button>
                    {!isSelectedProvider && (
                      <button
                        type="button"
                        className="model-group-hide"
                        aria-label={
                          providerHidden
                            ? `Show provider ${provider.name}`
                            : `Hide provider ${provider.name}`
                        }
                        title={providerHidden ? "Show provider" : "Hide provider"}
                        onClick={() => toggleProviderHidden(provider.id)}
                      >
                        {providerHidden ? <EyeIcon /> : <EyeOffIcon />}
                      </button>
                    )}
                  </div>
                  {!collapsed &&
                    provider.models.map((m) => {
                      const key = modelKey(m);
                      const isActive =
                        selectedModel?.providerID === m.providerID && selectedModel?.modelID === m.modelID;
                      const isHidden = hiddenModels.includes(key);
                      return (
                        <div key={key} className={`model-option-row ${isActive ? "active" : ""}`}>
                          <button
                            className="model-option"
                            onClick={() => select({ providerID: m.providerID, modelID: m.modelID })}
                            title={modelTooltip(m)}
                          >
                            <span className="model-option-name">{m.name}</span>
                            <span className="model-option-meta">
                              {m.limit.context > 0 && (
                                <span className="model-option-limit">{formatLimit(m.limit.context)}</span>
                              )}
                            </span>
                            <span className="model-option-badges">
                              {m.reasoning && <span className="badge badge-reasoning" title="Supports reasoning/thinking">R</span>}
                              {m.toolCall && <span className="badge badge-tool" title="Supports tool calls">T</span>}
                              {m.attachment && <span className="badge badge-attach" title="Supports attachments">A</span>}
                            </span>
                          </button>
                          {!isActive && (
                            <button
                              className="model-option-hide"
                              title={isHidden ? "Show in list" : "Hide from list"}
                              onClick={() => toggleModelHidden(key)}
                            >
                              {isHidden ? <EyeIcon /> : <EyeOffIcon />}
                            </button>
                          )}
                        </div>
                      );
                    })}
                </div>
              );
            })}
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

function EyeOffIcon(): React.ReactElement {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M2.5 8 C4 5 6 3.5 8 3.5 C10 3.5 12 5 13.5 8 C12 11 10 12.5 8 12.5 C6 12.5 4 11 2.5 8 Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
      <circle cx="8" cy="8" r="2" stroke="currentColor" strokeWidth="1.2" />
      <line x1="3" y1="3" x2="13" y2="13" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

function EyeIcon(): React.ReactElement {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M2.5 8 C4 5 6 3.5 8 3.5 C10 3.5 12 5 13.5 8 C12 11 10 12.5 8 12.5 C6 12.5 4 11 2.5 8 Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
      <circle cx="8" cy="8" r="2" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}
