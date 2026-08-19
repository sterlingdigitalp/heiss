/** Shared domain types for Heiss (Warmr-style farm). */

export type Platform = "tiktok" | "instagram" | "x" | "youtube";

/** Platforms that support scheduled auto-post. */
export const POSTING_PLATFORMS: readonly Platform[] = ["tiktok", "instagram", "x"] as const;

/** Platforms that only warm (no auto-post). */
export const WARM_ONLY_PLATFORMS: readonly Platform[] = ["youtube"] as const;

export type AccountStage =
  | "fresh"
  | "warmed_up"
  | "matured"
  | "kept_warm"
  | "posting";

export type WarmupAction = "scroll" | "like" | "follow" | "search";

export type AccountPreflightStatus = "pending" | "ready" | "attention";

export type FailureKind =
  | "transport"
  | "runner"
  | "unknown_ui"
  | "account_mismatch"
  | "app_navigation"
  | "safety_policy"
  | "action";

export type ContentKind = "text" | "video" | "carousel";

export type EngagementMode = "off" | "review" | "autonomous";
export type EngagementApprovalStatus = "pending" | "approved" | "rejected" | "consumed" | "expired";

export interface EngagementPolicy {
  mode: EngagementMode;
  likesEnabled: boolean;
  followsEnabled: boolean;
  /** Conservative hard limits for one local calendar day. */
  dailyLikeCap: number;
  dailyFollowCap: number;
  /** Minimum gap between sessions that contain engagement actions. */
  cooldownMinutes: number;
  /** Autonomous mode remains locked until this reaches the required threshold. */
  successfulReviewedSessions: number;
}

export interface EngagementApproval {
  id: string;
  accountId: string;
  localDay: string;
  status: EngagementApprovalStatus;
  proposedLikes: number;
  proposedFollows: number;
  createdAt: string;
  decidedAt?: string;
  consumedAt?: string;
}

export interface EngagementTargetRecord {
  id: string;
  accountId: string;
  platform: Platform;
  action: "like" | "follow";
  /** Non-reversible on-device fingerprint; no third-party content is stored. */
  targetKey: string;
  at: string;
}

/**
 * An operator-curated person a persona engages with. Distinct from
 * EngagementTargetRecord, which is the after-the-fact ledger of what was already
 * engaged: this is the hand-picked *input* list, one per persona, edited from
 * the dashboard's Targets page. Nothing here is auto-discovered.
 */
export interface CuratedTarget {
  id: string;
  /** Persona account that owns this list (one list per account). */
  accountId: string;
  /** Public @handle of the person to engage with. */
  handle: string;
  /** Free-form operator note — why this person is on the list. */
  note?: string;
  /** Paused targets stay for history but are never engaged. Used for weekly substitutions. */
  active: boolean;
  addedAt: string;
  /** Set once the persona has followed this target (the week-one follow burst). */
  followedAt?: string;
  /** Drives the daily rotation once every target is followed. */
  lastEngagedAt?: string;
  /**
   * When the runner last rendered a verdict on this target, whether or not
   * anything landed. A failed attempt still spends the persona's day: without
   * this, a target the runner cannot finish is retried on every idle tick
   * forever, which on 2026-08-01 burned ~6 minutes per attempt in a loop and
   * starved three other personas of their turn.
   */
  lastAttemptedAt?: string;
  /** Completed comment+like touches. */
  engagedCount: number;
  /**
   * FEGOS research rank (1 = highest), present only on imported targets. This
   * IS the intended day order — priority 1 is followed first — so it sorts
   * ahead of addedAt and leaves addedAt an honest record of when, not a
   * smuggled ordering. Absent on hand-added targets, which sort after.
   */
  priority?: number;
  /** FEGOS's stated reason this source is ranked where it is. */
  sourceRole?: string;
}

/**
 * Curation cap per persona: one new follow per day sustains a seven-day week,
 * after which the rotation engages an already-followed target instead.
 */
export const MAX_CURATED_TARGETS_PER_ACCOUNT = 7;

export type EngagementCandidateStatus = "pending" | "approved" | "rejected" | "expired";
export type EngagementActionStatus = "approved" | "ready" | "needs_manual" | "completed" | "skipped" | "expired" | "failed";

/** A read-only observation gathered during a normal search warmup. */
export interface EngagementCandidate {
  id: string;
  groupId: string;
  accountId: string;
  platform: Platform;
  actorHandle: string;
  targetHandle: string;
  targetKey: string;
  screenKey: string;
  excerpt: string;
  searchTerms: string[];
  relevanceScore: number;
  seenCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
  sessionId: string;
  status: EngagementCandidateStatus;
  /** True when the normalized handle came from a genuinely unresolvable observation (boundary truncation, length cap, OCR fragment, or UI ellipsis) and warrants human review before trust. Optional so existing persisted state stays valid. */
  ambiguous?: boolean;
}

