# Permission Settings Editor + Persistent "Always allow" (P2)

Status: **v1 + file-write architecture. Reviewed (engine v1.17.13 source + SDK types + agent review). Ready to implement.**

All open questions resolved with citations. Engine references: `anomalyco/opencode@v1.17.13`.

---

## Architectural decision: stay on v1

Our extension talks to the **v1** permission service: events are v1-shaped
(`permission`/`patterns`/`always`, consumed at `sessionService.ts:537-545`) and the SDK
replies via the v1-era path `/session/{id}/permissions/{permissionID}`
(`sdk.gen.js:853`). The v1 `reply("always")` is **in-memory, session-only**
(`packages/opencode/src/permission/index.ts:145-151` — pushes into a `State.approved`
array, no file/DB write).

> **v2 exists but is deliberately NOT used.** The engine has a newer v2 permission stack
> (`packages/core/src/permission.ts` + `permission/saved.ts`) backed by SQLite, exposed at
> `GET /api/permission/saved` / `DELETE /api/permission/saved/:id` (verified live on our
> server: HTTP 200). v2 `reply("always")` persists to that DB. **We are not migrating to
> v2** (decision): it would require creating sessions/requests through the v2 API (no
> continuity with existing sessions) and touch many places. We stay on v1 for compatibility.
> Consequence: cross-session persistence is NOT provided by the engine on our path → we add a
> file-write layer.

- **Session-level "Always allow"** → keep the engine's `response:"always"` (already wired).
  Do NOT replace it.
- **Cross-session persistence** → write permission rules to the real config files using the
  same library the engine uses (`jsonc-parser`) and the same precedence model.
- The overlay "Always allow" does **both**: `response:"always"` (instant this session) + a
  file write (next launch picks it up). **No restart prompt at click time** — the in-memory
  rule already covers the current session.

---

## Resolved findings (engine v1.17.13 source + SDK types)

> ⚠️ **Correction (post-implementation, verified live):** Finding #5 below originally
> claimed the `permission` schema is exactly 5 keys with granular `{pattern:action}`
> valid ONLY for `bash`. **This is wrong.** The SDK's static type
> (`types.gen.d.ts:1161-1169`) lists 5 keys, but the live v1.17.13 engine's
> `evaluate()` matches the **tool name with the same wildcard matcher it uses for
> patterns** (`M.flat().findLast((z) => match(input, z.permission) && match(p, z.pattern))`),
> so ANY string is a valid permission key, and each value may be flat OR granular
> `{pattern:action}` for **every** tool. Verified empirically: `GET /config` returns
> `edit: {"*.md":"allow"}` and `grep: "allow"` unchanged, and both resolve live.
> The implementation now models this full runtime shape (not the SDK subset).

1. **`response:"always"` is in-memory only (v1).** `permission/index.ts:109-167` (`Service.reply`):
   `once`→nothing; `always`→pushes into in-memory `approved` (line 145-151) then auto-approves
   matching pending in the session; `reject`→fails deferred + **cascades reject to all other
   pending in the session** (line 129-138) → **reject stops the run** (overlay tooltip correct).
   No persistence anywhere in the v1 reply path.
2. **Sessions survive restart.** Disk-persisted at `~/.local/share/opencode/storage/`. Restart
   interrupts an in-flight generation but preserves history; user can resume. → Restart is a
   valid "apply" mechanism.
3. **`*` ordering: catch-all must come FIRST within one tool object.** `evaluate`
   (`permission/index.ts:28-38`) flattens rulesets and uses `findLast` → last wins. Within
   `{"bash":{"docker *":"ask","*":"allow"}}`, `*` last → `*` wins → `docker *` dead. Across
   merge sources (global→project) `mergeDeep` orders global-keys-first so global `*` + project
   specific works naturally. → Writer emits `*` first when creating/rewriting a tool object.
4. **`PATCH /config` is NOT usable.** `PATCH /config` (full `ConfigV1.Info` payload) writes via
   `Config.update`/`updateGlobal`, but the instance ruleset is computed once at
   `loadInstanceState` (`config.ts:313`) and cached (`config.ts:599`); `invalidate()` only
   clears the global cache, not the instance. → Write files directly; apply via restart.
5. **~~Permission schema = exactly 5 keys, granular `{pattern:action}` valid ONLY for `bash`~~**
   *(SUPERSEDED — see the correction notice at the top of this section.)* The SDK's static
   type lists `edit | bash | webfetch | doom_loop | external_directory`, but the **live engine
   accepts any tool name and granular objects for all of them**. The implementation correctly
   models `Record<string, action | Record<string,action>>`. The 5 SDK keys are still offered
   as UI picker suggestions (most common), but the field is free-text.
   - **Piece 1 baseline follow-up:** our `OPENCODE_CONFIG` baseline sets `task`/`websearch: "ask"`
     — these keys are NOT in the schema (likely stripped/dead). Trim baseline to
     `{bash, edit, webfetch: "ask"}`. Separate quickfix, not part of P2.
6. **"Add tool" picker = the 5 hardcoded keys**, NOT `GET /experimental/tool/ids` (that returns
   dozens of tool IDs; most have no user-configurable permission slot → dead rows). Drop the
   tool.ids fetch.
