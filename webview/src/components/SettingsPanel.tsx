import { useEffect, useMemo, useState } from "react";
import { useStore } from "../store/store";
import { postMessage } from "../api/vscodeApi";
import { modelKey } from "../models";
import type { ModelSelection, PermissionAction, PermissionTool } from "../api/types";

type Tab = "general" | "models" | "permissions" | "connection";

// Shorten an absolute config path to "<parent-folder>/<file>" so the UI shows
// e.g. "opencode-vscode-client/opencode.json" instead of a full path that
// wraps and breaks the layout. The full path stays available as a tooltip.
function shortPath(full: string): string {
  if (!full) return "—";
  const parts = full.replace(/\\/g, "/").split("/").filter(Boolean);
  if (parts.length <= 2) return full;
  return parts.slice(-2).join("/");
}

// Module-level constants (don't re-create per render).
// The engine matches any tool name; these are just curated suggestions for the
// dropdown. "Custom…" lets the user type an arbitrary name for anything else.
const PERMISSION_TOOL_OPTIONS: PermissionTool[] = [
  "bash",
  "edit",
  "write",
  "read",
  "webfetch",
  "task",
  "grep",
  "glob",
  "ls",
  "doom_loop",
  "external_directory",
];
// Common safe dev commands a user might want to allow without a prompt.
// Deliberately excludes anything destructive or outward-facing (rm -rf, git
// push, npm publish, git push --force, …) — those should stay on `ask`.
const BASH_PRESETS = [
  "git commit *",
  "git status",
  "git diff *",
  "git log *",
  "npm test *",
  "npm run *",
  "make *",
  "ls",
  "cat",
];

