import {
  MATURITY_TRUST_THRESHOLD,
  POSTING_PLATFORMS,
  TRUST_PER_WARMUP,
  type AccountStage,
  type Platform,
  type SocialAccount,
  type WarmupAction,
} from "./types.js";

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

/** X and LinkedIn are warm-only. */
export function isWarmOnlyPlatform(platform: Platform): boolean {
  return platform === "x" || platform === "linkedin";
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
): SocialAccount {
  const trustScore = Math.min(
    MATURITY_TRUST_THRESHOLD,
    account.trustScore + TRUST_PER_WARMUP,
  );
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
    trustScore: Math.min(MATURITY_TRUST_THRESHOLD, account.trustScore + Math.floor(TRUST_PER_WARMUP / 2)),
  };
}

/** Every post cycle is wrapped with pre-post and post-post warmup. */
export function postCycleScript(searchTerms: string[]): string[] {
  const warmup = ["scroll", "scroll", "like", ...(searchTerms.length ? ["search"] : [])]
    .map((a) => `pre_warmup:${a}`);
  const post = ["post:upload", "post:caption", "post:music_optional", "post:publish"];
  const after = ["scroll", "scroll", "like", ...(searchTerms.length ? ["search"] : [])]
    .map((a) => `post_warmup:${a}`);
  return [...warmup, ...post, ...after];
}

export function warmupOnlyScript(searchTerms: string[], trustScore = 0): string[] {
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
  actions.push(...Array.from({ length: plan.like }, () => "like" as const));
  actions.push(...Array.from({ length: plan.follow }, () => "follow" as const));
  if (searchTerms.length > 0) {
    actions.push(...Array.from({ length: plan.search }, () => "search" as const));
  }
  return actions.map((action) => `warmup:${action}`);
}
