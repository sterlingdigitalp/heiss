import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commandSocketPath, forwardToController } from "../src/command-authority.js";

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
