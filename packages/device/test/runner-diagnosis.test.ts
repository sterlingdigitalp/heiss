import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diagnoseRunnerFailure, runnerFailureEvidence } from "../src/runner-diagnosis.js";

const cause = (text: string) => diagnoseRunnerFailure(text)?.cause;

describe("runner failure diagnosis", () => {
  // Wording copied from real ~/.heiss/runner-build logs and recorded incidents.
  it("names operator-only causes", () => {
    assert.equal(cause("NSLocalizedRecoverySuggestion=Xcode cannot launch HeissRunnerUITests on SterlingDP because the device is locked."), "device_locked");
    assert.equal(cause("Developer Mode is disabled"), "developer_mode_off");
    assert.equal(cause("Unable to launch so.heiss.runner.xctrunner because it has an invalid code signature, inadequate entitlements or its profile has not been explicitly trusted by the user."), "developer_certificate_untrusted");
    assert.equal(cause("error: The application could not be launched because the Developer App Certificate is not trusted."), "developer_certificate_untrusted");
    assert.equal(cause("error: No Accounts: Add a new account in Accounts settings."), "xcode_account_missing");
    assert.equal(cause("error: No Account for Team \"Y85HZWRV2Y\"."), "xcode_team_mismatch");
    assert.equal(diagnoseRunnerFailure("Developer App Certificate is not trusted")?.needsHuman, true);
  });

  it("prefers the specific cause over generic install or lock wording", () => {
    assert.equal(cause("Failed to install the app on the device. mkdir of '/private/var/installd/...': No space left on device"), "device_storage_full");
    assert.equal(cause("Testing failed: Developer Mode must be enabled; unlock the device"), "developer_mode_off");
  });

  it("names transient causes without stopping the repair ladder", () => {
    const unreachable = diagnoseRunnerFailure("xcodebuild: error: Unable to find a destination matching the provided destination specifier:");
    assert.deepEqual([unreachable?.cause, unreachable?.needsHuman], ["device_unreachable", false]);
    assert.equal(cause("xcodebuild: error: Unable to find a destination matching the provided destination specifier:"), "device_unreachable");
    assert.equal(cause("Failed to stream the app asset from remote device\nUnhandled error domain IXRemoteErrorDomain, code 7"), "install_failed");
    assert.equal(diagnoseRunnerFailure("install_failed text: Failed to install the app on the device.")?.needsHuman, false);
  });

  it("returns nothing for unrecognised failures so generic repair runs", () => {
    assert.equal(diagnoseRunnerFailure("relaunched but ping failed: ECONNREFUSED"), undefined);
    // Printed in the ineligible-destinations list of runs that succeed.
    assert.equal(diagnoseRunnerFailure("{ platform:iOS, arch:arm64, name:SterlingDP, error:Device is busy (Connecting to SterlingDP) }"), undefined);
    assert.equal(diagnoseRunnerFailure("** BUILD INTERRUPTED **"), undefined);
    assert.equal(diagnoseRunnerFailure("error: Timed out waiting for all destinations matching the provided destination specifier to become available"), undefined);
    assert.equal(diagnoseRunnerFailure(""), undefined);
  });

  it("reads the log a message points at", () => {
    const log = join(mkdtempSync(join(tmpdir(), "heiss-diag-")), "runner-123.log");
    writeFileSync(log, `${"noise\n".repeat(20_000)}error: The application could not be launched because the Developer App Certificate is not trusted.\n`);
    const evidence = runnerFailureEvidence(`relaunch exited; see ${log}`);
    assert.equal(cause(evidence), "developer_certificate_untrusted");
    assert.equal(cause(runnerFailureEvidence("relaunch exited; see /nonexistent/runner.log")), undefined);
  });
});
