import { randomUUID } from "node:crypto";
import {
  applyKeepWarm,
  applyWarmupProgress,
  canPost,
  isWarmOnlyPlatform,
  markPosting,
  postCycleScript,
  warmupOnlyScript,
} from "./lifecycle.js";
import {
  assignToAccount,
  claimQueueItem,
  ensureNotDoublePost,
  markPosted,
  storeLocally,
} from "./queue.js";
import {
  accountsFilledSlotOnDay,
  accountsNeedingSlotFill,
  calendarDay,
  pickAccountForQueueItem,
} from "./schedule.js";
import {
  advanceCheckpoint,
  checkpointSession,
  createCheckpoint,
  remainingSteps,
  resumeSession,
} from "./checkpoint.js";
import type { JsonStore } from "./store.js";
import type {
  FarmSession,
  QueueItem,
  SessionKind,
  SocialAccount,
} from "./types.js";

/** Abstraction for on-device actions (simulator or real iOS). */
export interface DeviceDriver {
  readonly kind: "simulator" | "ios";
  connect(deviceId: string, udid: string): Promise<void>;
  runAction(
    deviceId: string,
    accountId: string,
    action: string,
    context?: {
      platform: SocialAccount["platform"];
      handle: string;
      caption?: string;
      music?: string;
      mediaRef?: string;
      slides?: string[];
      searchTerms?: string[];
      uiProfile?: import("./types.js").PlatformUiProfile;
    },
  ): Promise<{ ok: true; detail: string }>;
  disconnect(deviceId: string): Promise<void>;
}

export interface RunOptions {
  runnerId: string;
  /** Local HH:mm used for schedule slot fill. */
  timeOfDay: string;
  /** Max sessions to start this tick. */
  maxSessions?: number;
  /** Interrupt after N steps (for crash-recovery tests). */
  interruptAfterSteps?: number;
  /** Force resume of checkpointed sessions first. */
  resumeFirst?: boolean;
  sessionId?: string;
  accountId?: string;
  /** Clock override (ISO) for day-scoped slot fill; defaults to now. */
  now?: string;
}

export interface RunResult {
  sessions: FarmSession[];
  activity: string[];
  interrupted: boolean;
}

export class FarmOrchestrator {
  constructor(
    private store: JsonStore,
    private driver: DeviceDriver,
  ) {}

