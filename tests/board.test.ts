import { describe, expect, it } from "vitest";
import {
  bearingExact,
  hexDistance,
  isAdjacent,
  lineHexes,
  neighbor,
  sameHex,
} from "../src/core/hex";
import {
  blocksTargeting,
  cellAt,
  costToEnter,
  type HexGrid,
  hasPartialCover,
  hexCell,
  screeningPoints,
  terrainMoveCost,
  terrainTargetMod,
} from "../src/core/terrain";
import {
  type Facing,
  type HexCell,
  oppositeFacing,
  rotateFacing,
  TERRAIN_TYPES,
  type TerrainType,
} from "../src/core/types";
import { allTerrainDefs } from "../src/data/terrain.schema";
import { loadBattleState, parseBattleState, saveBattleState } from "../src/index";
import {
  classifyArc,
  classifyArcWithBoundary,
  classifyFiringArc,
  defenderArcChoice,
  weaponCanFireIntoArc,
} from "../src/rules/arcs";
import { buildUnitInit, damageBuildingAt } from "../src/rules/game";
import { losBlocked, losWoodsPoints } from "../src/rules/los";
import {
  attackerMovementModifier,
  canEndMoveInHex,
  canPassThroughHex,
  facingChangeCost,
  maxMovePoints,
} from "../src/rules/movement";
import { bearing, createTestBattle } from "./helpers";

describe("movement rules", () => {
  it("computes MP budgets per movement mode", () => {
    expect(maxMovePoints("standStill", 4, 6, 0)).toBe(0);
    expect(maxMovePoints("walk", 4, 6, 0)).toBe(4);
    expect(maxMovePoints("run", 4, 6, 0)).toBe(6);
    expect(maxMovePoints("jump", 5, 8, 5)).toBe(5);
  });

  it("charges terrain and facing costs", () => {
    expect(facingChangeCost(3)).toBe(3);
    // Heavy woods hex: base 1 + 2 = 3 MP (Total Warfare p.52 example says 4 with a
    // one-hexside turn included).
    expect(facingChangeCost(1) + 3).toBe(4);
  });

  it("applies attacker movement modifiers (walk +1, run +2, jump +3)", () => {
    expect(attackerMovementModifier("standStill")).toBe(0);
    expect(attackerMovementModifier("walk")).toBe(1);
    expect(attackerMovementModifier("run")).toBe(2);
    expect(attackerMovementModifier("jump")).toBe(3);
  });

  it("enforces stacking pass-through vs ending rules", () => {
    expect(canPassThroughHex(undefined, 1)).toBe(true);
    expect(canPassThroughHex(1, 1)).toBe(true);
    expect(canPassThroughHex(2, 1)).toBe(false);
    expect(canEndMoveInHex(undefined, 1)).toBe(true);
    expect(canEndMoveInHex(1, 1)).toBe(false);
    expect(canEndMoveInHex(2, 1)).toBe(false);
  });
});

describe("line of sight", () => {
  it("blocks at three or more woods points", () => {
    expect(losWoodsPoints(["lightWoods", "lightWoods"])).toBe(2);
    expect(losBlocked(losWoodsPoints(["lightWoods", "lightWoods"]))).toBe(false);
    expect(losBlocked(losWoodsPoints(["lightWoods", "lightWoods", "lightWoods"]))).toBe(true);
    expect(losBlocked(losWoodsPoints(["heavyWoods"]))).toBe(false);
    expect(losBlocked(losWoodsPoints(["heavyWoods", "heavyWoods"]))).toBe(true);
    expect(losBlocked(losWoodsPoints(["heavyWoods", "lightWoods"]))).toBe(true);
  });
});

describe("firing arcs", () => {
  it("classifies all four arcs clockwise from facing", () => {
    // 'Mech attack direction (TW p.119): 3-1-1-1 — front spans the front
    // hexside plus the two front-diagonal hexsides; each side is a single
    // rear-diagonal hexside.
    expect(classifyArc("n", "n")).toBe("front");
    expect(classifyArc("n", "ne")).toBe("front");
    expect(classifyArc("n", "se")).toBe("rightSide");
    expect(classifyArc("n", "s")).toBe("rear");
    expect(classifyArc("n", "sw")).toBe("leftSide");
    expect(classifyArc("n", "nw")).toBe("front");
    expect(classifyArc("se", "n")).toBe("leftSide");
    expect(classifyArc("se", "se")).toBe("front");
    expect(classifyArc("se", "nw")).toBe("rear");
  });
});

