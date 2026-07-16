import { spawn } from "node:child_process";
import { createConnection, createServer, type Server } from "node:net";
import { existsSync, mkdirSync, rmSync } from "node:fs";
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

export async function forwardToController(
  dataDir: string,
  args: string[],
  timeoutMs = 10 * 60_000,
): Promise<{ forwarded: boolean; code?: number; stdout?: string; stderr?: string }> {
  const socketPath = commandSocketPath(dataDir);
  if (!existsSync(socketPath)) return { forwarded: false };
  return new Promise((resolve) => {
    const socket = createConnection(socketPath);
    let raw = "";
    const timer = setTimeout(() => {
      socket.destroy();
      resolve({ forwarded: false });
    }, timeoutMs);
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.end(`${JSON.stringify({ args })}\n`));
    socket.on("data", (chunk) => { raw += chunk; });
    socket.on("error", () => {
      clearTimeout(timer);
      resolve({ forwarded: false });
    });
    socket.on("close", () => {
      clearTimeout(timer);
      try {
        resolve({ forwarded: true, ...JSON.parse(raw) as { code: number; stdout: string; stderr: string } });
      } catch {
        resolve({ forwarded: false });
      }
    });
  });
}

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
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => { raw += chunk; });
    socket.on("end", () => {
      void authority.run(async () => {
        let args: string[] = [];
        try { args = (JSON.parse(raw.trim()) as { args: string[] }).args; }
        catch { socket.end(JSON.stringify({ code: 2, stdout: "", stderr: "Invalid controller command" })); return; }
        const invocation = [...process.execArgv, process.argv[1]!, ...args];
        const child = spawn(process.execPath, invocation, {
          env: { ...process.env, [AUTHORIZED_MUTATION_ENV]: "1" },
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "", stderr = "";
        child.stdout.on("data", (chunk) => { stdout += String(chunk); });
        child.stderr.on("data", (chunk) => { stderr += String(chunk); });
        const code = await new Promise<number>((resolve) => {
          child.on("error", (error) => { stderr += error.message; resolve(1); });
          child.on("close", (value) => resolve(value ?? 1));
        });
        socket.end(JSON.stringify({ code, stdout, stderr }));
      });
    });
  });
  server.listen(socketPath);
  server.on("close", () => rmSync(socketPath, { force: true }));
  return server;
}
