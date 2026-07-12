/**
 * Physical iPhone USB discovery via Apple's Core Device `devicectl`.
 * No simulators — only real paired devices.
 */
import { execFile, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface UsbIphone {
  udid: string;
  name: string;
  model?: string;
  state: string;
  paired: boolean;
  available: boolean;
  connection?: string;
}

export class UsbError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsbError";
  }
}

function runJson<T>(args: string[], timeoutMs = 30_000): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "heiss-devicectl-"));
  const out = join(dir, "out.json");
  return new Promise((resolve, reject) => {
    const child = spawn(
      "xcrun",
      ["devicectl", ...args, "--json-output", out],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stderr = "";
    child.stderr.on("data", (d) => {
      stderr += String(d);
    });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new UsbError(`devicectl timed out: ${args.join(" ")}\n${stderr}`));
    }, timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      try {
        const raw = readFileSync(out, "utf8");
        const parsed = JSON.parse(raw) as T;
        rmSync(dir, { recursive: true, force: true });
        if (code !== 0) {
          reject(
            new UsbError(
              `devicectl exited ${code}: ${args.join(" ")}\n${stderr}\n${raw.slice(0, 500)}`,
            ),
          );
          return;
        }
        resolve(parsed);
      } catch (e) {
        rmSync(dir, { recursive: true, force: true });
        reject(
          new UsbError(
            `devicectl JSON parse failed (code ${code}): ${stderr || String(e)}`,
          ),
        );
      }
    });
  });
}

/** Parse flexible devicectl JSON shapes across Xcode versions. */
export function parseDeviceList(json: unknown): UsbIphone[] {
  const root = json as {
    result?: {
      devices?: unknown[];
      deviceList?: unknown[];
    };
    devices?: unknown[];
  };
  const list =
    root.result?.devices ??
    root.result?.deviceList ??
    root.devices ??
    [];
  const out: UsbIphone[] = [];
  for (const raw of list) {
    const d = raw as Record<string, unknown>;
    const hw = (d.hardwareProperties ?? d.hardware ?? {}) as Record<
      string,
      unknown
    >;
    const conn = (d.connectionProperties ?? d.connection ?? {}) as Record<
      string,
      unknown
    >;
    const id =
      String(
        d.identifier ??
          d.udid ??
          hw.udid ??
          hw.deviceIdentifier ??
          d.coreDeviceIdentifier ??
          "",
      ) || "";
    if (!id) continue;
    const name = String(
      d.name ??
        d.deviceName ??
        hw.name ??
        conn.name ??
        "iPhone",
    );
    const model = hw.marketingName
      ? String(hw.marketingName)
      : hw.productType
        ? String(hw.productType)
        : undefined;
    const state = String(
      d.deviceState ?? conn.tunnelState ?? d.state ?? "unknown",
    ).toLowerCase();
    const paired =
      Boolean(conn.pairingState === "paired" || d.paired === true) ||
      state.includes("available") ||
      state.includes("connected");
    const reachable =
      state.includes("available") ||
      state.includes("connected") ||
      Boolean(conn.transportType);
    const transport = conn.transportType ? String(conn.transportType) : undefined;
    const isUsb = Boolean(transport && /usb|wired/i.test(transport));
    const available = reachable && isUsb;
    // Exclude simulators / virtual devices
    const isSim =
      String(hw.deviceType ?? d.deviceType ?? "")
        .toLowerCase()
        .includes("sim") ||
      name.toLowerCase().includes("simulator") ||
      String(hw.platform ?? "").toLowerCase().includes("sim");
    if (isSim) continue;
    // Prefer iPhone/iPad product types
    const product = String(hw.productType ?? hw.deviceType ?? model ?? "");
    if (
      product &&
      !/iphone|ipad|ipod/i.test(product) &&
      !/iphone|ipad/i.test(name)
    ) {
      // still allow if state says available physical
      if (!reachable) continue;
    }
    out.push({
      udid: id,
      name,
      model,
      state,
      paired,
      available,
      connection: transport,
    });
  }
  return out;
}

/** List paired physical iPhones; only wired/USB rows are marked available. */
export async function listUsbIphones(): Promise<UsbIphone[]> {
  try {
    const json = await runJson<unknown>(["list", "devices"], 20_000);
    return parseDeviceList(json);
  } catch (e) {
    // Fallback: human text parse of `xcrun xctrace list devices` / system_profiler
    return listUsbIphonesFallback();
  }
}

async function listUsbIphonesFallback(): Promise<UsbIphone[]> {
  try {
    const { stdout } = await execFileAsync(
      "xcrun",
      ["xctrace", "list", "devices"],
      { timeout: 15_000 },
    );
    const devices: UsbIphone[] = [];
    for (const line of stdout.split("\n")) {
      // e.g. "Pimpstick (18.x) (UDID)"
      const m = line.match(/^(.+?)\s+\(([0-9.]+)\)\s+\(([0-9A-Fa-f-]{20,})\)$/);
      if (!m) continue;
      const name = m[1]!.trim();
      if (/simulator/i.test(name)) continue;
      devices.push({
        udid: m[3]!,
        name,
        state: "available",
        paired: true,
        available: false,
        connection: "unknown (USB cannot be verified)",
      });
    }
    return devices;
  } catch {
    throw new UsbError(
      "Unable to list USB iPhones. Install Xcode command line tools and connect a device.",
    );
  }
}

export interface PollOptions {
  /** Max wait ms (default 120s). */
  timeoutMs?: number;
  /** Poll interval ms (default 2s). */
  intervalMs?: number;
  /** Specific UDID to wait for; otherwise any available device. */
  udid?: string;
  onTick?: (devices: UsbIphone[], elapsedMs: number) => void;
}

/**
 * Poll until at least one physical iPhone is available (or a specific UDID).
 */
export async function pollUntilReady(
  opts: PollOptions = {},
): Promise<UsbIphone> {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const intervalMs = opts.intervalMs ?? 2_000;
  const start = Date.now();
  for (;;) {
    const devices = await listUsbIphones();
    const elapsed = Date.now() - start;
    opts.onTick?.(devices, elapsed);
    const match = opts.udid
      ? devices.find((d) => d.udid === opts.udid && d.available)
      : devices.find((d) => d.available && d.paired);
    if (match) return match;
    if (elapsed >= timeoutMs) {
      throw new UsbError(
        opts.udid
          ? `Timed out waiting for iPhone ${opts.udid}. Plug in, unlock, and tap Trust.`
          : "Timed out waiting for a USB iPhone. Plug in, unlock, and tap Trust.",
      );
    }
    await sleep(intervalMs);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Write JSON helper used by install/transport tests. */
export function writeTempJson(obj: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "heiss-json-"));
  const p = join(dir, "data.json");
  writeFileSync(p, JSON.stringify(obj, null, 2));
  return p;
}