  /**
   * One farm tick: resume checkpointed sessions, then plan new warmup/post/keep-warm.
   */
  async runOnce(opts: RunOptions): Promise<RunResult> {
    const activity: string[] = [];
    const sessions: FarmSession[] = [];
    let interrupted = false;
    const runNow = opts.now ?? new Date().toISOString();

    // A backoff-delayed checkpoint still owns the account logically even though
    // its device lock is released. Retain the checkpoint with the most progress
    // and retire any duplicates created by older controllers.
    const pendingByAccount = new Map<string, FarmSession[]>();
    for (const session of this.store.state.sessions.filter((item) => item.status === "checkpointed")) {
      const group = pendingByAccount.get(session.accountId) ?? [];
      group.push(session); pendingByAccount.set(session.accountId, group);
    }
    for (const group of pendingByAccount.values()) {
      group.sort((a, b) => b.checkpoint.stepIndex - a.checkpoint.stepIndex || b.updatedAt.localeCompare(a.updatedAt));
      for (const duplicate of group.slice(1)) {
        duplicate.status = "failed";
        duplicate.nextRetryAt = undefined;
        duplicate.lastError = `superseded_by_checkpoint:${group[0]!.id}`;
        duplicate.completedAt = runNow;
        duplicate.updatedAt = runNow;
      }
    }

    // 1) Resume incomplete sessions first
    const checkpointed = this.store.state.sessions.filter(
      (s) => s.status === "checkpointed"
        && (!opts.sessionId || s.id === opts.sessionId)
        && (!opts.accountId || s.accountId === opts.accountId)
        && (opts.resumeFirst || !s.nextRetryAt || s.nextRetryAt <= runNow),
    );
    for (const s of checkpointed) {
      const resumed = await this.continueSession(s, opts, activity);
      sessions.push(resumed.session);
      if (resumed.interrupted) {
        interrupted = true;
        this.store.save();
        return { sessions, activity, interrupted };
      }
    }

    if (opts.resumeFirst) {
      this.store.save();
      return { sessions, activity, interrupted };
    }

    // 2) Plan new sessions
    const max = opts.maxSessions ?? 50;
    let started = 0;
    const accountsAwaitingRetry = new Set(
      this.store.state.sessions.filter((s) => s.status === "checkpointed").map((s) => s.accountId),
    );

    // Posts for accounts with open slots + claimable content.
    // Exclusion is per-tick only — never lifetime "any historical post".
    // A second Cloud Drop on a later run (even the same calendar day) remains
    // claimable and will fill the open slot when the farm runs again.
    // Within one tick, an account is filled at most once (filledThisTick).
    const filledThisTick = accountsFilledSlotOnDay(
      this.store.state.sessions,
      opts.timeOfDay,
      calendarDay(runNow),
    );

    const needingPost = accountsNeedingSlotFill(
      this.store.state.accounts,
      this.store.state.slots,
      opts.timeOfDay,
      filledThisTick,
    );

    for (const account of needingPost) {
      if (started >= max) break;
      if (opts.accountId && account.id !== opts.accountId) continue;
      if (accountsAwaitingRetry.has(account.id)) continue;
      if (isWarmOnlyPlatform(account.platform)) continue;
      if (!canPost(account)) {
        activity.push(
          `blocked_post: account ${account.handle} is ${account.stage} (fresh cannot post)`,
        );
        this.store.pushActivity({
          kind: "blocked_post",
          accountId: account.id,
          message: `Fresh/immature account ${account.handle} cannot post`,
        });
        continue;
      }
      if (this.store.locks.isDeviceLocked(account.deviceId)) continue;
      if (filledThisTick.has(account.id)) continue;

      const queueItem = this.findClaimableForAccount(account.id);
      if (!queueItem) continue;

      const session = await this.startPostSession(
        account,
        queueItem,
        opts,
        activity,
      );
      sessions.push(session.session);
      started += 1;
      // Count toward slot fill when post completed or still in-flight (interrupted mid-post)
      if (
        session.session.kind === "post" &&
        (session.session.checkpoint.posted ||
          session.session.status === "checkpointed" ||
          session.session.status === "completed")
      ) {
        filledThisTick.add(account.id);
      }
      if (session.interrupted) {
        interrupted = true;
        this.store.save();
        return { sessions, activity, interrupted };
      }
    }

    // Warmups / keep-warm for remaining accounts
    for (const account of this.store.state.accounts) {
      if (started >= max) break;
      if (opts.accountId && account.id !== opts.accountId) continue;
      if (accountsAwaitingRetry.has(account.id)) continue;
      if (this.store.locks.isDeviceLocked(account.deviceId)) continue;
      // Skip if already had a session this tick
      if (sessions.some((s) => s.accountId === account.id)) continue;
      // Warmup maturity progresses at most once per calendar day. Post sessions
      // still include their pre/post engagement wrapper at every configured slot.
      if (account.lastWarmupAt && calendarDay(account.lastWarmupAt) === calendarDay(runNow)) {
        continue;
      }

      const kind: SessionKind =
        account.stage === "fresh" || account.stage === "warmed_up"
          ? "warmup"
          : "keep_warm";

      // Fresh still warms; matured keep-warm; warm-only always warm
      const session = await this.startWarmSession(account, kind, opts, activity);
      sessions.push(session.session);
      started += 1;
      if (session.interrupted) {
        interrupted = true;
        this.store.save();
        return { sessions, activity, interrupted };
      }
    }

    this.store.save();
    return { sessions, activity, interrupted };
  }

  private findClaimableForAccount(accountId: string): QueueItem | undefined {
    return this.store.state.queue.find(
      (q) =>
        (q.status === "queued" ||
          (q.status === "stored_local" && !q.assignedAccountId)) &&
        q.accountIds.includes(accountId) &&
        !(q.postedAccountIds ?? []).includes(accountId) &&
        !this.store.locks.isContentLocked(q.id),
    );
  }

