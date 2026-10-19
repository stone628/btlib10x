import { describe, expect, it } from "vitest";
import { allAmmo } from "../src/data/ammo.schema";
import { mechDef, mechDefFor } from "../src/data/index";
import { loadAmmoBins } from "../src/rules/ammo";
import { ammoDamagePerShot, emptyCritTable, resolveCriticalHits } from "../src/rules/critical";
import { dealtOf } from "../src/rules/damage";
import {
  advancePhase,
  buildUnitInit,
  type GameEvent,
  requireUnit,
  rollInitiativePhase,
} from "../src/rules/game";
import { largestAmmoBin } from "../src/rules/heat";
import { createTestBattle, scriptedRng } from "./helpers";

// AMS ammunition and Narc pods ride on EQUIPMENT rows with no Damage Value,
// so their explosion size comes from the ammo row instead.
describe("equipment ammo explosion damage (TW p.130, p.139)", () => {
  it("AMS rounds and Narc pods explode for 2 per shot; B-Pods for 2", () => {
    expect(ammoDamagePerShot({ weapon: "Anti-Missile System" })).toBe(2);
    expect(ammoDamagePerShot({ weapon: "CL Narc Missile Beacon" })).toBe(2);
    expect(ammoDamagePerShot({ weapon: "B-Pods" })).toBe(2);
    // Weapon-derived rows are unchanged.
    expect(ammoDamagePerShot({ weapon: "AC/20" })).toBe(20);
    expect(ammoDamagePerShot({ weapon: "LRM 20" })).toBe(20);
  });

  it("every explosive ammo row that holds shots explodes for more than 0 per shot", () => {
    const zero = allAmmo()
      .filter((a) => a.explosive && a.shotsPerBin > 0)
      .filter((a) => ammoDamagePerShot(a) <= 0)
      .map((a) => a.weapon);
    expect(zero).toEqual([]);
  });

  it("unexpended A-Pods do not explode (TW p.130)", () => {
    const aPod = allAmmo().find((a) => a.weapon === "A-Pod");
    expect(aPod?.explosive).toBe(false);
  });

  it("a critical on FLS-8K's AMS bin explodes for 12 x 2 = 24", () => {
    const def = mechDef("FLS-8K")!;
    const ammoBins = loadAmmoBins(def);
    expect(ammoBins["rightTorso:6"]).toBe(12);
    const res = resolveCriticalHits({
      // Determining 8 -> one crit; first die 1 (slots 1-6), second die 6 ->
      // slot 6 (the AMS bin). Tail: follow-up Determining roll 2 (no crit)
      // for the struck right torso (TW p.125).
      rng: scriptedRng(4, 4, 1, 6, 1, 1),
      model: def.model,
      source: { location: "rightTorso", damage: 5 },
      critSlotsDestroyed: emptyCritTable(def),
      damage: {
        armor: { ...def.armor, rightTorso: 0 },
        armorRear: { ...def.armorRear },
        internalStructure: { ...def.internalStructure, rightTorso: 1000 },
      },
      ammoBins,
    });
    expect(res.rows).toHaveLength(1);
    const row = res.rows[0]!;
    expect(row.kind).toBe("ammoExplosion");
    if (row.kind !== "ammoExplosion") return;
    expect(row.weaponName).toBe("Anti-Missile System");
    expect(row.shotsRemaining).toBe(12);
    expect(row.damagePerShot).toBe(2);
    expect(row.damage).toBe(24);
    expect(dealtOf(row.application)).toBe(24);
    expect(res.damage.internalStructure.rightTorso).toBe(1000 - 24);
    expect(res.ammoBins["rightTorso:6"]).toBe(0);
  });

  it("the Heat Phase picks the AMS bin as a 24-point explosion (EXT-4DX, FLS-8K)", () => {
    for (const model of ["EXT-4DX", "FLS-8K"]) {
      const state = createTestBattle(
        [],
        [
          buildUnitInit("a", model, 1, { col: 2, row: 4 }, "se"),
          buildUnitInit("b", "ENF-4R", 2, { col: 6, row: 6 }, "nw"),
        ],
        true,
      );
      const unit = requireUnit(state, "a");
      const bin = largestAmmoBin(mechDefFor(unit), unit, scriptedRng(6));
      expect(bin).toMatchObject({
        weapon: "Anti-Missile System",
        shotsRemaining: 12,
        damagePerShot: 2,
        damage: 24,
      });
    }
  });

  it("a failed heat avoidance roll blasts FLS-8K's structure for 24 and costs 2 pilot hits", () => {
    const state = createTestBattle(
      [],
      [
        buildUnitInit("fls", "FLS-8K", 1, { col: 2, row: 4 }, "se"),
        buildUnitInit("enf", "ENF-4R", 2, { col: 6, row: 6 }, "nw"),
      ],
      true,
    );
    const fls = requireUnit(state, "fls");
    // 49 - 30 (15 DHS) = endHeat 19: shutdown avoid 6, ammo avoid 4.
    fls.heat = 49;
    rollInitiativePhase(state, scriptedRng(1, 1, 4, 4), []);
    advancePhase(state, [], scriptedRng());
    const events: GameEvent[] = [];
    // Shutdown 6,6 passes; ammo 1,1 fails; Consciousness Rolls 6,6 twice;
    // the XL-engine kill's salvage fall takes the tail.
    advancePhase(state, events, scriptedRng(6, 6, 1, 1, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6));
    const blast = events.find(
      (e): e is Extract<GameEvent, { kind: "ammoExplosionCheck" }> =>
        e.kind === "ammoExplosionCheck" && e.unitId === "fls",
    );
    expect(blast).toMatchObject({ avoided: false, shotsRemaining: 12, damage: 24 });
    // 24 points: the right torso's 16 IS, then 8 transferred to the CT.
    expect(fls.damage.internalStructure.rightTorso).toBe(0);
    expect(fls.damage.internalStructure.centerTorso).toBe(
      mechDef("FLS-8K")!.internalStructure.centerTorso - 8,
    );
    expect(events).toContainEqual(
      expect.objectContaining({ kind: "pilotDamaged", reason: "ammoExplosion", hits: 2 }),
    );
  });
});
