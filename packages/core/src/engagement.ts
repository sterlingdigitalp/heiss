import { createHash, randomUUID } from "node:crypto";
import { stageIndex } from "./lifecycle.js";
import type {
  ActivityEvent,
  EngagementApproval,
  EngagementPolicy,
  EngagementTargetRecord,
  SocialAccount,
} from "./types.js";

export const AUTONOMOUS_REVIEWED_SESSION_THRESHOLD = 3;
export const DEFAULT_DAILY_LIKE_CAP = 2;
export const DEFAULT_DAILY_FOLLOW_CAP = 1;
export const DEFAULT_ENGAGEMENT_COOLDOWN_MINUTES = 720;
export const TARGET_DEDUPLICATION_DAYS = 30;

export interface EngagementAllowance {
  likes: number;
  follows: number;
  approvalId?: string;
  reason: string;
}

export function defaultEngagementPolicy(): EngagementPolicy {
  return {
    mode: "off",
    likesEnabled: false,
    followsEnabled: false,
    dailyLikeCap: DEFAULT_DAILY_LIKE_CAP,
    dailyFollowCap: DEFAULT_DAILY_FOLLOW_CAP,
    cooldownMinutes: DEFAULT_ENGAGEMENT_COOLDOWN_MINUTES,
    successfulReviewedSessions: 0,
  };
}

export function normalizeEngagementPolicy(policy?: Partial<EngagementPolicy>): EngagementPolicy {
  const defaults = defaultEngagementPolicy();
  return {
    mode: policy?.mode ?? defaults.mode,
    likesEnabled: policy?.likesEnabled ?? defaults.likesEnabled,
    followsEnabled: policy?.followsEnabled ?? defaults.followsEnabled,
    dailyLikeCap: bounded(policy?.dailyLikeCap, defaults.dailyLikeCap, 0, 5),
    dailyFollowCap: bounded(policy?.dailyFollowCap, defaults.dailyFollowCap, 0, 2),
    cooldownMinutes: bounded(policy?.cooldownMinutes, defaults.cooldownMinutes, 60, 10_080),
    successfulReviewedSessions: Math.max(0, Math.floor(policy?.successfulReviewedSessions ?? 0)),
  };
}

export function engagementAutonomousEligible(account: SocialAccount): boolean {
  const policy = normalizeEngagementPolicy(account.engagement);
  return stageIndex(account.stage) >= stageIndex("matured")
    && policy.successfulReviewedSessions >= AUTONOMOUS_REVIEWED_SESSION_THRESHOLD;
}

export function ensureDailyEngagementApproval(
  account: SocialAccount,
  approvals: EngagementApproval[],
  localDay: string,
  now = new Date().toISOString(),
): EngagementApproval | undefined {
  const policy = normalizeEngagementPolicy(account.engagement);
  for (const approval of approvals.filter((item) => item.accountId === account.id && item.localDay < localDay && ["pending", "approved"].includes(item.status))) {
    approval.status = "expired";
    approval.decidedAt ??= now;
  }
  if (policy.mode !== "review" || stageIndex(account.stage) < stageIndex("matured") || (!policy.likesEnabled && !policy.followsEnabled)) {
    return undefined;
  }
  const existing = approvals.find((item) => item.accountId === account.id && item.localDay === localDay);
  if (existing) return existing;
  const request: EngagementApproval = {
    id: randomUUID(),
    accountId: account.id,
    localDay,
    status: "pending",
    proposedLikes: policy.likesEnabled ? policy.dailyLikeCap : 0,
    proposedFollows: policy.followsEnabled ? policy.dailyFollowCap : 0,
    createdAt: now,
  };
  approvals.push(request);
  return request;
}