  private async startPostSession(
    account: SocialAccount,
    rawItem: QueueItem,
    opts: RunOptions,
    activity: string[],
  ): Promise<{ session: FarmSession; interrupted: boolean }> {
    let item = rawItem;
    if (item.status === "queued") {
      item = claimQueueItem(item, opts.runnerId);
      item = storeLocally(item, `/local/media/${item.contentId}`);
    }
    ensureNotDoublePost(item);
    item = assignToAccount(item, account.id);

    const idx = this.store.state.queue.findIndex((q) => q.id === item.id);
    this.store.state.queue[idx] = item;

    const session = this.createSession(account, "post", item.id, opts.timeOfDay);
    this.store.locks.acquireDevice(account.deviceId, session.id);
    this.store.locks.acquireContent(item.id, session.id);
    this.store.save();

    const script = postCycleScript(account.searchTerms);
    return this.executeSteps(session, account, script, opts, activity, item);
  }

  private async startWarmSession(
    account: SocialAccount,
    kind: SessionKind,
    opts: RunOptions,
    activity: string[],
  ): Promise<{ session: FarmSession; interrupted: boolean }> {
    const session = this.createSession(account, kind);
    this.store.locks.acquireDevice(account.deviceId, session.id);
    this.store.save();
    const script = warmupOnlyScript(account.searchTerms, account.trustScore);
    return this.executeSteps(session, account, script, opts, activity);
  }

  private createSession(
    account: SocialAccount,
    kind: SessionKind,
    queueItemId?: string,
    slotTimeOfDay?: string,
  ): FarmSession {
    const now = new Date().toISOString();
    const session: FarmSession = {
      id: randomUUID(),
      ownerPid: process.pid,
      accountId: account.id,
      deviceId: account.deviceId,
      kind,
      status: "running",
      queueItemId,
      slotTimeOfDay: kind === "post" ? slotTimeOfDay : undefined,
      startedAt: now,
      updatedAt: now,
      checkpoint: createCheckpoint(),
      activityLog: [],
    };
    this.store.state.sessions.push(session);
    return session;
  }

  private async continueSession(
    session: FarmSession,
    opts: RunOptions,
    activity: string[],
  ): Promise<{ session: FarmSession; interrupted: boolean }> {
    const account = this.store.state.accounts.find((a) => a.id === session.accountId);
    if (!account) {
      throw new Error(`Account ${session.accountId} missing for session ${session.id}`);
    }
    const deviceHolder = this.store.locks.holderOfDevice(account.deviceId);
    const contentHolder = session.queueItemId
      ? this.store.locks.holderOfContent(session.queueItemId)
      : undefined;
    if ((deviceHolder && deviceHolder !== session.id) || (contentHolder && contentHolder !== session.id)) {
      const message = `resume_deferred: resources held by ${deviceHolder ?? contentHolder}`;
      activity.push(message);
      this.store.pushActivity({
        kind: "resume_deferred",
        sessionId: session.id,
        accountId: account.id,
        message,
      });
      return { session, interrupted: false };
    }
    let s = { ...resumeSession(session), ownerPid: process.pid };
    this.replaceSession(s);
    activity.push(`resume: session ${s.id} from step ${s.checkpoint.stepIndex}`);
    this.store.pushActivity({
      kind: "resume",
      sessionId: s.id,
      accountId: account.id,
      message: `Resumed from step ${s.checkpoint.stepIndex}`,
    });

    this.store.locks.acquireDevice(account.deviceId, s.id);
    if (s.queueItemId) {
      this.store.locks.acquireContent(s.queueItemId, s.id);
    }
    this.store.save();

    const script =
      s.kind === "post"
        ? postCycleScript(account.searchTerms)
        : warmupOnlyScript(account.searchTerms, account.trustScore);

    let item: QueueItem | undefined;
    if (s.queueItemId) {
      item = this.store.state.queue.find((q) => q.id === s.queueItemId);
    }
    return this.executeSteps(s, account, script, opts, activity, item);
  }

