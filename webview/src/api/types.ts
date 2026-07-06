export type FileSearchSource = "mention" | "attach";

export interface ModelSelection {
  providerID: string;
  modelID: string;
  variant?: string;
}

export interface AgentInfo {
  name: string;
  description?: string;
  mode: "subagent" | "primary" | "all";
  builtIn: boolean;
  color?: string;
}

export interface ToolInfo {
  id: string;
  description?: string;
}

export interface CommandInfo {
  name: string;
  description?: string;
  agent?: string;
}

export interface SendMessageOptions {
  model?: ModelSelection;
  agent?: string;
  system?: string;
  tools?: { [key: string]: boolean };
}

export interface MessageAttachment {
  url: string;
  filename?: string;
  mime?: string;
}

export interface QuestionOption {
  label: string;
  description?: string;
}

export interface QuestionInfo {
  question: string;
  header: string;
  options: QuestionOption[];
  multiple?: boolean;
  custom?: boolean;
}

export interface QuestionRequest {
  id: string;
  sessionID: string;
  questions: QuestionInfo[];
  tool?: { messageID: string; callID: string };
}

export interface ProviderModelInfo {
  providerID: string;
  modelID: string;
  name: string;
  reasoning: boolean;
  attachment: boolean;
  toolCall: boolean;
  variants?: string[];
  cost?: { input: number; output: number };
  limit: { context: number; output: number };
}

export interface ProviderInfo {
  id: string;
  name: string;
  connected: boolean;
  models: ProviderModelInfo[];
}

export interface Range {
  start: { line: number; character: number };
  end: { line: number; character: number };
}

export interface FileDiff {
  file: string;
  before: string;
  after: string;
  additions: number;
  deletions: number;
}

export interface File {
  path: string;
  added: number;
  removed: number;
  status: "added" | "deleted" | "modified";
}

export interface UserMessage {
  id: string;
  sessionID: string;
  role: "user";
  time: { created: number };
  summary?: { title?: string; body?: string; diffs: FileDiff[] };
  agent: string;
  model: { providerID: string; modelID: string };
  system?: string;
  tools?: { [key: string]: boolean };
}

export interface AssistantMessage {
  id: string;
  sessionID: string;
  role: "assistant";
  time: { created: number; completed?: number };
  error?: { name: string; data: { message: string } };
  parentID: string;
  modelID: string;
  providerID: string;
  mode: string;
  path: { cwd: string; root: string };
  summary?: boolean;
  cost: number;
  tokens: {
    input: number;
    output: number;
    reasoning: number;
    cache: { read: number; write: number };
  };
  finish?: string;
}

export type Message = UserMessage | AssistantMessage;

export interface TextPart {
  id: string;
  sessionID: string;
  messageID: string;
  type: "text";
  text: string;
  synthetic?: boolean;
  ignored?: boolean;
  time?: { start: number; end?: number };
  metadata?: { [key: string]: unknown };
}

export interface ReasoningPart {
  id: string;
  sessionID: string;
  messageID: string;
  type: "reasoning";
  text: string;
  metadata?: { [key: string]: unknown };
  time: { start: number; end?: number };
}

export interface FilePartSource {
  text?: { value: string; start: number; end: number };
  type: "file" | "symbol";
  path: string;
  range?: Range;
  name?: string;
  kind?: number;
}

export interface FilePart {
  id: string;
  sessionID: string;
  messageID: string;
  type: "file";
  mime: string;
  filename?: string;
  url: string;
  source?: FilePartSource;
}

export interface ToolStatePending {
  status: "pending";
  input: { [key: string]: unknown };
  raw: string;
}
export interface ToolStateRunning {
  status: "running";
  input: { [key: string]: unknown };
  title?: string;
  metadata?: { [key: string]: unknown };
  time: { start: number };
}
export interface ToolStateCompleted {
  status: "completed";
  input: { [key: string]: unknown };
  output: string;
  title: string;
  metadata: { [key: string]: unknown };
  time: { start: number; end: number; compacted?: number };
}
export interface ToolStateError {
  status: "error";
  input: { [key: string]: unknown };
  error: string;
  metadata?: { [key: string]: unknown };
  time: { start: number; end: number };
}
export type ToolState = ToolStatePending | ToolStateRunning | ToolStateCompleted | ToolStateError;

export interface ToolPart {
  id: string;
  sessionID: string;
  messageID: string;
  type: "tool";
  callID: string;
  tool: string;
  state: ToolState;
  metadata?: { [key: string]: unknown };
}

export interface StepStartPart {
  id: string;
  sessionID: string;
  messageID: string;
  type: "step-start";
  snapshot?: string;
}

export interface StepFinishPart {
  id: string;
  sessionID: string;
  messageID: string;
  type: "step-finish";
  reason: string;
  snapshot?: string;
  cost: number;
  tokens: { input: number; output: number; reasoning: number; cache: { read: number; write: number } };
}

export interface SubtaskPart {
  id: string;
  sessionID: string;
  messageID: string;
  type: "subtask";
  prompt: string;
  description: string;
  agent: string;
}

export interface AgentPart {
  id: string;
  sessionID: string;
  messageID: string;
  type: "agent";
  name: string;
  source?: { value: string; start: number; end: number };
}

