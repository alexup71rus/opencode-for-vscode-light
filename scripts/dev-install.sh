#!/usr/bin/env bash
# Build the extension, package a .vsix, and install it into VS Code so a
# window reload picks up the changes. Re-runnable after every edit.
#
#   npm run dev:install
#
# Exit codes: non-zero on failure. Safe to re-run.
set -euo pipefail

cd "$(dirname "$0")/.."

# 1. Build extension + webview into dist/.
echo "==> compiling"
npm run compile

# 2. Package a self-contained .vsix (runtime deps are bundled by esbuild,
#    node_modules are excluded by .vscodeignore).
echo "==> packaging vsix"
VSIX="opencode-vscode-client-$(node -p "require('./package.json').version").vsix"
vsce package --no-dependencies --no-git-tag-version -o "$VSIX"

# 3. Locate the editor CLI. An explicit EDITOR_CLI wins; otherwise auto-detect.
#    EDITOR_CLI accepts: a name on PATH, an absolute path to the binary, or a
#    short alias (code / codium / cursor / code-insiders) that resolves to the
#    macOS .app bundle under /Applications.
resolve_alias() {
  case "$1" in
    code)           echo "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" ;;
    codium)         echo "/Applications/VSCodium.app/Contents/Resources/app/bin/codium" ;;
    cursor)         echo "/Applications/Cursor.app/Contents/Resources/app/bin/cursor" ;;
    code-insiders)  echo "/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code-insiders" ;;
    *)              echo "" ;;
  esac
}

CODE_CLI=""
if [ -n "${EDITOR_CLI:-}" ]; then
  # Explicit hint: a name on PATH, an absolute path, or a known short alias.
  if command -v "$EDITOR_CLI" >/dev/null 2>&1; then
    CODE_CLI="$EDITOR_CLI"
  elif [ -x "$EDITOR_CLI" ]; then
    CODE_CLI="$EDITOR_CLI"
  else
    resolved="$(resolve_alias "$EDITOR_CLI")"
    if [ -n "$resolved" ] && [ -x "$resolved" ]; then
      CODE_CLI="$resolved"
    else
      echo "ERROR: EDITOR_CLI='$EDITOR_CLI' is not on PATH, not an executable path, and not a known alias." >&2
      echo "Known aliases: code, codium, cursor, code-insiders." >&2
      exit 1
    fi
  fi
fi

if [ -z "$CODE_CLI" ]; then
  # Auto-detect: PATH first, then the macOS .app bundles (VS Code → Codium → Cursor → Insiders).
  for candidate in \
    "code" \
    "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" \
    "codium" \
    "/Applications/VSCodium.app/Contents/Resources/app/bin/codium" \
    "/Applications/Cursor.app/Contents/Resources/app/bin/cursor" \
    "/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code-insiders"; do
    if command -v "$candidate" >/dev/null 2>&1 || [ -x "$candidate" ]; then
      CODE_CLI="$candidate"
      break
    fi
  done
fi

if [ -z "$CODE_CLI" ]; then
  echo "ERROR: could not find a VS Code / Codium / Cursor CLI." >&2
  echo "Put 'code' (or 'codium') on your PATH, set EDITOR_CLI=codium, or edit scripts/dev-install.sh." >&2
  exit 1
fi

echo "==> installing into: $CODE_CLI"
"$CODE_CLI" --install-extension "$VSIX" --force

cat <<EOF

Installed: $VSIX
In your editor: open the Command Palette (Cmd+Shift+P) -> "Developer: Reload Window".
EOF
