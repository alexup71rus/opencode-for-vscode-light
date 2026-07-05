import type { MessageWithParts } from "./api/types";
import { asString, extractFilePath } from "./diff";

export interface EditPatch {
  oldStr: string;
  newStr: string;
}

export interface FileChange {
  filePath: string;
  edits: EditPatch[];
  isNewFile: boolean;
  /** rough line counts for display */
  additions: number;
  deletions: number;
}

const EDIT_TOOLS = new Set(["edit", "str_replace", "replace"]);
const WRITE_TOOLS = new Set(["write"]);

/**
 * Derive the set of files an agent touched from a list of messages, grouping
 * all edits/writes per file. Only completed (non-error) tool calls count — an
 * errored edit changed nothing. This is the reliable source of "what changed"
 * since the server's /session/{id}/diff and /file/status endpoints are empty
 * on opencode 1.17.x.
 *
 * When `afterMessageId` is provided, only messages strictly newer than that
 * baseline are considered. This supports the "Apply" action, which marks the
 * current set of changes as reviewed so the list reflects only subsequent
 * edits. Files on disk are not affected by the baseline.
 */
export function extractFileChanges(messages: MessageWithParts[], afterMessageId?: string): FileChange[] {
  let considered = messages;
  if (afterMessageId) {
    const idx = messages.findIndex((m) => m.info.id === afterMessageId);
    if (idx >= 0) considered = messages.slice(idx + 1);
  }
  const byFile = new Map<string, FileChange>();
  for (const msg of considered) {
    for (const part of msg.parts) {
      if (part.type !== "tool") continue;
      const state = part.state as { status?: string; input?: Record<string, unknown> | null };
      if (state.status === "error") continue;
      const input = state.input;
      if (!input || typeof input !== "object") continue;
      const tool = part.tool.toLowerCase();
      const filePath = extractFilePath(input);
      if (!filePath) continue;

      const isEdit = EDIT_TOOLS.has(tool);
      const isWrite = WRITE_TOOLS.has(tool);
      if (!isEdit && !isWrite) continue;

      let entry = byFile.get(filePath);
      if (!entry) {
        entry = { filePath, edits: [], isNewFile: false, additions: 0, deletions: 0 };
        byFile.set(filePath, entry);
      }

      if (isEdit) {
        const oldStr = asString(input.oldString) ?? asString(input.old_str) ?? "";
        const newStr = asString(input.newString) ?? asString(input.new_str) ?? "";
        entry.edits.push({ oldStr, newStr });
        const oldLines = oldStr ? oldStr.split("\n").length : 0;
        const newLines = newStr ? newStr.split("\n").length : 0;
        // Rough: net added/removed lines for this hunk.
        if (newLines >= oldLines) {
          entry.additions += newLines - oldLines;
        } else {
          entry.deletions += oldLines - newLines;
        }
      } else {
        // write — new file (or full overwrite). Treat as all-added.
        entry.isNewFile = true;
        const content = asString(input.content) ?? "";
        entry.additions += content ? content.split("\n").length : 0;
      }
    }
  }
  return Array.from(byFile.values());
}
