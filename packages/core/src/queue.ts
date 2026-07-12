import { randomUUID } from "node:crypto";
import type {
  ContentAsset,
  ContentKind,
  QueueItem,
  QueueItemStatus,
} from "./types.js";

export class QueueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QueueError";
  }
}

export interface DropContentInput {
  kind: ContentKind;
  mediaRef: string;
  slides?: string[];
  caption: string;
  music?: string;
  accountIds: string[];
  createdBy: string;
  now?: string;
}

export interface DropResult {
  content: ContentAsset;
  queueItem: QueueItem;
}

/** Create content asset + queue item for selected accounts (Cloud Drop / local). */
export function dropContent(input: DropContentInput): DropResult {
  if (input.accountIds.length === 0) {
    throw new QueueError("At least one target account is required");
  }
  if (input.kind === "carousel" && (!input.slides || input.slides.length < 1)) {
    throw new QueueError("Carousel requires at least one slide in slides[]");
  }
  const now = input.now ?? new Date().toISOString();
  const content: ContentAsset = {
    id: randomUUID(),
    kind: input.kind,
    mediaRef: input.mediaRef,
    slides: input.slides,
    caption: input.caption,
    music: input.music,
    createdAt: now,
    createdBy: input.createdBy,
  };
  const queueItem: QueueItem = {
    id: randomUUID(),
    contentId: content.id,
    accountIds: [...input.accountIds],
    status: "queued",
    createdAt: now,
  };
  return { content, queueItem };
}

/** Local runner claims a queued item; prevents concurrent double-claim. */
export function claimQueueItem(
  item: QueueItem,
  runnerId: string,
  now: string = new Date().toISOString(),
): QueueItem {
  if (item.status !== "queued") {
    throw new QueueError(
      `Queue item ${item.id} is ${item.status}, not claimable (must be queued)`,
    );
  }
  if (item.claimedBy && item.claimedBy !== runnerId) {
    throw new QueueError(
      `Queue item ${item.id} already claimed by ${item.claimedBy}`,
    );
  }
  return {
    ...item,
    status: "claimed",
    claimedBy: runnerId,
    claimedAt: now,
  };
}

/** After claim, store media locally for posting. */
export function storeLocally(item: QueueItem, localPath: string): QueueItem {
  if (item.status !== "claimed") {
    throw new QueueError(`Cannot store item ${item.id} in status ${item.status}`);
  }
  return {
    ...item,
    status: "stored_local",
    localPath,
  };
}

/** Assign to a specific account for a post session (locks content). */
export function assignToAccount(item: QueueItem, accountId: string): QueueItem {
  if (item.status !== "stored_local" && item.status !== "claimed") {
    throw new QueueError(
      `Cannot assign item ${item.id} in status ${item.status}`,
    );
  }
  if (!item.accountIds.includes(accountId)) {
    throw new QueueError(
      `Account ${accountId} is not a target of queue item ${item.id}`,
    );
  }
  if (item.assignedAccountId) {
    throw new QueueError(
      `Queue item ${item.id} already assigned to ${item.assignedAccountId}`,
    );
  }
  return {
    ...item,
    status: "assigned",
    assignedAccountId: accountId,
  };
}

export function markPosted(
  item: QueueItem,
  now: string = new Date().toISOString(),
): QueueItem {
  if (item.status !== "assigned") {
    throw new QueueError(`Cannot mark posted: item ${item.id} is ${item.status}`);
  }
  return {
    ...item,
    status: "posted",
    postedAt: now,
  };
}

export function markFailed(item: QueueItem): QueueItem {
  return { ...item, status: "failed" };
}

/** Idempotent: already-posted items stay posted (no double-post). */
export function ensureNotDoublePost(item: QueueItem): void {
  if (item.status === "posted") {
    throw new QueueError(
      `Queue item ${item.id} already posted; refusing double-post`,
    );
  }
}

export function isClaimable(status: QueueItemStatus): boolean {
  return status === "queued";
}
