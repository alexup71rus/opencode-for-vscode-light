import * as vscode from "vscode";
import type { AttachedContext } from "../bridge/types";

export class ContextProvider {
  async getContext(): Promise<AttachedContext> {
    const context: AttachedContext = {};

    const activeFile = await this.getActiveFile();
    if (activeFile) {
      context.filePath = activeFile.path;
      context.fileName = activeFile.name;
    }

    const selection = await this.getSelection();
    if (selection) {
      context.selection = selection.text;
      context.selectionRange = { startLine: selection.startLine, endLine: selection.endLine };
    }

    const editor = vscode.window.activeTextEditor;
    if (editor) {
      const diagnostics = await this.getDiagnostics(editor.document.uri);
      if (diagnostics && diagnostics.length > 0) {
        context.diagnostics = diagnostics;
      }
    }

    return context;
  }

  async getActiveFile(): Promise<{ path: string; name: string; content: string } | null> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return null;
    }
    const document = editor.document;
    return {
      path: document.uri.fsPath,
      name: document.uri.path.split("/").pop() ?? document.uri.fsPath,
      content: document.getText(),
    };
  }

  async getSelection(): Promise<{ text: string; startLine: number; endLine: number } | null> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.selection.isEmpty) {
      return null;
    }
    const text = editor.document.getText(editor.selection);
    if (!text) {
      return null;
    }
    return {
      text,
      startLine: editor.selection.start.line,
      endLine: editor.selection.end.line,
    };
  }

  async getDiagnostics(uri: vscode.Uri): Promise<AttachedContext["diagnostics"]> {
    const diagnostics = vscode.languages.getDiagnostics(uri);
    return diagnostics
      .filter(
        (d) =>
          d.severity === vscode.DiagnosticSeverity.Error ||
          d.severity === vscode.DiagnosticSeverity.Warning,
      )
      .map((d) => ({
        severity: this.severityToString(d.severity),
        message: d.message,
        line: d.range.start.line,
        source: d.source,
      }));
  }

  private severityToString(severity: vscode.DiagnosticSeverity): string {
    switch (severity) {
      case vscode.DiagnosticSeverity.Error:
        return "error";
      case vscode.DiagnosticSeverity.Warning:
        return "warning";
      case vscode.DiagnosticSeverity.Information:
        return "info";
      case vscode.DiagnosticSeverity.Hint:
        return "hint";
      default:
        return "info";
    }
  }
}
