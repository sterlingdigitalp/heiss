/**
 * The "#connect" routine: find fresh posts from a search, follow the author
 * and leave a short reply. This module holds the decisions — who is on a
 * results page, whether they qualify, and what the reply says — so they can be
 * tested without a phone. The runner only reads the screen and taps.
 */
import { createHash } from "node:crypto";

/** Fingerprint under which a connection is remembered; never the handle itself. */
export function connectTargetKey(handle: string): string {
  const normalized = handle.trim().replace(/^@+/, "").toLowerCase();
  return `xconnect:${createHash("sha256").update(normalized).digest("hex").slice(0, 32)}`;
}

/** One OCR line from the runner: text plus its position on screen (0…1, top-left origin). */
export interface ScreenLine { t: string; x: number; y: number; w: number; h: number }

export interface ConnectCandidate {
  handle: string;
  displayName: string;
  /** Minutes since posting, from X's relative timestamp ("45s", "12m", "2h"). */
  ageMinutes: number;
  /** Name to address them by, or "" when nothing readable was found. */
  firstName: string;
  /** True when X cut the handle short; the full handle is read on the profile. */
  handleTruncated?: boolean;
}

/** Posts this old or older are skipped; newer is better. */
export const CONNECT_MAX_AGE_MINUTES = 180;

/** The operator's own wordings, verbatim. `<name>` is replaced; two have none. */
export const CONNECT_REPLY_VARIANTS = [
  "followed, let’s connect 🤝",
  "<name> followed you, let’s connect 🤝",
  "followed you 👋🏻, let’s connect🤝",
  "followed you <name>, let’s connect 🤝",
] as const;

const HANDLE = /@([A-Za-z0-9_]{2,15})\b/;
// X renders "· 12m" beside the handle; OCR reads the dot as ·, •, ., - or drops it.
const AGE = /(?:^|[\s·•.\-])(\d{1,2})\s?(s|m|h)\b(?!\w)/;

function ageMinutes(text: string): number | undefined {
  const match = AGE.exec(text);
  if (!match) return undefined;
  const value = Number(match[1]);
  return match[2] === "s" ? 0 : match[2] === "m" ? value : value * 60;
}

/**
 * Read the post headers off one or more OCR'd result pages. A header is the
 * line carrying "@handle · 12m"; the display name is the text before the
 * handle on that line, or the line directly above when X wrapped it.
 */
export function parseConnectResults(pages: ScreenLine[][]): ConnectCandidate[] {
  const seen = new Map<string, ConnectCandidate>();
  for (const page of pages) {
    const lines = [...page].sort((a, b) => a.y - b.y || a.x - b.x);
    lines.forEach((line, index) => {
      const handleMatch = HANDLE.exec(line.t);
      if (!handleMatch) return;
      const afterHandle = line.t.slice(handleMatch.index + handleMatch[0].length);
      const age = ageMinutes(afterHandle);
      // A mention inside a post body has no timestamp after it; only headers do.
      if (age === undefined) return;
      let displayName = line.t.slice(0, handleMatch.index).trim();
      if (!displayName) {
        // X draws "Name  @handle · 7m" on one row, which OCR returns as two
        // pieces; a narrow screen wraps the name onto the row above instead.
        const sameRow = lines
          .filter((other) => other !== line && Math.abs(other.y - line.y) < 0.012 && other.x < line.x)
          .sort((a, b) => b.x - a.x)[0];
        const above = lines.slice(0, index).reverse()
          .find((other) => line.y - (other.y + other.h) >= 0 && line.y - (other.y + other.h) < 0.03
            && Math.abs(other.x - line.x) < 0.08);
        displayName = (sameRow ?? above)?.t.trim() ?? "";
      }
      // X cuts long handles short ("@Gustav_Jou.."); the full one is only on
      // the profile, so a cut handle is a prefix, not an identity.
      const handleTruncated = /^\s*(\.{2,}|…)/.test(afterHandle);
      const handle = `@${handleMatch[1]}`;
      const key = handle.toLowerCase();
      // The same author can appear twice (and once cut short); keep the freshest.
      const sameAuthor = [...seen.keys()].find((other) => other === key
        || ((handleTruncated || seen.get(other)!.handleTruncated) && (other.startsWith(key) || key.startsWith(other))));
      const existing = sameAuthor ? seen.get(sameAuthor) : undefined;
      if (existing && existing.ageMinutes <= age) return;
      if (sameAuthor) seen.delete(sameAuthor);
      seen.set(key, {
        handle, displayName, ageMinutes: age, handleTruncated,
        // A cut handle is not a name; only the display name can supply one.
        firstName: connectFirstName(displayName, handleTruncated ? "" : handle),
      });
    });
  }
  return [...seen.values()].sort((a, b) => a.ageMinutes - b.ageMinutes);
}

/**
 * The first word of the display name, without emoji or decoration; failing
 * that, the leading letters of the handle. "" when neither reads as a name —
 * the caller then uses a wording with no name rather than guessing.
 */
export function connectFirstName(displayName: string, handle: string): string {
  const word = displayName.normalize("NFKC").split(/\s+/)
    .map((part) => part.replace(/[^\p{L}'’-]/gu, ""))
    .find((part) => part.length >= 2);
  if (word && word.length <= 20) return word;
  const fromHandle = /^[A-Za-z]{3,}/.exec(handle.replace(/^@/, ""))?.[0] ?? "";
  return fromHandle;
}

/**
 * Whether to connect with a candidate. `alreadyConnected` holds the
 * fingerprints of everyone ANY persona has already connected with.
 */
export function connectEligibility(
  candidate: ConnectCandidate,
  opts: { ownedHandles: string[]; alreadyConnected: Iterable<string> },
): { ok: boolean; reason: "eligible" | "too_old" | "own_account" | "already_connected" } {
  const key = candidate.handle.toLowerCase();
  if (candidate.ageMinutes >= CONNECT_MAX_AGE_MINUTES) return { ok: false, reason: "too_old" };
  if (opts.ownedHandles.some((owned) => owned.toLowerCase() === key)) return { ok: false, reason: "own_account" };
  // `alreadyConnected` holds connectTargetKey fingerprints.
  if (new Set(opts.alreadyConnected).has(connectTargetKey(candidate.handle))) {
    return { ok: false, reason: "already_connected" };
  }
  return { ok: true, reason: "eligible" };
}

/**
 * Pick a wording: never the same one twice running, and only a named wording
 * when there is a name. `pick` is a 0…1 random number, injected for tests.
 */
export function connectReply(
  firstName: string,
  pick: number,
  lastVariant?: number,
): { text: string; variant: number } {
  const usable = CONNECT_REPLY_VARIANTS
    .map((text, variant) => ({ text, variant }))
    .filter((item) => (firstName ? true : !item.text.includes("<name>")))
    .filter((item, _index, all) => all.length === 1 || item.variant !== lastVariant);
  const chosen = usable[Math.min(usable.length - 1, Math.floor(pick * usable.length))]!;
  return { text: chosen.text.replace("<name>", firstName), variant: chosen.variant };
}
