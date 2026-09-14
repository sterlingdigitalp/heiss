# Heiss

iPhone farm controller: **real USB iPhones only** (no simulator). It warms accounts, runs human-paced curated engagement on X, and can post Cloud Drop content to TikTok, Instagram, or X on a schedule. YouTube is warm-only.

## Packages

| Path | Role |
| --- | --- |
| `packages/core` | Lifecycle, queue, schedule, locks, checkpoints, orchestrator, JSON store |
| `packages/device` | USB detect, Xcode/ASC signing, HeissRunner install, runner health, real iOS driver |
| `ios/HeissRunner` | On-device XCTest runner (control channel) |
| `apps/farm` | `heiss-farm` CLI and persistent controller |
| `apps/web` | Marketing + Cloud Drop web UI |
| `apps/desktop` | **Heiss.app** Mac shell |
| `dist/Heiss.app` | Packaged app (after `npm run build -w @heiss/desktop`) |

## Quick start (physical iPhone)

```bash
npm install
npm test          # each package builds the workspace packages it imports first

# 1) Signing (Xcode free Apple ID — 7-day cert)
npm run farm -- signing set --team YOUR_TEAM_ID
# or ASC paid path:
# npm run farm -- signing set --asc-key ./AuthKey.p8 --key-id KEYID --issuer ISSUER_UUID --team TEAM

# 2) Plug in iPhone, unlock, Trust this computer, enable Developer Mode
npm run farm -- devices list
npm run farm -- setup status

# 3) Detect + install runner (build/sign/install HeissRunner)
npm run farm -- setup all --team YOUR_TEAM_ID
# Trust developer cert on phone: Settings → General → VPN & Device Management

# 4) Log in and finish each platform's onboarding manually, then:
npm run farm -- devices sync
npm run farm -- add-account <deviceId> x @you
npm run farm -- account preflight <accountId> ready
npm run farm -- preflight canary --accounts <accountId>

# 5) Run it persistently
npm run build
npm run farm -- daemon install

# Curated X engagement (dry run unless --live)
npm run farm -- targets add <xAccountId> @person --note "why this person"
npm run farm -- targets schedule <xAccountId> 09:30
npm run farm -- targets engage <xAccountId>

# Cloud Drop
npm run farm -- drop --accounts <accountId> --caption "hi" --media ./clip.mp4
```

Mutating commands are forwarded to the running controller so every change goes
through one serialized queue. After editing the CLI or packages, run
`npm run build` and restart the controller
(`launchctl kickstart -k gui/$(id -u)/so.heiss.controller`), or it keeps running
the old code.

## Heiss.app

```bash
npm run build -w @heiss/desktop   # → dist/Heiss.app
open dist/Heiss.app
# or dev:
npm run app
```

The app window can only send the CLI commands its own UI uses; everything else
is refused in the main process.

## CLI surface

`npm run farm -- --help` prints the complete list. The main groups:

| Command | Purpose |
| --- | --- |
| `setup status \| device \| all` | Remaining setup steps; register a USB iPhone; detect + build/sign/install runner |
| `runner install \| status \| ensure \| stop` | Build/install, health-check, self-heal, or stop the on-device runner |
| `daemon install \| uninstall \| status` | Persistent launchd controller |
| `signing show \| set` | Xcode team or ASC API key |
| `devices list \| sync \| rename` | USB iPhones via `devicectl` |
| `add-account` / `add-account-set` | Register accounts after you log in on the phone |
| `account preflight` | Mark manual onboarding pending/ready/attention |
| `preflight health \| canary \| verify-all \| x-composer` | Device/runner ladder; harmless exact-handle checks |
| `targets add \| list \| schedule \| scan \| engage \| pause \| resume \| remove` | Curated X engagement targets and per-persona timing |
| `warmup-schedule list \| set \| enable \| disable \| remove` | Daily warmup times |
| `add-slot` / `remove-slot` | Posting slots |
| `platforms focus \| resume` | Pause warmups/slots on every other platform |
| `candidates show \| approve \| reject \| assist \| complete \| skip` | Discovered like/follow candidates; each action needs an exact approval |
| `maintenance enter \| exit \| status` | Pause the scheduler (drains the current checkpoint first) |
| `safety stop \| resume` | Emergency stop |
| `settings show \| timezone \| caps` | Time zone and daily action caps |
| `run` / `start-warmups` | One farm tick on **real** devices |
| `drop` / `cancel` | Queue or cancel Cloud Drop content |