  private async executeSteps(
    session: FarmSession,
    account: SocialAccount,
    script: string[],
    opts: RunOptions,
    activity: string[],
    queueItem?: QueueItem,
  ): Promise<{ session: FarmSession; interrupted: boolean }> {
    const runNow = opts.now ?? new Date().toISOString();
    const device = this.store.state.devices.find((d) => d.id === account.deviceId);
    if (device) {
      await this.driver.connect(device.id, device.udid);
    }

    let s = { ...session, activityLog: [...session.activityLog] };
    const steps = remainingSteps(script, s.checkpoint);
    let stepsThisRun = 0;
    let interrupted = false;

    for (const step of steps) {
      // Fresh post gate even mid-script
      if (step.startsWith("post:") && !canPost(account) && s.kind === "post") {
        const msg = `blocked_post: ${account.handle} still not eligible`;
        s.activityLog.push(msg);
        activity.push(msg);
        s = {
          ...s,
          status: "failed",
          updatedAt: runNow,
        };
        this.replaceSession(s);
        this.releaseLocks(s);
        this.store.save();
        return { session: s, interrupted: false };
      }

      if (s.checkpoint.posted && step.startsWith("post:")) {
        // Skip post steps already done (resume after publish; no double-post)
        s = {
          ...s,
          checkpoint: advanceCheckpoint(s.checkpoint, `skip:${step}`),
          updatedAt: runNow,
        };
        this.replaceSession(s);
        continue;
      }

      const deviceAction = step === "post:publish" && s.checkpoint.publishAttempted
        ? "post:verify_published"
        : step;
      if (step === "post:publish" && !s.checkpoint.publishAttempted) {
        s = {
          ...s,
          checkpoint: { ...s.checkpoint, publishAttempted: true },
          updatedAt: runNow,
        };
        this.replaceSession(s);
        this.store.save();
      }
      let result: { ok: true; detail: string };
      try {
        const content = queueItem
          ? this.store.state.contents.find((c) => c.id === queueItem.contentId)
          : undefined;
        result = await this.driver.runAction(account.deviceId, account.id, deviceAction, {
          platform: account.platform,
          handle: account.handle,
          caption: content?.caption,
          music: content?.music,
          mediaRef: content?.mediaRef,
          slides: content?.slides,
          searchTerms: account.searchTerms,
          uiProfile: this.store.state.uiProfiles[account.platform],
        });
      } catch (error) {
        const message = `action_failed: ${deviceAction} → ${error instanceof Error ? error.message : String(error)}`;
        s.activityLog.push(message);
        activity.push(`${account.handle}: ${message}`);
        this.store.pushActivity({
          kind: "action_failed",
          sessionId: s.id,
          accountId: account.id,
          deviceId: account.deviceId,
          message,
        });
        const retryCount = (s.retryCount ?? 0) + 1;
        const retryMinutes = Math.min(120, 5 * 2 ** (retryCount - 1));
        s = checkpointSession({
          ...s,
          retryCount,
          nextRetryAt: new Date(new Date(runNow).getTime() + retryMinutes * 60 * 1000).toISOString(),
          lastError: message,
          updatedAt: runNow,
        });
        this.replaceSession(s);
        this.releaseLocks(s);
        if (device) await this.driver.disconnect(device.id).catch(() => undefined);
        this.store.save();
        return { session: s, interrupted: true };
      }
      const line = `${deviceAction} → ${result.detail}`;
      s.activityLog.push(line);
      activity.push(`${account.handle}: ${line}`);
      this.store.pushActivity({
        kind: "action",
        sessionId: s.id,
        accountId: account.id,
        deviceId: account.deviceId,
        message: line,
      });

      const extras: Parameters<typeof advanceCheckpoint>[2] = {};
      if (step === "post:publish") {
        extras.posted = true;
        extras.contentAssigned = true;
        if (queueItem) {
          ensureNotDoublePost(queueItem);
          const posted = markPosted(queueItem);
          const qi = this.store.state.queue.findIndex((q) => q.id === posted.id);
          this.store.state.queue[qi] = posted;
          activity.push(`posted: ${queueItem.id} via ${account.handle}`);
        }
      }

      s = {
        ...s,
        checkpoint: advanceCheckpoint(s.checkpoint, step, extras),
        updatedAt: runNow,
      };
      this.replaceSession(s);
      this.store.save();
      stepsThisRun += 1;

      if (
        opts.interruptAfterSteps !== undefined &&
        stepsThisRun >= opts.interruptAfterSteps
      ) {
        s = checkpointSession(s);
        this.replaceSession(s);
        // Release locks on interrupt so a stuck resume cannot pin the device forever.
        // Queue item stays assigned/posted so it cannot be double-claimed; resume re-acquires.
        this.releaseLocks(s);
        this.store.save();
        interrupted = true;
        activity.push(`checkpoint: session ${s.id} after ${stepsThisRun} steps`);
        return { session: s, interrupted };
      }
    }

    // Complete session + update account lifecycle
    s = {
      ...s,
      status: "completed",
      nextRetryAt: undefined,
      lastError: undefined,
      completedAt: runNow,
      updatedAt: runNow,
    };
    this.replaceSession(s);

    let updated = account;
    if (s.kind === "post" && s.checkpoint.posted) {
      updated = markPosting(applyWarmupProgress(account, runNow), runNow);
    } else if (s.kind === "warmup") {
      updated = applyWarmupProgress(account, runNow);
    } else {
      updated = applyKeepWarm(account, runNow);
    }
    const ai = this.store.state.accounts.findIndex((a) => a.id === account.id);
    this.store.state.accounts[ai] = updated;

    this.releaseLocks(s);
    this.store.save();
    if (device) {
      await this.driver.disconnect(device.id);
    }
    return { session: s, interrupted: false };
  }

