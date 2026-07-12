import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

function run(args: string[], dataDir: string) {
  return spawnSync(
    process.execPath,
    ["--import", "tsx", cli, ...args, "--data", dataDir],
    { encoding: "utf8", env: { ...process.env } },
  );
}

describe("farm CLI real-only path", () => {
  it("exposes setup status, devices list, signing show (no seed simulator)", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "heiss-farm-real-"));
    const seed = run(["seed"], dataDir);
    assert.notEqual(seed.status, 0, "seed must be rejected (no simulator)");
    assert.match(seed.stdout + seed.stderr, /simulator|removed|setup all/i);

    const status = run(["setup", "status"], dataDir);
    assert.equal(status.status, 0, status.stderr);
    const st = JSON.parse(status.stdout);
    assert.equal(st.ok, true);
    assert.ok(Array.isArray(st.steps));
    assert.ok(st.steps.some((s: { id: string }) => s.id === "usb_device"));
    assert.ok(st.steps.some((s: { id: string }) => s.id === "runner_installed"));

    const devices = run(["devices", "list"], dataDir);
    assert.equal(devices.status, 0, devices.stderr);
    const dl = JSON.parse(devices.stdout);
    assert.equal(dl.ok, true);
    assert.ok(Array.isArray(dl.devices));

    const signing = run(["signing", "show"], dataDir);
    assert.equal(signing.status, 0, signing.stderr);
    const sg = JSON.parse(signing.stdout);
    assert.equal(sg.ok, true);
    assert.ok(sg.config);
  });

  it("registers device only with real USB udid when present", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "heiss-farm-reg-"));
    const devices = run(["devices", "list"], dataDir);
    assert.equal(devices.status, 0);
    const dl = JSON.parse(devices.stdout);
    if (dl.devices.length === 0) {
      // No phone attached — register must fail
      const bad = run(["register-device", "Test", "NOT-A-REAL-UDID"], dataDir);
      assert.notEqual(bad.status, 0);
      return;
    }
    const u = dl.devices[0];
    const reg = run(["register-device", u.name, u.udid], dataDir);
    assert.equal(reg.status, 0, reg.stderr);
    const body = JSON.parse(reg.stdout);
    assert.equal(body.device.udid, u.udid);

    const add = run(
      ["add-account", body.device.id, "tiktok", "@real_user", "--stage", "fresh"],
      dataDir,
    );
    assert.equal(add.status, 0, add.stderr);
    const acc = JSON.parse(add.stdout);
    assert.equal(acc.account.platform, "tiktok");
    assert.equal(acc.account.stage, "fresh");
  });
});