/** Exact human authorization for one target and one action. */
export interface EngagementActionApproval {
  id: string;
  candidateId: string;
  groupId: string;
  accountId: string;
  platform: Platform;
  action: "like" | "follow";
  targetHandle: string;
  targetKey: string;
  /** Current platforms use assisted navigation; the human performs the final tap. */
  executionMode: "assisted" | "api";
  status: EngagementActionStatus;
  approvedAt: string;
  executeLocalDay: string;
  expiresAt: string;
  attemptedAt?: string;
  completedAt?: string;
  lastError?: string;
}

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
  /** Hardware model reported by CoreDevice, used for certified capacity. */
  model?: string;
  /** Compact devices need stricter per-platform certification limits. */
  viewportClass?: "compact" | "regular";
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
  /** Human-facing label shown by an in-app account picker. */
  displayName?: string;
  /** Login identity used only to locate an account row, never as final verification. */
  loginEmail?: string;
  /** Optional on-device picker label when the platform does not show the public handle. */
  switcherHint?: string;
  /** Stable visual hint for future picker matching; exact handle still gates activity. */
  avatarFingerprint?: string;
  /** Manual onboarding/readiness gate controlled by the account owner. */
  preflightStatus?: AccountPreflightStatus;
  preflightCompletedAt?: string;
  preflightAppVersion?: string;
  preflightNote?: string;
  /** Exact public handle most recently proven on-device. */
  lastVerifiedHandle?: string;
  identityVerifiedAt?: string;
  lastCanaryAt?: string;
  stage: AccountStage;
  /** Warmup progress toward maturity (0–100). */
  trustScore: number;
  /** Niche search terms for incubator-style calibration. */
  searchTerms: string[];
  createdAt: string;
  lastWarmupAt?: string;
  /**
   * Local HH:mm this persona does its curated follow+like. Without it the
   * engagement fires on the first idle tick after the calendar day rolls over
   * — i.e. all five personas inside half an hour of midnight, every night,
   * which is the opposite of the human pacing the warming depends on.
   * Staggered per persona and jittered daily, exactly like warmups.
   */
  curatedEngagementAt?: string;
  /** Daily variation around curatedEngagementAt; mirrors WarmupSchedule.jitterMinutes. */
  curatedEngagementJitterMinutes?: number;
  /** Distinct local calendar days with a completed warmup. */
  warmupLocalDays?: string[];
  lastPostAt?: string;
  /** Explicit, per-account engagement permission. Missing means fully off. */
  engagement?: EngagementPolicy;
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
  /** Accounts are processed platform-major to avoid needless app cycling. */
  platformOrder: Platform[];
  /** One-time migration marker for platform-major default warmup times. */
  platformScheduleVersion: number;
  /** Likes/follows and other engagement are omitted unless a human enables them. */
  /** Last observed state is persisted so disconnect alerts fire once per transition. */
  deviceStates: Record<string, "online" | "offline">;
  /** Notification fingerprints already delivered by the persistent controller. */
  notificationKeys: Record<string, string>;
  /** Scheduler pause that drains the current checkpoint before maintenance. */
  maintenance: MaintenanceState;
  /** Last typed device/runner health result per registered device. */
  deviceHealth: Record<string, DeviceHealthRecord>;
  /** Controller heartbeat proves there is one active scheduling authority. */
  controllerHeartbeatAt?: string;
  controllerPid?: number;
}

export interface MaintenanceState {
  mode: "running" | "draining" | "active";
  reason?: string;
  requestedAt?: string;
  enteredAt?: string;
  requestedBy?: string;
}

export interface DeviceHealthRecord {
  checkedAt: string;
  ok: boolean;
  action: string;
  detail: string;
  checks: {
    usb: boolean;
    paired: boolean;
    commandChannel: boolean;
    runnerHeartbeat: boolean;
    protocolCompatible?: boolean;
  };
  runnerProtocolVersion?: number;
  runnerBuild?: string;
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
  /** Infrastructure retries never inflate the social-session backoff. */
  transportRetryCount?: number;
  nextRetryAt?: string;
  lastError?: string;
  failureKind?: FailureKind;
  /** Excludes the checkpoint from autonomous retries until a human resumes it. */
  requiresAttention?: boolean;
  /** Last heartbeat/progress timestamp received from the on-device journal. */
  heartbeatAt?: string;
  /** Review approval consumed only after a session completes successfully. */
  engagementApprovalId?: string;
  engagementPlan?: { likes: number; follows: number };
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
