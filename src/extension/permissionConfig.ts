import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { modify, applyEdits, parse, type JSONPath, type ModificationOptions } from "jsonc-parser";

export type PermissionAction = "allow" | "ask" | "deny";
// The engine's evaluate() matches the tool name with the same wildcard matcher
// it uses for patterns, so ANY string is accepted as a permission key — not
// just the 5 in the SDK's static type. Configs in the wild use grep/task/read
// and granular objects for non-bash tools (e.g. edit: {"*.md":"allow"}).
// We keep the SDK's 5 as the "standard" picker suggestions but do not restrict
// to them.
export type PermissionTool = string;

export const PERMISSION_TOOLS: PermissionTool[] = ["bash", "edit", "webfetch", "doom_loop", "external_directory"];
const ACTION_VALUES: ReadonlySet<string> = new Set(["allow", "ask", "deny"]);

export interface PermissionRule {
  tool: PermissionTool;
  pattern: string;
  action: PermissionAction;
  source: "global" | "project";
}

const FORMATTING: ModificationOptions["formattingOptions"] = { insertSpaces: true, tabSize: 2 };

function isPermissionAction(value: unknown): value is PermissionAction {
  return typeof value === "string" && ACTION_VALUES.has(value);
}

// Any non-empty string is a valid tool key — the engine matches tool names via
// wildcard too. Used only to guard against junk like "" or numeric keys.
function isPermissionToolKey(key: string): boolean {
  return typeof key === "string" && key.length > 0;
}

// Ported verbatim from packages/core/src/util/wildcard.ts @ v1.17.13 — do not "simplify":
// the trailing-" .*" → optional-args rule and the dotall flag are load-bearing for parity
// with what the server actually enforces.
export function wildcardMatch(input: string, pattern: string): boolean {
  const normalized = input.replaceAll("\\", "/");
  let escaped = pattern
    .replaceAll("\\", "/")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  if (escaped.endsWith(" .*")) escaped = escaped.slice(0, -3) + "( .*)?";
  return new RegExp("^" + escaped + "$", process.platform === "win32" ? "si" : "s").test(normalized);
}

// Mirror of engine fromConfig (permission/index.ts:186-198): flat string ->
// {pattern:"*"}; granular {pattern:action} honoured for ANY tool (the engine
// matches tool names via wildcard too, so e.g. edit:{"*.md":"allow"} and
// grep:"allow" are both live). Non-action values are ignored so we never
// propagate junk, but tool keys are NOT restricted to a fixed set.
export function parsePermissionBlock(permission: unknown, source: "global" | "project"): PermissionRule[] {
  if (!permission || typeof permission !== "object") return [];
  const rules: PermissionRule[] = [];
  for (const [key, value] of Object.entries(permission as Record<string, unknown>)) {
    if (!isPermissionToolKey(key)) continue;
    if (typeof value === "string") {
      if (isPermissionAction(value)) rules.push({ tool: key, pattern: "*", action: value, source });
      continue;
    }
    if (value && typeof value === "object") {
      for (const [pat, act] of Object.entries(value as Record<string, unknown>)) {
        if (isPermissionAction(act)) rules.push({ tool: key, pattern: pat, action: act, source });
      }
    }
  }
  return rules;
}

export interface Resolved {
  action: PermissionAction;
  source: "global" | "project" | "default";
}

// Mirror of engine evaluate (permission/index.ts:28-38): flatten + findLast by wildcard match.
// Returns the winning action+source for (tool, input); default "ask" when no rule matches.
export function resolvePermission(
  rules: readonly PermissionRule[],
  tool: PermissionTool,
  input: string,
): Resolved {
  let winner: PermissionRule | undefined;
  for (const rule of rules) {
    if (rule.tool !== tool) continue;
    if (wildcardMatch(input, rule.pattern)) winner = rule;
  }
  return winner ? { action: winner.action, source: winner.source } : { action: "ask", source: "default" };
}

export type WriteScope = "global" | "project";

export interface WriteTarget {
  scope: WriteScope;
  path: string;
}

export function pickWriteTarget(workspace: string, home: string): WriteTarget {
  // Where new permission rules are written:
  //   - workspace == home  → global (there is no meaningful "project" scope)
  //   - workspace != home  → project (the workspace's own opencode.json[|c])
  // Git presence is NOT consulted: the user decides scope by which folder they
  // opened, not by repo state.
  const scope: WriteScope = workspace === home ? "global" : "project";
  return { scope, path: configFilePath(scope, workspace) };
}

