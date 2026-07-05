import {
  createOpencodeClient,
  type OpencodeClient as SdkClient,
  type Session,
  type Message,
  type Part,
  type SessionStatus,
  type Agent,
  type TextPartInput,
  type FilePartInput,
} from "@opencode-ai/sdk";
import type { ServerInfo } from "./serverManager";
import type {
  AgentInfo,
  SendMessageOptions,
  ToolInfo,
  SkillInfo,
  Todo,
  McpServerStatus,
  LspStatusInfo,
  QuestionRequest,
} from "./types";

export interface FileAttachment {
  type: "file";
  url: string;
  mime: string;
  filename?: string;
}

export class OpenCodeClientError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
  ) {
    super(message);
    this.name = "OpenCodeClientError";
  }
}

export class OpenCodeClient {
  private sdk: SdkClient;
  private readonly workdir: string;
  private baseUrl: string;
  private authHeader: string;

  constructor(serverInfo: ServerInfo, workdir: string) {
    this.workdir = workdir;
    this.baseUrl = serverInfo.url;
    this.authHeader = serverInfo.authHeader;
    this.sdk = this.createSdk(serverInfo);
  }

  /**
   * Swap the underlying server connection. All services that hold a reference
   * to this client instance automatically pick up the new URL/auth — no need
   * to recreate the services themselves. Call this after respawning a managed
   * server (new port + password) so requests and SSE land on the live process.
   */
  updateServer(serverInfo: ServerInfo): void {
    this.baseUrl = serverInfo.url;
    this.authHeader = serverInfo.authHeader;
    this.sdk = this.createSdk(serverInfo);
  }

  private createSdk(serverInfo: ServerInfo): SdkClient {
    return createOpencodeClient({
      baseUrl: serverInfo.url,
      headers: { Authorization: serverInfo.authHeader },
      directory: this.workdir,
    } as Record<string, unknown>);
  }

  get url(): string {
    return this.baseUrl;
  }

  get workdirPath(): string {
    return this.workdir;
  }

  async listSessions(): Promise<Session[]> {
    const res = await this.sdk.session.list();
    if (res.error) throw toError(res.error);
    return (res.data ?? []) as Session[];
  }

  async createSession(title?: string): Promise<Session> {
    const res = await this.sdk.session.create({
      body: title ? { title } : undefined,
    });
    if (res.error) throw toError(res.error);
    if (!res.data) throw new OpenCodeClientError("createSession returned no data");
    return res.data as Session;
  }

  async renameSession(sessionId: string, title: string): Promise<Session> {
    const res = await this.sdk.session.update({
      path: { id: sessionId },
      body: { title },
    });
    if (res.error) throw toError(res.error);
    if (!res.data) throw new OpenCodeClientError("renameSession returned no data");
    return res.data as Session;
  }

  async listAgents(): Promise<AgentInfo[]> {
    const res = await this.sdk.app.agents();
    if (res.error) throw toError(res.error);
    const data = (res.data ?? []) as Agent[];
    return data.map((a) => ({
      name: a.name,
      description: a.description,
      mode: a.mode,
      builtIn: a.builtIn,
      color: a.color,
    }));
  }

  async listToolIds(): Promise<ToolInfo[]> {
    const res = await this.sdk.tool.ids();
    if (res.error) throw toError(res.error);
    const ids = (res.data ?? []) as string[];
    return ids.map((id) => ({ id }));
  }

  async getMessages(
    sessionId: string,
  ): Promise<Array<{ info: Message; parts: Part[] }>> {
    const res = await this.sdk.session.messages({
      path: { id: sessionId },
    });
    if (res.error) throw toError(res.error);
    return (res.data ?? []) as Array<{ info: Message; parts: Part[] }>;
  }

