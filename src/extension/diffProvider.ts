import * as path from "path";
import * as vscode from "vscode";
import { readFile } from "fs/promises";

export const DIFF_SCHEME = "opencode-diff";

/**
 * Pick the view column file editors/diffs should open in.
 *
 * The chat webview occupies its own group; we must never open a diff "Beside"
 * because Beside is resolved relative to the CURRENTLY ACTIVE group — and when
 * the user clicks a chip inside the chat, the active group IS the webview, so
 * Beside splits a new group to the right of the chat every time.
 *
 * Strategy: find the first tab group that is not the webview's own group
 * (identified by its live viewColumn, passed in) and reuse its column so diffs
 * stack as tabs there. If no such group exists (chat-only layout), target the
 * lowest column that is not the webview's — creating exactly one group to the
 * webview's left, deterministically, instead of an active-relative split.
 */
function pickEditorViewColumn(
  webviewColumn: vscode.ViewColumn | undefined,
): vscode.ViewColumn {
  const groups = vscode.window.tabGroups.all;

  // A concrete file-editor group we can stack tabs into: any group whose
  // column differs from the webview's. (Empty groups have no column collision
  // risk; we simply skip the webview's own.)
  const target = groups.find(
    (g) => g.viewColumn !== webviewColumn && g.tabs.length > 0,
  );
  if (target) {
    return target.viewColumn;
  }

  // No non-webview editor group exists. Deterministically target One (or the
  // column just left of the webview) rather than Beside, which would split
  // relative to the active (webview) group.
  return webviewColumn && webviewColumn > vscode.ViewColumn.One
    ? ((webviewColumn - 1) as vscode.ViewColumn)
    : vscode.ViewColumn.One;
}

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

// Deliberately NOT confined to the workspace root. Agents legitimately edit
// files outside the workspace (global config, monorepo roots, MCP-managed
// resources, dotfiles). A startsWith(workdir) check would break diff previews
// for those files, and a realpath-based check would reject symlinks inside the
// workspace. Paths originate from the agent's tool-call output (not user
// input) and the content is shown locally — there is no remote exfiltration
// vector. See test/verify-findings.test.ts for empirical confirmation.
function resolveAbs(filePath: string, workdir: string): string {
  return path.isAbsolute(filePath) ? filePath : path.join(workdir, filePath);
}

function extensionFor(absPath: string): string {
  const ext = path.extname(absPath);
  return ext || ".txt";
}

/**
 * Reconstruct the "before this turn" content of a file the agent changed,
 * alongside its current on-disk content ("after"). Pure: no VS Code commands,
 * no provider mutation — used both by the native diff path and the webview
 * modal path.
 *
 * Returns `{ error }` if the file can't be read (missing/deleted). For a
 * non-new file whose patches no longer match the current content, `before`
 * may equal `after` — callers decide how to surface that.
 */
export type ReconstructedDiff =
  | { before: string; after: string; label: string }
  | { error: string };

export async function reconstructFileDiff(
  filePath: string,
  edits: EditPatch[],
  isNewFile: boolean,
  workdir: string,
): Promise<ReconstructedDiff> {
  const abs = resolveAbs(filePath, workdir);
  try {
    const after = await readFile(abs, "utf8");
    let before = after;
    if (isNewFile) {
      before = "";
    } else {
      // Reverse-apply each patch: newStr -> oldStr. Skip patches whose newStr
      // is no longer present (file changed since) so we don't corrupt content.
      for (const p of edits) {
        if (p.newStr && before.includes(p.newStr)) {
          before = before.replace(p.newStr, p.oldStr);
        }
      }
    }
    const label = `${path.basename(abs)} · agent changes`;
    return { before, after, label };
  } catch {
    return { error: "This file no longer exists on disk." };
  }
}

/**
 * Open a native VS Code diff for a file the agent changed: the left side is the
 * reconstructed "before this turn" content, the right side is the real file.
 * Delegates reconstruction to `reconstructFileDiff`.
 */
export async function openFileDiff(
  provider: DiffDocumentProvider,
  filePath: string,
  edits: EditPatch[],
  isNewFile: boolean,
  workdir: string,
  webviewColumn?: vscode.ViewColumn,
): Promise<void> {
  const abs = resolveAbs(filePath, workdir);
  const fileUri = vscode.Uri.file(abs);

  const r = await reconstructFileDiff(filePath, edits, isNewFile, workdir);
  if ("error" in r) {
    // File gone (or never written here) — fall back to opening it directly.
    await vscode.commands.executeCommand("vscode.open", fileUri, {
      viewColumn: pickEditorViewColumn(webviewColumn),
      preserveFocus: false,
    });
    return;
  }

  const { before, after, label } = r;

  // No reconstruction happened and not a new file → nothing to show as a diff;
  // just open the file.
  if (!isNewFile && before === after) {
    await vscode.commands.executeCommand("vscode.open", fileUri, {
      viewColumn: pickEditorViewColumn(webviewColumn),
      preserveFocus: false,
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

  // Reuse the existing file-editor group (via pickEditorViewColumn) so every
  // diff lands as a new tab in that same group instead of splitting off a
  // fresh group each time — "Beside" is relative to whichever editor is
  // currently active, so repeated calls (e.g. active editor is the previous
  // diff tab) would otherwise keep opening new splits instead of reusing it.
  await vscode.commands.executeCommand("vscode.diff", proposalUri, fileUri, label, {
    preview: false,
    preserveFocus: false,
    viewColumn: pickEditorViewColumn(webviewColumn),
  });
}
