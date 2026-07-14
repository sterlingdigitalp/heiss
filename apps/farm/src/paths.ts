import { join } from "node:path";
import { homedir } from "node:os";

export function defaultDataDir(): string {
  return process.env.HEISS_DATA ?? join(homedir(), ".heiss", "live");
}

export function farmStatePath(dataDir = defaultDataDir()): string {
  return join(dataDir, "farm.json");
}
