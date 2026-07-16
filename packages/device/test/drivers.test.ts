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

  it("delegates a frozen session once and returns the on-device checkpoint", async () => {
    let batchCalls = 0;
    const ios = new RealIosDriver({
      async listDevices() { return [{ udid: "REAL-UDID", name: "Phone" }]; },
      async runScriptAction() { return { ok: true, detail: "ping" }; },
      async runScriptSession(_udid, sessionId, steps, startIndex, context) {
        batchCalls += 1;
        assert.equal(sessionId, "session-1");
        assert.equal(startIndex, 2);
        assert.equal(context.handle, "@person");
        return { ok: true, detail: "batch", completedSteps: steps.length, journal: "session-1.json" };
      },
    });
    await ios.connect("d1", "REAL-UDID");
    const result = await ios.runSession("d1", "a1", "session-1", ["warmup:scroll", "warmup:search", "warmup:scroll"], 2, {
      platform: "tiktok", handle: "@person", searchTerms: ["housing"],
    });
    assert.equal(batchCalls, 1);
    assert.equal(result.completedSteps, 3);
    assert.equal(result.journal, "session-1.json");
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
          {
            identifier: "WIFI-1",
            name: "Network iPhone",
            deviceState: "available (paired)",
            hardwareProperties: { productType: "iPhone14,2" },
            connectionProperties: { pairingState: "paired", transportType: "localNetwork" },
          },
        ],
      },
    });
    assert.equal(devices.length, 2);
    assert.equal(devices.find((device) => device.udid === "AAAA-BBBB")?.available, true);
    assert.equal(devices.find((device) => device.udid === "WIFI-1")?.available, false);
  });

  it("keeps a wired connected tunnel online during a transient unavailable device state", () => {
    const [device] = parseDeviceList({
      result: {
        devices: [{
          identifier: "WIRED-1",
          deviceState: "unavailable",
          hardwareProperties: { deviceType: "iPhone", productType: "iPhone14,6" },
          connectionProperties: {
            pairingState: "paired",
            transportType: "wired",
            tunnelState: "connected",
          },
        }],
      },
    });
    assert.equal(device?.state, "connected");
    assert.equal(device?.available, true);
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
