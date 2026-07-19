import { createHash, randomUUID } from "node:crypto";
import type { EngagementActionApproval, EngagementCandidate, Platform, SocialAccount } from "./types.js";

interface DiscoveryPayload { handles?: unknown; excerpt?: unknown; screenKey?: unknown }

/**
 * Screen-scraped handles routinely arrive with a "time-ago" suffix welded on
 * by an OCR/UI separator (e.g. `@realtordotcom•7h`). Rather than stripping a
 * timestamp-shaped suffix (which silently corrupts legitimate handles like
 * `cinema4d` or `blender3d`), we cut at the first character outside the
 * platform's legal username charset. Bullet/hyphen/etc. are illegal on every
 * supported platform, so cutting there removes the pollution as a side
 * effect of correct boundary detection and can never truncate a handle made
 * entirely of legal characters.
 */
const HANDLE_CHARSET: Record<Platform, { re: RegExp; max: number }> = {
  x: { re: /^[a-z0-9_]+/, max: 15 },
  instagram: { re: /^[a-z0-9._]+/, max: 30 },
  tiktok: { re: /^[a-z0-9._]+/, max: 24 },
  // youtube has no dedicated charset here; fall back to x's (stricter, no
  // dots) via the `?? HANDLE_CHARSET.x` lookup below. That's a safe,
  // non-corrupting default — worst case it over-truncates a long/dotted
  // youtube handle, never welds unrelated characters together.
  youtube: { re: /^[a-z0-9_]+/, max: 15 },
};

export function normalizeCandidateHandle(value: string): string {
  return value.trim().replace(/^[^a-z0-9_@]+/i, "").replace(/^@+/, "").toLowerCase();
}

interface HandleCut {
  /** normalizeCandidateHandle(value): lowercased, leading junk/@ stripped, trailing junk NOT yet cut. */
  raw: string;
  /** Longest prefix of `raw` made entirely of legal charset characters. */
  matched: string;
  /** `matched` with a trailing `.`/`-` boundary artifact removed and length-capped. */
  cut: string;
  max: number;
}

function cutCandidateHandle(platform: Platform, value: string): HandleCut {
  const raw = normalizeCandidateHandle(value);
  const spec = HANDLE_CHARSET[platform] ?? HANDLE_CHARSET.x;
  const matched = raw.match(spec.re)?.[0] ?? "";
  // Only `.` and `-` are stripped: both are illegal as trailing username
  // characters on every supported platform (`-` isn't legal anywhere in
  // these charsets at all), so removing them is always safe. `_` is a legal
  // trailing character (e.g. `peptidedaily_`) and MUST be preserved.
  const cut = matched.replace(/[.-]+$/, "").slice(0, spec.max);
  return { raw, matched, cut, max: spec.max };
}

export function normalizePlatformCandidateHandle(platform: Platform, value: string): string {
  return cutCandidateHandle(platform, value).cut;
}

/**
 * Reports whether a normalized handle was produced from a genuinely
 * unresolvable observation: real content was discarded at a boundary
 * (distinct from a confidently-detected illegal separator like the OCR
 * bullet), the input was truncated by the platform length cap, the result
 * is an implausibly short OCR fragment, or the source text carried a UI
 * ellipsis. This is recorded for later human review only; it does not gate
 * any approval/blocking logic.
 */
export function isAmbiguousCandidateHandle(platform: Platform, value: string): boolean {
  // NB: length is measured against `matched` (the legal-charset run), never the
  // pre-cut `raw`. Using `raw` would flag any handle whose *pollution* pushed it
  // past the platform cap — e.g. `@realtordotcom•7h` resolves to `realtordotcom`
  // with full confidence, yet raw is 16 chars on a 15-char platform. Flagging
  // well-resolved handles trains reviewers to ignore the flag, which is exactly
  // when the genuinely unresolvable ones (`@te`) get waved through. The cap case
  // is already covered by `matched.length > cut.length`, since cut is a slice of
  // matched.
  const { matched, cut } = cutCandidateHandle(platform, value);
  return matched.length > cut.length
    || cut.length <= 3
    || /(\.\.\.|…)/.test(value);
}

