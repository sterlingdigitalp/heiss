import { spawn } from "node:child_process";
import { createConnection, createServer, type Server } from "node:net";
import { chmodSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  isLockStale,
  newLockRecord,
  probeProcessAlive,
  readLockRecord,
  reclaimStaleLock,
  releaseLockFile,
  tryCreateLockFile,
} from "@heiss/core";

export const AUTHORIZED_MUTATION_ENV = "HEISS_AUTHORIZED_MUTATION";

export function commandSocketPath(dataDir: string): string {
  return join(dataDir, "controller.sock");
}

export function commandMutatesFarm(args: string[]): boolean {
  const [cmd, sub] = args;
  if (!cmd || cmd === "status" || cmd === "--help" || cmd === "-h") return false;
  if (cmd === "daemon" || cmd === "runner" || cmd === "signing") return false;
  if (cmd === "settings" && sub === "show") return false;
  if (cmd === "warmup-schedule" && sub === "list") return false;
  if (cmd === "devices" && sub === "list") return false;
  if (cmd === "proxies" && sub === "list") return false;
  if (cmd === "license" && sub === "show") return false;
  if (cmd === "setup" && sub === "status") return false;
  if (cmd === "maintenance" && sub === "status") return false;
  if (cmd === "candidates" && sub === "show") return false;
  return true;
}

export class SerialCommandAuthority {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task, task);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
}

export type ForwardResult =
  /** No controller took the command; running it locally is safe. */
  | { forwarded: false }
  /** The controller ran it and returned a result. */
  | { forwarded: true; code: number; stdout: string; stderr: string }
  /**
   * The request reached the controller but no result came back (timeout,
   * dropped connection, garbled reply). It may be queued, running, or done, so
   * it must NOT be retried locally — that could apply the mutation twice
   * outside the serialized queue (audit 2026-09-14).
   */
  | { forwarded: "unknown"; reason: string };

/**
 * Longer than the controller can legitimately take: a full tick in the queue
 * ahead (the 25-minute tick watchdog) plus this command's own child ceiling.
 */
export const FORWARD_TIMEOUT_MS = 25 * 60_000 + 20 * 60_000 + 60_000;

export async function forwardToController(
  dataDir: string,
  args: string[],
  timeoutMs = FORWARD_TIMEOUT_MS,
): Promise<ForwardResult> {
  const socketPath = commandSocketPath(dataDir);
  if (!existsSync(socketPath)) return { forwarded: false };
  return new Promise((resolve) => {
    const socket = createConnection(socketPath);
    let raw = "";
    // Once connected, the request is handed to the controller; every failure
    // after that point has an unknown outcome.
    let delivered = false;
    let settled = false;
    const settle = (result: ForwardResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      socket.destroy();
      settle(delivered
        ? { forwarded: "unknown", reason: `no reply from the controller within ${Math.round(timeoutMs / 60_000)} minutes` }
        : { forwarded: false });
    }, timeoutMs);
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      delivered = true;
      socket.end(`${JSON.stringify({ args })}\n`);
    });
    socket.on("data", (chunk) => { raw += chunk; });
    socket.on("error", (error) => {
      // A stale socket file with no listener (ECONNREFUSED/ENOENT) never
      // delivered anything, so a local run is still safe.
      settle(delivered ? { forwarded: "unknown", reason: error.message } : { forwarded: false });
    });
    socket.on("close", () => {
      try {
        settle({ forwarded: true, ...JSON.parse(raw) as { code: number; stdout: string; stderr: string } });
      } catch {
        settle(delivered
          ? { forwarded: "unknown", reason: "the controller closed the connection without a result" }
          : { forwarded: false });
      }
    });
  });
}

/**
 * Commands the controller socket will run. Anything else is refused.
 *
 * The socket spawns the CLI with HEISS_AUTHORIZED_MUTATION=1 — the flag that
 * bypasses the "forward to the controller" check — so whatever it accepts runs
 * with full authority over the farm. It previously accepted ANY argv from any
 * local process that could open the socket.
 *
 * Regenerate with:
 *   grep -oE 'cmd === "[a-z][a-z0-9-]*"' apps/farm/src/cli.ts | sed 's/.*"\(.*\)"/\1/' | sort -u
 */
