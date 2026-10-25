/// <reference types="node" />
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Rng } from "../src/core/types";
import { appendCatalog, decodeMapLine } from "../src/data/catalog";
import { encodeMapDef, listMapNames, mapDef, mechDef } from "../src/data/index";
import { type MapDef, type MapDefSrc, validateMapDef } from "../src/data/map.schema";
import { clubTokensInHex, declarePickup } from "../src/rules/game/clubs";
import { buildUnitInit, createBattle } from "../src/rules/game/create";
import { hasWreckage, wreckageAt } from "../src/rules/game/queries";
import { resolveAllAttacks } from "../src/rules/game/resolveAttacks";
import type { GameEvent, UnitInit } from "../src/rules/game/types";
import { loadBattleState, saveBattleState } from "../src/rules/snapshot";
import { createTestBattle } from "./helpers/battle";

/**
 * Map-declared severed limbs and wreckage: validation, battle seeding, the
 * packed wire form, and parity with debris left during play.
 */

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

describe("createBattle registers catalog models on demand (DATA-04)", () => {
  // A one-'Mech pack: the base AS7-D sheet under a model id the suite setup
  // has not registered, like a pack 'Mech nobody has fielded yet.
  const BASE = readFileSync(new URL("../data/btlib10x.jsonl", import.meta.url), "utf8").split("\n");
  appendCatalog(
    [BASE[0], '{v:1,mechs:[{m:"AS7-DX",n:0,b:1,t:100,i:2755,v:1897,l:2}],maps:[]}', BASE[2]].join(
      "\n",
    ),
    "data04",
    () => {},
  );
  const units = (model: string) => [
    buildUnitInit("a", model, 1, { col: 5, row: 5 }, "n"),
    buildUnitInit("b", "ENF-4R", 2, { col: 1, row: 1 }, "n"),
  ];
  const debrisMap = (model: string): MapDef => ({
    ...SRC,
    legends: [],
    clubs: [{ col: 4, row: 4, model, limb: "leftArm" }],
    wreckage: [{ col: 2, row: 2, model }],
  });

  it("accepts map wreckage and clubs of a catalog 'Mech nobody has fielded", () => {
    expect(mechDef("AS7-DX")).toBeUndefined();
    const battle = createBattle(debrisMap("AS7-DX"), units("HBK-4G"));
    expect(wreckageAt(battle, { col: 2, row: 2 })).toEqual([{ model: "AS7-DX", unitId: null }]);
    expect(battle.clubs["4,4"]).toEqual([
      { kind: "limb", limb: "leftArm", model: "AS7-DX", ownerId: null },
    ]);
    expect(mechDef("AS7-DX")?.tonnage).toBe(100);
  });

  it("accepts a unit of such a model", () => {
    const battle = createBattle({ ...SRC, legends: [] }, units("AS7-DX"));
    expect(battle.units.a!.model).toBe("AS7-DX");
  });

  it("still refuses unknown and wrong-case models", () => {
    expect(() => createBattle(debrisMap("as7-dx"), units("HBK-4G"))).toThrow(
      /Unknown 'Mech model for club at 4,4: as7-dx/,
    );
    expect(() =>
      createBattle(
        { ...SRC, legends: [], clubs: [], wreckage: [{ col: 2, row: 2, model: "as7-dx" }] },
        units("HBK-4G"),
      ),
    ).toThrow(/Unknown 'Mech model for wreckage at 2,2: as7-dx/);
    expect(() => createBattle({ ...SRC, legends: [] }, units("as7-dx"))).toThrow(
      "Unknown 'Mech model: as7-dx",
    );
    expect(() => createBattle({ ...SRC, legends: [] }, units("NOPE"))).toThrow(
      "Unknown 'Mech model: NOPE",
    );
  });
});

describe("mapdata", () => {
  const valid: MapDefSrc = {
    name: "test-map",
    width: 5,
    height: 4,
    terrain: [
      { col: 3, row: 3, type: "lightWoods" },
      { col: 5, row: 4, type: "heavyWoods" },
    ],
  };

  describe("validateMapDef", () => {
    it("accepts a well-formed map", () => {
      expect(() => validateMapDef(valid)).not.toThrow();
    });

    it("rejects bad dimensions", () => {
      expect(() => validateMapDef({ ...valid, width: 0 } as MapDef)).toThrow(
        /width must be a positive integer/,
      );
      expect(() => validateMapDef({ ...valid, height: 2.5 } as MapDef)).toThrow(
        /height must be a positive integer/,
      );
    });

    it("rejects malformed terrain entries and unknown types", () => {
      expect(() =>
        validateMapDef({
          ...valid,
          terrain: [{ col: 1.5, row: 1, type: "lightWoods" }],
        } as MapDefSrc),
      ).toThrow(/terrain\[0\].col must be an integer/);
    });

    it("enforces 1-based board bounds", () => {
      const errors = (terrain: MapDefSrc["terrain"]): string =>
        (() => {
          try {
            validateMapDef({ ...valid, terrain });
            return "";
          } catch (e) {
            return (e as Error).message;
          }
        })();
      expect(errors([{ col: 0, row: 3, type: "clear" }])).toMatch(
        /col 0 outside board bounds 1\.\.5/,
      );
      expect(errors([{ col: 6, row: 3, type: "clear" }])).toMatch(
        /col 6 outside board bounds 1\.\.5/,
      );
      expect(errors([{ col: 3, row: 5, type: "clear" }])).toMatch(
        /row 5 outside board bounds 1\.\.4/,
      );
      // Boundary hexes are legal.
      expect(errors([{ col: 5, row: 4, type: "heavyWoods" }])).toBe("");
    });

    it("rejects duplicate hexes", () => {
      expect(() =>
        validateMapDef({
          ...valid,
          terrain: [
            { col: 1, row: 1, type: "lightWoods" },
            { col: 1, row: 1, type: "heavyWoods" },
          ],
        }),
      ).toThrow(/duplicates hex 1,1/);
    });

    it("accepts an optional non-negative integer `level` per hex", () => {
      const withLevel: MapDef = {
        name: "test-map",
        width: 5,
        height: 4,
        terrain: [
          { col: 3, row: 3, type: "clear", level: 2 },
          { col: 4, row: 3, type: "clear" },
        ],
        legends: ["clear"],
      };
      expect(() => validateMapDef(withLevel)).not.toThrow();
    });

    it("rejects malformed `level`", () => {
      expect(() =>
        validateMapDef({
          ...valid,
          terrain: [{ col: 3, row: 3, type: "clear", level: -1 }],
        }),
      ).toThrow(/level must be a non-negative integer/);
      expect(() =>
        validateMapDef({
          ...valid,
          terrain: [{ col: 3, row: 3, type: "clear", level: 1.5 }],
        }),
      ).toThrow(/level must be a non-negative integer/);
    });
  });

  describe("bundled maps", () => {
    it("loads both rulebook maps with expected dimensions and hex counts", () => {
      expect(listMapNames().sort()).toEqual(["beginner", "quickstart", "test", "testground"]);
      for (const name of ["beginner", "quickstart"]) {
        const map = mapDef(name)!;
        expect(map.width).toBe(15);
        expect(map.height).toBe(16);
        expect(map.terrain.length).toBeGreaterThan(0);
        for (const h of map.terrain) {
          expect(h.col).toBeGreaterThanOrEqual(1);
          expect(h.col).toBeLessThanOrEqual(map.width);
          expect(h.row).toBeGreaterThanOrEqual(1);
          expect(h.row).toBeLessThanOrEqual(map.height);
        }
      }
      expect(mapDef("beginner")!.terrain).toHaveLength(20);
      expect(mapDef("quickstart")!.terrain).toHaveLength(31);
      expect(mapDef("beginner")!.terrain[0]).toEqual({ col: 2, row: 5, type: "heavyWoods" });
    });

    it("is directly usable by createBattle (no conversion layer)", () => {
      expect(mapDef("beginner")!.terrain[0]).toEqual({ col: 2, row: 5, type: "heavyWoods" });
      const quickstart = mapDef("quickstart")!;
      const units: UnitInit[] = [
        buildUnitInit("a", "HBK-4G", 1, { col: 2, row: 4 }, "se"),
        buildUnitInit("b", "GRF-1N", 2, { col: 10, row: 8 }, "nw", 3),
      ];
      expect(() =>
        createTestBattle(quickstart.terrain, units, false, quickstart.width, quickstart.height),
      ).not.toThrow();
    });
  });
});
