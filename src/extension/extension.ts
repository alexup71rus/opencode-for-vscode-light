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

    sessionService = new SessionService(client, eventStream);
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
          // restart() awaits the old connect loop's full shutdown before
          // starting a new one, so we never briefly hold two SSE streams
          // and the dying loop cannot null the new abortController.
          await eventStream!.restart();
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

    context.subscriptions.push(panelManager);
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
        if (e.added.length === 0) return;
        // workdir is captured once at activation: it is the cwd of the
        // spawned opencode server, the SDK's directory parameter, and the
        // root for diff/file checks. We deliberately do not try to swap it
        // in-place — a half-migrated client pointing at a new folder while
        // the server keeps running with the old cwd would silently execute
        // actions in the wrong project. If the effective root actually
        // changed, ask the user to reload so activation re-runs cleanly.
        const next = resolveWorkdir();
        if (!next || next === workdir) return;
        log(`workspace root changed: ${next} (was ${workdir}); reload required`);
        void vscode.window
          .showInformationMessage(
            "OpenCode: workspace folder changed. Reload the window to apply.",
            "Reload Window",
          )
          .then((action) => {
            if (action === "Reload Window") {
              void vscode.commands.executeCommand("workbench.action.reloadWindow");
            }
          });
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
    // If activation failed partway through, server/eventStream/sessionService
    // may already be alive (e.g. spawned opencode serve, setInterval pollers,
    // active SSE subscriptions). VS Code does not call deactivate() after a
    // thrown activate(), so we must tear down manually before re-throwing —
    // otherwise those resources leak until window reload.
    try {
      await cleanup();
    } catch {
      // Swallow secondary cleanup errors so the original failure is reported.
    }
    vscode.window.showErrorMessage(`OCVS: OpenCode failed to start: ${message}`);
    throw err;
  }
}

export async function deactivate(): Promise<void> {
  await cleanup();
}

/**
 * Tear down any partially- or fully-initialised extension resources and
 * clear the module-level references. Idempotent: safe to call from both the
 * activation catch path (partial init) and deactivate() (full init).
 */
async function cleanup(): Promise<void> {
  try {
    sessionService?.stop();
  } catch {
    // ignore
  }
  await stopEventStreamWithCeiling();
  try {
    await serverManager?.dispose();
  } catch {
    // ignore
  }
  sessionService = undefined;
  eventStream = undefined;
  serverManager = undefined;
}

/**
 * Extension shutdown path. EventStream.stop() has honest "wait until the
 * connect loop fully exits" semantics, which is what restart() needs; but a
 * stuck SDK/SSE reader could hang shutdown indefinitely. Race against a 2s
 * ceiling so VS Code is never blocked by a wedged stream.
 */
async function stopEventStreamWithCeiling(): Promise<void> {
  const stopPromise = eventStream?.stop();
  if (!stopPromise) return;

  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      stopPromise,
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, 2000);
      }),
    ]);
  } catch {
    // Ignore shutdown errors.
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
