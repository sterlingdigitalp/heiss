import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// runCuratedEngagementOnce lives inside the CLI entry point, which runs on
// import, so pin its admission order from source (robustness review
// 2026-09-26, finding 1).
const source = readFileSync(fileURLToPath(new URL("../src/cli.ts", import.meta.url)), "utf8");
const start = source.indexOf("async function runCuratedEngagementOnce(");
const body = source.slice(start, source.indexOf("\nasync function ", start + 10));

describe("curated engagement admission", () => {
  it("refuses during an emergency stop before touching the device", () => {
    const stop = body.indexOf("settings.emergencyStop");
    assert.ok(stop > 0, "checks the emergency stop");
    assert.ok(stop < body.indexOf("acquireDevice("), "before taking the device lock");
    assert.ok(stop < body.indexOf("driver.connect("), "before connecting");
  });
  it("takes the device lock only after a target is chosen", () => {
    assert.ok(body.indexOf("if (!target)") < body.indexOf("acquireDevice("));
  });
});
