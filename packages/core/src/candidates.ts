import { createHash, randomUUID } from "node:crypto";
import type { EngagementActionApproval, EngagementCandidate, Platform, SocialAccount } from "./types.js";

interface DiscoveryPayload { handles?: unknown; excerpt?: unknown; screenKey?: unknown }

export function normalizeCandidateHandle(value: string): string {
  return value.trim().replace(/^@/, "").toLowerCase().replace(/^[^a-z0-9_]+|[^a-z0-9._-]+$/g, "");
}

export function normalizePlatformCandidateHandle(platform: Platform, value: string): string {
  let normalized = normalizeCandidateHandle(value).replace(/\.(?:\d+)(?:s|m|h|d|w)$/i, "");
  if (platform === "x") normalized = normalized.split(".")[0]!.replace(/[^a-z0-9_]/g, "").slice(0, 15);
  return normalized;
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
      recorded.push(existing);
      continue;
    }
    const candidate: EngagementCandidate = {
      id: randomUUID(), groupId: input.account.groupId, accountId: input.account.id,
      platform: input.account.platform, actorHandle: input.account.handle,
      targetHandle, targetKey, screenKey: discovery.screenKey, excerpt: discovery.excerpt,
      searchTerms: [...input.account.searchTerms], relevanceScore, seenCount: 1,
      firstSeenAt: input.now, lastSeenAt: input.now, sessionId: input.sessionId, status: "pending",
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
