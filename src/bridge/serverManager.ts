import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import * as crypto from "node:crypto";
import * as net from "node:net";

export interface ServerInfo {
  url: string;
  authHeader: string;
  isManaged: boolean;
}

const LISTENING_RE = /opencode server listening on (https?:\/\/[^\s]+)/i;
const STARTUP_TIMEOUT_MS = 15_000;
const HEALTH_CHECK_ATTEMPTS = 40;
const HEALTH_CHECK_DELAY_MS = 250;

export class ServerManager {
  private child: ChildProcess | null = null;
  private info: ServerInfo | null = null;
  private readonly hostname: string;

  constructor(
    private readonly binaryPath: string,
    private readonly externalUrl?: string,
    private readonly externalPassword?: string,
    hostname: string = "127.0.0.1",
    private readonly log?: (line: string) => void,
  ) {
    this.hostname = hostname;
  }

  static detectBinaryPath(configPath?: string): string | null {
    if (configPath && configPath.trim().length > 0) {
      return configPath.trim();
    }
    const finder = process.platform === "win32" ? "where" : "which";
    try {
      const result = spawnSync(finder, ["opencode"], { encoding: "utf-8" });
      if (result.status === 0 && result.stdout.trim().length > 0) {
        return result.stdout.trim().split(/\r?\n/)[0]!.trim();
      }
    } catch {
      // ignore and fall through
    }
    return null;
  }

  getServerInfo(): ServerInfo | null {
    return this.info;
  }

  async ensureServer(workdir: string): Promise<ServerInfo> {
    if (this.info) {
      return this.info;
    }
    if (this.externalUrl && this.externalUrl.trim().length > 0) {
      this.info = await this.connectExternal();
      return this.info;
    }
    this.info = await this.spawnManaged(workdir);
    return this.info;
  }

  private async connectExternal(): Promise<ServerInfo> {
    const url = this.externalUrl!.trim().replace(/\/+$/, "");
    const password = this.externalPassword && this.externalPassword.trim().length > 0
      ? this.externalPassword.trim()
      : "";
    const authHeader = makeAuthHeader(password);
    await this.healthCheck(url, authHeader);
    return { url, authHeader, isManaged: false };
  }

  private async spawnManaged(workdir: string): Promise<ServerInfo> {
    const binary = ServerManager.detectBinaryPath(this.binaryPath);
    if (!binary) {
      throw new Error(
        "opencode binary not found. Install opencode or set the 'opencode.binaryPath' setting.",
      );
    }

    const port = await findFreePort(this.hostname);
    const password = crypto.randomUUID();
    const authHeader = makeAuthHeader(password);

    const child = spawn(
      binary,
      ["serve", "--port", String(port), "--hostname", this.hostname],
      {
        cwd: workdir,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, OPENCODE_SERVER_PASSWORD: password },
      },
    );
    this.child = child;

    let actualUrl: string;
    try {
      actualUrl = await this.waitForListening(child, port);
      await this.healthCheck(actualUrl, authHeader);
    } catch (err) {
      void this.dispose();
      throw err;
    }

    this.attachStreamDrain(child);

    child.once("exit", (code, signal) => {
      this.child = null;
      // Clear stale info so ensureServer() will respawn on next call instead
      // of handing out a dead URL to callers.
      this.info = null;
      const detail = code !== null ? `code ${code}` : `signal ${signal}`;
      this.log?.(`[server] process exited (${detail})`);
    });

    return { url: actualUrl, authHeader, isManaged: true };
  }

  /**
   * Drain stdout/stderr for the lifetime of the child. Once the startup
   * listener is detached by waitForListening(), nobody reads the pipes —
   * the OS buffer (~64KB) fills up and the child blocks on write. This
   * attaches permanent flowing-mode listeners that consume data regardless
   * of whether a logger is configured.
   */
  private attachStreamDrain(child: ChildProcess): void {
    this.drainStream(child.stdout, "stdout");
    this.drainStream(child.stderr, "stderr");
  }

  private drainStream(
    stream: NodeJS.ReadableStream | null,
    label: string,
  ): void {
    if (!stream) return;
    if (this.log) {
      let pending = "";
      stream.on("data", (chunk: Buffer | string) => {
        pending += chunk.toString();
        const lines = pending.split(/\r?\n/);
        pending = lines.pop() ?? "";
        for (const line of lines) {
          if (line.length > 0) this.log!(`[${label}] ${line}`);
        }
      });
    } else {
      // No logger — still must drain to prevent pipe-buffer deadlock.
      stream.on("data", () => {});
    }
  }

  private waitForListening(child: ChildProcess, fallbackPort: number): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      let settled = false;
      let buffer = "";
      let timer: NodeJS.Timeout | undefined;

      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        child.stdout?.off("data", onData);
        child.stderr?.off("data", onData);
        child.off("error", onError);
        child.off("exit", onExit);
        if (timer) clearTimeout(timer);
        fn();
      };

      const onData = (chunk: Buffer | string) => {
        buffer += chunk.toString();
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const match = LISTENING_RE.exec(line);
          if (match) {
            finish(() => resolve(match[1]));
            return;
          }
        }
      };

      const onError = (err: Error) => {
        finish(() =>
          reject(new Error(`Failed to start opencode server: ${err.message}`)),
        );
      };

      const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
        finish(() =>
          reject(
            new Error(
              `opencode server exited${code !== null ? ` with code ${code}` : ` via signal ${signal}`} before becoming ready.`,
            ),
          ),
        );
      };

      child.stdout?.on("data", onData);
      child.stderr?.on("data", onData);
      child.on("error", onError);
      child.on("exit", onExit);

      timer = setTimeout(() => {
        finish(() => resolve(`http://${this.hostname}:${fallbackPort}`));
      }, STARTUP_TIMEOUT_MS);
    });
  }

  private async healthCheck(url: string, authHeader: string): Promise<void> {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < HEALTH_CHECK_ATTEMPTS; attempt++) {
      try {
        const res = await fetch(`${url}/config`, {
          headers: { Authorization: authHeader },
        });
        if (res.ok) {
          return;
        }
        lastError = new Error(`unexpected HTTP ${res.status} ${res.statusText}`);
      } catch (err) {
        lastError = err;
      }
      await sleep(HEALTH_CHECK_DELAY_MS);
    }
    throw new Error(
      `opencode server health check failed at ${url}: ${formatError(lastError)}`,
    );
  }

  async dispose(): Promise<void> {
    this.info = null;
    const child = this.child;
    if (child) {
      this.child = null;
      await terminate(child);
    }
  }
}

function makeAuthHeader(password: string): string {
  return "Basic " + Buffer.from(`opencode:${password}`, "utf8").toString("base64");
}

function findFreePort(hostname?: string): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, hostname, () => {
      const address = server.address();
      if (address && typeof address === "object" && typeof address.port === "number") {
        const port = address.port;
        server.close(() => resolve(port));
      } else {
        server.close();
        reject(new Error("Unable to determine a free port."));
      }
    });
  });
}

function terminate(child: ChildProcess): Promise<void> {
  return new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    let done = false;
    const settle = () => {
      if (done) return;
      done = true;
      resolve();
    };
    child.once("exit", settle);
    try {
      child.kill("SIGTERM");
    } catch {
      // ignore
    }
    const escalation = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        try {
          child.kill("SIGKILL");
        } catch {
          // ignore
        }
      }
    }, 3000);
    setTimeout(() => {
      clearTimeout(escalation);
      settle();
    }, 5000);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
