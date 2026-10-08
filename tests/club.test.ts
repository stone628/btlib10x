/**
 * Club management: severed-limb tokens, dropped clubs, involuntary release,
 * and the salvage flag (TW p.145-146; salvage value is a house rule).
 */

import { describe, expect, it } from "vitest";
import { type BattleState, createBattle, type GameEvent, mechDefFor, type Rng } from "../src";
import type { LimbLocation } from "../src/core/types";
import { setSlotDestroyed } from "../src/rules/critical";
import {
  applyFall,
  buildUnitInit,
  clubTokensInHex,
  declarePickup,
  recordSeveredLimbs,
  resolveAllAttacks,
  salvageableSeveredLimbs,
  validatePickup,
} from "../src/rules/game";

/** RNG that must never be consumed. */
const NO_RNG: Rng = {
  d6: () => {
    throw new Error("rng consumed");
  },
  snapshot: () => "",
  load: () => {},
};

const FIXED_RNG: Rng = { d6: () => 3, snapshot: () => "", load: () => {} };

function attackPhase(terrain: Array<{ col: number; row: number; terrain: string }> = []) {
  const battle = createBattle(
    {
      name: "club",
      width: 12,
      height: 12,
      terrain: terrain as never,
      legends: [],
    },
    [
      buildUnitInit("a", "HBK-4G", 1, { col: 5, row: 5 }, "n"),
      buildUnitInit("b", "HBK-4G", 2, { col: 5, row: 5 }, "n"),
      buildUnitInit("far", "HBK-4G", 2, { col: 1, row: 1 }, "n"),
    ],
  );
  battle.phase = "attack";
  battle.initiativeWinnerTeam = 2;
  battle.actorQueue = ["a", "b", "far"];
  battle.actedThisPhase = [];
  return battle;
}

function weaponLimb(battle: BattleState): LimbLocation {
  const def = mechDefFor(battle.units.a!);
  for (const loc of ["rightArm", "leftArm", "rightLeg", "leftLeg"] as const) {
    if (def.critSlots[loc].some((s) => s.kind === "weapon")) return loc;
  }
  throw new Error("no weapon limb");
}

function pickUp(battle: BattleState, unitId: string, decl = {}) {
  const sink: GameEvent[] = [];
  battle.actorQueue = [unitId];
  battle.actedThisPhase = [];
  declarePickup(battle, unitId, decl, sink);
  resolveAllAttacks(battle, FIXED_RNG, sink);
  return sink;
}

describe("severed limb salvage flag", () => {
  it("is salvageable until first picked up, even if dropped and re-picked", () => {
    const battle = attackPhase();
    const limb = weaponLimb(battle);
    recordSeveredLimbs(battle, battle.units.a!, [limb]);
    expect(salvageableSeveredLimbs(battle, "a")).toEqual([limb]);
    // Unit "a" picks up its own limb.
    pickUp(battle, "a");
    expect(battle.units.a!.club).toEqual({ kind: "limb", limb, ownerId: "a" });
    expect(salvageableSeveredLimbs(battle, "a")).toEqual([]);
    expect(battle.units.a!.blownOffLimbs[0]!.salvageable).toBe(false);
  });

  it("is not salvageable once every weapon slot in the limb is destroyed", () => {
    const battle = attackPhase();
    const limb = weaponLimb(battle);
    const def = mechDefFor(battle.units.a!);
    def.critSlots[limb].forEach((s, i) => {
      if (s.kind === "weapon") setSlotDestroyed(battle.units.a!.critSlotsDestroyed, limb, i);
    });
    recordSeveredLimbs(battle, battle.units.a!, [limb]);
    expect(salvageableSeveredLimbs(battle, "a")).toEqual([]);
  });
});

describe("pickup tokens", () => {
  it("picking up a lone limb token needs no roll", () => {
    const battle = attackPhase();
    battle.units.far!.position = { col: 5, row: 5 };
    recordSeveredLimbs(battle, battle.units.far!, ["leftArm"]);
    battle.actorQueue = ["a"];
    const sink: GameEvent[] = [];
    declarePickup(battle, "a", {}, sink);
    resolveAllAttacks(battle, NO_RNG, sink);
    expect(battle.units.a!.club).toEqual({ kind: "limb", limb: "leftArm", ownerId: "far" });
    expect(clubTokensInHex(battle, battle.units.a!)).toEqual([]);
  });

  it("errors with several tokens unless a token number is given", () => {
    const battle = attackPhase();
    recordSeveredLimbs(battle, battle.units.a!, ["leftArm", "rightLeg"]);
    const unit = battle.units.b!;
    const bare = validatePickup(battle, unit.id, {});
    expect(bare.ok).toBe(false);
    if (!bare.ok) expect(bare.reason).toContain("choose one");
    const chosen = validatePickup(battle, unit.id, { tokenIndex: 2 });
    expect(chosen.ok).toBe(true);
    if (chosen.ok) expect(chosen.token).toEqual({ kind: "limb", limb: "rightLeg", ownerId: "a" });
  });

  it("a dropped tree stays intact and is re-taken without a roll", () => {
    const battle = attackPhase();
    battle.units.a!.club = { kind: "tree" };
    const sink: GameEvent[] = [];
    applyFall(
      battle,
      battle.units.a!,
      FIXED_RNG,
      { cause: { kind: "terrain", terrain: "rubble" }, seatbeltModifier: 0, halved: false },
      sink,
    );
    expect(battle.units.a!.club).toBeNull();
    expect(clubTokensInHex(battle, battle.units.a!)).toEqual([{ kind: "tree" }]);
    const drop = sink.find((e) => e.kind === "clubDropped");
    expect(drop).toMatchObject({ clubKind: "tree", cause: "fall" });
    // Hex is clear terrain, so the token is the only source.
    const events: GameEvent[] = [];
    battle.actorQueue = ["b"];
    declarePickup(battle, "b", {}, events);
    resolveAllAttacks(battle, NO_RNG, events);
    expect(battle.units.b!.club).toEqual({ kind: "tree" });
    expect(clubTokensInHex(battle, battle.units.b!)).toEqual([]);
  });

  it("a dropped girder is re-taken without a 2D6 search", () => {
    const battle = attackPhase();
    battle.units.a!.club = { kind: "girder" };
    const sink: GameEvent[] = [];
    battle.actorQueue = ["a"];
    // lone drop via declareAttacks path is covered elsewhere; release directly.
    applyFall(
      battle,
      battle.units.a!,
      FIXED_RNG,
      { cause: { kind: "terrain", terrain: "rubble" }, seatbeltModifier: 0, halved: false },
      sink,
    );
    const result = validatePickup(battle, "b", {});
    expect(result).toEqual({ ok: true, source: "girder", token: { kind: "girder" } });
  });
});
