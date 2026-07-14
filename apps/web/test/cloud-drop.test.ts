import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHmac } from "node:crypto";
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
  it("refuses production startup without a durable session secret", () => {
    const previousNodeEnv = process.env.NODE_ENV;
    const previousSecret = process.env.HEISS_SESSION_SECRET;
    process.env.NODE_ENV = "production";
    delete process.env.HEISS_SESSION_SECRET;
    try { assert.throws(() => createWebServer(), /HEISS_SESSION_SECRET/); }
    finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previousNodeEnv;
      if (previousSecret === undefined) delete process.env.HEISS_SESSION_SECRET; else process.env.HEISS_SESSION_SECRET = previousSecret;
    }
  });

  it("signup → drop content linked to accounts and claimable (run twice)", async () => {
    const { server, base, data } = await listen();
    try {
      let firstUserAccountId = "";
      for (let run = 1; run <= 2; run++) {
        const email = `founder${run}-${Date.now()}@heiss.test`;
        const signup = await json(base, "/api/signup", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, password: "secret12" }),
        });
        assert.equal(signup.res.status, 200, JSON.stringify(signup.body));
        assert.ok(signup.body.token);
        assert.match(signup.body.licenseKey, /^HEISS-/);

        const me = await json(base, "/api/me", {
          headers: { Authorization: `Bearer ${signup.body.token}` },
        });
        assert.equal(me.body.user.planId, "free");
        assert.match(me.body.user.licenseKey, /^HEISS-/);
        assert.equal(me.body.plan.maxDevices, 1);

        if (run === 1) {
          process.env.HEISS_DEV_MAGIC_LINKS = "1";
          const requested = await json(base, "/api/magic/request", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email }),
          });
          assert.equal(requested.res.status, 200, JSON.stringify(requested.body));
          const verified = await json(base, "/api/magic/verify", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ token: requested.body.devToken }),
          });
          assert.equal(verified.res.status, 200);
          const reused = await json(base, "/api/magic/verify", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ token: requested.body.devToken }),
          });
          assert.equal(reused.res.status, 401);
        }

        const upload = await json(base, "/api/uploads?filename=clip.mp4", {
          method: "POST",
          headers: {
            "Content-Type": "video/mp4",
            Authorization: `Bearer ${signup.body.token}`,
          },
          body: Buffer.from("fake-video-bytes"),
        });
        assert.equal(upload.res.status, 200, JSON.stringify(upload.body));
        assert.equal(upload.body.name, "clip.mp4");
        assert.equal(upload.body.size, 16);
        if (run === 1) {
          process.env.HEISS_MAX_UPLOAD_MB = "1";
          const oversized = await json(base, "/api/uploads?filename=too-large.mp4", {
            method: "POST",
            headers: { "Content-Type": "video/mp4", Authorization: `Bearer ${signup.body.token}` },
            body: Buffer.alloc(1024 * 1024 + 1),
          });
          assert.equal(oversized.res.status, 413);
          delete process.env.HEISS_MAX_UPLOAD_MB;
        }

        const accounts = await json(base, "/api/accounts", {
          headers: { Authorization: `Bearer ${signup.body.token}` },
        });
        assert.ok(accounts.body.accounts.length >= 2);
        const targets = accounts.body.accounts
          .filter((a: { platform: string }) => a.platform === "tiktok" || a.platform === "instagram")
          .map((a: { id: string }) => a.id);
        if (run === 1) firstUserAccountId = targets[0] ?? "";
        if (run === 2) {
          assert.ok(!accounts.body.accounts.some((a: { id: string }) => a.id === firstUserAccountId));
        }

        const drop = await json(base, "/api/drop", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${signup.body.token}`,
          },
          body: JSON.stringify({
            kind: "video",
            mediaRef: upload.body.mediaRef,
            caption: `drop run ${run}`,
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

        const licenseHeaders = {
          "Content-Type": "application/json",
          Authorization: `Bearer ${signup.body.licenseKey}`,
        };
        const localAccounts = accounts.body.accounts.map((account: any, index: number) => ({
          ...account,
          id: `local-${run}-${index}`,
          deviceId: `local-device-${run}`,
          ownerId: undefined,
          sourceId: undefined,
        }));
        const synced = await json(base, "/api/runner/sync", {
          method: "POST",
          headers: licenseHeaders,
          body: JSON.stringify({
            devices: [{ id: `local-device-${run}`, name: "Real iPhone", udid: `UDID-${run}`, online: true, createdAt: new Date().toISOString() }],
            accounts: localAccounts,
            slots: [],
          }),
        });
        assert.equal(synced.res.status, 200, JSON.stringify(synced.body));
        const profiles = await json(base, "/api/runner/profiles", {
          method: "POST", headers: licenseHeaders, body: "{}",
        });
        assert.equal(profiles.res.status, 200);
        assert.match(profiles.body.profiles.tiktok.revision, /^2026\./);

        const claim = await json(base, "/api/runner/claim", {
          method: "POST",
          headers: licenseHeaders,
          body: JSON.stringify({ runnerId: `mac-${run}` }),
        });
        assert.equal(claim.res.status, 200, JSON.stringify(claim.body));
        assert.equal(claim.body.item.id, drop.body.queueItem.id);
        assert.ok(claim.body.targets.every((target: { sourceId?: string }) => target.sourceId?.startsWith(`local-${run}-`)));
        const media = await fetch(new URL(claim.body.content.mediaRef, base), {
          headers: { Authorization: `Bearer ${signup.body.licenseKey}` },
        });
        assert.equal(media.status, 200);
        assert.equal(await media.text(), "fake-video-bytes");

        let completed;
        for (const target of claim.body.targets) {
          completed = await json(base, "/api/runner/complete", {
            method: "POST",
            headers: licenseHeaders,
            body: JSON.stringify({ queueId: claim.body.item.id, sourceAccountId: target.sourceId }),
          });
          assert.equal(completed.res.status, 200, JSON.stringify(completed.body));
        }
        assert.equal(completed.body.done, true);

        if (run === 1) {
          process.env.HEISS_CHECKOUT_SOLO = "https://checkout.example/solo";
          process.env.HEISS_LEMON_WEBHOOK_SECRET = "webhook-test-secret";
          process.env.HEISS_LEMON_VARIANT_SOLO = "variant-solo";
          const checkout = await json(base, "/api/billing/checkout", {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${signup.body.token}` },
            body: JSON.stringify({ planId: "solo" }),
          });
          assert.equal(checkout.res.status, 200);
          assert.match(checkout.body.url, /checkout%5Bcustom%5D%5Buser_id%5D/);

          const webhookBody = JSON.stringify({
            meta: { event_name: "subscription_created", custom_data: { user_id: signup.body.user.id } },
            data: { id: "sub-1", attributes: { variant_id: "variant-solo", customer_id: "cust-1", user_email: email } },
          });
          const signature = createHmac("sha256", "webhook-test-secret").update(webhookBody).digest("hex");
          const webhook = await json(base, "/api/billing/webhook", {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-Signature": signature },
            body: webhookBody,
          });
          assert.equal(webhook.res.status, 200, JSON.stringify(webhook.body));
          const upgraded = await json(base, "/api/me", { headers: { Authorization: `Bearer ${signup.body.token}` } });
          assert.equal(upgraded.body.user.planId, "solo");
        }
      }

      const marketing = await fetch(`${base}/`);
      assert.equal(marketing.status, 200);
      assert.equal(marketing.headers.get("x-frame-options"), "DENY");
      assert.equal(marketing.headers.get("access-control-allow-origin"), null);
      assert.match(marketing.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
      const html = await marketing.text();
      assert.match(html, /Heiss/);
      assert.match(html, /Cloud Drop|autopilot/i);

      const app = await fetch(`${base}/app`);
      assert.equal(app.status, 200);
      const appHtml = await app.text();
      assert.match(appHtml, /Cloud Drop/);
      assert.equal(existsSync(join(data, "farm.json")), true, "server must honor HEISS_DATA at creation time");
      const release = join(data, "Heiss-mac-arm64.zip");
      writeFileSync(release, Buffer.from("signed-release-zip"));
      process.env.HEISS_DOWNLOAD_PATH = release;
      const download = await fetch(`${base}/download/mac`);
      assert.equal(download.status, 200);
      assert.equal(download.headers.get("content-disposition"), 'attachment; filename="Heiss-mac-arm64.zip"');
      assert.equal(await download.text(), "signed-release-zip");
      process.env.HEISS_PUBLIC_URL = "https://app.heiss.test";
      process.env.HEISS_GOOGLE_CLIENT_ID = "google-client";
      process.env.HEISS_GOOGLE_CLIENT_SECRET = "google-secret";
      const providers = await json(base, "/api/auth/providers");
      assert.equal(providers.body.google, true);
      const google = await fetch(`${base}/api/auth/google`, { redirect: "manual" });
      assert.equal(google.status, 302);
      const authorization = new URL(google.headers.get("location")!);
      assert.equal(authorization.hostname, "accounts.google.com");
      assert.equal(authorization.searchParams.get("redirect_uri"), "https://app.heiss.test/api/auth/google/callback");
      const oauthState = authorization.searchParams.get("state");
      assert.ok(oauthState);
      const tampered = await fetch(`${base}/api/auth/google/callback?code=nope&state=tampered`);
      assert.equal(tampered.status, 401);
      const nativeFetch = globalThis.fetch;
      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const href = input instanceof Request ? input.url : String(input);
        if (href === "https://oauth2.googleapis.com/token") return Response.json({ access_token: "google-access" });
        if (href === "https://openidconnect.googleapis.com/v1/userinfo") return Response.json({ email: "google@heiss.test", email_verified: true });
        return nativeFetch(input, init);
      }) as typeof fetch;
      let callback: Response;
      try {
        callback = await nativeFetch(`${base}/api/auth/google/callback?code=valid&state=${encodeURIComponent(oauthState!)}`, { redirect: "manual" });
      } finally { globalThis.fetch = nativeFetch; }
      assert.equal(callback.status, 302);
      const callbackUrl = new URL(callback.headers.get("location")!);
      assert.equal(callbackUrl.origin, "https://app.heiss.test");
      const oauthMagic = callbackUrl.searchParams.get("magic");
      assert.ok(oauthMagic, "OAuth callback must use a single-use handoff token");
      const oauthLogin = await json(base, "/api/magic/verify", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: oauthMagic }),
      });
      assert.equal(oauthLogin.res.status, 200);
      const oauthReuse = await json(base, "/api/magic/verify", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: oauthMagic }),
      });
      assert.equal(oauthReuse.res.status, 401);
      for (const path of ["/blog.html", "/resources.html", "/privacy.html", "/terms.html", "/blog/iphone-farm-guide.html", "/robots.txt", "/sitemap.xml", "/llms.txt"]) {
        const page = await fetch(`${base}${path}`);
        assert.equal(page.status, 200, path);
        assert.ok((await page.text()).length > 40, path);
      }
    } finally {
      delete process.env.HEISS_CHECKOUT_SOLO;
      delete process.env.HEISS_LEMON_WEBHOOK_SECRET;
      delete process.env.HEISS_LEMON_VARIANT_SOLO;
      delete process.env.HEISS_DEV_MAGIC_LINKS;
      delete process.env.HEISS_DOWNLOAD_PATH;
      delete process.env.HEISS_PUBLIC_URL;
      delete process.env.HEISS_GOOGLE_CLIENT_ID;
      delete process.env.HEISS_GOOGLE_CLIENT_SECRET;
      delete process.env.HEISS_MAX_UPLOAD_MB;
      await new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      );
    }
  });
});
