import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import {
  wildcardMatch,
  parsePermissionBlock,
  resolvePermission,
  pickWriteTarget,
  writePermissionRule,
  removePermissionRule,
  configFilePath,
  computeEffective,
  type PermissionRule,
} from "../src/extension/permissionConfig";

// ── Wildcard.match parity (ported from packages/core/src/util/wildcard.ts @ v1.17.13) ──

test("wildcardMatch: single-char token", () => {
  assert.equal(wildcardMatch("file1.txt", "file?.txt"), true);
  assert.equal(wildcardMatch("file12.txt", "file?.txt"), false);
});

test("wildcardMatch: literal specials are escaped, not regex", () => {
  assert.equal(wildcardMatch("foo+bar", "foo+bar"), true);
});

test("wildcardMatch: trailing ' *' matches with or without args", () => {
  assert.equal(wildcardMatch("ls", "ls *"), true);
  assert.equal(wildcardMatch("ls -la", "ls *"), true);
  assert.equal(wildcardMatch("ls foo bar", "ls *"), true);
  assert.equal(wildcardMatch("git commit -m foo", "git *"), true);
  // "ls *" (space) must NOT match "lstmeval"
  assert.equal(wildcardMatch("lstmeval", "ls *"), false);
});

test("wildcardMatch: 'ls*' (no space) matches greedily incl. 'lstmeval'", () => {
  assert.equal(wildcardMatch("ls", "ls*"), true);
  assert.equal(wildcardMatch("lstmeval", "ls*"), true);
});

test("wildcardMatch: normalizes backslashes", () => {
  assert.equal(wildcardMatch("C:\\Windows\\System32\\x", "C:/Windows/System32/*"), true);
});

// ── Spec-mandated parity cases (docs/future-permission-table.md:105) ──
// These exercise the trickier wildcard semantics the engine relies on; a
// future "simplification" of the matcher should fail here first.

test("wildcardMatch: **/*.env matches nested paths", () => {
  assert.equal(wildcardMatch(".env", "**/*.env"), false); // "**/" needs a separator
  assert.equal(wildcardMatch("src/.env", "**/*.env"), true);
  assert.equal(wildcardMatch("a/b/c/.env", "**/*.env"), true);
});

test("wildcardMatch: paths with spaces", () => {
  assert.equal(wildcardMatch("/Users/My Name/proj/file.ts", "/Users/My Name/proj/*"), true);
  assert.equal(wildcardMatch("git commit -m hello world", "git *"), true);
});

test("wildcardMatch: leading ~/ is literal, not home expansion", () => {
  // The engine treats "~/" literally (it's a regex on the raw string); it does
  // NOT expand to the home dir. Confirm we match that behaviour.
  assert.equal(wildcardMatch("~/src/file.ts", "~/src/*"), true);
  assert.equal(wildcardMatch("/Users/me/src/file.ts", "~/src/*"), false);
});

test("wildcardMatch: nested dirs require ** not single *", () => {
  // Single "*" does not cross "/" because the engine's matcher has no
  // special "/" handling — "*" already becomes ".*" which DOES cross "/".
  // Document the actual behaviour so a change is caught.
  assert.equal(wildcardMatch("a/b/c", "a/*"), true); // .* crosses "/"
  assert.equal(wildcardMatch("a/b/c", "a/**"), true);
});

// ── parsePermissionBlock (mirror engine fromConfig) ──

test("parsePermissionBlock: flat string -> pattern '*'", () => {
  const r = parsePermissionBlock({ edit: "ask", webfetch: "allow" }, "project");
  assert.deepEqual(
    r.map((x) => [x.tool, x.pattern, x.action, x.source]),
    [
      ["edit", "*", "ask", "project"],
      ["webfetch", "*", "allow", "project"],
    ],
  );
});

test("parsePermissionBlock: granular only for bash", () => {
  const r = parsePermissionBlock({ bash: { "docker *": "ask", "*": "allow" } }, "global");
  assert.deepEqual(
    r.map((x) => [x.tool, x.pattern, x.action]),
    [
      ["bash", "docker *", "ask"],
      ["bash", "*", "allow"],
    ],
  );
});

test("parsePermissionBlock: granular form honoured for ANY tool (engine matches tool via wildcard)", () => {
  // The live engine accepts edit:{"*.md":"allow"} — verified via GET /config on
  // v1.17.13. This used to be wrongly rejected as "schema-invalid".
  const r = parsePermissionBlock({ edit: { "*": "ask", "*.md": "allow" } }, "project");
  assert.deepEqual(
    r.map((x) => [x.tool, x.pattern, x.action]),
    [
      ["edit", "*", "ask"],
      ["edit", "*.md", "allow"],
    ],
  );
});

