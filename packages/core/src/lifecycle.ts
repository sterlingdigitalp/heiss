import {
  MATURITY_TRUST_THRESHOLD,
  POSTING_PLATFORMS,
  TRUST_PER_WARMUP,
  WARM_ONLY_PLATFORMS,
  type AccountStage,
  type Platform,
  type SocialAccount,
  type WarmupAction,
} from "./types.js";
import type { EngagementAllowance } from "./engagement.js";

const STAGE_ORDER: AccountStage[] = [
  "fresh",
  "warmed_up",
  "matured",
  "kept_warm",
  "posting",
];

export function stageIndex(stage: AccountStage): number {
  return STAGE_ORDER.indexOf(stage);
}

/** Fresh accounts cannot post. Matured and later may enter posting rotation. */
export function canPost(account: Pick<SocialAccount, "stage" | "platform">): boolean {
  if (!POSTING_PLATFORMS.includes(account.platform)) {
    return false;
  }
  return stageIndex(account.stage) >= stageIndex("matured");
}

/** YouTube remains warm-only. */
export function isWarmOnlyPlatform(platform: Platform): boolean {
  return WARM_ONLY_PLATFORMS.includes(platform);
}

export function supportsAutoPost(platform: Platform): boolean {
  return POSTING_PLATFORMS.includes(platform);
}

/** Daily warmup script actions (human-like). */
export function defaultWarmupActions(searchTerms: string[] = []): WarmupAction[] {
  const actions: WarmupAction[] = ["scroll", "like", "follow", "search"];
  if (searchTerms.length === 0) {
    return actions;
  }
  return actions;
}

/**
 * Apply a completed warmup session: raise trust and advance stage.
 * Fresh → Warmed Up once any warmup completes; → Matured at threshold.
 */
export function applyWarmupProgress(
  account: SocialAccount,
  now: string = new Date().toISOString(),
  localDay: string = now.slice(0, 10),
): SocialAccount {
  const warmupLocalDays = [...new Set([...(account.warmupLocalDays ?? []), localDay])].sort();
  const trustScore = Math.min(MATURITY_TRUST_THRESHOLD, warmupLocalDays.length * TRUST_PER_WARMUP);
  let stage = account.stage;

  if (stage === "fresh") {
    stage = "warmed_up";
  }
  if (trustScore >= MATURITY_TRUST_THRESHOLD && stageIndex(stage) < stageIndex("matured")) {
    stage = "matured";
  } else if (
    trustScore >= MATURITY_TRUST_THRESHOLD &&
    stage === "matured"
  ) {
    // Staying healthy without posting this cycle → kept warm
    stage = "kept_warm";
  }

  return {
    ...account,
    trustScore,
    stage,
    lastWarmupAt: now,
    warmupLocalDays,
  };
}

/** Mark account as actively in posting rotation after a successful post cycle. */
export function markPosting(
  account: SocialAccount,
  now: string = new Date().toISOString(),
): SocialAccount {
  if (!canPost(account)) {
    throw new Error(
      `Account ${account.id} (${account.stage}/${account.platform}) cannot enter posting rotation`,
    );
  }
  return {
    ...account,
    stage: "posting",
    lastPostAt: now,
  };
}

/**
 * Keep-warm for matured accounts that are not posting today.
 * Continues daily activity without requiring a post.
 */
export function applyKeepWarm(
  account: SocialAccount,
  now: string = new Date().toISOString(),
  localDay: string = now.slice(0, 10),
): SocialAccount {
  if (stageIndex(account.stage) < stageIndex("matured")) {
    throw new Error(`Account ${account.id} is not matured; cannot keep-warm`);
  }
  const nextStage: AccountStage =
    account.stage === "posting" ? "kept_warm" : account.stage === "matured" ? "kept_warm" : account.stage;
  return {
    ...account,
    stage: nextStage,
    lastWarmupAt: now,
    warmupLocalDays: [...new Set([...(account.warmupLocalDays ?? []), localDay])].sort(),
    trustScore: Math.min(MATURITY_TRUST_THRESHOLD, account.trustScore + Math.floor(TRUST_PER_WARMUP / 2)),
  };
}

/** Every post cycle is wrapped with pre-post and post-post warmup. */
export function postCycleScript(
  searchTerms: string[],
  engagement: boolean | Pick<EngagementAllowance, "likes" | "follows"> = true,
  platform: Platform = "tiktok",
  hasMedia = true,
): string[] {
  const allowance = normalizeAllowance(engagement);
  const warmup = ["scroll", "scroll", ...(allowance.likes > 0 ? ["like"] : []), ...(searchTerms.length ? ["search"] : [])]
    .map((a) => `pre_warmup:${a}`);
  const post = platform === "x"
    ? ["post:compose", "post:caption", ...(hasMedia ? ["post:media_optional"] : []), "post:publish"]
    : ["post:upload", "post:caption", "post:music_optional", "post:publish"];
  const after = ["scroll", "scroll", ...(allowance.likes > 1 ? ["like"] : []), ...(searchTerms.length ? ["search"] : [])]
    .map((a) => `post_warmup:${a}`);
  return [...warmup, ...post, ...after];
}

export function warmupOnlyScript(
  searchTerms: string[],
  trustScore = 0,
  seed = randomSeed(),
  engagement: boolean | Pick<EngagementAllowance, "likes" | "follows"> = true,
): string[] {
  const allowance = normalizeAllowance(engagement);
  const phase = Math.min(3, Math.floor(Math.max(0, trustScore) / TRUST_PER_WARMUP));
  const plans = [
    { scroll: 8, like: 0, follow: 0, search: 2 },
    { scroll: 10, like: 2, follow: 0, search: 2 },
    { scroll: 12, like: 3, follow: 1, search: 2 },
    { scroll: 15, like: 4, follow: 1, search: 2 },
  ] as const;
  const plan = plans[phase]!;
  const actions: WarmupAction[] = [];
  actions.push(...Array.from({ length: plan.scroll }, () => "scroll" as const));
  actions.push(...Array.from({ length: Math.min(plan.like, allowance.likes) }, () => "like" as const));
  actions.push(...Array.from({ length: Math.min(plan.follow, allowance.follows) }, () => "follow" as const));
  if (searchTerms.length > 0) {
    actions.push(...Array.from({ length: plan.search }, () => "search" as const));
  }
  return seededShuffle(actions, seed).map((action) => `warmup:${action}`);
}

function normalizeAllowance(
  value: boolean | Pick<EngagementAllowance, "likes" | "follows">,
): Pick<EngagementAllowance, "likes" | "follows"> {
  if (typeof value === "boolean") {
    return value ? { likes: Number.MAX_SAFE_INTEGER, follows: Number.MAX_SAFE_INTEGER } : { likes: 0, follows: 0 };
  }
  return { likes: Math.max(0, value.likes), follows: Math.max(0, value.follows) };
}

function seededShuffle<T>(values: T[], seed: string): T[] {
  const result = [...values];
  let state = 2166136261;
  for (const char of seed) state = Math.imul(state ^ char.charCodeAt(0), 16777619) >>> 0;
  for (let index = result.length - 1; index > 0; index -= 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const target = state % (index + 1);
    [result[index], result[target]] = [result[target]!, result[index]!];
  }
  return result;
}

function randomSeed(): string {
  return `${Date.now()}-${Math.random()}`;
}
