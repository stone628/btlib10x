import { describe, expect, it } from "vitest";
import type { TerrainType } from "../src/core/types";
import { mechDefFor } from "../src/index";
import { setSlotDestroyed } from "../src/rules/critical";
import {
  advancePhase,
  buildUnitInit,
  createBattle,
  type GameEvent,
  requireUnit,
} from "../src/rules/game";
import { createTestBattle, scriptedRng } from "./helpers";

// CRIT-09: destroyed life support also takes out the internal air supply
// (TW p.127). A 'Mech submerged in the End Phase (depth 2+ water, or prone
// in depth 1+) deals its MechWarrior 1 hit.

function hbkIn(terrain: TerrainType, lifeSupport: boolean) {
  const state = createTestBattle(
    [{ col: 2, row: 2, type: terrain }],
    [
      buildUnitInit("hbk", "HBK-4G", 1, { col: 2, row: 2 }, "s"),
      buildUnitInit("enf", "ENF-4R", 2, { col: 4, row: 4 }, "n"),
    ],
    true,
  );
  const hbk = requireUnit(state, "hbk");
  if (lifeSupport) {
    mechDefFor(hbk).critSlots.head.forEach((slot, i) => {
      if (slot?.kind === "structure" && slot.type === "lifeSupport") {
        setSlotDestroyed(hbk.critSlotsDestroyed, "head", i);
      }
    });
  }
  return { state, hbk };
}

/** Leave the End Phase of the current turn; consciousness roll 6+6. */
function endTurn(state: ReturnType<typeof hbkIn>["state"]): GameEvent[] {
  state.phase = "end";
  const events: GameEvent[] = [];
  advancePhase(state, events, scriptedRng(6, 6));
  return events;
}

const airHit = expect.objectContaining({
  kind: "pilotDamaged",
  unitId: "hbk",
  reason: "lifeSupport",
});

describe("life-support air supply (CRIT-09)", () => {
  it("depth 2 with destroyed life support deals 1 pilot hit per End Phase", () => {
    const { state, hbk } = hbkIn("water2", true);
    const events = endTurn(state);
    expect(hbk.pilotHits).toBe(1);
    expect(events).toContainEqual(airHit);
    expect(events).toContainEqual(
      expect.objectContaining({ kind: "consciousnessCheck", unitId: "hbk", success: true }),
    );
    endTurn(state);
    expect(hbk.pilotHits).toBe(2);
  });

  it("prone in depth 1 is submerged", () => {
    const { state, hbk } = hbkIn("water1", true);
    hbk.prone = true;
    endTurn(state);
    expect(hbk.pilotHits).toBe(1);
  });

  it("standing in depth 1 is not submerged", () => {
    const { state, hbk } = hbkIn("water1", true);
    expect(endTurn(state)).not.toContainEqual(airHit);
    expect(hbk.pilotHits).toBe(0);
  });

  it("intact life support keeps the air supply", () => {
    const { state, hbk } = hbkIn("water2", false);
    endTurn(state);
    expect(hbk.pilotHits).toBe(0);
  });

  it("the setup End Phase (turn 0) deals no hit", () => {
    const state = createBattle(
      {
        name: "air",
        width: 5,
        height: 5,
        terrain: [{ col: 2, row: 2, type: "water2" }],
        legends: [],
      },
      [
        buildUnitInit("hbk", "HBK-4G", 1, { col: 2, row: 2 }, "s"),
        buildUnitInit("enf", "ENF-4R", 2, { col: 4, row: 4 }, "n"),
      ],
      { critsDisabled: true },
    );
    const hbk = requireUnit(state, "hbk");
    mechDefFor(hbk).critSlots.head.forEach((slot, i) => {
      if (slot?.kind === "structure" && slot.type === "lifeSupport") {
        setSlotDestroyed(hbk.critSlotsDestroyed, "head", i);
      }
    });
    const events: GameEvent[] = [];
    advancePhase(state, events, scriptedRng());
    expect(state.turn).toBe(1);
    expect(hbk.pilotHits).toBe(0);
  });
});
