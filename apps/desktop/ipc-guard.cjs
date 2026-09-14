/**
 * Validation for what the renderer may ask the main process to do.
 *
 * The renderer could previously hand `farm` any argv — including `--data` to
 * point the CLI at another farm, or commands the UI never offers — and any
 * frame could call any handler (audit 2026-09-14). The UI is trusted today,
 * but this boundary should not depend on the renderer never being
 * compromised.
 */
const path = require("node:path");
const { pathToFileURL } = require("node:url");

/** Every command renderer.html sends. Add here when the UI gains one. */
const RENDERER_COMMANDS = new Set([
  "account", "account-set", "add-account", "add-account-set", "add-slot",
  "cancel", "candidates", "devices", "license", "maintenance", "preflight",
  "proxies", "remove-account", "remove-slot", "runner", "safety", "settings",
  "setup", "status", "targets", "warmup-schedule",
]);

/** Flags the renderer must never set: they re-point the CLI at other state. */
const FORBIDDEN_FLAGS = new Set(["--data"]);

const MAX_ARGS = 40;
const MAX_ARG_LENGTH = 2_000;

/** Returns the validated argv, or throws with the reason. */
function validateFarmArgs(args) {
  if (!Array.isArray(args) || args.length === 0) throw new Error("farm: expected a non-empty argument list");
  if (args.length > MAX_ARGS) throw new Error("farm: too many arguments");
  for (const arg of args) {
    if (typeof arg !== "string") throw new Error("farm: arguments must be strings");
    if (arg.length > MAX_ARG_LENGTH) throw new Error("farm: argument too long");
    if (arg.includes("\0")) throw new Error("farm: invalid argument");
    if (FORBIDDEN_FLAGS.has(arg.split("=")[0])) throw new Error(`farm: ${arg.split("=")[0]} is not allowed from the app window`);
  }
  if (!RENDERER_COMMANDS.has(args[0])) throw new Error(`farm: command "${args[0]}" is not allowed from the app window`);
  return [...args];
}

/** True only for the app's own top-level renderer page. */
function isTrustedSender(event, rendererPath) {
  const frame = event && event.senderFrame;
  if (!frame || frame.parent) return false;
  return frame.url === pathToFileURL(path.resolve(rendererPath)).href;
}

module.exports = { RENDERER_COMMANDS, validateFarmArgs, isTrustedSender };