export interface PermissionRulesSnapshot {
  rules: PermissionRule[];
  // Parallel to `rules`: effective[i] is false when rule i can never win
  // because a later rule of the same tool overrides every input it would match.
  // Conservative — only flags rules fully shadowed by a later "*" or identical
  // pattern (the common dead-rule case). Partial overlaps are left as true.
  effective: boolean[];
  writeTarget: WriteScope;
  projectFileExists: boolean;
  globalPath: string;
  projectPath: string;
}

// A rule is shadowed when a later rule of the same tool matches a superset of
// its inputs. We approximate "superset" as: later pattern is "*" (matches all)
// or identical to this one. This mirrors the dead-rule cases the engine's
// findLast produces (e.g. {bash: {"*":"allow","docker *":"ask"}} — here the
// "docker *" rule is dead because "*" comes later and wins).
function ruleIsShadowedByLater(
  rules: readonly PermissionRule[],
  index: number,
): boolean {
  const here = rules[index];
  for (let j = index + 1; j < rules.length; j++) {
    const later = rules[j];
    if (later.tool !== here.tool) continue;
    if (later.pattern === "*" || later.pattern === here.pattern) return true;
  }
  return false;
}

/** Compute the `effective` flag for each rule (false = fully shadowed). Exported
 *  for unit testing without touching the filesystem. */
export function computeEffective(rules: readonly PermissionRule[]): boolean[] {
  return rules.map((_, i) => !ruleIsShadowedByLater(rules, i));
}

function readPermissionBlock(text: string): unknown {
  try {
    return (parse(text, undefined, { allowTrailingComma: true }) as { permission?: unknown } | null)?.permission;
  } catch {
    return undefined;
  }
}

export function loadPermissionRules(workspace: string, home: string): PermissionRulesSnapshot {
  const globalPath = configFilePath("global", workspace);
  const projectPath = configFilePath("project", workspace);
  const rules: PermissionRule[] = [];
  if (fs.existsSync(globalPath)) {
    rules.push(...parsePermissionBlock(readPermissionBlock(fs.readFileSync(globalPath, "utf8")), "global"));
  }
  if (fs.existsSync(projectPath)) {
    rules.push(...parsePermissionBlock(readPermissionBlock(fs.readFileSync(projectPath, "utf8")), "project"));
  }
  const target = pickWriteTarget(workspace, home);
  return {
    rules,
    effective: computeEffective(rules),
    writeTarget: target.scope,
    projectFileExists: fs.existsSync(projectPath),
    globalPath,
    projectPath,
  };
}

