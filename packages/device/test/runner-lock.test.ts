import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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

// Child processes race for the lock at the same instant. Each appends
// "start"/"end" lines around a short hold; overlapping holds would mean two
// processes believed they owned the build directory.
const lockModule = resolve(dirname(fileURLToPath(import.meta.url)), "../src/runner-lock.ts");
const contender = `
  const [path, log, dir] = process.argv.slice(1);
  const { withRunnerBuildLock, RunnerBusyError } = await import(${JSON.stringify(lockModule)});
  const { appendFileSync, existsSync, writeFileSync } = await import("node:fs");
  // tsx boot takes seconds; report ready, then spin until every contender is released together.
  writeFileSync(dir + "/ready-" + process.pid, "");
  while (!existsSync(dir + "/go")) {}
  try {
    await withRunnerBuildLock("contender", async () => {
      appendFileSync(log, "start " + process.pid + "\\n");
      await new Promise((r) => setTimeout(r, 150));
      appendFileSync(log, "end " + process.pid + "\\n");
    }, path);
  } catch (error) {
    if (!(error instanceof RunnerBusyError)) { console.error(error); process.exit(2); }
  }
`;

function runContender(path: string, log: string, dir: string): Promise<number> {
  return new Promise((done) => {
    // Own timeout well under the test runner's, SIGKILL so nothing lingers.
    const child = execFile(process.execPath, ["--import", "tsx", "--input-type=module", "-e", contender, path, log, dir],
      { timeout: 20_000, killSignal: "SIGKILL" }, (error) => done(error ? (typeof error.code === "number" ? error.code : 1) : 0));
    const kill = () => child.kill("SIGKILL");
    process.once("exit", kill);
    child.once("exit", () => process.removeListener("exit", kill));
  });
}

describe("runner build lock across processes", () => {
  for (const [name, seedStale] of [["fresh lock", false], ["stale lock reclaim", true]] as const) {
    it(`never lets two processes hold it at once (${name})`, async () => {
      for (let round = 0; round < 2; round++) {
        const path = lockPath();
        const log = join(dirname(path), "holds.log");
        const signals = mkdtempSync(join(tmpdir(), "heiss-lock-go-"));
        writeFileSync(log, "");
        if (seedStale) writeFileSync(path, JSON.stringify(record({ pid: 2_147_483_000, acquiredAt: Date.now() })));
        const running = Array.from({ length: 8 }, () => runContender(path, log, signals));
        const readyBy = Date.now() + 25_000;
        while (readdirSync(signals).length < 8 && Date.now() < readyBy) await new Promise((r) => setTimeout(r, 50));
        writeFileSync(join(signals, "go"), "");
        const codes = await Promise.all(running);
        assert.deepEqual(codes.filter((code) => code !== 0), [], "no contender crashed");
        const lines = readFileSync(log, "utf8").trim().split("\n").filter(Boolean);
        assert.ok(lines.length >= 2, "someone acquired the lock");
        // All eight were released together while the first holds for 150ms,
        // so most must have been refused — otherwise there was no race.
        assert.ok(lines.length / 2 < 8, `contenders did not actually collide (${lines.length / 2} holds)`);
        for (let i = 0; i < lines.length; i += 2) {
          assert.match(lines[i]!, /^start /);
          assert.equal(lines[i + 1], lines[i]!.replace("start", "end"), `hold ${i / 2} overlapped another`);
        }
        assert.equal(existsSync(path), false, "released");
        assert.deepEqual(readdirSync(dirname(path)).filter((f) => f !== "holds.log"), [], "no temp files or guard left");
      }
    });
  }
});
