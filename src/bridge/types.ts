import type { Session, Message, Part, Permission, FileDiff, File } from "@opencode-ai/sdk";

export type { Session, Message, Part, Permission, FileDiff, File };

export interface ProviderModelInfo {
  providerID: string;
  modelID: string;
  name: string;
  reasoning: boolean;
  attachment: boolean;
  toolCall: boolean;
  variants?: string[];
  cost?: {
    input: number;
    output: number;
  };
  limit: {
    context: number;
    output: number;
  };
}

export interface ProviderInfo {
  id: string;
  name: string;
  connected: boolean;
  models: ProviderModelInfo[];
}

export interface ModelSelection {
  providerID: string;
  modelID: string;
  variant?: string;
}

export interface MessageWithParts {
  info: Message;
  parts: Part[];
}

export interface SessionWithMeta extends Session {
  cost?: number;
  tokens?: {
    input: number;
    output: number;
    reasoning: number;
    cache: {
      read: number;
      write: number;
    };
  };
  model?: ModelSelection;
  agent?: string;
  slug?: string;
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
  agents?: Array<{
    name: string;
    description?: string;
    mode: string;
    builtIn: boolean;
  }>;
  skills?: Array<{ name: string; description?: string }>;
  permission?: PermissionConfig;
}

/**
 * Engine permission block. Verified against the live v1.17.13 engine: the
 * evaluate() matcher accepts ANY tool name (it matches tool names via the same
 * wildcard matcher it uses for patterns), and each tool value may be either a
 * flat action string OR a granular {pattern: action} object — for every tool,
 * not just bash. Configs in the wild use e.g. edit:{"*.md":"allow"} and
 * grep:"allow". The SDK's static 5-key type is a subset; we model the full
 * runtime shape.
 */
export type PermissionConfig = Record<string, PermissionAction | Record<string, PermissionAction>>;
export type PermissionAction = "allow" | "ask" | "deny";

export interface AttachedContext {
  filePath?: string;
  fileName?: string;
  selection?: string;
  selectionRange?: { startLine: number; endLine: number };
  diagnostics?: Array<{
    severity: string;
    message: string;
    line: number;
    source?: string;
  }>;
}

export interface SessionStatusInfo {
  type: "idle" | "busy" | "retry";
  attempt?: number;
  message?: string;
}

export interface DiffInfo {
  sessionId: string;
  files: File[];
  diffs: FileDiff[];
}

export interface AgentInfo {
  name: string;
  description?: string;
  mode: "subagent" | "primary" | "all";
  builtIn: boolean;
  color?: string;
}

export interface CommandInfo {
  name: string;
  description?: string;
  agent?: string;
}

export interface ToolInfo {
  id: string;
  description?: string;
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
  /** Allow a free-form typed answer (defaults to true when omitted). */
  custom?: boolean;
}

export interface QuestionRequest {
  id: string;
  sessionID: string;
  questions: QuestionInfo[];
  tool?: { messageID: string; callID: string };
}
