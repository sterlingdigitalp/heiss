import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyFailure } from "../src/failures.js";

describe("classifyFailure", () => {
  it("honours an explicit failureKind on the error before any message regex", () => {
    // The message text alone would fall through to the generic "action"
    // bucket; only the explicit kind on the error should decide this.
    const error = Object.assign(new Error("Identity verification failed"), {
      failureKind: "account_mismatch",
    });
    const disposition = classifyFailure(error);
    assert.equal(disposition.kind, "account_mismatch");
    assert.equal(disposition.requiresAttention, true);
  });

  it("falls back to message matching when no explicit kind is present", () => {
    const disposition = classifyFailure(new Error("account switch did not verify"));
    assert.equal(disposition.kind, "account_mismatch");
    assert.equal(disposition.requiresAttention, true);
  });
});
