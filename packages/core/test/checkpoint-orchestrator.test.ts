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
  claimQueueItem,
  storeLocally,
  createCheckpoint,
  advanceCheckpoint,
  resumeSession,
  checkpointSession,
  remainingSteps,
  postCycleScript,
  type DeviceDriver,
  type FarmSession,
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
  const dir = mkdtempSync(join(tmpdir(), "heiss-core-"));
  return join(dir, "farm.json");
}

describe("checkpoint resume", () => {
  it("resumes remaining steps including after publish (post-warmup)", () => {
    const script = postCycleScript(["saas"]);
    let cp = createCheckpoint();
    cp = advanceCheckpoint(cp, script[0]!);
    cp = advanceCheckpoint(cp, script[1]!);
    const rem = remainingSteps(script, cp);
    assert.equal(rem.length, script.length - 2);
    assert.equal(rem[0], script[2]);

    // Crash after publish: posted=true must still be resumable for post-warmup
    const afterPublish: FarmSession = {
      id: "s1",
      accountId: "a",
      deviceId: "d",
      kind: "post",
      status: "checkpointed",
      startedAt: "t",
      updatedAt: "t",
      checkpoint: { ...cp, posted: true, stepIndex: 8 },
      activityLog: [],
    };
    const rPosted = resumeSession(afterPublish);
    assert.equal(rPosted.status, "running");
    assert.equal(rPosted.checkpoint.posted, true);

    const ok: FarmSession = {
      ...afterPublish,
      checkpoint: { ...cp, posted: false },
    };
    const r = resumeSession(ok);
    assert.equal(r.status, "running");

    assert.throws(
      () =>
        resumeSession({
          ...ok,
          status: "completed",
        }),
      /already completed/,
    );

    const completed = checkpointSession({ ...r, status: "running" });
    assert.equal(completed.status, "checkpointed");
  });
});

describe("farm orchestrator (shipped path)", () => {
  it("blocks fresh from posting, posts matured with pre/post warmup, warms X/LinkedIn only", async () => {
    const store = new JsonStore(storePath());
    seedDemoFarm(store);
    const driver = new RecordingDriver();
    const orch = new FarmOrchestrator(store, driver);

    const { content, queueItem } = dropContent({
      kind: "carousel",
      mediaRef: "1.jpg",
      slides: ["1.jpg", "2.jpg"],
      caption: "hello",
      music: "beat",
      accountIds: ["acc-tt-fresh", "acc-tt-mature", "acc-ig-mature"],
      createdBy: "test",
    });
    store.state.contents.push(content);
    store.state.queue.push(queueItem);
    store.save();

    // Try to force-run: mature gets post; fresh should not get post:publish
    const result = await orch.runOnce({
      runnerId: "runner-test",
      timeOfDay: "09:00",
      maxSessions: 20,
    });

    assert.ok(result.sessions.length > 0);

    const ttMatureSession = result.sessions.find(
      (s) => s.accountId === "acc-tt-mature" && s.kind === "post",
    );
    assert.ok(ttMatureSession, "matured TikTok should get a post session");
    assert.equal(ttMatureSession.status, "completed");
    assert.ok(
      ttMatureSession.activityLog.some((l) => l.includes("pre_warmup:")),
      "pre-post warmup required",
    );
    assert.ok(
      ttMatureSession.activityLog.some((l) => l.includes("post:publish")),
      "publish required",
    );
    assert.ok(
      ttMatureSession.activityLog.some((l) => l.includes("post_warmup:")),
      "post-post warmup required",
    );

    const freshPost = result.sessions.find(
      (s) => s.accountId === "acc-tt-fresh" && s.kind === "post",
    );
    assert.equal(freshPost, undefined, "fresh must not get post session");

    const xSession = result.sessions.find((s) => s.accountId === "acc-x-warm");
    assert.ok(xSession);
    assert.notEqual(xSession.kind, "post");
    assert.ok(!xSession.activityLog.some((l) => l.includes("post:publish")));

    const liSession = result.sessions.find((s) => s.accountId === "acc-li-warm");
    assert.ok(liSession);
    assert.notEqual(liSession.kind, "post");

    const posted = store.state.queue.find((q) => q.status === "posted");
    assert.ok(posted);
    assert.equal(posted.assignedAccountId, "acc-tt-mature");
  });

  it("crash-recovery resumes without double-posting the same queue item", async () => {
    const store = new JsonStore(storePath());
    seedDemoFarm(store);
    // Only one matured account with slot for cleaner test
    store.state.accounts = store.state.accounts.filter(
      (a) => a.id === "acc-tt-mature" || a.id === "acc-x-warm",
    );
    store.state.slots = store.state.slots.filter((s) => s.accountId === "acc-tt-mature");

    const { content, queueItem } = dropContent({
      kind: "video",
      mediaRef: "v.mp4",
      caption: "resume me",
      accountIds: ["acc-tt-mature"],
      createdBy: "test",
    });
    store.state.contents.push(content);
    // Pre-claim/store so post path is ready
    let item = claimQueueItem(queueItem, "runner-test");
    item = storeLocally(item, "/local/v.mp4");
    store.state.queue.push(item);
    store.save();

    const driver = new RecordingDriver();
    const orch = new FarmOrchestrator(store, driver);

    const first = await orch.runOnce({
      runnerId: "runner-test",
      timeOfDay: "09:00",
      maxSessions: 1,
      interruptAfterSteps: 2,
    });
    assert.equal(first.interrupted, true);
    const mid = first.sessions[0]!;
    assert.equal(mid.status, "checkpointed");
    assert.ok(mid.checkpoint.stepIndex >= 2);
    assert.notEqual(
      store.state.queue.find((q) => q.id === item.id)?.status,
      "posted",
      "must not have posted yet",
    );

    // Reload store from disk (simulate controller restart)
    const store2 = new JsonStore(store.path);
    const driver2 = new RecordingDriver();
    const orch2 = new FarmOrchestrator(store2, driver2);
    const second = await orch2.runOnce({
      runnerId: "runner-test",
      timeOfDay: "09:00",
      resumeFirst: false,
      maxSessions: 5,
    });

    const resumed = second.sessions.find((s) => s.id === mid.id) ??
      store2.state.sessions.find((s) => s.id === mid.id);
    assert.ok(resumed);
    assert.equal(resumed.status, "completed");
    assert.equal(resumed.checkpoint.posted, true);

    const q = store2.state.queue.find((q) => q.id === item.id)!;
    assert.equal(q.status, "posted");

    // Attempt another run must not double-post
    const third = await orch2.runOnce({
      runnerId: "runner-test",
      timeOfDay: "09:00",
      maxSessions: 5,
    });
    const postSessions = store2.state.sessions.filter(
      (s) => s.kind === "post" && s.queueItemId === item.id && s.checkpoint.posted,
    );
    assert.equal(postSessions.length, 1, "exactly one successful post for the item");
    assert.ok(third.sessions.every((s) => s.queueItemId !== item.id || s.id === mid.id));
  });
});
