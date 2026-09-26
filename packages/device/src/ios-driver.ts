import type { DeviceActionContext, DeviceDriver, DeviceSessionResult, FailureKind } from "@heiss/core";
import { RealUsbTransport } from "./ios-transport.js";

/**
 * Real iPhone driver — physical devices only.
 * Never uses a simulator. Never uses unofficial social APIs.
 */
export interface IosTransport {
  listDevices(): Promise<{ udid: string; name: string }[]>;
  installRunner?(udid: string): Promise<void>;
  tap?(udid: string, x: number, y: number): Promise<void>;
  swipe?(udid: string, x1: number, y1: number, x2: number, y2: number): Promise<void>;
  screenshot?(udid: string): Promise<Buffer>;
  runScriptAction?(
    udid: string,
    action: string,
    context?: DeviceActionContext,
  ): Promise<{ ok: true; detail: string ; data?: Record<string, unknown> }>;
  runScriptSession?(
    udid: string,
    sessionId: string,
    plannedSteps: string[],
    startIndex: number,
    context: DeviceActionContext,
  ): Promise<DeviceSessionResult>;
}

export class DeviceSessionError extends Error {
  constructor(
    message: string,
    readonly failureKind: FailureKind,
    readonly completedSteps = 0,
    readonly screenshot?: string,
    readonly stepDetails?: string[],
  ) {
    super(message);
    this.name = "DeviceSessionError";
  }
}

/**
 * Thrown by a single (non-batched) runner action failure. Carries the same
 * `failureKind` property shape as DeviceSessionError so core's classification
 * (classifyFailure) can read an explicit kind for both paths, instead of
 * falling back to message-text regexes.
 */
export class DeviceActionError extends Error {
  constructor(
    message: string,
    readonly failureKind: FailureKind,
    readonly action?: string,
    readonly commandId?: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = "DeviceActionError";
  }
}

export class RealIosDriver implements DeviceDriver {
  readonly kind = "ios" as const;
  private transport: IosTransport;
  private connected = new Map<string, string>();

  /**
   * @param transport Optional override (tests). Production defaults to RealUsbTransport.
   */
  constructor(transport?: IosTransport) {
    this.transport = transport ?? new RealUsbTransport();
  }

  setTransport(transport: IosTransport): void {
    this.transport = transport;
  }

  async connect(deviceId: string, udid: string): Promise<void> {
    const devices = await this.transport.listDevices();
    if (!devices.some((d) => d.udid === udid)) {
      throw new Error(
        `RealIosDriver: device UDID ${udid} not found on USB. Plug in, unlock, Trust.`,
      );
    }
    if (this.transport.runScriptAction) {
      let lastError: unknown;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          const ready = await this.transport.runScriptAction(udid, "ping");
          if (ready.ok) { lastError = undefined; break; }
        } catch (error) {
          lastError = error;
          await new Promise((resolve) => setTimeout(resolve, attempt * 1_000));
        }
      }
      if (lastError) {
        throw new Error(`RealIosDriver: runner readiness check failed for ${udid.slice(0, 8)}: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
      }
    }
    this.connected.set(deviceId, udid);
  }

  async disconnect(deviceId: string): Promise<void> {
    this.connected.delete(deviceId);
  }

  async runAction(
    deviceId: string,
    _accountId: string,
    action: string,
    context?: DeviceActionContext,
  ): Promise<{ ok: true; detail: string; data?: Record<string, unknown> }> {
    const udid = this.connected.get(deviceId);
    if (!udid) {
      throw new Error(`RealIosDriver: device ${deviceId} not connected`);
    }

    if (this.transport.runScriptAction) {
      return this.transport.runScriptAction(udid, action, context);
    }

    // No coordinate fallback. RealUsbTransport always implements
    // runScriptAction, so the old swipe/tap path with hardcoded portrait points
    // was unreachable — and blind coordinate taps are how X's Grok panel got
    // opened on 2026-07-30. A transport that cannot script must fail loudly.
    throw new Error(
      `RealIosDriver: transport cannot perform ${action}. Install HeissRunner on the device.`,
    );
  }

  async runSession(
    deviceId: string,
    _accountId: string,
    sessionId: string,
    plannedSteps: string[],
    startIndex: number,
    context: DeviceActionContext,
  ): Promise<DeviceSessionResult> {
    const udid = this.connected.get(deviceId);
    if (!udid) throw new Error(`RealIosDriver: device ${deviceId} not connected`);
    if (this.transport.runScriptSession) {
      return this.transport.runScriptSession(udid, sessionId, plannedSteps, startIndex, context);
    }
    let completedSteps = startIndex;
    const stepDetails: string[] = [];
    for (let index = startIndex; index < plannedSteps.length; index += 1) {
      const step = plannedSteps[index]!;
      const result = await this.runAction(deviceId, _accountId, step, context);
      stepDetails[index] = result.detail;
      completedSteps = index + 1;
    }
    return {
      ok: true,
      detail: `legacy-session:${context.platform}:${completedSteps}/${plannedSteps.length}`,
      completedSteps,
      stepDetails,
      heartbeatAt: new Date().toISOString(),
    };
  }

  capabilities(): {
    hardwareRequired: true;
    unofficialApis: false;
    usesOnDeviceTaps: true;
    fullyWired: true;
    simulator: false;
  } {
    return {
      hardwareRequired: true,
      unofficialApis: false,
      usesOnDeviceTaps: true,
      fullyWired: true,
      simulator: false,
    };
  }
}

