# Heiss robustness review — 2026-09-26

Reviewed commit: `adbf027`. This investigation covers the local controller, desktop shell, USB transport, XCTest runner, persisted state, recent repair history, and existing tests. Live state and logs were read without changing them. The hosted service was not reassessed: the inspected farm state contains no cloud URL and has an empty content queue; deployment elsewhere was not verified.

## Assessment

Heiss can be made substantially more robust. Its feature set also creates an ongoing maintenance requirement: it controls third-party iPhone apps through their changing user interfaces, including account pickers, notifications, keyboards, permission sheets, and accessibility trees. Keeping those interactions reliable requires continuing compatibility work.

The preventable part is how failures propagate and recover. Scheduling, human controls, lengthy device work, and repair operations share too much execution machinery. Curated engagement has its own execution path with different safeguards. Tests exercise the TypeScript bookkeeping much more thoroughly than the actual phone boundary. Changes are deployed through multiple runtime and installer paths.

A focused stabilization effort should improve predictable behavior and reduce manual intervention. Retaining the current phone interaction features means accepting some ongoing compatibility maintenance. There is no evidence here to justify a complete rewrite or to promise maintenance-free operation.

## Evidence from this installation

Snapshot read on September 26, around 11:16–11:20 UTC:

- One registered iPhone, 28 account records, five enabled warmup schedules, all for X. Other platforms remain in the account inventory.
- All 52 retained sessions were marked completed at inspection. Maintenance was deliberately active with reason `Detach from desktop`.
- Activity from September 18 onward contained **46 failure events**: 20 runner-restart reports, seven acknowledgement timeouts, 12 account/handle-verification reports, five explicit controller/runner build mismatches, and two X navigation-drawer failures. These are event counts, including retries and manual canaries, across multiple deployed builds; they are not 46 distinct incidents or a measured failure rate.
- Six device-lock reclamation events appeared in that window.
- Daily reports recorded warmups at 5/5 on September 18–21, 4/5 on September 22–24, and 3/5 on September 25. They are snapshots at reporting time; later recovery can explain why retained sessions are now completed.
- The source, built core package, packaged desktop CLI, and copied runner Swift source all currently contain runner build `heiss-runner-2026.09.25.3`. This is an artifact comparison, not a fresh query of the installed phone binary. Historical mismatch failures are real, but current artifact drift was not found.

Recent commits independently document recurrent failure families: X search typing, notification interception, dead device locks, watchdog interruption of healthy work, obsolete parked sessions, and XCTest host crashes.

## Findings and structural remedies

### 1. Execution paths do not share all control guarantees — first priority

