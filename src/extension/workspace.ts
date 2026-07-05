import * as vscode from "vscode";

export function getActiveWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
  const editor = vscode.window.activeTextEditor;
  if (editor) {
    const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
    if (folder) {
      return folder;
    }
  }

  if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
    return vscode.workspace.workspaceFolders[0];
  }

  return undefined;
}

export function resolveWorkdir(): string | undefined {
  return getActiveWorkspaceFolder()?.uri.fsPath ?? vscode.workspace.rootPath;
}
