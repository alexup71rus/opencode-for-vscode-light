import * as fs from "fs";
import * as path from "path";

/**
 * Append-only error/event logger that survives VS Code reloads. The Output
 * channel is volatile (cleared on reload), so when the extension hangs or
 * crashes there's no post-mortem trail. This writes to a file in the
 * extension's globalStorage, which persists.
 *
 * Scope is deliberately minimal: only errors and SSE disconnects. Normal
 * operation produces zero log lines.
 */
const MAX_BYTES = 5 * 1024 * 1024; // 5 MB cap; over that, keep the back half.

export class FileLogger {
  private filePath: string;
  private enabled: boolean;

  constructor(globalStoragePath: string, enabled: boolean) {
    this.filePath = path.join(globalStoragePath, "error.log");
    this.enabled = enabled;
    try {
      fs.mkdirSync(globalStoragePath, { recursive: true });
    } catch {
      // Directory may already exist; ignore.
    }
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  log(message: string): void {
    if (!this.enabled) return;
    const line = `${new Date().toISOString()}  ${message}\n`;
    try {
      this.rotateIfNeeded();
      fs.appendFileSync(this.filePath, line, "utf8");
    } catch {
      // Disk full / permissions — nothing we can do; swallow to avoid
      // masking the original error being reported.
    }
  }

  error(err: unknown, action: string): void {
    const detail = err instanceof Error ? `${err.message}${err.stack ? `\n${err.stack}` : ""}` : String(err);
    this.log(`ERROR  failed to ${action}: ${detail}`);
  }

  getFilePath(): string {
    return this.filePath;
  }

  private rotateIfNeeded(): void {
    try {
      const stat = fs.statSync(this.filePath);
      if (stat.size < MAX_BYTES) return;
      // Keep the back half (most recent entries).
      const content = fs.readFileSync(this.filePath, "utf8");
      const half = Math.floor(content.length / 2);
      const cut = content.indexOf("\n", half);
      const kept = cut >= 0 ? content.slice(cut + 1) : content.slice(half);
      fs.writeFileSync(this.filePath, kept, "utf8");
    } catch {
      // File doesn't exist yet or can't be read — nothing to rotate.
    }
  }
}