**Evidence:** [session stop guard](../packages/core/src/orchestrator.ts#L254), [curated engagement](../apps/farm/src/cli.ts#L329), [daemon engagement dispatch](../apps/farm/src/cli.ts#L1470), [serialized command queue](../apps/farm/src/command-authority.ts#L27).

`FarmOrchestrator.runOnce()` checks `emergencyStop`. The separate `runCuratedEngagementOnce()` does not. When the orchestrator returns no sessions because of an emergency stop, the daemon can still enter its curated-engagement branch if a persona is otherwise eligible. The stop command itself also waits in the same serialized queue as long device work, so it cannot interrupt that work promptly. A batched phone session has no cancellation command checked between its steps.

**Isolated reproduction:** extracted the actual curated function using the TypeScript AST, transpiled it without changing its body, supplied a temporary real `JsonStore`, and replaced the physical driver with a stub that throws on connection. With `emergencyStop=true`, the function attempted the device connection. No phone command was sent. The daemon path to that function was confirmed by source inspection.

There is also a remaining lock-cleanup hole: the function acquires and saves a device lock before selecting its target. A `no target` return occurs before its `try/finally`. The same isolated harness returned `not_on_curated_list` with `deviceStillLocked=true`. A short-lived CLI process will subsequently become reclaimable, but the cleanup invariant is still broken.

**Remedy:** route all device jobs through one execution boundary that owns admission checks, lock acquisition/release, job state, retries, and terminal outcomes. Put every exit after acquisition inside `try/finally`. Give stop/cancel a prompt control path, with cancellation checked on the phone between bounded steps. An acknowledgement should distinguish “stop requested” from “phone has stopped.” Preserve serialized state updates when introducing that control path.

### 2. Long jobs and recovery are coupled to the controller's scheduling loop

**Evidence:** [whole-tick watchdog](../apps/farm/src/cli.ts#L1251), [sequential session dispatch](../apps/farm/src/cli.ts#L1438), [checkpoint retry loop](../packages/core/src/orchestrator.ts#L296), [USB command deadlines](../packages/device/src/ios-transport.ts#L322).

A single serialized tick includes cloud calls when enabled, device discovery, signing renewal, runner supervision, retry sessions, posting, warmups, and engagement. The controller exits after 25 minutes for the entire tick. A batched session alone can wait 15 minutes after delivery. `maxSessions: 1` limits newly started sessions; the preceding checkpoint-resume loop has no corresponding limit. Multiple individually valid operations can therefore exhaust the aggregate tick budget. The timer starts before waiting for the command authority too.

This is a source-derived risk; no 25-minute stall was induced. The separate controller heartbeat added recently is useful, but it does not resolve the aggregate execution budget or queued controls.

**Remedy:** keep the controller responsive and move device execution into a worker with one active job per phone. Track process liveness and job progress separately. Bound individual operations and total job time, count resumed work against the scheduling budget, and recover the affected worker when possible. A smaller first step is to run only one budgeted unit of work per tick and make queued controls responsive.

### 3. The phone protocol needs explicit treatment of uncertain outcomes

**Evidence:** [host delivery/retry/polling](../packages/device/src/ios-transport.ts#L251), [runner command handling](../ios/HeissRunner/UITests/HeissRunnerUITests.swift#L141), [journal writes](../ios/HeissRunner/UITests/HeissRunnerUITests.swift#L1886), [publication recovery](../ios/HeissRunner/UITests/HeissRunnerUITests.swift#L356).

The warmup journal and generation checks are valuable existing protections. However, the host stopping its wait does not stop the phone's work. The runner processes commands synchronously, so a ping shares the path used by long actions. Single commands have no general durable receipt lookup before execution. Journal and response writes use `try?`, allowing persistence failures to be silently ignored while actions continue or the inbox entry is removed.

The previously reported publication verifier still treats absence of a Post/Share button as success and skips the usual account verification. That is insufficient evidence that the intended content was published. This is currently a latent posting issue, since the inspected content queue is empty.

**Remedy:** add durable command receipts and explicit states such as accepted, running, succeeded, failed, cancelled, and outcome unknown. Use stable job IDs across retries, and a worker ownership generation the phone checks before further actions. Surface journal-write failures. After a lost acknowledgement, reconcile the result before retrying a consequential action. Verify posting with positive account/content evidence or retain an unknown outcome for review. An ID alone cannot guarantee exactly-once behavior across an external UI action and a subsequent crash.

The current file channel also spawns repeated `devicectl` processes to poll replies. First instrument calls per job, latency, and transport failures; adapt polling further or prototype a persistent channel only if measurements justify that migration. A channel replacement still needs the same receipt and recovery semantics.

### 4. The compatibility boundary is intrinsically fragile and under-tested

**Evidence:** [private runtime hooks](../ios/HeissRunner/UITests/HeissRunnerUITests.swift#L11), [runner session loop](../ios/HeissRunner/UITests/HeissRunnerUITests.swift#L598), [device test doubles](../packages/device/test/drivers.test.ts#L16), [orchestrator test doubles](../packages/core/test/checkpoint-orchestrator.test.ts#L28).

The 3,482-line Swift runner combines four platforms, OCR, accessibility queries, coordinate fallbacks, overlays, account switching, and long-running service behavior. It changes internal XCTest methods at runtime to suppress quiescence waits and uses an internal interruption-handling selector. These dependencies add compatibility risk beyond ordinary application code. Apple's documented purpose for XCUIAutomation is testing UI behavior through queries and simulated interactions: [Apple documentation](https://developer.apple.com/documentation/XCUIAutomation).

The existing tests verify many useful state and recovery rules, but substitute device drivers rather than exercise the production USB-to-Swift-to-app chain. The root test command does not compile or validate the Swift runner. Existing account/composer canaries are a useful starting point.

**Remedy:** extract small platform adapters with explicit recognized screen states and verified before/after conditions. Preserve screenshot/OCR/accessibility fixtures from failures and replay the recognition logic in tests. Add a fake `devicectl` transport harness for lost replies, duplicate delivery, stale generations, slow copies, and restarts. Extend the canary workflow on designated test accounts to cover switching, search, scrolling, and interrupted-session recovery. Require an unattended soak before promoting changes to the everyday phone.

Splitting the Swift file is useful when it enables those tests and contracts. Moving unchanged heuristics into smaller files alone will not improve reliability.

### 5. Desktop and CLI deployment paths have diverged

**Evidence:** [desktop daemon installation](../apps/desktop/main.cjs#L64), [CLI daemon installation](../apps/farm/src/daemon-agent.ts#L108), [bundle replacement](../apps/desktop/scripts/build-app.cjs#L49).

The desktop writes its own launchd configuration, starts the controller through the packaged Electron executable, and immediately bootstraps after bootout. The CLI installer prefers a stable Node path, waits for removal, retries bootstrap, and installs the external watchdog through the CLI command. The desktop installer does not include all those fixes. Packaging deletes and rebuilds the app directory that the desktop-installed daemon may depend on.

The currently installed controller uses the repository's built CLI and `/opt/homebrew/bin/node`, so the app-bundle dependency is not its current configuration. Starting it through the desktop can select the other implementation again. Historical logs also show real version mismatch failures.

**Remedy:** have desktop and CLI call one installer/lifecycle service. Install immutable versioned runtime artifacts outside a bundle being rebuilt, switch versions only after a health check, and keep the prior version for rollback. Expose controller, runner, app, and protocol identities in status. Generate the shared build identifier so host and Swift declarations cannot drift by hand. Verify artifact alignment and a canary during release.

### 6. Reporting can miss work that never started

**Evidence:** [daily summary denominator](../packages/core/src/daily-summary.ts#L65), [summary call placement](../apps/farm/src/cli.ts#L1532), [early maintenance return](../apps/farm/src/cli.ts#L1307).

The engagement summary compares successes with targets attempted today. It does not compare with expected scheduled persona runs. In an isolated real-core fixture with a scheduled persona, an active target, no attempts, and no warmups, `summaryDue=true`, the headline was `warmups 0/0 · engagements 0/0`, and `summaryIsBad=false`.

The daily report is also invoked inside the online-device work branch, after an earlier maintenance return. A paused or fully disconnected day can therefore miss this report. The external pause watchdog partially covers that case, but its role differs from reporting expected work.

**Remedy:** record expected jobs and terminal outcomes explicitly. Report completed, intentionally skipped, blocked, and overdue work against that expectation. Emit the report independently of device execution and maintenance state. Track human interventions, unattended completion, recovery duration, and unknown outcomes by platform/build. This gives a measurable answer to whether each repair actually made operation better.

## Existing strengths to preserve

- Store commits now have a cross-process lock plus revision checks; the earlier lost-update race was addressed.
- CLI forwarding fails closed after an uncertain controller response.
- Warmup plans are frozen and journaled on the phone, with partial progress and restart detection.
- Failure classification, bounded retries, stale-lock recovery, account attention gates, exact-handle checks, and an external controller watchdog already exist.

These are useful foundations for consolidating the system. The 1.38 MB state file and synchronous full-state writes warrant measurement, but this review did not establish them as the main cause of the observed phone failures. Transactional storage may simplify durable job records later; prioritize the execution and testing boundaries first.

## Recommended implementation order

| Stage | Deliverable | Evidence required before promotion |
| --- | --- | --- |
| 1. Make controls and reporting dependable | Shared stop/admission guard for every device path; complete lock cleanup; expected-work reporting; one daemon installer | Regressions for stopped curated work, target-selection exits, missing work, and desktop/CLI lifecycle parity |
| 2. Bound and isolate work | Budget resumed jobs; responsive controller; one worker per phone; explicit cancellation and recovery states | Fault tests show a hung job leaves controls usable, recovery does not overlap phone work, and lost acknowledgements stay explicit |
| 3. Establish a release gate | USB protocol harness, screen fixtures, extended canaries, immutable releases and rollback | Swift build plus TypeScript tests, canary completion, and unattended soak on the supported device/app combination |
| 4. Reduce compatibility work | Platform adapters, fewer unnecessary UI transitions, measured polling changes | Lower intervention frequency and transport cost on comparable workloads |

A reasonable initial operational target is seven consecutive scheduled days without manual recovery, with every due job accounted for. That is a proposed acceptance criterion, not a reliability estimate established by this investigation. With only five enabled warmups per day, a week would still be a small sample.

For a larger change in product scope, move API-supported tasks off the phone where appropriate. For example, X documents creating posts through `POST /2/tweets` and returning a post ID: [X Create Posts](https://docs.x.com/x-api/posts/create-post). That could eliminate UI composition and improve publication evidence for that feature, subject to access and product requirements. It would not reproduce on-phone browsing/warmup behavior. Every retained UI-driven feature retains some compatibility burden.

## Validation and limits

- `npm run typecheck`: passed for core, device, farm, and web.
- `npm test`: **255 passed, 0 failed** — 202 core, 34 device, 13 farm, two web, four desktop.
- The first test invocation was blocked by the sandbox's restriction on local IPC sockets. The unchanged suite passed when run with the required execution permission.
- Three additional isolated probes confirmed the curated stop bypass, target-selection lock leak, and missing-work summary gap described above. Probes used temporary state and a driver that could not contact a phone.
- Test prerequisite scripts rebuilt core/device JavaScript exports. No desktop package was replaced, service restarted, live setting changed, or social action performed by this investigation. Existing tests include read-only USB discovery.
- Swift compilation, live gesture validation, long-duration soak, and transport/storage performance measurements were not run. Those are necessary before claiming a proposed stabilization has succeeded.
- Application source was not edited. The pre-existing `.handoff-auto.md` edit was preserved; this report is the only tracked addition from the investigation.
