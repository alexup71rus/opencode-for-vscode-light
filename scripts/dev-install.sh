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

# 3. Locate the VS Code CLI: PATH first, then the macOS .app bundle, then Cursor.
CODE_CLI=""
for candidate in \
  "code" \
  "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" \
  "/Applications/Cursor.app/Contents/Resources/app/bin/cursor" \
  "/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code-insiders"; do
  if command -v "$candidate" >/dev/null 2>&1; then
    CODE_CLI="$candidate"
    break
  elif [ -x "$candidate" ]; then
    CODE_CLI="$candidate"
    break
  fi
done

if [ -z "$CODE_CLI" ]; then
  echo "ERROR: could not find a VS Code / Cursor CLI." >&2
  echo "Put 'code' on your PATH, or edit scripts/dev-install.sh to point at your editor." >&2
  exit 1
fi

echo "==> installing into: $CODE_CLI"
"$CODE_CLI" --install-extension "$VSIX" --force

cat <<EOF

Installed: $VSIX
In VS Code: open the Command Palette (Cmd+Shift+P) -> "Developer: Reload Window".
EOF
