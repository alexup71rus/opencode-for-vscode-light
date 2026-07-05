import { create } from "zustand";
import type {
  ExtensionToWebview,
  MessageWithParts,
  Part,
  Permission,
  ProjectConfig,
  ProviderInfo,
  ModelSelection,
  SessionStatusInfo,
  SessionWithMeta,
  AgentInfo,
  ToolInfo,
  CommandInfo,
  SkillInfo,
  Todo,
  McpServerStatus,
  LspStatusInfo,
  AttachedContext,
  SendMessageOptions,
  MessageAttachment,
  QuestionRequest,
} from "../api/types";

export interface Settings {
  systemPrompt: string;
  enabledTools: Record<string, boolean>;
  autoApprove: boolean;
  expandThinking: boolean;
  autoExpandBash: boolean;
  autoExpandEdit: boolean;
  autoExpandError: boolean;
  soundOnComplete: boolean;
  sendOnEnter: boolean;
}

export interface QueuedMessage {
  id: string;
  text: string;
  context?: AttachedContext;
  options?: SendMessageOptions;
  attachments?: MessageAttachment[];
}

export interface AppState {
  serverStatus: "starting" | "ready" | "error";
  errorMessage: string | null;
  serverUrl: string | null;
  binaryPath: string | null;
  isManaged: boolean | null;
  externalUrl: string | null;

  sessions: SessionWithMeta[];
  activeSessionId: string | null;

  messagesBySession: Record<string, MessageWithParts[]>;

  pendingPermissions: Permission[];
  pendingQuestions: QuestionRequest[];

  providers: ProviderInfo[];
  selectedModel: ModelSelection | null;

  agents: AgentInfo[];
  tools: ToolInfo[];
  selectedAgent: string | null;
  agentsRequested: boolean;

  commands: CommandInfo[];
  fileResults: string[];
  skills: SkillInfo[];
  todosBySession: Record<string, Todo[]>;
  mcpStatus: Record<string, McpServerStatus>;
  lspStatus: LspStatusInfo[];

  settings: Settings;

  pinnedSessions: string[];
  hiddenModels: string[];
  hiddenProviders: string[];
  collapsedProviders: string[];
  sessionSearch: string;

  settingsOpen: boolean;
  helpOpen: boolean;

  config: ProjectConfig | null;

  activeFile: string | null;
  selection: string | null;

  totalCost: number;
  totalTokens: { input: number; output: number; reasoning: number };

  sessionStatus: Record<string, SessionStatusInfo>;

  sidebarOpen: boolean;
  rightPanelOpen: boolean;
  sidebarWidth: number;
  rightWidth: number;
  recentPanelHidden: boolean;
  queuedMessages: QueuedMessage[];
  setSidebarOpen: (open: boolean) => void;
  toggleSidebar: () => void;
  setRightPanelOpen: (open: boolean) => void;
  toggleRightPanel: () => void;
  setRecentPanelHidden: (hidden: boolean) => void;

  handleMessage: (msg: ExtensionToWebview) => void;
  setSelectedModel: (model: ModelSelection) => void;
  setSelectedAgent: (agent: string | null) => void;
  setSessionSearch: (q: string) => void;
  togglePin: (sessionId: string) => void;
  toggleModelHidden: (key: string) => void;
  toggleProviderHidden: (providerId: string) => void;
  toggleProviderCollapsed: (providerId: string) => void;
  updateSettings: (patch: Partial<Settings>) => void;
  setSettingsOpen: (open: boolean) => void;
  setHelpOpen: (open: boolean) => void;
  setSidebarWidth: (w: number, persist?: boolean) => void;
  setRightWidth: (w: number, persist?: boolean) => void;
  enqueueMessage: (m: Omit<QueuedMessage, "id">, priority?: boolean) => void;
  removeQueuedMessage: (id: string) => void;
  shiftQueuedMessage: () => QueuedMessage | undefined;
  clearQueue: () => void;
  reset: () => void;
}

function upsertPart(list: MessageWithParts[], part: Part): MessageWithParts[] {
  return list.map((m) => {
    if (m.info.id !== part.messageID) return m;
    const idx = m.parts.findIndex((p) => p.id === part.id);
    const newParts = idx === -1 ? [...m.parts, part] : [...m.parts.slice(0, idx), part, ...m.parts.slice(idx + 1)];
    return { ...m, parts: newParts };
  });
}

// Streaming emits a `messagePartUpdated` event per token — far faster than the
// screen can paint. Applying each one synchronously re-renders the whole chat
// (re-parsing markdown over the full growing text) and starves the main thread,
// making modals / input / scroll feel frozen while a message streams in.
//
// Coalesce part updates into one state mutation per animation frame: buffer the
// latest part per id and flush on rAF. This caps renders at ~60fps and leaves
// the main thread responsive between frames.
type PendingPart = { sessionId: string; part: Part };
const pendingParts = new Map<string, PendingPart>(); // key: sessionId|messageID|partID
let partFlushScheduled = false;

