import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createWebServer } from "../src/server.js";

async function listen() {
  const data = mkdtempSync(join(tmpdir(), "heiss-web-"));
  process.env.HEISS_DATA = data;
  const server = createWebServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no port");
  const base = `http://127.0.0.1:${addr.port}`;
  return { server, base, data };
}

async function json(base: string, path: string, init?: RequestInit) {
  const res = await fetch(`${base}${path}`, init);
  const body = await res.json();
  return { res, body };
}

describe("web Cloud Drop (shipped entry)", () => {
  it("signup → drop content linked to accounts and claimable (run twice)", async () => {
    const { server, base } = await listen();
    try {
      for (let run = 1; run <= 2; run++) {
        const email = `founder${run}-${Date.now()}@heiss.test`;
        const signup = await json(base, "/api/signup", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, password: "secret12" }),
        });
        assert.equal(signup.res.status, 200, JSON.stringify(signup.body));
        assert.ok(signup.body.token);

        const accounts = await json(base, "/api/accounts", {
          headers: { Authorization: `Bearer ${signup.body.token}` },
        });
        assert.ok(accounts.body.accounts.length >= 2);
        const targets = accounts.body.accounts
          .filter((a: { platform: string }) => a.platform === "tiktok" || a.platform === "instagram")
          .map((a: { id: string }) => a.id);

        const drop = await json(base, "/api/drop", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${signup.body.token}`,
          },
          body: JSON.stringify({
            kind: "video",
            mediaRef: `https://cdn.example/r${run}.mp4`,
            caption: `drop run ${run}`,
            music: "lofi",
            accountIds: targets,
          }),
        });
        assert.equal(drop.res.status, 200, JSON.stringify(drop.body));
        assert.equal(drop.body.ok, true);
        assert.equal(drop.body.queueItem.status, "queued");
        assert.equal(drop.body.claimable, true);
        assert.equal(drop.body.claimableByRunner, true);
        assert.deepEqual(drop.body.linkedAccountIds, targets);
        assert.deepEqual(drop.body.queueItem.accountIds, targets);
      }

      const marketing = await fetch(`${base}/`);
      assert.equal(marketing.status, 200);
      const html = await marketing.text();
      assert.match(html, /Heiss/);
      assert.match(html, /Cloud Drop|autopilot/i);

      const app = await fetch(`${base}/app`);
      assert.equal(app.status, 200);
      const appHtml = await app.text();
      assert.match(appHtml, /Cloud Drop/);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      );
    }
  });
});