describe("TW p.105 firing-arc template", () => {
  // Attacker on 0509 facing north: every hex within radius 2 falls wholly
  // in one arc (the template has no boundary hexes).
  const origin = { col: 5, row: 9 };
  const expected: Record<string, "front" | "rear" | "leftSide" | "rightSide"> = {
    "5,7": "front",
    "4,7": "front",
    "6,7": "front",
    "3,8": "front",
    "5,8": "front",
    "7,8": "front",
    "4,8": "front",
    "6,8": "front",
    "3,9": "leftSide",
    "4,9": "leftSide",
    "3,10": "leftSide",
    "7,9": "rightSide",
    "6,9": "rightSide",
    "7,10": "rightSide",
    "5,10": "rear",
    "4,10": "rear",
    "6,10": "rear",
    "5,11": "rear",
  };

  it("places each hex within radius 2 of 0509 facing n in its book arc", () => {
    expect(Object.keys(expected)).toHaveLength(18);
    for (const [key, arc] of Object.entries(expected)) {
      const [col, row] = key.split(",").map(Number);
      expect(classifyFiringArc(origin, { col: col!, row: row! }, "n")).toBe(arc);
    }
  });

  it("returns null for a target in the attacker's own hex", () => {
    expect(classifyFiringArc(origin, origin, "n")).toBeNull();
  });

  it("keeps adjacent split 3-1-1-1 around every facing", () => {
    const forward: Record<Facing, Facing[]> = {
      n: ["n", "ne", "nw"],
      ne: ["ne", "n", "se"],
      se: ["se", "ne", "s"],
      s: ["s", "se", "sw"],
      sw: ["sw", "s", "nw"],
      nw: ["nw", "sw", "n"],
    };
    const facings: Facing[] = ["n", "ne", "se", "s", "sw", "nw"];
    for (const facing of facings) {
      const sides = new Set(facings);
      for (const f of forward[facing]!) sides.delete(f);
      // The three forward-adjacent hexes read front.
      for (const f of forward[facing]!) {
        expect(classifyFiringArc(origin, neighbor(origin, f), facing)).toBe("front");
      }
      // The directly rear hex reads rear.
      const rear =
        facing === "n"
          ? "s"
          : facing === "ne"
            ? "sw"
            : facing === "se"
              ? "nw"
              : facing === "s"
                ? "n"
                : facing === "sw"
                  ? "ne"
                  : "se";
      expect(classifyFiringArc(origin, neighbor(origin, rear), facing)).toBe("rear");
      sides.delete(rear);
      // The two remaining adjacent hexes read opposite sides.
      expect(sides.size).toBe(2);
      const sideArcs = new Set(
        [...sides].map((f) => classifyFiringArc(origin, neighbor(origin, f), facing)),
      );
      expect([...sideArcs].sort()).toEqual(["leftSide", "rightSide"]);
    }
  });

  it("holds the template corridors at longer range", () => {
    // Straight ahead / behind from 0509 facing n.
    expect(classifyFiringArc(origin, { col: 5, row: 5 }, "n")).toBe("front");
    expect(classifyFiringArc(origin, { col: 5, row: 13 }, "n")).toBe("rear");
    // Far flanks stay on their side.
    expect(classifyFiringArc(origin, { col: 1, row: 9 }, "n")).toBe("leftSide");
    expect(classifyFiringArc(origin, { col: 9, row: 9 }, "n")).toBe("rightSide");
  });
});