const ALLOWED_COMMANDS = new Set([
  "account", "account-set", "add-account", "add-account-set", "add-slot",
  "cancel", "candidates", "cloud", "daemon", "data", "devices", "drop",
  "engagement", "license", "maintenance", "platforms", "preflight",
  "proxies", "register-device", "remove-account", "remove-slot", "resume",
  "run", "runner", "safety", "seed", "settings", "setup", "signing",
  "start-warmups", "status", "targets", "warmup-schedule",
]);

/** A controller command is a few short tokens; anything larger is not one. */
const MAX_REQUEST_BYTES = 64 * 1024;

/**
 * Hard ceiling on a forwarded command. `serve-api` proved the failure mode:
 * a child that never exits pins SerialCommandAuthority forever, and with it
 * every warmup, engagement and recovery — silently, with the process alive so
 * launchd never restarts it. Generous enough for `runner install` and a full
 * scan+engage, far below anything that should run through this socket.
 */
const MAX_CHILD_MS = 20 * 60_000;

export function commandLockPath(dataDir: string): string {
  return join(dataDir, "controller.lock");
}

/**
 * The lease outlives any plausible daemon restart cadence; liveness is really
 * judged by `probeProcessAlive` on the recorded pid, not by age. A generous
 * ceiling only guards against a record whose pid check can never resolve.
 */
const LEASE_MAX_AGE_MS = 365 * 24 * 60 * 60_000;

/**
 * Connect to `socketPath` to find out whether a live server is listening.
 * Resolves true when something answered the connection, false when the path
 * is absent or nothing answers (stale socket file — ECONNREFUSED/ENOENT).
 */
function probeSocketAlive(socketPath: string, timeoutMs = 1_000): Promise<boolean> {
  if (!existsSync(socketPath)) return Promise.resolve(false);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (alive: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(alive);
    };
    const socket = createConnection(socketPath);
    const timer = setTimeout(() => finish(true), timeoutMs); // no answer either way; treat as unknown/alive to be safe
    socket.on("connect", () => finish(true));
    socket.on("error", (error) => {
      const code = (error as NodeJS.ErrnoException).code;
      // ECONNREFUSED/ENOENT: nothing is listening. ENOTSOCK: the path exists
      // but is not a socket at all (e.g. a leftover empty file) — also stale.
      finish(code !== "ECONNREFUSED" && code !== "ENOENT" && code !== "ENOTSOCK");
    });
  });
}

/**
 * Claim the controller socket for this process, refusing to start when
 * another server already owns it.
 *
 * Starting used to unconditionally `rmSync` the socket path before binding:
 * a second server could steal the path out from under a first one that was
 * still serving, and the first server's `close` handler then deleted the
 * *second* server's socket out from under it. Now a live listener at
 * `socketPath`, or a live pid holding `controller.lock`, refuses to start;
 * only a dead socket/lock is reclaimed. `close` only removes the socket file
 * (and releases the lease) when it still identifies as the one this server
 * bound, by comparing dev/ino taken right after `listen()`.
 */
