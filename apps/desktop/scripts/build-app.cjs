/**
 * Package a minimal Heiss.app macOS bundle that launches Electron.
 * For distribution, prefer `electron-builder`; this creates a runnable .app shell.
 */
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const root = path.resolve(__dirname, "../../..");
const desktop = path.resolve(__dirname, "..");
const outDir = path.join(root, "dist");
const appDir = path.join(outDir, "Heiss.app");
const contents = path.join(appDir, "Contents");
const macos = path.join(contents, "MacOS");
const resources = path.join(contents, "Resources");

fs.mkdirSync(macos, { recursive: true });
fs.mkdirSync(resources, { recursive: true });

const launcher = `#!/bin/bash
DIR="$(cd "$(dirname "$0")/../../.." && pwd)"
# Prefer monorepo root (dev) or Resources (packaged)
if [ -f "$DIR/apps/desktop/main.cjs" ]; then
  ROOT="$DIR"
else
  ROOT="$(cd "$(dirname "$0")/../Resources/app" && pwd)/../.."
  if [ ! -f "$ROOT/package.json" ]; then
    ROOT="$(cd "$(dirname "$0")/../Resources" && pwd)"
  fi
fi
export HEISS_APP=1
cd "$ROOT"
if command -v npx >/dev/null 2>&1; then
  exec npx electron "$ROOT/apps/desktop"
else
  echo "npx/electron not found" >&2
  exit 1
fi
`;

fs.writeFileSync(path.join(macos, "Heiss"), launcher, { mode: 0o755 });
fs.chmodSync(path.join(macos, "Heiss"), 0o755);

const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key><string>Heiss</string>
  <key>CFBundleIdentifier</key><string>so.heiss.app</string>
  <key>CFBundleName</key><string>Heiss</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
`;
fs.writeFileSync(path.join(contents, "Info.plist"), plist);

// Copy desktop app into Resources for offline launch reference
const resApp = path.join(resources, "app");
fs.mkdirSync(resApp, { recursive: true });
for (const f of ["main.cjs", "preload.cjs", "renderer.html", "package.json"]) {
  fs.copyFileSync(path.join(desktop, f), path.join(resApp, f));
}

console.log(JSON.stringify({ ok: true, app: appDir, open: `open ${appDir}` }, null, 2));