export function candidateTargetKey(platform: Platform, handle: string): string {
  return createHash("sha256").update(`${platform}|${normalizePlatformCandidateHandle(platform, handle)}`).digest("hex").slice(0, 20);
}

export function parseDiscoveryDetail(detail: string): { handles: string[]; excerpt: string; screenKey: string } | undefined {
  const encoded = detail.match(/(?:^|\|)discovery:([A-Za-z0-9+/=]+)/)?.[1];
  if (!encoded) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as DiscoveryPayload;
    const handles = Array.isArray(payload.handles)
      ? [...new Set(payload.handles.filter((value): value is string => typeof value === "string").map(normalizeCandidateHandle).filter(Boolean))]
      : [];
    if (handles.length === 0) return undefined;
    return {
      handles,
      excerpt: typeof payload.excerpt === "string" ? payload.excerpt.slice(0, 700) : "",
      screenKey: typeof payload.screenKey === "string" && payload.screenKey ? payload.screenKey : "unknown",
    };
  } catch { return undefined; }
}

function termScore(excerpt: string, terms: string[]): number {
  const haystack = excerpt.toLowerCase();
  const tokens = [...new Set(terms.flatMap((term) => term.toLowerCase().split(/[^a-z0-9]+/)).filter((token) => token.length > 2))];
  if (tokens.length === 0) return 0;
  return Math.round(35 * tokens.filter((token) => haystack.includes(token)).length / tokens.length);
}

export function recordDiscoveryCandidates(input: {
  candidates: EngagementCandidate[];
  account: SocialAccount;
  ownedHandles: string[];
  sessionId: string;
  detail: string;
  now: string;
}): EngagementCandidate[] {
  const discovery = parseDiscoveryDetail(input.detail);
  if (!discovery || !input.account.groupId) return [];
  const owned = new Set(input.ownedHandles.map((handle) => normalizePlatformCandidateHandle(input.account.platform, handle)));
  const actor = normalizePlatformCandidateHandle(input.account.platform, input.account.handle);
  const recorded: EngagementCandidate[] = [];
  for (const observedHandle of discovery.handles) {
    const targetHandle = normalizePlatformCandidateHandle(input.account.platform, observedHandle);
    if (!targetHandle) continue;
    if (targetHandle === actor || owned.has(targetHandle)) continue;
    const targetKey = candidateTargetKey(input.account.platform, targetHandle);
    const ambiguous = isAmbiguousCandidateHandle(input.account.platform, observedHandle);
    const existing = input.candidates.find((candidate) => candidate.accountId === input.account.id
      && candidate.targetKey === targetKey && candidate.status !== "expired");
    const crossPersona = input.candidates.some((candidate) => candidate.groupId !== input.account.groupId
      && candidate.targetKey === targetKey && candidate.status !== "expired");
    const relevanceScore = Math.max(0, Math.min(100,
      45 + termScore(discovery.excerpt, input.account.searchTerms) + (crossPersona ? -20 : 0) + (existing ? Math.min(10, existing.seenCount * 2) : 0),
    ));
    if (existing) {
      existing.lastSeenAt = input.now;
      existing.seenCount += 1;
      existing.excerpt = discovery.excerpt || existing.excerpt;
      existing.screenKey = discovery.screenKey;
      existing.relevanceScore = relevanceScore;
      existing.sessionId = input.sessionId;
      existing.ambiguous = ambiguous;
      recorded.push(existing);
      continue;
    }
    const candidate: EngagementCandidate = {
      id: randomUUID(), groupId: input.account.groupId, accountId: input.account.id,
      platform: input.account.platform, actorHandle: input.account.handle,
      targetHandle, targetKey, screenKey: discovery.screenKey, excerpt: discovery.excerpt,
      searchTerms: [...input.account.searchTerms], relevanceScore, seenCount: 1,
      firstSeenAt: input.now, lastSeenAt: input.now, sessionId: input.sessionId, status: "pending",
      ambiguous,
    };
    input.candidates.push(candidate); recorded.push(candidate);
  }
  return recorded;
}

