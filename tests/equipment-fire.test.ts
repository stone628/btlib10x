import { buildUnitInit as buildUnitInitDist, createBattle } from "btlib10x";
import { describe, expect, it } from "vitest";
import { isFireableWeapon, weaponDef } from "../src/data/weapon.schema";
import { mechDefFor } from "../src/index";
import { suggestFireTargets } from "../src/rules/fireability";
import type { GameEvent } from "../src/rules/game";
import {
  advancePhase,
  buildUnitInit,
  declareAttacks,
  resolveAllAttacks,
  rollInitiativePhase,
  validateAttacksImpl,
} from "../src/rules/game";
import { usableWeapons } from "../web/terminal/persona.common";
import { createTestBattle, scriptedRng, seededRng } from "./helpers";

// Every chassis in the catalog that mounts a TAG, with the TAG's weapon index.
// TAG (TW pp.142-143) designates rather than damages and awaits the equipment
// pipeline (docs/VISION.md §4): it must never reach weapon-attack resolution,
// where a hit used to push a 0-damage group into `applyDamage` and throw.
const TAG_MOUNTS = [
  { model: "SL-1G", tag: 4 },
  { model: "SL-1H", tag: 4 },
  { model: "FFL-3A", tag: 9 },
  { model: "SPT-N2", tag: 1 },
] as const;

const ATTACKER = { col: 4, row: 6 };
const TARGET = { col: 4, row: 3 };

function setup(model: string) {
  const state = createTestBattle(
    [],
    [buildUnitInit("a", model, 1, ATTACKER, "n"), buildUnitInit("t", "ENF-4R", 2, TARGET, "s")],
    true,
  );
  rollInitiativePhase(state, scriptedRng(1, 1, 4, 4), []);
  advancePhase(state, [], scriptedRng());
  return state;
}

describe("equipment is not a fireable weapon", () => {
  it("treats every EQUIPMENT row as non-fireable and every other row as fireable", () => {
    for (const name of ["TAG", "CL TAG", "CL Narc Missile Beacon", "CL ECM Suite", "Hatchet"]) {
      expect(isFireableWeapon(weaponDef(name)!)).toBe(false);
    }
    for (const name of ["Medium Laser", "AC/20", "LRM 20", "CL Plasma Cannon"]) {
      expect(isFireableWeapon(weaponDef(name)!)).toBe(true);
    }
  });

  for (const { model, tag } of TAG_MOUNTS) {
    describe(model, () => {
      it("mounts the TAG at the expected index", () => {
        expect(mechDefFor(setup(model).units.a!).weapons[tag]!.weapon).toBe("TAG");
      });

      it("refuses a TAG declaration", () => {
        const decl = [{ weaponIndex: tag, targetId: "t" }];
        expect(() => validateAttacksImpl(setup(model), "a", decl)).toThrow(
          /TAG on a is equipment, not a fireable weapon/,
        );
        const state = setup(model);
        expect(() => declareAttacks(state, "a", decl, [], [], seededRng(1))).toThrow(
          /not a fireable weapon/,
        );
        expect(state.units.a!.declaredWeaponAttacks).toEqual([]);
      });

      it("leaves the TAG out of fire suggestions, fireable and blocked alike", () => {
        for (const target of suggestFireTargets(setup(model), "a").targets) {
          const listed = [
            ...target.weaponsIfPropLeft,
            ...target.weaponsIfPropRight,
            ...target.blocked,
          ];
          expect(listed.map((w) => w.weaponIndex)).not.toContain(tag);
        }
      });

      it("leaves the TAG out of the shell's usable weapons", () => {
        const state = createBattle({ name: "t", width: 9, height: 9, terrain: [], legends: [] }, [
          buildUnitInitDist("a", model, 1, ATTACKER, "n"),
          buildUnitInitDist("t", "ENF-4R", 2, TARGET, "s"),
        ]);
        const usable = usableWeapons(state.units.a!);
        expect(usable.length).toBeGreaterThan(0);
        expect(usable.map((w) => w.index)).not.toContain(tag);
      });

      it("still resolves every suggested weapon without throwing", () => {
        const state = setup(model);
        const target = suggestFireTargets(state, "a").targets.find((t) => t.targetId === "t")!;
        const decls = target.weaponsIfPropLeft.map((w) => ({
          weaponIndex: w.weaponIndex,
          targetId: "t",
        }));
        expect(decls.length).toBeGreaterThan(0);
        const events: GameEvent[] = [];
        declareAttacks(state, "a", decls, [], events, seededRng(2));
        expect(() =>
          resolveAllAttacks(state, scriptedRng(...Array(64).fill(6)), events),
        ).not.toThrow();
      });
    });
  }
});
