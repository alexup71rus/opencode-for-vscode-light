import { EventEmitter } from "events";
import type { OpenCodeClient } from "./openCodeClient";

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

export class EventStream extends EventEmitter {
  private readonly client: OpenCodeClient;
  private abortController: AbortController | null = null;
  private running = false;
  private sleepTimer: NodeJS.Timeout | undefined = undefined;
  private sleepResolver: (() => void) | null = null;
  private generation = 0;
  private activeConnect: Promise<void> = Promise.resolve();

  constructor(client: OpenCodeClient) {
    super();
    this.client = client;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.activeConnect = this.connect(++this.generation);
  }

  /**
   * Stop the stream and wait until the active connect loop has fully exited.
   *
   * Honest semantics: by the time the returned promise resolves, no connect
   * loop is running and no SSE subscription is held. Callers that cannot
   * block indefinitely (e.g. extension shutdown) should race this with a
   * timeout at the call site rather than weakening the contract here.
   */
  async stop(): Promise<void> {
    this.running = false;
    this.cancelWait();
    await this.activeConnect;
  }

  /**
   * Atomically swap the connection: abort the old connect loop, wait for it
   * to fully tear down its SSE subscription, then start a fresh one. Without
   * the awaited shutdown two concurrent SSE streams could briefly coexist
   * and the dying loop could null out the new loop's abortController in its
   * finally block.
   */
  async restart(): Promise<void> {
    const gen = ++this.generation;
    this.running = false;
    this.cancelWait();
    await this.activeConnect;
    this.running = true;
    this.activeConnect = this.connect(gen);
  }

  private cancelWait(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    if (this.sleepTimer) {
      clearTimeout(this.sleepTimer);
      this.sleepTimer = undefined;
    }
    if (this.sleepResolver) {
      const resolve = this.sleepResolver;
      this.sleepResolver = null;
      resolve();
    }
  }

  private async connect(gen: number): Promise<void> {
    let delay = RECONNECT_BASE_MS;

    while (this.running && gen === this.generation) {
      this.abortController = new AbortController();
      try {
        const stream = this.client.subscribeEvents(this.abortController.signal);
        this.emit("server.connected");
        delay = RECONNECT_BASE_MS;

        for await (const event of stream) {
          if (!this.running || gen !== this.generation) break;
          this.emit(event.type, event.properties);
        }
      } catch (err) {
        if (!this.running || gen !== this.generation) break;
        this.emit("stream.error", err);
      } finally {
        if (this.abortController) {
          this.abortController = null;
        }
      }

      if (!this.running || gen !== this.generation) break;

      await this.interruptibleSleep(delay);
      delay = Math.min(delay * 2, RECONNECT_MAX_MS);
    }
  }

  private interruptibleSleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      this.sleepResolver = () => resolve();
      this.sleepTimer = setTimeout(() => {
        this.sleepTimer = undefined;
        this.sleepResolver = null;
        resolve();
      }, ms);
    });
  }
}
