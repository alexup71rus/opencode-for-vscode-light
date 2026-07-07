import { EventEmitter } from "events";
import type { Session, Message, Part, Permission, SessionStatus } from "@opencode-ai/sdk";
import { OpenCodeClientError } from "../bridge/errors";
import type { OpenCodeClient } from "../bridge/openCodeClient";
import type { EventStream } from "../bridge/eventStream";
import type {
  SessionWithMeta,
  MessageWithParts,
  ModelSelection,
  AttachedContext,
  SessionStatusInfo,
  SendMessageOptions,
  MessageAttachment,
  Todo,
  QuestionRequest,
} from "../bridge/types";

interface FileAttachment {
  type: "file";
  url: string;
  mime: string;
  filename?: string;
}

export class SessionService extends EventEmitter {
  private readonly client: OpenCodeClient;
  private readonly eventStream: EventStream;

  private sessions: SessionWithMeta[] = [];
  private activeSessionId: string | null = null;
  private readonly messagesBySession = new Map<string, MessageWithParts[]>();
  private readonly permissionsBySession = new Map<string, Permission[]>();
  private readonly statusBySession = new Map<string, SessionStatusInfo>();
  private readonly todosBySession = new Map<string, Todo[]>();
  private readonly questions = new Map<string, QuestionRequest>();
  private questionTimer: ReturnType<typeof setInterval> | null = null;
  private openSessionToken = 0;
  private readonly aborting = new Set<string>();

  constructor(client: OpenCodeClient, eventStream: EventStream) {
    super();
    this.client = client;
    this.eventStream = eventStream;
  }

  getSessions(): SessionWithMeta[] {
    return this.sessions;
  }

  getActiveSessionId(): string | null {
    return this.activeSessionId;
  }

  getMessages(sessionId: string): MessageWithParts[] {
    return this.messagesBySession.get(sessionId) ?? [];
  }

  getPendingPermissions(sessionId: string): Permission[] {
    return this.permissionsBySession.get(sessionId) ?? [];
  }

  getStatus(sessionId: string): SessionStatusInfo {
    return this.statusBySession.get(sessionId) ?? { type: "idle" };
  }

  /** True if any session is currently generating (busy/retry). Used to guard
   *  disruptive actions — e.g. restarting the server — that would interrupt
   *  an in-flight run. */
  isAnySessionBusy(): boolean {
    for (const s of this.statusBySession.values()) {
      if (s.type === "busy" || s.type === "retry") return true;
    }
    return false;
  }

  getTodos(sessionId: string): Todo[] {
    return this.todosBySession.get(sessionId) ?? [];
  }

  /**
   * Pending question-tool requests scoped to a single session. Used to
   * rebuild the active session snapshot when the webview panel is
   * recreated (the live questionAdded events only fire once per request,
   * so a fresh panel would otherwise miss already-pending questions).
   */
  getQuestionsForSession(sessionId: string): QuestionRequest[] {
    const out: QuestionRequest[] = [];
    for (const q of this.questions.values()) {
      if (q.sessionID === sessionId) out.push(q);
    }
    return out;
  }

  async fetchTodos(sessionId: string): Promise<Todo[]> {
    const todos = await this.client.getSessionTodos(sessionId);
    this.todosBySession.set(sessionId, todos);
    this.emit("todosChanged", { sessionId, todos });
    return todos;
  }

  async start(): Promise<void> {
    await this.refreshSessions();
    this.subscribe();
    // The question tool blocks until the user answers. The v1 SSE stream does
    // not reliably carry question events, so poll GET /question while any
    // session is busy and diff the list to surface/clear pending requests.
    void this.pollQuestions();
    this.questionTimer = setInterval(() => {
      void this.pollQuestions();
    }, 1500);
  }

  stop(): void {
    this.unsubscribe();
    if (this.questionTimer) {
      clearInterval(this.questionTimer);
      this.questionTimer = null;
    }
  }

  async refreshSessions(): Promise<void> {
    const [sessions, statusMap] = await Promise.all([
      this.client.listSessions(),
      this.client.getSessionStatus().catch(() => ({}) as Record<string, SessionStatus>),
    ]);
    this.sessions = sessions as SessionWithMeta[];
    this.statusBySession.clear();
    for (const [id, status] of Object.entries(statusMap)) {
      this.statusBySession.set(id, this.toStatusInfo(status));
    }
    if (this.activeSessionId && !this.sessions.some((s) => s.id === this.activeSessionId)) {
      this.activeSessionId = null;
    }
    this.emit("sessionsChanged");
  }

