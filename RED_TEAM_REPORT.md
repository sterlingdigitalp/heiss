# Red Team Report — Heiss

**Date:** 2026-07-18
**Commit:** `d95efde` (main) · working tree dirty: modified `apps/farm/src/cli.ts`, untracked `candidate-review/`, `search-term-research/`
**Scope:** entire repo, module by module — `packages/core`, `packages/device`, `ios/HeissRunner`, `apps/farm`, `apps/web`, `apps/desktop` (~13.4k LOC). Excluded `node_modules/`, `dist/`, `package-lock.json`.
**Nothing in the repo was modified.** Read-only was enforced structurally (Grok `--permission-mode plan`, Claude agents limited to Read/Grep/Glob).

## Auditors

| Model | Role | Outcome |
| --- | --- | --- |
| **Opus 4.8** (×4 dimension-scoped read-only passes) | core correctness/concurrency; web security; device transport; CLI/engagement/efficiency | 61 findings |
| **grok-4.5 high** | all five dimensions, whole repo | 18 findings |
| **gpt-5.6-sol** (Codex) | all five dimensions, whole repo | **FAILED — see below** |

> **Coverage caveat — read this.** Codex was dispatched twice. Its first run exited 0 after 20+ minutes having audited **a different repository entirely** (FEGOS: "Mission Control", personas, `Writing_Lab_v1.xlsx` — 63 references, and *zero* mentions of heiss/`orchestrator.ts`/`devicectl`), despite `-C /Users/sterlingdigital/heiss`. It resumed cached session context instead of reading the target. That output was quarantined to `/tmp/redteam-codex-WRONG-REPO-fegos.md` and discarded. Grok's first run also misfired — it loaded its own red-team skill and began orchestrating a sub-audit rather than auditing, returning 281 bytes of narration; it was re-dispatched with an anti-recursion preamble and then performed correctly.
>
> **Consequence:** this report reflects **two model families, not three.** "CONSENSUS" below means Opus and Grok agreed, or two independent Opus passes converged from different scopes. Cross-family diversity is weaker than intended, so single-source findings carry more weight than usual — every finding rated critical or high was therefore **manually verified against source** by the orchestrator before inclusion. Verified items are marked ✅.

---

## Executive summary

Heiss is, in its careful parts, genuinely well built. The double-post protocol is the standout: `publishAttempted` is persisted *before* the publish command is sent, so a crash between send and acknowledgement resumes into verification rather than tapping publish twice — one auditor explicitly tried to construct a replay that double-publishes and could not. Crash recovery releases exactly the locks held by dead PIDs rather than clearing the table. Timezone/DST math is correct across spring-forward and fall-back. Path traversal, shell injection around `devicectl`/`xcodebuild`, and cross-tenant *read* isolation on the dashboard were each probed hard and found sound. The on-device engagement guard is fail-closed in the ways that matter.

The problem is not the design. **The problem is that the safety properties the README advertises are not the properties the code enforces**, and that an unattended daemon has several paths to silent, permanent halt.

Three themes dominate:

