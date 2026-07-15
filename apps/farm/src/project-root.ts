import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Locate the vendored iOS runner from a repo checkout or packaged app root. */
export function findProjectRoot(start = process.cwd()): string {
  const explicit = process.env.HEISS_REPO_ROOT;
  if (explicit) {
    const root = resolve(explicit);
    if (existsSync(join(root, "ios", "HeissRunner"))) return root;
    throw new Error(`HEISS_REPO_ROOT does not contain ios/HeissRunner: ${root}`);
  }

  // launchd starts persistent jobs with `/` as cwd. Search both that caller
  // location and this module's location; in Heiss.app the bundled CLI lives
  // beside Resources/app/ios, while in development it lives under apps/farm.
  const starts = [resolve(start), dirname(fileURLToPath(import.meta.url))];
  for (const candidate of starts) {
    let current = candidate;
    while (true) {
      if (existsSync(join(current, "ios", "HeissRunner"))) return current;
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  throw new Error(`Could not locate ios/HeissRunner from ${resolve(start)}`);
}