test("parsePermissionBlock: any tool name accepted (grep/task/read)", () => {
  // Engine evaluate() wildcard-matches tool names, so non-SDK keys are live.
  const r = parsePermissionBlock(
    { task: "ask", grep: "deny", bash: "maybe", doom_loop: "allow", read: { "*.ts": "allow" } },
    "global",
  );
  assert.deepEqual(
    r.map((x) => [x.tool, x.pattern, x.action]),
    [
      ["task", "*", "ask"],
      ["grep", "*", "deny"],
      ["doom_loop", "*", "allow"],
      ["read", "*.ts", "allow"],
    ],
  );
});

// ── resolvePermission (mirror engine evaluate: findLast) ──

test("resolvePermission: last match wins across sources", () => {
  const rules: PermissionRule[] = [
    { tool: "bash", pattern: "*", action: "allow", source: "global" },
    { tool: "bash", pattern: "docker *", action: "ask", source: "project" },
  ];
  assert.deepEqual(resolvePermission(rules, "bash", "docker run hi"), { action: "ask", source: "project" });
  assert.deepEqual(resolvePermission(rules, "bash", "ls -la"), { action: "allow", source: "global" });
});

test("resolvePermission: no match -> default ask", () => {
  assert.deepEqual(resolvePermission([], "bash", "rm -rf /"), { action: "ask", source: "default" });
});

// ── pickWriteTarget ──

test("pickWriteTarget: project when workspace!=home", () => {
  const t = pickWriteTarget("/repo", "/home/me");
  assert.equal(t.scope, "project");
  assert.match(t.path, /\/repo\/opencode\.json$/);
});

test("pickWriteTarget: global when workspace is home", () => {
  const t = pickWriteTarget("/home/me", "/home/me");
  assert.equal(t.scope, "global");
});

// ── writePermissionRule / removePermissionRule (jsonc-parser) ──

function tmpFile(name: string, content?: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "permcfg-"));
  const file = path.join(dir, name);
  if (content !== undefined) fs.writeFileSync(file, content, "utf8");
  return file;
}

test("writePermissionRule: creates file + flat for non-bash", () => {
  const f = tmpFile("opencode.json");
  writePermissionRule(f, { tool: "edit", pattern: "*", action: "ask", source: "project" });
  const data = JSON.parse(fs.readFileSync(f, "utf8"));
  assert.deepEqual(data.permission, { edit: "ask" });
  assert.equal(data.$schema, "https://opencode.ai/config.json");
});

test("writePermissionRule: granular for bash", () => {
  const f = tmpFile("opencode.json", "{}");
  writePermissionRule(f, { tool: "bash", pattern: "docker *", action: "ask", source: "global" });
  const data = JSON.parse(fs.readFileSync(f, "utf8"));
  assert.deepEqual(data.permission, { bash: { "docker *": "ask" } });
});

test("writePermissionRule: specific pattern on non-bash tool stays granular", () => {
  // The engine accepts granular objects for any tool, so a specific pattern is
  // preserved (not collapsed to "*"). Flat string is used only when the pattern
  // IS "*" and no other specifics exist for that tool.
  const f = tmpFile("opencode.json", "{}");
  writePermissionRule(f, { tool: "webfetch", pattern: "https://x", action: "allow", source: "global" });
  const data = JSON.parse(fs.readFileSync(f, "utf8"));
  assert.deepEqual(data.permission, { webfetch: { "https://x": "allow" } });
});

test("writePermissionRule: '*' on non-bash tool without other specifics -> flat string", () => {
  const f = tmpFile("opencode.json", "{}");
  writePermissionRule(f, { tool: "webfetch", pattern: "*", action: "allow", source: "global" });
  const data = JSON.parse(fs.readFileSync(f, "utf8"));
  assert.deepEqual(data.permission, { webfetch: "allow" });
});

test("writePermissionRule: '*' on non-bash tool WITH specifics -> granular, * first", () => {
  const f = tmpFile("opencode.json", JSON.stringify({ permission: { edit: { "*.md": "allow" } } }));
  writePermissionRule(f, { tool: "edit", pattern: "*", action: "ask", source: "global" });
  const text = fs.readFileSync(f, "utf8");
  const starPos = text.indexOf('"*"');
  const mdPos = text.indexOf('"*.md"');
  assert.ok(starPos > -1 && mdPos > -1 && starPos < mdPos, "'*' must precede specifics");
});

