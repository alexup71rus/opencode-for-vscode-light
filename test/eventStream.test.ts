import { test } from "node:test";
import assert from "node:assert/strict";

import { EventStream } from "../src/bridge/eventStream";

/**
 * Minimal fake of OpenCodeClient.subscribeEvents. Each call returns a new
 * async generator. The generator yields one event, then blocks until the
 * signal is aborted. Tracks how many generators are currently alive so
 * tests can assert that at most one SSE stream is held at any time.
 *
 * Important: the generator body runs synchronously up to the first yield
 * the moment iter.next() is first called by the consumer's `for await`.
 * That means the "started" notification must be registered before
 * stream.start() is invoked — see the `nextStart()` helper usage below.
 */
class FakeClient {
  readonly activeSubscriptions = new Set<number>();
  private nextId = 0;
  private pendingStartResolver: (() => void) | null = null;

  subscribeEvents(signal?: AbortSignal) {
    return this.makeStream(signal);
  }

  /**
   * Register a resolver to be called when the NEXT subscription's generator
   * body starts running. Must be called BEFORE the EventStream method that
   * triggers the subscription (start / restart), because the generator's
   * initial sync section consumes the resolver during that call.
   */
  nextStart(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.pendingStartResolver = resolve;
    });
  }

  private async *makeStream(signal?: AbortSignal) {
    const id = this.nextId++;
    this.activeSubscriptions.add(id);
    const started = this.pendingStartResolver;
    this.pendingStartResolver = null;
    if (started) started();

    try {
      yield { type: "server.connected", properties: {} };
      // Block until aborted. The connect loop's stop()/restart() abort the
      // controller; once aborted we exit and the finally cleans up.
      while (!signal?.aborted) {
        await new Promise<void>((resolve) => {
          const t = setInterval(() => {
            if (signal?.aborted) {
              clearInterval(t);
              resolve();
            }
          }, 5);
        });
      }
    } finally {
      this.activeSubscriptions.delete(id);
    }
  }
}

function tick(ms = 10): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

test("start() then stop() leaves no active subscription", async () => {
  const client = new FakeClient();
  const stream = new EventStream(client as never);

  const started = client.nextStart();
  await stream.start();
  await started;
  assert.equal(client.activeSubscriptions.size, 1);

  await stream.stop();
  assert.equal(client.activeSubscriptions.size, 0);
});

test("restart() never holds two subscriptions at once", async () => {
  const client = new FakeClient();
  const stream = new EventStream(client as never);

  const started1 = client.nextStart();
  await stream.start();
  await started1;
  assert.equal(client.activeSubscriptions.size, 1);

  const started2 = client.nextStart();
  await stream.restart();
  await started2;

  assert.equal(
    client.activeSubscriptions.size,
    1,
    "exactly one subscription should be active after restart",
  );

  await stream.stop();
  assert.equal(client.activeSubscriptions.size, 0);
});

test("two rapid restart() calls do not leak streams or throw", async () => {
  const client = new FakeClient();
  const stream = new EventStream(client as never);

  const started1 = client.nextStart();
  await stream.start();
  await started1;

  // Fire restart twice without awaiting between calls. The chain serialises
  // them; the second restart's ++generation wins cleanly and only the
  // final connect loop survives.
  const p1 = stream.restart();
  const p2 = stream.restart();
  await Promise.allSettled([p1, p2]);

  await tick(20);

  assert.ok(
    client.activeSubscriptions.size <= 1,
    `expected at most 1 active subscription, got ${client.activeSubscriptions.size}`,
  );

  await stream.stop();
  assert.equal(client.activeSubscriptions.size, 0);
});

test("stop() resolves only after the connect loop has exited", async () => {
  const client = new FakeClient();
  const stream = new EventStream(client as never);

  const started = client.nextStart();
  await stream.start();
  await started;

  let stopResolved = false;
  const stopPromise = stream.stop().then(() => {
    stopResolved = true;
  });

  await stopPromise;
  assert.equal(stopResolved, true);
  assert.equal(client.activeSubscriptions.size, 0);
});

test("calling start() twice does not start two loops", async () => {
  const client = new FakeClient();
  const stream = new EventStream(client as never);

  const started = client.nextStart();
  await stream.start();
  await started;
  await stream.start(); // no-op (already running)
  await tick(20);

  assert.equal(client.activeSubscriptions.size, 1);

  await stream.stop();
});

test("stop() is idempotent", async () => {
  const client = new FakeClient();
  const stream = new EventStream(client as never);

  const started = client.nextStart();
  await stream.start();
  await started;

  await stream.stop();
  await stream.stop();
  await stream.stop();

  assert.equal(client.activeSubscriptions.size, 0);
});

test("start() after stop() begins a fresh stream", async () => {
  const client = new FakeClient();
  const stream = new EventStream(client as never);

  const started1 = client.nextStart();
  await stream.start();
  await started1;
  await stream.stop();
  assert.equal(client.activeSubscriptions.size, 0);

  const started2 = client.nextStart();
  await stream.start();
  await started2;
  assert.equal(client.activeSubscriptions.size, 1);

  await stream.stop();
  assert.equal(client.activeSubscriptions.size, 0);
});

test("restart() after stop() begins a fresh stream", async () => {
  const client = new FakeClient();
  const stream = new EventStream(client as never);

  const started1 = client.nextStart();
  await stream.start();
  await started1;
  await stream.stop();
  assert.equal(client.activeSubscriptions.size, 0);

  const started2 = client.nextStart();
  await stream.restart();
  await started2;
  assert.equal(client.activeSubscriptions.size, 1);

  await stream.stop();
  assert.equal(client.activeSubscriptions.size, 0);
});

test("concurrent stop() and restart() do not race: final state is deterministic", async () => {
  // Without the chain, calling stop() and restart() concurrently could
  // leave the stream running even after stop() resolved (restart might
  // flip running back to true after stop's await). The chain serialises
  // them so the order of operations is well-defined: whichever was
  // enqueued first runs first; the second sees the resulting state and
  // applies its own transition on top. Final state is therefore a pure
  // function of the call order, not of microtask scheduling.
  const client = new FakeClient();
  const stream = new EventStream(client as never);

  const started1 = client.nextStart();
  await stream.start();
  await started1;

  // Register the next-subscription resolver BEFORE firing stop/restart,
  // otherwise restart's makeStream runs before nextStart can register
  // and the await never resolves.
  const nextSubscription = client.nextStart();

  // stop enqueued before restart: stop runs (stream torn down), then
  // restart runs (new stream brought up). After both settle the stream
  // must be running with exactly one subscription.
  await Promise.all([stream.stop(), stream.restart()]);
  await nextSubscription;

  assert.equal(client.activeSubscriptions.size, 1);

  await stream.stop();
  assert.equal(client.activeSubscriptions.size, 0);
});

test("stop() followed immediately by restart(): stop wins, then restart runs", async () => {
  // Queue order is preserved: stop runs to completion first (its contract
  // "running === false when resolved" holds at resolve time), then restart
  // queues up and runs. This guards against the original race where stop
  // and restart could interleave their state mutations.
  const client = new FakeClient();
  const stream = new EventStream(client as never);

  const started1 = client.nextStart();
  await stream.start();
  await started1;

  // stop resolves before restart even begins (chain guarantees this).
  await stream.stop();
  assert.equal(client.activeSubscriptions.size, 0);

  const started2 = client.nextStart();
  await stream.restart();
  await started2;
  assert.equal(client.activeSubscriptions.size, 1);

  await stream.stop();
});
