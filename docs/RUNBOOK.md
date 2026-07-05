# RUNBOOK — opencode-vscode-client

How to build, run, and package the extension. The local (gitignored)
`AGENTS.md` points here so opencode picks it up automatically.

## Stack
- TypeScript extension host entry: `src/extension/extension.ts` → bundled by **esbuild** to `dist/extension/extension.js` (CJS, Node 18). Everything is inlined; only `vscode` is external, so the bundle is self-contained.
- React webview: `webview/src/**` → built by **Vite** to `dist/webview/` (hashed assets).
- `@opencode-ai/sdk` is bundled into the extension — no runtime `node_modules` needed in the packaged vsix.

## Commands
- `npm run lint` — typecheck both projects (run before claiming done).
- `npm run compile` — one-shot build of extension + webview into `dist/`.
- `npm run watch:extension` / `npm run watch:webview` — incremental rebuild on save.
- `npm run package:vsix` — produce `opencode-vscode-client-<version>.vsix` (self-contained; `--no-dependencies`).
- `npm run dev:install` — compile + package + force-install into VS Code. **Then reload the window.**

## Two dev loops — pick by goal

### Loop A — fast iteration (recommended for daily editing)
No vsix, no reinstall. Uses the VS Code **Extension Development Host**, which loads the extension straight from the workspace `dist/`.

1. Start the watchers (run once): Command Palette → `Tasks: Run Task` → **`watch (both)`**. Two terminals rebuild `dist/` on every save.
2. Press **F5** (config "Run Extension"). A new VS Code window opens with this extension loaded.
3. After edits: the watchers rebuild. To apply:
   - extension-host code → **Developer: Reload Window** (or the dev host restarts automatically);
   - webview code → reload the window too (the webview reads `dist/webview/index.html` once at panel creation, see `src/extension/webviewPanel.ts:616`).
4. Keep editing; only reload after a batch of changes. Repeat.

First F5 also runs the `compile` preLaunchTask, so `dist/` always exists even if you forgot the watchers.

### Loop B — install into your MAIN VS Code window
For testing next to your real files, or producing a shareable build. The installed extension is a **separate copy** in `~/.vscode/extensions/opencode.opencode-vscode-client-0.1.0/`, so Loop A's watchers do NOT touch it — you must reinstall.

```
npm run dev:install        # compile → package → code --install-extension --force
```
Then in VS Code: `Cmd+Shift+P` → `Developer: Reload Window`.

`scripts/dev-install.sh` auto-detects the `code` CLI: PATH → `/Applications/Visual Studio Code.app/...` → Cursor → Insiders.

## Important gotchas
- **Loop A vs Loop B copies are different.** Workspace `dist/` (Loop A) ≠ installed copy in `~/.vscode/extensions/` (Loop B). Changes you see in the F5 dev host will NOT appear in your main window until you run `dev:install`.
- **Webview has no HMR.** It loads a built `index.html`; reload the window after webview edits. True HMR would need a Vite dev server wired into the webview (not implemented).
- **Don't edit `dist/`.** It is generated; always edit `src/` and `webview/src/`.
- **VS Code webview restrictions:** `window.prompt/confirm/alert` don't work; use inline editors and host-clipboard (`copyText` message). `navigator.clipboard` is unreliable — the host fallback is required.

## Before committing
1. `npm run lint` clean.
2. `npm run compile` clean.
3. For shareable/test builds: `npm run dev:install` and reload, then sanity-check in the running extension.

## Packaging details
- `.vscodeignore` excludes `node_modules/**`, `src/**`, `webview/src/**`, `docs/**`, `scripts/**` → the vsix ships only `dist/`, `media/`, `package.json`, `readme.md`.
- `vsce package --no-dependencies` is correct because esbuild bundles the SDK; runtime requires are only Node built-ins + `vscode`.
- Bump `version` in `package.json` before a release-quality build.