7. **Full precedence (low→high, last-wins)** — `config.ts:313-563`: remote wellknown →
   **global** `~/.config/opencode/` (`config.json`→`opencode.json`→`opencode.jsonc`) →
   **`OPENCODE_CONFIG`** (our baseline, `config.ts:400`) → **project** `opencode.json`/`.jsonc`
   walking up to worktree (`config.ts:405`) → `.opencode/` dirs (`config.ts:423`) →
   `OPENCODE_CONFIG_CONTENT` (`config.ts:467`) → account/org → managed → MDM →
   `OPENCODE_PERMISSION` env (`config.ts:544`) → `tools` mapping. Our baseline sits correctly
   below project. We do NOT use `OPENCODE_PERMISSION` (overrides project).
8. **`jsonc-parser@3.3.1`** is the engine's own JSONC-patch lib (`config.ts:149-161` `patchJsonc`,
   `modify`+`applyEdits`, 2-space). Already resolvable in our tree (transitive via `@vscode/vsce`).
   Add as an explicit dependency.

---

## Architecture

### Two write paths, one model
- **Overlay "Always allow"** → `replyPermission("always")` (engine, instant, this session)
  **+** write rule(s) to the target config file (persistent, next launch). No restart prompt.
- **Table editor** → read source files, edit, write file. Applies on server restart (instance
  config cached). "Reload to apply" button + file watcher.

### Source of truth = real files (NOT localStorage, NOT the v2 DB)
- global `~/.config/opencode/opencode.json` (or `.jsonc` if it exists)
- project `<workspace>/opencode.json` (or `.jsonc`)
- baseline (`OPENCODE_CONFIG`) is read-only/hidden in the UI (its path is ephemeral
  `os.tmpdir()/opencode-ext-permission-<pid>.json`, `serverManager.ts:168`; and the baseline is
  all-"ask" so its effect = the resolver's default → no need to display it).

### Effective-action display
Replicate the engine's `evaluate` (`findLast` over flattened `[global, project]` rules) with the
**engine's exact `Wildcard.match` semantics** (port from `packages/core/src/util/wildcard.ts`,
not picomatch — they differ on `**`/separators/braces). Default (no rule) → `"ask"` (= baseline).
Parity tests required for tricky patterns: `docker *`, `**/*.env`, paths with spaces, leading `~/`.

### Write target selection
- workspace ≠ home AND inside a git repo → project `opencode.json`.
- otherwise → global `opencode.json`.
- Prefer `.jsonc` if it exists (like engine `globalConfigFile()`, `config.ts:139`); else `.json`.
- **Offer-to-save** when a project write would create the file; AND disclose scope for global
  writes ("~/.config/opencode/opencode.json affects all projects on this machine").

### Reload model
- Overlay button: no restart needed.
- Table edits: restart required. "Reload server" reuses `serverManager` stop/start **only when
  `connection.isManaged`** (`serverManager.ts:104/157`, `store.ts:58`). When `!isManaged`
  (external server), hide/disable the button with tooltip "Connected to an external server —
  restart it manually". Confirm dialog if a generation is active.

---

## Reuse audit

| Need | Reuse |
|---|---|
| Session "always" | engine `response:"always"` via `sessionService.replyPermission` (keep) |
| JSONC-safe write | `jsonc-parser` `modify`/`applyEdits` (engine `patchJsonc`, `config.ts:149`) |
| Config → webview pipeline | `loadConfig`→`transformConfig`→`{type:"config"}` (`webviewPanel.ts:650-655,739`) — widen `permission` type |
| Resolved config | `client.getConfig()` → `GET /config` |
| Permission lookup (overlay persist) | `sessionService.permissionsBySession` (`sessionService.ts:31,563`) — full object (incl. `type`+`always`) present at reply time (evicted later on `permission.replied`). Look up host-side by id → no protocol widening. |
| Server restart | `serverManager` stop/start (managed only) |

---

## Data model

```ts
// Maps to one entry the engine's fromConfig would emit. NOTE: granular {pattern:action}
// is schema-valid ONLY for bash; for edit/webfetch/doom_loop/external_directory the
// writer collapses pattern to "*" and emits a flat string.
interface PermissionRule {
  tool: "edit" | "bash" | "webfetch" | "doom_loop" | "external_directory";
  pattern: string;          // "*" (whole tool) | "docker *" | "~/src/**" | ... (bash only)
  action: "allow" | "ask" | "deny";
  source: "global" | "project";
}
```

---

## File structure

**New:**
- `src/extension/permissionConfig.ts` — pure logic (read global+project files, parse→rules,
  resolve effective action via ported Wildcard.match, pick write target, write/remove with
  jsonc-parser, enforce `*`-first, per-file write mutex). No vscode imports → unit-testable.
- `src/extension/permissionConfig.test.ts` — unit tests incl. Wildcard.match parity.
- `webview/src/components/PermissionSettings.tsx` — the table.
- `webview/src/styles/permissions.css`.

