import type {
  SessionWithMeta,
  MessageWithParts,
  Part,
  Permission,
  ProviderInfo,
  ModelSelection,
  ProjectConfig,
  AttachedContext,
  SessionStatusInfo,
  AgentInfo,
  ToolInfo,
  CommandInfo,
  SendMessageOptions,
  MessageAttachment,
  SkillInfo,
  Todo,
  McpServerStatus,
  LspStatusInfo,
  QuestionRequest,
} from "../bridge/types";

export type FileSearchSource = "mention" | "attach";

export type ExtensionToWebview =
  | { type: "state"; sessions: SessionWithMeta[]; activeSessionId: string | null }
  | {
      type: "messages";
      sessionId: string;
      messages: MessageWithParts[];
    }
  | { type: "messagePartUpdated"; sessionId: string; part: Part; delta?: string }
  | { type: "messagePartRemoved"; sessionId: string; messageID: string; partID: string }
  | { type: "messageRemoved"; sessionId: string; messageID: string }
  | { type: "permissionRequest"; sessionId: string; permission: Permission }
  | { type: "permissionReplied"; sessionId: string; permissionID: string; response?: string }
  | { type: "questionAdded"; sessionId: string; question: QuestionRequest }
  | { type: "questionRemoved"; sessionId: string; requestId: string }
  | { type: "sessionStatus"; sessionId: string; status: SessionStatusInfo }
  | { type: "models"; providers: ProviderInfo[]; defaultModel: ModelSelection | null }
  | { type: "agents"; agents: AgentInfo[]; tools: ToolInfo[] }
  | { type: "commands"; commands: CommandInfo[] }
  | { type: "fileResults"; files: string[]; source: FileSearchSource; query: string }
  | { type: "config"; config: ProjectConfig }
  | { type: "skills"; skills: SkillInfo[] }
  | { type: "todos"; sessionId: string; todos: Todo[] }
  | { type: "mcpStatus"; servers: Record<string, McpServerStatus> }
  | { type: "lspStatus"; servers: LspStatusInfo[] }
  | { type: "stats"; totalCost: number; totalTokens: { input: number; output: number; reasoning: number } }
  | { type: "context"; filePath: string | null; fileName: string | null; selection: string | null; diagnostics: AttachedContext["diagnostics"] | null }
  | { type: "fileDiffContent"; filePath: string; before: string; after: string; label: string; error?: string }
  | { type: "filesExist"; results: Record<string, boolean> }
  | { type: "error"; message: string }
  | { type: "serverStatus"; status: "starting" | "ready" | "error"; url?: string; message?: string; binaryPath?: string; isManaged?: boolean; externalUrl?: string };

export type WebviewToExtension =
  | { type: "createSession"; model?: ModelSelection; title?: string }
  | { type: "openSession"; sessionId: string }
  | { type: "deleteSession"; sessionId: string }
  | { type: "renameSession"; sessionId: string; title: string }
  | { type: "sendMessage"; sessionId: string; text: string; context?: AttachedContext; options?: SendMessageOptions; attachments?: MessageAttachment[] }
  | { type: "editMessage"; sessionId: string; messageID: string; text: string; options?: SendMessageOptions; attachments?: MessageAttachment[] }
  | { type: "abortSession"; sessionId: string }
  | { type: "replyPermission"; sessionId: string; permissionId: string; decision: "once" | "always" | "reject" }
  | { type: "replyQuestion"; requestId: string; answers: string[][] }
  | { type: "rejectQuestion"; requestId: string }
  | { type: "selectModel"; model: ModelSelection }
  | { type: "selectAgent"; agent: string | null }
  | { type: "refreshAgents" }
  | { type: "openFileDiff"; filePath: string; edits: { oldStr: string; newStr: string }[]; isNewFile: boolean }
  | { type: "getFileDiffContent"; filePath: string; edits: { oldStr: string; newStr: string }[]; isNewFile: boolean }
  | { type: "checkFilesExist"; paths: string[] }
  | { type: "getContext" }
  | { type: "refreshSessions" }
  | { type: "refreshModels" }
  | { type: "getCommands" }
  | { type: "executeCommand"; sessionId: string; command: string; args: string }
  | { type: "compactSession"; sessionId: string; model: ModelSelection }
  | { type: "findFiles"; query: string; source: FileSearchSource }
  | { type: "copyText"; text: string }
  | { type: "refreshInspect" }
  | { type: "retryConnection" }
  | { type: "openVscodeSettings" };
