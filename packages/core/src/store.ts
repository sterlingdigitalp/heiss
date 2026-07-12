import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import type {
  ActivityEvent,
  ContentAsset,
  Device,
  FarmSession,
  QueueItem,
  ScheduleSlot,
  SocialAccount,
  User,
} from "./types.js";
import type { LockSnapshot } from "./locks.js";
import { ResourceLocks } from "./locks.js";

export interface FarmState {
  version: 1;
  users: User[];
  devices: Device[];
  accounts: SocialAccount[];
  contents: ContentAsset[];
  queue: QueueItem[];
  slots: ScheduleSlot[];
  sessions: FarmSession[];
  activity: ActivityEvent[];
  locks: LockSnapshot;
}

export function emptyState(): FarmState {
  return {
    version: 1,
    users: [],
    devices: [],
    accounts: [],
    contents: [],
    queue: [],
    slots: [],
    sessions: [],
    activity: [],
    locks: { devices: {}, content: {} },
  };
}

export class JsonStore {
  readonly path: string;
  state: FarmState;
  locks: ResourceLocks;

  constructor(path: string) {
    this.path = path;
    this.state = emptyState();
    this.locks = new ResourceLocks();
    this.load();
  }

  load(): void {
    if (!existsSync(this.path)) {
      this.state = emptyState();
      this.locks = new ResourceLocks();
      return;
    }
    const raw = readFileSync(this.path, "utf8");
    this.state = JSON.parse(raw) as FarmState;
    this.locks = new ResourceLocks();
    this.locks.restore(this.state.locks ?? { devices: {}, content: {} });
  }

  save(): void {
    this.state.locks = this.locks.snapshot();
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(this.state, null, 2), "utf8");
  }

  pushActivity(event: Omit<ActivityEvent, "id" | "at"> & { id?: string; at?: string }): ActivityEvent {
    const full: ActivityEvent = {
      id: event.id ?? cryptoRandom(),
      at: event.at ?? new Date().toISOString(),
      accountId: event.accountId,
      deviceId: event.deviceId,
      sessionId: event.sessionId,
      kind: event.kind,
      message: event.message,
      meta: event.meta,
    };
    this.state.activity.push(full);
    return full;
  }
}

function cryptoRandom(): string {
  return globalThis.crypto?.randomUUID?.() ?? `id-${Date.now()}-${Math.random()}`;
}