describe("per-weapon firing arcs (TW p.105)", () => {
  it("restricts head/leg/front-torso weapons to the front arc", () => {
    for (const loc of [
      "head",
      "centerTorso",
      "rightTorso",
      "leftTorso",
      "rightLeg",
      "leftLeg",
    ] as const) {
      expect(weaponCanFireIntoArc(loc, false, "front")).toBe(true);
      expect(weaponCanFireIntoArc(loc, false, "rear")).toBe(false);
      expect(weaponCanFireIntoArc(loc, false, "leftSide")).toBe(false);
      expect(weaponCanFireIntoArc(loc, false, "rightSide")).toBe(false);
    }
  });

  it("lets arm weapons cover the front and their own side arc", () => {
    expect(weaponCanFireIntoArc("rightArm", false, "front")).toBe(true);
    expect(weaponCanFireIntoArc("rightArm", false, "rightSide")).toBe(true);
    expect(weaponCanFireIntoArc("rightArm", false, "leftSide")).toBe(false);
    expect(weaponCanFireIntoArc("rightArm", false, "rear")).toBe(false);
    expect(weaponCanFireIntoArc("leftArm", false, "front")).toBe(true);
    expect(weaponCanFireIntoArc("leftArm", false, "leftSide")).toBe(true);
    expect(weaponCanFireIntoArc("leftArm", false, "rightSide")).toBe(false);
    expect(weaponCanFireIntoArc("leftArm", false, "rear")).toBe(false);
  });

  it("fires rear-facing torso weapons into the rear arc only", () => {
    expect(weaponCanFireIntoArc("centerTorso", true, "rear")).toBe(true);
    expect(weaponCanFireIntoArc("centerTorso", true, "front")).toBe(false);
    expect(weaponCanFireIntoArc("centerTorso", true, "leftSide")).toBe(false);
    expect(weaponCanFireIntoArc("rightTorso", true, "rear")).toBe(true);
    expect(weaponCanFireIntoArc("leftTorso", true, "front")).toBe(false);
  });

  it("resolves boundary-line ambiguity to the defender's dominant choice", () => {
    // Engine policy tied to TW p.119 (locked-in LOS hexside) — see
    // defenderArcChoice docstring. `front` wins; otherwise drop `rear`.
    expect(defenderArcChoice("front", null)).toBe("front");
    expect(defenderArcChoice("front", "leftSide")).toBe("front");
    expect(defenderArcChoice("leftSide", "front")).toBe("front");
    expect(defenderArcChoice("rear", "rightSide")).toBe("rightSide");
    expect(defenderArcChoice("leftSide", "rear")).toBe("leftSide");
    expect(defenderArcChoice("rear", "leftSide")).toBe("leftSide");
    expect(defenderArcChoice("rightSide", "rear")).toBe("rightSide");
  });

  it("classifies both arcs of a boundary pair", () => {
    // (2,4) -> (3,3) runs exactly along the n|ne sector edge: front on n,
    // right side on ne when facing northwest ('Mech 3-1-1-1).
    const b = bearingExact({ col: 2, row: 4 }, { col: 3, row: 3 })!;
    expect(b.boundary).not.toBeNull();
    const cls = classifyArcWithBoundary("nw", b);
    expect(cls.arc).toBe("front");
    expect(cls.altArc).toBe("rightSide");
  });
});