  async sendMessage(
    sessionId: string,
    text: string,
    options?: SendMessageOptions,
    attachments?: FileAttachment[],
  ): Promise<void> {
    const parts: Array<TextPartInput | FilePartInput> = [
      { type: "text", text },
    ];
    if (attachments) {
      for (const a of attachments) {
        parts.push({
          type: "file",
          url: a.url,
          mime: a.mime,
          filename: a.filename,
        });
      }
    }
    const body: Record<string, unknown> = { parts };
    if (options?.model) body.model = options.model;
    if (options?.agent) body.agent = options.agent;
    if (options?.system) body.system = options.system;
    if (options?.tools && Object.keys(options.tools).length > 0) body.tools = options.tools;
    const res = await this.sdk.session.promptAsync({
      path: { id: sessionId },
      body: body as never,
    });
    if (res.error) throw toError(res.error);
  }

  async abortSession(sessionId: string): Promise<void> {
    const res = await this.sdk.session.abort({
      path: { id: sessionId },
    });
    if (res.error) throw toError(res.error);
  }

  async deleteSession(sessionId: string): Promise<void> {
    const res = await this.sdk.session.delete({
      path: { id: sessionId },
    });
    if (res.error) throw toError(res.error);
  }

  async revertMessage(sessionId: string, messageID: string): Promise<void> {
    // sdk.session.revert removes the given message and everything after it
    // AND reverts file changes made in those messages (snapshot-based). This
    // is the server-side primitive behind opencode's `/undo`. Returns the
    // updated Session; we only need the side effect.
    const res = await this.sdk.session.revert({
      path: { id: sessionId },
      query: { directory: this.workdir },
      body: { messageID },
    } as never);
    if (res.error) throw toError(res.error);
  }

  async replyPermission(
    sessionId: string,
    permissionId: string,
    response: "once" | "always" | "reject",
  ): Promise<void> {
    const res = await this.sdk.postSessionIdPermissionsPermissionId({
      path: { id: sessionId, permissionID: permissionId },
      body: { response },
    });
    if (res.error) throw toError(res.error);
  }

  async listCommands(): Promise<Array<{ name: string; description?: string; agent?: string }>> {
    // "compact" is a real opencode action (runs session.summarize). We surface
    // it as a known slash command; the composer routes /compact to the
    // summarize endpoint instead of the (unrelated) session.command path.
    const builtIns: Array<{ name: string; description?: string }> = [
      { name: "compact", description: "Summarize the conversation to save context" },
    ];
    let data: Array<{ name: string; description?: string; agent?: string }> = [];
    try {
      const res = await this.sdk.command.list({ query: { directory: this.workdir } });
      if (res.error) throw toError(res.error);
      data = (res.data ?? []) as Array<{ name: string; description?: string; agent?: string }>;
    } catch (err) {
      void err;
    }
    const existing = new Set(data.map((c) => c.name));
    const prepend = builtIns.filter((c) => !existing.has(c.name));
    return [...prepend, ...data];
  }

  async executeSessionCommand(sessionId: string, command: string, args: string): Promise<void> {
    const res = await this.sdk.session.command({
      path: { id: sessionId },
      query: { directory: this.workdir },
      body: { command, arguments: args },
    });
    if (res.error) throw toError(res.error);
  }

  async summarize(sessionId: string, providerID: string, modelID: string): Promise<void> {
    // /compact in opencode is the summarize endpoint (see TUI: sdk.session.summarize),
    // not session.command. It runs the given model over the session to produce a
    // compaction summary; the server then truncates the old tail.
    const res = await this.sdk.session.summarize({
      path: { id: sessionId },
      query: { directory: this.workdir },
      body: { providerID, modelID },
    });
    if (res.error) throw toError(res.error);
  }

  async findFiles(query: string): Promise<string[]> {
    const res = await this.sdk.find.files({
      query: { query, directory: this.workdir, dirs: "false" },
    });
    if (res.error) throw toError(res.error);
    return (res.data ?? []) as string[];
  }