export function approveCandidate(input: {
  candidate: EngagementCandidate;
  action: "like" | "follow";
  approvals: EngagementActionApproval[];
  allCandidates: EngagementCandidate[];
  localDay: string;
  now: string;
}): EngagementActionApproval {
  if (input.candidate.status !== "pending" && input.candidate.status !== "approved") throw new Error("Candidate is no longer reviewable");
  const duplicateContent = input.allCandidates.some((candidate) => candidate.id !== input.candidate.id
    && candidate.groupId !== input.candidate.groupId && candidate.screenKey !== "unknown"
    && candidate.screenKey === input.candidate.screenKey && candidate.status === "approved");
  if (duplicateContent) throw new Error("The same content is already approved for another person");
  const existing = input.approvals.find((approval) => approval.candidateId === input.candidate.id
    && approval.action === input.action && !["skipped", "expired", "failed"].includes(approval.status));
  if (existing) return existing;
  const approval: EngagementActionApproval = {
    id: randomUUID(), candidateId: input.candidate.id, groupId: input.candidate.groupId,
    accountId: input.candidate.accountId, platform: input.candidate.platform,
    action: input.action, targetHandle: input.candidate.targetHandle, targetKey: input.candidate.targetKey,
    executionMode: "assisted", status: "ready", approvedAt: input.now,
    executeLocalDay: input.localDay,
    expiresAt: new Date(Date.parse(input.now) + 72 * 60 * 60 * 1000).toISOString(),
  };
  input.candidate.status = "approved"; input.approvals.push(approval); return approval;
}

/**
 * Selects `ready` like-approvals eligible for fully automated (unattended)
 * execution during the account's next scheduled session, bounded by the
 * caller's remaining engagement-allowance budget.
 *
 * Deliberately excludes:
 *  - anything not `status: "ready"` or already past `expiresAt` (human must
 *    re-approve/complete via the existing assist flow),
 *  - `action: "follow"` approvals (out of scope for this pass — see brief),
 *  - a `targetKey` present in the caller's 30-day blocked-target set,
 *  - a candidate flagged `ambiguous: true` (unresolved OCR handle; never
 *    executed unattended).
 * The caller is responsible for gating on policy mode/stage/cooldown — this
 * function trusts `maxCount` as the already-computed remaining budget.
 */
export function readyLikeApprovalsForTargeting(input: {
  approvals: EngagementActionApproval[];
  candidates: EngagementCandidate[];
  blockedTargetKeys: Iterable<string>;
  accountId: string;
  maxCount: number;
  now: string;
}): EngagementActionApproval[] {
  if (input.maxCount <= 0) return [];
  const blocked = new Set(input.blockedTargetKeys);
  const candidateById = new Map(input.candidates.map((candidate) => [candidate.id, candidate]));
  return input.approvals
    .filter((approval) => approval.accountId === input.accountId
      && approval.action === "like"
      && approval.status === "ready"
      && approval.expiresAt > input.now
      && !blocked.has(approval.targetKey)
      && candidateById.get(approval.candidateId)?.ambiguous !== true)
    .sort((a, b) => a.approvedAt.localeCompare(b.approvedAt))
    .slice(0, input.maxCount);
}

export function refreshCandidateQueue(candidates: EngagementCandidate[], approvals: EngagementActionApproval[], localDay: string, now: string): number {
  let ready = 0;
  for (const candidate of candidates) {
    if (candidate.status === "pending" && Date.parse(candidate.lastSeenAt) < Date.parse(now) - 14 * 86400_000) candidate.status = "expired";
  }
  for (const approval of approvals) {
    if (["completed", "skipped", "expired"].includes(approval.status)) continue;
    if (approval.expiresAt <= now) { approval.status = "expired"; continue; }
    if (approval.status === "approved" && approval.executeLocalDay <= localDay) { approval.status = "ready"; ready += 1; }
  }
  return ready;
}