describe("hex", () => {
  describe("hex geometry", () => {
    it("computes even-q neighbors on flat-top hexes (even cols lowered)", () => {
      // even columns sit half a hex lower (matching the renderer stagger). An
      // even-col 'ne' steps one col over at the same row; 'se' steps one col
      // over and one row down.
      const evenCol = { col: 4, row: 4 };
      expect(sameHex(neighbor(evenCol, "n"), { col: 4, row: 3 })).toBe(true);
      expect(sameHex(neighbor(evenCol, "s"), { col: 4, row: 5 })).toBe(true);
      expect(sameHex(neighbor(evenCol, "ne"), { col: 5, row: 4 })).toBe(true);
      expect(sameHex(neighbor(evenCol, "se"), { col: 5, row: 5 })).toBe(true);
      expect(sameHex(neighbor(evenCol, "nw"), { col: 3, row: 4 })).toBe(true);
      expect(sameHex(neighbor(evenCol, "sw"), { col: 3, row: 5 })).toBe(true);

      // odd columns sit half a hex higher. An odd-col 'ne' steps one col over
      // and one row up; 'se' steps one col over at the same row.
      const oddCol = { col: 5, row: 4 };
      expect(sameHex(neighbor(oddCol, "n"), { col: 5, row: 3 })).toBe(true);
      expect(sameHex(neighbor(oddCol, "s"), { col: 5, row: 5 })).toBe(true);
      expect(sameHex(neighbor(oddCol, "ne"), { col: 6, row: 3 })).toBe(true);
      expect(sameHex(neighbor(oddCol, "se"), { col: 6, row: 4 })).toBe(true);
      expect(sameHex(neighbor(oddCol, "nw"), { col: 4, row: 3 })).toBe(true);
      expect(sameHex(neighbor(oddCol, "sw"), { col: 4, row: 4 })).toBe(true);
    });

    it("measures distance in hexes", () => {
      expect(hexDistance({ col: 3, row: 3 }, { col: 3, row: 3 })).toBe(0);
      expect(hexDistance({ col: 3, row: 3 }, { col: 4, row: 3 })).toBe(1);
      expect(hexDistance({ col: 3, row: 3 }, { col: 5, row: 5 })).toBe(3);
    });

    it("traces straight lines excluding endpoints", () => {
      // Straight lines run along columns on flat-top grids.
      const line = lineHexes({ col: 3, row: 3 }, { col: 3, row: 8 });
      expect(line).toHaveLength(4);
      expect(line[0]).toEqual({ col: 3, row: 4 });
      expect(line[3]).toEqual({ col: 3, row: 7 });
    });

    it("approximates bearing toward non-adjacent hexes consistently with adjacency", () => {
      const from = { col: 7, row: 7 };
      const north = neighbor(from, "n");
      expect(bearing(from, north)).toBe("n");
      const southwest = neighbor(from, "sw");
      expect(bearing(from, southwest)).toBe("sw");

      expect(bearing({ col: 2, row: 2 }, { col: 2, row: -2 })).toBe("n");
      expect(bearing({ col: 2, row: 2 }, { col: 2, row: 6 })).toBe("s");
      expect(bearing({ col: 2, row: 2 }, { col: 2, row: 2 })).toBeNull();
    });

    it("computes exact bearings on the true flat-top pixel angle", () => {
      // Cube delta (4, 3, -7): true angle atan2(6, 5√3)=34.7° (past the 30°
      // wedge edge), so the exact sector is ne — the old atan2(dx, -dz)
      // approximation gave n (29.7°).
      expect(bearingExact({ col: 5, row: 5 }, { col: 9, row: 0 })).toEqual({
        facing: "ne",
        boundary: null,
      });
      // Cube delta (1, 1, -2) lies exactly on the n|ne sector edge.
      const edge = bearingExact({ col: 2, row: 4 }, { col: 3, row: 3 })!;
      expect(edge.boundary).not.toBeNull();
      expect(new Set([edge.facing, edge.boundary])).toEqual(new Set(["n", "ne"]));
    });

    it("reports adjacency symmetrically and excludes far hexes", () => {
      const a = { col: 5, row: 5 };
      expect(isAdjacent(a, a)).toBe(true);
      for (const f of ["n", "s", "ne", "se", "nw", "sw"] as const) {
        expect(isAdjacent(a, neighbor(a, f))).toBe(true);
      }
      expect(isAdjacent(a, { col: 6, row: 7 })).toBe(false);
      expect(isAdjacent(a, { col: 2, row: 2 })).toBe(false);
    });

    it("reads a cell off a grid and defaults to clear/level 0", () => {
      const width = 5;
      const height = 5;
      const cells: HexCell[] = new Array<HexCell>(width * height).fill({
        terrain: "clear",
        level: 0,
      });
      const grid: HexGrid = { cells, width, height };
      const hex = { col: 4, row: 5 };
      expect(cellAt(grid, hex).level).toBe(0);
      expect(cellAt(grid, hex).terrain).toBe("clear");
      // col 4, row 5 maps to index (4-1)+(5-1)*5 = 23
      cells[23] = { terrain: "lightWoods", level: 2 };
      expect(cellAt(grid, hex).level).toBe(2);
      expect(cellAt(grid, hex).terrain).toBe("lightWoods");
    });
  });
});

