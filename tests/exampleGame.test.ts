import { describe, expect, it } from "vitest";
import {
  advancePhase,
  checkVictory,
  createBattle,
  declareAttacks,
  declareMove,
  executeMove,
  getUnit,
  nextActor,
  resolveDeclaredAttacks,
  rollInitiativePhase,
} from "../src/rules/game.js";
import type { BattleState } from "../src/rules/game.js";
import { scriptedRng } from "./helpers.js";

/**
 * Full battle reproducing the CBT Quick-Start "Rolling To Hit" diagram (p.6):
 * a Wolverine runs up to a Griffin through light woods and trades fire.
 *
 * Dice are fully scripted; every to-hit number below is derived by hand:
 *   T1 Wolverine ML: g4 + run2 + medium +2 = 8
 *   T1 Griffin PPC:  g3 + walk1 + wolverine-moved-4 (+1) + short +0 = 5
 *   T2+ Wolverine ML (both stand): g4 + medium +2 = 6
 */
function setup(): BattleState {
  return createBattle(
    [
      { id: "wvr", model: "WVR-6R", team: 0, gunnery: 4, position: { col: 0, row: 2 }, facing: "se" },
      { id: "grf", model: "GRF-1N", team: 1, gunnery: 3, position: { col: 8, row: 6 }, facing: "nw" },
    ],
    { terrain: { "2,3": "lightWoods" } },
  );
}

describe("example battle: Wolverine vs Griffin", () => {
  it("plays turn 1 exactly as the rulebook diagram describes", () => {
    let state = setup();

    // Initiative: WVR rolls 7 (3+4), GRF rolls 5 (2+3) -> team 0 wins.
    state = rollInitiativePhase(state, scriptedRng(3, 4, 2, 3));
    expect(state.initiativeWinnerTeam).toBe(0);

    // Movement phase: Wolverine runs 4 hexes southeast through the light woods.
    expect(nextActor(state)).toBe("grf");
    state = declareMove(state, "wvr", "run"); // running budget 8
    state = executeMove(state, "wvr", [
      { kind: "enter", to: { col: 1, row: 2 } },
      { kind: "enter", to: { col: 2, row: 3 } }, // light woods: costs 2
      { kind: "enter", to: { col: 3, row: 3 } },
      { kind: "enter", to: { col: 4, row: 4 } },
    ]);
    const wvr = getUnit(state, "wvr");
    expect(wvr.position).toEqual({ col: 4, row: 4 });
    expect(wvr.mpSpent).toBe(5);
    // Griffin walks in place (keeps the walked attacker modifier).
    state = declareMove(state, "grf", "walk");
    state = executeMove(state, "grf", []);

    // Weapon phase: Wolverine medium laser at range 4 (medium bracket).
    state = advancePhase(state); // movement -> weaponAttack
    state = declareAttacks(state, "wvr", [{ weaponIndex: 0, targetId: "grf" }]);
    // To-hit 11 >= TN 8; location roll 8 -> left torso; ML damage 5. LT 18 -> 13.
    state = resolveDeclaredAttacks(state, "wvr", scriptedRng(6, 5, 3, 5));
    expect(getUnit(state, "grf").armor["leftTorso"]).toBe(
      state.defs["GRF-1N"]!.armor["leftTorso"]! - 5,
    );

    // Griffin answers with its PPC: TN 5, rolls 4 -> miss, no damage.
    state = declareAttacks(state, "grf", [{ weaponIndex: 0, targetId: "wvr" }]);
    state = resolveDeclaredAttacks(state, "grf", scriptedRng(1, 3)); // miss
    expect(getUnit(state, "wvr").armor).toEqual(state.defs["WVR-6R"]!.armor);
  });

  it("fights through turn 6 until the Griffin loses its center torso", () => {
    let state = setup();
    const grfCt = (): number => getUnit(state, "grf").armor["centerTorso"] ?? -1;

    // ---- Turn 1 ----
    state = rollInitiativePhase(state, scriptedRng(3, 4, 2, 3));
    state = declareMove(state, "wvr", "run");
    state = executeMove(state, "wvr", [
      { kind: "enter", to: { col: 1, row: 2 } },
      { kind: "enter", to: { col: 2, row: 3 } },
      { kind: "enter", to: { col: 3, row: 3 } },
      { kind: "enter", to: { col: 4, row: 4 } },
    ]);
    state = declareMove(state, "grf", "walk");
    state = executeMove(state, "grf", []);
    state = advancePhase(state);
    state = declareAttacks(state, "wvr", [{ weaponIndex: 0, targetId: "grf" }]);
    state = resolveDeclaredAttacks(state, "wvr", scriptedRng(6, 5, 3, 5)); // LT hit
    state = declareAttacks(state, "grf", [{ weaponIndex: 0, targetId: "wvr" }]);
    state = resolveDeclaredAttacks(state, "grf", scriptedRng(1, 3)); // miss

    // ---- Turns 2..6: both stand still, Wolverine plinks the CT for 5 each.
    // Griffin starts at CT 24 -> five hits (19/14/9/4/dead).
    const ctStart = grfCt();
    expect(ctStart).toBe(state.defs["GRF-1N"]!.armor["centerTorso"]);
    for (let t = 2; t <= 6; t++) {
      state = advancePhase(state); // weaponAttack -> end
      state = advancePhase(state); // end -> initiative
      expect(state.turn).toBe(t);

      state = rollInitiativePhase(state, scriptedRng(3, 3, 3, 1)); // team 0 wins
      state = advancePhase(state); // -> weaponAttack (both skip moving)
      if (t < 6) {
        state = declareAttacks(state, "wvr", [{ weaponIndex: 0, targetId: "grf" }]);
        // 12 hits TN 8; location 7 -> center torso.
        state = resolveDeclaredAttacks(state, "wvr", scriptedRng(6, 6, 3, 4));
        expect(grfCt()).toBe(Math.max(ctStart - 5 * (t - 1), 0));
        expect(getUnit(state, "grf").destroyed).toBe(false);
      } else {
        // Final blow: CT armor 4, damage 5 -> destroyed.
        state = declareAttacks(state, "wvr", [{ weaponIndex: 0, targetId: "grf" }]);
        state = resolveDeclaredAttacks(state, "wvr", scriptedRng(6, 6, 3, 4));
        expect(grfCt()).toBe(0);
        expect(getUnit(state, "grf").destroyed).toBe(false); // committed at end of phase
      }
    }

    state = advancePhase(state); // weaponAttack -> end: kill committed
    expect(getUnit(state, "grf").destroyed).toBe(true);
    expect(getUnit(state, "grf").removed).toBe(true);
    expect(checkVictory(state)).toEqual({ winnerTeam: 0, draw: false });
    expect(state.events.filter((e) => e.kind === "unitRemoved")).toHaveLength(1);
  });
});
