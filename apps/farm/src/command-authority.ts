import { spawn } from "node:child_process";
import { createConnection, createServer, type Server } from "node:net";
import { chmodSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

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

export function startCommandAuthorityServer(
  dataDir: string,
  authority: SerialCommandAuthority,
): Server {
  mkdirSync(dataDir, { recursive: true });
  const socketPath = commandSocketPath(dataDir);
  rmSync(socketPath, { force: true });
  // Keep the writable side open after the client half-closes its request so
  // long-running canaries can return their complete JSON response.
  const server = createServer({ allowHalfOpen: true }, (socket) => {
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
  server.listen(socketPath, () => {
    // 0600 so only this user can hand the controller a command. The socket was
    // created with the default umask, and anything that can write to it runs
    // with mutation authority.
    try { chmodSync(socketPath, 0o600); } catch { /* best effort; the parent dir is already user-owned */ }
  });
  server.on("close", () => rmSync(socketPath, { force: true }));
  return server;
}