  private replaceSession(session: FarmSession): void {
    const i = this.store.state.sessions.findIndex((s) => s.id === session.id);
    if (i >= 0) this.store.state.sessions[i] = session;
    else this.store.state.sessions.push(session);
  }

  private releaseLocks(session: FarmSession): void {
    this.store.locks.releaseDevice(session.deviceId, session.id);
    if (session.queueItemId) {
      this.store.locks.releaseContent(session.queueItemId, session.id);
    }
  }

  /** Plan helper used by CLI status. */
  planSummary(timeOfDay: string, now: string = new Date().toISOString()): {
    canPost: SocialAccount[];
    blockedFresh: SocialAccount[];
    warmOnly: SocialAccount[];
    needingSlots: SocialAccount[];
  } {
    // Status view mirrors execution: a day+time slot is filled at most once.
    const filledToday = accountsFilledSlotOnDay(
      this.store.state.sessions,
      timeOfDay,
      calendarDay(now),
    );
    return {
      canPost: this.store.state.accounts.filter((a) => canPost(a)),
      blockedFresh: this.store.state.accounts.filter((a) => !canPost(a) && !isWarmOnlyPlatform(a.platform)),
      warmOnly: this.store.state.accounts.filter((a) => isWarmOnlyPlatform(a.platform)),
      needingSlots: accountsNeedingSlotFill(
        this.store.state.accounts,
        this.store.state.slots,
        timeOfDay,
        filledToday,
      ),
    };
  }
}

/** Seed helpers for demos/tests. */
export function seedDemoFarm(store: JsonStore, ownerId?: string): void {
  const now = new Date().toISOString();
  const suffix = ownerId ? `-${ownerId.slice(0, 8)}` : "";
  const deviceKey = `dev-1${suffix}`;
  if (!store.state.devices.some((d) => d.id === deviceKey)) {
    store.state.devices.push({
      id: deviceKey,
      ownerId,
      name: "iPhone Farm 1",
      udid: "SIM-0001",
      online: true,
      createdAt: now,
    });
  }
  const deviceId = deviceKey;

  const ensure = (
    id: string,
    platform: SocialAccount["platform"],
    handle: string,
    stage: SocialAccount["stage"],
    trust: number,
  ) => {
    const scopedId = `${id}${suffix}`;
    if (!store.state.accounts.find((a) => a.id === scopedId)) {
      store.state.accounts.push({
        id: scopedId,
        ownerId,
        deviceId,
        platform,
        handle,
        stage,
        trustScore: trust,
        searchTerms: ["founders", "saas"],
        createdAt: now,
      });
    }
  };

  ensure("acc-tt-fresh", "tiktok", "@fresh_tt", "fresh", 0);
  ensure("acc-tt-mature", "tiktok", "@mature_tt", "matured", 100);
  ensure("acc-ig-mature", "instagram", "@mature_ig", "matured", 100);
  ensure("acc-x-warm", "x", "@warm_x", "matured", 100);
  ensure("acc-li-warm", "linkedin", "warm-li", "matured", 100);

  for (const baseId of ["acc-tt-mature", "acc-ig-mature"]) {
    const accId = `${baseId}${suffix}`;
    if (!store.state.slots.find((s) => s.accountId === accId && s.timeOfDay === "09:00")) {
      store.state.slots.push({
        id: randomUUID(),
        accountId: accId,
        timeOfDay: "09:00",
        enabled: true,
      });
    }
  }

  store.save();
}

export { pickAccountForQueueItem };