export interface RetryPart {
  id: string;
  sessionID: string;
  messageID: string;
  type: "retry";
  attempt: number;
  error: { name: string; data: { message: string } };
  time: { created: number };
}

export interface CompactionPart {
  id: string;
  sessionID: string;
  messageID: string;
  type: "compaction";
  auto: boolean;
}

export interface SnapshotPart {
  id: string;
  sessionID: string;
  messageID: string;
  type: "snapshot";
  snapshot: string;
}

export interface PatchPart {
  id: string;
  sessionID: string;
  messageID: string;
  type: "patch";
  hash: string;
  files: string[];
}

export type Part =
  | TextPart
  | ReasoningPart
  | FilePart
  | ToolPart
  | StepStartPart
  | StepFinishPart
  | SubtaskPart
  | AgentPart
  | RetryPart
  | CompactionPart
  | SnapshotPart
  | PatchPart;

export interface Permission {
  id: string;
  type: string;
  pattern?: string | string[];
  sessionID: string;
  messageID: string;
  callID?: string;
  title: string;
  metadata: { [key: string]: unknown };
  /** Suggested patterns that "Always allow" would permit (from the server). */
  always?: string[];
  time: { created: number };
}

// The engine accepts any tool name as a permission key (wildcard-matched), so
// this is a free string. The common 5 are offered as picker suggestions.
export type PermissionTool = string;
export type PermissionAction = "allow" | "ask" | "deny";

export interface PermissionRule {
  tool: PermissionTool;
  pattern: string;
  action: PermissionAction;
  source: "global" | "project";
}

/**
 * Engine permission block. Verified against the live v1.17.13 engine: any tool
 * name is accepted, and each value may be a flat action OR a granular
 * {pattern: action} object — for every tool, not just bash.
 */
export type PermissionConfig = Record<string, PermissionAction | Record<string, PermissionAction>>;

export interface PermissionRulesSnapshot {
  rules: PermissionRule[];
  // Parallel to rules: false = fully shadowed by a later rule (dead under
  // last-match-wins), rendered dimmed in the table.
  effective: boolean[];
  writeTarget: "global" | "project";
  projectFileExists: boolean;
  globalPath: string;
  projectPath: string;
}

export interface Session {
  id: string;
  projectID: string;
  directory: string;
  parentID?: string;
  summary?: { additions: number; deletions: number; files: number; diffs?: FileDiff[] };
  share?: { url: string };
  title: string;
  version: string;
  time: { created: number; updated: number; compacting?: number };
  revert?: { messageID: string; partID?: string; snapshot?: string; diff?: string };
}

export interface SessionWithMeta extends Session {
  cost?: number;
  tokens?: {
    input: number;
    output: number;
    reasoning: number;
    cache: { read: number; write: number };
  };
  model?: ModelSelection;
  agent?: string;
  slug?: string;
}

export interface MessageWithParts {
  info: Message;
  parts: Part[];
}

export interface SessionStatusInfo {
  type: "idle" | "busy" | "retry";
  attempt?: number;
  message?: string;
}

export interface SkillInfo {
  name: string;
  description?: string;
  location?: string;
}

export interface Todo {
  id: string;
  content: string;
  status: string;
  priority: string;
}

export interface McpServerStatus {
  status: string;
  error?: string;
}

export interface LspStatusInfo {
  id: string;
  name: string;
  root: string;
  status: "connected" | "error";
}

export interface ProjectConfig {
  model?: string;
  smallModel?: string;
  mode?: string;
  username?: string;
  agents?: Array<{ name: string; description?: string; mode: string; builtIn: boolean }>;
  skills?: Array<{ name: string; description?: string }>;
  permission?: PermissionConfig;
}

export interface AttachedContext {
  filePath?: string;
  fileName?: string;
  selection?: string;
  selectionRange?: { startLine: number; endLine: number };
  diagnostics?: Array<{ severity: string; message: string; line: number; source?: string }>;
}

export type ExtensionToWebview =
  | { type: "state"; sessions: SessionWithMeta[]; activeSessionId: string | null }
  | { type: "messages"; sessionId: string; messages: MessageWithParts[] }
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
  | { type: "skills"; skills: SkillInfo[] }
  | { type: "todos"; sessionId: string; todos: Todo[] }
  | { type: "mcpStatus"; servers: Record<string, McpServerStatus> }
  | { type: "lspStatus"; servers: LspStatusInfo[] }
  | { type: "config"; config: ProjectConfig }
  | { type: "permissionRules"; snapshot: PermissionRulesSnapshot }
  | { type: "stats"; totalCost: number; totalTokens: { input: number; output: number; reasoning: number } }
  | { type: "context"; filePath: string | null; fileName: string | null; selection: string | null; diagnostics: AttachedContext["diagnostics"] | null }
  | { type: "fileDiffContent"; filePath: string; before: string; after: string; label: string; error?: string }
  | { type: "filesExist"; results: Record<string, boolean> }
  | { type: "permissionNotice"; kind: "externalChange"; message: string }
  | { type: "clearPermissionNotice" }
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
  | { type: "openVscodeSettings" }
  | { type: "getPermissionRules" }
  | { type: "savePermissionRule"; rule: PermissionRule }
  | { type: "removePermissionRule"; tool: PermissionTool; pattern: string; source: "global" | "project" }
  | { type: "reloadServer"; force?: boolean };
