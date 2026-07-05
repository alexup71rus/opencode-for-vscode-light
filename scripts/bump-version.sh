#!/usr/bin/env bash
# Bump the extension version in package.json.
#
#   bash scripts/bump-version.sh            # default: patch  (0.1.0 -> 0.1.1)
#   bash scripts/bump-version.sh minor      #                 (0.1.0 -> 0.2.0)
#   bash scripts/bump-version.sh major      #                 (0.1.0 -> 1.0.0)
#   bash scripts/bump-version.sh 1.2.3      # explicit version
#
# Does NOT build, commit, or tag — those are separate steps. Run
# `npm run package:vsix` after this to produce the .vsix, then commit
# the bumped package.json and publish a release.
set -euo pipefail

cd "$(dirname "$0")/.."

BUMP="${1:-patch}"
CURRENT=$(node -p "require('./package.json').version")

# Compute the next version. We bypass `npm version` because it refuses to
# run with an unclean git working tree; this script should bump regardless.
NEW=$(node -e '
  const fs = require("fs");
  const p = JSON.parse(fs.readFileSync("./package.json", "utf8"));
  const cur = p.version.split(".").map(Number);
  const arg = process.argv[1];
  let next;
  if (/^\d+\.\d+\.\d+$/.test(arg)) {
    next = arg;
  } else if (arg === "patch") { next = cur[0] + "." + cur[1] + "." + (cur[2] + 1); }
  else if (arg === "minor")   { next = cur[0] + "." + (cur[1] + 1) + ".0"; }
  else if (arg === "major")   { next = (cur[0] + 1) + ".0.0"; }
  else {
    console.error("ERROR: argument must be patch | minor | major | x.y.z, got: " + arg);
    process.exit(1);
  }
  console.log(next);
' "$BUMP")

# Write the new version into package.json, preserving the existing 2-space
# formatting and trailing newline.
node -e '
  const fs = require("fs");
  const p = JSON.parse(fs.readFileSync("./package.json", "utf8"));
  p.version = process.argv[1];
  fs.writeFileSync("./package.json", JSON.stringify(p, null, 2) + "\n");
' "$NEW"

cat <<EOF

Bumped: ${CURRENT} -> ${NEW}
Next:   npm run package:vsix
        # then commit package.json + the new .vsix and publish a release
EOF
