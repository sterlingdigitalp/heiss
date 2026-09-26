# Heiss robustness: deeper investigation — 2026-09-26

Follow-up to [the first review](robustness-review-2026-09-26.md), covering command ownership, time and retry behavior, session transitions, X post recognition, signing, desktop status, dead code, storage costs, and dependency updates.

## Assessment

There is substantial room to improve reliability without removing the main features or rewriting the app. Several additional problems reproduce entirely on the Mac with fake device responses: they do not depend on X changing its interface or an unreliable USB connection.

The recurring architectural problem is that the same decision has several implementations: single actions and batches classify failures differently; scheduling and the desktop disagree about active targets; different paths initiate runner repairs; and session completion does not always finish the associated queue item. Consolidating these rules would remove opportunities for fixes to work in one path and miss another.

UI automation still requires compatibility maintenance. Better ownership, recovery, and testing can make that maintenance more predictable and prevent a small interaction failure from disrupting the whole farm.

### Changes made alongside this investigation

During this investigation, changes appeared and were committed as `4f21a06` that address findings from the first review (the initial audit baseline was `adbf027`):

- Curated engagement checks emergency stop and selects a target before acquiring the device lock.
- Desktop daemon lifecycle calls delegate to the CLI installer, which locates a built CLI outside the app bundle.
- Daily summaries count expected engagements and run before the maintenance/device-work branches.
- Root test/typecheck scripts now include a Swift runner typecheck.

These are useful source changes. Their presence does not establish that the deployed app/controller includes them, or that all related behavior is fixed. For example, an emergency-stop request can still wait behind work in the serial authority. This audit did not author or overwrite those implementation changes. The findings below were checked against the relevant source at `4f21a06`.

## Additional findings

“Reproduced” below means an isolated local probe using production functions, temporary state, or fake device responses. It does not mean a live phone incident was induced.

### 1. A second controller can take over the socket without stopping the first