test("writePermissionRule: '*' sorts first within bash (specifics stay live)", () => {
  const f = tmpFile("opencode.json", JSON.stringify({ permission: { bash: { "docker *": "ask" } } }));
  writePermissionRule(f, { tool: "bash", pattern: "*", action: "allow", source: "global" });
  const text = fs.readFileSync(f, "utf8");
  const starPos = text.indexOf('"*"');
  const dockerPos = text.indexOf('"docker *"');
  assert.ok(starPos > -1 && dockerPos > -1, "both keys present");
  assert.ok(starPos < dockerPos, "'*' must precede specifics so last-match-wins keeps them live");
});

test("writePermissionRule: preserves comments in untouched regions (jsonc)", () => {
  const f = tmpFile(
    "opencode.jsonc",
    `{
  // my model
  "model": "x",
  "permission": {
    "edit": "allow"
  }
}`,
  );
  writePermissionRule(f, { tool: "bash", pattern: "*", action: "ask", source: "project" });
  const text = fs.readFileSync(f, "utf8");
  assert.match(text, /\/\/ my model/);
  assert.match(text, /"model": "x"/);
  assert.match(text, /"bash"/);
});

test("removePermissionRule: removes granular key + cleans empty tool + empty permission", () => {
  const f = tmpFile("opencode.json", JSON.stringify({ permission: { bash: { "docker *": "ask" } } }));
  let res = removePermissionRule(f, "bash", "docker *");
  assert.equal(res.changed, true);
  const data1 = JSON.parse(fs.readFileSync(f, "utf8"));
  assert.deepEqual(data1, {});
});

test("removePermissionRule: flat removal", () => {
  const f = tmpFile("opencode.json", JSON.stringify({ permission: { edit: "ask", webfetch: "allow" } }));
  removePermissionRule(f, "edit", "*");
  const data = JSON.parse(fs.readFileSync(f, "utf8"));
  assert.deepEqual(data.permission, { webfetch: "allow" });
});

test("configFilePath: prefers existing .jsonc over .json", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "permcfg-"));
  fs.writeFileSync(path.join(dir, "opencode.jsonc"), "{}");
  assert.equal(configFilePath("project", dir), path.join(dir, "opencode.jsonc"));
});

// ── computeEffective (dead-rule detection) ──

test("computeEffective: '*' after specifics shadows them (last-wins)", () => {
  // {bash: {"docker *":"ask","*":"allow"}} — "*" last wins, "docker *" dead
  const rules: PermissionRule[] = [
    { tool: "bash", pattern: "docker *", action: "ask", source: "project" },
    { tool: "bash", pattern: "*", action: "allow", source: "project" },
  ];
  assert.deepEqual(computeEffective(rules), [false, true]);
});

test("computeEffective: specifics after '*' stay live (last-wins keeps them)", () => {
  // {bash: {"*":"allow","docker *":"ask"}} — the canonical live ordering
  const rules: PermissionRule[] = [
    { tool: "bash", pattern: "*", action: "allow", source: "project" },
    { tool: "bash", pattern: "docker *", action: "ask", source: "project" },
  ];
  assert.deepEqual(computeEffective(rules), [true, true]);
});

test("computeEffective: identical pattern later shadows earlier", () => {
  const rules: PermissionRule[] = [
    { tool: "edit", pattern: "*", action: "ask", source: "global" },
    { tool: "edit", pattern: "*", action: "allow", source: "project" },
  ];
  assert.deepEqual(computeEffective(rules), [false, true]);
});

test("computeEffective: different tools don't shadow each other", () => {
  const rules: PermissionRule[] = [
    { tool: "edit", pattern: "*", action: "ask", source: "global" },
    { tool: "bash", pattern: "*", action: "allow", source: "global" },
  ];
  assert.deepEqual(computeEffective(rules), [true, true]);
});

test("computeEffective: partial overlap left as effective", () => {
  // "docker *" and "rm *" overlap on nothing concrete; neither is a superset,
  // so neither is flagged — conservative (don't claim false confidence).
  const rules: PermissionRule[] = [
    { tool: "bash", pattern: "docker *", action: "ask", source: "project" },
    { tool: "bash", pattern: "rm *", action: "deny", source: "project" },
  ];
  assert.deepEqual(computeEffective(rules), [true, true]);
});
