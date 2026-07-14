/** Shared domain types for Heiss (Warmr-style farm). */

export type Platform = "tiktok" | "instagram" | "x" | "youtube";

/** Platforms that support scheduled auto-post (video/carousel). */
export const POSTING_PLATFORMS: readonly Platform[] = ["tiktok", "instagram"] as const;

/** Platforms that only warm (no auto-post). */
export const WARM_ONLY_PLATFORMS: readonly Platform[] = ["x", "youtube"] as const;

export type AccountStage =
  | "fresh"
  | "warmed_up"
  | "matured"
  | "kept_warm"
  | "posting";

export type WarmupAction = "scroll" | "like" | "follow" | "search";

export type ContentKind = "video" | "carousel";

export interface PlatformUiProfile {
  platform: Platform;
  revision: string;
  bundleId?: string;
  points: Record<string, { x: number; y: number }>;
  updatedAt: string;
}

export type QueueItemStatus =
  | "queued"
  | "claimed"
  | "stored_local"
  | "assigned"
  | "posted"
  | "failed"
  | "cancelled";

export type SessionKind = "warmup" | "post" | "keep_warm";

export type SessionStatus =
  | "pending"
  | "running"
  | "checkpointed"
  | "completed"
  | "failed";

export interface Device {
  id: string;
  ownerId?: string;
  /** Stable id from the owner's Mac when mirrored to Cloud Drop. */
  sourceId?: string;
  name: string;
  /** Simulated or physical identifier */
  udid: string;
  online: boolean;
  /** Optional SOCKS5 proxy assigned one-per-device. */
  proxyId?: string;
  createdAt: string;
}

export interface ProxyConfig {
  id: string;
  ownerId?: string;
  name: string;
  type: "socks5";
  host: string;
  port: number;
  username?: string;
  password?: string;
  deviceId?: string;
  createdAt: string;
}

export interface SocialAccount {
  id: string;
  ownerId?: string;
  sourceId?: string;
  /** Four-platform identity/account set this handle belongs to. */
  groupId?: string;
  deviceId: string;
  platform: Platform;
  handle: string;
  stage: AccountStage;
  /** Warmup progress toward maturity (0–100). */
  trustScore: number;
  /** Niche search terms for incubator-style calibration. */
  searchTerms: string[];
  createdAt: string;
  lastWarmupAt?: string;
  /** Distinct local calendar days with a completed warmup. */
  warmupLocalDays?: string[];
  lastPostAt?: string;
}

export interface AccountGroup {
  id: string;
  name: string;
  deviceId: string;
  createdAt: string;
}

export interface ContentAsset {
  id: string;
  ownerId?: string;
  kind: ContentKind;
  /** Local path or remote URL of primary media / first slide. */
  mediaRef: string;
  /** Additional carousel slides when kind === carousel. */
  slides?: string[];
  caption: string;
  music?: string;
  createdAt: string;
  createdBy: string;
}

export interface QueueItem {
  id: string;
  ownerId?: string;
  contentId: string;
  /** Target account ids selected at drop time. */
  accountIds: string[];
  status: QueueItemStatus;
  claimedBy?: string;
  claimedAt?: string;
  localPath?: string;
  assignedAccountId?: string;
  /** Targets that have already published this item; supports fan-out exactly once. */
  postedAccountIds?: string[];
  postedAt?: string;
  remoteUrl?: string;
  remoteQueueId?: string;
  remotePostedAccountIds?: string[];
  createdAt: string;
}

export interface ScheduleSlot {
  id: string;
  accountId: string;
  /** HH:mm local time of day. */
  timeOfDay: string;
  enabled: boolean;
}

export interface WarmupSchedule {
  id: string;
  accountId: string;
  /** Preferred HH:mm in the configured farm timezone. */
  timeOfDay: string;
  /** Deterministic daily variation applied around timeOfDay. */
  jitterMinutes: number;
  enabled: boolean;
}

export interface FarmSettings {
  timeZone: string;
  emergencyStop: boolean;
  dailyActionCap: number;
  accountDailyActionCap: number;
  /** Last observed state is persisted so disconnect alerts fire once per transition. */
  deviceStates: Record<string, "online" | "offline">;
  /** Notification fingerprints already delivered by the persistent controller. */
  notificationKeys: Record<string, string>;
}

export interface ActivityEvent {
  id: string;
  at: string;
  accountId?: string;
  deviceId?: string;
  sessionId?: string;
  kind: string;
  message: string;
  meta?: Record<string, unknown>;
}

export interface SessionCheckpoint {
  stepIndex: number;
  stepsCompleted: string[];
  lastAction?: string;
  contentAssigned?: boolean;
  posted?: boolean;
  publishAttempted?: boolean;
}

export interface FarmSession {
  id: string;
  ownerPid?: number;
  accountId: string;
  deviceId: string;
  kind: SessionKind;
  status: SessionStatus;
  queueItemId?: string;
  /** HH:mm schedule slot this post session was planned for (post sessions only). */
  slotTimeOfDay?: string;
  /** Frozen at session creation so retries preserve the randomized sequence. */
  plannedSteps?: string[];
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  checkpoint: SessionCheckpoint;
  activityLog: string[];
  retryCount?: number;
  nextRetryAt?: string;
  lastError?: string;
}

export interface User {
  id: string;
  email: string;
  passwordHash: string;
  planId: PlanTier["id"];
  licenseKey: string;
  trialEndsAt: string;
  billingCustomerId?: string;
  subscriptionId?: string;
  createdAt: string;
}

export interface MagicLink {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: string;
  usedAt?: string;
  createdAt: string;
}

export interface PlanTier {
  id: "free" | "solo" | "rack" | "scale";
  name: string;
  maxDevices: number | null;
  maxAccounts: number | null;
  cloudDropGb: number | null;
  priceMonthly: number;
}

export interface LicenseActivation {
  key: string;
  planId: PlanTier["id"];
  activatedAt: string;
  cloudUrl?: string;
}

export const PLAN_TIERS: readonly PlanTier[] = [
  {
    id: "free",
    name: "Free",
    maxDevices: 1,
    maxAccounts: 32,
    cloudDropGb: 0.5,
    priceMonthly: 0,
  },
  {
    id: "solo",
    name: "Solo",
    maxDevices: 1,
    maxAccounts: 32,
    cloudDropGb: 5,
    priceMonthly: 40,
  },
  {
    id: "rack",
    name: "Rack",
    maxDevices: 3,
    maxAccounts: 96,
    cloudDropGb: 20,
    priceMonthly: 80,
  },
  {
    id: "scale",
    name: "Scale",
    maxDevices: null,
    maxAccounts: null,
    cloudDropGb: null,
    priceMonthly: 150,
  },
] as const;

/** Max accounts per platform per physical device (Warmr: 8). */
export const MAX_ACCOUNTS_PER_PLATFORM_PER_DEVICE = 8;

/** Trust score required before an account is considered matured. */
export const MATURITY_TRUST_THRESHOLD = 100;

/** Trust gained per completed daily warmup session. */
export const TRUST_PER_WARMUP = 25;
