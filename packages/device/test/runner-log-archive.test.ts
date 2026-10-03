import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveRunnerLog, RUNNER_LOG_ARCHIVE_DAYS } from "../src/runner-install.js";

describe("runner log archive", () => {
  it("keeps a dated copy and prunes copies past the window", () => {
    const dir = mkdtempSync(join(tmpdir(), "runner-logs-"));
    const log = join(dir, "UDID.log");
    writeFileSync(log, "run one");
    archiveRunnerLog(log, new Date("2026-10-01T15:00:00Z"));
    const old = join(dir, "archive", readdirSync(join(dir, "archive"))[0]!);
    const stale = (Date.now() - (RUNNER_LOG_ARCHIVE_DAYS + 1) * 86_400_000) / 1000;
    utimesSync(old, stale, stale);
    archiveRunnerLog(log, new Date());
    const kept = readdirSync(join(dir, "archive"));
    assert.equal(kept.length, 1, "the stale copy was pruned");
    assert.match(kept[0]!, /^UDID-\d{4}-/);
  });
});
