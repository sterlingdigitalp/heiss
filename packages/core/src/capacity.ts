import {
  MAX_ACCOUNTS_PER_PLATFORM_PER_DEVICE,
  type Platform,
  type PlanTier,
  type SocialAccount,
} from "./types.js";

export class CapacityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CapacityError";
  }
}

/** Enforce Warmr-style 8 accounts per platform per device. */
export function assertCanAddAccount(
  existing: SocialAccount[],
  deviceId: string,
  platform: Platform,
): void {
  const count = existing.filter(
    (a) => a.deviceId === deviceId && a.platform === platform,
  ).length;
  if (count >= MAX_ACCOUNTS_PER_PLATFORM_PER_DEVICE) {
    throw new CapacityError(
      `Device ${deviceId} already has ${MAX_ACCOUNTS_PER_PLATFORM_PER_DEVICE} ${platform} accounts`,
    );
  }
}

export function assertWithinPlan(
  tier: PlanTier,
  deviceCount: number,
  accountCount: number,
): void {
  if (tier.maxDevices !== null && deviceCount > tier.maxDevices) {
    throw new CapacityError(
      `Plan ${tier.name} allows at most ${tier.maxDevices} device(s)`,
    );
  }
  if (tier.maxAccounts !== null && accountCount > tier.maxAccounts) {
    throw new CapacityError(
      `Plan ${tier.name} allows at most ${tier.maxAccounts} account(s)`,
    );
  }
}
