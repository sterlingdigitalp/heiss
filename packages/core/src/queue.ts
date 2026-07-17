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
  ownerId?: string;
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
  if (input.kind === "carousel" && (!input.slides || input.slides.length < 2)) {
    throw new QueueError("Carousel requires at least two slides in slides[]");
  }
  if (input.kind === "text" && input.caption.trim().length === 0) {
    throw new QueueError("Text posts require a caption");
  }
  if (input.kind !== "text" && !input.mediaRef.trim()) {
    throw new QueueError("Media posts require mediaRef");
  }
  const now = input.now ?? new Date().toISOString();
  const content: ContentAsset = {
    id: randomUUID(),
    ownerId: input.ownerId,
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
    ownerId: input.ownerId,
    contentId: content.id,
    accountIds: [...input.accountIds],
    status: "queued",
    postedAccountIds: [],
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
  if ((item.postedAccountIds ?? []).includes(accountId)) {
    throw new QueueError(`Queue item ${item.id} already posted to ${accountId}`);
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
  const delivered = [...new Set([...(item.postedAccountIds ?? []), item.assignedAccountId!])];
  const complete = item.accountIds.every((id) => delivered.includes(id));
  return {
    ...item,
    status: complete ? "posted" : "stored_local",
    assignedAccountId: complete ? item.assignedAccountId : undefined,
    postedAccountIds: delivered,
    postedAt: complete ? now : undefined,
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
  if (item.assignedAccountId && (item.postedAccountIds ?? []).includes(item.assignedAccountId)) {
    throw new QueueError(`Queue item ${item.id} already posted to ${item.assignedAccountId}`);
  }
}

export function isClaimable(status: QueueItemStatus): boolean {
  return status === "queued";
}
