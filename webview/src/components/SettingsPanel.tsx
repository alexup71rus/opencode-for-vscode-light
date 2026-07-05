import { useEffect, useMemo, useState } from "react";
import { useStore } from "../store/store";
import { postMessage } from "../api/vscodeApi";
import { modelKey } from "../models";
import type { ModelSelection } from "../api/types";

type Tab = "general" | "models" | "tools" | "connection";

export function SettingsPanel(): React.ReactElement | null {
  const open = useStore((s) => s.settingsOpen);
  const setOpen = useStore((s) => s.setSettingsOpen);
  const settings = useStore((s) => s.settings);
  const updateSettings = useStore((s) => s.updateSettings);
  const tools = useStore((s) => s.tools);
  const serverUrl = useStore((s) => s.serverUrl);
  const serverStatus = useStore((s) => s.serverStatus);
  const binaryPath = useStore((s) => s.binaryPath);
  const isManaged = useStore((s) => s.isManaged);
  const externalUrl = useStore((s) => s.externalUrl);
  const providers = useStore((s) => s.providers);
  const selectedModel = useStore((s) => s.selectedModel);
  const setSelectedModel = useStore((s) => s.setSelectedModel);
  const agents = useStore((s) => s.agents);
  const selectedAgent = useStore((s) => s.selectedAgent);
  const setSelectedAgent = useStore((s) => s.setSelectedAgent);
  const hiddenModels = useStore((s) => s.hiddenModels);
  const toggleModelHidden = useStore((s) => s.toggleModelHidden);
  const hiddenProviders = useStore((s) => s.hiddenProviders);
  const toggleProviderHidden = useStore((s) => s.toggleProviderHidden);
  const config = useStore((s) => s.config);

  const [systemPrompt, setSystemPrompt] = useState(settings.systemPrompt);
  const [enabledTools, setEnabledTools] = useState<Record<string, boolean>>(settings.enabledTools);
  const [toolFilter, setToolFilter] = useState("");
  const [draftModel, setDraftModel] = useState<ModelSelection | null>(selectedModel);
  const [draftAgent, setDraftAgent] = useState<string | null>(selectedAgent);
  const [draftAutoApprove, setDraftAutoApprove] = useState(settings.autoApprove);
  const [draftExpandThinking, setDraftExpandThinking] = useState(settings.expandThinking);
  const [draftAutoExpandBash, setDraftAutoExpandBash] = useState(settings.autoExpandBash);
  const [draftAutoExpandEdit, setDraftAutoExpandEdit] = useState(settings.autoExpandEdit);
  const [draftAutoExpandError, setDraftAutoExpandError] = useState(settings.autoExpandError);
  const [draftSoundOnComplete, setDraftSoundOnComplete] = useState(settings.soundOnComplete);
  const [draftSendOnEnter, setDraftSendOnEnter] = useState(settings.sendOnEnter);
  const [tab, setTab] = useState<Tab>("general");

  useEffect(() => {
    if (open) {
      setSystemPrompt(settings.systemPrompt);
      setEnabledTools(settings.enabledTools);
      setToolFilter("");
      setDraftModel(selectedModel);
      setDraftAgent(selectedAgent);
      setDraftAutoApprove(settings.autoApprove);
      setDraftExpandThinking(settings.expandThinking);
      setDraftAutoExpandBash(settings.autoExpandBash);
      setDraftAutoExpandEdit(settings.autoExpandEdit);
      setDraftAutoExpandError(settings.autoExpandError);
      setDraftSoundOnComplete(settings.soundOnComplete);
      setDraftSendOnEnter(settings.sendOnEnter);
    }
  }, [open, settings.systemPrompt, settings.enabledTools, settings.autoApprove, settings.expandThinking, settings.autoExpandBash, settings.autoExpandEdit, settings.autoExpandError, settings.soundOnComplete, settings.sendOnEnter, selectedModel, selectedAgent]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, setOpen]);

  const connectedProviders = useMemo(
    () => providers.filter((p) => p.connected && p.models.length > 0),
    [providers],
  );

  const visibleProviders = useMemo(() => {
    const hidden = new Set(hiddenModels);
    const hiddenProv = new Set(hiddenProviders);
    const draftKey = draftModel ? modelKey(draftModel) : null;
    const draftProviderId = draftModel?.providerID ?? null;
    return connectedProviders
      .map((p) => ({
        ...p,
        models: p.models.filter((m) => {
          const key = modelKey(m);
          if (hidden.has(key) && key !== draftKey) return false;
          return true;
        }),
      }))
      .filter((p) => p.models.length > 0)
      .filter((p) => p.id === draftProviderId || !hiddenProv.has(p.id));
  }, [connectedProviders, hiddenModels, hiddenProviders, draftModel]);

  const filteredTools = useMemo(() => {
    const q = toolFilter.trim().toLowerCase();
    if (!q) return tools;
    return tools.filter((t) => t.id.toLowerCase().includes(q));
  }, [tools, toolFilter]);

  const draftVariants = useMemo<string[] | null>(() => {
    if (!draftModel) return null;
    const p = connectedProviders.find((pr) => pr.id === draftModel.providerID);
    const m = p?.models.find((mm) => mm.modelID === draftModel.modelID);
    return m?.variants ?? null;
  }, [draftModel, connectedProviders]);

  if (!open) return null;

  const save = () => {
    updateSettings({ systemPrompt, enabledTools, autoApprove: draftAutoApprove, expandThinking: draftExpandThinking, autoExpandBash: draftAutoExpandBash, autoExpandEdit: draftAutoExpandEdit, autoExpandError: draftAutoExpandError, soundOnComplete: draftSoundOnComplete, sendOnEnter: draftSendOnEnter });
    if (draftModel) {
      const sameKey =
        !!selectedModel && modelKey(draftModel) === modelKey(selectedModel);
      const sameVariant = !!selectedModel && selectedModel.variant === draftModel.variant;
      if (!sameKey || !sameVariant) {
        setSelectedModel(draftModel);
        postMessage({ type: "selectModel", model: draftModel });
      }
    }
    if (draftAgent !== selectedAgent) {
      setSelectedAgent(draftAgent);
      postMessage({ type: "selectAgent", agent: draftAgent });
    }
    setOpen(false);
  };

  const toggleTool = (id: string) => {
    setEnabledTools((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const onModelChange = (value: string) => {
    if (!value) return;
    const idx = value.indexOf("/");
    if (idx <= 0) return;
    setDraftModel({ providerID: value.slice(0, idx), modelID: value.slice(idx + 1) });
  };

  const onVariantChange = (value: string) => {
    setDraftModel((cur) => {
      if (!cur) return cur;
      if (!value) {
        if (!cur.variant) return cur;
        const next = { ...cur };
        delete next.variant;
        return next;
      }
      return { ...cur, variant: value };
    });
  };

  const onAgentChange = (value: string) => {
    setDraftAgent(value || null);
  };

  const statusLabel =
    serverStatus === "ready" ? "Connected" : serverStatus === "starting" ? "Starting…" : "Error";
  const modeLabel = isManaged == null ? "—" : isManaged ? "Managed (spawned)" : "External";

  const currentModelValue = draftModel ? modelKey(draftModel) : "";
  const enabledCount = Object.values(enabledTools).filter(Boolean).length;
  const hiddenSet = new Set(hiddenModels);
  const hiddenProviderSet = new Set(hiddenProviders);
  const serverDefault = config?.model ?? "(none — first connected model is used)";
  const totalModels = connectedProviders.reduce((n, p) => n + p.models.length, 0);
  const visibleCount = connectedProviders.reduce(
    (n, p) => n + p.models.filter((m) => !hiddenSet.has(modelKey(m))).length,
    0,
  );

  const TABS: { id: Tab; label: string }[] = [
    { id: "general", label: "General" },
    { id: "models", label: "Models" },
    { id: "tools", label: "Tools" },
    { id: "connection", label: "Connection" },
  ];

  return (
    <div className="modal-overlay" onClick={() => setOpen(false)}>
      <div className="modal settings-panel" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span className="modal-title">Settings</span>
          <button className="modal-close" title="Close" onClick={() => setOpen(false)}>
            ✕
          </button>
        </div>
        <div className="modal-body">
          <div className="settings-tabs" role="tablist">
            {TABS.map((t) => (
              <button
                key={t.id}
                role="tab"
                aria-selected={tab === t.id}
                className={`settings-tab ${tab === t.id ? "active" : ""}`}
                onClick={() => setTab(t.id)}
              >
                {t.label}
              </button>
            ))}
          </div>

          {tab === "general" && (
            <>
              <section className="settings-section">
                <div className="settings-section-title">Agent behavior</div>
                <div className="settings-field">
                  <ToggleRow
                    checked={draftAutoApprove}
                    onChange={setDraftAutoApprove}
                    danger
                    title="YOLO mode — auto-approve every tool request"
                    hint="When on, the agent runs without asking. Approvals are sent instantly. Use with care."
                  />
                </div>
                <div className="settings-field">
                  <ToggleRow
                    checked={draftExpandThinking}
                    onChange={setDraftExpandThinking}
                    title="Expand thinking blocks by default"
                    hint="Reasoning/thought-process blocks render open. You can still collapse them individually."
                  />
                </div>
              </section>

              <section className="settings-section">
                <div className="settings-section-title">Auto-expand tool calls</div>
                <div className="settings-field">
                  <ToggleRow
                    checked={draftAutoExpandBash}
                    onChange={setDraftAutoExpandBash}
                    title="Expand bash commands"
                    hint="Show the command and its output without needing to click."
                  />
                </div>
                <div className="settings-field">
                  <ToggleRow
                    checked={draftAutoExpandEdit}
                    onChange={setDraftAutoExpandEdit}
                    title="Expand edits (write / edit / replace)"
                    hint="Show the diff inline as soon as the tool runs."
                  />
                </div>
                <div className="settings-field">
                  <ToggleRow
                    checked={draftAutoExpandError}
                    onChange={setDraftAutoExpandError}
                    title="Expand on error"
                    hint="Auto-open any tool call that fails so the error is immediately visible."
                  />
                </div>
              </section>

              <section className="settings-section">
                <div className="settings-section-title">Input</div>
                <div className="settings-field">
                  <ToggleRow
                    checked={draftSendOnEnter}
                    onChange={setDraftSendOnEnter}
                    title="Send on Enter"
                    hint="On: Enter sends the message, Shift+Enter inserts a newline. Off: ⌘/Ctrl+Enter sends, Enter inserts a newline. ⌘/Ctrl+Enter always sends regardless of this setting."
                  />
                </div>
              </section>

              <section className="settings-section">
                <div className="settings-section-title">Feedback</div>
                <div className="settings-field">
                  <ToggleRow
                    checked={draftSoundOnComplete}
                    onChange={setDraftSoundOnComplete}
                    title="Sound cues"
                    hint="Play a soft cue when the agent finishes a turn, and a brighter one when it needs your input (a question or an approval request)."
                  />
                </div>
              </section>

              <section className="settings-section">
                <div className="settings-section-title">System prompt override</div>
                <div className="settings-field">
                  <span className="settings-hint">
                    Prepended to the agent&apos;s own system prompt and sent with every message.
                    Leave empty to use the agent default.
                  </span>
                  <textarea
                    className="settings-textarea"
                    placeholder="e.g. Always respond in TypeScript and prefer functional style…"
                    value={systemPrompt}
                    rows={5}
                    onChange={(e) => setSystemPrompt(e.target.value)}
                  />
                </div>
              </section>
            </>
          )}

          {tab === "models" && (
            <>
              <section className="settings-section">
                <div className="settings-section-title">Model &amp; Agent</div>

                <div className="settings-field">
                  <label className="settings-label" htmlFor="settings-model">
                    Model for new messages
                  </label>
                  <select
                    id="settings-model"
                    className="settings-select"
                    value={currentModelValue}
                    onChange={(e) => onModelChange(e.target.value)}
                  >
                    {!draftModel && <option value="">Select model…</option>}
                    {visibleProviders.map((p) => (
                      <optgroup key={p.id} label={p.name}>
                        {p.models.map((m) => (
                          <option key={modelKey(m)} value={modelKey(m)}>
                            {m.name}
                          </option>
                        ))}
                      </optgroup>
                    ))}
                    {connectedProviders.length === 0 && (
                      <option value="">No providers connected</option>
                    )}
                    {connectedProviders.length > 0 &&
                      visibleProviders.length === 0 &&
                      !draftModel && (
                        <option value="">All models hidden — reveal in Model visibility below</option>
                      )}
                  </select>
                  <span className="settings-hint">Server default: {serverDefault}</span>
                  {draftVariants && draftVariants.length > 0 && (
                    <>
                      <label className="settings-label" htmlFor="settings-variant">
                        Thinking level (variant)
                      </label>
                      <select
                        id="settings-variant"
                        className="settings-select"
                        value={draftModel?.variant ?? ""}
                        onChange={(e) => onVariantChange(e.target.value)}
                      >
                        <option value="">Default (server pick)</option>
                        {draftVariants.map((v) => (
                          <option key={v} value={v}>
                            {v}
                          </option>
                        ))}
                      </select>
                      <span className="settings-hint">
                        Variants let the same model run with different reasoning effort
                        (e.g. low / medium / high). Picked alongside the model on every send.
                      </span>
                    </>
                  )}
                  <span className="settings-hint">
                    Models tagged <span className="badge badge-reasoning">R</span> support
                    reasoning/thinking.
                  </span>
                </div>

                <div className="settings-field">
                  <label className="settings-label" htmlFor="settings-agent">
                    Default agent
                  </label>
                  <select
                    id="settings-agent"
                    className="settings-select"
                    value={draftAgent ?? ""}
                    onChange={(e) => onAgentChange(e.target.value)}
                  >
                    <option value="">Default</option>
                    {agents.map((a) => (
                      <option key={a.name} value={a.name}>
                        {a.name}
                        {a.description ? ` — ${a.description}` : ""}
                      </option>
                    ))}
                  </select>
                </div>
              </section>

              <section className="settings-section">
                <div className="settings-section-title">Model visibility</div>
                <div className="settings-field">
                  <div className="settings-label-row">
                    <label className="settings-label">Models shown in the picker</label>
                    <span className="settings-hint">
                      {totalModels > 0 ? `${visibleCount} of ${totalModels} shown` : ""}
                    </span>
                  </div>
                  <span className="settings-hint">
                    Uncheck a model to hide it from the model selector dropdown. The active model is
                    always shown.
                  </span>
                  {connectedProviders.length === 0 ? (
                    <div className="settings-empty">No providers connected.</div>
                  ) : (
                    <div className="settings-model-vis">
                      {connectedProviders.map((p) => (
                        <div key={p.id} className="settings-model-group">
                          <label className="settings-model-group-title">
                            <input
                              type="checkbox"
                              className="settings-check"
                              checked={!hiddenProviderSet.has(p.id)}
                              onChange={() => toggleProviderHidden(p.id)}
                            />
                            <span>{p.name}</span>
                          </label>
                          {p.models.map((m) => {
                            const key = modelKey(m);
                            const visible = !hiddenSet.has(key);
                            return (
                              <label
                                key={key}
                                className={`settings-tool ${visible ? "checked" : ""}`}
                              >
                                <input
                                  type="checkbox"
                                  className="settings-check"
                                  checked={visible}
                                  onChange={() => toggleModelHidden(key)}
                                />
                                <span className="settings-tool-name" title={m.modelID}>
                                  {m.name}
                                </span>
                              </label>
                            );
                          })}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </section>
            </>
          )}

          {tab === "tools" && (
            <section className="settings-section">
              <div className="settings-label-row">
                <div className="settings-section-title">
                  Tools{enabledCount > 0 ? ` (${enabledCount} enabled)` : ""}
                </div>
              </div>
              <span className="settings-hint">
                Force-enable specific tools for new messages. Empty = the agent&apos;s default
                toolset. Approvals are handled separately (YOLO mode + per-request permission cards).
              </span>
              <div className="settings-field">
                {tools.length === 0 ? (
                  <div className="settings-empty">No tools available.</div>
                ) : (
                  <>
                    <input
                      className="settings-tool-filter"
                      type="text"
                      placeholder="Filter tools…"
                      value={toolFilter}
                      onChange={(e) => setToolFilter(e.target.value)}
                    />
                    <div className="settings-tools">
                      {filteredTools.map((t) => {
                        const checked = !!enabledTools[t.id];
                        return (
                          <label key={t.id} className={`settings-tool ${checked ? "checked" : ""}`}>
                            <input
                              type="checkbox"
                              className="settings-check"
                              checked={checked}
                              onChange={() => toggleTool(t.id)}
                            />
                            <span className="settings-tool-meta">
                              <span className="settings-tool-name">{t.id}</span>
                              {t.description && (
                                <span className="settings-tool-desc">{t.description}</span>
                              )}
                            </span>
                          </label>
                        );
                      })}
                      {filteredTools.length === 0 && (
                        <div className="settings-empty">No tools match “{toolFilter}”.</div>
                      )}
                    </div>
                  </>
                )}
              </div>
            </section>
          )}

          {tab === "connection" && (
            <>
              <section className="settings-section">
                <div className="settings-section-title">Server</div>
                <div className="settings-readonly">
                  <div className="settings-readonly-row">
                    <span className="settings-readonly-key">Status</span>
                    <span className={`settings-readonly-val status-${serverStatus}`}>
                      {statusLabel}
                    </span>
                  </div>
                  <div className="settings-readonly-row">
                    <span className="settings-readonly-key">URL</span>
                    <span className="settings-readonly-val settings-readonly-mono">
                      {serverUrl ?? "—"}
                    </span>
                  </div>
                  <div className="settings-readonly-row">
                    <span className="settings-readonly-key">Mode</span>
                    <span className="settings-readonly-val">{modeLabel}</span>
                  </div>
                  {externalUrl && !isManaged && (
                    <div className="settings-readonly-row">
                      <span className="settings-readonly-key">External URL</span>
                      <span className="settings-readonly-val settings-readonly-mono">
                        {externalUrl}
                      </span>
                    </div>
                  )}
                  <div className="settings-readonly-row">
                    <span className="settings-readonly-key">Binary</span>
                    <span className="settings-readonly-val settings-readonly-mono">
                      {binaryPath ?? "—"}
                    </span>
                  </div>
                </div>
                <div className="settings-actions">
                  <button
                    className="btn"
                    title="Re-fetch sessions / models / config"
                    onClick={() => postMessage({ type: "retryConnection" })}
                  >
                    Retry connection
                  </button>
                  <button
                    className="btn"
                    title="Open VS Code settings for opencode.* (binary path, external server, …)"
                    onClick={() => postMessage({ type: "openVscodeSettings" })}
                  >
                    Open VS Code settings
                  </button>
                </div>
              </section>

              <section className="settings-section">
                <div className="settings-section-title">opencode.json</div>
                <div className="settings-readonly">
                  <div className="settings-readonly-row">
                    <span className="settings-readonly-key">model</span>
                    <span className="settings-readonly-val settings-readonly-mono">
                      {config?.model ?? "—"}
                    </span>
                  </div>
                  <div className="settings-readonly-row">
                    <span className="settings-readonly-key">smallModel</span>
                    <span className="settings-readonly-val settings-readonly-mono">
                      {config?.smallModel ?? "—"}
                    </span>
                  </div>
                  <div className="settings-readonly-row">
                    <span className="settings-readonly-key">mode</span>
                    <span className="settings-readonly-val">{config?.mode ?? "—"}</span>
                  </div>
                  <div className="settings-readonly-row">
                    <span className="settings-readonly-key">username</span>
                    <span className="settings-readonly-val">{config?.username ?? "—"}</span>
                  </div>
                </div>
                <span className="settings-hint">
                  These come from your project&apos;s opencode.json. Edit the file to change them.
                </span>
              </section>
            </>
          )}
        </div>
        <div className="modal-foot">
          <button className="btn" onClick={() => setOpen(false)}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={save}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

interface ToggleRowProps {
  checked: boolean;
  onChange: (v: boolean) => void;
  title: string;
  hint: string;
  danger?: boolean;
}

function ToggleRow({ checked, onChange, title, hint, danger }: ToggleRowProps): React.ReactElement {
  return (
    <label className={`settings-toggle-row ${checked ? "on" : ""} ${danger ? "danger" : ""}`}>
      <span className="settings-toggle-text">
        <span className="settings-toggle-title">{title}</span>
        <span className="settings-toggle-hint">{hint}</span>
      </span>
      <input
        type="checkbox"
        className="settings-check"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
    </label>
  );
}