export async function startCommandAuthorityServer(
  dataDir: string,
  authority: SerialCommandAuthority,
): Promise<Server> {
  mkdirSync(dataDir, { recursive: true });
  const socketPath = commandSocketPath(dataDir);
  const lockPath = commandLockPath(dataDir);

  if (await probeSocketAlive(socketPath)) {
    throw new Error(`another controller owns ${socketPath}`);
  }

  const record = newLockRecord("command-authority");
  const isStale = (current: import("@heiss/core").LockRecord | null) =>
    isLockStale(current, Date.now(), LEASE_MAX_AGE_MS, probeProcessAlive);
  if (!tryCreateLockFile(lockPath, record)) {
    const current = readLockRecord(lockPath);
    if (!isStale(current)) {
      throw new Error(`another controller owns ${socketPath} (lease held by pid ${current?.pid})`);
    }
    if (!reclaimStaleLock(lockPath, record, current, isStale)) {
      throw new Error(`another controller owns ${socketPath} (lease contested)`);
    }
  }

  // The socket probe and the lease both came back dead/ours, so any leftover
  // socket file at this path is stale — safe to remove before binding.
  rmSync(socketPath, { force: true });

  let ourIdentity: { dev: number; ino: number } | null = null;
  const releaseLease = () => releaseLockFile(lockPath, record);

  // Keep the writable side open after the client half-closes its request so
  // long-running canaries can return their complete JSON response.
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    // A client that disconnects before its reply is written makes the write
    // fail with EPIPE/ECONNRESET. Unhandled, that 'error' event takes down the
    // whole controller — it did, 2026-09-18, after which launchd could not get
    // it healthy again and the farm sat idle.
    socket.on("error", () => { /* the caller is gone; the command still ran */ });
    let raw = "";
    let oversized = false;
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      if (oversized) return;
      raw += chunk;
      if (raw.length > MAX_REQUEST_BYTES) {
        oversized = true;
        socket.end(JSON.stringify({ code: 2, stdout: "", stderr: "Controller command too large" }));
      }
    });
    socket.on("end", () => {
      if (oversized) return;
      void authority.run(async () => {
        let args: string[] = [];
        try { args = (JSON.parse(raw.trim()) as { args: string[] }).args; }
        catch { socket.end(JSON.stringify({ code: 2, stdout: "", stderr: "Invalid controller command" })); return; }
        // Refuse anything that is not a known command. Without this the socket
        // ran arbitrary argv with mutation authority for any local process.
        if (!Array.isArray(args) || args.some((a) => typeof a !== "string")
            || !args[0] || !ALLOWED_COMMANDS.has(args[0])) {
          socket.end(JSON.stringify({
            code: 2, stdout: "",
            stderr: `Refused: ${args?.[0] ? `unknown command ${args[0]}` : "no command"}`,
          }));
          return;
        }
        const invocation = [...process.execArgv, process.argv[1]!, ...args];
        const child = spawn(process.execPath, invocation, {
          env: { ...process.env, [AUTHORIZED_MUTATION_ENV]: "1" },
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "", stderr = "";
        child.stdout.on("data", (chunk) => { stdout += String(chunk); });
        child.stderr.on("data", (chunk) => { stderr += String(chunk); });
        const code = await new Promise<number>((resolve) => {
          let settled = false;
          const finish = (value: number) => { if (settled) return; settled = true; clearTimeout(timer); resolve(value); };
          const timer = setTimeout(() => {
            child.kill("SIGKILL");
            stderr += `\nController command exceeded ${MAX_CHILD_MS}ms and was killed`;
            finish(1);
          }, MAX_CHILD_MS);
          child.on("error", (error) => { stderr += error.message; finish(1); });
          child.on("close", (value) => finish(value ?? 1));
        });
        socket.end(JSON.stringify({ code, stdout, stderr }));
      });
    });
  });
  server.on("error", (error) => {
    console.error(JSON.stringify({ at: new Date().toISOString(), commandSocketError: String(error) }));
  });
  server.listen(socketPath, () => {
    // 0600 so only this user can hand the controller a command. The socket was
    // created with the default umask, and anything that can write to it runs
    // with mutation authority.
    try { chmodSync(socketPath, 0o600); } catch { /* best effort; the parent dir is already user-owned */ }
    // Record which socket file is ours so `close` never deletes a newer
    // server's socket at the same path (the original bug: two servers racing
    // this path, the first one's close deleting the second's live socket).
    try {
      const stat = statSync(socketPath);
      ourIdentity = { dev: stat.dev, ino: stat.ino };
    } catch { /* best effort; close falls back to leaving the file alone */ }
  });
  server.on("close", () => {
    try {
      if (ourIdentity) {
        const stat = statSync(socketPath);
        if (stat.dev === ourIdentity.dev && stat.ino === ourIdentity.ino) rmSync(socketPath, { force: true });
      }
    } catch { /* already gone */ }
    releaseLease();
  });
  return server;
}
