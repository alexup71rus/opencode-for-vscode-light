import * as vscode from "vscode";

import { getConfig, getBinaryPath } from "./config";
import { resolveWorkdir } from "./workspace";
import { ContextProvider } from "./contextProvider";
import { DiffDocumentProvider, DIFF_SCHEME } from "./diffProvider";
import { WebviewPanelManager } from "./webviewPanel";
import { registerCommands } from "./commands";

import { ServerManager } from "../bridge/serverManager";
import { OpenCodeClient } from "../bridge/openCodeClient";
import { EventStream } from "../bridge/eventStream";
import { SessionService } from "../services/sessionService";
import { ModelService } from "../services/modelService";
import { AgentService } from "../services/agentService";
import { StatsService } from "../services/statsService";

let outputChannel: vscode.OutputChannel | undefined;
let serverManager: ServerManager | undefined;
let eventStream: EventStream | undefined;
let sessionService: SessionService | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  outputChannel = vscode.window.createOutputChannel("OCVS");
  context.subscriptions.push(outputChannel);

  const log = (message: string) => outputChannel!.appendLine(`[opencode] ${message}`);

  const config = getConfig();
  const hasExternalUrl =
    config.externalServerUrl.trim().length > 0;
  const binaryPath = getBinaryPath(config);

  if (!binaryPath && !hasExternalUrl) {
    log("opencode binary not found and no external server URL configured");
    context.subscriptions.push(
      vscode.commands.registerCommand("opencode.openPanel", async () => {
        const action = await vscode.window.showErrorMessage(
          "OpenCode binary was not found. Install it or configure an external server URL.",
          "Install instructions",
        );
        if (action === "Install instructions") {
          await vscode.env.openExternal(
            vscode.Uri.parse("https://opencode.ai/docs/quickstart"),
          );
        }
      }),
      vscode.commands.registerCommand("opencode.newSession", () => {
        void vscode.commands.executeCommand("opencode.openPanel");
      }),
    );
    return;
  }

  if (binaryPath) {
    log(`using binary: ${binaryPath}`);
  } else {
    log("no local binary; using external server only");
  }

  const workdir = resolveWorkdir();
  if (!workdir) {
    log("no workspace folder open");
    context.subscriptions.push(
      vscode.commands.registerCommand("opencode.openPanel", async () => {
        const action = await vscode.window.showWarningMessage(
          "Open a folder to start using OCVS.",
          "Open Folder",
        );
        if (action === "Open Folder") {
          await vscode.commands.executeCommand(
            "workbench.action.files.openFolder",
          );
        }
      }),
      vscode.commands.registerCommand("opencode.newSession", () => {
        void vscode.commands.executeCommand("opencode.openPanel");
      }),
    );
    return;
  }

  log(`workspace: ${workdir}`);

  try {
    serverManager = new ServerManager(
      binaryPath,
      config.externalServerUrl || undefined,
      config.serverPassword || undefined,
      config.serverHostname,
      log,
    );
    const serverInfo = await serverManager.ensureServer(workdir);
    log(`server ready: ${serverInfo.url}`);

    const client = new OpenCodeClient(serverInfo, workdir);

    eventStream = new EventStream(client);
    await eventStream.start();

    sessionService = new SessionService(client, eventStream, workdir);
    await sessionService.start();

    const modelService = new ModelService(client);
    await modelService.refresh();

    // Apply the default model from the OpenCode config `model` field
    // (e.g. "Tokenator/claude-sonnet-5"). Falls back to refresh() defaults
    // if the config model is missing/invalid or its provider isn't connected.
    try {
      const ocConfig = await client.getConfig();
      const configModel = typeof ocConfig.model === "string" ? ocConfig.model : undefined;
      modelService.applyConfigDefault(configModel);
    } catch (err) {
      log(`config model apply failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    const agentService = new AgentService(client);
    await agentService.refresh().catch((err) => {
      log(`agents refresh failed: ${err instanceof Error ? err.message : String(err)}`);
    });

    if (config.defaultModel) {
      const [providerID, modelID] = config.defaultModel.split("/");
      if (providerID && modelID) {
        modelService.selectModel({ providerID, modelID });
      }
    }

    const statsService = new StatsService();
    const contextProvider = new ContextProvider();
    const diffProvider = new DiffDocumentProvider();

    context.subscriptions.push(
      vscode.workspace.registerTextDocumentContentProvider(DIFF_SCHEME, diffProvider),
    );

    const reconnect = async (): Promise<boolean> => {
      try {
        const info = await serverManager!.ensureServer(workdir);
        if (info.url !== client.url) {
          log(`reconnecting to server: ${info.url}`);
          client.updateServer(info);
          eventStream!.stop();
          void eventStream!.start();
        }
        return true;
      } catch (err) {
        log(`reconnect failed: ${err instanceof Error ? err.message : String(err)}`);
        return false;
      }
    };

    const panelManager = new WebviewPanelManager(
      context,
      sessionService,
      modelService,
      agentService,
      statsService,
      contextProvider,
      client,
      eventStream,
      outputChannel,
      {
        binaryPath,
        isManaged: serverInfo.isManaged,
        externalUrl: config.externalServerUrl ?? "",
      },
      diffProvider,
      reconnect,
    );

    registerCommands(context, panelManager, sessionService);

    const statusItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100,
    );
    statusItem.text = "$(comment-discussion) OCVS";
    statusItem.tooltip = "Open OCVS Chat";
    statusItem.command = "opencode.openPanel";
    statusItem.show();
    context.subscriptions.push(statusItem);

    context.subscriptions.push(
      vscode.workspace.onDidChangeWorkspaceFolders((e) => {
        if (e.added.length > 0) {
          const next = resolveWorkdir();
          if (next) {
            sessionService!.updateWorkdir(next);
            log(`workspace changed: ${next}`);
          }
        }
      }),
    );

    let contextTimer: NodeJS.Timeout | undefined;
    const scheduleContextPush = (): void => {
      if (contextTimer) clearTimeout(contextTimer);
      contextTimer = setTimeout(() => {
        contextTimer = undefined;
        void panelManager.pushContext();
      }, 150);
    };

    context.subscriptions.push(
      vscode.window.onDidChangeActiveTextEditor(() => {
        // Switching the active editor should refresh immediately.
        void panelManager.pushContext();
      }),
    );

    context.subscriptions.push(
      vscode.window.onDidChangeTextEditorSelection(scheduleContextPush),
    );

    context.subscriptions.push({ dispose: () => diffProvider.dispose() });

    panelManager.show();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`activation failed: ${message}`);
    vscode.window.showErrorMessage(`OCVS: OpenCode failed to start: ${message}`);
    throw err;
  }
}

export async function deactivate(): Promise<void> {
  try {
    sessionService?.stop();
  } catch {
    // ignore
  }
  try {
    eventStream?.stop();
  } catch {
    // ignore
  }
  try {
    await serverManager?.dispose();
  } catch {
    // ignore
  }
  sessionService = undefined;
  eventStream = undefined;
  serverManager = undefined;
}
