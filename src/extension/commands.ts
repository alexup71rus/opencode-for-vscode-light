import * as vscode from "vscode";
import type { WebviewPanelManager } from "./webviewPanel";
import type { SessionService } from "../services/sessionService";

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function registerCommands(
  context: vscode.ExtensionContext,
  panelManager: WebviewPanelManager,
  sessionService: SessionService,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("opencode.openPanel", () => {
      panelManager.show();
    }),

    vscode.commands.registerCommand("opencode.newSession", async () => {
      panelManager.show();
      try {
        await sessionService.createSession();
      } catch (err) {
        vscode.window.showErrorMessage(`OCVS: failed to create session: ${errorMessage(err)}`);
      }
    }),
  );
}
