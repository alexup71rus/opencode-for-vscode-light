import { EventEmitter } from "events";
import type { OpenCodeClient } from "./openCodeClient";

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

export class EventStream extends EventEmitter {
  private readonly client: OpenCodeClient;
  private abortController: AbortController | null = null;
  private running = false;
  private sleepTimer: NodeJS.Timeout | undefined = undefined;

  constructor(client: OpenCodeClient) {
    super();
    this.client = client;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.connect();
  }

  stop(): void {
    this.running = false;
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    if (this.sleepTimer) {
      clearTimeout(this.sleepTimer);
      this.sleepTimer = undefined;
    }
  }

  private async connect(): Promise<void> {
    let delay = RECONNECT_BASE_MS;

    while (this.running) {
      this.abortController = new AbortController();
      try {
        const stream = this.client.subscribeEvents(this.abortController.signal);
        this.emit("server.connected");
        delay = RECONNECT_BASE_MS;

        for await (const event of stream) {
          if (!this.running) break;
          this.emit(event.type, event.properties);
        }
      } catch (err) {
        if (!this.running) break;
        this.emit("stream.error", err);
      } finally {
        this.abortController = null;
      }

      if (!this.running) break;

      await this.interruptibleSleep(delay);
      delay = Math.min(delay * 2, RECONNECT_MAX_MS);
    }
  }

  private interruptibleSleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      this.sleepTimer = setTimeout(() => {
        this.sleepTimer = undefined;
        resolve();
      }, ms);
    });
  }
}
