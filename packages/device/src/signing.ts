/**
 * Xcode free-Apple-ID signing + App Store Connect API (ASC) signing path.
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type SigningMethod = "xcode" | "asc";

export interface SigningConfig {
  method: SigningMethod;
  /** 10-character DEVELOPMENT_TEAM id for free/paid Apple ID via Xcode. */
  teamId?: string;
  bundleId?: string;
  /** ASC API key path (.p8) for recommended paid-account path. */
  ascKeyPath?: string;
  ascKeyId?: string;
  ascIssuerId?: string;
  codeSignIdentity?: string;
}

export interface SignResult {
  method: SigningMethod;
  teamId?: string;
  bundleId: string;
  xcodebuildArgs: string[];
  notes: string[];
}

const DEFAULT_BUNDLE = "so.heiss.runner";

export function loadSigningConfig(
  configPath = join(homedir(), ".heiss", "signing.json"),
): SigningConfig | null {
  if (!existsSync(configPath)) return null;
  try {
    return JSON.parse(readFileSync(configPath, "utf8")) as SigningConfig;
  } catch {
    // A corrupt config must not take down every signing operation; behave as
    // if unset so env vars / defaults still resolve.
    return null;
  }
}

export function saveSigningConfig(
  config: SigningConfig,
  configPath = join(homedir(), ".heiss", "signing.json"),
): void {
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2));
}

/** Prefer ASC when key env is set; else Xcode team. */
export function resolveSigningConfig(
  overrides: Partial<SigningConfig> = {},
  configPath?: string,
): SigningConfig {
  const fromFile = loadSigningConfig(configPath) ?? { method: "xcode" as const };
  const env: Partial<SigningConfig> = {
    teamId: process.env.HEISS_TEAM_ID ?? process.env.DEVELOPMENT_TEAM,
    bundleId: process.env.HEISS_BUNDLE_ID,
    ascKeyPath: process.env.HEISS_ASC_KEY_PATH ?? process.env.APP_STORE_CONNECT_API_KEY_PATH,
    ascKeyId: process.env.HEISS_ASC_KEY_ID ?? process.env.APP_STORE_CONNECT_KEY_ID,
    ascIssuerId:
      process.env.HEISS_ASC_ISSUER_ID ?? process.env.APP_STORE_CONNECT_ISSUER_ID,
  };
  const merged: SigningConfig = {
    method: overrides.method ?? fromFile.method,
    teamId: overrides.teamId ?? env.teamId ?? fromFile.teamId,
    bundleId:
      overrides.bundleId ?? env.bundleId ?? fromFile.bundleId ?? DEFAULT_BUNDLE,
    ascKeyPath: overrides.ascKeyPath ?? env.ascKeyPath ?? fromFile.ascKeyPath,
    ascKeyId: overrides.ascKeyId ?? env.ascKeyId ?? fromFile.ascKeyId,
    ascIssuerId:
      overrides.ascIssuerId ?? env.ascIssuerId ?? fromFile.ascIssuerId,
    codeSignIdentity:
      overrides.codeSignIdentity ??
      fromFile.codeSignIdentity ??
      "Apple Development",
  };
  if (
    merged.ascKeyPath &&
    merged.ascKeyId &&
    merged.ascIssuerId &&
    existsSync(merged.ascKeyPath) &&
    !overrides.method
  ) {
    // Only auto-prefer ASC when the key material actually exists; a stale
    // env var pointing at a deleted .p8 must not break the working Xcode path.
    merged.method = "asc";
  }
  return merged;
}

/**
 * Build xcodebuild CODE_SIGN arguments for free Apple ID (7-day cert)
 * or paid team.
 */
export function buildXcodeSignArgs(config: SigningConfig): SignResult {
  const bundleId = config.bundleId ?? DEFAULT_BUNDLE;
  const notes: string[] = [];
  const args: string[] = [
    "CODE_SIGN_STYLE=Automatic",
    `PRODUCT_BUNDLE_IDENTIFIER=${bundleId}`,
  ];
  if (config.teamId) {
    args.push(`DEVELOPMENT_TEAM=${config.teamId}`);
    notes.push(`Using DEVELOPMENT_TEAM=${config.teamId} (Xcode automatic signing)`);
  } else {
    notes.push(
      "No DEVELOPMENT_TEAM set. Open Xcode once, add your Apple ID, set Team, then set HEISS_TEAM_ID.",
    );
  }
  if (config.codeSignIdentity) {
    args.push(`CODE_SIGN_IDENTITY=${config.codeSignIdentity}`);
  }
  if (config.method === "xcode") {
    notes.push(
      "Free Apple ID certs expire every 7 days — re-run heiss-farm runner install weekly.",
    );
  }
  return {
    method: "xcode",
    teamId: config.teamId,
    bundleId,
    xcodebuildArgs: args,
    notes,
  };
}

/**
 * ASC API path: validate key material and produce auth env for altool / notary /
 * future one-button install. Does not store Apple ID passwords.
 */
export function buildAscSignPlan(config: SigningConfig): SignResult {
  const bundleId = config.bundleId ?? DEFAULT_BUNDLE;
  const notes: string[] = [];
  if (!config.ascKeyPath || !existsSync(config.ascKeyPath)) {
    throw new Error(
      "ASC path requires HEISS_ASC_KEY_PATH (.p8) from App Store Connect → Users → Keys",
    );
  }
  if (!config.ascKeyId || !config.ascIssuerId) {
    throw new Error("ASC path requires HEISS_ASC_KEY_ID and HEISS_ASC_ISSUER_ID");
  }
  notes.push("App Store Connect API key present — paid Apple Developer path");
  notes.push("Certificate validity ~1 year with automatic re-sign support");
  const args = [
    "CODE_SIGN_STYLE=Automatic",
    `PRODUCT_BUNDLE_IDENTIFIER=${bundleId}`,
  ];
  if (config.teamId) args.push(`DEVELOPMENT_TEAM=${config.teamId}`);
  return {
    method: "asc",
    teamId: config.teamId,
    bundleId,
    xcodebuildArgs: args,
    notes,
  };
}

export function planSigning(config?: Partial<SigningConfig>): SignResult {
  const resolved = resolveSigningConfig(config ?? {});
  if (resolved.method === "asc") return buildAscSignPlan(resolved);
  return buildXcodeSignArgs(resolved);
}

/** Detect teams from local Xcode accounts if possible (best-effort). */
export async function detectLocalTeams(): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync(
      "security",
      ["find-identity", "-v", "-p", "codesigning"],
      { timeout: 10_000 },
    );
    const teams = new Set<string>();
    for (const line of stdout.split("\n")) {
      const m = line.match(/\(([A-Z0-9]{10})\)/);
      if (m) teams.add(m[1]!);
    }
    return [...teams];
  } catch {
    return [];
  }
}