1. **The engagement safety model has a hole at its centre.** Caps, cooldowns, dated approvals, and the three-reviewed-sessions gate are all implemented — and all bypassable. A resumed session replays a *frozen* step list without re-checking any of them (#3). The autonomous-mode gate increments on approvals that were never valid (#5). The assisted-candidate path writes likes and follows consulting no policy at all, and its writes are invisible to the cap accounting (#6). `requireHumanEngagement`, the documented master switch, **is read by nothing** (#13). Any one of these gets real accounts banned; together they mean the advertised guarantees should not be relied on today.
2. **The unattended daemon has at least four distinct silent-halt paths.** One interrupted resume returns out of the entire tick (#1). Transport failures never escalate, retrying every 60s forever (#2). A `serve-api` command permanently wedges the serial authority (#8). An unguarded, untimed cloud fetch hangs the tick indefinitely (#9). In each case the process stays *alive*, so launchd KeepAlive never restarts it, and nobody is watching.
3. **The hosted web service has a pre-auth account-takeover path** (#4) and a drive-by CSRF that reaches real social accounts (#7).

### Fix these first

| # | What | Where |
| --- | --- | --- |
| 1 | Interrupted resume aborts the whole tick — one unplugged iPhone stops all posting on all devices, forever | `orchestrator.ts:288` |
| 2 | Empty staged media still taps picker cell 0 — publishes an arbitrary camera-roll photo to a real account | `HeissRunnerUITests.swift:408` + `ios-transport.ts:236` |
| 3 | Resumed session replays frozen `like`/`follow` steps, bypassing cap, cooldown, approval, and `mode: off` | `orchestrator.ts:555` |
| 4 | Pre-auth account hijacking: unverified `/api/signup` row is silently adopted by Google and magic-link sign-in | `server.ts:426` |
| 5 | `serve-api` CORS `*` on an unauthenticated mutation API — any web page can post to every connected account | `cli.ts:1726` |

---

## Ranked punch list

Severity ordering: correctness > security > robustness > efficiency > refactor, weighted by confidence.

### CRITICAL

---

**#1 · Interrupted resume aborts the entire tick — permanent farm-wide halt** ✅
`packages/core/src/orchestrator.ts:288` · correctness · **single-source (Opus core)** · *verified*

The resume loop runs before any planning. If `continueSession` returns `interrupted: true` — which `checkpointFailure` causes on *any* device/transport error — `runOnce` returns immediately. Combined with the 60s transport backoff, one unplugged iPhone produces a checkpointed session that is due on nearly every tick, sorts first, fails, and returns. **No account on any device ever posts again.** Only signal is a repeating notification every 60s.

*Verified:* lines 284–292 confirmed — `if (resumed.interrupted) { … return { sessions, activity, interrupted } }` sits inside the `for` loop, before all planning.

**Fix:** track `interrupted = true` and `continue` to the next session, then to planning. Skip further work only for the *same device/account*. Reserve the hard early-return for `opts.interruptAfterSteps` (test hook) and `emergencyStop`.

---

**#2 · Empty staged media publishes an arbitrary camera-roll photo** ✅
`ios/HeissRunner/UITests/HeissRunnerUITests.swift:408` · `packages/device/src/ios-transport.ts:236` · correctness · **CONSENSUS (Opus device + Grok)** · *verified*

Two defects that compose into the worst outcome in this report. `sendCommand` filters media paths through `existsSync` and **silently drops** missing ones — a pruned Cloud Drop file, a path from another machine, a failed download — setting no `stagedMediaNames` and raising no error. On device, `post:upload` then runs `for index in 0..<min(max(staged.count, 1), cells.count)`. The `max(staged.count, 1)` floor means an **empty** list still taps `cells.element(boundBy: 0)`, taps Next, and the following `post:caption`/`post:publish` steps publish it. Result: **an arbitrary photo from the phone's camera roll published to a real social account under the operator's handle.** Note `post:media_optional` (line 437) uses `min(staged.count, cells.count)` and is correctly a no-op when empty — `post:upload` is the outlier. Grok independently reached the same line by a different route (via the orchestrator fabricating a `/local/media/${contentId}` path that never exists, `orchestrator.ts:443`).

*Verified:* both the `max(staged.count, 1)` bound and the `existsSync` filter confirmed verbatim.

**Fix:** in `sendCommand`, **throw** when a supplied `mediaRef`/slide does not exist — a missing asset is a hard error, not an optional. On device, `guard !staged.isEmpty else { throw … "post:upload received no staged media" }` and change the bound to `min(staged.count, cells.count)`. Also stop fabricating `/local/media/...` in `orchestrator.ts:443`.

---

**#3 · Resumed session replays frozen engagement steps, bypassing every gate** ✅
`packages/core/src/orchestrator.ts:555` · correctness · **single-source (Opus CLI)** · *verified*

`continueSession` computes a fresh allowance at line 552, then uses `s.plannedSteps ?? …` at line 555 — the recomputed allowance is only applied inside `if (!s.plannedSteps)`. Any session whose frozen script contains `like`/`follow` keeps those steps forever. `executeSteps` re-checks only generic `safetyCapStatus`; there is **no per-step engagement re-check anywhere**. So a session approved on day 1, checkpointed on a transport error, and resumed on day 2 executes its engagement steps with **no approved review for that day**. The same bypass applies if the operator runs `engagement configure --mode off`, if the cooldown is active, or if another session already consumed the daily cap. The frozen script wins over all four.

*Verified:* the `allowance` computation and the `if (!s.plannedSteps)` guard confirmed exactly as described.

**Fix:** on resume, recompute the allowance and **prune** the remaining script — drop `warmup:like`/`warmup:follow`/`pre_warmup:like`/`post_warmup:like` beyond the current allowance, persist the trimmed `plannedSteps` and refreshed `engagementPlan`/`engagementApprovalId`. Belt-and-braces: in `executeSteps`, re-evaluate `engagementAllowance` before dispatching any `like`/`follow` step.

---

**#4 · Pre-auth account hijacking via unverified signup** ✅
`apps/web/src/server.ts:426` · security · **single-source (Opus security)** · *verified*

`/api/signup` creates a password-backed account for **any** email with no verification (`createUser` does no ownership check). The victim later signs in with Google — line 265 finds the attacker's row by email and does **not** create a new user, dropping the victim into the attacker's account. Identical adoption at line 451 for magic link. The attacker retains a valid password and can call `/api/login` indefinitely, reading `/api/overview`, `/api/queue`, the victim's Cloud Drop media, and `/api/me`'s `licenseKey` — which is itself a **non-expiring** bearer credential for the runner API. Full cross-tenant compromise, no primitive needed beyond a signup form.

*Verified:* `/api/signup` has no verification step; the Google callback's `let user = s.state.users.find(c => c.email === email)` adopts any existing row.

**Fix:** mark `/api/signup` users `emailVerified: false` and refuse `/api/login` until verified. In both the Google callback and magic-request paths, when adopting an existing *unverified* password account, clear `passwordHash` (or set an unusable sentinel) and set `emailVerified: true` before issuing a token.

---

**#5 · `serve-api` exposes an unauthenticated mutation API with `Access-Control-Allow-Origin: *`** ✅
`apps/farm/src/cli.ts:1726` · security · **single-source (Opus CLI)** · *verified*

`res.setHeader("Access-Control-Allow-Origin", "*")` plus permissive preflight means `fetch("http://127.0.0.1:8787/api/run", {method:"POST"})` from **any origin** succeeds — no token, no `Origin` check, no CSRF token. `/api/run` executes a real posting/warmup cycle on physical iPhones. `/api/drop` queues arbitrary caption/media against arbitrary `accountIds` and only *reads* the bearer token for a `createdBy` label (`session?.userId ?? "anonymous"`) — **it never rejects a missing or invalid token.** `/api/accounts` and `/api/overview` leak the roster and license state. This is a drive-by "post attacker content to all my real social accounts" primitive: the operator merely has to visit a web page.

*Verified:* the wildcard CORS header and the `createdBy: session?.userId ?? "anonymous"` fall-through both confirmed.

**Fix:** require a valid bearer token on every non-`/health` route (reuse `parseSessionToken`, reject on failure). Replace `*` with an explicit allowlist or drop CORS entirely. Reject requests whose `Host` is not `127.0.0.1:<port>`/`localhost:<port>` to block DNS rebinding, and require a non-simple content type so preflight is mandatory.

---

**#6 · Runner health check cannot distinguish "busy" from "dead"; relaunch wipes the journal and replays engagement** ✅
`ios/HeissRunner/UITests/HeissRunnerUITests.swift:55` · `packages/device/src/runner-health.ts:132` · correctness · **single-source (Opus device)** · *verified*

The on-device drain loop is strictly single-threaded — `handle()` is called synchronously inside `while true` — so **while a session runs, no ping can ever be answered.** Any supervision pass landing during a long session sees `pingOk = false` → `planRunnerRepair` → `"relaunch"` → `stopAutomationRunner`, killing the job mid-gesture. The replacement host then deletes inbox, outbox, **and `Documents/journals/*`**. Chained with #12: minute-15 timeout → checkpoint at step 0 → next tick's supervision kills and relaunches → journals gone → retry sends `startIndex = 0` → `performWarmupSession` finds no prior journal, so `priorCompleted = 0` and **every scroll, like, and follow is replayed on a live account.** The journal-wipe comment defends against the wrong hazard: replaying a *command* is prevented by the inbox wipe alone; wiping the *journal* destroys the very idempotency key that makes a legitimate retry safe.

*Verified:* the startup wipe of `documents()/journals` confirmed at lines 62–66.

**Fix:** (a) do not delete `Documents/journals/` at startup — the `plannedSteps` equality check at line 502 is already the real guard; prune by age (>24h) instead. (b) Give the health check a busy signal: have the runner touch a heartbeat (or bump the journal `updatedAt`) each step, and treat "ping unanswered but journal touched within N seconds" as **busy** → repair action `"none"`.

---

**#7 · `serve-api` permanently wedges the daemon's serial command authority** ✅
`apps/farm/src/cli.ts:1718` · `apps/farm/src/command-authority.ts:15` · correctness · **single-source (Opus CLI)** · *verified*

`commandMutatesFarm` returns `true` for `serve-api` (it is not in the exclusion list), so it is forwarded to the controller socket. `startCommandAuthorityServer` wraps the spawn in `authority.run(...)` and awaits the child's `close`. But `serve-api` calls `server.listen()` — the handle keeps it alive indefinitely, so `close` never fires. `SerialCommandAuthority.tail` chains on that never-settling promise, so the daemon's `await authority.run(...)` never runs again. **No warmups, no posting, no cloud sync, no stale-session recovery, no notification** — a completely silent unattended halt, with the process still alive so launchd KeepAlive never restarts it. `daemon` has the same shape and is saved only by being explicitly excluded.

*Verified:* exclusion list confirmed as `daemon | runner | signing` — `serve-api` absent.

**Fix:** add `serve-api` (and any other non-terminating command) to the exclusion list. Independently, bound each spawned child with a timeout that kills it and releases the authority slot, so no single command can pin the queue.

---

**#8 · Unguarded, untimed cloud fetch hangs or aborts every tick** ✅
`apps/farm/src/cli.ts:903` · robustness · **single-source (Opus CLI)** · *verified*

Two compounding defects. (1) `cloudJson` calls `fetch` with **no `AbortSignal`/timeout**; Node's fetch has no default, so a black-holed TCP connection hangs forever — inside `authority.run(...)`, so the serial queue never drains, the process stays alive, and launchd will not restart it. (2) Even on fast failure, `syncCloudDrop` is awaited **unguarded** ahead of USB sync, runner supervision, and both `runOnce` calls — so any cloud 500, signature mismatch, media 404, or the `throw new Error("Cloud Drop has no matching local accounts…")` skips the whole farm cycle. That last one loops permanently: the web claim handler's 10-minute stale-reclaim window means an unmatched drop re-claims and re-throws every ~10 minutes forever.

*Verified:* daemon path `await syncCloudDrop(store, args)` is bare; the `run` command at `cli.ts:1035` wraps the identical call in `.catch(...)`. The omission is an oversight, not a design.

**Fix:** give `cloudJson` an `AbortSignal.timeout(~20_000)`. Wrap the daemon's `syncCloudDrop` in `.catch()` exactly as `run` does. Make "no matching local accounts" release the remote claim rather than throw, and add a consecutive-failure counter that raises a notification.

---

### HIGH

---

**#9 · Transport/runner failures never escalate — infinite 60s retry, never reaches a human** ✅
`packages/core/src/orchestrator.ts:968` · robustness · **single-source (Opus core)** · *verified*

`classifyFailure` sets `incrementSocialRetry: false` for both `transport` and `runner`, so `retryCount` stays `undefined` permanently and `escalate`'s `(undefined ?? 0) >= 6` is never true. `transportRetryCount` *is* incremented but is **read nowhere in the codebase**. A dead USB cable or an un-relaunchable runner produces an unbounded 60s retry loop that permanently blocks the account and never sets `requiresAttention`.

> **Note:** the existing test at `packages/core/test/checkpoint-orchestrator.test.ts:169-171` and `:190-192` **asserts `retryCount === undefined`** — the suite encodes this bug as correct behaviour. Fixing the code requires updating those assertions; do not treat their failure as a regression.

**Fix:** compute escalation from `Math.max(retryCount ?? 0, transportRetryCount ?? 0)`, or add a lower transport ceiling (~20 attempts ≈ 20 min). Apply exponential backoff to `transportRetryCount` instead of a flat 60s. Escalation must set `requiresAttention`.

---

**#10 · Autonomous-engagement gate increments on invalid approvals** ✅
`packages/core/src/orchestrator.ts:945` · correctness · **single-source (Opus CLI)** · *verified*

`completeEngagementSession` checks `approval.status === "approved"` only to decide whether to mark it `consumed`. The `successfulReviewedSessions += 1` bump sits **outside** that check, guarded solely by `if (session.engagementApprovalId)` and `executed > 0`. Combined with #3, a session approved on day 1 and completed on day 2 with an **expired** approval still credits a "successful reviewed session". Three such cycles satisfy `engagementAutonomousEligible`, after which full daily caps are granted with **no dated approval at all**. The README's "autonomous mode requires three successful reviewed sessions" is enforced by a counter that increments without a valid review.

*Verified:* the `if (executed > 0)` block sits outside the `if (approval && approval.status === "approved")` block — confirmed verbatim.

**Fix:** move the increment **inside** the `approval && approval.status === "approved"` branch, and additionally assert `approval.localDay === calendarDay(now, timeZone)`.

---

**#11 · Assisted candidate path ignores engagement policy entirely and is invisible to cap accounting**
`apps/farm/src/cli.ts:1512` · correctness · **single-source (Opus CLI)**

`candidates complete` mutates `approval.status`, pushes an `EngagementTargetRecord`, and logs `kind: "candidate_completed"`. But `engagementAllowance` counts usage by filtering for `kind === "engagement"` with `meta.outcome === "executed"`, and gates cooldown on `kind === "engagement_session_completed"` — **neither kind is ever emitted by this path.** So an account can complete unbounded assisted likes/follows in a day *and still* receive its full automated daily cap, with the cooldown clock never starting. `candidates approve` imposes no per-day ceiling either. Note `store.ts:160-161` calls candidate approvals "the only write path" — so this is not a marginal path.

**Fix:** in `candidates approve`, call `engagementAllowance` and refuse when the remaining allowance is zero. In `candidates complete`, push an `engagement` event with `meta: { action, outcome: "executed", localDay, targetKey }` **and** an `engagement_session_completed` event, so both the daily counter and the cooldown observe assisted actions.

---

**#12 · Session transport timeout discards all progress the phone actually made**
`packages/device/src/ios-transport.ts:328` · robustness · **CONSENSUS (Opus device + Grok)**

`runScriptSession` produces a `DeviceSessionError` carrying `completedSteps` only on the *answered* failure path. Every unanswered path — the 15-minute poll deadline, a mid-session USB unplug, a phone lock, a CoreDevice stall — throws a **bare `Error`**. `batchCompletedSteps` finds no `completedSteps` and returns `0`, so `applyBatchedProgress` is never called. Meanwhile the runner keeps executing the frozen plan to completion. A 12-step plan reaching step 9 (2 likes, 1 follow already performed) checkpoints at **step 0**; the engaged target keys never enter `engagementTargets`, so the duplicate-target denylist misses them on retry. Both the safety-cap counters and the denylist are under-counted by exactly the work that really happened.

**Fix:** make the timeout path structurally identical to the failure path — do a final `copyFromDevice` of the journal before throwing, and throw a `DeviceSessionError(..., "transport", journalCompletedSteps, undefined, journalStepDetails)`. Track the highest `completedSteps` seen by the journal poller and use it as a floor.

---

**#13 · Daily caps enforced by substring-matching free-form text from a separately-versioned binary**
`packages/core/src/orchestrator.ts:901` · correctness · **single-source (Opus core)**

`recordEngagementOutcome` classifies an outcome as executed only via `detail.includes("engagement:executed")`, and `engagementAllowance` counts only `meta.outcome === "executed"` against the caps. On the batched path this is fed by `details?.[index] ?? ""`. **If a runner build omits `stepDetails`, or a version change alters the token, every like performed on-device is recorded `unconfirmed`, `likesUsed` stays 0, and each subsequent session is granted the full daily cap again.** A cap bypass on real accounts, driven by string formatting in a separately-versioned Swift binary — and it **fails open**, which is the wrong direction.

**Fix:** have the runner return a typed per-step outcome (`{action, outcome, targetKey}`) in the protocol rather than prose. Treat a *missing or unparseable* outcome for a like/follow step as `executed` (fail-**closed**) for cap accounting.

---

**#14 · `requireHumanEngagement` — the documented master safety switch — is read by nothing** ✅
`packages/core/src/types.ts:281`, `store.ts:78`, `store.ts:132` · correctness · **CONSENSUS (Opus CLI + Grok)** · *verified*

Declared with the comment "Likes/follows and other engagement are omitted unless a human enables them", initialised in `emptyState`, forward-filled on load — and **never read**. An operator who sets it to `false`, or who trusts it being `true`, gets no behavioural change either way. A safety control that exists only as a comment, in a system whose README markets exactly this guarantee.

*Verified:* repo-wide grep returns only the two writes, the type declaration, and the compiled `dist/` copy. **Zero readers.**

**Fix:** either delete the field, or wire it — have `engagementAllowance` return `{likes: 0, follows: 0}` when it is set unless the policy is `review` with a same-day approved approval, and have `candidates approve` refuse when it is set and no human decision is recorded.

---

**#15 · Cross-account target dedup not enforced on the approval path**
`packages/core/src/candidates.ts:100` · correctness · **single-source (Opus CLI)**

`activeBlockedTargetKeys` builds a *global* cross-account denylist that the orchestrator ships to the device, so the automated path refuses a target any owned account already engaged. `approveCandidate` implements no such check — `duplicateContent` only rejects a matching `screenKey` across groups, and `screenKey` is `"unknown"` whenever the runner omits it, disabling even that. The completion dedup is scoped `accountId + targetKey + action`, so each persona gets its own record for the same target. **Three personas on one iPhone can all follow the same account** — an obvious coordinated-engagement ban signal. `recordDiscoveryCandidates` already *knows* about cross-persona overlap (it applies a −20 relevance penalty) but still records the candidate as approvable.

**Fix:** in `approveCandidate`, reject when any non-`skipped`/`expired`/`failed` approval or `EngagementTargetRecord` within `TARGET_DEDUPLICATION_DAYS` already covers this `targetKey` under a *different* `groupId`.

---

**#16 · Forwarding timeout causes double execution of the same mutation**
`apps/farm/src/command-authority.ts:47` · correctness · **single-source (Opus CLI)**

On the 10-minute timeout, `forwardToController` destroys the socket and resolves `{ forwarded: false }`. The caller then executes the same mutation **locally — while the controller is still executing it** (the child is never killed). A `drop`, `candidates complete`, `add-account-set`, or `engagement approve` therefore runs twice. The revision check only catches straddling writes; sequential completion produces two content items / two target records / two approvals with no conflict raised. Same fall-through on socket `error` and unparseable output, where the command may have fully succeeded remotely.

**Fix:** distinguish "could not connect" (safe to run locally) from "connected but no reply" (must not). Return a distinct outcome for timeout/parse-failure and exit non-zero with "controller is busy; the command may already be running — re-check state before retrying."

---

**#17 · Checkpoint dedup groups by `accountId` only, stranding queue items permanently**
`packages/core/src/orchestrator.ts:265` · correctness · **single-source (Opus core)**

Every checkpointed session for an account is grouped, sorted by `stepIndex`, and all but the highest are force-`failed` — regardless of `kind`, `queueItemId`, or age. A post session checkpointed at step 3 loses to an unrelated warmup at step 12 and is killed. Its queue item is left `assigned` with `assignedAccountId` set; `findClaimableForAccount` accepts only `queued` or `stored_local && !assignedAccountId`, so it is **never claimable again**; `markFailed` is dead code; and the CLI refuses to cancel it ("Cannot cancel content in assigned status"). **The content is unrecoverable without hand-editing `farm.json`.** Reachable whenever a mutating CLI command falls back to local execution (#16).

**Fix:** key dedup on `${accountId}:${kind}:${queueItemId ?? ""}`. When retiring a post session, release its content lock and reset the queue item to `stored_local` with `assignedAccountId: undefined` (guarded by `postedAccountIds`). Add a reconciliation pass that un-assigns items whose owning session is failed or absent.

---

**#18 · X post continuation trusts an in-memory variable as proof of posting identity**
`ios/HeissRunner/UITests/HeissRunnerUITests.swift:233` · correctness · **single-source (Opus device)**

For `post:caption`, `post:media_optional`, and `post:publish` on X, the branch that calls `ensureAccountVerified` is **not** taken. The only guards are `activeHandles["x"] == command["handle"]` — an in-memory dictionary on the XCTestCase — and "some text view exists". Neither reads anything on screen identifying the posting account. `activeHandles` is never invalidated when X switches identity on its own (session expiry, push deep link, restored multi-account state). The composer's own account avatar is never checked. **Failure mode: publishing queued content under the wrong X handle, returning `ok: true`.**

**Fix:** before `post:publish` on X, require on-screen evidence via the existing `screenContainsExactHandleUsingOCR`, throwing `account_mismatch` when absent. Clear `activeHandles[platform]` on every app terminate/relaunch.

---

**#19 · TikTok/Instagram post flow destroys its own composer between steps**
`ios/HeissRunner/UITests/HeissRunnerUITests.swift:174` · correctness · **single-source (Opus device)**

The post script is four separate commands, and only X gets the stateful exemption. For TikTok, `post:upload` leaves the app on the caption screen; the next command hits `app.terminate()`, relaunches, and runs `ensureAccountVerified` — which navigates to Profile then taps Home. **The draft is gone before `typeText` runs.** Instagram is not terminated but still gets the full verification walk, which likewise dismantles the composer. Best case it fails every time; worse, `post:caption` finds *some* text field on the feed and types the caption into it, and `post:publish` matches a `CONTAINS[c] "Post" OR "Share"` button somewhere unrelated and taps it.

**Fix:** extend the stateful-continuation concept beyond X — suppress terminate and the full verification walk for post steps once `post:upload` succeeds, replacing them with a cheap composer + handle assertion. Alternatively make the whole post flow a single batched command like `warmup:session`.

---

**#20 · `installAppOnDevice` has no error handler and no timeout — wedges the daemon forever**
`packages/device/src/runner-install.ts:222` · robustness · **single-source (Opus device)**

The promise settles only from `child.on("close")`. There is **no `child.on("error")`**, so an ENOENT (Xcode CLI tools relocated or mid-upgrade, `xcrun` off PATH under launchd) makes the child emit `error` with no listener — the promise never settles and Node raises an uncaught exception. No timer either, so a stalled `devicectl install` hangs indefinitely. On the autonomous path twice (`renewExpiringRunners`, `ensureAutomationRunner`'s reinstall). Because each tick is wrapped in `authority.run(...)`, one wedged install stops **every** device's scheduling, silently. Contrast `copyWithTimeout` and `runJson`, which both handle this correctly — this is the one spawn site that does not.

**Fix:** add `child.on("error", reject)` and a `setTimeout` that SIGKILLs and rejects, using the same `settled` guard as `copyWithTimeout`. Add a per-tick watchdog as defence in depth.

---

**#21 · `runner install` mutates the store but bypasses controller forwarding**
`apps/farm/src/command-authority.ts:15` · correctness · **single-source (Opus CLI)** ✅ *verified*

`commandMutatesFarm` returns `false` for the whole `runner` family, so `runner install` executes in-process without serialization. The handler runs a multi-minute `xcodebuild`, *then* opens the store and pushes a device. During that window the daemon has ticked dozens of times and bumped `revision`, so `save()` throws `StoreConflictError` and **the device registration is discarded after a successful, expensive install.** `runner status`/`stop`/`ensure` are genuinely read-only, so the blanket family exclusion is the bug.

**Fix:** make `commandMutatesFarm` sub-command specific — exclude `runner status|ensure|stop`, forward `runner install`. Call `openStore` immediately before the write and retry once on `StoreConflictError`.

---

**#22 · Plan quotas validated per-request, never against resulting state**
`apps/web/src/server.ts:294` · security · **single-source (Opus security)**

`assertWithinPlan(plan, incomingDevices.length, incomingAccounts.length)` checks the **batch**, not the resulting stored state, and the purge deliberately keeps every row with a `sourceId` — i.e. every previously synced account. A Free-plan holder syncs 32 accounts as `a1..a32`, then 32 more as `b1..b32`; each call passes, and 64 persist. The check is server-side but the attacker controls the client entirely, which is exactly the threat it exists to stop. Also unbounded state growth in a single JSON file.

**Fix:** compute post-merge totals and assert on those before any mutation; or make sync a true replace by deleting all rows for `user.id` prior to the upsert loop.

---

**#23 · `HEISS_DEV_MAGIC_LINKS=1` returns a live sign-in token in the HTTP response** ✅
`apps/web/src/server.ts:487` · security · **single-source (Opus security)** · *verified*

The endpoint emits `{ devLink, devToken }` in the `/api/magic/request` body, and `/api/auth/providers` even advertises it. Anyone who can POST `{"email":"victim@corp.com"}` gets a token exchangeable for a 7-day session — **total takeover of every account on the instance, no email delivery needed.** The only startup guard checks `HEISS_SESSION_SECRET` length and says nothing about this flag. `.env.example` does not list it, so its danger is undocumented.

*Verified:* the conditional spread emitting `devLink`/`devToken` confirmed.

**Fix:** throw at startup when `NODE_ENV === "production" && HEISS_DEV_MAGIC_LINKS === "1"`. Gate the emission on `HOST` being loopback. Document the flag in `.env.example` with a warning.

---

**#24 · OAuth `state` signed with a hardcoded secret that ships in the source**
`apps/web/src/server.ts:125` · security · **CONSENSUS (Opus security + Grok)**

`googleState()` and `verifyGoogleState()` both fall back to the literal `"heiss-development-session-secret"`. The startup guard fires only when `NODE_ENV === "production"` **exactly** — a deploy under `NODE_ENV=prod`, under a supervisor that does not set it, or any staging instance has a *publicly known* state-signing key. An attacker mints a valid `state`, starts a Google flow with their own account, and delivers the callback to a victim; the CSRF defence passes and the victim is silently logged into the **attacker's** account, after which every clip they upload lands in attacker-owned storage. Note `packages/core/src/auth.ts:5` handles the same missing-env case correctly with `randomBytes(32)` — the two modules disagree.

**Fix:** delete the literal from both call sites; resolve the secret through one shared helper that throws when absent and `googleConfigured()` is true. Broaden the guard to fire unless `NODE_ENV` is explicitly `development`/`test` (fail closed).

---

**#25 · Cloud Drop 10-minute stale-reclaim permits cross-machine double-post** ✅
`apps/web/src/server.ts:361` · correctness · **CONSENSUS (Grok + Opus CLI)** · *verified*

Claim accepts `status === "claimed"` whose `claimedAt` is older than 10 minutes. A real post cycle (pre-warmup + upload + publish) routinely exceeds that. A second Mac re-claims the same item, downloads the media, and enqueues locally — `cli.ts:232` only skips if `remoteQueueId` already exists **on that machine** — and can publish again before `/api/runner/complete` marks it posted.

> **Layer note:** the *local* double-post protocol is sound (see Verified Clean) — `publishAttempted`, `postedAccountIds`, and `ensureNotDoublePost` are mutually redundant and one auditor could not defeat them. Those guards are **per-machine**, so they do not protect against this hosted-layer reclaim. Both auditors are right about different layers.

**Fix:** do not auto-reclaim on wall-clock age alone. Use explicit lease tokens with a claiming-runner heartbeat, or a much longer lease plus `claimedBy` ownership checks. Refuse complete/post if remote `postedAccountIds` already contains the target.

---

**#26 · Unbounded `readBody` on unauthenticated endpoints**
`apps/web/src/server.ts:65` · robustness · **CONSENSUS (Opus security + Grok)**

`readBody` accumulates chunks with no byte limit and no `Content-Length` rejection. `/api/billing/webhook` and `/api/signup` call it **before any authentication**. A single unauthenticated multi-gigabyte POST OOM-kills the dashboard for every tenant. `/api/uploads` got this right via `streamUpload` with `maxBytes`, so the gap is inconsistent rather than intentional.

**Fix:** give `readBody` a `maxBytes` parameter (~1 MB default, higher for `/api/runner/sync`); reject early on `Content-Length` and destroy the socket with a 413 once accumulated length exceeds it.

---

**#27 · Unauthenticated controller Unix socket accepts arbitrary local commands**
`apps/farm/src/command-authority.ts:69,103` · security · **CONSENSUS (Opus security + Grok)**

`server.listen(socketPath)` creates `~/.heiss/controller.sock` under the process umask, and the handler spawns the CLI with `HEISS_AUTHORIZED_MUTATION=1` for any client sending `{ args }`. No peer credential check, no shared secret, no SO_PEERCRED gate. Any local process — a sandboxed helper, another user on a shared Mac, a malicious npm postinstall — can run `safety resume`, change engagement, drop content, or drive device work, **completely bypassing the authority gate**. Secondarily, `args` is never validated: `{"args": null}` throws inside `authority.run`, the rejection is swallowed, `socket.end` is never called, and the client hangs for the full 10-minute timeout.

**Fix:** `chmodSync(socketPath, 0o600)` immediately after `listen` (and `chmodSync(dataDir, 0o700)`); verify peer UID; reject unless `Array.isArray(args) && args.every(a => typeof a === "string")`; wrap `authority.run` in try/finally that always writes a response.

---

**#28 · Farm state and signing config written world-readable**
`packages/core/src/store.ts:254`, `packages/device/src/signing.ts:54` · security · **single-source (Grok)**

`JsonStore.save` and `saveSigningConfig` use default `writeFileSync` modes — mode 0644 on this host. `farm.json` holds `license.key`, SOCKS proxy passwords, and account handles/emails; `signing.json` holds team IDs and ASC `.p8` paths. Any local account that can read the home directory can steal cloud license authority and network credentials.

**Fix:** write with mode `0o600` and `mkdir` the data dir `0o700`; chmod existing files on load. Prefer the keychain for proxy passwords.

---

**#29 · Activity log grows unbounded; safety-cap check is O(n) with a fresh `Intl` per event**
`packages/core/src/orchestrator.ts:1051` · efficiency · **3-WAY CONSENSUS (Opus core + Opus CLI + Grok)**

The strongest consensus in the report. `safetyCapStatus` and `hasActionCapacity` both filter the **entire** `state.activity` array, calling `calendarDay` on every event — and `calendarDay` constructs a **new `Intl.DateTimeFormat`** per call, one of the most expensive allocations in Node. It runs once **per step**. Nothing ever prunes `state.activity`. Every step also appends 2–3 events and calls `store.save()`, which re-reads and re-serializes the whole file with `JSON.stringify(state, null, 2)`. After weeks of unattended operation the array is in the tens of thousands, so each step performs tens of thousands of `Intl` constructions twice over plus two multi-megabyte JSON traversals. **Growth is quadratic in farm age**, on a KeepAlive daemon with nobody watching CPU. Per #12 this also inflates session wall-clock toward the 15-minute deadline — the efficiency bug manufactures the correctness bug.

**Fix:** cache one `Intl.DateTimeFormat` per timezone in a module-level `Map`. Maintain an incrementally-updated per-day action counter in `settings` instead of rescanning. Prune `activity` to a bounded retention window (≥ the 30-day `TARGET_DEDUPLICATION_DAYS`). Drop `null, 2` from the persisted state.

---

### MEDIUM

| # | Issue | Where | Flagged by |
| --- | --- | --- | --- |
| 30 | `store.save()` throws `StoreConflictError` mid-session; no try/finally, so `disconnect` and `releaseLocks` never run and locks stay held for 30 min | `orchestrator.ts:777` | Opus core |
| 31 | `checkpointStaleRunningSessions` releases locks on wall-clock age with **no PID check**, while batched sessions emit no heartbeat — can release a lock while the phone is actively driven | `orchestrator.ts:1113` | Opus core |
| 32 | `verifyPreflight` checks `isDeviceLocked` then connects **without acquiring the lock** — TOCTOU letting canary and farm session share one phone | `orchestrator.ts:176` | Opus core |
| 33 | `continueSession` **throws** when a session's account was deleted, wedging every subsequent tick permanently | `orchestrator.ts:519` | Opus core |
| 34 | Engagement cooldown never armed when a session executes engagement then fails — `engagement_session_completed` only fires on the success path | `orchestrator.ts:936` | Opus CLI |
| 35 | Post slots matched by **exact `HH:mm` string equality** with no catch-up window — a slot minute the daemon is busy is silently skipped for the whole day (warmups use `>=` and do have catch-up; posts do not) | `schedule.ts:42` | Opus core |
| 36 | Billing webhook has correct HMAC but **no replay/idempotency protection and no event allowlist** — any captured body re-grants a plan forever; plan set on *any* event carrying a known `variant_id` | `server.ts:560` | **CONSENSUS** (Opus security + Grok) |
| 37 | Abandoned command stays in the device inbox after timeout, never cancelled; `contentsOfDirectory` has no defined order, so stale commands can interleave with a *different account's* | `ios-transport.ts:327` | Opus device |
| 38 | `"approved" → "ready"` transition is **unreachable dead code** — nothing ever assigns `"approved"`, so `executeLocalDay` gates nothing and the "actions ready" notification can never fire | `candidates.ts:126` | Opus CLI |
| 39 | `getArg` treats "flag present, value missing" as absent and consumes the **next flag** as a value — `daemon --data` silently runs against a different farm; `--caption --accounts a` posts the literal `"--accounts"` | `cli.ts:145` | Opus CLI |
| 40 | Automation LaunchAgent is `KeepAlive` + `ThrottleInterval 15` with **no failure ceiling** — an expired cert respawns `xcodebuild` every 15s forever, appending ~5,760×/day to one never-rotated log | `runner-install.ts:408` | Opus device |
| 41 | TikTok search fires **four blind coordinate gestures** (incl. a 1.2s long-press) without confirming search opened, and reports success regardless — same class as the two recently fixed TikTok bugs | `HeissRunnerUITests.swift:1157` | Opus device |
| 42 | `tap`/`swipe`/`screenshot` skip the protocol/build check that session commands enforce; `tap` resolves successfully on **any** JSON reply, including `executed: false` | `ios-transport.ts:85` | Opus device |
| 43 | `runner-installs.json` parsed with unguarded `JSON.parse` in 3 places — one truncated write permanently breaks install, detection, **and** cert-expiry renewal | `runner-install.ts:354` | Opus device |
| 44 | `reinstall` branch returns `{ ok: true }` without verifying the runner answers, unlike the `relaunch` branch above it | `runner-health.ts:175` | Opus device |
| 45 | Catch-all handler reflects raw internal errors to unauthenticated clients — leaks absolute filesystem paths and upstream provider state; mislabels every 5xx as 400 | `server.ts:733` | Opus security |
| 46 | No rate limiting anywhere — unmetered password login (6-char minimum), magic-link as an email-bombing relay, license-key brute force, and **synchronous scrypt** on the event loop as a CPU DoS | `server.ts:503` | Opus security |
| 47 | Sessions cannot be revoked (no logout, no invalidation on password change) and `/api/me` discloses the **non-expiring** `licenseKey` — a momentary session compromise yields permanent runner-API access | `server.ts:536` | Opus security |
| 48 | Container runs the multi-tenant web service as **root** with no `USER` directive; the `node:22-alpine` base already provides a `node` user | `Dockerfile:18` | Opus security |
| 49 | Hosted web holds one long-lived `JsonStore` with no per-request concurrency control — concurrent handlers interleave on the same in-memory object | `server.ts:177` | Grok |
| 50 | Each 30s tick builds **two** production transports and connect/disconnect cycles against the same iPhone, plus 3 unconditional cloud POSTs (~8,600/day) shipping full arrays to discover a drop that arrives a few times a week | `cli.ts:963` | Opus CLI |
| 51 | Every warmup step pays 3–5 full-screen `.accurate` Vision OCR passes; `detectPlatformState` already accepts a shared `observations` param but no caller threads one through | `HeissRunnerUITests.swift:570` | Opus device |
| 52 | `apps/desktop/main.cjs` claims to parse the "last JSON object" but slices from the **first** `{` — every CLI response preceded by a progress line is discarded, and the catch reports `ok: true` with no data | `main.cjs:50` | Opus CLI |
| 53 | `startDaemon` duplicates `installControllerAgent`'s launchctl logic but **omits the bootout-completion wait** added specifically to fix a launchd race — intermittent failure in the primary GUI path | `main.cjs:77` | Opus CLI |
| 54 | `normalizeAllowance(true)` maps to `MAX_SAFE_INTEGER` likes/follows; `postCycleScript`/`warmupOnlyScript` still default `engagement = true` | `lifecycle.ts:172` | Grok |
| 55 | Batched warmup re-verifies account identity before `follow` but **not** before `like` | `HeissRunnerUITests.swift:576` | Grok |
| 56 | Like/follow fall back to **hard-coded coordinates** when no matching button is found — can engage a different element than the OCR-verified handle while reporting `engagement:executed` | `HeissRunnerUITests.swift:829` | Grok |

### LOW

| # | Issue | Where | Flagged by |
| --- | --- | --- | --- |
| 57 | `checkpointSession`/`resumeSession` overwrite `updatedAt` with the real clock, discarding injected `opts.now` — and `checkpointStaleRunningSessions` makes lock-release decisions from that field | `checkpoint.ts:61` | Opus core |
| 58 | Success-path `driver.disconnect` is the **only** disconnect not wrapped in `.catch()` — a flaky teardown truncates the rest of the tick | `orchestrator.ts:827` | Opus core |
| 59 | Device-supplied `result.screenshot` interpolated into a remote path without `basename()`, while the adjacent local path and `screenshot()` both do it correctly | `ios-transport.ts:150` | Opus device |
| 60 | `.gitignore` lists only `.env`/`.env.local` while `.dockerignore` correctly uses `.env*` — a `.env.production` holding every secret is tracked by default | `.gitignore:11` | Opus security |
| 61 | UI-layout profiles signed with the user's **own license key** (which the client already holds), with no timestamp or revision binding — forgeable and replayable to pin a farm to stale tap coordinates | `server.ts:351` | Opus security |
| 62 | `ControlServer.swift` is dead in production (the transport addresses the `.xctrunner` container) and exists in **two divergent copies**, one embedded as a string literal in the TS installer | `ControlServer.swift:21` | Opus device |
| 63 | Brace-less `if` with two statements on one line in `proxies unassign` — the classic goto-fail shape on a state-consistency path (behaviour is currently correct) | `cli.ts:702` | Opus CLI |
| 64 | `dailyLikeCap` hard max of 5/account/day with no **farm-wide** engagement ceiling across accounts | `engagement.ts:42` | Grok |

---

## Verified clean

Areas probed hard by multiple auditors and found sound. This is not "not yet examined" — these were attacked and held.

- **Double-post prevention (local layer).** The two-phase publish guard is genuinely correct: `checkpoint.publishAttempted` is persisted *before* the publish command is sent, so a crash between send and acknowledgement resumes into `post:verify_published` rather than tapping publish twice. `ensureNotDoublePost` is called both at claim time and again immediately before `markPosted`; `postedAccountIds` and the content lock are mutually redundant rather than merely duplicative. One auditor explicitly tried to construct a replay that re-publishes **and could not.** (Finding #25 concerns the *hosted* reclaim layer, which these per-machine guards do not cover.)
- **Fan-out exactly-once.** `markPosted` correctly returns the item to `stored_local` with `assignedAccountId` cleared when targets remain; `findClaimableForAccount` excludes accounts already in `postedAccountIds`. A three-account drop delivers once per account.
- **Timezone / DST.** `zonedParts` uses `Intl` with `hourCycle: "h23"` and a real IANA zone. Spring-forward verified (a 02:30 warmup on a day when 02:30 does not exist still fires, via `>=` on elapsed local minutes) and fall-back verified (the repeated 01:30 hour is idempotent via the `lastWarmupAt` same-day guard). `addUtcDay` anchors at T12:00Z, safe for all real offsets.
- **Crash recovery of a dead controller's locks.** `JsonStore.load` identifies `running` sessions with a dead `ownerPid`, demotes them, and deletes **exactly** the lock entries whose holder is in that orphan set — leaving live holders intact. A blanket `locks.clear()` would have been the obvious bug and it is not there.
- **Store durability.** PID+timestamp-scoped temp file, atomic `renameSync`, `finally` cleanup, optimistic `revision` check. The mechanism is correct; finding #30 is about error *handling*, not the primitive.
- **Path traversal in Cloud Drop.** `userUploadPath` does `resolve()` then `startsWith(root + "/")` — the trailing slash defeats `uploads/a` vs `uploads/ab` confusion, and `resolve` normalizes `..` first. Every read, delete, and drop-acceptance routes through it. The `kind:"text"` branch that skips media validation was specifically probed: the unvalidated ref is inert because downstream paths still filter. Upload filenames are `basename`d, character-filtered, UUID-prefixed, and written with `flags:"wx"`.
- **Shell / argument injection.** Every child process across `packages/device` and `apps/farm` uses `execFile`/`spawn`/`spawnSync` with an argv array — no `shell: true`, no string concatenation, anywhere. UDIDs flowing from `devicectl` output into argv positions cannot break out. `automationRunnerLabel` additionally scrubs the UDID before it becomes a launchd label, and both plist generators XML-escape. `notifyDesktop`'s AppleScript is `execFile` with the script as one argv element, plus quote/backslash stripping.
- **Cross-tenant read isolation.** `farmForUser` filters by `ownerId` throughout; runner endpoints independently re-check `ownerId === user.id` on every lookup; sync rows are namespaced `${user.id}:${id}`, making cross-tenant id collision structurally impossible. Mass assignment is prevented — the object spreads set `id`/`ownerId`/`sourceId` **after** the spread.
- **Session and magic-link cryptography.** 128-bit nonce, HMAC-SHA256, length-checked `timingSafeEqual`; magic tokens 256-bit, stored only as SHA-256, single-use via `usedAt`, 15-minute expiry, expired rows swept on each issue. The OAuth handoff correctly uses a one-time magic token rather than a session token in a redirect URL.
- **Journal-based session idempotency (mechanism).** `performWarmupSession` refuses to trust a journal whose `plannedSteps` differ, takes `max(requestedStart, priorCompleted)` so neither side moves the checkpoint backwards, and short-circuits to `recovered` when already complete. A lost *acknowledgement* is correctly non-replaying. Finding #6 is about the journal being **deleted out from under** this mechanism, not the mechanism.
- **Protocol negotiation.** Constants match exactly in both directions; each side rejects mismatches. The distinction between `protocolMismatch` (→ rebuild) and mere delivery failure (→ relaunch, not an expensive rebuild) is a correct and non-obvious call.
- **On-device engagement guards.** `performGuardedEngagement` is fail-closed where it counts: refuses to act unless exactly one non-actor handle is visible, skips owned handles, honours both the blocked-target denylist and the per-session engaged set, and short-circuits already-liked/already-following. `textContainsExactHandle` correctly refuses to let an email local part satisfy a handle match. **This layer is the reason findings #6/#12 produce duplicate engagement rather than engagement with the wrong party.**
- **Owned-account exclusion (end to end).** Filtered at discovery with platform-aware normalisation (X's 15-char/underscore rule included), shipped on every device context, and re-checked on-device returning `engagement:skipped_owned`. Three independent layers, all consistent.
- **Loop termination in the Swift automation.** All 2252 lines were checked for the class of bug the recent TikTok fixes addressed. Every loop is bounded — tutorial/prompt dismissals (3, 2, 3), settle loops (35s wall-clock), drawer/verify loops (3), YouTube navigation (15s deadlines), OCR waits (explicit timeouts). Each throws or returns at the bound rather than spinning. The `while true` at line 75 is the intended server loop; its 12-hour recycle is *soft* (exits only when the inbox is empty), which is the correct priority ordering.
- **`copyWithTimeout` process hygiene.** `settled` guard, `clearTimeout` on every exit, SIGKILL on deadline, both `error` and `close` handled, stderr captured. This is the model the rest of the codebase should follow — finding #20 is specifically the one site that departs from it.
- **Signing-config resolution.** A corrupt `signing.json` is treated as unset rather than fatal; a stale `HEISS_ASC_KEY_PATH` does not hijack a working Xcode path. No key material is interpolated into `xcodebuild` args, and the build-failure handler greps for `error:` lines rather than dumping the log, so key contents cannot leak into a thrown message.
- **Launchd job lifecycle.** `launchAutomationRunner` boots out the old job, polls up to 10s for it to disappear before bootstrapping the same label, and rotates the log so readiness cannot read a previous launch's marker.
- **Engagement policy normalisation and autonomous unreachability.** `bounded` correctly clamps (likes 0–5, follows 0–2, cooldown 60–10080) with `Number.isFinite` rejecting `NaN`. Defaults are `mode: "off"`, likes and follows disabled — the "off by default" claim holds for **every** creation path. `engagement configure` hard-rejects `--mode autonomous`, and `JsonStore.load` actively downgrades any persisted autonomous policy. Maturity gating is enforced at three independent points. *(Findings #3/#10 concern the counter's integrity and the resume path — not this policy logic, which is sound.)*
- **Approval expiry.** Prior-day approvals expire via lexicographic `localDay` comparison (correct for `YYYY-MM-DD`), and approve/reject refuses anything not currently `pending`.
- **Emergency stop and maintenance drain.** Both checked before any device action, with a correct `draining → active` transition gated on zero running sessions.
- **`findProjectRoot` / `stableNodePath`.** Correctly handles launchd's `/` cwd by searching both caller and module locations, and validates `HEISS_REPO_ROOT` actually contains `ios/HeissRunner` rather than trusting it. `stableNodePath` resolves through `realpathSync` to prefer `/opt/homebrew/bin/node` over a versioned Cellar path — exactly right for a launchd job that must survive Homebrew upgrades.
- **`data migrate`.** Refuses to overwrite without explicit `--replace`, validates the source, resolves both paths. A genuinely careful destructive-operation guard.
- **`assertWithinPlan` in `add-account-set`.** Unlike `add-account`, validates all four accounts against per-device capacity and plan limits **before** mutating anything — correctly atomic.
- **Webhook signature primitive.** HMAC over the *raw* body (not a re-serialized parse), `timingSafeEqual` after an explicit length check, 503 when the secret is unset rather than skipping verification. The shape is correct; only replay protection and the event allowlist are missing (#36).
- **`SerialCommandAuthority` primitive.** `this.tail.then(task, task)` correctly continues the chain after a rejected predecessor, and the assigned promise swallows both outcomes so one failure cannot poison the queue. Finding #7 is about non-terminating children, not this primitive.
- **Coordinate clamping.** `point(...)` clamps host-supplied `uiProfile` coordinates to `[0,1]`, so a corrupt or hostile profile cannot drive an out-of-bounds tap.

---

## Dropped during synthesis

- **"`normalizeAllowance(true)` grants unlimited engagement" as a live bug** (Grok). Retained at #54 as **medium/latent**, not high: every current orchestrator path passes a structured allowance, so the `MAX_SAFE_INTEGER` branch is unreachable today. It is a trap for future callers, not a present bypass.
- **"Autonomous mode is reachable"** — actively contradicted by two auditors. The CLI hard-rejects `--mode autonomous` and `JsonStore.load` downgrades any persisted autonomous policy. The *gate logic* is sound; what is broken is the counter feeding it (#10). Reported as the counter bug rather than as a mode bypass.
- **Codex's entire output** — audited the wrong repository (FEGOS). Discarded in full; nothing from it appears in this report.

---

## Suggested dispatch order

Items are written to be handed to `/codex-first`, `/grok-first`, or `/self-first` individually or in batches.

1. **Stop the bleeding on real accounts** — #2, #3, #10, #11, #15. These are the ones that get accounts banned. #2 and #3 are small, surgical diffs; do them first.
2. **Un-wedge the daemon** — #1, #7, #8, #9, #20. All five are silent-halt paths on an unattended process. #1 and #7 are one-line-ish; #9 needs the timeout plumbed into `cloudJson`.
3. **Close the web holes** — #4, #5, #23, #24, #26, #27. #5 and #23 are the fastest wins and among the highest impact.
4. **Transport and journal integrity** — #6, #12, #37. These interact; fix them as one batch, not piecemeal.
5. **Then** the medium efficiency/refactor tail, starting with #29 (3-way consensus, and it manufactures #12's timeout).

**Before dispatching #9:** update the assertions at `packages/core/test/checkpoint-orchestrator.test.ts:169-171` and `:190-192`, which currently encode the bug as expected behaviour.

**Recommended re-run:** after items 1–3 land, re-run `/red-team` — with a working Codex to restore the third model family, since this pass effectively had two.
