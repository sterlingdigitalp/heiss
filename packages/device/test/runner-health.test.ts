import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  planRunnerRepair,
  classifyStorage,
  shouldAlertStorage,
  STORAGE_WARN_BYTES,
  STORAGE_CRITICAL_BYTES,
} from "../src/runner-health.js";
import {
  automationRunnerLabel,
  automationPlistXml,
} from "../src/runner-install.js";
import { loadSigningConfig, resolveSigningConfig } from "../src/signing.js";

describe("automation runner supervision", () => {
  it("repairs by relaunch when build products exist, reinstall otherwise", () => {
    assert.equal(planRunnerRepair(true, true), "none");
    assert.equal(planRunnerRepair(true, false), "none");
    assert.equal(planRunnerRepair(false, true), "relaunch");
    assert.equal(planRunnerRepair(false, false), "reinstall");
  });

  it("sanitizes UDIDs into launchd labels", () => {
    assert.equal(
      automationRunnerLabel("AC3FBDFC-9EB1-584F-B870-724F9DFE4596"),
      "so.heiss.automation.AC3FBDFC-9EB1-584F-B870-724F9DFE4596",
    );
    assert.equal(automationRunnerLabel("bad udid/&<>"), "so.heiss.automation.bad-udid----");
  });

  it("emits a KeepAlive RunAtLoad plist with XML-escaped arguments", () => {
    const xml = automationPlistXml(
      "so.heiss.automation.TEST",
      ["/usr/bin/xcodebuild", "-project", "/tmp/My <Farm> & Co/HeissRunner.xcodeproj"],
      "/tmp/My <Farm> & Co",
      "/tmp/logs/TEST.log",
    );
    assert.match(xml, /<key>KeepAlive<\/key><true\/>/);
    assert.match(xml, /<key>RunAtLoad<\/key><true\/>/);
    assert.match(xml, /My &lt;Farm&gt; &amp; Co/);
    assert.ok(!xml.includes("<Farm>"));
    assert.match(xml, /<string>so.heiss.automation.TEST<\/string>/);
    // Crash-loop cap: 15s let a degraded runner hammer CoreDevice 4x/minute.
    assert.match(xml, /<key>ThrottleInterval<\/key><integer>300<\/integer>/);
    assert.ok(!/<integer>15<\/integer>/.test(xml), "the old 15s throttle must be gone");
  });
});

describe("storage watchdog", () => {
  const GB = 1024 ** 3;

  it("classifies reported free space into ok/warn/critical", () => {
    assert.equal(classifyStorage(20 * GB), "ok");
    assert.equal(classifyStorage(STORAGE_WARN_BYTES + 1), "ok");
    assert.equal(classifyStorage(STORAGE_WARN_BYTES), "warn");
    assert.equal(classifyStorage(4 * GB), "warn");
    assert.equal(classifyStorage(STORAGE_CRITICAL_BYTES), "critical");
    assert.equal(classifyStorage(1 * GB), "critical");
  });

  it("treats unknown/undefined/negative free space as ok, never a false alarm", () => {
    assert.equal(classifyStorage(undefined), "ok");
    assert.equal(classifyStorage(-1), "ok");
    assert.equal(classifyStorage(Number.NaN), "ok");
  });

  it("alerts once per day per level, and re-alerts when severity worsens", () => {
    // First warn of the day fires; a repeat the same day does not.
    assert.equal(shouldAlertStorage("warn", undefined, "2026-07-20"), true);
    assert.equal(shouldAlertStorage("warn", "2026-07-20:warn", "2026-07-20"), false);
    // Worsening warn → critical on the same day re-alerts.
    assert.equal(shouldAlertStorage("critical", "2026-07-20:warn", "2026-07-20"), true);
    // A new day re-alerts even at the same level.
    assert.equal(shouldAlertStorage("warn", "2026-07-20:warn", "2026-07-21"), true);
    // ok never alerts.
    assert.equal(shouldAlertStorage("ok", undefined, "2026-07-20"), false);
  });
});

describe("signing resilience (autonomy regressions)", () => {
  const savedEnv: Record<string, string | undefined> = {};
  const keys = [
    "HEISS_TEAM_ID", "DEVELOPMENT_TEAM", "HEISS_BUNDLE_ID",
    "HEISS_ASC_KEY_PATH", "APP_STORE_CONNECT_API_KEY_PATH",
    "HEISS_ASC_KEY_ID", "APP_STORE_CONNECT_KEY_ID",
    "HEISS_ASC_ISSUER_ID", "APP_STORE_CONNECT_ISSUER_ID",
  ];
  beforeEach(() => {
    for (const key of keys) { savedEnv[key] = process.env[key]; delete process.env[key]; }
  });
  afterEach(() => {
    for (const key of keys) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  it("treats a corrupt signing.json as unset instead of throwing", () => {
    const dir = mkdtempSync(join(tmpdir(), "heiss-signing-"));
    const corrupt = join(dir, "signing.json");
    writeFileSync(corrupt, "{ not json !!");
    assert.equal(loadSigningConfig(corrupt), null);
    const resolved = resolveSigningConfig({}, corrupt);
    assert.equal(resolved.method, "xcode");
  });

  it("ignores stale ASC env pointing at a missing .p8 and keeps the Xcode path", () => {
    const dir = mkdtempSync(join(tmpdir(), "heiss-signing-"));
    process.env.HEISS_TEAM_ID = "ABCDE12345";
    process.env.HEISS_ASC_KEY_PATH = join(dir, "deleted-key.p8");
    process.env.HEISS_ASC_KEY_ID = "KEYID";
    process.env.HEISS_ASC_ISSUER_ID = "ISSUER";
    const resolved = resolveSigningConfig({}, join(dir, "absent.json"));
    assert.equal(resolved.method, "xcode");
    assert.equal(resolved.teamId, "ABCDE12345");
  });

  it("still prefers ASC when the key material actually exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "heiss-signing-"));
    const keyPath = join(dir, "AuthKey.p8");
    writeFileSync(keyPath, "fake-key");
    process.env.HEISS_ASC_KEY_PATH = keyPath;
    process.env.HEISS_ASC_KEY_ID = "KEYID";
    process.env.HEISS_ASC_ISSUER_ID = "ISSUER";
    const resolved = resolveSigningConfig({}, join(dir, "absent.json"));
    assert.equal(resolved.method, "asc");
  });
});