  async createSession(title?: string, model?: ModelSelection): Promise<string> {
    const session = await this.client.createSession(title);
    const meta = session as SessionWithMeta;
    this.sessions = [meta, ...this.sessions.filter((s) => s.id !== meta.id)];
    this.messagesBySession.set(meta.id, []);
    this.permissionsBySession.set(meta.id, []);
    this.activeSessionId = meta.id;
    if (model) meta.model = model;
    this.emit("sessionsChanged");
    const messages = this.messagesBySession.get(meta.id) ?? [];
    this.emit("messagesChanged", meta.id);
    return meta.id;
  }

  async openSession(sessionId: string): Promise<void> {
    this.activeSessionId = sessionId;
    const openToken = ++this.openSessionToken;
    const messages = await this.client.getMessages(sessionId);
    if (openToken !== this.openSessionToken) return;
    if (this.activeSessionId !== sessionId) return;
    this.messagesBySession.set(sessionId, messages);
    this.emit("sessionsChanged");
    this.emit("messagesChanged", sessionId);
    void this.fetchTodos(sessionId).catch(() => undefined);
  }

  async renameSession(sessionId: string, title: string): Promise<void> {
    const updated = await this.client.renameSession(sessionId, title);
    const meta = updated as SessionWithMeta;
    const idx = this.sessions.findIndex((s) => s.id === meta.id);
    if (idx >= 0) {
      this.sessions[idx] = { ...this.sessions[idx], ...meta };
    } else {
      this.sessions = [meta, ...this.sessions];
    }
    this.emit("sessionsChanged");
  }

  async sendMessage(
    sessionId: string,
    text: string,
    context?: AttachedContext,
    options?: SendMessageOptions,
    attachments?: MessageAttachment[],
  ): Promise<void> {
    const merged = this.mergeAttachments(this.contextToAttachments(context), attachments);
    await this.client.sendMessage(sessionId, text, options, merged);
  }

  private mergeAttachments(
    a: FileAttachment[] | undefined,
    b: MessageAttachment[] | undefined,
  ): FileAttachment[] | undefined {
    const list: FileAttachment[] = [];
    if (a) for (const item of a) list.push(item);
    if (b) {
      for (const item of b) {
        list.push({
          type: "file",
          url: item.url,
          mime: item.mime ?? "text/plain",
          filename: item.filename ?? item.url.split(/[\\/]/).pop(),
        });
      }
    }
    return list.length > 0 ? list : undefined;
  }

  async abortSession(sessionId: string): Promise<void> {
    this.aborting.add(sessionId);
    try {
      await this.client.abortSession(sessionId);
    } finally {
      setTimeout(() => this.aborting.delete(sessionId), 5_000);
    }
  }

  async editMessage(
    sessionId: string,
    messageID: string,
    text: string,
    options?: SendMessageOptions,
    attachments?: MessageAttachment[],
  ): Promise<void> {
    // ChatGPT-style "edit & resend": truncate the conversation at messageID
    // (removing it and everything after, reverting file changes) then send the
    // edited text as a fresh turn. Implemented as revert + promptAsync.
    // Server's revert rejects with SessionBusyError if the session is active,
    // so abort first and wait for idle.
    const status = this.statusBySession.get(sessionId);
    if (status?.type === "busy" || status?.type === "retry") {
      await this.client.abortSession(sessionId);
      await this.waitForIdle(sessionId, 5000);
    }
    await this.client.revertMessage(sessionId, messageID);
    const merged = this.mergeAttachments(undefined, attachments);
    await this.client.sendMessage(sessionId, text, options, merged);
  }