// Prefer an existing opencode.jsonc/.json; default to opencode.json (mirrors engine
// globalConfigFile, config.ts:139-147).
export function configFilePath(scope: WriteScope, workspace: string): string {
  const dir = scope === "global" ? globalConfigDir() : workspace;
  for (const name of ["opencode.jsonc", "opencode.json"]) {
    const candidate = path.join(dir, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return path.join(dir, "opencode.json");
}

export function globalConfigDir(): string {
  const envDir = process.env.OPENCODE_CONFIG_DIR;
  if (envDir) return envDir;
  if (process.platform === "win32") {
    const base = process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming");
    return path.join(base, "opencode");
  }
  if (process.platform === "darwin") {
    const base = process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config");
    return path.join(base, "opencode");
  }
  const base = process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config");
  return path.join(base, "opencode");
}

function readOrCreateText(filePath: string): string {
  if (fs.existsSync(filePath)) return fs.readFileSync(filePath, "utf8");
  return JSON.stringify({ $schema: "https://opencode.ai/config.json" }, null, 2);
}

// Rebuild a tool object so "*" sorts first (so specifics stay live under
// last-match-wins). Applies to any tool that has a granular object form.
function rebuildWithStarFirst(text: string, tool: PermissionTool, next: Record<string, PermissionAction>): string {
  const keys = Object.keys(next).sort((a, b) => (a === "*" ? -1 : b === "*" ? 1 : 0));
  const ordered: Record<string, PermissionAction> = {};
  for (const k of keys) ordered[k] = next[k];
  const edits = modify(text, ["permission", tool], ordered, { formattingOptions: FORMATTING });
  return applyEdits(text, edits);
}

function existingGranular(text: string, tool: PermissionTool): Record<string, PermissionAction> | undefined {
  let obj: unknown;
  try {
    obj = parse(text, undefined, { allowTrailingComma: true });
  } catch {
    return undefined;
  }
  if (!obj || typeof obj !== "object") return undefined;
  const perm = (obj as { permission?: unknown }).permission;
  if (!perm || typeof perm !== "object") return undefined;
  const entry = (perm as Record<string, unknown>)[tool];
  if (!entry || typeof entry !== "object") return undefined;
  const out: Record<string, PermissionAction> = {};
  for (const [k, v] of Object.entries(entry as Record<string, unknown>)) if (isPermissionAction(v)) out[k] = v;
  return out;
}

// Write one rule, comment-safe via jsonc-parser. The engine accepts BOTH a flat
// string and a granular {pattern:action} object for any tool, so we choose the
// representation by the rule's pattern and the file's existing shape:
//   - pattern "*" and the tool has no other specifics  → flat string (cleaner)
//   - pattern "*" but other specifics exist             → granular, "*" sorted first
//   - specific pattern                                  → granular
// Enforces "*"-first ordering within a granular object. NOTE: the "*"-first
// rebuild strips inline comments inside that single tool object (acceptable;
// the rest of the file keeps its comments).
export function writePermissionRule(filePath: string, rule: PermissionRule): { changed: boolean; text: string } {
  const before = readOrCreateText(filePath);
  const existing = existingGranular(before, rule.tool);
  const hasOtherSpecifics = existing
    ? Object.keys(existing).some((k) => k !== "*" && k !== rule.pattern)
    : false;
  // Granular form is needed when writing a specific pattern OR when the tool
  // already has other specifics that a flat string would clobber.
  const granular = rule.pattern !== "*" || hasOtherSpecifics || Boolean(existing && rule.pattern === "*" && Object.keys(existing).some((k) => k !== "*"));
  let after: string;
  if (granular && rule.pattern === "*") {
    const merged = { ...(existing ?? {}), "*": rule.action };
    const others = Object.keys(merged).filter((k) => k !== "*");
    if (others.length) {
      after = rebuildWithStarFirst(before, rule.tool, merged);
    } else {
      const edits = modify(before, ["permission", rule.tool, "*"], rule.action, { formattingOptions: FORMATTING });
      after = applyEdits(before, edits);
    }
  } else if (granular) {
    const edits = modify(before, ["permission", rule.tool, rule.pattern], rule.action, {
      formattingOptions: FORMATTING,
    });
    after = applyEdits(before, edits);
  } else {
    const edits = modify(before, ["permission", rule.tool], rule.action, { formattingOptions: FORMATTING });
    after = applyEdits(before, edits);
  }
  if (after !== before && after.trim().length) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, after, "utf8");
  }
  return { changed: after !== before, text: after };
}

// Remove a rule. Cleans up empty tool objects and an empty permission block.
export function removePermissionRule(
  filePath: string,
  tool: PermissionTool,
  pattern: string,
): { changed: boolean; text: string } {
  if (!fs.existsSync(filePath)) return { changed: false, text: "" };
  const before = fs.readFileSync(filePath, "utf8");
  // Decide granularity by the file's actual shape, not by tool name: a flat
  // string entry is removed as a whole; a granular object removes one pattern
  // and then collapses if empty.
  const isGranularInFile = Boolean(existingGranular(before, tool));
  const p: JSONPath = isGranularInFile ? ["permission", tool, pattern] : ["permission", tool];
  let after = applyEdits(before, modify(before, p, undefined, { formattingOptions: FORMATTING }));

  if (isGranularInFile) {
    const remaining = existingGranular(after, tool);
    if (remaining && Object.keys(remaining).length === 0) {
      after = applyEdits(after, modify(after, ["permission", tool], undefined, { formattingOptions: FORMATTING }));
    }
  }
  let permNow: unknown;
  try {
    permNow = (parse(after, undefined, { allowTrailingComma: true }) as { permission?: unknown } | null)?.permission;
  } catch {
    permNow = undefined;
  }
  if (permNow && typeof permNow === "object" && Object.keys(permNow as object).length === 0) {
    after = applyEdits(after, modify(after, ["permission"], undefined, { formattingOptions: FORMATTING }));
  }

  if (after !== before) fs.writeFileSync(filePath, after, "utf8");
  return { changed: after !== before, text: after };
}
