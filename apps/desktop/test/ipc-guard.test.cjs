const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { RENDERER_COMMANDS, validateFarmArgs, isTrustedSender } = require("../ipc-guard.cjs");

const renderer = path.join(__dirname, "..", "renderer.html");

describe("desktop IPC guard", () => {
  it("allows every command the renderer actually sends", () => {
    // Keep the allowlist and the UI in step: each ['command', ...] array in
    // renderer.html must pass, or the button that sends it would break.
    const html = fs.readFileSync(renderer, "utf8");
    const sent = new Set([...html.matchAll(/farm\(\['([a-z-]+)'/g), ...html.matchAll(/(?:args|addArgs)=\['([a-z-]+)'/g)]
      .map((match) => match[1]));
    assert.ok(sent.size >= 15, `found the renderer's commands (${sent.size})`);
    for (const command of sent) assert.ok(RENDERER_COMMANDS.has(command), `renderer sends "${command}"`);
  });

  it("accepts the argument shapes the UI builds", () => {
    assert.deepEqual(validateFarmArgs(["status"]), ["status"]);
    assert.deepEqual(validateFarmArgs(["maintenance", "enter", "--reason", "Detach from desktop"]),
      ["maintenance", "enter", "--reason", "Detach from desktop"]);
    assert.doesNotThrow(() => validateFarmArgs(["targets", "add", "id-1", "@handle", "--note", "met at conf"]));
  });

  it("rejects commands the UI never sends, data redirection, and malformed input", () => {
    for (const bad of [
      ["daemon"], ["data", "migrate"], ["seed"], ["run"], ["cloud", "sync"],
      ["status", "--data", "/tmp/other"], ["status", "--data=/tmp/other"],
      [], "status", [42], ["status", "a\0b"], ["status", "x".repeat(2_001)],
      Array.from({ length: 41 }, () => "status"),
    ]) {
      assert.throws(() => validateFarmArgs(bad), /farm:/, JSON.stringify(bad).slice(0, 60));
    }
  });

  it("trusts only the top-level renderer page", () => {
    const url = pathToFileURL(path.resolve(renderer)).href;
    assert.equal(isTrustedSender({ senderFrame: { url, parent: null } }, renderer), true);
    assert.equal(isTrustedSender({ senderFrame: { url, parent: {} } }, renderer), false, "subframe");
    assert.equal(isTrustedSender({ senderFrame: { url: "https://example.com/", parent: null } }, renderer), false);
    assert.equal(isTrustedSender({ senderFrame: null }, renderer), false);
    assert.equal(isTrustedSender(undefined, renderer), false);
  });
});