  async listSkills(): Promise<SkillInfo[]> {
    // The v1 SDK does not type the /skill endpoint, so call it directly.
    const url = new URL("/skill", this.baseUrl);
    url.searchParams.set("directory", this.workdir);
    const resp = await fetch(url.toString(), {
      headers: { Authorization: this.authHeader },
    });
    if (!resp.ok) {
      throw new OpenCodeClientError(`listSkills failed: HTTP ${resp.status}`, resp.status);
    }
    const data = (await resp.json()) as Array<{
      name?: string;
      description?: string;
      location?: string;
    }>;
    if (!Array.isArray(data)) return [];
    return data.map((s) => ({
      name: typeof s.name === "string" ? s.name : "unknown",
      description: typeof s.description === "string" ? s.description : undefined,
      location: typeof s.location === "string" ? s.location : undefined,
    }));
  }

  async getProviders(): Promise<{
    all: Array<{
      id: string;
      name: string;
      models: Record<string, Record<string, unknown>>;
    }>;
    default: Record<string, string>;
    connected: string[];
  }> {
    const res = await this.sdk.provider.list();
    if (res.error) throw toError(res.error);
    if (!res.data) {
      return { all: [], default: {}, connected: [] };
    }
    const data = res.data as {
      all?: Array<{
        id: string;
        name: string;
        models: Record<string, Record<string, unknown>>;
      }>;
      default?: Record<string, string>;
      connected?: string[];
    };
    return {
      all: Array.isArray(data.all) ? data.all : [],
      default: data.default ?? {},
      connected: Array.isArray(data.connected) ? data.connected : [],
    };
  }

  async getConfig(): Promise<Record<string, unknown>> {
    const res = await this.sdk.config.get();
    if (res.error) throw toError(res.error);
    return (res.data ?? {}) as Record<string, unknown>;
  }

  async getSessionStatus(): Promise<Record<string, SessionStatus>> {
    const res = await this.sdk.session.status();
    if (res.error) throw toError(res.error);
    return (res.data ?? {}) as Record<string, SessionStatus>;
  }

  async getSessionTodos(sessionId: string): Promise<Todo[]> {
    const res = await this.sdk.session.todo({
      path: { id: sessionId },
      query: { directory: this.workdir },
    });
    if (res.error) throw toError(res.error);
    return (res.data ?? []) as Todo[];
  }

  async getMcpStatus(): Promise<Record<string, McpServerStatus>> {
    const res = await this.sdk.mcp.status();
    if (res.error) throw toError(res.error);
    const data = (res.data ?? {}) as Record<string, { status: string; error?: string }>;
    const result: Record<string, McpServerStatus> = {};
    for (const [name, value] of Object.entries(data)) {
      result[name] = {
        status: typeof value.status === "string" ? value.status : "unknown",
        error: typeof value.error === "string" ? value.error : undefined,
      };
    }
    return result;
  }

  async listQuestions(): Promise<QuestionRequest[]> {
    // The v1 SDK has no /question typings; call it directly. Returns pending
    // question requests across all sessions (the question tool blocks on these).
    const url = new URL("/question", this.baseUrl);
    url.searchParams.set("directory", this.workdir);
    const resp = await fetch(url.toString(), {
      headers: { Authorization: this.authHeader },
    });
    if (!resp.ok) {
      throw new OpenCodeClientError(`listQuestions failed: HTTP ${resp.status}`, resp.status);
    }
    const data = (await resp.json()) as unknown;
    if (!Array.isArray(data)) return [];
    return data.map(normalizeQuestion);
  }

  async replyQuestion(requestId: string, answers: string[][]): Promise<void> {
    const url = new URL(`/question/${encodeURIComponent(requestId)}/reply`, this.baseUrl);
    url.searchParams.set("directory", this.workdir);
    const resp = await fetch(url.toString(), {
      method: "POST",
      headers: { Authorization: this.authHeader, "Content-Type": "application/json" },
      body: JSON.stringify({ answers }),
    });
    if (!resp.ok) {
      throw new OpenCodeClientError(`replyQuestion failed: HTTP ${resp.status}`, resp.status);
    }
  }