function keyFor(sessionId: string, part: Part): string {
  return `${sessionId}|${part.messageID}|${part.id}`;
}

function schedulePartFlush(flush: () => void): void {
  if (partFlushScheduled) return;
  partFlushScheduled = true;
  const run = () => {
    partFlushScheduled = false;
    flush();
  };
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(run);
  } else {
    setTimeout(run, 16);
  }
}

function dropPendingForSession(sessionId: string): void {
  for (const key of pendingParts.keys()) {
    if (key.startsWith(`${sessionId}|`)) pendingParts.delete(key);
  }
}

const initialState = {
  serverStatus: "starting" as const,
  errorMessage: null as string | null,
  serverUrl: null as string | null,
  binaryPath: null as string | null,
  isManaged: null as boolean | null,
  externalUrl: null as string | null,
  sessions: [] as SessionWithMeta[],
  activeSessionId: null as string | null,
  messagesBySession: {} as Record<string, MessageWithParts[]>,
  pendingPermissions: [] as Permission[],
  pendingQuestions: [] as QuestionRequest[],
  providers: [] as ProviderInfo[],
  selectedModel: null as ModelSelection | null,
  agents: [] as AgentInfo[],
  tools: [] as ToolInfo[],
  selectedAgent: null as string | null,
  agentsRequested: false,
  commands: [] as CommandInfo[],
  fileResults: [] as string[],
  skills: [] as SkillInfo[],
  todosBySession: {} as Record<string, Todo[]>,
  mcpStatus: {} as Record<string, McpServerStatus>,
  lspStatus: [] as LspStatusInfo[],
  settings: { systemPrompt: "", enabledTools: {}, autoApprove: false, expandThinking: false, autoExpandBash: false, autoExpandEdit: false, autoExpandError: false, soundOnComplete: true, sendOnEnter: true },
  pinnedSessions: [] as string[],
  sessionSearch: "",
  collapsedProviders: [] as string[],
  hiddenProviders: [] as string[],
  settingsOpen: false,
  helpOpen: false,
  config: null as ProjectConfig | null,
  activeFile: null as string | null,
  selection: null as string | null,
  totalCost: 0,
  totalTokens: { input: 0, output: 0, reasoning: 0 },
  sessionStatus: {} as Record<string, SessionStatusInfo>,
  queuedMessages: [] as QueuedMessage[],
};

interface PersistedUi {
  sidebarOpen?: boolean;
  rightPanelOpen?: boolean;
  settings?: Settings;
  pinnedSessions?: string[];
  hiddenModels?: string[];
  hiddenProviders?: string[];
  collapsedProviders?: string[];
  selectedModel?: ModelSelection | null;
  selectedAgent?: string | null;
  sidebarWidth?: number;
  rightWidth?: number;
  recentPanelHidden?: boolean;
}

function loadPersistedUi(): PersistedUi {
  try {
    const raw = localStorage.getItem("opencode-ui-state");
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed as PersistedUi;
  } catch {
    // ignore
  }
  return {};
}

function savePersistedUi(state: PersistedUi): void {
  try {
    const current = loadPersistedUi();
    localStorage.setItem("opencode-ui-state", JSON.stringify({ ...current, ...state }));
  } catch {
    // ignore
  }
}

const persistedUi = loadPersistedUi();

