import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createConnection, createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  commandLockPath,
  commandSocketPath,
  forwardToController,
  startCommandAuthorityServer,
  SerialCommandAuthority,
} from "../src/command-authority.js";

// Short socket paths: macOS caps AF_UNIX paths at 104 bytes.
const dataDir = () => mkdtempSync(join(tmpdir(), "hca-"));

async function listen(dir: string, onRequest: (socket: import("node:net").Socket) => void): Promise<Server> {
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    socket.setEncoding("utf8");
    socket.on("end", () => onRequest(socket));
    socket.resume();
  });
  await new Promise<void>((resolve) => server.listen(commandSocketPath(dir), resolve));
  return server;
}

describe("forwarding to the controller", () => {
  it("runs locally when no controller socket exists", async () => {
    assert.deepEqual(await forwardToController(dataDir(), ["status"]), { forwarded: false });
  });

  it("runs locally when the socket file is stale (nothing delivered)", async () => {
    const dir = dataDir();
    writeFileSync(commandSocketPath(dir), "");
    assert.deepEqual(await forwardToController(dir, ["settings", "set"]), { forwarded: false });
  });

  it("returns the controller's result", async () => {
    const dir = dataDir();
    const server = await listen(dir, (socket) => socket.end(JSON.stringify({ code: 0, stdout: "ok\n", stderr: "" })));
    try {
      assert.deepEqual(await forwardToController(dir, ["settings", "set"]),
        { forwarded: true, code: 0, stdout: "ok\n", stderr: "" });
    } finally {
      server.close();
    }
  });

  it("reports an unknown outcome, not a local run, when a delivered command times out", async () => {
    const dir = dataDir();
    const held: import("node:net").Socket[] = [];
    const server = await listen(dir, (socket) => { held.push(socket); });
    try {
      const result = await forwardToController(dir, ["settings", "set"], 300);
      assert.equal(result.forwarded, "unknown");
    } finally {
      for (const socket of held) socket.destroy();
      server.close();
    }
  });

  it("reports an unknown outcome when the controller drops the connection", async () => {
    const dir = dataDir();
    const server = await listen(dir, (socket) => socket.destroy());
    try {
      assert.equal((await forwardToController(dir, ["settings", "set"])).forwarded, "unknown");
    } finally {
      server.close();
    }
  });
});

describe("controller socket resilience", () => {
  it("survives a client that disconnects before its reply is written", async () => {
    // The controller crashed on an unhandled EPIPE here (2026-09-18): every
    // forwarded command whose caller gave up took the whole farm down and
    // launchd could not get it healthy again.
    //
    // The command is deliberately one the server refuses: that still writes a
    // reply to the vanished socket (the failing path) without spawning a CLI
    // child, which under the test runner would re-run this file.
    const dir = dataDir();
    const server = await startCommandAuthorityServer(dir, new SerialCommandAuthority());
    await new Promise((resolve) => setTimeout(resolve, 150));
    const crashed: unknown[] = [];
    const onUncaught = (error: unknown) => crashed.push(error);
    process.on("uncaughtException", onUncaught);
    try {
      for (let i = 0; i < 3; i++) {
        await new Promise<void>((resolve) => {
          const socket = createConnection(commandSocketPath(dir), () => {
            socket.end(`${JSON.stringify({ args: ["no-such-command"] })}\n`, () => {
              socket.destroy();
              resolve();
            });
          });
          socket.on("error", () => resolve());
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
      assert.deepEqual(crashed, [], "no unhandled socket error reached the process");
      const after = await forwardToController(dir, ["no-such-command"], 5_000);
      assert.equal(after.forwarded, true, "the controller is still serving");
    } finally {
      process.removeListener("uncaughtException", onUncaught);
      server.close();
    }
  });
});

describe("controller socket ownership", () => {
  it("refuses to start a second server while the first is live", async () => {
    const dir = dataDir();
    const first = await startCommandAuthorityServer(dir, new SerialCommandAuthority());
    try {
      await assert.rejects(
        startCommandAuthorityServer(dir, new SerialCommandAuthority()),
        /another controller owns/,
      );
    } finally {
      await new Promise<void>((resolve) => first.close(() => resolve()));
    }
  });

  it("lets a new server start once the first has closed", async () => {
    const dir = dataDir();
    const first = await startCommandAuthorityServer(dir, new SerialCommandAuthority());
    await new Promise<void>((resolve) => first.close(() => resolve()));
    const second = await startCommandAuthorityServer(dir, new SerialCommandAuthority());
    try {
      assert.equal((await forwardToController(dir, ["no-such-command"], 5_000)).forwarded, true);
    } finally {
      await new Promise<void>((resolve) => second.close(() => resolve()));
    }
  });

  it("never deletes a newer server's socket when an old server closes late", async () => {
    const dir = dataDir();
    const first = await startCommandAuthorityServer(dir, new SerialCommandAuthority());
    await new Promise<void>((resolve) => first.close(() => resolve()));
    const second = await startCommandAuthorityServer(dir, new SerialCommandAuthority());
    try {
      // Simulate the original race: the first server's close handler runs
      // again (e.g. a delayed callback) after a second server already took
      // the same socket path. It must not remove the second server's socket.
      first.emit("close");
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal((await forwardToController(dir, ["no-such-command"], 5_000)).forwarded, true,
        "the second server's socket must still exist and answer");
    } finally {
      await new Promise<void>((resolve) => second.close(() => resolve()));
    }
  });

  it("reclaims a stale socket file with no listener", async () => {
    const dir = dataDir();
    writeFileSync(commandSocketPath(dir), "");
    const server = await startCommandAuthorityServer(dir, new SerialCommandAuthority());
    try {
      assert.equal((await forwardToController(dir, ["no-such-command"], 5_000)).forwarded, true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("reclaims a stale lease file left by a dead pid", async () => {
    const dir = dataDir();
    // A pid essentially guaranteed not to be a live process on this host.
    writeFileSync(commandLockPath(dir), JSON.stringify({
      pid: 999_999, processStartedAt: Date.now(), acquiredAt: Date.now(), purpose: "command-authority",
    }));
    const server = await startCommandAuthorityServer(dir, new SerialCommandAuthority());
    try {
      assert.equal((await forwardToController(dir, ["no-such-command"], 5_000)).forwarded, true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