  async rejectQuestion(requestId: string): Promise<void> {
    const url = new URL(`/question/${encodeURIComponent(requestId)}/reject`, this.baseUrl);
    url.searchParams.set("directory", this.workdir);
    const resp = await fetch(url.toString(), {
      method: "POST",
      headers: { Authorization: this.authHeader },
    });
    if (!resp.ok) {
      throw new OpenCodeClientError(`rejectQuestion failed: HTTP ${resp.status}`, resp.status);
    }
  }

  async getLspStatus(): Promise<LspStatusInfo[]> {
    const res = await this.sdk.lsp.status();
    if (res.error) throw toError(res.error);
    const data = (res.data ?? []) as Array<{
      id?: string;
      name?: string;
      root?: string;
      status?: string;
    }>;
    if (!Array.isArray(data)) return [];
    return data.map((s) => ({
      id: typeof s.id === "string" ? s.id : "",
      name: typeof s.name === "string" ? s.name : "unknown",
      root: typeof s.root === "string" ? s.root : "",
      status: s.status === "connected" ? "connected" : "error",
    }));
  }

  subscribeEvents(
    signal?: AbortSignal,
  ): AsyncGenerator<{ type: string; properties: Record<string, unknown> }> {
    return this.subscribeSSE(signal);
  }

  private async *subscribeSSE(
    signal?: AbortSignal,
  ): AsyncGenerator<{ type: string; properties: Record<string, unknown> }> {
    let result: Awaited<ReturnType<typeof this.sdk.event.subscribe>>;
    try {
      result = await this.sdk.event.subscribe({
        ...(signal ? { signal } : {}),
      } as Record<string, unknown>);
    } catch (err) {
      if (signal?.aborted) return;
      throw err;
    }
    if (!result || !result.stream) return;
    for await (const event of result.stream) {
      const e = event as unknown as {
        type: string;
        properties: Record<string, unknown>;
      };
      if (e && e.type) {
        yield e;
      }
    }
  }
}

function toError(err: unknown): OpenCodeClientError {
  if (typeof err === "object" && err !== null) {
    const e = err as { message?: string; name?: string };
    if (e.message) return new OpenCodeClientError(e.message);
    if (e.name) return new OpenCodeClientError(e.name);
  }
  return new OpenCodeClientError(String(err));
}

function normalizeQuestion(raw: unknown): QuestionRequest {
  const r = (raw ?? {}) as Record<string, unknown>;
  const id = typeof r.id === "string" ? r.id : "";
  const sessionID = typeof r.sessionID === "string" ? r.sessionID : "";
  const rawQuestions = Array.isArray(r.questions) ? r.questions : [];
  const questions = rawQuestions.map((q) => {
    const qo = (q ?? {}) as Record<string, unknown>;
    const rawOptions = Array.isArray(qo.options) ? qo.options : [];
    return {
      question: typeof qo.question === "string" ? qo.question : "",
      header: typeof qo.header === "string" ? qo.header : "",
      multiple: typeof qo.multiple === "boolean" ? qo.multiple : undefined,
      custom: typeof qo.custom === "boolean" ? qo.custom : undefined,
      options: rawOptions.map((o) => {
        const oo = (o ?? {}) as Record<string, unknown>;
        return {
          label: typeof oo.label === "string" ? oo.label : "",
          description: typeof oo.description === "string" ? oo.description : undefined,
        };
      }),
    };
  });
  const toolRaw = r.tool as { messageID?: string; callID?: string } | undefined;
  const tool =
    toolRaw && typeof toolRaw.messageID === "string" && typeof toolRaw.callID === "string"
      ? { messageID: toolRaw.messageID, callID: toolRaw.callID }
      : undefined;
  return { id, sessionID, questions, tool };
}
