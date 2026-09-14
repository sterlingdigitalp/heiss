import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isRunnerLockStale,
  RunnerBusyError,
  RUNNER_LOCK_MAX_AGE_MS,
  withRunnerBuildLock,
  type RunnerLockRecord,
} from "../src/runner-lock.js";

const lockPath = () => join(mkdtempSync(join(tmpdir(), "heiss-lock-")), "runner-build.lock");
const record = (overrides: Partial<RunnerLockRecord> = {}): RunnerLockRecord => ({
  pid: 4242, processStartedAt: 1_000_000, acquiredAt: 2_000_000, purpose: "test", ...overrides,
});

describe("runner build lock", () => {
  it("judges staleness by missing record, dead PID, reused PID, and age", () => {
    const now = 2_000_000 + 60_000;
    assert.equal(isRunnerLockStale(null, now), true);
    assert.equal(isRunnerLockStale(record(), now, () => null), true, "dead PID");
    assert.equal(isRunnerLockStale(record(), now, () => 1_000_000 + 600_000), true, "reused PID");
    assert.equal(isRunnerLockStale(record(), now, () => 1_000_000 + 1_000), false, "live holder");
    assert.equal(isRunnerLockStale(record(), now, () => "unknown"), false, "alive, start time unreadable");
    assert.equal(
      isRunnerLockStale(record(), 2_000_000 + RUNNER_LOCK_MAX_AGE_MS + 1, () => 1_000_000),
      true,
      "older than the max age",
    );
  });

  it("recognises a live process through the real ps probe", () => {
    const live = record({
      pid: process.pid,
      processStartedAt: Math.round(Date.now() - process.uptime() * 1000),
      acquiredAt: Date.now(),
    });
    assert.equal(isRunnerLockStale(live, Date.now()), false);
    assert.equal(isRunnerLockStale({ ...live, processStartedAt: live.processStartedAt - 3_600_000 }, Date.now()), true);
  });

  it("holds the lock for the duration and releases it afterwards", async () => {
    const path = lockPath();
    const result = await withRunnerBuildLock("build", async () => {
      assert.equal(existsSync(path), true);
      assert.equal(JSON.parse(readFileSync(path, "utf8")).pid, process.pid);
      return 7;
    }, path);
    assert.equal(result, 7);
    assert.equal(existsSync(path), false);
  });

  it("releases the lock when the work throws", async () => {
    const path = lockPath();
    await assert.rejects(withRunnerBuildLock("build", async () => { throw new Error("boom"); }, path), /boom/);
    assert.equal(existsSync(path), false);
  });

  it("refuses a second holder without disturbing the first", async () => {
    const path = lockPath();
    await withRunnerBuildLock("outer install", async () => {
      await assert.rejects(
        withRunnerBuildLock("inner relaunch", async () => "never", path),
        (error: unknown) => error instanceof RunnerBusyError && /outer install/.test(error.message),
      );
      assert.equal(existsSync(path), true, "the holder's lock survives the refused attempt");
    }, path);
    assert.equal(existsSync(path), false);
  });

  it("reclaims a lock left by a dead process", async () => {
    const path = lockPath();
    // PIDs near the 32-bit max are never live on macOS.
    writeFileSync(path, JSON.stringify(record({ pid: 2_147_483_000, acquiredAt: Date.now() })));
    assert.equal(await withRunnerBuildLock("build", async () => "ran", path), "ran");
    assert.equal(existsSync(path), false);
  });

  it("reclaims a corrupt lock file", async () => {
    const path = lockPath();
    writeFileSync(path, "{not json");
    assert.equal(await withRunnerBuildLock("build", async () => "ran", path), "ran");
  });
});