**Modified:**
- `src/extension/webviewPanel.ts` — handlers (`getPermissionRules`, `savePermissionRule`,
  `removePermissionRule`, `reloadServer`); widen `transformConfig` permission to granular; wire
  overlay "Always allow" to persist (host-side lookup).
- `webview/src/api/types.ts` — `PermissionRule`; widen `ProjectConfig.permission`.
- `webview/src/store/store.ts` — `permissionRules`, `permissionSettingsOpen`, `permissionRestartNeeded`.
- `webview/src/App.tsx` — mount `<PermissionSettings/>`.
- `package.json` — add `jsonc-parser` explicit dep.

---

## Implementation tasks

### Phase 0 — Core config logic (pure, tested)

**0.1 `parsePermissionBlock(unknown) → PermissionRule[]`** — mirror `fromConfig`
(`permission/index.ts:186-198`): flat string→`{pattern:"*"}`; granular object→one rule/pattern.
Reject/ignore unknown tool keys (keep schema-valid).

**0.2 `resolve()` + port `Wildcard.match`** — replicate `evaluate` (`findLast`); port the engine's
exact wildcard matcher from `packages/core/src/util/wildcard.ts` (do NOT use picomatch).
Parity tests: `docker *`, `**/*.env`, spaces, `~/`.

**0.3 `pickWriteTarget(workspace, home, hasGitRoot) → {target, path}`** — project iff
workspace≠home && hasGitRoot; prefer `.jsonc` if exists else `.json`.

**0.4 `writePermissionRule` / `removePermissionRule` (jsonc-parser)** — comment-safe patch
(`modify`+`applyEdits`, 2-space). **Branch by tool:** `bash` → granular `{tool:{pattern:action}}`;
others → collapse pattern→`"*"`, flat `{tool: action}`. On adding `*` to a tool that already has
specifics, rewrite the object with `*` first (note: this strips inline comments within that
object — acceptable, documented). Per-file write mutex (overlay+table+agent can overlap).

### Phase 1 — Overlay "Always allow" persist

**1.1** In `webviewPanel.ts` `case "replyPermission"`: when `decision==="always"`, after the
existing reply, look up the request in `sessionService.permissionsBySession` by `permissionId`
→ get `.type` (tool) + `.always` (patterns). For each pattern, `writePermissionRule(target, ...)`.
**If `always` is empty/missing → persist nothing** (in-memory covers the session; surface a hint
in the overlay). No restart prompt. Errors via `reportError` (don't block the reply).

### Phase 2 — Table UI

**2.1 extension handlers** — `getPermissionRules`: read global+project via `permissionConfig`,
`resolve()`, post `{type:"permissionRules", snapshot}`. `savePermissionRule`/`removePermissionRule`
→ write + re-broadcast + set `restartNeeded`.

**2.2 webview** — `PermissionSettings.tsx`: rows grouped by tool (the 5 keys); columns
Tool/Pattern(bash only)/Action/source badge; Add (picker = 5 keys)/Remove. Header: writeTarget +
"Reload to apply" (disabled if `!isManaged`, with tooltip).

**2.3 offer-to-save + reload** — confirm on project-file creation AND disclose global-write scope;
reload confirm if generating.

### Phase 3 — File watcher
**3.1** `createFileSystemWatcher` on global+project config files → on external change, re-read,
re-broadcast, toast "Config changed externally — reload to apply".

---

## Out of scope
- v2 migration / `permission.saved.*` API (decision — no session continuity).
- Per-agent permission overrides; MDM layers; `PATCH /config`.

> Note: "Configuring non-schema tools (task/grep/read/...)" was originally listed here as
> out of scope, but that restriction was based on the incorrect finding #5 (see correction
> notice above). The live engine DOES accept those tool names in the `permission` block, so
> the table now supports them as free-text entries.

---

## Engine drift note
Validated against v1.17.13; `package.json` has `^1.17.13`. Phase-0 tests assert OUR mirror of the
engine, not the engine. Pin the SDK version and add a smoke test (round-trip `GET /config` + a
permission prompt) to catch engine changes to `evaluate`/`fromConfig`/`always`.

## Reference (engine, v1.17.13)
- `packages/opencode/src/permission/index.ts` — `evaluate`, `fromConfig`, v1 `reply`.
- `packages/opencode/src/config/config.ts` — `loadInstanceState`, `updateGlobal`, `patchJsonc`, `globalConfigFile`.
- `packages/opencode/src/config/paths.ts`; `packages/core/src/util/wildcard.ts`.
- `packages/opencode/src/server/routes/instance/httpapi/groups/{config,permission}.ts`.

## Reference (our code)
- Baseline: `src/bridge/serverManager.ts` (`OPENCODE_CONFIG`, baseline tmpdir `:168`).
- Events/reply: `src/services/sessionService.ts` (`handlePermissionAsked:537`, `replyPermission:242`, `permissionsBySession:31,563`).
- Overlay reply: `src/extension/webviewPanel.ts:239` (`case "replyPermission"`).
- Config pipeline: `src/extension/webviewPanel.ts:650-655,739,873-922`.
- Overlay: `webview/src/components/PermissionOverlay.tsx`.
