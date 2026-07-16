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
  type DeviceActionContext,
  type DeviceSessionResult,
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

class BatchDriver extends RecordingDriver {
  readonly kind = "ios" as const;
  sessions: Array<{ accountId: string; steps: string[]; startIndex: number; context: DeviceActionContext }> = [];
  sessionFailure?: Error & { completedSteps?: number; failureKind?: string };
  async runSession(
    _deviceId: string,
    accountId: string,
    _sessionId: string,
    plannedSteps: string[],
    startIndex: number,
    context: DeviceActionContext,
  ): Promise<DeviceSessionResult> {
    this.sessions.push({ accountId, steps: plannedSteps, startIndex, context });
    if (this.sessionFailure) throw this.sessionFailure;
    return {
      ok: true,
      detail: "device batch complete",
      completedSteps: plannedSteps.length,
      stepDetails: plannedSteps.map((step) => `batch:${step}`),
      heartbeatAt: "2026-07-12T14:01:00.000Z",
      journal: "session.json",
    };
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
  it("advances warmup maturity once per calendar day", async () => {
    const store = new JsonStore(storePath());
    seedDemoFarm(store);
    store.state.accounts = store.state.accounts.filter((a) => a.id === "acc-tt-fresh");
    store.state.slots = [];
    const orch = new FarmOrchestrator(store, new RecordingDriver());

    await orch.runOnce({ runnerId: "r", timeOfDay: "09:00", now: "2026-07-12T14:00:00.000Z" });
    assert.equal(store.state.accounts[0]!.trustScore, 25);
    const sameDay = await orch.runOnce({ runnerId: "r", timeOfDay: "15:00", now: "2026-07-12T20:00:00.000Z" });
    assert.equal(sameDay.sessions.length, 0);
    assert.equal(store.state.accounts[0]!.trustScore, 25);
    await orch.runOnce({ runnerId: "r", timeOfDay: "09:00", now: "2026-07-13T14:00:00.000Z" });
    assert.equal(store.state.accounts[0]!.trustScore, 50);
  });

  it("checkpoints and releases locks when a device action fails", async () => {
    const store = new JsonStore(storePath());
    seedDemoFarm(store);
    store.state.accounts = store.state.accounts.filter((a) => a.id === "acc-tt-fresh");
    store.state.slots = [];
    const failing: DeviceDriver = {
      kind: "ios",
      async connect() {}, async disconnect() {},
      async runAction() { throw new Error("runner did not acknowledge execution"); },
    };
    const result = await new FarmOrchestrator(store, failing).runOnce({ runnerId: "r", timeOfDay: "09:00" });
    assert.equal(result.interrupted, true);
    assert.equal(result.sessions[0]!.status, "checkpointed");
    assert.deepEqual(store.locks.snapshot().devices, {});
    assert.match(result.sessions[0]!.activityLog[0]!, /action_failed/);
    assert.equal(result.sessions[0]!.retryCount, undefined);
    assert.equal(result.sessions[0]!.transportRetryCount, 1);
    assert.ok(result.sessions[0]!.nextRetryAt);
  });

  it("checkpoints and releases locks when device connect fails", async () => {
    const store = new JsonStore(storePath());
    seedDemoFarm(store);
    store.state.accounts = store.state.accounts.filter((a) => a.id === "acc-tt-fresh");
    store.state.slots = [];
    const unreachable: DeviceDriver = {
      kind: "ios",
      async connect() { throw new Error("device UDID not found on USB"); },
      async disconnect() {},
      async runAction() { throw new Error("unreachable"); },
    };
    const result = await new FarmOrchestrator(store, unreachable).runOnce({ runnerId: "r", timeOfDay: "09:00" });
    assert.equal(result.interrupted, true);
    assert.equal(result.sessions[0]!.status, "checkpointed");
    assert.deepEqual(store.locks.snapshot().devices, {});
    assert.match(result.sessions[0]!.lastError!, /connect_failed/);
    assert.equal(result.sessions[0]!.retryCount, undefined);
    assert.equal(result.sessions[0]!.transportRetryCount, 1);
    assert.ok(result.sessions[0]!.nextRetryAt);
    // The persisted session must be checkpointed too, not stranded as running.
    const reloaded = new JsonStore(store.path);
    assert.equal(reloaded.state.sessions[0]!.status, "checkpointed");
    assert.deepEqual(reloaded.locks.snapshot().devices, {});
  });

  it("honors emergency stop and daily action caps before device actions", async () => {
    const store = new JsonStore(storePath()); seedDemoFarm(store);
    store.state.accounts = store.state.accounts.filter((a) => a.id === "acc-tt-fresh");
    const driver = new RecordingDriver();
    store.state.settings.emergencyStop = true;
    const stopped = await new FarmOrchestrator(store, driver).runOnce({ runnerId: "r", timeOfDay: "20:30" });
    assert.equal(stopped.sessions.length, 0);
    assert.equal(driver.actions.length, 0);
    store.state.settings.emergencyStop = false;
    store.state.settings.maintenance = { mode: "active", reason: "upgrade" };
    const maintained = await new FarmOrchestrator(store, driver).runOnce({ runnerId: "r", timeOfDay: "20:30" });
    assert.equal(maintained.sessions.length, 0);
    assert.match(maintained.activity[0]!, /maintenance_active/);
    store.state.settings.maintenance = { mode: "running" };
    store.state.settings.accountDailyActionCap = 1;
    store.state.activity.push({ id: "used", at: "2026-07-13T20:00:00.000Z", accountId: "acc-tt-fresh", kind: "action", message: "used" });
    const capped = await new FarmOrchestrator(store, driver).runOnce({ runnerId: "r", timeOfDay: "20:30", now: "2026-07-13T21:00:00.000Z" });
    assert.equal(capped.interrupted, true);
    assert.equal(driver.actions.length, 0);
    assert.match(capped.sessions[0]!.lastError!, /safety_cap/);
  });

  it("sends a complete warmup session to the device and journals all progress", async () => {
    const store = new JsonStore(storePath()); seedDemoFarm(store);
    store.state.accounts = store.state.accounts.filter((account) => account.id === "acc-tt-fresh");
    store.state.slots = [];
    const driver = new BatchDriver();
    const result = await new FarmOrchestrator(store, driver).runOnce({
      runnerId: "r", timeOfDay: "20:00", now: "2026-07-12T14:00:00.000Z",
    });
    assert.equal(driver.sessions.length, 1);
    assert.equal(driver.actions.length, 0, "batched sessions must not cross USB once per gesture");
    assert.equal(result.sessions[0]!.status, "completed");
    assert.equal(result.sessions[0]!.checkpoint.stepIndex, driver.sessions[0]!.steps.length);
    assert.equal(result.sessions[0]!.heartbeatAt, "2026-07-12T14:01:00.000Z");
    assert.ok(store.state.activity.some((event) => event.kind === "session_heartbeat"));
  });

  it("uses harmless identity canaries to clear current attention checkpoints", async () => {
    const store = new JsonStore(storePath()); seedDemoFarm(store);
    const account = store.state.accounts.find((candidate) => candidate.id === "acc-tt-fresh")!;
    account.preflightStatus = "attention";
    store.state.sessions.push({
      id: "paused", kind: "warmup", accountId: account.id, deviceId: account.deviceId,
      status: "checkpointed", checkpoint: createCheckpoint(), plannedSteps: ["feed:scroll"],
      requiresAttention: true, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    const results = await new FarmOrchestrator(store, new RecordingDriver()).verifyPreflight({
      accountIds: [account.id], lowTrustFirst: true, transitionRing: true,
    });
    assert.equal(results.length, 2, "a one-account transition ring closes back on its first account");
    assert.ok(results.every((result) => result.ok && result.trustScore === account.trustScore));
    assert.equal(account.lastVerifiedHandle, account.handle);
    assert.ok(account.identityVerifiedAt);
    assert.equal(store.state.sessions.at(-1)!.requiresAttention, false);
  });

  it("retains partial on-device progress and pauses account mismatch for attention", async () => {
    const store = new JsonStore(storePath()); seedDemoFarm(store);
    store.state.accounts = store.state.accounts.filter((account) => account.id === "acc-tt-fresh");
    store.state.slots = [];
    const driver = new BatchDriver();
    driver.sessionFailure = Object.assign(new Error("exact handle did not verify"), {
      completedSteps: 4, failureKind: "account_mismatch",
    });
    const first = await new FarmOrchestrator(store, driver).runOnce({
      runnerId: "r", timeOfDay: "20:00", now: "2026-07-12T14:00:00.000Z",
    });
    assert.equal(first.sessions[0]!.checkpoint.stepIndex, 4);
    assert.equal(first.sessions[0]!.failureKind, "account_mismatch");
    assert.equal(first.sessions[0]!.requiresAttention, true);
    assert.equal(first.sessions[0]!.nextRetryAt, undefined);

    const automatic = await new FarmOrchestrator(store, new BatchDriver()).runOnce({
      runnerId: "r", timeOfDay: "20:00", now: "2026-07-12T15:00:00.000Z",
    });
    assert.equal(automatic.sessions.length, 0, "attention checkpoints must not retry autonomously");
  });

  it("processes due accounts platform-major and excludes pending onboarding", async () => {
    const store = new JsonStore(storePath()); seedDemoFarm(store);
    store.state.accounts = store.state.accounts.filter((account) => ["acc-x-warm", "acc-tt-fresh", "acc-ig-mature", "acc-yt-warm"].includes(account.id));
    store.state.slots = [];
    for (const account of store.state.accounts) {
      account.lastWarmupAt = undefined;
      account.preflightStatus = account.platform === "instagram" ? "pending" : "ready";
    }
    const driver = new BatchDriver();
    await new FarmOrchestrator(store, driver).runOnce({
      runnerId: "r", timeOfDay: "20:00", now: "2026-07-12T14:00:00.000Z",
    });
    assert.deepEqual(driver.sessions.map((session) => session.context.platform), ["x", "tiktok", "youtube"]);
    assert.ok(store.state.activity.some((event) => event.kind === "preflight_required" && event.accountId === "acc-ig-mature"));
  });

  it("keeps the most advanced checkpoint and does not start another session during backoff", async () => {
    const store = new JsonStore(storePath());
    seedDemoFarm(store);
    store.state.accounts = store.state.accounts.filter((a) => a.id === "acc-tt-fresh");
    store.state.slots = [];
    const account = store.state.accounts[0]!;
    const base: FarmSession = {
      id: "zero", accountId: account.id, deviceId: account.deviceId,
      kind: "warmup", status: "checkpointed",
      startedAt: "2026-07-12T00:00:00.000Z", updatedAt: "2026-07-12T00:01:00.000Z",
      checkpoint: createCheckpoint(), activityLog: [], nextRetryAt: "2026-07-12T01:00:00.000Z",
    };
    store.state.sessions.push(base, {
      ...base, id: "advanced", updatedAt: "2026-07-12T00:02:00.000Z",
      checkpoint: { stepIndex: 8, stepsCompleted: Array(8).fill("warmup:scroll") },
    });
    const driver = new RecordingDriver();
    const result = await new FarmOrchestrator(store, driver).runOnce({
      runnerId: "r", timeOfDay: "09:00", now: "2026-07-12T00:30:00.000Z",
    });
    assert.equal(result.sessions.length, 0);
    assert.equal(driver.actions.length, 0);
    assert.equal(store.state.sessions.find((s) => s.id === "advanced")!.status, "checkpointed");
    assert.equal(store.state.sessions.find((s) => s.id === "zero")!.status, "failed");
  });

  it("explicit resume bypasses retry backoff", async () => {
    const store = new JsonStore(storePath()); seedDemoFarm(store);
    store.state.accounts = store.state.accounts.filter((a) => a.id === "acc-tt-fresh");
    const account = store.state.accounts[0]!;
    store.state.sessions.push({
      id: "waiting", accountId: account.id, deviceId: account.deviceId,
      kind: "warmup", status: "checkpointed",
      startedAt: "2026-07-12T00:00:00.000Z", updatedAt: "2026-07-12T00:00:00.000Z",
      checkpoint: createCheckpoint(), activityLog: [], nextRetryAt: "2026-07-13T00:00:00.000Z",
    });
    const result = await new FarmOrchestrator(store, new RecordingDriver()).runOnce({
      runnerId: "r", timeOfDay: "09:00", now: "2026-07-12T01:00:00.000Z", resumeFirst: true,
    });
    assert.equal(result.sessions[0]!.status, "completed");
  });

  it("defers a resume when another live session owns its device lock", async () => {
    const store = new JsonStore(storePath());
    seedDemoFarm(store);
    store.state.accounts = store.state.accounts.filter((a) => a.id === "acc-tt-fresh");
    const account = store.state.accounts[0]!;
    const session: FarmSession = {
      id: "waiting", accountId: account.id, deviceId: account.deviceId,
      kind: "warmup", status: "checkpointed",
      startedAt: "2026-07-12T00:00:00.000Z", updatedAt: "2026-07-12T00:00:00.000Z",
      checkpoint: createCheckpoint(), activityLog: [],
    };
    store.state.sessions.push(session);
    store.locks.acquireDevice(account.deviceId, "other-live-session");
    store.save();
    const result = await new FarmOrchestrator(store, new RecordingDriver()).runOnce({ runnerId: "r", timeOfDay: "09:00" });
    assert.equal(result.sessions[0]!.status, "checkpointed");
    assert.ok(result.activity.some((line) => line.startsWith("resume_deferred:")));
  });

  it("recovers a process-crashed running session from disk", async () => {
    const path = storePath();
    const store = new JsonStore(path); seedDemoFarm(store);
    store.state.accounts = store.state.accounts.filter((a) => a.id === "acc-tt-fresh");
    const account = store.state.accounts[0]!;
    store.state.sessions.push({
      id: "crashed", accountId: account.id, deviceId: account.deviceId,
      kind: "warmup", status: "running",
      startedAt: "2026-07-12T00:00:00.000Z", updatedAt: "2026-07-12T00:00:00.000Z",
      checkpoint: createCheckpoint(), activityLog: [],
    });
    store.locks.acquireDevice(account.deviceId, "crashed"); store.save();
    const recovered = new JsonStore(path);
    assert.equal(recovered.state.sessions[0]!.status, "checkpointed");
    // A daemon killed mid-session must not strand the device lock: the reload
    // recovers the session AND frees the lock so other consumers aren't blocked.
    assert.equal(recovered.locks.isDeviceLocked(account.deviceId), false);
    assert.deepEqual(recovered.state.locks.devices, {});
    const result = await new FarmOrchestrator(recovered, new RecordingDriver()).runOnce({ runnerId: "r", timeOfDay: "09:00" });
    assert.equal(result.sessions[0]!.status, "completed");
  });

  it("blocks fresh from posting, posts matured with pre/post warmup, warms X/YouTube only", async () => {
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

    const ytSession = result.sessions.find((s) => s.accountId === "acc-yt-warm");
    assert.ok(ytSession);
    assert.notEqual(ytSession.kind, "post");

    const delivered = store.state.queue.find((q) =>
      q.postedAccountIds?.includes("acc-tt-mature"),
    );
    assert.ok(delivered);
    assert.equal(delivered.status, "stored_local", "fresh target remains pending");
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

  it("does not refill the same local-day slot after UTC midnight (evening double-post)", async () => {
    const store = new JsonStore(storePath());
    seedDemoFarm(store);
    store.state.settings.timeZone = "America/Chicago";
    store.state.accounts = store.state.accounts.filter((a) => a.id === "acc-tt-mature");
    store.state.slots = [{ id: "slot-23", accountId: "acc-tt-mature", timeOfDay: "23:00", enabled: true }];
    const drop1 = dropContent({
      kind: "video", mediaRef: "a.mp4", caption: "one",
      accountIds: ["acc-tt-mature"], createdBy: "test",
    });
    store.state.contents.push(drop1.content); store.state.queue.push(drop1.queueItem); store.save();
    const orch = new FarmOrchestrator(store, new RecordingDriver());

    // 23:05 local on Jul 12 — already Jul 13 in UTC.
    const first = await orch.runOnce({ runnerId: "r", timeOfDay: "23:00", now: "2026-07-13T04:05:00.000Z" });
    assert.ok(first.sessions.some((s) => s.kind === "post" && s.checkpoint.posted));

    // Second Cloud Drop later the same local evening must wait for tomorrow's slot.
    const drop2 = dropContent({
      kind: "video", mediaRef: "b.mp4", caption: "two",
      accountIds: ["acc-tt-mature"], createdBy: "test",
    });
    store.state.contents.push(drop2.content); store.state.queue.push(drop2.queueItem); store.save();
    const sameEvening = await orch.runOnce({ runnerId: "r", timeOfDay: "23:00", now: "2026-07-13T04:35:00.000Z" });
    assert.equal(sameEvening.sessions.filter((s) => s.kind === "post").length, 0, "same local-day slot must not refill");

    // Next local evening the second drop posts.
    const nextEvening = await orch.runOnce({ runnerId: "r", timeOfDay: "23:00", now: "2026-07-14T04:30:00.000Z" });
    assert.ok(nextEvening.sessions.some((s) => s.kind === "post" && s.checkpoint.posted));
  });

  it("verifies an attempted publish after failure instead of tapping publish twice", async () => {
    const store = new JsonStore(storePath());
    seedDemoFarm(store);
    store.state.accounts = store.state.accounts.filter((a) => a.id === "acc-tt-mature");
    store.state.slots = store.state.slots.filter((s) => s.accountId === "acc-tt-mature");
    const drop = dropContent({
      kind: "video", mediaRef: "v.mp4", caption: "two phase",
      accountIds: ["acc-tt-mature"], createdBy: "test",
    });
    store.state.contents.push(drop.content); store.state.queue.push(drop.queueItem); store.save();
    const firstDriver = new RecordingDriver();
    firstDriver.runAction = async (_deviceId, _accountId, action) => {
      firstDriver.actions.push(action);
      if (action === "post:publish") throw new Error("connection lost after command delivery");
      return { ok: true, detail: `sim:${action}` };
    };
    const first = await new FarmOrchestrator(store, firstDriver).runOnce({
      runnerId: "r", timeOfDay: "09:00", now: "2026-07-12T14:00:00.000Z",
    });
    assert.equal(first.interrupted, true);
    assert.equal(first.sessions[0]!.checkpoint.publishAttempted, true);
    assert.equal(first.sessions[0]!.checkpoint.posted, false);

    const resumedDriver = new RecordingDriver();
    await new FarmOrchestrator(store, resumedDriver).runOnce({
      runnerId: "r", timeOfDay: "09:00", now: "2026-07-12T14:06:00.000Z",
    });
    assert.ok(resumedDriver.actions.includes("post:verify_published"));
    assert.equal(resumedDriver.actions.includes("post:publish"), false);
    assert.equal(store.state.queue[0]!.status, "posted");
  });
});
