import * as vscode from "vscode";
import { randomBytes } from "crypto";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import type { EventEmitter } from "events";

import type { OpenCodeClient } from "../bridge/openCodeClient";
import type { SessionService } from "../services/sessionService";
import type { ModelService } from "../services/modelService";
import type { AgentService } from "../services/agentService";
import type { StatsService } from "../services/statsService";
import type { EventStream } from "../bridge/eventStream";
import { ContextProvider } from "./contextProvider";
import { openFileDiff, type DiffDocumentProvider } from "./diffProvider";

import type {
  ExtensionToWebview,
  WebviewToExtension,
} from "../protocol/messages";
import type { Part, Permission } from "@opencode-ai/sdk";
import type {
  SessionWithMeta,
  SessionStatusInfo,
  ProjectConfig,
  SkillInfo,
  Todo,
  McpServerStatus,
  LspStatusInfo,
  QuestionRequest,
} from "../bridge/types";

interface ServiceListenerBinding {
  emitter: EventEmitter;
  event: string;
  handler: (...args: unknown[]) => void;
}

export interface ConnectionInfo {
  binaryPath: string;
  isManaged: boolean;
  externalUrl: string;
}

export class WebviewPanelManager {
  private panel: vscode.WebviewPanel | undefined;
  private readonly listeners: ServiceListenerBinding[] = [];
  private readonly disposables: vscode.Disposable[] = [];
  private isReady = false;
  private currentConfig: ProjectConfig | null = null;
  private currentSkills: SkillInfo[] = [];
  private currentMcpStatus: Record<string, McpServerStatus> = {};
  private currentLspStatus: LspStatusInfo[] = [];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly sessionService: SessionService,
    private readonly modelService: ModelService,
    private readonly agentService: AgentService,
    private readonly statsService: StatsService,
    private readonly contextProvider: ContextProvider,
    private readonly client: OpenCodeClient,
    private readonly eventStream: EventStream,
    private readonly output: vscode.OutputChannel,
    private readonly connection: ConnectionInfo,
    private readonly diffProvider: DiffDocumentProvider,
  ) {
    this.loadConfig();
  }

  show(): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Two, false);
      return;
    }

    const webviewRoot = vscode.Uri.joinPath(this.context.extensionUri, "dist", "webview");
    const mediaRoot = vscode.Uri.joinPath(this.context.extensionUri, "media");

    this.panel = vscode.window.createWebviewPanel(
      "opencode.chat",
      "OCVS",
      vscode.ViewColumn.Two,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [webviewRoot, mediaRoot],
      },
    );

    this.panel.iconPath = {
      light: vscode.Uri.joinPath(mediaRoot, "icon.svg"),
      dark: vscode.Uri.joinPath(mediaRoot, "icon-dark.svg"),
    };
    this.panel.webview.html = this.getHtmlForWebview(this.panel.webview, webviewRoot);

    this.panel.webview.onDidReceiveMessage(
      (msg) => this.handleMessage(msg as WebviewToExtension),
      undefined,
      this.disposables,
    );

    this.panel.onDidChangeViewState(
      () => {
        if (this.panel && this.panel.visible && this.isReady) {
          this.pushInitialState();
        }
      },
      undefined,
      this.disposables,
    );

    this.panel.onDidDispose(
      () => {
        this.detachServiceListeners();
        this.panel = undefined;
        this.isReady = false;
      },
      undefined,
      this.disposables,
    );

    this.attachServiceListeners();
  }

  hide(): void {
    if (this.panel) {
      this.panel.dispose();
    }
  }

  dispose(): void {
    this.detachServiceListeners();
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables.length = 0;
    if (this.panel) {
      this.panel.dispose();
      this.panel = undefined;
    }
    this.isReady = false;
  }

  private postMessage(msg: ExtensionToWebview): void {
    if (this.panel) {
      this.panel.webview.postMessage(msg);
    }
  }

  private async handleMessage(msg: WebviewToExtension): Promise<void> {
    if (!this.isReady) {
      this.isReady = true;
      this.pushInitialState();
    }

    switch (msg.type) {
      case "createSession": {
        try {
          await this.sessionService.createSession(msg.title, msg.model ?? undefined);
        } catch (err) {
          this.reportError(err, "create session");
        }
        break;
      }
      case "openSession": {
        try {
          await this.sessionService.openSession(msg.sessionId);
        } catch (err) {
          this.reportError(err, "open session");
        }
        break;
      }
      case "deleteSession": {
        try {
          await this.sessionService.deleteSession(msg.sessionId);
        } catch (err) {
          this.reportError(err, "delete session");
        }
        break;
      }
      case "renameSession": {
        try {
          await this.sessionService.renameSession(msg.sessionId, msg.title);
        } catch (err) {
          this.reportError(err, "rename session");
        }
        break;
      }
      case "sendMessage": {
        try {
          await this.sessionService.sendMessage(
            msg.text,
            msg.context,
            msg.options ?? undefined,
            msg.attachments,
          );
        } catch (err) {
          this.reportError(err, "send message");
        }
        break;
      }
      case "abortSession": {
        try {
          await this.sessionService.abortSession();
        } catch (err) {
          this.reportError(err, "abort session");
        }
        break;
      }
      case "replyPermission": {
        try {
          await this.sessionService.replyPermission(msg.permissionId, msg.decision);
        } catch (err) {
          this.reportError(err, "reply to permission");
        }
        break;
      }
      case "replyQuestion": {
        try {
          await this.sessionService.replyQuestion(msg.requestId, msg.answers);
        } catch (err) {
          this.reportError(err, "reply to question");
        }
        break;
      }
      case "rejectQuestion": {
        try {
          await this.sessionService.rejectQuestion(msg.requestId);
        } catch (err) {
          this.reportError(err, "reject question");
        }
        break;
      }
      case "selectModel": {
        try {
          this.modelService.selectModel(msg.model);
        } catch (err) {
          this.reportError(err, "select model");
        }
        break;
      }
      case "selectAgent": {
        try {
          this.agentService.selectAgent(msg.agent);
        } catch (err) {
          this.reportError(err, "select agent");
        }
        break;
      }
      case "refreshAgents": {
        try {
          await this.agentService.refresh();
        } catch (err) {
          this.reportError(err, "refresh agents");
        }
        break;
      }
      case "openFileDiff": {
        try {
          await openFileDiff(
            this.diffProvider,
            msg.filePath,
            msg.edits,
            msg.isNewFile,
            this.client.workdirPath,
          );
        } catch (err) {
          this.reportError(err, "open file diff");
        }
        break;
      }
      case "getContext": {
        try {
          const context = await this.contextProvider.getContext();
          const activeFile = context.fileName ?? context.filePath ?? null;
          const selection = context.selection ?? null;
          const diagnostics = context.diagnostics ?? null;
          this.postMessage({ type: "context", activeFile, selection, diagnostics });
        } catch (err) {
          this.reportError(err, "get context");
        }
        break;
      }
      case "refreshSessions": {
        try {
          await this.sessionService.refreshSessions();
        } catch (err) {
          this.reportError(err, "refresh sessions");
        }
        break;
      }
      case "refreshModels": {
        try {
          await this.modelService.refresh();
        } catch (err) {
          this.reportError(err, "refresh models");
        }
        break;
      }
      case "getCommands": {
        try {
          const commands = await this.client.listCommands();
          this.postMessage({ type: "commands", commands });
        } catch (err) {
          this.reportError(err, "list commands");
        }
        break;
      }
      case "executeCommand": {
        try {
          await this.client.executeSessionCommand(msg.sessionId, msg.command, msg.args);
        } catch (err) {
          this.reportError(err, "execute command");
        }
        break;
      }
      case "compactSession": {
        try {
          await this.client.summarize(msg.sessionId, msg.model.providerID, msg.model.modelID);
        } catch (err) {
          this.reportError(err, "compact session");
        }
        break;
      }
      case "findFiles": {
        try {
          const files = await this.client.findFiles(msg.query);
          this.postMessage({ type: "fileResults", files });
        } catch (err) {
          this.reportError(err, "find files");
        }
        break;
      }
      case "copyText": {
        try {
          await vscode.env.clipboard.writeText(msg.text);
        } catch (err) {
          this.reportError(err, "copy text");
        }
        break;
      }
      case "openVscodeSettings": {
        try {
          await vscode.commands.executeCommand("workbench.action.openSettings", "opencode");
        } catch (err) {
          this.reportError(err, "open VS Code settings");
        }
        break;
      }
      case "retryConnection": {
        try {
          await Promise.all([
            this.sessionService.refreshSessions(),
            this.modelService.refresh(),
            this.agentService.refresh().catch(() => undefined),
          ]);
          await this.loadConfig();
          this.postServerStatus("ready");
          this.pushInitialState();
        } catch (err) {
          this.reportError(err, "retry connection");
          this.postServerStatus("error", err instanceof Error ? err.message : String(err));
        }
        break;
      }
      case "refreshInspect": {
        try {
          await this.loadInspectStatus();
          const sessionId = this.sessionService.getActiveSessionId();
          if (sessionId) {
            await this.sessionService.fetchTodos(sessionId).catch(() => undefined);
          }
        } catch (err) {
          this.output.appendLine(
            `[opencode] failed to refresh inspect: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        break;
      }
      default: {
        break;
      }
    }
  }

  private attachServiceListeners(): void {
    const session = this.sessionService as unknown as EventEmitter;
    const models = this.modelService as unknown as EventEmitter;

    this.addListener(session, "sessionsChanged", () => {
      const sessions = this.sessionService.getSessions();
      this.statsService.update(sessions);
      this.postMessage({
        type: "state",
        sessions,
        activeSessionId: this.sessionService.getActiveSessionId(),
      });
      this.postMessage({
        type: "stats",
        totalCost: this.statsService.getTotalCost(),
        totalTokens: this.statsService.getTotalTokens(),
      });
    });

    this.addListener(session, "messagesChanged", (...args) => {
      const sessionId = args[0] as string;
      if (!sessionId) {
        return;
      }
      const messages = this.sessionService.getMessages(sessionId);
      this.postMessage({ type: "messages", sessionId, messages });
    });

    this.addListener(session, "messagePartUpdated", (...args) => {
      const payload = args[0] as { sessionId: string; part: Part };
      if (!payload?.sessionId) return;
      this.postMessage({ type: "messagePartUpdated", sessionId: payload.sessionId, part: payload.part });
    });

    this.addListener(session, "messagePartRemoved", (...args) => {
      const payload = args[0] as { sessionId: string; messageID: string; partID: string };
      if (!payload?.sessionId) return;
      this.postMessage({
        type: "messagePartRemoved",
        sessionId: payload.sessionId,
        messageID: payload.messageID,
        partID: payload.partID,
      });
    });

    this.addListener(session, "sessionStatus", (...args) => {
      const payload = args[0] as { sessionId: string; status: SessionStatusInfo };
      if (!payload?.sessionId) return;
      this.postMessage({ type: "sessionStatus", sessionId: payload.sessionId, status: payload.status });
    });

    this.addListener(session, "permissionRequest", (...args) => {
      const payload = args[0] as { sessionId: string; permission: Permission };
      if (!payload?.sessionId) return;
      this.postMessage({
        type: "permissionRequest",
        sessionId: payload.sessionId,
        permission: payload.permission,
      });
    });

    this.addListener(session, "permissionReplied", (...args) => {
      const payload = args[0] as { sessionId: string; permissionID: string };
      if (!payload?.sessionId) return;
      this.postMessage({
        type: "permissionReplied",
        sessionId: payload.sessionId,
        permissionID: payload.permissionID,
      });
    });

    this.addListener(session, "questionAdded", (...args) => {
      const payload = args[0] as { sessionId: string; question: QuestionRequest };
      if (!payload?.sessionId) return;
      this.postMessage({
        type: "questionAdded",
        sessionId: payload.sessionId,
        question: payload.question,
      });
    });

    this.addListener(session, "questionRemoved", (...args) => {
      const payload = args[0] as { sessionId: string; requestId: string };
      if (!payload?.sessionId) return;
      this.postMessage({
        type: "questionRemoved",
        sessionId: payload.sessionId,
        requestId: payload.requestId,
      });
    });

    this.addListener(session, "todosChanged", (...args) => {
      const payload = args[0] as { sessionId: string; todos: Todo[] };
      if (!payload?.sessionId) {
        return;
      }
      this.postMessage({ type: "todos", sessionId: payload.sessionId, todos: payload.todos });
    });

    this.addListener(models, "modelsChanged", () => {
      this.postMessage({
        type: "models",
        providers: this.modelService.getProviders(),
        defaultModel: this.modelService.getDefaultModel(),
      });
    });

    const agents = this.agentService as unknown as EventEmitter;
    this.addListener(agents, "agentsChanged", () => {
      this.postMessage({
        type: "agents",
        agents: this.agentService.getAgents(),
        tools: this.agentService.getTools(),
      });
    });

    this.addListener(this.eventStream, "stream.error", () => {
      this.postServerStatus("error", "Stream connection lost, retrying…");
    });

    this.addListener(this.eventStream, "server.connected", () => {
      this.postServerStatus("ready");
    });
  }

  private addListener(
    emitter: EventEmitter,
    event: string,
    handler: (...args: unknown[]) => void,
  ): void {
    emitter.on(event, handler as (...args: unknown[]) => void);
    this.listeners.push({ emitter, event, handler });
  }

  private detachServiceListeners(): void {
    for (const binding of this.listeners) {
      binding.emitter.off(binding.event, binding.handler);
    }
    this.listeners.length = 0;
  }

  private async loadConfig(): Promise<void> {
    try {
      const raw = await this.client.getConfig();
      this.currentConfig = transformConfig(raw);
      if (this.panel) {
        this.postMessage({ type: "config", config: this.currentConfig });
      }
    } catch (err) {
      this.reportError(err, "load config");
    }
    void this.loadSkills();
    void this.loadInspectStatus();
  }

  private async loadSkills(): Promise<void> {
    try {
      this.currentSkills = await this.client.listSkills();
      if (this.panel) {
        this.postMessage({ type: "skills", skills: this.currentSkills });
      }
    } catch (err) {
      this.output.appendLine(
        `[opencode] failed to load skills: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async loadInspectStatus(): Promise<void> {
    try {
      this.currentMcpStatus = await this.client.getMcpStatus();
      if (this.panel) {
        this.postMessage({ type: "mcpStatus", servers: this.currentMcpStatus });
      }
    } catch (err) {
      this.output.appendLine(
        `[opencode] failed to load MCP status: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    try {
      this.currentLspStatus = await this.client.getLspStatus();
      if (this.panel) {
        this.postMessage({ type: "lspStatus", servers: this.currentLspStatus });
      }
    } catch (err) {
      this.output.appendLine(
        `[opencode] failed to load LSP status: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private postServerStatus(
    status: "starting" | "ready" | "error",
    message?: string,
  ): void {
    this.postMessage({
      type: "serverStatus",
      status,
      url: this.client.url,
      message,
      binaryPath: this.connection.binaryPath,
      isManaged: this.connection.isManaged,
      externalUrl: this.connection.externalUrl,
    });
  }

  private pushInitialState(): void {
    const sessions: SessionWithMeta[] = this.sessionService.getSessions();
    this.statsService.update(sessions);
    this.postMessage({
      type: "state",
      sessions,
      activeSessionId: this.sessionService.getActiveSessionId(),
    });
    this.postMessage({
      type: "models",
      providers: this.modelService.getProviders(),
      defaultModel: this.modelService.getDefaultModel(),
    });
    this.postMessage({
      type: "agents",
      agents: this.agentService.getAgents(),
      tools: this.agentService.getTools(),
    });
    this.postMessage({
      type: "stats",
      totalCost: this.statsService.getTotalCost(),
      totalTokens: this.statsService.getTotalTokens(),
    });
    if (this.currentConfig) {
      this.postMessage({ type: "config", config: this.currentConfig });
    }
    if (this.currentSkills.length > 0) {
      this.postMessage({ type: "skills", skills: this.currentSkills });
    }
    if (Object.keys(this.currentMcpStatus).length > 0) {
      this.postMessage({ type: "mcpStatus", servers: this.currentMcpStatus });
    }
    if (this.currentLspStatus.length > 0) {
      this.postMessage({ type: "lspStatus", servers: this.currentLspStatus });
    }
    const activeSessionId = this.sessionService.getActiveSessionId();
    if (activeSessionId) {
      const todos = this.sessionService.getTodos(activeSessionId);
      if (todos.length > 0) {
        this.postMessage({ type: "todos", sessionId: activeSessionId, todos });
      }
    }
    // Connection details (url / binary path / mode) live on serverStatus, so
    // re-publish on every initial push to keep the Connection tab populated
    // even before any stream event fires.
    this.postServerStatus("ready");
  }

  private reportError(err: unknown, action: string): void {
    const message = err instanceof Error ? err.message : String(err);
    this.output.appendLine(`[opencode] failed to ${action}: ${message}`);
    this.postMessage({ type: "error", message: `failed to ${action}: ${message}` });
    vscode.window.showErrorMessage(`OCVS: failed to ${action}.`);
  }

  private getHtmlForWebview(webview: vscode.Webview, webviewRoot: vscode.Uri): string {
    const nonce = randomBytes(16).toString("base64");

    const indexPath = join(webviewRoot.fsPath, "index.html");
    let html: string;
    try {
      html = existsSync(indexPath) ? readFileSync(indexPath, "utf8") : "";
    } catch {
      html = "";
    }

    if (!html) {
      return this.getFallbackHtml(webview, nonce);
    }

    html = html
      .replace(/<(script|link)\b([^>]*)\shref=(["'])(\.\.?\/)?([^"']+)\3/gi, (_m, tag, mid, _q, _rel, asset) => {
        const uri = webview.asWebviewUri(vscode.Uri.joinPath(webviewRoot, asset));
        return `<${tag}${mid} href=${uri.toString()}`;
      })
      .replace(/<(script|link)\b([^>]*)\ssrc=(["'])(\.\.?\/)?([^"']+)\3/gi, (_m, tag, mid, _q, _rel, asset) => {
        const uri = webview.asWebviewUri(vscode.Uri.joinPath(webviewRoot, asset));
        const nonceAttr = tag.toLowerCase() === "script" ? ` nonce="${nonce}"` : "";
        return `<${tag}${mid} src=${uri.toString()}${nonceAttr}`;
      });

    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} https: data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `font-src ${webview.cspSource}`,
      `connect-src ${webview.cspSource} https: ws: wss:`,
      `script-src 'nonce-${nonce}'`,
    ].join("; ");

    const cspMeta = `<meta http-equiv="Content-Security-Policy" content="${csp}">`;
    if (/<head[^>]*>/i.test(html)) {
      html = html.replace(/<head[^>]*>/i, (head) => `${head}${cspMeta}`);
    } else {
      html = cspMeta + html;
    }

    return html;
  }

  private getFallbackHtml(webview: vscode.Webview, nonce: string): string {
    const csp = [
      `default-src 'none'`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
    ].join("; ");

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>OCVS</title>
  <style>
    body { margin: 0; padding: 2rem; font-family: var(--vscode-font-family); color: var(--vscode-foreground); }
    .root { display: flex; align-items: center; justify-content: center; height: 100vh; }
  </style>
</head>
<body>
  <div class="root">
    <p>OCVS webview bundle is not built. Run <code>npm run compile:webview</code>.</p>
  </div>
</body>
</html>`;
  }

}

function transformConfig(raw: Record<string, unknown>): ProjectConfig {
  const config: ProjectConfig = {};
  if (typeof raw.model === "string") config.model = raw.model;
  if (typeof raw.small_model === "string") config.smallModel = raw.small_model;
  if (typeof raw.mode === "string") config.mode = raw.mode;
  if (typeof raw.username === "string") config.username = raw.username;
  if (raw.permission && typeof raw.permission === "object") {
    config.permission = raw.permission as Record<string, string>;
  }
  if (raw.agent && typeof raw.agent === "object") {
    const agents: ProjectConfig["agents"] = [];
    for (const [name, val] of Object.entries(raw.agent as Record<string, unknown>)) {
      if (val && typeof val === "object") {
        const a = val as Record<string, unknown>;
        agents.push({
          name,
          description: typeof a.description === "string" ? a.description : undefined,
          mode: typeof a.mode === "string" ? a.mode : "primary",
          builtIn: typeof a.builtIn === "boolean" ? a.builtIn : false,
        });
      }
    }
    config.agents = agents;
  }
  if (raw.skills && typeof raw.skills === "object") {
    const skills: ProjectConfig["skills"] = [];
    const skillsData = raw.skills as Record<string, unknown>;
    if (Array.isArray(skillsData.paths)) {
      for (const p of skillsData.paths) {
        if (typeof p === "string") {
          const parts = p.replace(/\\/g, "/").split("/");
          skills.push({ name: parts[parts.length - 1] ?? p, description: p });
        }
      }
    }
    if (Array.isArray(skillsData.list)) {
      for (const s of skillsData.list) {
        if (typeof s === "string") skills.push({ name: s });
        else if (s && typeof s === "object") {
          const so = s as Record<string, unknown>;
          skills.push({
            name: typeof so.name === "string" ? so.name : "unknown",
            description: typeof so.description === "string" ? so.description : undefined,
          });
        }
      }
    }
    config.skills = skills;
  }
  return config;
}