export function SettingsPanel(): React.ReactElement | null {
  const open = useStore((s) => s.settingsOpen);
  const setOpen = useStore((s) => s.setSettingsOpen);
  const settings = useStore((s) => s.settings);
  const updateSettings = useStore((s) => s.updateSettings);
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

  const permissionRules = useStore((s) => s.permissionRules);
  const requestPermissionRules = useStore((s) => s.requestPermissionRules);
  const savePermissionRule = useStore((s) => s.savePermissionRule);
  const removePermissionRule = useStore((s) => s.removePermissionRule);
  const reloadServer = useStore((s) => s.reloadServer);
  const permissionNotice = useStore((s) => s.permissionNotice);
  const dismissPermissionNotice = useStore((s) => s.dismissPermissionNotice);
  // Whether any session is generating — restarting the server would interrupt
  // it, so we ask for confirmation first.
  const anyBusy = useStore((s) =>
    Object.values(s.sessionStatus).some((st) => st.type === "busy" || st.type === "retry"),
  );
  // True while the server is restarting after "Reload to apply" — drives the
  // button's busy label/state so the click visibly does something.
  const reloading = useStore((s) => s.permissionReloading);

  const [systemPrompt, setSystemPrompt] = useState(settings.systemPrompt);
  const [draftModel, setDraftModel] = useState<ModelSelection | null>(selectedModel);
  const [draftAgent, setDraftAgent] = useState<string | null>(selectedAgent);
  const [draftExpandThinking, setDraftExpandThinking] = useState(settings.expandThinking);
  const [draftAutoExpandBash, setDraftAutoExpandBash] = useState(settings.autoExpandBash);
  const [draftAutoExpandEdit, setDraftAutoExpandEdit] = useState(settings.autoExpandEdit);
  const [draftAutoExpandError, setDraftAutoExpandError] = useState(settings.autoExpandError);
  const [draftSoundOnComplete, setDraftSoundOnComplete] = useState(settings.soundOnComplete);
  const [draftSendOnEnter, setDraftSendOnEnter] = useState(settings.sendOnEnter);
  const [tab, setTab] = useState<Tab>("general");
  const [newTool, setNewTool] = useState<PermissionTool>("bash");
  // Separate "custom mode" flag so typing a name that happens to match a preset
  // (e.g. "grep") doesn't snap the select back and hide the custom text field.
  const [toolCustom, setToolCustom] = useState(false);
  const [newPattern, setNewPattern] = useState("*");
  const [newAction, setNewAction] = useState<PermissionAction>("ask");

  useEffect(() => {
    if (open) {
      setSystemPrompt(settings.systemPrompt);
      setDraftModel(selectedModel);
      setDraftAgent(selectedAgent);
      setDraftExpandThinking(settings.expandThinking);
      setDraftAutoExpandBash(settings.autoExpandBash);
      setDraftAutoExpandEdit(settings.autoExpandEdit);
      setDraftAutoExpandError(settings.autoExpandError);
      setDraftSoundOnComplete(settings.soundOnComplete);
      setDraftSendOnEnter(settings.sendOnEnter);
    }
  }, [open, settings.systemPrompt, settings.expandThinking, settings.autoExpandBash, settings.autoExpandEdit, settings.autoExpandError, settings.soundOnComplete, settings.sendOnEnter, selectedModel, selectedAgent]);

  useEffect(() => {
    if (open && tab === "permissions") requestPermissionRules();
  }, [open, tab, requestPermissionRules]);

  useEffect(() => {
    if (!permissionNotice) return;
    const t = setTimeout(() => dismissPermissionNotice(), 8000);
    return () => clearTimeout(t);
  }, [permissionNotice, dismissPermissionNotice]);

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

  const draftVariants = useMemo<string[] | null>(() => {
    if (!draftModel) return null;
    const p = connectedProviders.find((pr) => pr.id === draftModel.providerID);
    const m = p?.models.find((mm) => mm.modelID === draftModel.modelID);
    return m?.variants ?? null;
  }, [draftModel, connectedProviders]);

  if (!open) return null;

  const save = () => {
    updateSettings({ systemPrompt, expandThinking: draftExpandThinking, autoExpandBash: draftAutoExpandBash, autoExpandEdit: draftAutoExpandEdit, autoExpandError: draftAutoExpandError, soundOnComplete: draftSoundOnComplete, sendOnEnter: draftSendOnEnter });
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
  const hiddenSet = new Set(hiddenModels);
  const hiddenProviderSet = new Set(hiddenProviders);
  const serverDefault = config?.model ?? "(none — first connected model is used)";
  const totalModels = connectedProviders.reduce((n, p) => n + p.models.length, 0);
  const visibleCount = connectedProviders.reduce(
    (n, p) => n + p.models.filter((m) => !hiddenSet.has(modelKey(m))).length,
    0,
  );

  const permRules = permissionRules?.rules ?? [];
  const permWritePath = permissionRules
    ? permissionRules.writeTarget === "project"
      ? permissionRules.projectPath
      : permissionRules.globalPath
    : "";

  const addRule = () => {
    if (!permissionRules) return;
    const source = permissionRules.writeTarget;
    const tool = newTool.trim();
    if (!tool) return;
    // Any tool accepts a pattern (engine matches via wildcard). Empty pattern
    // defaults to "*" (whole tool).
    const pattern = newPattern.trim() || "*";
    // Confirm ONLY when about to CREATE a project config that doesn't exist yet.
    // Writing to an existing project file, or to global when the workspace IS
    // home, happens silently.
    if (source === "project" && !permissionRules.projectFileExists) {
      if (!window.confirm(`Create ${permissionRules.projectPath} in the project?`)) return;
    }
    savePermissionRule({ tool, pattern, action: newAction, source });
    // Reset the pattern field and custom flag (keep tool/action for fast repeats).
    setNewPattern("");
    setToolCustom(false);
    setNewTool("bash");
  };

  const TABS: { id: Tab; label: string }[] = [
    { id: "general", label: "General" },
    { id: "models", label: "Models" },
    { id: "permissions", label: "Permissions" },
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

          {tab === "permissions" && (
            <section className="settings-section">
              {permissionNotice && (
                <div className="perm-notice" role="status">
                  <span className="perm-notice-text">{permissionNotice.message}</span>
                  <button className="perm-notice-dismiss" title="Dismiss" onClick={() => dismissPermissionNotice()}>
                    ✕
                  </button>
                </div>
              )}
              <div className="settings-label-row">
                <div className="settings-section-title">Permission rules</div>
                <button
                  className={`btn btn-sm${reloading ? " btn-busy" : ""}`}
                  disabled={!isManaged || reloading}
                  title={
                    !isManaged
                      ? "Connected to an external server — restart it manually to apply changes"
                      : reloading
                        ? "Restarting server to apply permission changes…"
                        : "Restart the server so it re-reads opencode.json"
                  }
                  onClick={() => {
                    if (anyBusy) {
                      const ok = window.confirm(
                        "A generation is in progress. Restarting the server will interrupt it. Restart anyway?",
                      );
                      if (!ok) return;
                    }
                    reloadServer(anyBusy);
                  }}
                >
                  {reloading ? (
                    <>
                      <span className="btn-spinner" aria-hidden />
                      Restarting…
                    </>
                  ) : (
                    "Reload to apply"
                  )}
                </button>
              </div>
              <span className="settings-hint">
                Rules the engine consults when a tool runs. <code>ask</code> prompts you,{" "}
                <code>allow</code> skips the prompt, <code>deny</code> blocks. New rules save to{" "}
                <code className="perm-path" title={permWritePath || undefined}>
                  {shortPath(permWritePath)}
                </code>
                {permissionRules?.writeTarget === "global" && " (global — affects all projects)"}.
              </span>

              <div className="settings-field">
                {permRules.length === 0 ? (
                  <div className="settings-empty">No explicit rules. Action tools default to <code>ask</code>.</div>
                ) : (
                  <div className="perm-table" role="table" aria-label="Permission rules">
                    {permRules.map((r, i) => {
                      const dead = permissionRules?.effective[i] === false;
                      return (
                        <div
                          className={`perm-row${dead ? " perm-row-dead" : ""}`}
                          key={`${r.source}:${r.tool}:${r.pattern}`}
                          role="row"
                          title={dead ? "Shadowed by a later rule — never wins (remove or reorder)" : undefined}
                        >
                          <span className="perm-tool" role="cell">{r.tool}</span>
                          <span className="perm-pattern" role="cell" title={r.pattern}>{r.pattern}</span>
                          <select
                            className="settings-select perm-action"
                            role="cell"
                            aria-label={`Action for ${r.tool} ${r.pattern}`}
                            value={r.action}
                            onChange={(e) =>
                              savePermissionRule({
                                tool: r.tool,
                                pattern: r.pattern,
                                action: e.target.value as PermissionAction,
                                source: r.source,
                              })
                            }
                          >
                            <option value="ask">ask</option>
                            <option value="allow">allow</option>
                            <option value="deny">deny</option>
                          </select>
                          <span
                            className={`perm-source perm-source-${r.source}`}
                            role="cell"
                            title={r.source === "global" ? permissionRules?.globalPath : permissionRules?.projectPath}
                          >
                            {r.source}
                          </span>
                          <button
                            className="perm-remove"
                            aria-label={`Remove ${r.tool} ${r.pattern} rule`}
                            title="Remove rule"
                            onClick={() => removePermissionRule(r.tool, r.pattern, r.source)}
                          >
                            ✕
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              <div className="settings-field perm-add">
                <div className="settings-label-row">
                  <label className="settings-label">Add rule</label>
                </div>
                <div className="perm-add-top">
                  <label className="perm-field perm-field-tool">
                    <span className="perm-field-label">Tool</span>
                    <select
                      className="perm-tool-select"
                      aria-label="Tool"
                      value={toolCustom ? "__custom__" : newTool}
                      onChange={(e) => {
                        const v = e.target.value;
                        if (v === "__custom__") {
                          setToolCustom(true);
                          setNewTool("");
                        } else {
                          setToolCustom(false);
                          setNewTool(v as PermissionTool);
                        }
                      }}
                    >
                      {PERMISSION_TOOL_OPTIONS.map((t) => (
                        <option key={t} value={t}>
                          {t}
                        </option>
                      ))}
                      <option value="__custom__">Custom…</option>
                    </select>
                  </label>
                  <label className="perm-field perm-field-action">
                    <span className="perm-field-label">Action</span>
                    <select
                      className="perm-action-select"
                      aria-label="Action"
                      value={newAction}
                      onChange={(e) => setNewAction(e.target.value as PermissionAction)}
                    >
                      <option value="ask">ask</option>
                      <option value="allow">allow</option>
                      <option value="deny">deny</option>
                    </select>
                  </label>
                </div>
                {toolCustom && (
                  <input
                    className="perm-tool-custom"
                    type="text"
                    placeholder="custom tool name (e.g. mcp__github__create_issue)"
                    value={newTool}
                    onChange={(e) => setNewTool(e.target.value)}
                    aria-label="Custom tool name"
                  />
                )}
                <label className="perm-field perm-field-pattern">
                  <span className="perm-field-label">
                    Pattern <span className="perm-field-optional">(wildcard; empty = whole tool)</span>
                  </span>
                  <input
                    className="perm-pattern-input"
                    type="text"
                    placeholder='e.g. "docker *", "*.md", or leave empty for the whole tool'
                    value={newPattern}
                    onChange={(e) => setNewPattern(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        addRule();
                      }
                    }}
                    aria-label="Pattern (wildcard)"
                  />
                </label>
                {newTool === "bash" && (
                  <div className="perm-presets" role="group" aria-label="Pattern presets">
                    {BASH_PRESETS.map((p) => (
                      <button
                        key={p}
                        type="button"
                        className={`perm-preset${newPattern === p ? " active" : ""}`}
                        onClick={() => setNewPattern(p)}
                      >
                        {p}
                      </button>
                    ))}
                  </div>
                )}
                <div className="perm-add-footer">
                  <span className="settings-hint perm-preview">
                    {newTool.trim() ? (
                      <>
                        Preview:{" "}
                        <code>{newTool.trim()}</code> {" → "} <code>{newPattern.trim() || "*"}</code> {" → "}
                        <span className={`perm-preview-action perm-preview-${newAction}`}>{newAction}</span>
                      </>
                    ) : (
                      <>Enter a tool name to add a rule.</>
                    )}
                  </span>
                  <button
                    className="btn btn-primary btn-sm"
                    onClick={addRule}
                    disabled={!newTool.trim()}
                  >
                    Add
                  </button>
                </div>
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
