import { describe, expect, it } from "vitest";
import { getMechDef } from "../src/data/index.js";
import type { BattleState, UnitInit } from "../src/rules/game.js";
import {
  advancePhase,
  checkVictory,
  declareAttacks,
  declareMove,
  executeMove,
  getUnit,
  nextActor,
  resolveAllAttacks,
  rollInitiativePhase,
} from "../src/rules/game.js";
import { createTestBattle, scriptedRng } from "./helpers.js";

/**
 * Full battle reproducing the Total Warfare "Rolling To Hit" diagram (p.6):
 * a Wolverine closes on a Griffin and trades fire through light woods.
 *
 * Dice are fully scripted; every to-hit number below is derived by hand:
 *   T1 Wolverine ML: g4 + run2 + woods1 + long4 = 11
 *   T1 Griffin PPC:  g3 + walk1 + wolverine-moved-0 + woods1 + long4 = 9
 *   T2+ Wolverine ML (both stand): g4 + woods1 + long4 = 9
 */
function setup(): BattleState {
  const units: UnitInit[] = [
    {
      id: "wvr",
      model: "WVR-6R",
      team: 0,
      gunnery: 4,
      position: { col: 3, row: 5 },
      facing: "se",
    },
    {
      id: "grf",
      model: "GRF-1N",
      team: 1,
      gunnery: 3,
      position: { col: 11, row: 8 },
      facing: "nw",
    },
  ];
  return createTestBattle([{ col: 7, row: 7, type: "lightWoods" }], units, true);
}

describe("example battle: Wolverine vs Griffin", () => {
  it("plays turn 1 exactly as the rulebook diagram describes", () => {
    const state = setup();

    // Initiative: WVR rolls 7 (3+4), GRF rolls 5 (2+3) -> team 0 wins.
    rollInitiativePhase(state, scriptedRng(3, 4, 2, 3));
    expect(state.initiativeWinnerTeam).toBe(0);

    // Movement phase: Wolverine runs southeast into (4,5), turns south
    // (1 MP), steps south into (4,6), and squares up southeast (1 MP) -
    // 4 of the 8-MP run budget.
    expect(nextActor(state)).toBe("grf");
    declareMove(state, "wvr", "run"); // running budget 8
    executeMove(state, "wvr", [
      { kind: "enter", to: { col: 4, row: 5 } }, // forward (se)
      { kind: "turn", facings: 1 }, // se -> s
      { kind: "enter", to: { col: 4, row: 6 } }, // forward (s)
      { kind: "turn", facings: -1 }, // s -> se (counterclockwise; target in front arc)
    ]);
    const wvr = getUnit(state, "wvr");
    expect(wvr.position).toEqual({ col: 4, row: 6 });
    expect(wvr.mpSpent).toBe(4);
    // Griffin walks in place (keeps the walked attacker modifier).
    declareMove(state, "grf", "walk");
    executeMove(state, "grf", []);

    // Weapon phase: Wolverine medium laser at range 7 (long bracket); the
    // light woods between at (7,7) add +1 -> TN 11.
    advancePhase(state); // movement -> weaponAttack
    declareAttacks(state, "wvr", [{ weaponIndex: 1, targetId: "grf" }]);
    // To-hit 11 >= TN 11; location roll 8 -> left torso; ML damage 5. LT 18 -> 13.
    resolveAllAttacks(state, scriptedRng(6, 5, 3, 5));
    expect(getUnit(state, "grf").damage.armor.leftTorso).toBe(
      getMechDef("GRF-1N")!.armor.leftTorso! - 5,
    );

    // Griffin answers with its PPC: TN 9, rolls 4 -> miss, no damage.
    declareAttacks(state, "grf", [{ weaponIndex: 2, targetId: "wvr" }]);
    resolveAllAttacks(state, scriptedRng(1, 3)); // miss
    expect(getUnit(state, "wvr").damage.armor).toEqual(getMechDef("WVR-6R")!.armor);
  });

  it("fights through turn 6 until the Griffin loses its center torso", () => {
    const state = setup();
    const grfCt = (): number => getUnit(state, "grf").damage.armor.centerTorso ?? -1;

    // ---- Turn 1 ----
    rollInitiativePhase(state, scriptedRng(3, 4, 2, 3));
    declareMove(state, "wvr", "run");
    executeMove(state, "wvr", [
      { kind: "enter", to: { col: 4, row: 5 } },
      { kind: "turn", facings: 1 },
      { kind: "enter", to: { col: 4, row: 6 } },
      { kind: "turn", facings: -1 },
    ]);
    declareMove(state, "grf", "walk");
    executeMove(state, "grf", []);
    advancePhase(state);
    declareAttacks(state, "wvr", [{ weaponIndex: 1, targetId: "grf" }]);
    resolveAllAttacks(state, scriptedRng(6, 5, 3, 5)); // LT hit
    declareAttacks(state, "grf", [{ weaponIndex: 2, targetId: "wvr" }]);
    resolveAllAttacks(state, scriptedRng(1, 3)); // miss

    // ---- Turns 2..10: both stand still, Wolverine plinks the CT for 5 each.
    // Griffin front CT is 27 -> 6 hits reach 0 armor, then 18 IS needs 4 more
    // hits (3 to drop to 5, final hit to destroy).
    const ctFront = getMechDef("GRF-1N")!.armor.centerTorso;
    expect(grfCt()).toBe(ctFront);
    for (let t = 2; t <= 10; t++) {
      advancePhase(state); // weaponAttack -> end
      advancePhase(state); // end -> initiative
      expect(state.turn).toBe(t);

      rollInitiativePhase(state, scriptedRng(3, 3, 3, 1)); // team 0 wins
      advancePhase(state); // -> weaponAttack (both skip moving)
      if (t < 10) {
        declareAttacks(state, "wvr", [{ weaponIndex: 1, targetId: "grf" }]);
        // 12 hits TN 9; location 7 -> center torso.
        resolveAllAttacks(state, scriptedRng(6, 6, 3, 4));
        const hitsDone = t - 1;
        expect(grfCt()).toBe(Math.max(ctFront - 5 * hitsDone, 0));
        expect(getUnit(state, "grf").destroyed).toBe(false);
      } else {
        // Final blow: front armor gone, CT IS 5, damage 5 -> structure destroyed.
        declareAttacks(state, "wvr", [{ weaponIndex: 1, targetId: "grf" }]);
        resolveAllAttacks(state, scriptedRng(6, 6, 3, 4));
        expect(grfCt()).toBe(0);
        expect(getUnit(state, "grf").destroyed).toBe(true); // killed immediately
        expect(getUnit(state, "grf").removed).toBe(true);
      }
    }

    advancePhase(state); // weaponAttack -> end: kill committed
    expect(getUnit(state, "grf").destroyed).toBe(true);
    expect(getUnit(state, "grf").removed).toBe(true);
    expect(checkVictory(state)).toEqual({ winnerTeam: 0, draw: false });
    expect(state.events.filter((e) => e.kind === "unitRemoved")).toHaveLength(1);
  });
});
