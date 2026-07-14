import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { hashPassword, verifyPassword, issueSessionToken, parseSessionToken } from "../src/index.js";

describe("dashboard authentication", () => {
  it("uses a salted memory-hard password hash", () => {
    const hash = hashPassword("correct horse battery staple");
    assert.match(hash, /^scrypt\$/);
    assert.equal(verifyPassword("correct horse battery staple", hash), true);
    assert.equal(verifyPassword("wrong", hash), false);
  });

  it("signs sessions, expires them, and rejects tampering", () => {
    const token = issueSessionToken("user-1");
    const parsed = parseSessionToken(token);
    assert.equal(parsed?.userId, "user-1");
    assert.ok((parsed?.exp ?? 0) > Date.now());
    const raw = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
    raw.userId = "user-2";
    const tampered = Buffer.from(JSON.stringify(raw)).toString("base64url");
    assert.equal(parseSessionToken(tampered), null);
  });
});