## Autonomous operation

`heiss-farm daemon install` registers a KeepAlive launchd agent that runs the
controller (a tick at most every 60s by default), survives crashes and reboots,
and needs no desktop app. Each tick the controller:

- keeps the on-device **XCTest automation runner** alive: pings it before due
  work, relaunches it from the last build, and rebuilds + reinstalls only when
  build products are missing or the protocol changed. Known failures are named
  (device locked, Developer Mode off, untrusted certificate, Xcode
  "No Accounts", phone storage full, phone unreachable, install failed). The
  ones only a person can fix stop the repair ladder and say exactly what to do.
- **re-signs the runner automatically** within 24h of provisioning expiry
  (7-day free Apple ID certs / ~1-year ASC). A build lock stops a manual
  `runner install` from colliding with the controller's own repair.
- runs due posting slots, scheduled warmups, and checkpointed session retries
  with per-device locks, safety caps, and exponential backoff. New scheduled
  sessions wait a varied 4–9 minute rest after the device's last scheduled work,
  so a late start spreads the backlog instead of chaining it.
- runs **curated X engagement**: at most one target per persona per local day,
  at that persona's own time. It follows during the first-meeting burst, then
  rotates to the least recently engaged target, likes the chosen post, and
  remembers it (as a fingerprint) so it does not re-open the same post.
- sends each account's full frozen warmup plan to the phone once and journals
  every completed gesture on-device. Transport loss resumes from that journal
  instead of replaying the session.
- never runs unattended candidate likes/follows: the `autonomous` engagement
  mode is retired, and discovered candidates need an exact approval. An account
  mismatch or unknown overlay pauses only that account and preserves a
  screenshot/checkpoint for manual cleanup.

`farm.json` saves are serialized across processes. If a forwarded command reaches
the controller but no result comes back, the CLI exits with code 75 instead of
running it a second time locally. Check `status` before retrying.

## Env

| Variable | Purpose |
| --- | --- |
| `HEISS_DATA` | Data directory (default `~/.heiss/live`) |
| `HEISS_TEAM_ID` | Xcode `DEVELOPMENT_TEAM` |
| `HEISS_ASC_KEY_PATH` | App Store Connect `.p8` |
| `HEISS_ASC_KEY_ID` | ASC key id |
| `HEISS_ASC_ISSUER_ID` | ASC issuer id |
| `HEISS_CLOUD_URL` | Hosted Cloud Drop dashboard origin used by the Mac controller |

## Hosted dashboard

The web dashboard is deployable as a persistent Docker service. It provides
passwordless sign-in, user-isolated Cloud Drop storage, license validation,
plan enforcement, checkout/webhook integration, and the Mac runner sync API.

> **Before deploying:** `docs/audit-2026-09-14.md` lists open findings in the
> hosted path (findings 6–12): unbounded request bodies and synchronous password
> hashing, dev magic-link tokens honoured in production, OAuth state not bound
> to the browser, Cloud Drop lease and shared-media bugs, sync limits, and
> webhook ordering. Never set `HEISS_DEV_MAGIC_LINKS` on a public deployment.

```bash
cp .env.example .env
# Fill HEISS_PUBLIC_URL, HEISS_SESSION_SECRET, email, and billing values.
docker build -t heiss-web .
docker run --env-file .env -p 3000:3000 -v heiss-data:/data heiss-web
```

Use a durable encrypted volume for `/data` and terminate TLS in front of the
container. After signing in, copy both the license key and dashboard URL into
Heiss.app. The controller then registers the real local farm, downloads queued
media, pulls signed UI-layout profiles, and reports each account delivery.

**No `HEISS_DRIVER=simulator`** — production path is iOS USB only.