  private waitForIdle(sessionId: string, timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        this.off("sessionStatus", handler);
        clearTimeout(timer);
        resolve();
      };
      const handler = (payload: { sessionId: string; status: SessionStatusInfo }) => {
        if (payload.sessionId === sessionId && payload.status.type === "idle") {
          done();
        }
      };
      const timer = setTimeout(done, timeoutMs);
      this.on("sessionStatus", handler);
    });
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.client.deleteSession(sessionId);
    this.removeSessionState(sessionId);
    this.emit("sessionsChanged");
  }

  /**
   * Reply to a permission and reconcile the authoritative map.
   *
   * On success we drop the entry immediately rather than waiting for the
   * server's `permission.replied` SSE event, which is unreliable across engine
   * versions (see webviewPanel). Leaving answered permissions in the map is the
   * root of the phantom-confirm bug: a later `pushInitialState` (triggered by a
   * tab switch / panel revisit) would re-send them as if still pending.
   *
   * A 400/404 means the server no longer knows this permission — already
   * answered, reverted, or a phantom that re-surfaced after a reconnect. That
   * is not actionable, so we treat it the same as success: drop it and signal
   * the card cleared. Transient failures (network, 5xx) are rethrown with the
   * entry left intact so the user can retry.
   */
  async replyPermission(
    sessionId: string,
    permissionId: string,
    decision: "once" | "always" | "reject",
  ): Promise<void> {
    try {
      await this.client.replyPermission(sessionId, permissionId, decision);
    } catch (err) {
      const status = err instanceof OpenCodeClientError ? err.statusCode : undefined;
      const stale = status === 400 || status === 404;
      if (!stale) throw err;
    }
    this.clearPermission(sessionId, permissionId);
  }

  /** Remove a permission from the authoritative map and notify listeners. Safe
   *  to call for an id that is no longer present (no-op + no event). */
  private clearPermission(sessionId: string, permissionId: string): void {
    const list = this.permissionsBySession.get(sessionId);
    if (!list) return;
    const next = list.filter((p) => p.id !== permissionId);
    if (next.length === list.length) return;
    this.permissionsBySession.set(sessionId, next);
    this.emit("permissionReplied", { sessionId, permissionID: permissionId });
  }

  async replyQuestion(requestId: string, answers: string[][]): Promise<void> {
    const existing = this.questions.get(requestId);
    await this.client.replyQuestion(requestId, answers);
    if (existing && this.questions.delete(requestId)) {
      this.emit("questionRemoved", { sessionId: existing.sessionID, requestId });
    }
  }

  async rejectQuestion(requestId: string): Promise<void> {
    const existing = this.questions.get(requestId);
    await this.client.rejectQuestion(requestId);
    if (existing && this.questions.delete(requestId)) {
      this.emit("questionRemoved", { sessionId: existing.sessionID, requestId });
    }
  }

  private readonly pollQuestions = async (): Promise<void> => {
    const anyBusy = [...this.statusBySession.values()].some((s) => s.type === "busy");
    if (!anyBusy && this.questions.size === 0) return;
    let list: QuestionRequest[];
    try {
      list = await this.client.listQuestions();
    } catch {
      return;
    }
    const nextIds = new Set(list.map((q) => q.id));
    for (const q of list) {
      if (!this.questions.has(q.id)) {
        this.questions.set(q.id, q);
        this.emit("questionAdded", { sessionId: q.sessionID, question: q });
      } else {
        this.questions.set(q.id, q);
      }
    }
    for (const [id, q] of this.questions) {
      if (!nextIds.has(id)) {
        this.questions.delete(id);
        this.emit("questionRemoved", { sessionId: q.sessionID, requestId: id });
      }
    }
  };

  private removeSessionState(sessionId: string): void {
    this.sessions = this.sessions.filter((s) => s.id !== sessionId);
    this.messagesBySession.delete(sessionId);
    this.permissionsBySession.delete(sessionId);
    this.statusBySession.delete(sessionId);
    this.todosBySession.delete(sessionId);
    for (const [id, q] of this.questions) {
      if (q.sessionID === sessionId) {
        this.questions.delete(id);
        this.emit("questionRemoved", { sessionId, requestId: id });
      }
    }
    if (this.activeSessionId === sessionId) {
      this.activeSessionId = null;
    }
  }

  private upsertSession(meta: SessionWithMeta): void {
    const idx = this.sessions.findIndex((s) => s.id === meta.id);
    if (idx >= 0) this.sessions[idx] = meta;
    else this.sessions = [meta, ...this.sessions];
  }

  private contextToAttachments(context?: AttachedContext): FileAttachment[] | undefined {
    if (!context?.filePath) return undefined;
    return [
      {
        type: "file",
        url: context.filePath,
        mime: "text/plain",
        filename: context.fileName,
      },
    ];
  }

  private toStatusInfo(status: SessionStatus): SessionStatusInfo {
    switch (status.type) {
      case "busy":
        return { type: "busy" };
      case "retry":
        return { type: "retry", attempt: status.attempt, message: status.message };
      case "idle":
      default:
        return { type: "idle" };
    }
  }

  private subscribe(): void {
    this.eventStream.on("session.created", this.handleSessionCreated);
    this.eventStream.on("session.updated", this.handleSessionUpdated);
    this.eventStream.on("session.deleted", this.handleSessionDeleted);
    this.eventStream.on("session.status", this.handleSessionStatus);
    this.eventStream.on("session.idle", this.handleSessionIdle);
    this.eventStream.on("session.error", this.handleSessionError);
    this.eventStream.on("message.updated", this.handleMessageUpdated);
    this.eventStream.on("message.removed", this.handleMessageRemoved);
    this.eventStream.on("message.part.updated", this.handleMessagePartUpdated);
    this.eventStream.on("message.part.delta", this.handleMessagePartDelta);
    this.eventStream.on("message.part.removed", this.handleMessagePartRemoved);
    this.eventStream.on("permission.updated", this.handlePermissionUpdated);
    this.eventStream.on("permission.asked", this.handlePermissionAsked);
    this.eventStream.on("permission.replied", this.handlePermissionReplied);
    this.eventStream.on("todo.updated", this.handleTodoUpdated);
    this.eventStream.on("server.connected", this.handleServerConnected);
  }

  private unsubscribe(): void {
    this.eventStream.off("session.created", this.handleSessionCreated);
    this.eventStream.off("session.updated", this.handleSessionUpdated);
    this.eventStream.off("session.deleted", this.handleSessionDeleted);
    this.eventStream.off("session.status", this.handleSessionStatus);
    this.eventStream.off("session.idle", this.handleSessionIdle);
    this.eventStream.off("session.error", this.handleSessionError);
    this.eventStream.off("message.updated", this.handleMessageUpdated);
    this.eventStream.off("message.removed", this.handleMessageRemoved);
    this.eventStream.off("message.part.updated", this.handleMessagePartUpdated);
    this.eventStream.off("message.part.delta", this.handleMessagePartDelta);
    this.eventStream.off("message.part.removed", this.handleMessagePartRemoved);
    this.eventStream.off("permission.updated", this.handlePermissionUpdated);
    this.eventStream.off("permission.asked", this.handlePermissionAsked);
    this.eventStream.off("permission.replied", this.handlePermissionReplied);
    this.eventStream.off("todo.updated", this.handleTodoUpdated);
    this.eventStream.off("server.connected", this.handleServerConnected);
  }

  private handleSessionCreated = (payload: { info: Session }): void => {
    this.upsertSession(payload.info as SessionWithMeta);
    this.emit("sessionsChanged");
  };

  private handleSessionUpdated = (payload: { info: Session }): void => {
    this.upsertSession(payload.info as SessionWithMeta);
    this.emit("sessionsChanged");
  };

  private handleSessionDeleted = (payload: { info: Session }): void => {
    this.removeSessionState(payload.info.id);
    this.emit("sessionsChanged");
  };

  private handleSessionStatus = (payload: { sessionID: string; status: SessionStatus }): void => {
    const status = this.toStatusInfo(payload.status);
    this.statusBySession.set(payload.sessionID, status);
    this.emit("sessionStatus", { sessionId: payload.sessionID, status });
  };

  private handleSessionIdle = (payload: { sessionID: string }): void => {
    const status: SessionStatusInfo = { type: "idle" };
    this.statusBySession.set(payload.sessionID, status);
    this.emit("sessionStatus", { sessionId: payload.sessionID, status });
  };

  private handleSessionError = (payload: { sessionID?: string; error?: unknown }): void => {
    if (!payload.sessionID) return;
    const sessionId = payload.sessionID;
    this.statusBySession.set(sessionId, { type: "idle" });
    this.emit("sessionStatus", { sessionId, status: { type: "idle" } });
    if (this.aborting.delete(sessionId)) return;
    this.emit("sessionError", { sessionId, error: payload.error });
  };

  private handleMessageUpdated = (payload: { info: Message }): void => {
    const info = payload.info;
    const sessionId = info.sessionID;
    if (!sessionId) return;
    let list = this.messagesBySession.get(sessionId);
    if (!list) {
      list = [];
      this.messagesBySession.set(sessionId, list);
    }
    const idx = list.findIndex((m) => m.info.id === info.id);
    const entry: MessageWithParts = { info, parts: idx >= 0 ? list[idx].parts : [] };
    if (idx >= 0) list[idx] = entry;
    else list.push(entry);
    this.emit("messagesChanged", sessionId);
  };

  private handleMessageRemoved = (payload: { sessionID: string; messageID: string }): void => {
    const { sessionID, messageID } = payload;
    if (!sessionID || !messageID) return;
    const list = this.messagesBySession.get(sessionID);
    if (!list) return;
    // Server's revert/removeMessage emits one event per removed message; filter
    // by id so any order arrives correctly. No need to also drop "subsequent"
    // messages client-side — the server emits events for each of them too.
    const next = list.filter((m) => m.info.id !== messageID);
    if (next.length === list.length) return;
    this.messagesBySession.set(sessionID, next);
    this.emit("messageRemoved", { sessionId: sessionID, messageID });
  };

  private ensureMessage(sessionId: string, messageID: string): MessageWithParts | null {
    const list = this.messagesBySession.get(sessionId);
    if (!list) return null;
    let msg = list.find((m) => m.info.id === messageID);
    if (!msg) {
      // Streaming deltas can arrive before the server emits message.updated for
      // the new assistant turn. Register a minimal placeholder so chunks are not
      // dropped; the real info arrives later via message.updated (which preserves
      // the accumulated parts).
      msg = {
        info: {
          id: messageID,
          sessionID: sessionId,
          role: "assistant",
          time: { created: Date.now() },
        } as unknown as Message,
        parts: [],
      };
      list.push(msg);
      this.emit("messagesChanged", sessionId);
    }
    return msg;
  }

  private handleMessagePartUpdated = (payload: { part: Part; delta?: string }): void => {
    const part = payload.part;
    const sessionId = part.sessionID;
    const msg = this.ensureMessage(sessionId, part.messageID);
    if (!msg) return;
    const pIdx = msg.parts.findIndex((p) => p.id === part.id);
    let finalPart: Part = part;
    if (payload.delta && (part.type === "text" || part.type === "reasoning")) {
      const base = pIdx >= 0 ? msg.parts[pIdx] : undefined;
      const existingText =
        base && (base.type === "text" || base.type === "reasoning") ? base.text : "";
      finalPart = { ...part, text: existingText + payload.delta };
    }
    if (pIdx >= 0) msg.parts[pIdx] = finalPart;
    else msg.parts.push(finalPart);
    this.emit("messagePartUpdated", { sessionId, part: finalPart });
  };

  private handleMessagePartDelta = (payload: {
    sessionID: string;
    messageID: string;
    partID: string;
    field: string;
    delta: string;
  }): void => {
    const { sessionID, messageID, partID, field, delta } = payload;
    if (!sessionID || !messageID || !partID) return;
    const msg = this.ensureMessage(sessionID, messageID);
    if (!msg) return;

    let part = msg.parts.find((p) => p.id === partID);
    if (!part) {
      part = {
        id: partID,
        sessionID,
        messageID,
        type: field === "reasoning" ? "reasoning" : "text",
        text: delta,
      } as Part;
      msg.parts.push(part);
    } else if (part.type === "text" || part.type === "reasoning") {
      (part as { text: string }).text += delta;
    }
    this.emit("messagePartUpdated", { sessionId: sessionID, part });
  };

  private handleMessagePartRemoved = (payload: {
    sessionID: string;
    messageID: string;
    partID: string;
  }): void => {
    const { sessionID, messageID, partID } = payload;
    const list = this.messagesBySession.get(sessionID);
    if (!list) return;
    const msg = list.find((m) => m.info.id === messageID);
    if (!msg) return;
    msg.parts = msg.parts.filter((p) => p.id !== partID);
    this.emit("messagePartRemoved", { sessionId: sessionID, messageID, partID });
  };

  /**
   * Handle the real `permission.asked` event. The opencode server emits
   * `permission.asked` (NOT `permission.updated` as the SDK types claim), with
   * a different payload: callID lives under `tool.callID`, the tool name is the
   * `permission` field, and there is no `title`. We normalize to the webview
   * Permission shape so the existing approval card in ToolCallView matches by
   * callID and renders. handlePermissionUpdated is retained as a fallback.
   */
  private handlePermissionAsked = (raw: {
    id: string;
    sessionID: string;
    permission?: string;
    patterns?: string[];
    metadata?: { [key: string]: unknown };
    always?: string[];
    tool?: { messageID: string; callID: string };
  }): void => {
    const sessionId = raw.sessionID;
    if (!sessionId || !raw.id) return;
    const tool = raw.permission ?? "tool";
    const detail =
      (raw.metadata?.command as string | undefined) ?? raw.patterns?.[0];
    const permission: Permission & { always?: string[] } = {
      id: raw.id,
      type: tool,
      pattern: raw.patterns,
      sessionID: sessionId,
      messageID: raw.tool?.messageID ?? "",
      callID: raw.tool?.callID,
      title: detail ? `${tool}: ${detail}` : tool,
      metadata: raw.metadata ?? {},
      always: raw.always,
      time: { created: Date.now() },
    };
    let list = this.permissionsBySession.get(sessionId);
    if (!list) {
      list = [];
      this.permissionsBySession.set(sessionId, list);
    }
    const idx = list.findIndex((p) => p.id === permission.id);
    if (idx >= 0) list[idx] = permission;
    else list.push(permission);
    this.emit("permissionRequest", { sessionId, permission });
  };

  // The SDK defines EventPermissionUpdated as { properties: Permission } —
  // the ONLY event whose properties is a bare domain object rather than a
  // wrapper. eventStream.ts emits event.properties verbatim, so the argument
  // here IS the Permission itself (with sessionID as a direct field).
  // Verified against @opencode-ai/sdk types.gen.d.ts + test/verify-findings.test.ts.
  private handlePermissionUpdated = (permission: Permission): void => {
    const sessionId = permission.sessionID;
    if (!sessionId) return;
    let list = this.permissionsBySession.get(sessionId);
    if (!list) {
      list = [];
      this.permissionsBySession.set(sessionId, list);
    }
    const idx = list.findIndex((p) => p.id === permission.id);
    if (idx >= 0) list[idx] = permission;
    else list.push(permission);
    this.emit("permissionRequest", { sessionId, permission });
  };

  private handlePermissionReplied = (payload: {
    sessionID: string;
    permissionID: string;
    response: string;
  }): void => {
    const { sessionID, permissionID } = payload;
    // Delegate to clearPermission so the SSE path and the local-reply path
    // share the same no-op guard (skip if already gone) and avoid a double
    // emit when the server's permission.replied arrives after our own
    // optimistic removal in replyPermission().
    this.clearPermission(sessionID, permissionID);
  };

  private handleTodoUpdated = (payload: { sessionID: string; todos: Todo[] }): void => {
    if (!payload?.sessionID) return;
    const todos = Array.isArray(payload.todos) ? payload.todos : [];
    this.todosBySession.set(payload.sessionID, todos);
    this.emit("todosChanged", { sessionId: payload.sessionID, todos });
  };

  private handleServerConnected = (): void => {
    void this.reconcileOnReconnect();
  };

  /**
   * On (re)connect, refresh sessions/statuses, then conservatively drop stale
   * pending permissions. The engine exposes no GET for pending permissions, so
   * we can't re-read the true list. Instead we clear permissions for sessions
   * that are NOT busy: an idle session cannot have a live permission prompt
   * outstanding, so any lingering entry is a phantom left over from a dropped
   * connection (its answer never round-tripped, or it was answered elsewhere).
   * Busy sessions are left untouched — they may hold a genuinely pending prompt
   * that the agent is still blocked on.
   */
  private async reconcileOnReconnect(): Promise<void> {
    await this.refreshSessions();
    for (const [sessionId, list] of this.permissionsBySession) {
      if (list.length === 0) continue;
      if (this.getStatus(sessionId).type === "busy") continue;
      this.permissionsBySession.set(sessionId, []);
      for (const perm of list) {
        this.emit("permissionReplied", { sessionId, permissionID: perm.id });
      }
    }
  }
}
