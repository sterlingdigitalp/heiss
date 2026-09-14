import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { JsonStore, withStoreWriteLock, StoreConflictError } from "../src/index.js";

const storeModule = resolve(dirname(fileURLToPath(import.meta.url)), "../src/index.ts");
const WRITERS = 6;
const SAVES_EACH = 25;

// Each writer repeatedly opens the store, adds one uniquely named key, and
// saves; on a conflict it reopens and tries again, like a real command. A lost
// update shows up as a missing key at the end.
const writer = `
  const [path, signals] = process.argv.slice(1);
  const { JsonStore, StoreConflictError } = await import(${JSON.stringify(storeModule)});
  const { existsSync, readFileSync, writeFileSync } = await import("node:fs");
  writeFileSync(signals + "/ready-" + process.pid, "");
  const idle = new Int32Array(new SharedArrayBuffer(4));
  // Sleep-poll while others boot (spinning would starve them), then spin to
  // the shared start instant so the race is sub-millisecond.
  while (!existsSync(signals + "/go")) Atomics.wait(idle, 0, 0, 1);
  const startAt = Number(readFileSync(signals + "/go", "utf8"));
  while (Date.now() < startAt) {}
  for (let i = 0; i < ${SAVES_EACH}; i++) {
    for (;;) {
      const store = new JsonStore(path);
      store.state.settings.notificationKeys["w" + process.pid + "-" + i] = "x";
      try { store.save(); break; }
      catch (error) { if (!(error instanceof StoreConflictError)) { console.error(error); process.exit(2); } }
    }
  }
`;

function runWriter(path: string, signals: string): Promise<number> {
  return new Promise((done) => {
    // Own timeout under the test runner's; SIGKILL so nothing lingers.
    const child = execFile(process.execPath, ["--import", "tsx", "--input-type=module", "-e", writer, path, signals],
      { timeout: 180_000, killSignal: "SIGKILL" }, (error, _out, stderr) => {
        if (error) console.error(stderr);
        done(error ? (typeof error.code === "number" ? error.code : 1) : 0);
      });
    const kill = () => child.kill("SIGKILL");
    process.once("exit", kill);
    child.once("exit", () => process.removeListener("exit", kill));
  });
}

describe("farm store write lock", () => {
  it("never loses an update when processes save concurrently", { timeout: 300_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "heiss-store-"));
    const path = join(dir, "farm.json");
    new JsonStore(path).save();
    const signals = mkdtempSync(join(tmpdir(), "heiss-store-go-"));
    const running = Array.from({ length: WRITERS }, () => runWriter(path, signals));
    // tsx boots take ~9s idle and far longer under a loaded full suite.
    const readyBy = Date.now() + 90_000;
    while (readdirSync(signals).length < WRITERS && Date.now() < readyBy) await new Promise((r) => setTimeout(r, 50));
    const ready = readdirSync(signals).length;
    writeFileSync(join(signals, "go"), String(Date.now() + 500));
    assert.equal(ready, WRITERS, "all writers booted before the race started");
    assert.deepEqual((await Promise.all(running)).filter((code) => code !== 0), [], "no writer crashed");

    const keys = Object.keys(new JsonStore(path).state.settings.notificationKeys);
    assert.equal(keys.length, WRITERS * SAVES_EACH, "every save survived");
    assert.deepEqual(readdirSync(dir).filter((file) => file !== "farm.json"), [], "no lock or temp files left");
  });

  it("reclaims a lock left by a dead writer", () => {
    const dir = mkdtempSync(join(tmpdir(), "heiss-store-"));
    const path = join(dir, "farm.json");
    writeFileSync(`${path}.lock`, JSON.stringify({ pid: 2_147_483_000, processStartedAt: 0, acquiredAt: Date.now(), purpose: "crashed" }));
    const store = new JsonStore(path);
    store.state.settings.dailyActionCap = 7;
    store.save();
    assert.equal(JSON.parse(readFileSync(path, "utf8")).settings.dailyActionCap, 7);
  });

  it("reports a conflict instead of waiting forever on a live holder", { timeout: 30_000 }, () => {
    const dir = mkdtempSync(join(tmpdir(), "heiss-store-"));
    const path = join(dir, "farm.json");
    // This process is alive and the lock is fresh, so it cannot be reclaimed.
    writeFileSync(`${path}.lock`, JSON.stringify({ pid: process.pid, processStartedAt: 0, acquiredAt: Date.now(), purpose: "held" }));
    assert.throws(() => withStoreWriteLock(path, () => "never"), StoreConflictError);
  });
});
