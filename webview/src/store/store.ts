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
  CommandInfo,
  SkillInfo,
  Todo,
  McpServerStatus,
  LspStatusInfo,
  AttachedContext,
  SendMessageOptions,
  MessageAttachment,
  QuestionRequest,
  PermissionRule,
  PermissionRulesSnapshot,
  PermissionTool,
} from "../api/types";
import { postMessage } from "../api/vscodeApi";
import type { FileChange } from "../changes";

export interface Settings {
  systemPrompt: string;
  expandThinking: boolean;
  autoExpandBash: boolean;
  autoExpandEdit: boolean;
  autoExpandError: boolean;
  soundOnComplete: boolean;
  sendOnEnter: boolean;
  logToFile: boolean;
}

export interface QueuedMessage {
  id: string;
  text: string;
  context?: AttachedContext;
  options?: SendMessageOptions;
  attachments?: MessageAttachment[];
}

interface DiffModalBase {
  filePath: string;
  edits: { oldStr: string; newStr: string }[];
  isNewFile: boolean;
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

  // YOLO / auto-approve is per-session and intentionally NOT persisted: it
  // auto-approves dangerous tools (bash/edit/task), so silently restoring it
  // across a VS Code reload would be a footgun. Resets to off on reload.
  autoApproveBySession: Record<string, boolean>;

  // Session-scoped errors emitted by the opencode server (session.error).
  // Kept separate from the global `errorMessage` banner (which is for
  // system/operational failures) and surfaced above the composer instead.
  sessionErrors: Record<string, string>;

  providers: ProviderInfo[];
  selectedModel: ModelSelection | null;

  agents: AgentInfo[];
  selectedAgent: string | null;
  agentsRequested: boolean;

  commands: CommandInfo[];
  mentionResults: string[];
  attachResults: string[];
  mentionFileQuery: string | null;
  attachFileQuery: string | null;
  // Transient: images produced by paste/picker, awaiting insertion into the
  // composer as @path mentions. ChatInput consumes and clears it.
  pendingImageInsert: { path: string; mime: string }[] | null;
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

  permissionRules: PermissionRulesSnapshot | null;
  permissionNotice: { kind: "externalChange"; message: string } | null;
  // Local UI flag: true between clicking "Reload to apply" and the server
  // coming back ready/error. Drives the button's busy label.
  permissionReloading: boolean;

  activeFilePath: string | null;
  activeFileName: string | null;
  selection: string | null;

  sessionStatus: Record<string, SessionStatusInfo>;

