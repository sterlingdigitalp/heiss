import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONTROLLER_LABEL,
  controllerPlistXml,
  controllerProgramArguments,
  stableNodePath,
} from "../src/daemon-agent.js";

describe("controller LaunchAgent", () => {
  it("prefers the built dist CLI under the current node, falls back to tsx", () => {
    const dir = mkdtempSync(join(tmpdir(), "heiss-agent-"));
    const dist = join(dir, "cli.js");
    const src = join(dir, "cli.ts");
    const missing = controllerProgramArguments({ dataDir: "/data", distCliPath: dist, srcCliPath: src });
    assert.deepEqual(missing.slice(0, 3), ["/usr/bin/env", "npx", "tsx"]);
    assert.ok(missing.includes(src));
    writeFileSync(dist, "// built");
    const built = controllerProgramArguments({ dataDir: "/data", distCliPath: dist, srcCliPath: src, intervalSec: 45 });
    assert.equal(built[0], stableNodePath());
    assert.equal(built[1], dist);
    assert.deepEqual(built.slice(2), ["daemon", "--data", "/data", "--interval-sec", "45"]);
    // The stable path must still be the same node binary.
    assert.ok(stableNodePath() === process.execPath || stableNodePath().endsWith("/bin/node"));
  });

  it("emits a persistent KeepAlive plist with escaped values", () => {
    const xml = controllerPlistXml({
      programArguments: ["/usr/local/bin/node", "/Users/o'brien/heiss & co/cli.js", "daemon"],
      dataDir: "/Users/x/.heiss/live",
      logPath: "/Users/x/.heiss/live/controller.log",
      environment: { PATH: "/usr/bin:<extra>" },
    });
    assert.match(xml, new RegExp(`<key>Label</key><string>${CONTROLLER_LABEL}</string>`));
    assert.match(xml, /<key>RunAtLoad<\/key><true\/>/);
    assert.match(xml, /<key>KeepAlive<\/key><true\/>/);
    assert.match(xml, /heiss &amp; co/);
    assert.match(xml, /&lt;extra&gt;/);
    assert.match(xml, /<key>HEISS_DATA<\/key><string>\/Users\/x\/.heiss\/live<\/string>/);
  });
});
