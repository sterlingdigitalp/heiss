import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { findProjectRoot } from "../src/project-root.js";
import { JsonStore } from "@heiss/core";

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

function run(args: string[], dataDir: string) {
  return spawnSync(
    process.execPath,
    ["--import", "tsx", cli, ...args, "--data", dataDir],
    { encoding: "utf8", env: { ...process.env } },
  );
}

describe("farm CLI real-only path", () => {
  it("finds vendored runner sources when npm starts inside apps/farm", () => {
    const root = fileURLToPath(new URL("../../../", import.meta.url));
    assert.equal(findProjectRoot(join(root, "apps", "farm")), root.replace(/\/$/, ""));
    assert.equal(findProjectRoot("/"), root.replace(/\/$/, ""), "launchd cwd must fall back to the CLI module");
  });

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

  it("adds one named person with four linked platform handles atomically", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "heiss-farm-set-"));
    const store = new JsonStore(join(dataDir, "farm.json"));
    store.state.devices.push({ id: "d1", name: "iPhone", udid: "REAL", online: false, createdAt: new Date().toISOString() });
    store.save();
    const result = run([
      "add-account-set", "d1", "Person 2",
      "--instagram", "@ig2", "--tiktok", "@tt2", "--x", "@x2", "--youtube", "@yt2",
      "--terms", "humanoid robots,robotics",
    ], dataDir);
    assert.equal(result.status, 0, result.stderr);
    const body = JSON.parse(result.stdout);
    assert.equal(body.group.name, "Person 2");
    assert.equal(body.accounts.length, 4);
    assert.ok(body.accounts.every((account: { groupId: string }) => account.groupId === body.group.id));
    assert.ok(body.accounts.every((account: { searchTerms: string[] }) => account.searchTerms.join("|") === "humanoid robots|robotics"));
    assert.ok(body.accounts.every((account: { preflightStatus: string }) => account.preflightStatus === "pending"));
    const terms = run(["account-set", "terms", body.group.id, "automation, embodied AI"], dataDir);
    assert.equal(terms.status, 0, terms.stderr);
    const handle = run(["account", "handle", body.accounts[2].id, "@XCase"], dataDir);
    assert.equal(handle.status, 0, handle.stderr);
    const saved = new JsonStore(join(dataDir, "farm.json"));
    assert.ok(saved.state.accounts.every((account) => account.searchTerms.join("|") === "automation|embodied AI"));
    assert.equal(saved.state.accounts.find((account) => account.id === body.accounts[2].id)?.handle, "@XCase");
    assert.equal(saved.state.warmupSchedules.length, 4);
    assert.deepEqual(saved.state.warmupSchedules.map((schedule) => schedule.timeOfDay), ["15:30", "15:44", "15:58", "16:12"]);
    assert.deepEqual(saved.state.warmupSchedules.map((schedule) => saved.state.accounts.find((account) => account.id === schedule.accountId)?.platform), ["x", "tiktok", "instagram", "youtube"]);
    assert.ok(saved.state.warmupSchedules.every((schedule) => schedule.jitterMinutes <= 5));

    const ready = run(["account", "preflight", body.accounts[0].id, "ready"], dataDir);
    assert.equal(ready.status, 0, ready.stderr);
    assert.equal(JSON.parse(ready.stdout).account.preflightStatus, "ready");

    const disable = run(["warmup-schedule", "disable", body.accounts[3].id], dataDir);
    assert.equal(disable.status, 0, disable.stderr);
    assert.equal(JSON.parse(disable.stdout).schedule.enabled, false);
    const disabled = new JsonStore(join(dataDir, "farm.json"));
    assert.equal(disabled.state.warmupSchedules.find((schedule) => schedule.accountId === body.accounts[3].id)?.enabled, false);

    const enable = run(["warmup-schedule", "enable", body.accounts[3].id], dataDir);
    assert.equal(enable.status, 0, enable.stderr);
    assert.equal(JSON.parse(enable.stdout).schedule.enabled, true);
  });

  it("allows a fifth four-platform person on one iPhone", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "heiss-farm-five-"));
    const store = new JsonStore(join(dataDir, "farm.json"));
    store.state.devices.push({ id: "d1", name: "iPhone", udid: "REAL", online: false, createdAt: new Date().toISOString() });
    store.save();

    for (let person = 1; person <= 5; person += 1) {
      const result = run([
        "add-account-set", "d1", `Person ${person}`,
        "--instagram", `@ig${person}`, "--tiktok", `@tt${person}`,
        "--x", `@x${person}`, "--youtube", `@yt${person}`,
        "--terms", `topic ${person}`,
      ], dataDir);
      assert.equal(result.status, 0, `person ${person}: ${result.stderr}`);
    }

    const saved = new JsonStore(join(dataDir, "farm.json"));
    assert.equal(saved.state.accountGroups.length, 5);
    assert.equal(saved.state.accounts.length, 20);
    assert.equal(saved.state.warmupSchedules.length, 20);
    assert.deepEqual(
      ["x", "tiktok", "instagram", "youtube"].map((platform) =>
        saved.state.accounts.filter((account) => account.platform === platform).length),
      [5, 5, 5, 5],
    );
    assert.ok(saved.state.warmupSchedules.every((schedule) => /^([01]\d|2[0-3]):[0-5]\d$/.test(schedule.timeOfDay)));
  });
});
