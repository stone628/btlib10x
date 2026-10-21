import { describe, expect, it } from "vitest";
import { cloneCritTable, setSlotDestroyed } from "../src/rules/critical";
import { applyFall, buildUnitInit, type GameEvent, requireUnit } from "../src/rules/game";
import { createTestBattle, scriptedRng } from "./helpers";

// CRIT-10: fall damage lands as several 5-point groups, and each group's
// critical is judged against the location as it stood at the start of the
// phase (TW p.125), not as an earlier group of the same fall left it.
//
// ENF-4R right leg: hip, upper leg, lower leg, foot, jump jet, jump jet
// (slots 1-6). Right torso slot 1 is a heat sink.

function enfWithBareRightLeg() {
  const state = createTestBattle(
    [],
    [
      buildUnitInit("hbk", "HBK-4G", 1, { col: 2, row: 2 }, "s"),
      buildUnitInit("enf", "ENF-4R", 2, { col: 2, row: 3 }, "n"),
    ],
    false,
  );
  const enf = requireUnit(state, "enf");
  enf.damage = { ...enf.damage, armor: { ...enf.damage.armor, rightLeg: 0 } };
  return { state, enf };
}

function destroyRightLegSlots(enf: ReturnType<typeof enfWithBareRightLeg>["enf"], from: number) {
  const mask = cloneCritTable(enf.critSlotsDestroyed);
  for (let i = from; i < 6; i++) setSlotDestroyed(mask, "rightLeg", i);
  enf.critSlotsDestroyed = mask;
}

function fall(
  state: ReturnType<typeof enfWithBareRightLeg>["state"],
  enf: ReturnType<typeof enfWithBareRightLeg>["enf"],
  rolls: number[],
  levelsFallen: number,
) {
  const events: GameEvent[] = [];
  const rng = scriptedRng(...rolls);
  applyFall(
    state,
    enf,
    rng,
    {
      cause: { kind: "failedPsr", reason: "rubble" },
      seatbeltModifier: 0,
      halved: false,
      levelsFallen,
    },
    events,
  );
  expect(rng.remaining()).toBe(0);
  const fell = events.find((e) => e.kind === "unitFell");
  if (fell?.kind !== "unitFell") throw new Error("no unitFell event");
  return fell.crits;
}

describe("fall criticals use the phase-start crit table (CRIT-10)", () => {
  it("a second group's critical is lost once the first group took the leg's last slot", () => {
    const { state, enf } = enfWithBareRightLeg();
    destroyRightLegSlots(enf, 1); // only the hip is live
    // 50 t falling one level: 10 damage, two 5-point groups. Dir 1 (front),
    // both groups 2+3 (right leg). Group 1: determining 4+4, slot 1 (hip).
    // Group 2: determining 4+4, no live slot and no roll. Seatbelt 6+6.
    const crits = fall(state, enf, [1, 2, 3, 2, 3, 4, 4, 1, 4, 4, 6, 6], 1);
    expect(crits.map((c) => c.rows.map((r) => r.kind))).toEqual([
      ["componentDestroyed"],
      ["noEffect"],
    ]);
    expect(enf.critSlotsDestroyed.rightTorso).toBe(0);
  });

  it("a slot lost earlier in the phase still counts as live for the fall", () => {
    const { state, enf } = enfWithBareRightLeg();
    destroyRightLegSlots(enf, 1);
    // Phase start: only the hip live. Then the hip goes earlier this phase.
    state.currentDealt = {
      before: { damage: {}, crit: { enf: cloneCritTable(enf.critSlotsDestroyed) } },
      total: {},
      byAttacker: {},
    };
    destroyRightLegSlots(enf, 0);
    // One 5-point group: dir 1, loc 2+3 (right leg), determining 4+4, seatbelt 6+6.
    const crits = fall(state, enf, [1, 2, 3, 4, 4, 6, 6], 0);
    expect(crits.map((c) => c.rows.map((r) => r.kind))).toEqual([["noEffect"]]);
    expect(enf.critSlotsDestroyed.rightTorso).toBe(0);
  });

  it("a leg already empty at phase start still passes its critical inward", () => {
    const { state, enf } = enfWithBareRightLeg();
    destroyRightLegSlots(enf, 0);
    // Dir 1, loc 2+3, determining 4+4 carried to the right torso: slot 1+1
    // (heat sink). Seatbelt 6+6.
    const crits = fall(state, enf, [1, 2, 3, 4, 4, 1, 1, 6, 6], 0);
    expect(crits.map((c) => c.rows.map((r) => r.kind))).toEqual([["componentDestroyed"]]);
    expect(enf.critSlotsDestroyed.rightTorso).toBe(1);
  });
});
