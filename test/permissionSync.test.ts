import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "events";

import { SessionService } from "../src/services/sessionService";
import { OpenCodeClientError } from "../src/bridge/errors";

/**
 * These tests lock in the permission-desync fixes:
 *   A. A successful reply drops the entry from the authoritative map (no phantom
 *      re-surfacing on the next pushInitialState).
 *   B. A 400/404 reply is treated as stale (dropped + card cleared), while a
 *      transient error keeps the entry and rethrows.
 *   C. On reconnect, pending permissions for non-busy sessions are cleared;
 *      busy sessions keep theirs.
 *
 * The service only touches `client.replyPermission` and (for reconnect)
 * `client.listSessions` / `client.getSessionStatus`, so the fake implements
 * just those.
 */

interface ReplyOutcome {
  ok?: boolean;
  status?: number; // when set (and not ok), throw an OpenCodeClientError w/ status
}

class FakeClient {
  replyCalls: Array<{ sessionId: string; permissionId: string; decision: string }> = [];
  nextReply: ReplyOutcome = { ok: true };
  sessions: Array<{ id: string }> = [];
  statuses: Record<string, { type: string }> = {};

  async replyPermission(sessionId: string, permissionId: string, decision: string): Promise<void> {
    this.replyCalls.push({ sessionId, permissionId, decision });
    if (this.nextReply.ok) return;
    throw new OpenCodeClientError("reply failed", this.nextReply.status);
  }

  async listSessions() {
    return this.sessions;
  }

  async getSessionStatus() {
    return this.statuses;
  }
}

/** Build a service with a permission already seeded in the authoritative map
 *  via the real `permission.asked` event path. */
function makeService(): { service: SessionService; client: FakeClient; stream: EventEmitter } {
  const client = new FakeClient();
  const stream = new EventEmitter();
  const service = new SessionService(client as never, stream as never);
  // subscribe() wires the handlers; it's private, so drive via start()'s public
  // surface would hit the network. Instead attach the same listeners the
  // service uses by re-emitting through its subscribe path: simplest is to call
  // the private subscribe via a cast.
  (service as unknown as { subscribe(): void }).subscribe();
  return { service, client, stream };
}

function seedPermission(stream: EventEmitter, sessionId: string, id: string): void {
  stream.emit("permission.asked", {
    id,
    sessionID: sessionId,
    permission: "bash",
    tool: { messageID: "m1", callID: "c1" },
  });
}

test("A: successful reply removes the permission from the authoritative map", async () => {
  const { service, client, stream } = makeService();
  seedPermission(stream, "s1", "p1");
  assert.equal(service.getPendingPermissions("s1").length, 1);

  const replied: string[] = [];
  service.on("permissionReplied", (p: { permissionID: string }) => replied.push(p.permissionID));

  client.nextReply = { ok: true };
  await service.replyPermission("s1", "p1", "once");

  assert.equal(service.getPendingPermissions("s1").length, 0, "map entry dropped");
  assert.deepEqual(replied, ["p1"], "permissionReplied emitted once");
});

test("B: 404 reply is treated as stale — dropped and card cleared, no throw", async () => {
  const { service, client, stream } = makeService();
  seedPermission(stream, "s1", "p1");

  const replied: string[] = [];
  service.on("permissionReplied", (p: { permissionID: string }) => replied.push(p.permissionID));

  client.nextReply = { ok: false, status: 404 };
  await assert.doesNotReject(() => service.replyPermission("s1", "p1", "once"));

  assert.equal(service.getPendingPermissions("s1").length, 0, "stale entry dropped");
  assert.deepEqual(replied, ["p1"], "card cleared");
});

test("B: 400 reply is also treated as stale", async () => {
  const { service, client, stream } = makeService();
  seedPermission(stream, "s1", "p1");
  client.nextReply = { ok: false, status: 400 };
  await assert.doesNotReject(() => service.replyPermission("s1", "p1", "reject"));
  assert.equal(service.getPendingPermissions("s1").length, 0);
});

test("B: transient (500) reply keeps the entry and rethrows", async () => {
  const { service, client, stream } = makeService();
  seedPermission(stream, "s1", "p1");

  const replied: string[] = [];
  service.on("permissionReplied", (p: { permissionID: string }) => replied.push(p.permissionID));

  client.nextReply = { ok: false, status: 500 };
  await assert.rejects(() => service.replyPermission("s1", "p1", "once"), /reply failed/);

  assert.equal(service.getPendingPermissions("s1").length, 1, "entry kept for retry");
  assert.deepEqual(replied, [], "card not cleared on transient failure");
});

test("B: network error (no status) keeps the entry and rethrows", async () => {
  const { service, client, stream } = makeService();
  seedPermission(stream, "s1", "p1");
  client.nextReply = { ok: false, status: undefined };
  await assert.rejects(() => service.replyPermission("s1", "p1", "once"));
  assert.equal(service.getPendingPermissions("s1").length, 1);
});

test("C: reconnect clears permissions for idle sessions, keeps busy ones", async () => {
  const { service, client, stream } = makeService();
  seedPermission(stream, "idle-session", "p-idle");
  seedPermission(stream, "busy-session", "p-busy");
  assert.equal(service.getPendingPermissions("idle-session").length, 1);
  assert.equal(service.getPendingPermissions("busy-session").length, 1);

  // After reconnect the server reports busy-session as still generating.
  client.sessions = [{ id: "idle-session" }, { id: "busy-session" }];
  client.statuses = { "busy-session": { type: "busy" } };

  const replied: Array<{ sessionId: string; permissionID: string }> = [];
  service.on("permissionReplied", (p: { sessionId: string; permissionID: string }) => replied.push(p));

  stream.emit("server.connected");
  // reconcileOnReconnect awaits refreshSessions; let microtasks flush.
  await new Promise((r) => setTimeout(r, 20));

  assert.equal(service.getPendingPermissions("idle-session").length, 0, "idle cleared");
  assert.equal(service.getPendingPermissions("busy-session").length, 1, "busy kept");
  assert.deepEqual(replied, [{ sessionId: "idle-session", permissionID: "p-idle" }]);
});
