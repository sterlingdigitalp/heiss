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

// Child processes boot once, then race for the lock at a shared instant in
// many rounds (the reclaim race is microseconds wide, and each boot costs
// seconds). Each hold appends "start"/"end" lines; an interleaving means two
// processes believed they owned the build directory.
const lockModule = resolve(dirname(fileURLToPath(import.meta.url)), "../src/runner-lock.ts");
const CONTENDERS = 8;
const ROUNDS = 12;
const contender = `
  const [dir] = process.argv.slice(1);
  const { withRunnerBuildLock, RunnerBusyError } = await import(${JSON.stringify(lockModule)});
  const { appendFileSync, existsSync, readFileSync, writeFileSync } = await import("node:fs");
  const idle = new Int32Array(new SharedArrayBuffer(4));
  writeFileSync(dir + "/ready-" + process.pid, "");
  for (let round = 0; round < ${ROUNDS}; round++) {
    // Sleep-poll while others boot or finish (spinning would starve them),
    // then spin to the shared start instant so the race is sub-millisecond.
    while (!existsSync(dir + "/go-" + round)) Atomics.wait(idle, 0, 0, 1);
    const startAt = Number(readFileSync(dir + "/go-" + round, "utf8"));
    while (Date.now() < startAt) {}
    try {
      await withRunnerBuildLock("contender", async () => {
        appendFileSync(dir + "/holds-" + round, "start " + process.pid + "\\n");
        await new Promise((r) => setTimeout(r, 40));
        appendFileSync(dir + "/holds-" + round, "end " + process.pid + "\\n");
      }, dir + "/runner-build.lock");
    } catch (error) {
      if (!(error instanceof RunnerBusyError)) { console.error(error); process.exit(2); }
    }
    writeFileSync(dir + "/done-" + round + "-" + process.pid, "");
  }
`;

function runContender(dir: string): Promise<number> {
  return new Promise((done) => {
    // Own timeout under the test's; SIGKILL so nothing lingers.
    const child = execFile(process.execPath, ["--import", "tsx", "--input-type=module", "-e", contender, dir],
      { timeout: 180_000, killSignal: "SIGKILL" }, (error) => done(error ? (typeof error.code === "number" ? error.code : 1) : 0));
    const kill = () => child.kill("SIGKILL");
    process.once("exit", kill);
    child.once("exit", () => process.removeListener("exit", kill));
  });
}

const count = (dir: string, prefix: string) => readdirSync(dir).filter((file) => file.startsWith(prefix)).length;
async function waitFor(condition: () => boolean, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  while (!condition() && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
  return condition();
}

describe("runner build lock across processes", () => {
  for (const [name, seedStale] of [["fresh lock", false], ["stale lock reclaim", true]] as const) {
    it(`never lets two processes hold it at once (${name})`, { timeout: 300_000 }, async () => {
      const dir = mkdtempSync(join(tmpdir(), "heiss-lock-race-"));
      const lock = join(dir, "runner-build.lock");
      const running = Array.from({ length: CONTENDERS }, () => runContender(dir));
      // tsx boots take ~9s idle and far longer under a loaded full suite.
      const booted = await waitFor(() => count(dir, "ready-") === CONTENDERS, 150_000);
      let collided = false;
      let codes: number[];
      try {
        for (let round = 0; round < ROUNDS && booted; round++) {
          if (seedStale) writeFileSync(lock, JSON.stringify(record({ pid: 2_147_483_000, acquiredAt: Date.now() })));
          writeFileSync(join(dir, `go-${round}`), String(Date.now() + 150));
          if (!await waitFor(() => count(dir, `done-${round}-`) === CONTENDERS, 30_000)) break;
          const lines = existsSync(join(dir, `holds-${round}`))
            ? readFileSync(join(dir, `holds-${round}`), "utf8").trim().split("\n").filter(Boolean) : [];
          assert.ok(lines.length >= 2, `round ${round}: someone acquired the lock`);
          for (let i = 0; i < lines.length; i += 2) {
            assert.match(lines[i]!, /^start /);
            assert.equal(lines[i + 1], lines[i]!.replace("start", "end"), `round ${round}: hold ${i / 2} overlapped another`);
          }
          if (lines.length / 2 < CONTENDERS) collided = true;
          assert.equal(existsSync(lock), false, `round ${round}: released`);
        }
      } finally {
        // Always release every waiting round — a failed assertion must not leave
        // children sleeping until their timeout and holding the runner open.
        for (let round = 0; round < ROUNDS; round++) writeFileSync(join(dir, `go-${round}`), "0");
        codes = await Promise.all(running);
      }
      assert.ok(booted, "all contenders booted before the race started");
      assert.deepEqual(codes.filter((code) => code !== 0), [], "no contender crashed");
      assert.equal(count(dir, "done-"), CONTENDERS * ROUNDS, "every round completed");
      assert.ok(collided, "contenders actually collided in at least one round");
      assert.deepEqual(readdirSync(dir).filter((file) => /\.tmp$|\.reclaim$|\.lock$/.test(file)), [], "no temp files, guard, or lock left");
    });
  }
});