export function engagementAllowance(input: {
  account: SocialAccount;
  approvals: EngagementApproval[];
  activity: ActivityEvent[];
  localDay: string;
  now: string;
}): EngagementAllowance {
  const { account, approvals, activity, localDay, now } = input;
  const policy = normalizeEngagementPolicy(account.engagement);
  if (policy.mode === "off" || (!policy.likesEnabled && !policy.followsEnabled)) {
    return { likes: 0, follows: 0, reason: "engagement is off" };
  }
  if (stageIndex(account.stage) < stageIndex("matured")) {
    return { likes: 0, follows: 0, reason: "account is not mature" };
  }
  const today = activity.filter((event) => event.accountId === account.id
    && event.kind === "engagement"
    && String(event.meta?.localDay ?? "") === localDay
    && event.meta?.outcome === "executed");
  const likesUsed = today.filter((event) => event.meta?.action === "like").length;
  const followsUsed = today.filter((event) => event.meta?.action === "follow").length;
  const recentSession = [...activity].reverse().find((event) => event.accountId === account.id
    && event.kind === "engagement_session_completed");
  if (recentSession && new Date(now).getTime() - new Date(recentSession.at).getTime() < policy.cooldownMinutes * 60_000) {
    return { likes: 0, follows: 0, reason: "engagement cooldown is active" };
  }
  let approvalId: string | undefined;
  let likeLimit = policy.dailyLikeCap;
  let followLimit = policy.dailyFollowCap;
  if (policy.mode === "review") {
    const approval = approvals.find((item) => item.accountId === account.id && item.localDay === localDay && item.status === "approved");
    if (!approval) return { likes: 0, follows: 0, reason: "today's engagement review is not approved" };
    approvalId = approval.id;
    likeLimit = Math.min(likeLimit, approval.proposedLikes);
    followLimit = Math.min(followLimit, approval.proposedFollows);
  } else if (!engagementAutonomousEligible(account)) {
    return { likes: 0, follows: 0, reason: `autonomous mode requires ${AUTONOMOUS_REVIEWED_SESSION_THRESHOLD} successful reviewed sessions` };
  }
  return {
    likes: policy.likesEnabled ? Math.max(0, likeLimit - likesUsed) : 0,
    follows: policy.followsEnabled ? Math.max(0, followLimit - followsUsed) : 0,
    approvalId,
    reason: policy.mode,
  };
}

/**
 * Record a successful engagement, refreshing the timestamp when this account
 * already engaged the same target with the same action.
 *
 * The recorders used to insert only when the key had never been seen, by any
 * account. The denylist only looks back TARGET_DEDUPLICATION_DAYS, so once the
 * first record aged out every later engagement went unrecorded and the target
 * was immediately eligible again (audit 2026-09-14, reproduced).
 */
export function recordEngagementTarget(
  targets: EngagementTargetRecord[],
  entry: Omit<EngagementTargetRecord, "id" | "at">,
  now: string,
): EngagementTargetRecord {
  const existing = targets.find((target) =>
    target.accountId === entry.accountId && target.action === entry.action && target.targetKey === entry.targetKey);
  if (existing) {
    if (existing.at < now) existing.at = now;
    return existing;
  }
  const record: EngagementTargetRecord = { id: randomUUID(), ...entry, at: now };
  targets.push(record);
  return record;
}

/**
 * Non-reversible fingerprint of an X post key (which embeds the post's text),
 * so engagement records keep their no-third-party-content promise.
 */
export function xPostTargetKey(postKey: string): string {
  return `xpost:${createHash("sha256").update(postKey).digest("hex").slice(0, 32)}`;
}

export function activeBlockedTargetKeys(targets: EngagementTargetRecord[], now: string): string[] {
  const cutoff = new Date(now).getTime() - TARGET_DEDUPLICATION_DAYS * 86_400_000;
  return [...new Set(targets.filter((target) => new Date(target.at).getTime() >= cutoff).map((target) => target.targetKey))];
}

function bounded(value: number | undefined, fallback: number, min: number, max: number): number {
  const next = Number.isFinite(value) ? Math.floor(value!) : fallback;
  return Math.min(max, Math.max(min, next));
}
