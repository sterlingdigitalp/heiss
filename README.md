# Heiss

Warmr-style iPhone farm controller: **real USB iPhones only** (no simulator). Warm accounts, Cloud Drop content, and auto-post TikTok, Instagram, or X on schedule. YouTube stays warm-only.

## Packages

| Path | Role |
| --- | --- |
| `packages/core` | Lifecycle, queue, schedule, locks, checkpoints, orchestrator |
| `packages/device` | USB detect, Xcode/ASC signing, HeissRunner install, real iOS driver |
| `ios/HeissRunner` | On-device runner app (control channel) |
| `apps/farm` | `heiss-farm` CLI |
| `apps/web` | Marketing + Cloud Drop web UI |
| `apps/desktop` | **Heiss.app** Mac shell |
| `dist/Heiss.app` | Packaged app (after `npm run build -w @heiss/desktop`) |

## Quick start (physical iPhone)

```bash
npm install
npm test

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
npm run farm -- add-account <deviceId> tiktok @you
npm run farm -- account preflight <accountId> ready
npm run farm -- preflight canary --accounts <accountId>
npm run farm -- start-warmups --time 09:00

# Cloud Drop
npm run farm -- drop --accounts <accountId> --caption "hi" --media ./clip.mp4
npm run farm -- run --time 09:00
```

## Heiss.app

```bash
npm run build -w @heiss/desktop   # → dist/Heiss.app
open dist/Heiss.app
# or dev:
npm run app
```

## CLI surface

| Command | Purpose |
| --- | --- |
| `setup status` | Remaining setup steps |
| `setup device` | Poll USB until iPhone ready, register |
| `setup all` | Detect + build/sign/install runner |
| `runner install` | Download sources / build / install HeissRunner |
| `runner status \| ensure \| stop` | Health-check / self-heal / stop the on-device automation runner |
| `daemon install \| uninstall \| status` | Persistent launchd controller (autonomous mode) |
| `signing show \| set` | Xcode team or ASC API key path |
| `devices list \| sync` | USB iPhones via `devicectl` |
| `add-account` | Register social account after you log in on phone |
| `account preflight` | Mark manual onboarding ready/pending/attention |
| `preflight health` | Check USB, trust, command channel, and runner; run the recovery ladder |
| `preflight canary` | Harmless exact-handle verification without engagement |
| `preflight x-composer` | Open and close the verified X composer without typing or publishing |
| `engagement configure/review/approve` | Per-account, capped likes/follows with review-first qualification |
| `start-warmups` / `run` | Farm tick on **real** devices only |
| `drop` | Queue content for Cloud Drop |

## Autonomous operation

`heiss-farm daemon install` registers a KeepAlive launchd agent that runs the
controller every 30s, survives crashes and reboots, and needs no desktop app.
Each tick the daemon:

- keeps the on-device **XCTest automation runner** alive: pings it before any
  due work and relaunches it from the last build (full rebuild + reinstall if
  build products are missing). The runner itself is a KeepAlive LaunchAgent,
  so it also survives its own 12-hour recycle and Mac reboots.
- **re-signs the runner automatically** within 24h of provisioning expiry
  (7-day free Apple ID certs / ~1-year ASC), so weekly manual reinstalls are
  no longer required — keep the iPhone plugged in and unlocked-able.
- runs due posting slots, scheduled warmups, and checkpointed session retries
  with per-device locks, safety caps, and exponential backoff.
- groups work by platform, sends each account's full frozen warmup plan to the
  phone once, and journals every completed gesture on-device. Transport loss
  resumes from that journal instead of replaying the session.
- omits likes and follows by default. Review mode requires a dated approval;
  autonomous mode requires three successful reviewed sessions and retains
  per-account caps, cooldowns, owned-account exclusion, and target deduplication.
  An account mismatch or unknown overlay
  pauses only that account, preserves a screenshot/checkpoint, and identifies
  the person/platform that needs manual cleanup.

## Env

| Variable | Purpose |
| --- | --- |
| `HEISS_DATA` | Store dir (default `~/.heiss`) |
| `HEISS_TEAM_ID` | Xcode `DEVELOPMENT_TEAM` |
| `HEISS_ASC_KEY_PATH` | App Store Connect `.p8` |
| `HEISS_ASC_KEY_ID` | ASC key id |
| `HEISS_ASC_ISSUER_ID` | ASC issuer id |
| `HEISS_CLOUD_URL` | Hosted Cloud Drop dashboard origin used by the Mac daemon |

## Hosted dashboard

The web dashboard is deployable as a persistent Docker service. It provides
passwordless sign-in, user-isolated Cloud Drop storage, license validation,
plan enforcement, checkout/webhook integration, and the Mac runner sync API.

```bash
cp .env.example .env
# Fill HEISS_PUBLIC_URL, HEISS_SESSION_SECRET, email, and billing values.
docker build -t heiss-web .
docker run --env-file .env -p 3000:3000 -v heiss-data:/data heiss-web
```

Use a durable encrypted volume for `/data` and terminate TLS in front of the
container. After signing in, copy both the license key and dashboard URL into
Heiss.app. The daemon then registers the real local farm, downloads queued
media, pulls signed UI-layout profiles, and reports each account delivery.

**No `HEISS_DRIVER=simulator`** — production path is iOS USB only.
