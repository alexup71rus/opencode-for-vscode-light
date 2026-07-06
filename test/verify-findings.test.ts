/**
 * Verification tests for code-review findings.
 *
 * Each test empirically confirms or debunks a specific claim from the review,
 * so that the fix/don't-fix decision is based on observed behaviour, not just
 * code reading.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { EventEmitter } from "node:events";

import { ServerManager } from "../src/bridge/serverManager";
import type { ServerInfo } from "../src/bridge/serverManager";
import { reconstructFileDiff } from "../src/extension/diffProvider";
import { SessionService } from "../src/services/sessionService";
import type { Permission } from "@opencode-ai/sdk";

// ─────────────────────────────────────────────────────────────────────────────
// Finding #4 (Critical): ServerManager.ensureServer race condition
// Claim: concurrent calls spawn duplicate `opencode serve` processes.
// ─────────────────────────────────────────────────────────────────────────────

test("ensureServer: sequential calls do NOT respawn (guard works when not racing)", async () => {
  const manager = new ServerManager("", "", "", "127.0.0.1");
  let spawnCount = 0;

  (manager as unknown as {
    spawnManaged: (wd: string) => Promise<ServerInfo>;
  }).spawnManaged = async () => {
    spawnCount++;
    return { url: "http://127.0.0.1:4000", authHeader: "x", isManaged: true };
  };

  await manager.ensureServer("/tmp");
  await manager.ensureServer("/tmp");

  assert.equal(spawnCount, 1, "second call reused cached this.info");
});

test("ensureServer: concurrent calls with dedup invoke spawnManaged ONCE (FIX VERIFIED)", async () => {
  const manager = new ServerManager("", "", "", "127.0.0.1");
  let spawnCount = 0;

  (manager as unknown as {
    spawnManaged: (wd: string) => Promise<ServerInfo>;
  }).spawnManaged = async () => {
    spawnCount++;
    const myPort = 5000 + spawnCount;
    await new Promise((r) => setTimeout(r, 50));
    return { url: `http://127.0.0.1:${myPort}`, authHeader: "Basic fake", isManaged: true };
  };

  const [a, b] = await Promise.all([
    manager.ensureServer("/tmp"),
    manager.ensureServer("/tmp"),
  ]);

  assert.equal(spawnCount, 1, "spawnManaged called once — dedup works");
  assert.deepEqual(a, b, "both callers received the same ServerInfo");
});

// ─────────────────────────────────────────────────────────────────────────────
// Finding #5 (Critical): handlePermissionUpdated payload shape
// Claim: handler expects bare Permission but server sends { permission: Permission },
//        causing all permission prompts to be silently dropped.
// REALITY (checked against SDK types.gen.d.ts):
//   EventPermissionUpdated { type: "permission.updated"; properties: Permission }
//   So eventStream emits the BARE Permission object. Handler is correct.
// ─────────────────────────────────────────────────────────────────────────────

test("handlePermissionUpdated: bare Permission payload is stored correctly (NOT A BUG)", async () => {
  const fakeEventStream = new EventEmitter();
  const fakeClient = {} as unknown as ConstructorParameters<typeof SessionService>[0];
  const service = new SessionService(fakeClient, fakeEventStream as never);

  // Attach listeners (same as start() does, minus the network calls).
  (service as unknown as { subscribe: () => void }).subscribe();

  const permission: Permission = {
    id: "perm-1",
    type: "tool",
    sessionID: "sess-1",
    messageID: "msg-1",
    title: "Run bash command",
    metadata: {},
    time: { created: Date.now() },
  };

  // Simulate exactly what eventStream.ts:124 does:
  //   this.emit(event.type, event.properties);
  // For permission.updated, properties IS the bare Permission.
  fakeEventStream.emit("permission.updated", permission);

  const pending = service.getPendingPermissions("sess-1");
  assert.equal(pending.length, 1, "permission was stored, not dropped");
  assert.equal(pending[0]?.id, "perm-1");

  let emitted = false;
  service.on("permissionRequest", (payload: { sessionId: string }) => {
    emitted = payload.sessionId === "sess-1";
  });
  // Emit again to check the event propagation
  fakeEventStream.emit("permission.updated", { ...permission, id: "perm-2" });
  assert.ok(emitted, "permissionRequest event was emitted to listeners");
});

// ─────────────────────────────────────────────────────────────────────────────
// Finding #1 (Critical): Path traversal in diff/checkFilesExist
// Claim: path.join(workdir, "../../etc/passwd") resolves outside workspace.
// We verify this is TRUE, but also verify that the proposed fix
// (startsWith(workdir)) would break legitimate external-file diffs.
// ─────────────────────────────────────────────────────────────────────────────

test("path traversal: reconstructFileDiff resolves relative '../' outside workspace (CONFIRMED)", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ocvs-trav-"));
  try {
    const workspaceDir = path.join(tmp, "workspace");
    const secretDir = path.join(tmp, "secret");
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.mkdir(secretDir, { recursive: true });

    const secretContent = "TOPSECRET";
    await fs.writeFile(path.join(secretDir, "secret.txt"), secretContent);

    // Relative traversal: ../secret/secret.txt from inside workspace
    const traversalRel = path.join("..", "secret", "secret.txt");

    const result = await reconstructFileDiff(traversalRel, [], false, workspaceDir);

    assert.ok(!("error" in result), "file outside workspace was read without error");
    if (!("error" in result)) {
      assert.equal(
        result.after,
        secretContent,
        "path traversal succeeded — external file content returned",
      );
    }
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("path traversal: absolute path outside workspace is also readable (CONFIRMED)", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ocvs-abs-"));
  try {
    const workspaceDir = path.join(tmp, "workspace");
    await fs.mkdir(workspaceDir, { recursive: true });

    const externalAbs = path.join(tmp, "outside.txt");
    await fs.writeFile(externalAbs, "external-data");

    const result = await reconstructFileDiff(externalAbs, [], false, workspaceDir);

    assert.ok(!("error" in result), "absolute external path was read");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("path traversal FIX IMPACT: startsWith(workdir) would break legitimate external files", async () => {
  // Agents legitimately edit files outside the workspace (global config,
  // monorepo roots, MCP-managed files). This test demonstrates that the
  // proposed fix would break diff reconstruction for those files.
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ocvs-fix-"));
  try {
    const workspaceDir = path.join(tmp, "ws");
    await fs.mkdir(workspaceDir, { recursive: true });

    const externalFile = path.join(tmp, "global-config.json");
    await fs.writeFile(externalFile, '{"theme":"dark"}');

    // Simulate the proposed fix
    const resolved = path.resolve(workspaceDir, externalFile);
    const wouldBlock = !resolved.startsWith(workspaceDir + path.sep);

    // Confirm the file is currently readable (no fix in place)
    const result = await reconstructFileDiff(externalFile, [], false, workspaceDir);
    assert.ok(!("error" in result), "external file is currently readable");

    // And confirm the proposed fix WOULD block it
    assert.ok(
      wouldBlock,
      "startsWith(workdir) check would reject this legitimate external file",
    );
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("path traversal FIX IMPACT: symlinks inside workspace would be falsely rejected", async () => {
  // If the workspace contains a symlink pointing outside (common in
  // node_modules, dotfile stow setups, etc.), realpath differs from
  // workdir but the file IS legitimately accessible via the workspace.
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ocvs-sym-"));
  try {
    const workspaceDir = path.join(tmp, "ws");
    const realDir = path.join(tmp, "real");
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.mkdir(realDir, { recursive: true });
    await fs.writeFile(path.join(realDir, "linked.txt"), "linked");

    // Create a symlink inside workspace pointing to realDir
    await fs.symlink(realDir, path.join(workspaceDir, "link"));

    const fileViaSymlink = path.join(workspaceDir, "link", "linked.txt");
    const result = await reconstructFileDiff(fileViaSymlink, [], false, workspaceDir);
    assert.ok(!("error" in result), "symlinked file is readable via workspace");

    // A naive startsWith check on the AS-WRITTEN path passes, but a
    // realpath-based check would reject it because realpath resolves the
    // symlink to outside workspace.
    const rp = await fs.realpath(fileViaSymlink);
    const realWorkspace = await fs.realpath(workspaceDir);
    const realpathWouldBlock = !rp.startsWith(realWorkspace + path.sep);
    // On most systems the symlink target IS outside, so realpath would block:
    assert.ok(realpathWouldBlock, "realpath-based check would reject symlinked file");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Finding: openSession race protection (relevant to user's session-switch bug)
// Verify the openSessionToken guard prevents stale message loads.
// ─────────────────────────────────────────────────────────────────────────────

test("openSession: rapid A→B switch discards slow A's message load (guard works)", async () => {
  const fakeEventStream = new EventEmitter();

  const fakeClient = {
    getMessages: async (sessionId: string) => {
      // "slow" session takes longer, simulating a big history fetch
      const delay = sessionId === "slow" ? 60 : 5;
      await new Promise((r) => setTimeout(r, delay));
      return [
        {
          info: {
            id: `msg-${sessionId}`,
            sessionID: sessionId,
            role: "user" as const,
            time: { created: 1 },
          },
          parts: [],
        },
      ];
    },
    listSessions: async () => [],
    getSessionStatus: async () => ({} as Record<string, never>),
    getSessionTodos: async () => [],
  };

  const service = new SessionService(
    fakeClient as never,
    fakeEventStream as never,
  );
  await service.refreshSessions();

  let emittedSession: string | null = null;
  service.on("messagesChanged", (sid: string) => {
    emittedSession = sid;
  });

  // Switch to "slow" then immediately to "fast"
  const slowP = service.openSession("slow");
  const fastP = service.openSession("fast");
  await Promise.all([slowP, fastP]);

  // The fast session should win; slow's emit should have been suppressed
  assert.equal(emittedSession, "fast", "fast session won the race");
  assert.equal(service.getActiveSessionId(), "fast");
});
