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
  /**
   * Serialises start/stop/restart. Each public method delegates to a private
   * doXxx op and runs it through this chain so concurrent callers cannot
   * interleave their state mutations: e.g. a stop() whose await races a
   * restart() cannot have its "running stays false" contract violated by
   * the restart setting running=true mid-flight.
   */
  private chain: Promise<void> = Promise.resolve();

  constructor(client: OpenCodeClient) {
    super();
    this.client = client;
  }

  async start(): Promise<void> {
    await this.enqueue(() => this.doStart());
  }

  /**
   * Stop the stream and wait until the active connect loop has fully exited.
   *
   * Honest semantics: by the time the returned promise resolves, no connect
   * loop is running and no SSE subscription is held. The internal chain
   * additionally guarantees that if a restart() was issued concurrently
   * (before this stop() began executing), it runs first; once stop()
   * resolves the stream is genuinely stopped — no later queued op can have
   * raced ahead to flip running back to true.
   *
   * Callers that cannot block indefinitely (e.g. extension shutdown) should
   * race this with a timeout at the call site rather than weakening the
   * contract here.
   */
  async stop(): Promise<void> {
    await this.enqueue(() => this.doStop());
  }

  /**
   * Atomically swap the connection: abort the old connect loop, wait for it
   * to fully tear down its SSE subscription, then start a fresh one. The
   * chain serialises this against concurrent stop()/start() calls so the
   * only state transitions that happen during restart are restart's own.
   */
  async restart(): Promise<void> {
    await this.enqueue(() => this.doRestart());
  }

  private enqueue(op: () => Promise<void>): Promise<void> {
    // Run op whether the previous link resolved or rejected (a failing
    // stop()/start() must not poison the chain for the next caller).
    const run = this.chain.then(op, op);
    // Swallow rejections on the persistent chain link so a throwing op
    // never breaks subsequent operations. The originating caller still
    // observes the rejection via `run`.
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async doStart(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.activeConnect = this.connect(++this.generation);
  }

  private async doStop(): Promise<void> {
    this.running = false;
    this.cancelWait();
    await this.activeConnect;
  }

  private async doRestart(): Promise<void> {
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
