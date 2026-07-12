import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  RealIosDriver,
  parseDeviceList,
  planSigning,
  buildXcodeSignArgs,
  buildAscSignPlan,
  getSetupStatus,
} from "../src/index.js";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";

describe("RealIosDriver (physical path only)", () => {
  it("reports fully wired real capabilities, no simulator", () => {
    const ios = new RealIosDriver({
      async listDevices() {
        return [{ udid: "U1", name: "iPhone" }];
      },
      async tap() {},
      async swipe() {},
      async runScriptAction(_u, action) {
        return { ok: true, detail: `ok:${action}` };
      },
    });
    const caps = ios.capabilities();
    assert.equal(caps.unofficialApis, false);
    assert.equal(caps.usesOnDeviceTaps, true);
    assert.equal(caps.fullyWired, true);
    assert.equal(caps.simulator, false);
  });

  it("connects only when UDID present on USB list", async () => {
    const ios = new RealIosDriver({
      async listDevices() {
        return [{ udid: "REAL-UDID", name: "Phone" }];
      },
      async runScriptAction() {
        return { ok: true, detail: "x" };
      },
    });
    await assert.rejects(() => ios.connect("d1", "MISSING"), /not found on USB/);
    await ios.connect("d1", "REAL-UDID");
    const r = await ios.runAction("d1", "a1", "warmup:scroll");
    assert.equal(r.ok, true);
  });
});

describe("USB device list parsing", () => {
  it("parses devicectl-like JSON and skips simulators", () => {
    const devices = parseDeviceList({
      result: {
        devices: [
          {
            identifier: "AAAA-BBBB",
            name: "Pimpstick",
            deviceState: "available (paired)",
            hardwareProperties: {
              marketingName: "iPhone 13 Pro",
              productType: "iPhone14,2",
            },
            connectionProperties: {
              pairingState: "paired",
              transportType: "wired",
            },
          },
          {
            identifier: "SIM-1",
            name: "iPhone 15 Simulator",
            deviceType: "simulator",
            hardwareProperties: { deviceType: "simulator" },
          },
        ],
      },
    });
    assert.equal(devices.length, 1);
    assert.equal(devices[0]!.udid, "AAAA-BBBB");
    assert.equal(devices[0]!.available, true);
  });
});

describe("signing plans", () => {
  it("builds Xcode free-team args", () => {
    const plan = buildXcodeSignArgs({
      method: "xcode",
      teamId: "ABCDE12345",
      bundleId: "so.heiss.runner",
    });
    assert.equal(plan.method, "xcode");
    assert.ok(plan.xcodebuildArgs.some((a) => a.includes("ABCDE12345")));
    assert.ok(plan.notes.some((n) => /7 days/i.test(n)));
  });

  it("builds ASC plan when key material exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "heiss-asc-"));
    const key = join(dir, "AuthKey.p8");
    writeFileSync(key, "-----BEGIN PRIVATE KEY-----\nMII\n-----END PRIVATE KEY-----\n");
    const plan = buildAscSignPlan({
      method: "asc",
      ascKeyPath: key,
      ascKeyId: "KEYID123",
      ascIssuerId: "issuer-uuid",
      teamId: "TEAM123456",
      bundleId: "so.heiss.runner",
    });
    assert.equal(plan.method, "asc");
    assert.ok(plan.notes.some((n) => /App Store Connect/i.test(n)));
  });

  it("planSigning defaults to xcode", () => {
    const plan = planSigning({ method: "xcode", teamId: "T1" });
    assert.equal(plan.method, "xcode");
  });
});

describe("setup status", () => {
  it("returns ordered steps including USB and runner", async () => {
    const status = await getSetupStatus({
      hasRegisteredDevice: false,
      hasAccount: false,
      hasWarmupSession: false,
    });
    assert.ok(status.steps.length >= 5);
    assert.ok(status.steps.some((s) => s.id === "usb_device"));
    assert.ok(status.steps.some((s) => s.id === "runner_installed"));
    assert.ok(status.steps.some((s) => s.id === "signing"));
    assert.equal(typeof status.ready, "boolean");
  });
});
