import * as path from "path";
import * as vscode from "vscode";
import { readFile } from "fs/promises";

export const DIFF_SCHEME = "opencode-diff";

/** A single edit hunk reconstructed from a tool call's input. */
export interface EditPatch {
  oldStr: string;
  newStr: string;
}

export interface FileChange {
  filePath: string;
  edits: EditPatch[];
  isNewFile: boolean;
}

/**
 * Proposal-backed content provider (mirrors the clipboard-diff-apply pattern):
 * the "before" side of a diff is held in memory keyed by URI, the "after" side
 * is the real file on disk. VS Code's native diff editor then shows the change
 * and its apply arrows write into the real file.
 */
export class DiffDocumentProvider implements vscode.TextDocumentContentProvider {
  private readonly docs = new Map<string, string>();

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.docs.get(uri.toString()) ?? "";
  }

  set(uri: vscode.Uri, content: string): void {
    this.docs.set(uri.toString(), content);
  }

  dispose(): void {
    this.docs.clear();
  }
}

function resolveAbs(filePath: string, workdir: string): string {
  return path.isAbsolute(filePath) ? filePath : path.join(workdir, filePath);
}

function extensionFor(absPath: string): string {
  const ext = path.extname(absPath);
  return ext || ".txt";
}

/**
 * Open a native VS Code diff for a file the agent changed: the left side is the
 * reconstructed "before this turn" content, the right side is the real file.
 *
 * Because edits have already been applied, the real file currently holds the
 * `newStr` of each patch. We reverse-apply them (newStr → oldStr) on top of the
 * current file content to recover the pre-turn version. For new files the
 * "before" is empty.
 */
export async function openFileDiff(
  provider: DiffDocumentProvider,
  filePath: string,
  edits: EditPatch[],
  isNewFile: boolean,
  workdir: string,
): Promise<void> {
  const abs = resolveAbs(filePath, workdir);
  const fileUri = vscode.Uri.file(abs);

  let current = "";
  try {
    current = await readFile(abs, "utf8");
  } catch {
    // File gone (or never written here) — fall back to opening it directly.
    await vscode.commands.executeCommand("vscode.open", fileUri, {
      viewColumn: vscode.ViewColumn.Beside,
    });
    return;
  }

  let before = current;
  if (isNewFile) {
    before = "";
  } else {
    // Reverse-apply each patch: newStr → oldStr. Skip patches whose newStr is
    // no longer present (file changed since) so we don't silently corrupt.
    for (const p of edits) {
      if (p.newStr && before.includes(p.newStr)) {
        before = before.replace(p.newStr, p.oldStr);
      }
    }
  }

  // No reconstruction happened and not a new file → nothing to show as a diff;
  // just open the file.
  if (!isNewFile && before === current) {
    await vscode.commands.executeCommand("vscode.open", fileUri, {
      viewColumn: vscode.ViewColumn.Beside,
    });
    return;
  }

  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const proposalUri = vscode.Uri.from({
    scheme: DIFF_SCHEME,
    authority: "proposal",
    path: `/proposal-${id}${extensionFor(abs)}`,
  });
  provider.set(proposalUri, before);

  const label = `${path.basename(abs)} · agent changes`;
  await vscode.commands.executeCommand("vscode.diff", proposalUri, fileUri, label, {
    preview: false,
    viewColumn: vscode.ViewColumn.Beside,
  });
}
