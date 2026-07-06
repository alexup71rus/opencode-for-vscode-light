# Future: Permission Table Editor (Piece 2)

Status: **Idea / plan, not started.** Captured so it isn't lost.
Created during the confirmation-bug investigation (see Piece 1 fix in `src/bridge/serverManager.ts`).

## Problem this solves

Once Piece 1 lands, tool confirmations appear (ask-by-default for action tools).
But persistent, cross-session permission tuning still requires hand-editing `opencode.json`.
A table UI would let users manage permission rules for **any** tool/command (incl. custom
`bash` sub-patterns like `docker *`, `ls *`) without touching JSON — while keeping the real
config file as the single source of truth.

## Decided design (from brainstorming)

- **Source of truth = real files.** The table is a view + editor over `permission` blocks in:
  - global `~/.config/opencode/opencode.json`
  - project `<workspace>/opencode.json`
  Edits write to the file; nothing is stored in webview/localStorage. Rationale: the agent
  edits the same file with `edit`/`write` and the environment must pick it up.

- **Write target:**
  - workspace ≠ home dir (and ideally has a git root) → project `opencode.json`
  - workspace == home dir (or no project root) → global `~/.config/opencode/opencode.json`
  - **Offer to save on change** (don't silently auto-create): when the user edits a row and no
    project config exists, prompt "Save to project? This creates `opencode.json`." so the user
    knows a file will appear.

- **ask-by-default** is already handled by Piece 1 (`OPENCODE_CONFIG` baseline file). The table
  does NOT re-establish the baseline; it only manages **explicit** overrides (which, via
  precedence, beat the baseline).

- **Resolution order (server-side, native):** global → `OPENCODE_CONFIG` baseline (action=ask) →
  project. Last-match-wins per pattern. The table shows the resolved effective action per rule
  with a source badge (global / project / extension-default).

## Key facts established by investigation (don't re-derive)

1. Official SDK spawns server/TUI with `OPENCODE_CONFIG_CONTENT` env
   (`@opencode-ai/sdk/dist/server.js:12-17, 91-97`). Default feed is `{}` (empty — no auto-ask).
   Our extension previously spawned `opencode serve` without it (the bug).
2. `OPENCODE_CONFIG_CONTENT` (inline) = highest precedence, **merges** (doesn't clobber) but
   would override project — avoid for baselines that must respect project.
3. `OPENCODE_CONFIG` (path) = precedence **between global and project** → ideal for our baseline:
   project overrides it natively. **Use this.** (Verified empirically.)
4. Global scalar `"permission": "allow"` materializes as `"*":"allow"` (catch-all default).
5. Avoid `*` in our injected rules — ordering vs specifics is ambiguous under last-match-wins.
   Use explicit per-tool keys.
6. **No hot-reload:** server does not pick up `opencode.json` changes without restart
   (verified). So applying any edit (table OR agent) needs a server restart.
7. `PATCH /config` returned HTTP 200 but had no live effect in our test — semantics unclear,
   don't rely on it without further investigation.
8. Available permission keys (finite, from docs): `read, edit, glob, grep, bash, task, skill,
   lsp, question, webfetch, websearch, external_directory, doom_loop`. `edit` covers
   edit/write/patch. Granular object syntax per tool: `{"bash": {"docker *": "ask", "*": "ask"}}`.
9. Tool list for populating "add tool" picker: `GET /experimental/tool/ids`.

## Open design details (resolve when starting Piece 2)

- **Table data model:** flat rows `(tool, pattern, action)` (e.g. `bash | docker * | ask`) vs
  nested per-tool. Flat maps cleanly to opencode's granular object syntax when grouped by tool.
  Recommendation: flat, with a "pattern" column defaulting to `*` (whole-tool).
- **Granular bash patterns** (`docker *`, `ls *`): one "pattern" column covers this — a row is
  `(bash, "docker *", ask)`. No separate sub-section needed.
- **Reload UX:** since no hot-reload, edits apply on server restart. Plan:
  - "Reload server" button always available.
  - File watcher on `opencode.json` so agent/external edits also surface a "reload to apply"
    prompt (otherwise agent edits silently don't apply).
  - Confirm dialog when a session is active / a sensitive key changed: "Reload now? This
    interrupts the running session."
  - Open question: do opencode sessions survive a server restart (persisted on disk)? Verify
    before deciding whether restart mid-session is safe.
- **`*` ordering within a tool:** when the user adds both a catch-all and specifics for the same
  tool, enforce catch-all-first ordering in the written file (docs: put `*` first, last-match-wins).

## Out of scope for Piece 2 (YAGNI)

- Per-agent permission overrides (`agent.{name}.permission`) — add only if needed.
- Managed/MDM config layers.
- `PATCH /config` live updates (defer until semantics confirmed; restart is fine for now).

## Reference

- Piece 1 fix: `src/bridge/serverManager.ts` (baseline file + `OPENCODE_CONFIG` env).
- Existing approval UI (already built, starts firing after Piece 1):
  `webview/src/components/ToolCallView.tsx:350-371` (Allow once / Always allow / Reject card).
- Permission event plumbing: `src/services/sessionService.ts:532-557`, `src/extension/webviewPanel.ts:552-570`.
- Config transform (will need `permission` type widened for granular object syntax):
  `src/extension/webviewPanel.ts:865-915` (`transformConfig`).
