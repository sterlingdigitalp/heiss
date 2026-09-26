const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// main.cjs requires "electron", which isn't resolvable outside an Electron
// process, so this reads it as source rather than executing it. The point is
// to pin that the desktop no longer carries its own launchd installer and
// instead defers to the CLI's `daemon` command (apps/farm/src/daemon-agent.ts),
// which waits out the bootout race, retries the bootstrap, and installs the
// watchdog agent — none of which the desktop's old copy did.
const source = fs.readFileSync(path.join(__dirname, "..", "main.cjs"), "utf8");

describe("desktop daemon control", () => {
  it("has no launchd/plist installer of its own", () => {
    for (const needle of ["launchctl", "bootstrap", "bootout", "<plist", "ProgramArguments"]) {
      assert.ok(!source.includes(needle), `main.cjs should not contain "${needle}"`);
    }
  });

  it("drives daemon install/uninstall/status through the farm CLI", () => {
    assert.match(source, /runFarm\(\["daemon",\s*"install"/);
    assert.match(source, /runFarm\(\["daemon",\s*"uninstall"/);
    assert.match(source, /runFarm\(\["daemon",\s*"status"/);
  });
});