export const useStore = create<AppState>((set, get) => ({
  ...initialState,

  sidebarOpen: persistedUi.sidebarOpen ?? true,
  rightPanelOpen: persistedUi.rightPanelOpen ?? false,
  settings: {
    systemPrompt: persistedUi.settings?.systemPrompt ?? "",
    enabledTools: persistedUi.settings?.enabledTools ?? {},
    autoApprove: persistedUi.settings?.autoApprove ?? false,
    expandThinking: persistedUi.settings?.expandThinking ?? false,
    autoExpandBash: persistedUi.settings?.autoExpandBash ?? false,
    autoExpandEdit: persistedUi.settings?.autoExpandEdit ?? false,
    autoExpandError: persistedUi.settings?.autoExpandError ?? true,
    soundOnComplete: persistedUi.settings?.soundOnComplete ?? true,
    sendOnEnter: persistedUi.settings?.sendOnEnter ?? true,
  },
  pinnedSessions: persistedUi.pinnedSessions ?? [],
  hiddenModels: persistedUi.hiddenModels ?? [],
  collapsedProviders: persistedUi.collapsedProviders ?? [],
  hiddenProviders: persistedUi.hiddenProviders ?? [],
  selectedModel: persistedUi.selectedModel ?? null,
  selectedAgent: persistedUi.selectedAgent ?? null,
  sidebarWidth: persistedUi.sidebarWidth ?? 230,
  rightWidth: persistedUi.rightWidth ?? 250,
  recentPanelHidden: persistedUi.recentPanelHidden ?? false,

  setSidebarOpen: (open) => {
    savePersistedUi({ sidebarOpen: open });
    set({ sidebarOpen: open });
  },
  toggleSidebar: () => {
    set((s) => {
      const next = !s.sidebarOpen;
      savePersistedUi({ sidebarOpen: next });
      return { sidebarOpen: next };
    });
  },
  setRightPanelOpen: (open) => {
    savePersistedUi({ rightPanelOpen: open });
    set({ rightPanelOpen: open });
  },
  setSidebarWidth: (w, persist = true) => {
    if (persist) savePersistedUi({ sidebarWidth: w });
    set({ sidebarWidth: w });
  },
  setRightWidth: (w, persist = true) => {
    if (persist) savePersistedUi({ rightWidth: w });
    set({ rightWidth: w });
  },
  setRecentPanelHidden: (hidden) => {
    savePersistedUi({ recentPanelHidden: hidden });
    set({ recentPanelHidden: hidden });
  },
  enqueueMessage: (m, priority) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    set((s) => ({
      queuedMessages: priority ? [{ ...m, id }, ...s.queuedMessages] : [...s.queuedMessages, { ...m, id }],
    }));
  },
  removeQueuedMessage: (id) => {
    set((s) => ({ queuedMessages: s.queuedMessages.filter((q) => q.id !== id) }));
  },
  shiftQueuedMessage: () => {
    const first = get().queuedMessages[0];
    if (first) {
      set((s) => ({ queuedMessages: s.queuedMessages.slice(1) }));
    }
    return first;
  },
  clearQueue: () => set({ queuedMessages: [] }),
  toggleRightPanel: () => {
    set((s) => {
      const next = !s.rightPanelOpen;
      savePersistedUi({ rightPanelOpen: next });
      return { rightPanelOpen: next };
    });
  },

  handleMessage: (msg) => {
    switch (msg.type) {
      case "state":
        set((s) => ({
          sessions: msg.sessions,
          activeSessionId: msg.activeSessionId,
          serverStatus: s.serverStatus === "starting" ? "ready" : s.serverStatus,
        }));
        break;

      case "messages":
        // Full-array replacement is authoritative and newer than any buffered
        // part updates for this session, so drop them to avoid stomping it.
        dropPendingForSession(msg.sessionId);
        set((s) => ({
          messagesBySession: { ...s.messagesBySession, [msg.sessionId]: msg.messages },
        }));
        break;

      case "messagePartUpdated": {
        // Buffer and flush on rAF (see pendingParts). Keeps the UI responsive
        // while a message streams token-by-token.
        pendingParts.set(keyFor(msg.sessionId, msg.part), { sessionId: msg.sessionId, part: msg.part });
        schedulePartFlush(() => {
          if (pendingParts.size === 0) return;
          const updates = Array.from(pendingParts.values());
          pendingParts.clear();
          set((s) => {
            let next = s.messagesBySession;
            let changed = false;
            for (const { sessionId, part } of updates) {
              const list = next[sessionId];
              if (!list) continue;
              next = { ...next, [sessionId]: upsertPart(list, part) };
              changed = true;
            }
            return changed ? { messagesBySession: next } : s;
          });
        });
        break;
      }

      case "messagePartRemoved":
        set((s) => {
          const list = s.messagesBySession[msg.sessionId];
          if (!list) return s;
          return {
            messagesBySession: {
              ...s.messagesBySession,
              [msg.sessionId]: list.map((m) =>
                m.info.id === msg.messageID
                  ? { ...m, parts: m.parts.filter((p) => p.id !== msg.partID) }
                  : m,
              ),
            },
          };
        });
        break;

      case "permissionRequest":
        set((s) => ({
          pendingPermissions: s.pendingPermissions.some((p) => p.id === msg.permission.id)
            ? s.pendingPermissions
            : [...s.pendingPermissions, msg.permission],
        }));
        break;

      case "permissionReplied":
        set((s) => ({
          pendingPermissions: s.pendingPermissions.filter((p) => p.id !== msg.permissionID),
        }));
        break;

      case "questionAdded":
        set((s) => ({
          pendingQuestions: s.pendingQuestions.some((q) => q.id === msg.question.id)
            ? s.pendingQuestions
            : [...s.pendingQuestions, msg.question],
        }));
        break;

      case "questionRemoved":
        set((s) => ({
          pendingQuestions: s.pendingQuestions.filter((q) => q.id !== msg.requestId),
        }));
        break;

      case "sessionStatus":
        set((s) => ({
          sessionStatus: { ...s.sessionStatus, [msg.sessionId]: msg.status },
        }));
        break;

      case "models":
        set((s) => {
          const stillValid =
            !!s.selectedModel &&
            msg.providers.some(
              (p) =>
                p.id === s.selectedModel!.providerID &&
                p.models.some((m) => m.modelID === s.selectedModel!.modelID),
            );
          let next = stillValid ? s.selectedModel : msg.defaultModel;
          // Drop a stale variant if the model no longer advertises it.
          if (next?.variant) {
            const provider = msg.providers.find((p) => p.id === next!.providerID);
            const model = provider?.models.find((m) => m.modelID === next!.modelID);
            if (!model?.variants?.includes(next.variant)) {
              next = { providerID: next.providerID, modelID: next.modelID };
            }
          }
          savePersistedUi({ selectedModel: next ?? null });
          return {
            providers: msg.providers,
            selectedModel: next,
          };
        });
        break;

      case "agents":
        set((s) => {
          const keepCurrent =
            s.selectedAgent && msg.agents.some((a) => a.name === s.selectedAgent);
          const preferredPrimary =
            msg.agents.find((a) => a.name === "build" && a.mode === "primary") ??
            msg.agents.find((a) => a.mode === "primary");
          const next = keepCurrent ? s.selectedAgent : preferredPrimary?.name ?? null;
          savePersistedUi({ selectedAgent: next });
          return {
            agents: msg.agents,
            tools: msg.tools,
            agentsRequested: false,
            selectedAgent: next,
          };
        });
        break;

      case "commands":
        set({ commands: msg.commands });
        break;

      case "fileResults":
        set({ fileResults: msg.files });
        break;

      case "skills":
        set({ skills: msg.skills });
        break;

      case "todos":
        set((s) => ({
          todosBySession: { ...s.todosBySession, [msg.sessionId]: msg.todos },
        }));
        break;

      case "mcpStatus":
        set({ mcpStatus: msg.servers });
        break;

      case "lspStatus":
        set({ lspStatus: msg.servers });
        break;

      case "config":
        set({ config: msg.config });
        break;

      case "stats":
        set({ totalCost: msg.totalCost, totalTokens: msg.totalTokens });
        break;

      case "context":
        set({
          activeFile: msg.activeFile,
          selection: msg.selection,
        });
        break;

      case "error":
        set({ errorMessage: msg.message });
        break;

      case "serverStatus":
        set((s) => ({
          serverStatus: msg.status,
          serverUrl: msg.url ?? s.serverUrl,
          binaryPath: msg.binaryPath ?? s.binaryPath,
          isManaged: msg.isManaged ?? s.isManaged,
          externalUrl: msg.externalUrl ?? s.externalUrl,
          errorMessage: msg.status === "error" ? (msg.message ?? s.errorMessage) : null,
        }));
        break;
    }
  },

  reset: () => set({ ...initialState }),

  setSelectedModel: (model) => {
    savePersistedUi({ selectedModel: model });
    set({ selectedModel: model });
  },

  setSelectedAgent: (agent) => {
    savePersistedUi({ selectedAgent: agent });
    set({ selectedAgent: agent });
  },

  setSessionSearch: (q) => set({ sessionSearch: q }),

  togglePin: (sessionId) => {
    set((s) => {
      const next = s.pinnedSessions.includes(sessionId)
        ? s.pinnedSessions.filter((id) => id !== sessionId)
        : [...s.pinnedSessions, sessionId];
      savePersistedUi({ pinnedSessions: next });
      return { pinnedSessions: next };
    });
  },

  toggleModelHidden: (key) => {
    set((s) => {
      const next = s.hiddenModels.includes(key)
        ? s.hiddenModels.filter((k) => k !== key)
        : [...s.hiddenModels, key];
      savePersistedUi({ hiddenModels: next });
      return { hiddenModels: next };
    });
  },

  toggleProviderHidden: (providerId) => {
    set((s) => {
      const next = s.hiddenProviders.includes(providerId)
        ? s.hiddenProviders.filter((id) => id !== providerId)
        : [...s.hiddenProviders, providerId];
      savePersistedUi({ hiddenProviders: next });
      return { hiddenProviders: next };
    });
  },

  toggleProviderCollapsed: (providerId) => {
    set((s) => {
      const next = s.collapsedProviders.includes(providerId)
        ? s.collapsedProviders.filter((id) => id !== providerId)
        : [...s.collapsedProviders, providerId];
      savePersistedUi({ collapsedProviders: next });
      return { collapsedProviders: next };
    });
  },

  updateSettings: (patch) => {
    set((s) => {
      const next = { ...s.settings, ...patch };
      savePersistedUi({ settings: next });
      return { settings: next };
    });
  },

  setSettingsOpen: (open) => set({ settingsOpen: open }),
  setHelpOpen: (open) => set({ helpOpen: open }),
}));
