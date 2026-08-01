import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { planFegosImport, applyFegosImport } from "../src/fegos-import.js";
import { activeCuratedTargetsFor } from "../src/targets.js";
import type { CuratedTarget } from "../src/types.js";

const fleet = {
  SterlingDgtl: { persona_id: "research_expert", niche: "AI agents" },
  chrisklebl: { persona_id: "legacy_persona" },
};
const watchLists = [{
  persona_id: "research_expert",
  accounts: [
    { handle: "@bcherny", priority: 1, role: "Claude Code creator" },
    { handle: "@trq212", priority: 2 },
    { handle: "@third", priority: 3 },
    { handle: "@fourth", priority: 4 },
    { handle: "@retired_source", priority: 5, status: "RETIRED" },
  ],
}];
const accounts = [{ id: "acct-1", handle: "@sterlingdgtl" }];

function target(over: Partial<CuratedTarget>): CuratedTarget {
  return {
    id: over.id ?? "t", accountId: "acct-1", handle: over.handle ?? "@x",
    active: over.active ?? true, addedAt: over.addedAt ?? "2026-07-01T00:00:00.000Z",
    engagedCount: over.engagedCount ?? 0, ...over,
  } as CuratedTarget;
}

describe("FEGOS import", () => {
  it("matches a bare fleet key to the @handle Heiss stores", () => {
    const plan = planFegosImport({ fleet, watchLists, accounts, existing: [] });
    const persona = plan.personas.find((p) => p.accountHandle === "@sterlingdgtl");
    assert.equal(persona?.personaId, "research_expert");
  });

  it("reports legacy fleet entries instead of failing on them", () => {
    const plan = planFegosImport({ fleet, watchLists, accounts, existing: [] });
    assert.deepEqual(plan.unmatchedFleet, ["chrisklebl"]);
  });

  it("caps at the per-persona limit rather than importing all ten", () => {
    const plan = planFegosImport({ fleet, watchLists, accounts, existing: [], limit: 2 });
    const persona = plan.personas[0]!;
    assert.deepEqual(persona.changes.filter((c) => c.kind === "add").map((c) => c.handle),
      ["@bcherny", "@trq212"]);
  });

  it("skips sources FEGOS has retired", () => {
    const plan = planFegosImport({ fleet, watchLists, accounts, existing: [] });
    const handles = persona_handles(plan);
    assert.equal(handles.includes("@retired_source"), false);
  });

  it("keeps a target we already hold instead of re-adding it", () => {
    const existing = [target({ id: "keep-me", handle: "@bcherny", followedAt: "2026-07-02T00:00:00.000Z" })];
    const plan = planFegosImport({ fleet, watchLists, accounts, existing });
    assert.equal(plan.personas[0]!.changes.some((c) => c.kind === "keep" && c.handle === "@bcherny"), true);
  });

  it("retires rather than deletes, so a follow we made is never lost", () => {
    const existing = [target({ id: "old", handle: "@someone_else", followedAt: "2026-07-02T00:00:00.000Z", engagedCount: 3 })];
    const plan = planFegosImport({ fleet, watchLists, accounts, existing });
    applyFegosImport(existing, plan, "2026-08-01T00:00:00.000Z", () => "new-id");
    const retired = existing.find((t) => t.handle === "@someone_else")!;
    assert.equal(retired.active, false);
    assert.equal(retired.followedAt, "2026-07-02T00:00:00.000Z");
    assert.equal(retired.engagedCount, 3);
  });

  it("does not re-follow a re-activated target", () => {
    // Paused earlier, ranked again now: the follow history must survive, or the
    // farm would follow someone it already follows.
    const existing = [target({ id: "back", handle: "@bcherny", active: false, followedAt: "2026-07-02T00:00:00.000Z" })];
    const plan = planFegosImport({ fleet, watchLists, accounts, existing });
    applyFegosImport(existing, plan, "2026-08-01T00:00:00.000Z", () => "new-id");
    const revived = existing.find((t) => t.handle === "@bcherny")!;
    assert.equal(revived.active, true);
    assert.equal(revived.followedAt, "2026-07-02T00:00:00.000Z");
  });

  it("orders the rotation by FEGOS priority, not by when rows were added", () => {
    const existing: CuratedTarget[] = [];
    const plan = planFegosImport({ fleet, watchLists, accounts, existing, limit: 3 });
    let n = 0;
    applyFegosImport(existing, plan, "2026-08-01T00:00:00.000Z", () => `id-${n += 1}`);
    assert.deepEqual(activeCuratedTargetsFor(existing, "acct-1").map((t) => t.handle),
      ["@bcherny", "@trq212", "@third"]);
  });

  it("flags a persona with no watch list instead of reporting no changes", () => {
    const plan = planFegosImport({
      fleet: { SterlingDgtl: { persona_id: "missing_persona" } },
      watchLists, accounts, existing: [],
    });
    assert.match(plan.personas[0]!.problem ?? "", /no watch list/);
  });
});

function persona_handles(plan: ReturnType<typeof planFegosImport>): string[] {
  return plan.personas.flatMap((p) => p.changes.map((c) => c.handle));
}
