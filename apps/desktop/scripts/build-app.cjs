const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { build } = require("esbuild");

const root = path.resolve(__dirname, "../../..");
const desktop = path.resolve(__dirname, "..");
const outDir = path.join(root, "dist");
const finalApp = path.join(outDir, "Heiss.app");
const finalZip = path.join(outDir, "Heiss-mac-arm64.zip");

async function main() {
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), "heiss-desktop-"));
  try {
    fs.cpSync(path.join(root, "ios"), path.join(staging, "ios"), { recursive: true });
    fs.copyFileSync(path.join(desktop, "renderer.html"), path.join(staging, "renderer.html"));
    fs.copyFileSync(path.join(desktop, "preload.cjs"), path.join(staging, "preload.cjs"));
    fs.writeFileSync(path.join(staging, "package.json"), JSON.stringify({
      name: "heiss-desktop",
      productName: "Heiss",
      version: "0.1.0",
      main: "main.cjs",
    }, null, 2));

    await build({
      entryPoints: [path.join(desktop, "main.cjs")],
      outfile: path.join(staging, "main.cjs"),
      bundle: true,
      platform: "node",
      format: "cjs",
      target: "node20",
      external: ["electron"],
    });
    await build({
      entryPoints: [path.join(root, "apps/farm/src/cli.ts")],
      outfile: path.join(staging, "farm-cli.mjs"),
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node20",
      banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
    });

    const electronExecutable = require("electron");
    const electronApp = path.resolve(path.dirname(electronExecutable), "../..");
    fs.mkdirSync(outDir, { recursive: true });
    fs.rmSync(finalApp, { recursive: true, force: true });
    execFileSync("ditto", [electronApp, finalApp]);
    const resources = path.join(finalApp, "Contents", "Resources");
    fs.rmSync(path.join(resources, "default_app.asar"), { force: true });
    fs.cpSync(staging, path.join(resources, "app"), { recursive: true });
    const iconset = path.join(staging, "Heiss.iconset");
    fs.mkdirSync(iconset);
    const iconSource = path.join(desktop, "assets", "Heiss-icon.png");
    for (const [name, size] of [
      ["icon_16x16.png", 16], ["icon_16x16@2x.png", 32],
      ["icon_32x32.png", 32], ["icon_32x32@2x.png", 64],
      ["icon_128x128.png", 128], ["icon_128x128@2x.png", 256],
      ["icon_256x256.png", 256], ["icon_256x256@2x.png", 512],
      ["icon_512x512.png", 512], ["icon_512x512@2x.png", 1024],
    ]) {
      execFileSync("sips", ["-z", String(size), String(size), iconSource, "--out", path.join(iconset, name)], { stdio: "ignore" });
    }
    execFileSync("iconutil", ["-c", "icns", iconset, "-o", path.join(resources, "Heiss.icns")]);
    const oldExecutable = path.join(finalApp, "Contents", "MacOS", "Electron");
    const executable = path.join(finalApp, "Contents", "MacOS", "Heiss");
    fs.renameSync(oldExecutable, executable);
    const plist = path.join(finalApp, "Contents", "Info.plist");
    for (const [key, value] of [
      ["CFBundleDisplayName", "Heiss"],
      ["CFBundleName", "Heiss"],
      ["CFBundleIdentifier", "so.heiss.app"],
      ["CFBundleExecutable", "Heiss"],
      ["CFBundleIconFile", "Heiss.icns"],
      ["CFBundleShortVersionString", "0.1.0"],
      ["CFBundleVersion", "1"],
    ]) {
      execFileSync("plutil", ["-replace", key, "-string", value, plist]);
    }
    execFileSync("codesign", ["--force", "--deep", "--sign", "-", finalApp], { stdio: "pipe" });
    fs.rmSync(finalZip, { force: true });
    execFileSync("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", finalApp, finalZip]);
    console.log(JSON.stringify({
      ok: true,
      app: finalApp,
      architecture: process.arch === "x64" ? "x64" : "arm64",
      selfContained: true,
      zip: finalZip,
      open: `open ${finalApp}`,
    }, null, 2));
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
