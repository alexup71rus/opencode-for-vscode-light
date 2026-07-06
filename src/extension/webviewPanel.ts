import * as vscode from "vscode";
import { randomBytes } from "crypto";
import { readFileSync, existsSync } from "fs";
import * as os from "os";
import * as path from "path";
import { stat } from "fs/promises";
import { join } from "path";
import type { EventEmitter } from "events";

import type { OpenCodeClient } from "../bridge/openCodeClient";
import type { SessionService } from "../services/sessionService";
import type { ModelService } from "../services/modelService";
import type { AgentService } from "../services/agentService";
import type { StatsService } from "../services/statsService";
import type { EventStream } from "../bridge/eventStream";
import { ContextProvider } from "./contextProvider";
import { openFileDiff, reconstructFileDiff, type DiffDocumentProvider } from "./diffProvider";
import { pickWriteTarget, writePermissionRule, removePermissionRule, loadPermissionRules, configFilePath, globalConfigDir, type WriteScope } from "./permissionConfig";

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
  // Permission-config watchers live separately from `disposables` (which are
  // only cleared on full manager dispose). They are recreated on every panel
  // show(), so they MUST be torn down on panel close — otherwise each
  // close/reopen cycle leaks 2 native watchers + 6 callbacks and compounds
  // duplicate re-broadcasts/toasts.
  private permissionWatchers: vscode.Disposable[] = [];
  private isReady = false;
  private currentConfig: ProjectConfig | null = null;
  private currentSkills: SkillInfo[] = [];
  private currentMcpStatus: Record<string, McpServerStatus> = {};
  private currentLspStatus: LspStatusInfo[] = [];
  // Consume-once self-write guard: each own write to a config path increments a
  // counter, and each incoming watcher event for that path decrements it. This
  // is a true per-event mutex rather than a time-based heuristic — the watcher
  // event for our own write is always suppressed exactly once, regardless of
  // how long the FS layer takes to deliver it (slow/network/WSL/macOS-load).
  private readonly pendingSelfWrites = new Map<string, number>();
  private permissionReloadTimer: NodeJS.Timeout | undefined;

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
    private readonly reconnect: () => Promise<boolean>,
    // Force-restart the managed server (kill + respawn) so a freshly-written
    // config file is re-read. Returns false for external servers (nothing to
    // restart — the user must do it manually). May reject on respawn failure.
    private readonly restartManagedServer: () => Promise<boolean>,
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
        this.disposePermissionWatchers();
        this.panel = undefined;
        this.isReady = false;
      },
      undefined,
      this.disposables,
    );

    this.attachServiceListeners();
    this.setupPermissionConfigWatcher();
  }

  hide(): void {
    if (this.panel) {
      this.panel.dispose();
    }
  }

  dispose(): void {
    this.detachServiceListeners();
    this.disposePermissionWatchers();
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

  async pushContext(): Promise<void> {
    const context = await this.contextProvider.getContext();
    this.postMessage({
      type: "context",
      filePath: context.filePath ?? null,
      fileName: context.fileName ?? null,
      selection: context.selection ?? null,
      diagnostics: context.diagnostics ?? null,
    });
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
            msg.sessionId,
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
      case "editMessage": {
        try {
          await this.sessionService.editMessage(
            msg.sessionId,
            msg.messageID,
            msg.text,
            msg.options ?? undefined,
            msg.attachments,
          );
        } catch (err) {
          this.reportError(err, "edit message");
        }
        break;
      }
      case "abortSession": {
        try {
          await this.sessionService.abortSession(msg.sessionId);
        } catch (err) {
          this.reportError(err, "abort session");
        }
        break;
      }
      case "replyPermission": {
        // Capture the request before the awaited reply so the persist below is
        // race-free (the server's permission.replied event may evict it).
        const alwaysPersist =
          msg.decision === "always"
            ? this.sessionService
                .getPendingPermissions(msg.sessionId)
                .find((p) => p.id === msg.permissionId)
            : undefined;
        try {
          await this.sessionService.replyPermission(msg.sessionId, msg.permissionId, msg.decision);
          // Optimistically clear the card from the store. The server's
          // permission.replied event name is not reliable across versions, so
          // don't depend on it for removal — the user already acted.
          this.postMessage({
            type: "permissionReplied",
            sessionId: msg.sessionId,
            permissionID: msg.permissionId,
          });
          if (alwaysPersist) this.persistAlwaysAllow(alwaysPersist);
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
      case "getFileDiffContent": {
        try {
          const r = await reconstructFileDiff(
            msg.filePath,
            msg.edits,
            msg.isNewFile,
            this.client.workdirPath,
          );
          if ("error" in r) {
            this.postMessage({
              type: "fileDiffContent",
              filePath: msg.filePath,
              before: "",
              after: "",
              label: "",
              error: r.error,
            });
          } else {
            this.postMessage({
              type: "fileDiffContent",
              filePath: msg.filePath,
              before: r.before,
              after: r.after,
              label: r.label,
            });
          }
        } catch (err) {
          this.reportError(err, "get file diff content");
          this.postMessage({
            type: "fileDiffContent",
            filePath: msg.filePath,
            before: "",
            after: "",
            label: "",
            error: err instanceof Error ? err.message : String(err),
          });
        }
        break;
      }
      case "checkFilesExist": {
        try {
          const results: Record<string, boolean> = {};
          await Promise.all(
            msg.paths.map(async (p) => {
              const abs = path.isAbsolute(p) ? p : path.join(this.client.workdirPath, p);
              try {
                await stat(abs);
                results[p] = true;
              } catch {
                results[p] = false;
              }
            }),
          );
          this.postMessage({ type: "filesExist", results });
        } catch (err) {
          this.reportError(err, "check files exist");
        }
        break;
      }
      case "getContext": {
        try {
          await this.pushContext();
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
          this.postMessage({ type: "fileResults", files, source: msg.source, query: msg.query });
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
          this.postServerStatus("starting");
          const ok = await this.reconnect();
          if (!ok) {
            this.postServerStatus("error", "Server respawn failed — see output for details.");
            break;
          }
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
      case "getPermissionRules": {
        try {
          this.pushPermissionRules();
        } catch (err) {
          this.reportError(err, "load permission rules");
        }
        break;
      }
      case "savePermissionRule": {
        try {
          const workspace = this.client.workdirPath;
          const file = configFilePath(msg.rule.source, workspace);
          this.markSelfWrite(file);
          writePermissionRule(file, {
            tool: msg.rule.tool,
            pattern: msg.rule.pattern,
            action: msg.rule.action,
            source: msg.rule.source,
          });
          this.pushPermissionRules();
        } catch (err) {
          this.reportError(err, "save permission rule");
        }
        break;
      }
      case "removePermissionRule": {
        try {
          const workspace = this.client.workdirPath;
          const file = configFilePath(msg.source, workspace);
          this.markSelfWrite(file);
          removePermissionRule(file, msg.tool, msg.pattern);
          this.pushPermissionRules();
        } catch (err) {
          this.reportError(err, "remove permission rule");
        }
        break;
      }
      case "reloadServer": {
        try {
          if (!this.connection.isManaged) {
            this.postMessage({
              type: "permissionNotice",
              kind: "externalChange",
              message:
                "Connected to an external server — restart it manually to apply permission changes.",
            });
            break;
          }
          // Guard against interrupting an in-flight generation: restarting the
          // server tears down SSE and aborts the run. The webview is expected
          // to confirm first, but enforce it host-side too (defense in depth).
          if (this.sessionService.isAnySessionBusy() && !msg.force) {
            this.postMessage({
              type: "permissionNotice",
              kind: "externalChange",
              message:
                "A generation is in progress. Click again to restart anyway (the run will be interrupted).",
            });
            break;
          }
          // Signal "reloading" so the UI can show a busy state on the button.
          // postServerStatus("starting") flips the whole Connection tab too.
          this.postServerStatus("starting");
          // The button already reflects the in-progress state (label, pulse,
          // tooltip), so don't spam a banner for the happy path — only surface
          // a notice when the button itself can't tell the story (errors,
          // external server, busy-guard). Clear any stale notice first.
          this.postMessage({ type: "clearPermissionNotice" });
          // Restart the managed server (kill+respawn) so the instance re-reads
          // the config. reloadWindow would also work but tears down the whole
          // UI; a targeted server restart is lighter and keeps the panel open.
          const restarted = await this.restartManagedServer();
          if (!restarted) {
            this.postServerStatus("ready");
            this.postMessage({
              type: "permissionNotice",
              kind: "externalChange",
              message: "Server restart was not performed — no changes applied.",
            });
          } else {
            // Server came back fresh: re-broadcast rules. No success banner —
            // the button returning to "Reload to apply" is the confirmation.
            this.pushPermissionRules();
            this.postServerStatus("ready");
          }
        } catch (err) {
          this.postServerStatus("error", err instanceof Error ? err.message : String(err));
          this.reportError(err, "reload server");
        }
        break;
      }
      default: {
        break;
      }
    }
  }

  private persistAlwaysAllow(perm: Permission): void {
    const tool = perm.type;
    // The engine accepts any tool name as a permission key (it matches via
    // wildcard), so we persist whatever the prompt was for.
    if (!tool || typeof tool !== "string") return;
    const patterns = (perm as Permission & { always?: string[] }).always;
    if (!patterns?.length) {
      // No specific patterns: the in-memory "always" covers the session; there
      // is nothing durable to write. Tell the user so they know it won't carry
      // over to the next launch.
      void vscode.window.showInformationMessage(
        `OCVS: "Always allow" for ${tool} applies to this session only.`,
      );
      return;
    }
    const workspace = this.client.workdirPath;
    const target = pickWriteTarget(workspace, os.homedir());
    for (const pattern of patterns) {
      try {
        this.markSelfWrite(target.path);
        writePermissionRule(target.path, { tool, pattern, action: "allow", source: target.scope });
      } catch (err) {
        this.reportError(err, "persist always-allow");
      }
    }
  }

  private pushPermissionRules(): void {
    const workspace = this.client.workdirPath;
    const snapshot = loadPermissionRules(workspace, os.homedir());
    this.postMessage({ type: "permissionRules", snapshot });
  }

  private setupPermissionConfigWatcher(): void {
    // Idempotent: if a previous show() left watchers installed (e.g. reopen
    // before close finished), reuse them instead of stacking new ones.
    if (this.permissionWatchers.length) return;
    const folders = [globalConfigDir(), this.client.workdirPath];
    for (const folder of folders) {
      const pattern = new vscode.RelativePattern(vscode.Uri.file(folder), "opencode.{json,jsonc}");
      const watcher = vscode.workspace.createFileSystemWatcher(pattern);
      const handler = (uri: vscode.Uri) => this.onPermissionConfigChanged(uri.fsPath);
      watcher.onDidChange(handler, undefined, this.permissionWatchers);
      watcher.onDidCreate(handler, undefined, this.permissionWatchers);
      watcher.onDidDelete(handler, undefined, this.permissionWatchers);
      this.permissionWatchers.push(watcher);
    }
  }

  private disposePermissionWatchers(): void {
    for (const w of this.permissionWatchers) w.dispose();
    this.permissionWatchers = [];
    if (this.permissionReloadTimer) {
      clearTimeout(this.permissionReloadTimer);
      this.permissionReloadTimer = undefined;
    }
    // Drop any unconsumed self-write counters so a stale count can't suppress
    // the next genuine external change after the panel reopens.
    this.pendingSelfWrites.clear();
  }

  // Consume-once: each own write increments a per-path counter; the first
  // matching watcher event decrements it. A real external edit arrives when
  // the counter is 0 and is therefore never suppressed. Unlike a timeout,
  // this is correct regardless of FS event delivery latency.
  private markSelfWrite(filePath: string): void {
    this.pendingSelfWrites.set(filePath, (this.pendingSelfWrites.get(filePath) ?? 0) + 1);
    // Safety net: if a watcher event never arrives (file on an unwatched path,
    // watcher disposed mid-write), clear the slot after a generous window so
    // the counter can't wedge permanently.
    setTimeout(() => {
      const remaining = (this.pendingSelfWrites.get(filePath) ?? 0) - 1;
      if (remaining <= 0) this.pendingSelfWrites.delete(filePath);
      else this.pendingSelfWrites.set(filePath, remaining);
    }, 2000);
  }

  private onPermissionConfigChanged(filePath: string): void {
    // Consume one self-write slot per incoming event. FS coalescing means one
    // write may surface as several events; decrement-but-don't-go-negative so
    // a burst of N events for M writes still settles to 0.
    const pending = this.pendingSelfWrites.get(filePath);
    if (pending) {
      this.pendingSelfWrites.set(filePath, pending - 1);
      return;
    }
    if (this.permissionReloadTimer) clearTimeout(this.permissionReloadTimer);
    this.permissionReloadTimer = setTimeout(() => {
      this.permissionReloadTimer = undefined;
      try {
        this.pushPermissionRules();
        this.postMessage({
          type: "permissionNotice",
          kind: "externalChange",
          message: "Config changed externally — reload the server to apply.",
        });
      } catch (err) {
        this.reportError(err, "reload permission rules after external change");
      }
    }, 200);
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

    this.addListener(session, "messageRemoved", (...args) => {
      const payload = args[0] as { sessionId: string; messageID: string };
      if (!payload?.sessionId) return;
      this.postMessage({
        type: "messageRemoved",
        sessionId: payload.sessionId,
        messageID: payload.messageID,
      });
    });

    this.addListener(session, "sessionStatus", (...args) => {
      const payload = args[0] as { sessionId: string; status: SessionStatusInfo };
      if (!payload?.sessionId) return;
      this.postMessage({ type: "sessionStatus", sessionId: payload.sessionId, status: payload.status });
    });

    this.addListener(session, "sessionError", (...args) => {
      const payload = args[0] as { sessionId: string; error: unknown };
      if (!payload?.sessionId) return;
      const detail =
        typeof payload.error === "string"
          ? payload.error
          : payload.error instanceof Error
            ? payload.error.message
            : payload.error && typeof payload.error === "object" && "message" in payload.error
              ? String((payload.error as { message: unknown }).message)
              : "unknown server error";
      this.output.appendLine(`[opencode] session ${payload.sessionId} error: ${detail}`);
      this.postMessage({ type: "error", message: detail });
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
      // Restore the full active-session snapshot. The live listeners in
      // attachServiceListeners() only fire on new events, so a freshly
      // created panel (dispose + recreate via openPanel, or a visibility
      // toggle without retainContextWhenHidden) would otherwise render an
      // empty chat for a session that actually has messages, an in-flight
      // permission prompt, or a pending question-tool request.
      const messages = this.sessionService.getMessages(activeSessionId);
      if (messages.length > 0) {
        this.postMessage({ type: "messages", sessionId: activeSessionId, messages });
      }
      this.postMessage({
        type: "sessionStatus",
        sessionId: activeSessionId,
        status: this.sessionService.getStatus(activeSessionId),
      });
      for (const permission of this.sessionService.getPendingPermissions(activeSessionId)) {
        this.postMessage({
          type: "permissionRequest",
          sessionId: activeSessionId,
          permission,
        });
      }
      for (const question of this.sessionService.getQuestionsForSession(activeSessionId)) {
        this.postMessage({
          type: "questionAdded",
          sessionId: activeSessionId,
          question,
        });
      }
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
      `img-src ${webview.cspSource} data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `font-src ${webview.cspSource}`,
      `connect-src ${webview.cspSource}`,
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
    // Keep only schema-valid keys with valid actions; bash may be granular
    // {pattern: action}. Drop anything else so the webview never renders a
    // shape the engine would strip.
    const src = raw.permission as Record<string, unknown>;
    const out: NonNullable<ProjectConfig["permission"]> = {};
    const isAction = (v: unknown): v is "allow" | "ask" | "deny" =>
      v === "allow" || v === "ask" || v === "deny";
    // The engine accepts any tool name; each value is flat OR granular. Keep
    // valid entries, drop junk so the webview never renders a shape the engine
    // would ignore.
    for (const [tool, v] of Object.entries(src)) {
      if (typeof v === "string" && isAction(v)) {
        out[tool] = v;
      } else if (v && typeof v === "object") {
        const granular: Record<string, "allow" | "ask" | "deny"> = {};
        for (const [pat, act] of Object.entries(v as Record<string, unknown>)) {
          if (isAction(act)) granular[pat] = act;
        }
        if (Object.keys(granular).length) out[tool] = granular;
      }
    }
    config.permission = out;
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
