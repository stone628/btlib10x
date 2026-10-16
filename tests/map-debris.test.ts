/**
 * Map-declared severed limbs and wreckage: validation, battle seeding, the
 * packed wire form, and parity with debris left during play.
 */

import { describe, expect, it } from "vitest";
import type { Rng } from "../src/core/types";
import { decodeMapLine } from "../src/data/catalog";
import { encodeMapDef } from "../src/data/index";
import { type MapDef, type MapDefSrc, validateMapDef } from "../src/data/map.schema";
import {
  buildUnitInit,
  clubTokensInHex,
  createBattle,
  declarePickup,
  type GameEvent,
  hasWreckage,
  resolveAllAttacks,
  wreckageAt,
} from "../src/rules/game";
import { loadBattleState, saveBattleState } from "../src/rules/snapshot";

const NO_RNG: Rng = {
  d6: () => {
    throw new Error("rng consumed");
  },
  snapshot: () => "",
  load: () => {},
};

const SRC: MapDefSrc = {
  name: "debris",
  width: 8,
  height: 8,
  terrain: [{ col: 2, row: 2, type: "lightWoods" }],
  clubs: [
    { col: 5, row: 5, model: "AS7-D", limb: "leftArm" },
    { col: 5, row: 5, model: "BZK-F3", limb: "rightLeg" },
  ],
  wreckage: [{ col: 3, row: 4, model: "KGC-000" }],
};

function battleOn(map: MapDefSrc) {
  const def: MapDef = { ...map, legends: [] };
  return createBattle(def, [
    buildUnitInit("a", "HBK-4G", 1, { col: 5, row: 5 }, "n"),
    buildUnitInit("b", "ENF-4R", 2, { col: 1, row: 1 }, "n"),
  ]);
}

describe("validateMapDef: clubs and wreckage", () => {
  it("accepts well-formed entries", () => {
    expect(() => validateMapDef(SRC)).not.toThrow();
  });

  it("rejects out-of-bounds hexes, empty models and non-limb locations", () => {
    expect(() =>
      validateMapDef({ ...SRC, wreckage: [{ col: 9, row: 1, model: "KGC-000" }] }),
    ).toThrow(/wreckage\[0\] hex 9,1 outside board bounds/);
    expect(() => validateMapDef({ ...SRC, wreckage: [{ col: 1, row: 1, model: "" }] })).toThrow(
      /wreckage\[0\]\.model must be a non-empty string/,
    );
    expect(() =>
      validateMapDef({
        ...SRC,
        clubs: [{ col: 1, row: 1, model: "AS7-D", limb: "head" as never }],
      }),
    ).toThrow(/clubs\[0\]\.limb "head" is not an arm or leg location/);
  });
});

describe("createBattle seeds map debris", () => {
  it("places owner-less limbs and wreckage in deposit order", () => {
    const battle = battleOn(SRC);
    expect(battle.clubs).toEqual({
      "5,5": [
        { kind: "limb", limb: "leftArm", model: "AS7-D", ownerId: null },
        { kind: "limb", limb: "rightLeg", model: "BZK-F3", ownerId: null },
      ],
    });
    expect(wreckageAt(battle, { col: 3, row: 4 })).toEqual([{ model: "KGC-000", unitId: null }]);
    expect(hasWreckage(battle, { col: 3, row: 4 })).toBe(true);
  });

  it("rejects unknown models and wreckage under 40 t", () => {
    expect(() =>
      battleOn({ ...SRC, clubs: [{ col: 1, row: 1, model: "NOPE", limb: "leftArm" }] }),
    ).toThrow(/Unknown 'Mech model for club at .*: NOPE/);
    expect(() => battleOn({ ...SRC, wreckage: [{ col: 1, row: 1, model: "BZK-F3" }] })).toThrow(
      /BZK-F3 is 35 t, under 40 t/,
    );
  });

  it("a map limb is picked up like one severed in play, with no salvage to void", () => {
    const battle = battleOn(SRC);
    battle.phase = "attack";
    battle.initiativeWinnerTeam = 1;
    battle.actorQueue = ["a"];
    battle.actedThisPhase = [];
    const sink: GameEvent[] = [];
    declarePickup(battle, "a", { tokenIndex: 2 }, sink);
    resolveAllAttacks(battle, NO_RNG, sink);
    expect(battle.units.a!.club).toEqual({
      kind: "limb",
      limb: "rightLeg",
      model: "BZK-F3",
      ownerId: null,
    });
    expect(clubTokensInHex(battle, battle.units.a!)).toEqual([
      { kind: "limb", limb: "leftArm", model: "AS7-D", ownerId: null },
    ]);
  });

  it("round-trips through snapshots", () => {
    const battle = battleOn(SRC);
    const snap = saveBattleState(battle);
    battle.wreckage = {};
    battle.clubs = {};
    loadBattleState(battle, snap);
    expect(wreckageAt(battle, { col: 3, row: 4 })).toEqual([{ model: "KGC-000", unitId: null }]);
    expect(battle.clubs["5,5"]).toHaveLength(2);
  });
});

describe("map wire form", () => {
  const identity = { name: SRC.name, width: SRC.width, height: SRC.height };

  it("round-trips clubs and wreckage", () => {
    expect(decodeMapLine(encodeMapDef(SRC), identity)).toEqual(SRC);
  });

  it("codes club limbs with the mech wire's location codes", () => {
    expect(encodeMapDef(SRC)).toContain('m:"AS7-D",l:"A"');
    expect(() => decodeMapLine('{v:1,t:[],c:[{c:1,r:1,m:"AS7-D",l:"C"}]}', identity)).toThrow(
      /bad club limb/,
    );
  });

  it("omits the keys when a map has none", () => {
    const bare: MapDefSrc = { ...identity, terrain: SRC.terrain };
    const line = encodeMapDef(bare);
    expect(line).toBe(encodeMapDef({ ...bare, clubs: [], wreckage: [] }));
    expect(decodeMapLine(line, identity)).toEqual(bare);
  });
});
