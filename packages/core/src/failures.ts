import type { FailureKind } from "./types.js";

export interface FailureDisposition {
  kind: FailureKind;
  retryDelayMs?: number;
  requiresAttention: boolean;
  incrementSocialRetry: boolean;
}

/**
 * Classify failures by recovery domain. The runner may supply an explicit
 * `failureKind`; message matching keeps older runners and stored failures
 * forward-compatible during upgrades.
 */
export function classifyFailure(error: unknown): FailureDisposition {
  const explicit = failureKindFrom(error);
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  const kind: FailureKind = explicit
    ?? (/coredevice|devicectl|copy (to|from) device|usb|runner readiness|did not acknowledge|timed out/.test(lower)
      ? "transport"
      : /account .*not found|account switch did not verify|signed-in accounts did not verify|exact handle/.test(lower)
        ? "account_mismatch"
        : /onboarding|prompt|overlay|unknown ui|unexpected screen/.test(lower)
          ? "unknown_ui"
          : /foreground|navigation|search field|keyboard/.test(lower)
            ? "app_navigation"
            : /runner|xctest/.test(lower)
              ? "runner"
              : "action");

  switch (kind) {
    case "transport":
    case "runner":
      return { kind, retryDelayMs: 60_000, requiresAttention: false, incrementSocialRetry: false };
    case "account_mismatch":
    case "unknown_ui":
      return { kind, requiresAttention: true, incrementSocialRetry: false };
    case "safety_policy":
      return { kind, retryDelayMs: 6 * 60 * 60 * 1_000, requiresAttention: false, incrementSocialRetry: false };
    case "app_navigation":
      return { kind, retryDelayMs: 5 * 60 * 1_000, requiresAttention: false, incrementSocialRetry: true };
    default:
      return { kind, retryDelayMs: 5 * 60 * 1_000, requiresAttention: false, incrementSocialRetry: true };
  }
}

function failureKindFrom(error: unknown): FailureKind | undefined {
  if (!error || typeof error !== "object") return undefined;
  const value = (error as { failureKind?: unknown }).failureKind;
  return typeof value === "string" && [
    "transport", "runner", "unknown_ui", "account_mismatch",
    "app_navigation", "safety_policy", "action",
  ].includes(value) ? value as FailureKind : undefined;
}

/** Repeats of the same failure before escalating, regardless of failure kind. */
export const REPEATED_FAILURE_LIMIT = 3;

/**
 * Collapse a failure message to what makes it the "same" failure: the wording,
 * without the identifiers that change every attempt (screenshot names, session
 * and command ids, paths, timings).
 */
export function failureSignature(message: string): string {
  return message
    .replace(/\b[0-9a-fA-F]{8}-[0-9a-fA-F-]{4,}\b/g, "<id>")
    .replace(/\/\S+/g, "<path>")
    .replace(/\d+/g, "<n>")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

/**
 * How many times in a row this exact failure has now been seen.
 *
 * The retry ladders are generous because most failures are transient — but a
 * deterministic fault repeats verbatim and rides the ladder for hours. On
 * 2026-09-18 an unreachable keyboard key would have taken ~2.6 hours of
 * app_navigation backoff (5/10/20/40/80 minutes) to reach a human. Identical
 * wording is the signal that waiting will not help.
 */
export function repeatedFailureCount(
  previousSignature: string | undefined,
  previousCount: number | undefined,
  message: string,
): { signature: string; count: number; deterministic: boolean } {
  const signature = failureSignature(message);
  const count = signature === previousSignature ? (previousCount ?? 0) + 1 : 1;
  return { signature, count, deterministic: count >= REPEATED_FAILURE_LIMIT };
}