  sidebarOpen: boolean;
  rightPanelOpen: boolean;
  sidebarWidth: number;
  sidebarHeight: number;
  rightWidth: number;
  recentPanelHidden: boolean;
  contextLegendOpen: boolean;
  pinnedSlash: string[];
  changesBaseline: Record<string, string>;
  // Per-session queue: messages enqueued while a session is busy are kept
  // separately for each session, so switching chats no longer drops the queue.
  queuedMessagesBySession: Record<string, QueuedMessage[]>;
  suppressQueueOnIdle: boolean;
  diffModal:
    | null
    | (DiffModalBase & { status: "loading" })
    | (DiffModalBase & { status: "ready"; label: string; before: string; after: string })
    | (DiffModalBase & { status: "error"; message: string });
  allFilesDiffModal: { changes: FileChange[] } | null;
  fileExists: Record<string, boolean>;
  drafts: Record<string, string>;
  setDraft: (sessionId: string, text: string) => void;
  setSidebarOpen: (open: boolean) => void;
  toggleSidebar: () => void;
  setRightPanelOpen: (open: boolean) => void;
  toggleRightPanel: () => void;
  setRecentPanelHidden: (hidden: boolean) => void;
  setContextLegendOpen: (open: boolean) => void;
  /** Toggle a command/skill pin. `key` is `command:<name>` or `skill:<name>`. */
  togglePinnedSlash: (key: string) => void;
  applyChanges: (sessionId: string, messageId: string) => void;
  openFileDiffModal: (filePath: string, edits: { oldStr: string; newStr: string }[], isNewFile: boolean) => void;
  closeFileDiffModal: () => void;
  openAllFilesDiffModal: (changes: FileChange[]) => void;
  closeAllFilesDiffModal: () => void;
  checkFilesExist: (paths: string[]) => void;

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
  requestPermissionRules: () => void;
  savePermissionRule: (rule: PermissionRule) => void;
  removePermissionRule: (tool: PermissionTool, pattern: string, source: "global" | "project") => void;
  reloadServer: (force?: boolean) => void;
  dismissPermissionNotice: () => void;
  setSidebarWidth: (w: number, persist?: boolean) => void;
  setSidebarHeight: (h: number, persist?: boolean) => void;
  setRightWidth: (w: number, persist?: boolean) => void;
  enqueueMessage: (sessionId: string, m: Omit<QueuedMessage, "id">, priority?: boolean) => void;
  removeQueuedMessage: (sessionId: string, id: string) => void;
  shiftQueuedMessage: (sessionId: string) => QueuedMessage | undefined;
  reorderQueuedMessages: (sessionId: string, fromId: string, toId: string) => void;
  clearPendingImageInsert: () => void;
  /** Toggle YOLO / auto-approve for a single session (in-memory only). */
  setAutoApprove: (sessionId: string, on: boolean) => void;
  /** Dismiss a session-scoped opencode error surfaced above the composer. */
  dismissSessionError: (sessionId: string) => void;
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
  selectedAgent: null as string | null,
  agentsRequested: false,
  commands: [] as CommandInfo[],
  mentionResults: [] as string[],
  attachResults: [] as string[],
  mentionFileQuery: null as string | null,
  attachFileQuery: null as string | null,
  pendingImageInsert: null as { path: string; mime: string }[] | null,
  skills: [] as SkillInfo[],
  todosBySession: {} as Record<string, Todo[]>,
  mcpStatus: {} as Record<string, McpServerStatus>,
  lspStatus: [] as LspStatusInfo[],
  settings: { systemPrompt: "", expandThinking: false, autoExpandBash: false, autoExpandEdit: true, autoExpandError: true, soundOnComplete: true, sendOnEnter: true, logToFile: true },
  pinnedSessions: [] as string[],
  sessionSearch: "",
  collapsedProviders: [] as string[],
  hiddenProviders: [] as string[],
  settingsOpen: false,
  helpOpen: false,
  config: null as ProjectConfig | null,
  permissionRules: null as PermissionRulesSnapshot | null,
  permissionNotice: null as { kind: "externalChange"; message: string } | null,
  permissionReloading: false,
  activeFilePath: null as string | null,
  activeFileName: null as string | null,
  selection: null as string | null,
  sessionStatus: {} as Record<string, SessionStatusInfo>,
  autoApproveBySession: {} as Record<string, boolean>,
  sessionErrors: {} as Record<string, string>,
  queuedMessagesBySession: {} as Record<string, QueuedMessage[]>,
  suppressQueueOnIdle: false,
  diffModal: null as AppState["diffModal"],
  allFilesDiffModal: null as AppState["allFilesDiffModal"],
  fileExists: {} as Record<string, boolean>,
  drafts: {} as Record<string, string>,
  changesBaseline: {} as Record<string, string>,
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
  sidebarHeight?: number;
  rightWidth?: number;
  recentPanelHidden?: boolean;
  contextLegendOpen?: boolean;
  changesBaseline?: Record<string, string>;
  /** Pinned commands/skills, keyed as `command:<name>` / `skill:<name>` so
   *  commands and skills with the same name stay distinct. Surfaced at the top
   *  of the / and $ drop-downs behind a "Pinned" separator. */
  pinnedSlash?: string[];
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
    expandThinking: persistedUi.settings?.expandThinking ?? false,
    autoExpandBash: persistedUi.settings?.autoExpandBash ?? false,
    autoExpandEdit: persistedUi.settings?.autoExpandEdit ?? true,
    autoExpandError: persistedUi.settings?.autoExpandError ?? true,
    soundOnComplete: persistedUi.settings?.soundOnComplete ?? true,
    sendOnEnter: persistedUi.settings?.sendOnEnter ?? true,
    logToFile: persistedUi.settings?.logToFile ?? true,
  },
  pinnedSessions: persistedUi.pinnedSessions ?? [],
  hiddenModels: persistedUi.hiddenModels ?? [],
  collapsedProviders: persistedUi.collapsedProviders ?? [],
  hiddenProviders: persistedUi.hiddenProviders ?? [],
  selectedModel: persistedUi.selectedModel ?? null,
  selectedAgent: persistedUi.selectedAgent ?? null,
  sidebarWidth: persistedUi.sidebarWidth ?? 230,
  sidebarHeight: persistedUi.sidebarHeight ?? 260,
  rightWidth: persistedUi.rightWidth ?? 250,
  recentPanelHidden: persistedUi.recentPanelHidden ?? false,
  contextLegendOpen: persistedUi.contextLegendOpen ?? false,
  changesBaseline: persistedUi.changesBaseline ?? {},
  pinnedSlash: persistedUi.pinnedSlash ?? [],

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
  setSidebarHeight: (h, persist = true) => {
    if (persist) savePersistedUi({ sidebarHeight: h });
    set({ sidebarHeight: h });
  },
  setRightWidth: (w, persist = true) => {
    if (persist) savePersistedUi({ rightWidth: w });
    set({ rightWidth: w });
  },
  setRecentPanelHidden: (hidden) => {
    savePersistedUi({ recentPanelHidden: hidden });
    set({ recentPanelHidden: hidden });
  },
  setContextLegendOpen: (open) => {
    savePersistedUi({ contextLegendOpen: open });
    set({ contextLegendOpen: open });
  },
  togglePinnedSlash: (key) => {
    set((s) => {
      const has = s.pinnedSlash.includes(key);
      const next = has ? s.pinnedSlash.filter((k) => k !== key) : [...s.pinnedSlash, key];
      savePersistedUi({ pinnedSlash: next });
      return { pinnedSlash: next };
    });
  },
  applyChanges: (sessionId, messageId) => {
    const next = { ...(get().changesBaseline ?? {}), [sessionId]: messageId };
    savePersistedUi({ changesBaseline: next });
    set({ changesBaseline: next });
  },
  openFileDiffModal: (filePath, edits, isNewFile) => {
    set({ diffModal: { status: "loading", filePath, edits, isNewFile } });
    postMessage({ type: "getFileDiffContent", filePath, edits, isNewFile });
  },

  closeFileDiffModal: () => set({ diffModal: null }),
  openAllFilesDiffModal: (changes) => set({ allFilesDiffModal: { changes } }),
  closeAllFilesDiffModal: () => set({ allFilesDiffModal: null }),
  checkFilesExist: (paths) => {
    if (paths.length === 0) return;
    postMessage({ type: "checkFilesExist", paths });
  },
  enqueueMessage: (sessionId, m, priority) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    set((s) => {
      const cur = s.queuedMessagesBySession[sessionId] ?? [];
      const next = priority ? [{ ...m, id }, ...cur] : [...cur, { ...m, id }];
      return { queuedMessagesBySession: { ...s.queuedMessagesBySession, [sessionId]: next } };
    });
  },
  removeQueuedMessage: (sessionId, id) => {
    set((s) => {
      const cur = s.queuedMessagesBySession[sessionId];
      if (!cur) return {};
      return { queuedMessagesBySession: { ...s.queuedMessagesBySession, [sessionId]: cur.filter((q) => q.id !== id) } };
    });
  },
  reorderQueuedMessages: (sessionId, fromId, toId) => {
    if (fromId === toId) return;
    set((s) => {
      const cur = s.queuedMessagesBySession[sessionId];
      if (!cur) return {};
      const from = cur.findIndex((q) => q.id === fromId);
      const to = cur.findIndex((q) => q.id === toId);
      if (from === -1 || to === -1) return {};
      const next = cur.slice();
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return { queuedMessagesBySession: { ...s.queuedMessagesBySession, [sessionId]: next } };
    });
  },
  shiftQueuedMessage: (sessionId) => {
    const cur = get().queuedMessagesBySession[sessionId] ?? [];
    const first = cur[0];
    if (first) {
      set((s) => ({
        queuedMessagesBySession: {
          ...s.queuedMessagesBySession,
          [sessionId]: (s.queuedMessagesBySession[sessionId] ?? []).slice(1),
        },
      }));
    }
    return first;
  },
  clearPendingImageInsert: () => set({ pendingImageInsert: null }),
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

      case "messageRemoved": {
        // A message was deleted server-side (revert/deleteMessage). Drop it from
        // the list. If the changes-baseline for this session points at a message
        // that no longer exists, clear it so the Changes panel doesn't anchor to
        // stale state. (dropPendingForSession not needed: part events for the
        // removed message will simply no-op via upsertPart.)
        set((s) => {
          const list = s.messagesBySession[msg.sessionId];
          if (!list) return s;
          const next = list.filter((m) => m.info.id !== msg.messageID);
          if (next.length === list.length) return s;
          const baseline = s.changesBaseline[msg.sessionId];
          const baselineStillPresent =
            !baseline || next.some((m) => m.info.id === baseline);
          const changesBaseline = baselineStillPresent
            ? s.changesBaseline
            : Object.fromEntries(
                Object.entries(s.changesBaseline).filter(([k]) => k !== msg.sessionId),
              );
          return {
            messagesBySession: { ...s.messagesBySession, [msg.sessionId]: next },
            changesBaseline,
          };
        });
        break;
      }

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
        set((s) => {
          // A session going busy means a fresh turn started — clear any stale
          // session-scoped error so a previous failure doesn't linger above the
          // composer while new output streams in.
          if (msg.status.type === "busy" && s.sessionErrors[msg.sessionId]) {
            const { [msg.sessionId]: _drop, ...restErrors } = s.sessionErrors;
            return {
              sessionStatus: { ...s.sessionStatus, [msg.sessionId]: msg.status },
              sessionErrors: restErrors,
            };
          }
          return { sessionStatus: { ...s.sessionStatus, [msg.sessionId]: msg.status } };
        });
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
            agentsRequested: false,
            selectedAgent: next,
          };
        });
        break;

      case "commands": {
        // Drop pin entries for commands that no longer exist (renamed/removed).
        set((s) => {
          const valid = new Set(msg.commands.map((c) => `command:${c.name}`));
          const pruned = s.pinnedSlash.filter(
            (k) => !k.startsWith("command:") || valid.has(k),
          );
          if (pruned.length === s.pinnedSlash.length) return { commands: msg.commands };
          savePersistedUi({ pinnedSlash: pruned });
          return { commands: msg.commands, pinnedSlash: pruned };
        });
        break;
      }

      case "fileResults": {
        if (msg.source === "mention") {
          // Discard stale responses — only apply if the query matches the
          // last one the user typed in the @mention picker.
          if (msg.query === get().mentionFileQuery) {
            set({ mentionResults: msg.files });
          }
        } else {
          if (msg.query === get().attachFileQuery) {
            set({ attachResults: msg.files });
          }
        }
        break;
      }

      case "imageSaved": {
        set({ pendingImageInsert: [{ path: msg.path, mime: msg.mime }] });
        break;
      }

      case "imagesPicked": {
        if (msg.items.length > 0) {
          set({ pendingImageInsert: msg.items.map((i) => ({ path: i.path, mime: i.mime })) });
        }
        break;
      }

      case "skills": {
        // Drop pin entries for skills that no longer exist (renamed/removed).
        set((s) => {
          const valid = new Set(msg.skills.map((sk) => `skill:${sk.name}`));
          const pruned = s.pinnedSlash.filter(
            (k) => !k.startsWith("skill:") || valid.has(k),
          );
          if (pruned.length === s.pinnedSlash.length) return { skills: msg.skills };
          savePersistedUi({ pinnedSlash: pruned });
          return { skills: msg.skills, pinnedSlash: pruned };
        });
        break;
      }

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

      case "permissionRules":
        set({ permissionRules: msg.snapshot });
        break;

      case "permissionNotice":
        set({ permissionNotice: { kind: msg.kind, message: msg.message } });
        break;

      case "clearPermissionNotice":
        set({ permissionNotice: null });
        break;

      case "context":
        set({
          activeFilePath: msg.filePath,
          activeFileName: msg.fileName,
          selection: msg.selection,
        });
        break;

      case "fileDiffContent": {
        set((s) => {
          const cur = s.diffModal;
          // Only apply if we're currently loading this exact file — a late
          // response arriving after the user closed the modal must not reopen it.
          if (!cur || cur.status !== "loading" || cur.filePath !== msg.filePath) return s;
          if (msg.error) {
            return {
              diffModal: {
                status: "error",
                filePath: msg.filePath,
                edits: cur.edits,
                isNewFile: cur.isNewFile,
                message: msg.error,
              },
            };
          }
          return {
            diffModal: {
              status: "ready",
              filePath: msg.filePath,
              edits: cur.edits,
              isNewFile: cur.isNewFile,
              label: msg.label,
              before: msg.before,
              after: msg.after,
            },
          };
        });
        break;
      }

      case "filesExist": {
        set((s) => ({ fileExists: { ...s.fileExists, ...msg.results } }));
        break;
      }

      case "error":
        set({ errorMessage: msg.message });
        break;

      case "sessionError":
        // Session-scoped opencode error: surface it above that session's
        // composer instead of the global banner, so an error in a background
        // session doesn't hijack the whole UI.
        set((s) => ({
          sessionErrors: { ...s.sessionErrors, [msg.sessionId]: msg.message },
        }));
        break;

      case "serverStatus":
        set((s) => ({
          serverStatus: msg.status,
          serverUrl: msg.url ?? s.serverUrl,
          binaryPath: msg.binaryPath ?? s.binaryPath,
          isManaged: msg.isManaged ?? s.isManaged,
          externalUrl: msg.externalUrl ?? s.externalUrl,
          errorMessage: msg.status === "error" ? (msg.message ?? s.errorMessage) : null,
          // A ready/error transition means a pending reload has finished.
          permissionReloading: msg.status === "starting" ? s.permissionReloading : false,
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

  setDraft: (sessionId, text) =>
    set((s) => ({ drafts: { ...s.drafts, [sessionId]: text } })),

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

  setAutoApprove: (sessionId, on) =>
    set((s) => ({
      autoApproveBySession: { ...s.autoApproveBySession, [sessionId]: on },
    })),
  dismissSessionError: (sessionId) =>
    set((s) => {
      if (!(sessionId in s.sessionErrors)) return s;
      const next = { ...s.sessionErrors };
      delete next[sessionId];
      return { sessionErrors: next };
    }),

  requestPermissionRules: () => postMessage({ type: "getPermissionRules" }),
  savePermissionRule: (rule) => postMessage({ type: "savePermissionRule", rule }),
  removePermissionRule: (tool, pattern, source) =>
    postMessage({ type: "removePermissionRule", tool, pattern, source }),
  reloadServer: (force?: boolean) => {
    // Local busy flag so the "Reload to apply" button can show a restarting
    // state immediately on click. Cleared by the next ready/error serverStatus.
    set({ permissionReloading: true });
    postMessage({ type: "reloadServer", force });
  },
  dismissPermissionNotice: () => set({ permissionNotice: null }),
}));
