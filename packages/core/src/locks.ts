/** In-process + serializable locks for devices and content (no double-assign). */

export class LockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LockError";
  }
}

export interface LockSnapshot {
  devices: Record<string, string>;
  content: Record<string, string>;
}

export class ResourceLocks {
  private devices = new Map<string, string>();
  private content = new Map<string, string>();

  acquireDevice(deviceId: string, sessionId: string): void {
    const holder = this.devices.get(deviceId);
    if (holder && holder !== sessionId) {
      throw new LockError(`Device ${deviceId} already locked by session ${holder}`);
    }
    this.devices.set(deviceId, sessionId);
  }

  releaseDevice(deviceId: string, sessionId: string): void {
    const holder = this.devices.get(deviceId);
    if (holder === sessionId) {
      this.devices.delete(deviceId);
    }
  }

  acquireContent(queueItemId: string, sessionId: string): void {
    const holder = this.content.get(queueItemId);
    if (holder && holder !== sessionId) {
      throw new LockError(
        `Content ${queueItemId} already assigned to session ${holder}`,
      );
    }
    this.content.set(queueItemId, sessionId);
  }

  releaseContent(queueItemId: string, sessionId: string): void {
    const holder = this.content.get(queueItemId);
    if (holder === sessionId) {
      this.content.delete(queueItemId);
    }
  }

  isDeviceLocked(deviceId: string): boolean {
    return this.devices.has(deviceId);
  }

  isContentLocked(queueItemId: string): boolean {
    return this.content.has(queueItemId);
  }

  holderOfDevice(deviceId: string): string | undefined {
    return this.devices.get(deviceId);
  }

  holderOfContent(queueItemId: string): string | undefined {
    return this.content.get(queueItemId);
  }

  snapshot(): LockSnapshot {
    return {
      devices: Object.fromEntries(this.devices),
      content: Object.fromEntries(this.content),
    };
  }

  restore(snapshot: LockSnapshot): void {
    this.devices = new Map(Object.entries(snapshot.devices));
    this.content = new Map(Object.entries(snapshot.content));
  }

  clear(): void {
    this.devices.clear();
    this.content.clear();
  }
}
