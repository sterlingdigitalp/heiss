# Restoring the farm iPhone (reclaiming System Data)

The SE accumulates ~15 GB/day of iOS System Data (OS/test logs from continuous
XCUITest). iOS exposes no way to clear it — only an erase does. A **backup →
erase → restore** cycle reclaims it while keeping apps, data, and logins:
backups deliberately exclude system caches and logs, so the restore rebuilds
System Data from near-zero.

Measured on 2026-07-20: **62.7 GB used → 18.2 GB used**, System Data 35.1 GB →
3.96 GB, with every social login intact.

Budget ~45–60 minutes, most of it unattended.

---

## Before you start

- Farm must be **paused** (`heiss-farm maintenance status` → `"mode": "active"`).
- Phone **unplugged** until Part 5.
- Know the Apple ID password (the erase asks for it, to clear Activation Lock).
- **Do not press Reattach in the Heiss app** at any point — it un-pauses the
  farm mid-restore.

---

## Part 1 — Encrypted backup

The encryption checkbox is what preserves keychain items, i.e. your social
logins. An unencrypted backup will log every account out on restore.

1. Plug the SE into the Mac. Unlock it. If it asks **Trust This Computer**, tap
   **Trust** and enter the passcode.
2. **Finder → SterlingDP** (left sidebar, under Locations) → **General** tab.
3. Select **"Back up all of the data on your iPhone to this Mac."**
4. Tick **"Encrypt local backup."** Set a password and **write it down** — it
   cannot be recovered, and without it the backup cannot be restored.
5. Click **Back Up Now**. Wait for it to finish completely.
6. **Verify before going further:** click **Manage Backups**. You must see a
   backup dated **today** with a **🔒 lock icon**. No lock means it is not
   encrypted — fix it and back up again.

> Do not proceed past this point without a verified, dated, locked backup.

---

## Part 2 — Erase

1. On the SE: **Settings → General → Transfer or Reset iPhone → Erase All
   Content and Settings**.
2. Enter the passcode, then the **Apple ID password** when prompted.
3. Confirm. The phone wipes and reboots to the **"Hello"** setup screen
   (a few minutes).

---

## Part 3 — Restore

1. Work through setup until **Transfer Your Apps & Data**.
2. Choose **From Mac or PC**.
3. Connect to the Mac if prompted; in Finder click **Restore Backup**.
4. Pick **today's** backup and enter the **encryption password**.
5. Let it run to completion. The phone may reboot more than once.

Apps re-download from the App Store afterwards and will sit greyed out showing
**"Waiting…"** — this is normal, the *data* is already restored. If they stall:

- **Settings** → check for a **Sign-In Required / Verify Apple ID** banner and
  sign in.
- Open the **App Store** → profile icon → confirm you are signed in.
- Tap one waiting app (e.g. X) to jump the queue; entering the Apple ID
  password once usually releases all of them.

Prioritise **X** — it is the only platform the farm currently uses.

---

## Part 4 — Re-enable Developer Mode

**The erase turns Developer Mode off.** Nothing can be installed until it is
back on, and this step is easy to miss.

1. **Settings → Privacy & Security** → scroll to the bottom → **Developer Mode**.
2. Toggle it **on**. Tap **Restart** when prompted.
3. After the reboot, **unlock the phone**. A prompt appears: **"Turn On
   Developer Mode?"** → **Turn On** → enter passcode.

---

## Part 5 — Reconnect, wired

The farm drives the device over USB; a network connection will not work.

1. Plug the SE in and leave it **unlocked**.
2. Confirm it is wired:

   ```sh
   xcrun devicectl list devices | grep SterlingDP
   ```

   It should read **connected**, not `unavailable` or `available (paired)`.

If it comes back over WiFi (`transportType: localNetwork`), that is a known
**Mac-side CoreDevice glitch after replugging — not a cable fault**. Restart the
service and re-check:

```sh
pkill -u $(id -u) -x CoreDeviceService
```

---

## Part 6 — Hand back

Say the word and the following runs from the Mac:

1. `heiss-farm runner install` — rebuilds and installs the runner. This also
   deploys anything not yet on the device.
2. **One manual step:** the fresh install is untrusted, so the launch fails
   with *"Developer App Certificate is not trusted."* That is expected. On the
   phone: **Settings → General → VPN & Device Management** → tap the **Apple
   Development** profile → **Trust**.
3. `heiss-farm runner ensure` → `runner status` — confirm `pingOk: true`.
   `freeBytes` should now report ~45 GB.
4. `heiss-farm daemon install` — the controller LaunchAgent.
5. `heiss-farm maintenance exit` — resumes the farm.

Finally, spot-check that **X is still logged in** on the phone.

---

## Notes

- **The two Heiss apps do not need saving.** They are dev-signed and are
  rebuilt from source in Part 6. If they return as broken icons, ignore them.
- **Free-team certificates expire every 7 days**, so `runner install` is a
  weekly chore regardless of restores.
- The storage watchdog warns at **6 GB** free and again at **3 GB**, so the
  next restore should be scheduled rather than forced.