describe("hexcell", () => {
  function battle() {
    return createTestBattle(
      [
        { col: 3, row: 3, type: "lightBuilding", level: 1 },
        { col: 4, row: 3, type: "heavyWoods" },
      ],
      [
        buildUnitInit("a", "HBK-4G", 1, { col: 1, row: 1 }, "n"),
        buildUnitInit("b", "ENF-4R", 2, { col: 6, row: 6 }, "s"),
      ],
      true,
    );
  }

  describe("hexCell registry", () => {
    it("returns one shared instance per terrain/level pair", () => {
      expect(hexCell("clear")).toBe(hexCell("clear", 0));
      expect(hexCell("clear", 1)).not.toBe(hexCell("clear", 0));
      expect(hexCell("lightWoods")).not.toBe(hexCell("heavyWoods"));
      expect(hexCell("lightWoods", 2)).toEqual({ terrain: "lightWoods", level: 2 });
    });

    it("createBattle shares cells within and across battles", () => {
      const a = battle();
      const b = battle();
      expect(a.cells[0]).toBe(hexCell("clear"));
      expect(a.cells[0]).toBe(a.cells[1]);
      expect(a.cells[0]).toBe(b.cells[0]);
      expect(a.cells[2 + 2 * a.width]).toBe(hexCell("lightBuilding", 1));
    });

    it("stores the shared rubble cell when a building collapses", () => {
      const state = battle();
      damageBuildingAt(state, { col: 3, row: 3 }, 999, []);
      expect(state.cells[2 + 2 * state.width]).toBe(hexCell("rubble", 1));
    });

    it("snapshot load restores shared instances", () => {
      const state = battle();
      const snap = saveBattleState(state);
      damageBuildingAt(state, { col: 3, row: 3 }, 999, []);
      loadBattleState(state, snap);
      state.cells.forEach((cell) => {
        expect(cell).toBe(hexCell(cell.terrain, cell.level));
      });
      expect(state.cells[2 + 2 * state.width]).toBe(hexCell("lightBuilding", 1));
      expect(parseBattleState(snap)).toEqual(state);
    });
  });
});

describe("facing", () => {
  describe("facing helpers", () => {
    it("rotates with wrap-around in both directions", () => {
      expect(rotateFacing("n", 1)).toBe("ne");
      expect(rotateFacing("n", -1)).toBe("nw");
      expect(rotateFacing("se", 1)).toBe("s");
      expect(rotateFacing("ne", 2)).toBe("s");
      expect(rotateFacing("s", 6)).toBe("s");
    });

    it("opposite is a half turn", () => {
      expect(oppositeFacing("n")).toBe("s");
      expect(oppositeFacing("ne")).toBe("sw");
      expect(oppositeFacing("se")).toBe("nw");
      expect(oppositeFacing(oppositeFacing("sw"))).toBe("sw");
    });
  });
});

describe("terrainCatalog", () => {
  describe("terrain catalog integrity", () => {
    it("defines every TerrainType with a catalog entry", () => {
      const catalog = allTerrainDefs();
      for (const t of TERRAIN_TYPES) {
        expect(catalog.has(t), `missing catalog entry for ${t}`).toBe(true);
      }
    });
  });

  describe("costToEnter", () => {
    it("costs the base 1 MP plus the terrain surcharge", () => {
      expect(costToEnter("clear")).toBe(1);
      expect(costToEnter("rough")).toBe(2);
      expect(costToEnter("heavyWoods")).toBe(3);
    });
  });

  describe("core rulebook terrain values", () => {
    it("wood types provide screening and to-hit modifiers", () => {
      expect(screeningPoints("lightWoods")).toBe(1);
      expect(screeningPoints("heavyWoods")).toBe(2);
      expect(terrainTargetMod("lightWoods")).toBe(1);
      expect(terrainTargetMod("heavyWoods")).toBe(2);
    });

    it("clear / rough / rubble provide no screening or to-hit mod", () => {
      for (const t of ["clear", "rough", "rubble"] as const) {
        expect(screeningPoints(t)).toBe(0);
        expect(terrainTargetMod(t)).toBe(0);
      }
    });

    it("water1 grants partial cover (no standalone target mod)", () => {
      expect(terrainTargetMod("water1")).toBe(0);
      expect(hasPartialCover("water1")).toBe(true);
    });

    it("water2 and water3 block targeting in/out", () => {
      expect(blocksTargeting("water2")).toBe(true);
      expect(blocksTargeting("water3")).toBe(true);
      expect(blocksTargeting("water1")).toBe(false);
    });

    it("building types grant partial cover and have escalating MP costs", () => {
      const costs: Partial<Record<TerrainType, number>> = {
        lightBuilding: 1,
        mediumBuilding: 2,
        heavyBuilding: 3,
        hardenedBuilding: 4,
      };
      for (const type of Object.keys(costs) as TerrainType[]) {
        expect(terrainMoveCost(type)).toBe(costs[type]);
        expect(hasPartialCover(type)).toBe(true);
      }
    });
  });
});