**Priority: high. Reproduced.** [Command authority](../apps/farm/src/command-authority.ts#L137).

Starting the authority unconditionally deletes `controller.sock`. Two server instances can therefore both remain alive: the new instance binds the pathname while the old one keeps running. When the first server closes, its cleanup deletes the second server's socket pathname.

The probe started two actual command-authority servers in a temporary directory, without sending any commands. Both reported `listening=true`. Closing the first left the second listening but with no reachable socket pathname. This is a server-lifetime reproduction, not an experiment with two live farm daemons.

The launchd label protects its own launch path; it is not a general controller ownership lock. The JSON store's commit lock also does not establish exclusive ownership of a whole device job.

**Improve:** acquire an exclusive controller lease before binding; refuse a live owner; reclaim only demonstrably stale ownership. Cleanup must remove only the socket owned by that server. Give forwarded requests stable IDs and recorded outcomes so a disconnect can be reconciled.

### 2. Retry delays use the wrong precedence and sometimes the wrong time

**Priority: high. Reproduced.** [Failure policy](../packages/core/src/failures.ts#L15), [checkpoint failure](../packages/core/src/orchestrator.ts#L1145), [execution timestamps](../packages/core/src/orchestrator.ts#L635).

The orchestrator calculates increasing social retry delays, but `disposition.retryDelayMs ?? socialDelay` always chooses the five-minute delay supplied for navigation/action failures. Five isolated retry counts produced **5, 5, 5, 5, 5 minutes**, rather than increasing delays. Existing repeated-failure and attempt ceilings still limit retries; this finding does not imply infinite retrying.

The failure timestamp passed into that calculation is captured at run start. If an action takes ten minutes to fail, its five-minute retry deadline is already in the past. The same start-time reuse affects completion timestamps and engagement bookkeeping. `createSession()` uses the actual clock while completion can use an earlier tick time, allowing misleading durations. Curated engagement also records completion-related times from its starting timestamp.

**Improve:** separate `scheduledFor`, `startedAt`, `failedAt`, and `completedAt`. Inject a clock for tests and read it at transitions. Calculate backoff from failure time; use monotonic elapsed time for operation deadlines. Put the retry policy in one place and test long-running failures, midnight crossings, and mixed retry classes.

### 3. Single actions discard the runner's structured failure reason

**Priority: high. Reproduced.** [Single action](../packages/device/src/ios-transport.ts#L159), [batch action](../packages/device/src/ios-transport.ts#L196).

For a failed single action, `runScriptAction()` throws a plain error and drops `failureKind`. Batch execution preserves it in `DeviceSessionError`.

With the same fake runner reply, `failureKind=account_mismatch` and detail `Identity verification failed`, the single-action path classified it as a recoverable **runner** failure; the batch path correctly classified **account_mismatch**, requiring attention. Some current English messages happen to match fallback regular expressions, but a wording change should not change the recovery policy.

**Improve:** one typed result/error contract for both paths. Preserve the explicit failure kind, action, command ID, partial progress, and uncertainty. Keep text matching only for legacy responses. Validate protocol payloads at the boundary instead of relying on casts and arbitrary action strings.

### 4. Post parsing can mistake text in the body for the post's age

**Priority: high for curated X engagement. Reproduced.** [X parser](../packages/core/src/x-posts.ts#L98), [on-device matching](../ios/HeissRunner/UITests/HeissRunnerUITests.swift#L1230).

The parser chooses the first relative-time phrase anywhere in the accessibility label. A fixture whose body says `Our full deployment finished successfully 2 hours ago...`, followed by the actual timestamp `5 days ago`, was parsed as **2 hours old instead of 120 hours**. A body containing a relative phrase can also take precedence over an absolute timestamp in the tail. That can change eligibility and ordering.

Post keys use only the first 60 normalized body characters. Different authors and different posts with the same opening generated identical keys in the probe. Engagement history can consequently suppress an unrelated post as already handled.

A related source-derived risk remains on the phone: OCR matching shortens content to a few words or one long word, and opening a detail screen is confirmed using generic markers such as `Views`. This does not independently verify the selected post's identity. No wrong-post action was attempted during the audit.

**Improve:** parse the structured timestamp/metrics tail; reject ambiguous labels. Prefer an actual post ID/permalink when obtainable, otherwise combine author, timestamp, and a fuller content fingerprint. After navigation, verify author and content before acting. Keep shortened OCR phrases as navigation aids. Add fixtures with quoted dates, relative-time phrases in bodies, repeated openings, pinned posts, and quote posts.

### 5. Automatically paused targets still look active and consume capacity

**Priority: medium, relevant to everyday operation. Reproduced.** [Scheduler selection](../packages/core/src/targets.ts#L65), [addition limit](../packages/core/src/targets.ts#L100), [desktop target rendering](../apps/desktop/renderer.html#L50).

The scheduler excludes targets with `autoPausedAt`. The seven-target capacity check and desktop status use only `active`.

With seven automatically paused targets, the probe found **zero selectable targets**, while adding a replacement was rejected because there were supposedly **seven active targets**. The desktop can show these targets as ready and offer Pause, concealing the reason nothing runs.

**Improve:** one shared target-status function used by selection, capacity, reports, and desktop rendering. Show automatic-pause reasons and a direct Resume action. Decide explicitly whether such targets reserve capacity; the UI and error message must reflect that choice.

### 6. Runner renewal can be scheduled weeks after the actual profile expiry

**Priority: medium; confirmed against local build artifacts.** [Expiry estimate](../apps/farm/src/cli.ts#L545), [install record](../packages/device/src/runner-install.ts#L412).

The controller estimates expiry as installation time plus seven days for `xcode`, or 365 days for `asc`. Reinstalling does not necessarily create a new provisioning profile. The `xcode` configuration also supports both free and paid teams, so the authentication/signing method alone is insufficient.

The local install record says September 25, 2026 and `asc`, giving an estimated expiry of **September 25, 2027**. Both local built app profiles (`HeissRunner.app` and `HeissRunnerUITests-Runner.app`) contain an expiry of **August 14, 2027**—about **42 days earlier**.

This was a read of embedded profile metadata, without signature validation or downloading the installed phone binary. It establishes a mismatch between the recorded build artifacts and the controller's estimate, not an immediate expiry incident.

**Improve:** record actual profile expiration during installation and account for any earlier signing-certificate expiry. Persist the relevant artifact/build identity. Renewal warnings should use that evidence; missing evidence should be reported as unknown rather than assigned a fresh lifetime.

### 7. Retiring a session after a runner update can strand a posting item

**Priority: high before posting is enabled. Reproduced; latent in this installation's empty content queue.** [Retirement selection](../packages/core/src/stale-attention.ts#L9), [retirement mutation](../packages/core/src/orchestrator.ts#L285).

An attention session from an older runner build and earlier day is automatically marked failed and its account returned to ready. This applies to posting sessions too, regardless of failure kind or publication uncertainty. It does not reconcile the assigned queue item.

An isolated fixture with `publishAttempted=true` ended with **session failed, queue item assigned, account ready**. The normal claim path does not select assigned items, and the failed session is no longer an ordinary checkpoint to resume. The recovery rule thus removes the visible attention gate without resolving the work.

**Improve:** make session transitions update the queue, account attention, and locks together through one function. Preserve unknown publication outcomes for explicit reconciliation. A newer runner build is not evidence that a particular account problem or uncertain post has been resolved. Keep automatic retirement narrowly scoped to recoveries that are demonstrably safe.

### 8. Posting schedules can miss their entire window

**Priority: high before posting is enabled. Reproduced.** [Schedule helpers](../packages/core/src/schedule.ts#L13).

Posting eligibility requires exact `HH:mm` equality. A 09:00 slot was eligible at 09:00, but not at 09:01 or 09:12. Long device work, a restart, or a delayed tick can therefore miss the slot with no same-day catch-up. Warmup scheduling already uses different due-time semantics.

Time validation checks only string shape: `29:75` is accepted by `createSlot()`, which warmup schedule creation also calls.

**Improve:** validate hour/minute ranges once. Represent each due run by account, slot, and local date, with a unique execution key and explicit catch-up/expiry policy. A delayed tick should account for missed work instead of silently waiting for the next matching minute. Test timezone transitions and restarts near the scheduled time.

### 9. A diagnostic call can restart the runner outside the repair owner

**Priority: high architectural cleanup. Source-derived.** [Command classification](../apps/farm/src/command-authority.ts#L12), [health check](../packages/device/src/runner-health.ts#L144), [transport relaunch](../packages/device/src/ios-transport.ts#L401), [runner launch](../packages/device/src/runner-install.ts#L519).

Runner commands bypass the farm mutation authority. A health check uses the same transport that, after delivery trouble, may call `ensureRunnerLaunched()`. That directly calls `launchAutomationRunner()`, which stops the existing job first. This lower transport path does not acquire the build lock used by the higher-level repair service.

Consequently a nominal check can trigger a restart, potentially overlapping installation or other device work. No such race was induced on the phone.

**Improve:** separate passive observations from explicit repairs. Route relaunch, reinstall, and stop through one owner per device, with the same repair/build locking. The transport should report delivery failure; a supervisor with job context should decide whether restarting is appropriate. Use a shared subprocess helper for bounded output, timeouts, termination escalation, and temporary-file cleanup.

### 10. Optional cloud failure can prevent local scheduling

**Priority: medium before cloud use. Source-derived; cloud URL absent in the inspected state.** [Daemon cloud sync](../apps/farm/src/cli.ts#L1349), [manual run's handling](../apps/farm/src/cli.ts#L1614).

The daemon awaits cloud sync before local work, inside the tick's outer error boundary. A cloud error exits that tick. The manual run path instead catches the same error and continues, so the two entry points have different availability behavior.

**Improve:** isolate optional cloud synchronization, with bounded retries and visible status. An unavailable cloud service should not prevent already-local warmups or jobs from being assessed. Reassess the hosted service separately before deployment; this audit does not establish its current deployment state or security posture.

## Improvements that simplify maintenance

### Share behavior where fixes currently need repeating

- **One search implementation per platform.** Swift search behavior appears in the generic action path, the warmup-step path, and `openSearchAndType()`. Consolidate the navigation/typing/verification operation while keeping explicit lifecycle differences. The frequent search repairs in history make this a practical extraction, especially with screen fixtures.
- **One command catalog.** CLI parsing/help, command mutation classification, the socket allowlist, and desktop validation repeat command knowledge. For example, `targets list` is treated as a mutation while runner commands with repair effects bypass the queue. A small catalog of arguments and effects can drive these rules without introducing a large framework.
- **One status model.** `daemonAgentStatus()` calls a successfully registered launchd job “running.” That does not establish a fresh controller heartbeat, enabled scheduling, a ready device, or progressing work. Show these states separately, with sample time and failure reason. The renderer refreshes on startup and actions rather than continuously tracking changes.
- **Expose actual progress.** `makeDriver()` logs batch progress, while the desktop inspector reads persisted checkpoints. The UI can look stalled while the runner is working. Use a lightweight progress feed or status snapshot, distinguishing live progress from durable recovery checkpoints; avoid saving the entire farm for every progress event.
- **Separate CLI dispatch from services.** The new curated-admission tests assert source-text ordering because importing the CLI executes it. Extract an importable engagement service and use behavioral fake-driver tests for stop checks, cleanup, stale state, and failure outcomes. Source-text tests can pass despite semantic mistakes.

### Remove obsolete surface area

An additional TypeScript check with `--noUnusedLocals --noUnusedParameters` found **13 diagnostics**: two in core, four in device, seven in farm, and none in web. Examples include unused account lookup, old runner template constants, and HTTP/auth helpers left in the CLI after the server path was removed. These are cleanup candidates, not 13 independently demonstrated bugs.

There is also legacy `autonomous` engagement help/types even though configuration rejects that mode and loading migrates it off. Keep compatibility conversion at the persistence boundary, then remove obsolete operating paths and clarify which approval/engagement flows are supported. Verify usage before removing the companion iOS app's historical control-server scaffolding: the XCTest host still needs its project/app targets.

After cleanup, enable unused-code checks. Keep core/device/farm boundaries; removing workspaces or adopting a new framework would not itself address the reproduced faults.

### Make persistence explicit before considering a database migration

The store parses JSON with a type assertion, keeps schema version `1`, and mixes normalization, migrations, stale-lock recovery, and retention with loading. Add runtime schema validation, explicit migration versions, recoverable backups, and separate recovery decisions from ordinary reads. Define invariants such as “every assigned posting item has a live owning session or a visible reconciliation state.”

A benchmark on a **temporary copy** of the approximately 1.38 MB live state ran 20 load/save iterations:

| Operation | Median | Maximum observed |
| --- | ---: | ---: |
| Load | 2.00 ms | 2.87 ms |
| Save | 5.49 ms | 6.80 ms |

These are warm local measurements, not crash-durability or contention tests. They provide no evidence that JSON throughput currently explains multi-minute interruptions. SQLite may later help transactional job records, but storage replacement is lower priority than ownership and transition correctness.

Set explicit retention budgets for screenshots and runner/install logs. The inspected failure directory had 387 files at about 123 MiB, plus separate runner and build logs. This is a growth-management opportunity, not evidence that the Mac is currently out of space.

## Updates worth making deliberately

Read-only `npm outdated --json` and `npm audit --json` were run against the registry on September 26. No dependencies were installed or lockfiles changed. The audit reported **zero known vulnerabilities**; that is the registry advisory result, not proof of overall application security.

| Package | Installed | Update within the current declared range | Approach |
| --- | --- | --- | --- |
| Electron | 43.1.0 | 43.7.5 | Update first; smoke-test packaged launch, IPC, daemon lifecycle, and packaging |
| esbuild | 0.28.1 | 0.28.2 | Small separate build-tool update |
| tsx | 4.23.0 | 4.23.15 | Run CLI and test suite after updating |
| `@types/node` | 22.20.1 | 22.20.4 | Keep aligned with the chosen Node runtime |
| TypeScript | 5.9.3 | Already at wanted version | Registry latest is 7.0.2; treat that as a separate major migration |

The registry also reported Electron 44.4.5 as latest. A major Electron migration can follow the smaller update. Electron's policy supports the latest three stable major versions and limits security fixes within a major to its latest minor: [Electron release policy](https://www.electronjs.org/docs/latest/tutorial/electron-timelines).

The local host uses **Node 26.3.1**, Docker uses **Node 22**, types target **Node 22**, and `engines` allows **>=20**. No pinned developer runtime or checked-in CI workflow was found. Align development, daemon, container, types, and release tests on an explicitly tested LTS version—Node 24 LTS is a reasonable candidate, with migration verification. Node's production guidance favors LTS releases; Node 26 is currently on the Current line and Node 20 is end-of-life: [Node release schedule](https://nodejs.org/en/about/previous-releases).

Pin a tested compatibility set: Node, Electron, Xcode/iOS SDK, runner build, phone OS, and social-app versions where controllable. Record automatic external app updates even when pinning is unavailable. The installed Xcode is 27.0 (27A266a); this audit does not establish that upgrading or downgrading it would reduce XCTest crashes.

## Recommended sequence

1. **Close the reproduced control/recovery gaps:** controller ownership; clock/backoff; typed failure propagation; target-status consistency; profile-expiry evidence. Finish and verify the existing stop/lock/installer/reporting changes.
2. **Harden the current X workflow:** timestamp and identity fixtures, post-detail verification, shared search implementation, and visible progress.
3. **Consolidate execution:** passive health checks, one repair owner, budgeted device work, responsive controls, and explicit unknown outcomes. Retain the existing journals and revision protections.
4. **Gate dormant features:** reconcile posting queue/session transitions and missed-slot handling before activating content posting; isolate cloud faults before connecting cloud synchronization.
5. **Reduce future drift:** remove obsolete code, validate persisted/protocol data, align runtimes, apply small dependency updates, and establish a release gate with fault tests and a device canary/soak.

Measure due jobs accounted for, unattended completion, manual interventions, recovery duration, and unknown outcomes. Compare comparable workloads across releases. A practical initial acceptance target remains seven scheduled days without manual recovery, while acknowledging the small workload/sample size.

## Validation and limits

- The isolated probes reproduced the controller socket lifetime bug, retry delay behavior, lost failure classification, posting retirement inconsistency, missed-slot behavior/invalid time acceptance, X age/key ambiguity, and paused-target capacity inconsistency.
- Probes used temporary directories and fake drivers/responses. The store benchmark read the live state only to create a temporary copy. No phone/social action was performed.
- Local provisioning metadata confirmed the discrepancy between the estimated expiry and both built app profiles. Cryptographic validity and the currently installed device binary were not verified.
- The Swift runner **passed typechecking** against the installed iOS SDK, targeting arm64 iOS 17. The first invocation could not write the default compiler cache under sandbox permissions; the equivalent invocation with a temporary module cache passed. This is not a signed build or live UI test.
- The earlier full baseline was **255 tests passed** and all four TypeScript workspaces typechecked. That baseline predates the newly appearing implementation changes; it is not presented as a fresh full-suite result for those edits.
- The new Swift script skips when Xcode is absent. A release gate should have a required macOS/Xcode job so that a skip cannot be mistaken for validation.
- No source fixes, dependency updates, service restarts, package replacement, or live farm changes were made by this deeper investigation. This document is the added artifact. Concurrent source edits were inspected and preserved.

The evidence supports targeted stabilization and simplification. It does not support attributing every incident to these findings, estimating a future failure rate, or promising maintenance-free third-party UI automation.
