import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  JsonStore,
  FarmOrchestrator,
  seedDemoFarm,
  dropContent,
  postCycleScript,
  type DeviceDriver,
} from "../src/index.js";

class RecordingDriver implements DeviceDriver {
  readonly kind = "simulator" as const;
  actions: string[] = [];
  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  async runAction(
    _deviceId: string,
    _accountId: string,
    action: string,
  ): Promise<{ ok: true; detail: string }> {
    this.actions.push(action);
    return { ok: true, detail: `sim:${action}` };
  }
}

function storePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "heiss-skep-"));
  return join(dir, "farm.json");
}

describe("skeptic regressions (shipped orchestrator path)", () => {
  it("second Cloud Drop posts on a later run (not blocked by historical posts)", async () => {
    const store = new JsonStore(storePath());
    seedDemoFarm(store);
    // Isolate to one matured TikTok account with a 09:00 slot
    store.state.accounts = store.state.accounts.filter((a) => a.id === "acc-tt-mature");
    store.state.slots = store.state.slots.filter((s) => s.accountId === "acc-tt-mature");

    const d1 = dropContent({
      kind: "video",
      mediaRef: "first.mp4",
      caption: "first",
      accountIds: ["acc-tt-mature"],
      createdBy: "test",
    });
    store.state.contents.push(d1.content);
    store.state.queue.push(d1.queueItem);
    store.save();

    const orch = new FarmOrchestrator(store, new RecordingDriver());
    const run1 = await orch.runOnce({
      runnerId: "r1",
      timeOfDay: "09:00",
      maxSessions: 5,
    });
    assert.equal(run1.interrupted, false);
    const posted1 = store.state.queue.filter((q) => q.status === "posted");
    assert.equal(posted1.length, 1);
    assert.equal(posted1[0]!.id, d1.queueItem.id);

    // Second Cloud Drop — must become posted on next farm run (not stuck queued forever)
    const d2 = dropContent({
      kind: "video",
      mediaRef: "second.mp4",
      caption: "second",
      accountIds: ["acc-tt-mature"],
      createdBy: "test",
    });
    store.state.contents.push(d2.content);
    store.state.queue.push(d2.queueItem);
    store.save();

    const run2 = await orch.runOnce({
      runnerId: "r1",
      timeOfDay: "09:00",
      maxSessions: 5,
    });
    assert.equal(run2.interrupted, false);

    const second = store.state.queue.find((q) => q.id === d2.queueItem.id);
    assert.ok(second);
    assert.equal(
      second.status,
      "posted",
      `second Cloud Drop must post; got status=${second.status}`,
    );
    const posted_after_second_drop_run = store.state.queue.filter(
      (q) => q.status === "posted",
    ).length;
    assert.equal(posted_after_second_drop_run, 2);
  });

  it("resume after post:publish finishes post-warmup without double-post or stuck locks", async () => {
    const store = new JsonStore(storePath());
    seedDemoFarm(store);
    store.state.accounts = store.state.accounts.filter((a) => a.id === "acc-tt-mature");
    store.state.slots = store.state.slots.filter((s) => s.accountId === "acc-tt-mature");

    const d = dropContent({
      kind: "video",
      mediaRef: "mid.mp4",
      caption: "crash after publish",
      accountIds: ["acc-tt-mature"],
      createdBy: "test",
    });
    store.state.contents.push(d.content);
    store.state.queue.push(d.queueItem);
    store.save();

    const script = postCycleScript(["founders", "saas"]);
    const publishIndex = script.indexOf("post:publish");
    assert.ok(publishIndex >= 0);
    const interruptAfter = publishIndex + 1; // complete through publish

    const orch = new FarmOrchestrator(store, new RecordingDriver());
    const mid = await orch.runOnce({
      runnerId: "r1",
      timeOfDay: "09:00",
      maxSessions: 1,
      interruptAfterSteps: interruptAfter,
    });
    assert.equal(mid.interrupted, true);
    const sess = mid.sessions[0]!;
    assert.equal(sess.status, "checkpointed");
    assert.equal(sess.checkpoint.posted, true, "must have published before interrupt");
    assert.equal(
      store.state.queue.find((q) => q.id === d.queueItem.id)?.status,
      "posted",
    );

    // Locks must be released on interrupt (device free)
    assert.equal(
      store.locks.isDeviceLocked(sess.deviceId),
      false,
      "device lock must be released on checkpoint interrupt",
    );
    assert.equal(
      store.locks.isContentLocked(d.queueItem.id),
      false,
      "content lock must be released on checkpoint interrupt",
    );

    // Persist + reload like a controller crash
    store.save();
    const store2 = new JsonStore(store.path);
    const orch2 = new FarmOrchestrator(store2, new RecordingDriver());

    // Resume must NOT throw "refuse double-post on resume"
    const resumed = await orch2.runOnce({
      runnerId: "r1",
      timeOfDay: "09:00",
      maxSessions: 5,
    });
    assert.equal(resumed.interrupted, false);

    const done = store2.state.sessions.find((s) => s.id === sess.id);
    assert.ok(done);
    assert.equal(done.status, "completed");
    assert.ok(
      done.activityLog.some((l) => l.includes("post_warmup:")) ||
        done.checkpoint.stepsCompleted.some((step) => step.includes("post_warmup")),
      "post-warmup must complete after resume",
    );

    // Still exactly one posted queue item (no double-post)
    assert.equal(
      store2.state.queue.filter((q) => q.id === d.queueItem.id && q.status === "posted")
        .length,
      1,
    );
    assert.equal(store2.locks.isDeviceLocked(sess.deviceId), false);
  });
});
