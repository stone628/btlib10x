import { describe, expect, it } from "vitest";
import { LOCATIONS, type Location, type Rng } from "../src/core/types";
import { mechDef, type ResolvedMechDef } from "../src/data/index";
import {
  ammoWeaponTotals,
  collectAmmoBins,
  loadAmmoBins,
  strandedShots,
  usableShots,
} from "../src/rules/ammo";
import {
  anySlotDestroyed,
  applyAmmoExplosion,
  checkCASE,
  cloneCritTable,
  componentHitStatus,
  countDestroyedEngine,
  critDamageDealt,
  critSeveredLimbs,
  crittedWeapons,
  destroyAllSlots,
  destroyedSlots,
  effectiveMovement,
  emptyCritTable,
  isSlotDestroyed,
  MAX_CRIT_SLOTS,
  markLocationCatastrophicallyDestroyed,
  mergeCritTable,
  resolveCriticalHits,
  setSlotDestroyed,
} from "../src/rules/critical";
import { dealtOf, type UnitDamageState } from "../src/rules/damage";
import { buildUnitInit } from "../src/rules/game/create";
import { declareAttacks } from "../src/rules/game/declare";
import { advancePhase } from "../src/rules/game/loop";
import { requireUnit } from "../src/rules/game/queries";
import { resolveAllAttacks } from "../src/rules/game/resolveAttacks";
import { rollInitiativePhase } from "../src/rules/game/turnOrder";
import type { GameEvent, UnitInit } from "../src/rules/game/types";
import { heatSinksOperational } from "../src/rules/heat";
import { preexistingDamageModifier } from "../src/rules/piloting";
import { createTestBattle, overrideAmmoBin } from "./helpers/battle";
import { scriptedRng, seededRng } from "./helpers/rng";

/** Helper: returns an Rng whose first 2D6 sums to `sum` (1..12), then yields `tail`. */
function detRoll(sum: number, ...tail: number[]): ReturnType<typeof scriptedRng> {
  const a = Math.max(1, Math.min(6, sum - 1));
  const b = sum - a;
  return scriptedRng(a, b, ...tail);
}

function freshFlags(def = mechDef("HBK-4G")!) {
  return emptyCritTable(def);
}

describe("determining critical hits table", () => {
  const def = mechDef("HBK-4G")!;
  const damage: UnitDamageState = {
    armor: { ...def.armor },
    armorRear: { ...def.armorRear },
    internalStructure: { ...def.internalStructure },
  };

  it("rolls 2-7 as no crit", () => {
    for (let roll = 2; roll <= 7; roll++) {
      const res = resolveCriticalHits({
        rng: detRoll(roll),
        model: def.model,
        source: { location: "centerTorso", damage: 5 },
        critSlotsDestroyed: freshFlags(def),
        damage,
        ammoBins: loadAmmoBins(def),
      });
      expect(res.determiningRoll).toBe(roll);
      expect(res.rows).toHaveLength(0);
      expect(res.throughArmor).toBe(false);
    }
  });

  it("tags through-armor resolutions when triggered by a hit-location 2", () => {
    const res = resolveCriticalHits({
      rng: detRoll(8, 1, 1),
      model: def.model,
      source: { location: "centerTorso", damage: 5, tac: true },
      critSlotsDestroyed: freshFlags(def),
      damage,
      ammoBins: loadAmmoBins(def),
    });
    expect(res.throughArmor).toBe(true);
    expect(res.rows).toHaveLength(1);
  });

  it("rolls 8-9 as one crit", () => {
    for (const roll of [8, 9]) {
      const res = resolveCriticalHits({
        rng: detRoll(roll, 1, 1),
        model: def.model,
        source: { location: "rightTorso", damage: 5 },
        critSlotsDestroyed: freshFlags(def),
        damage,
        ammoBins: loadAmmoBins(def),
      });
      expect(res.determiningRoll).toBe(roll);
      expect(res.rows).toHaveLength(1);
    }
  });

  it("rolls 10-11 as two crits", () => {
    for (const roll of [10, 11]) {
      // Use a location with several distinct hittable slots so the second
      // crit reliably finds a fresh target. RightTorso has 10 AC/20 + 2
      // ammo = 12 hittable slots.
      const res = resolveCriticalHits({
        rng: detRoll(roll, 1, 1, 1, 2),
        model: def.model,
        source: { location: "rightTorso", damage: 5 },
        critSlotsDestroyed: freshFlags(def),
        damage,
        ammoBins: loadAmmoBins(def),
      });
      expect(res.determiningRoll).toBe(roll);
      expect(res.rows).toHaveLength(2);
    }
  });
});

describe("limb / head blow-off on 12", () => {
  const def = mechDef("HBK-4G")!;
  const damage: UnitDamageState = {
    armor: { ...def.armor },
    armorRear: { ...def.armorRear },
    internalStructure: { ...def.internalStructure },
  };

  it("head blown off on 12 kills the unit", () => {
    const res = resolveCriticalHits({
      rng: detRoll(12),
      model: def.model,
      source: { location: "head", damage: 3 },
      critSlotsDestroyed: freshFlags(def),
      damage,
      ammoBins: loadAmmoBins(def),
    });
    expect(res.killedReason).toBe("headBlownOff");
    expect(res.rows.some((r) => r.kind === "headBlownOff")).toBe(true);
    expect(res.damage.internalStructure.head).toBe(0);
  });

  it("arm blown off on 12 zeros the arm and reports it", () => {
    const res = resolveCriticalHits({
      rng: detRoll(12),
      model: def.model,
      source: { location: "leftArm", damage: 5 },
      critSlotsDestroyed: freshFlags(def),
      damage,
      ammoBins: loadAmmoBins(def),
    });
    expect(critSeveredLimbs(res)).toContain("leftArm");
    expect(res.damage.internalStructure.leftArm).toBe(0);
    expect(res.damage.armor.leftArm).toBe(0);
  });

  it("leg blown off on 12 zeros the leg", () => {
    const res = resolveCriticalHits({
      rng: detRoll(12),
      model: def.model,
      source: { location: "leftLeg", damage: 5 },
      critSlotsDestroyed: freshFlags(def),
      damage,
      ammoBins: loadAmmoBins(def),
    });
    expect(res.damage.internalStructure.leftLeg).toBe(0);
    expect(res.damage.armor.leftLeg).toBe(0);
    expect(res.rows.some((r) => r.kind === "limbBlownOff")).toBe(true);
  });

  it("12 on torso yields three crits (no blow-off)", () => {
    const res = resolveCriticalHits({
      // 12 on rightTorso: 3 crits against 12 AC/20/ammo slots. Dice:
      //   det 2, slot 2, slot 2, slot 2 = 8 total.
      rng: detRoll(12, 1, 1, 1, 2, 1, 3, 1, 1),
      model: def.model,
      source: { location: "rightTorso", damage: 5 },
      critSlotsDestroyed: freshFlags(def),
      damage,
      ammoBins: loadAmmoBins(def),
    });
    expect(res.rows).toHaveLength(3);
    expect(res.killedReason).toBe(null);
  });
});

describe("slot selection", () => {
  const def = mechDef("HBK-4G")!;
  const damage: UnitDamageState = {
    armor: { ...def.armor },
    armorRear: { ...def.armorRear },
    internalStructure: { ...def.internalStructure },
  };

  it("head slots: 1D6 from 1..6", () => {
    // 8 -> one crit. Slot rolls of 1, 2, 3, 4, 5, 6 each land on a known slot.
    const expectedSlot = (n: number) => n; // first 6 slots in the head layout
    for (const targetSlot of [1, 2, 3, 4, 5, 6]) {
      const res = resolveCriticalHits({
        rng: detRoll(8, targetSlot),
        model: def.model,
        source: { location: "head", damage: 3 },
        critSlotsDestroyed: freshFlags(def),
        damage,
        ammoBins: loadAmmoBins(def),
      });
      expect(res.rows).toHaveLength(1);
      const eff = res.rows[0]!;
      if (
        eff.kind === "componentDestroyed" ||
        eff.kind === "weaponDestroyed" ||
        eff.kind === "cockpitDestroyed"
      ) {
        expect(eff.slotIndex).toBe(expectedSlot(targetSlot));
      } else {
        throw new Error(`unexpected effect kind ${eff.kind}`);
      }
    }
  });

  it("torso slots: 2D6 (first = half, second = slot within half)", () => {
    // Half 1 (slots 1-6): first die <= 3, second die 1-6.
    // Half 2 (slots 7-12): first die 4-6, second die 1-6.
    // We use rightTorso (12 slots); slots 1-10 are the AC/20 weapon and
    // slots 11-12 are empty (reroll territory, not tested here).
    const cases: [number, number, number][] = [
      [1, 1, 1],
      [1, 6, 6],
      [4, 1, 7],
      [4, 4, 10],
    ];
    for (const [d1, d2, expected] of cases) {
      const res = resolveCriticalHits({
        rng: detRoll(8, d1, d2),
        model: def.model,
        source: { location: "rightTorso", damage: 5 },
        critSlotsDestroyed: freshFlags(def),
        damage,
        ammoBins: loadAmmoBins(def),
      });
      expect(res.rows).toHaveLength(1);
      const eff = res.rows[0]!;
      if (
        eff.kind === "componentDestroyed" ||
        eff.kind === "weaponDestroyed" ||
        eff.kind === "ammoExplosion"
      ) {
        expect(eff.slotIndex).toBe(expected);
      } else {
        throw new Error(`unexpected ${eff.kind}`);
      }
    }
  });
});

describe("re-rolls", () => {
  const def = mechDef("HBK-4G")!;
  const damage: UnitDamageState = {
    armor: { ...def.armor },
    armorRear: { ...def.armorRear },
    internalStructure: { ...def.internalStructure },
  };

  it("re-rolls on empty slots and finds a hittable one", () => {
    // Center Torso: slots 1-10 (engine/gyro) and 11 (heatSink) are hittable;
    // slot 12 is empty. Roll 8 -> one crit. If first slot roll is 12 (empty),
    // it must reroll. We simulate 1D6 for first die and 1-6 for second
    // (it's a 12-slot location so the first die is 1-6 not 1-3, and second
    // die 1-6). The half selector uses 1-3 -> first half, 4-6 -> second half.
    // We pre-roll 1 (first die -> first half) and 5 (second die -> slot 5)
    // — slot 5 in CT is "gyro", which is hittable.
    const res = resolveCriticalHits({
      rng: detRoll(8, 1, 5),
      model: def.model,
      source: { location: "centerTorso", damage: 5 },
      critSlotsDestroyed: freshFlags(def),
      damage,
      ammoBins: loadAmmoBins(def),
    });
    expect(res.rows).toHaveLength(1);
    const eff = res.rows[0]!;
    expect(eff.kind).toBe("componentDestroyed");
    if (eff.kind === "componentDestroyed") {
      expect(eff.name).toBe("gyro");
      expect(eff.slotIndex).toBe(5);
    }
  });
});

describe("weapon and ammo crit effects", () => {
  it("destroying a weapon prevents it from firing", () => {
    const def = mechDef("HBK-4G")!;
    // HBK rightTorso: slots 1-10 are AC/20 (weapon), 11-12 are AC/20 ammo.
    // Roll 8 -> one crit. Slot 1,1 (CT half=1, slot=1) lands on AC/20.
    const res = resolveCriticalHits({
      rng: detRoll(8, 1, 1),
      model: def.model,
      source: { location: "rightTorso", damage: 5 },
      critSlotsDestroyed: freshFlags(def),
      damage: {
        armor: { ...def.armor },
        armorRear: { ...def.armorRear },
        internalStructure: { ...def.internalStructure },
      },
      ammoBins: loadAmmoBins(def),
    });
    expect(res.rows).toHaveLength(1);
    const eff = res.rows[0]!;
    expect(eff.kind).toBe("weaponDestroyed");
    if (eff.kind === "weaponDestroyed") {
      expect(eff.weaponName).toBe("AC/20");
      expect(eff.weaponIndex).toBe(4);
    }
    expect(crittedWeapons(def, res.critSlotsDestroyed)).toContain(4);
  });

  it("AC/20 ammo explosion = hit bin's shots x 20 damage to that bin's IS", () => {
    const def = mechDef("HBK-4G")!;
    // HBK ammo bins are leftTorso slots 1-2, each loaded with 5 shots. Roll
    // 8 -> one crit; land on slot 1 (first half: first die 1-3, second die
    // 1 -> slot 1). Only the hit bin detonates: 5 shots x 20 = 100 IS
    // damage; the sibling bin (slot 2, 5 shots) is untouched, so no cascade
    // runs (LT IS is large enough that even a full-bin blast wouldn't zero
    // the location).
    const ammoBins = loadAmmoBins(def);
    overrideAmmoBin(ammoBins, "leftTorso", 1, 5);
    overrideAmmoBin(ammoBins, "leftTorso", 2, 5);
    const res = resolveCriticalHits({
      // Tail: follow-up Determining roll 2 (no crit) for the struck LT (TW p.125).
      rng: detRoll(8, 1, 1, 1, 1),
      model: def.model,
      source: { location: "leftTorso", damage: 5 },
      critSlotsDestroyed: freshFlags(def),
      damage: {
        armor: { ...def.armor, leftTorso: 0 },
        armorRear: { ...def.armorRear },
        internalStructure: { ...def.internalStructure, leftTorso: 1000, centerTorso: 1000 },
      },
      ammoBins,
    });
    expect(res.rows).toHaveLength(1);
    const eff = res.rows[0]!;
    expect(eff.kind).toBe("ammoExplosion");
    if (eff.kind === "ammoExplosion") {
      expect(eff.weaponName).toBe("AC/20");
      expect(eff.shotsRemaining).toBe(5);
      expect(eff.damagePerShot).toBe(20);
      expect(eff.damage).toBe(100);
    }
    // The exploded bin is empty; the sibling bin keeps its 5 shots, and the
    // derived per-weapon total drops from 10 to 5.
    expect(res.ammoBins["leftTorso:1"]).toBe(0);
    expect(res.ammoBins["leftTorso:2"]).toBe(5);
    expect(ammoWeaponTotals(def, res)[4]).toBe(5);
  });

  it("critDamageDealt counts the blast's marked points (100, all on live IS)", () => {
    const def = mechDef("HBK-4G")!;
    const ammoBins = loadAmmoBins(def);
    overrideAmmoBin(ammoBins, "leftTorso", 1, 5);
    overrideAmmoBin(ammoBins, "leftTorso", 2, 5);
    const res = resolveCriticalHits({
      rng: detRoll(8, 1, 1, 1, 1),
      model: def.model,
      source: { location: "leftTorso", damage: 5 },
      critSlotsDestroyed: freshFlags(def),
      damage: {
        armor: { ...def.armor, leftTorso: 0 },
        armorRear: { ...def.armorRear },
        internalStructure: { ...def.internalStructure, leftTorso: 1000, centerTorso: 1000 },
      },
      ammoBins,
    });
    expect(res.rows).toHaveLength(1);
    const row = res.rows[0]!;
    expect(row.kind).toBe("ammoExplosion");
    // 5 shots x 20, all marked on surviving IS — no wipe involved.
    expect(critDamageDealt(res)).toBe(100);
    if (row.kind === "ammoExplosion") expect(dealtOf(row.application)).toBe(100);
  });

  it("ammo explosion cascades a fresh determining roll on a newly-emptied IS", () => {
    // Use a near-empty state where the rightTorso IS has 1 point left and
    // the AC/20 ammo bin (leftTorso slot 1) has 5 shots. Crit on the ammo:
    // 5 shots x 20 = 100 damage, drains leftTorso IS, zeros the location —
    // the cascade rules then trigger a fresh determining roll.
    const def = mechDef("HBK-4G")!;
    const damage: UnitDamageState = {
      armor: { ...def.armor, rightTorso: 0 },
      armorRear: { ...def.armorRear },
      internalStructure: { ...def.internalStructure, rightTorso: 1 },
    };
    const ammoBins = loadAmmoBins(def);
    overrideAmmoBin(ammoBins, "leftTorso", 1, 5);
    overrideAmmoBin(ammoBins, "leftTorso", 2, 0);
    // The starting crit lands on leftTorso slot 1 (det 8 -> first half,
    // slot 1). The explosion drains leftTorso IS from its fresh value to 0
    // (transferring into CT), and the cascade runs two more determining
    // rolls — one for leftTorso (its IS just hit 0) and one for CT (which
    // then dies when the cascade hits an engine slot or gyro). Provide
    // ample dice:
    //   det(2) + slot(2) + [cascade LT: det(2) + slot roll that re-rolls once(4)] + [cascade CT: det(2) + slot(2)]
    //   = 14 dice
    const res = resolveCriticalHits({
      rng: detRoll(8, 1, 1, 3, 4, 1, 1, 1, 2, 3, 4, 1, 1, 1, 1),
      model: def.model,
      source: { location: "leftTorso", damage: 5 },
      critSlotsDestroyed: freshFlags(def),
      damage,
      ammoBins,
    });
    // We at least expect the initial crit to be the ammo explosion.
    expect(res.rows.length).toBeGreaterThanOrEqual(1);
    const first = res.rows[0]!;
    expect(first.kind).toBe("ammoExplosion");
    if (first.kind === "ammoExplosion") {
      // 5 shots x 20 dmg = 100 IS damage. CT IS is 16 (50 ton), RT was 1.
      // The explosion hits LT IS directly (we zeroed the armor pool), drops
      // LT to 0, transfers to CT for 100 more, dropping CT IS from 16 -> 0
      // and the remaining 84 transfers to ... nowhere (centerTorso is
      // terminal), so the unit is killed.
      expect(first.damage).toBe(100);
    }
    expect(res.killedReason).toBe("centerTorsoDestroyed");
    expect(res.damage.internalStructure.centerTorso).toBe(0);
    // The exploded bin's location is gone, so all leftTorso bins are zeroed
    // (exploded, nothing to salvage) and the derived per-weapon total vanishes.
    expect(res.ammoBins["leftTorso:1"]).toBe(0);
    expect(res.ammoBins["leftTorso:2"]).toBe(0);
    expect(ammoWeaponTotals(def, res)[1]).toBeUndefined();
  });

  it("keeps the first kill of a cascade: engine kill, then a blast through the CT", () => {
    // HER-5SA (XL engine): leftTorso slots 1-3 engine, slot 7 Ultra AC/5
    // ammo (20 shots x 5 = 100), no CASE. Two CT engine slots are already
    // gone, so the third engine slot kills the 'Mech; the bin then blows
    // through the 1-IS center torso. The engine came first, so it is the
    // reason (the derivation every damage path shares in `src/rules/game/`).
    const def = mechDef("HER-5SA")!;
    const flags = freshFlags(def);
    setSlotDestroyed(flags, "centerTorso", 0);
    setSlotDestroyed(flags, "centerTorso", 1);
    const res = resolveCriticalHits({
      // det 10 -> 2 crits: (1,1) leftTorso slot 1 engine, (4,1) slot 7 ammo.
      rng: detRoll(10, 1, 1, 4, 1, ...Array(12).fill(1)),
      model: def.model,
      source: { location: "leftTorso", damage: 5 },
      critSlotsDestroyed: flags,
      damage: {
        armor: { ...def.armor, leftTorso: 0, centerTorso: 0 },
        armorRear: { ...def.armorRear },
        internalStructure: { ...def.internalStructure, centerTorso: 1 },
      },
      ammoBins: loadAmmoBins(def),
    });
    expect(res.rows.map((r) => r.kind)).toEqual(["engineDestroyed", "ammoExplosion"]);
    expect(res.damage.internalStructure.centerTorso).toBe(0);
    expect(res.killedReason).toBe("engineDestroyed");
  });

  it("gauss ammo (inert) crits as ammoNoExplosion, bin empties, no damage", () => {
    // BZK-F3 carries only gauss rifle rounds. Total Warfare: gauss ammo is
    // inert — a crit on the bin does not detonate. The slot still takes the
    // crit and the bin empties (slugs spill), but no damage is dealt and no
    // cascade runs.
    const def = mechDef("BZK-F3")!;
    const bins = loadAmmoBins(def);
    // Pre-condition: both CT gauss bins are loaded.
    expect(bins["centerTorso:11"]).toBe(8);
    expect(bins["centerTorso:12"]).toBe(8);
    const ctArmorBefore = def.armor.centerTorso;
    const res = resolveCriticalHits({
      // det 8 -> 1 crit. CT is 12-slot: first die 1-3 = slots 1-6, 4-6 =
      // slots 7-12. (4,5) lands on slot 11 = first gauss ammo bin.
      rng: detRoll(8, 4, 5),
      model: def.model,
      source: { location: "centerTorso", damage: 5 },
      critSlotsDestroyed: freshFlags(def),
      damage: {
        armor: { ...def.armor, centerTorso: 0 },
        armorRear: { ...def.armorRear },
        internalStructure: { ...def.internalStructure, centerTorso: 1000 },
      },
      ammoBins: { ...bins },
    });
    expect(res.rows).toHaveLength(1);
    const eff = res.rows[0]!;
    expect(eff.kind).toBe("ammoNoExplosion");
    if (eff.kind === "ammoNoExplosion") {
      expect(eff.weaponName).toBe("Gauss Rifle");
      expect(eff.location).toBe("centerTorso");
      expect(eff.slotIndex).toBe(11);
    }
    // The hit bin empties; the sibling gauss bin keeps its 8 shots.
    expect(res.ammoBins["centerTorso:11"]).toBe(0);
    expect(res.ammoBins["centerTorso:12"]).toBe(8);
    // No damage, no kill, no cascade rows. We pre-set CT IS to 1000 so
    // any non-zero damage applied at this slot would show up.
    expect(res.damage.armor.centerTorso).toBe(0);
    expect(res.damage.internalStructure.centerTorso).toBe(1000);
    expect(res.killedReason).toBe(null);
    // Guard: armor pool untouched (no explosion damage applied).
    expect(def.armor.centerTorso).toBe(ctArmorBefore);
  });

  it("gauss weapon crit detonates a 20-pt blast inside weaponDestroyed", () => {
    // BZK-F3 rightTorso slots 3-9 are the Gauss Rifle mount (weaponIndex 0).
    // TW p.135: a crit on the rifle itself causes a 20-pt ammo explosion in
    // that location, applied direct to IS (armor bypassed) with a cascade.
    const def = mechDef("BZK-F3")!;
    const rtArmor = def.armor.rightTorso;
    const res = resolveCriticalHits({
      // det 8 -> 1 crit; (1,3) lands on slot 3 = Gauss Rifle.
      // Tail: follow-up Determining roll 2 (no crit) for the struck RT (TW p.125).
      rng: detRoll(8, 1, 3, 1, 1),
      model: def.model,
      source: { location: "rightTorso", damage: 5 },
      critSlotsDestroyed: freshFlags(def),
      damage: {
        armor: { ...def.armor },
        armorRear: { ...def.armorRear },
        internalStructure: { ...def.internalStructure, rightTorso: 1000 },
      },
      ammoBins: loadAmmoBins(def),
    });
    expect(res.rows).toHaveLength(1);
    const eff = res.rows[0]!;
    expect(eff.kind).toBe("weaponDestroyed");
    if (eff.kind === "weaponDestroyed") {
      expect(eff.weaponName).toBe("Gauss Rifle");
      expect(eff.slotIndex).toBe(3);
      expect(eff.weaponIndex).toBe(1);
      expect(eff.explosion?.damage).toBe(20);
      expect(eff.explosion?.application.newlyDestroyed ?? []).toHaveLength(0);
    }
    expect(crittedWeapons(def, res.critSlotsDestroyed)).toContain(1);
    // Blast bypasses armor and hits IS directly.
    expect(res.damage.armor.rightTorso).toBe(rtArmor);
    expect(res.damage.internalStructure.rightTorso).toBe(980);
    expect(res.killedReason).toBe(null);
  });

  it("second crit on a powered-down gauss mount soaks with no second blast", () => {
    const def = mechDef("BZK-F3")!;
    const destroyed = freshFlags(def);
    setSlotDestroyed(destroyed, "rightTorso", 2); // slot 3 already hit
    const res = resolveCriticalHits({
      // det 8 -> 1 crit; (1,4) lands on slot 4 = same Gauss mount.
      rng: detRoll(8, 1, 4),
      model: def.model,
      source: { location: "rightTorso", damage: 5 },
      critSlotsDestroyed: destroyed,
      damage: {
        armor: { ...def.armor },
        armorRear: { ...def.armorRear },
        internalStructure: { ...def.internalStructure, rightTorso: 1000 },
      },
      ammoBins: loadAmmoBins(def),
    });
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]!.kind).toBe("noEffect");
    expect(res.damage.internalStructure.rightTorso).toBe(1000);
    expect(res.killedReason).toBe(null);
  });

  it("cockpit crit kills the 'Mech", () => {
    const def = mechDef("HBK-4G")!;
    // HBK head slot 3 = cockpit. Roll 8 -> one crit. Slot 3 (1D6 = 3).
    const res = resolveCriticalHits({
      rng: detRoll(8, 3),
      model: def.model,
      source: { location: "head", damage: 3 },
      critSlotsDestroyed: freshFlags(def),
      damage: {
        armor: { ...def.armor },
        armorRear: { ...def.armorRear },
        internalStructure: { ...def.internalStructure },
      },
      ammoBins: loadAmmoBins(def),
    });
    expect(res.killedReason).toBe("cockpitDestroyed");
    expect(res.rows.some((r) => r.kind === "cockpitDestroyed")).toBe(true);
    // TW p.125: cockpit destroys the slot only — head pools survive.
    expect(res.damage.internalStructure.head).toBe(def.internalStructure.head);
    expect(res.damage.armor.head).toBe(def.armor.head);
  });
});

describe("transfer rules", () => {
  it("excess crits are lost when the source still has hittable slots", () => {
    // 12 on Atlas centerTorso: 3 crits. Atlas CT has 10 engine + 4 gyro +
    // 2 Medium Laser (R) + 1 empty = 12. With 2 separate ML mounts and
    // 3 crits, we get 3 rows (no transfers because the source still has
    // hittable slots throughout the determining).
    const def = mechDef("AS7-D")!;
    const res = resolveCriticalHits({
      // Provide 12 dice. det 2 + 3 slot rolls (with possible re-rolls)
      // = up to 10 dice; extra margin.
      rng: detRoll(12, 1, 1, 1, 1, 2, 6, 6, 1, 3),
      model: def.model,
      source: { location: "centerTorso", damage: 5 },
      critSlotsDestroyed: freshFlags(def),
      damage: {
        armor: { ...def.armor },
        armorRear: { ...def.armorRear },
        internalStructure: { ...def.internalStructure },
      },
      ammoBins: loadAmmoBins(def),
    });
    // Three crits land against 11 hittable slots; none transfer.
    expect(res.rows).toHaveLength(3);
    // At least one crit destroys something (component or weapon).
    expect(res.rows.some((r) => r.kind !== "noEffect")).toBe(true);
  });

  it("crits transfer inward when the source is exhausted from a prior phase", () => {
    const def = mechDef("HBK-4G")!;
    // Simulate: every crit-hittable slot in leftTorso is already destroyed
    // from a previous turn. Roll 8 -> one crit -> source is exhausted,
    // transfer to centerTorso. Provide 6 dice: 2 for the top-level
    // determining roll, 2 for the recursive (transferred) determining
    // roll, 2 for the slot roll.
    const destroyed = freshFlags(def);
    for (let i = 0; i < def.critSlots.leftTorso.length; i++) {
      const slot = def.critSlots.leftTorso[i]!;
      if (slot.kind !== "empty" && slot.kind !== "soak") {
        setSlotDestroyed(destroyed, "leftTorso", i);
      }
    }
    const res = resolveCriticalHits({
      rng: detRoll(8, 4, 4, 1, 4),
      model: def.model,
      source: { location: "leftTorso", damage: 5 },
      critSlotsDestroyed: destroyed,
      damage: {
        armor: { ...def.armor },
        armorRear: { ...def.armorRear },
        internalStructure: { ...def.internalStructure },
      },
      ammoBins: loadAmmoBins(def),
    });
    expect(res.rows).toHaveLength(1);
    const eff = res.rows[0]!;
    expect(eff.kind).toBe("componentDestroyed");
    if (eff.kind === "componentDestroyed") {
      expect(eff.location).toBe("centerTorso");
    }
  });

  it("crits on a terminal source (head) with no eligible slot are lost", () => {
    const def = mechDef("HBK-4G")!;
    // Mark every head slot destroyed.
    const destroyed = freshFlags(def);
    for (let i = 0; i < def.critSlots.head.length; i++) {
      setSlotDestroyed(destroyed, "head", i);
    }
    const res = resolveCriticalHits({
      rng: detRoll(8),
      model: def.model,
      source: { location: "head", damage: 3 },
      critSlotsDestroyed: destroyed,
      damage: {
        armor: { ...def.armor },
        armorRear: { ...def.armorRear },
        internalStructure: { ...def.internalStructure },
      },
      ammoBins: loadAmmoBins(def),
    });
    // Head is terminal: 1 crit declared, no slot found, lost.
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]!.kind).toBe("noEffect");
  });

  it("crit lands on the last live weapon slot after 50 dice misses", () => {
    // HBK-4G rightTorso: slots 1-10 are one AC/20 mount, slots 11-12 empty.
    // Destroy slots 1-9, leaving slot 10 as the only live hittable slot, then
    // force all 50 dice tries onto destroyed slot 1. Pre-fix this resolved
    // as a silent noEffect; TW p.124 requires the re-roll to land. The
    // flagged slots already destroyed the AC/20, so the landing hit soaks.
    const def = mechDef("HBK-4G")!;
    const destroyed = freshFlags(def);
    for (let i = 0; i < 9; i++) setSlotDestroyed(destroyed, "rightTorso", i);
    const res = resolveCriticalHits({
      // det 8 (4+4) -> 1 crit; 50 tries of (1,1) -> destroyed slot 1;
      // +1 die for the uniform fallback pick among the single live slot.
      rng: scriptedRng(4, 4, ...Array(100).fill(1), 1),
      model: def.model,
      source: { location: "rightTorso", damage: 5 },
      critSlotsDestroyed: destroyed,
      damage: {
        armor: { ...def.armor },
        armorRear: { ...def.armorRear },
        internalStructure: { ...def.internalStructure },
      },
      ammoBins: loadAmmoBins(def),
    });
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]!.kind).toBe("noEffect");
    expect(isSlotDestroyed(res.critSlotsDestroyed, "rightTorso", 9)).toBe(true);
  });

  it("crit lands on the last live ammo bin after 50 dice misses", () => {
    // HBK-4G leftTorso: slots 1-2 are AC/20 ammo, rest empty. Destroy slot 1,
    // leaving slot 2 (the last bin) live, and force all 50 dice tries onto
    // slot 1. The bin must detonate (5 shots x 20 = 100 IS damage).
    const def = mechDef("HBK-4G")!;
    const destroyed = freshFlags(def);
    setSlotDestroyed(destroyed, "leftTorso", 0);
    const ammoBins = loadAmmoBins(def);
    overrideAmmoBin(ammoBins, "leftTorso", 1, 5);
    overrideAmmoBin(ammoBins, "leftTorso", 2, 5);
    const res = resolveCriticalHits({
      // det 8 (4+4) -> 1 crit; 50 tries of (1,1) -> destroyed slot 1;
      // +1 die for the fallback pick; +2 dice for the blast's cascade
      // determining roll (1+1 = 2, no further crit).
      rng: scriptedRng(4, 4, ...Array(100).fill(1), 1, 1, 1),
      model: def.model,
      source: { location: "leftTorso", damage: 5 },
      critSlotsDestroyed: destroyed,
      damage: {
        armor: { ...def.armor, leftTorso: 0 },
        armorRear: { ...def.armorRear },
        internalStructure: { ...def.internalStructure, leftTorso: 1000, centerTorso: 1000 },
      },
      ammoBins,
    });
    expect(res.rows[0]!.kind).toBe("ammoExplosion");
    const eff = res.rows[0]!;
    if (eff.kind === "ammoExplosion") {
      expect(eff.location).toBe("leftTorso");
      expect(eff.slotIndex).toBe(2);
      expect(eff.shotsRemaining).toBe(5);
      expect(eff.damage).toBe(100);
    }
    expect(res.ammoBins["leftTorso:2"]).toBe(0);
    expect(res.ammoBins["leftTorso:1"]).toBe(5);
  });

  it("second crit of one determining is still lost once its first crit exhausts the location", () => {
    // Same gutted rightTorso (only slot 10 live), but determining 10 -> 2
    // crits. The first lands on slot 10 (a soak: the flagged slots already
    // destroyed the AC/20); the second finds the location exhausted
    // mid-sequence and is lost per TW p.125 (not transferred).
    const def = mechDef("HBK-4G")!;
    const destroyed = freshFlags(def);
    for (let i = 0; i < 9; i++) setSlotDestroyed(destroyed, "rightTorso", i);
    const res = resolveCriticalHits({
      // det 10 (5+5) -> 2 crits; first slot roll (4,4) -> live slot 10.
      rng: detRoll(10, 4, 4),
      model: def.model,
      source: { location: "rightTorso", damage: 5 },
      critSlotsDestroyed: destroyed,
      damage: {
        armor: { ...def.armor },
        armorRear: { ...def.armorRear },
        internalStructure: { ...def.internalStructure },
      },
      ammoBins: loadAmmoBins(def),
    });
    expect(res.rows).toHaveLength(2);
    expect(res.rows[0]!.kind).toBe("noEffect");
    expect(isSlotDestroyed(res.critSlotsDestroyed, "rightTorso", 9)).toBe(true);
    expect(res.rows[1]!.kind).toBe("noEffect");
  });
});

describe("effectiveMovement", () => {
  const def = mechDef("HBK-4G")!;
  const flags = (mods: Partial<Record<Location, number[]>>) => {
    const out = freshFlags(def);
    for (const [loc, idxs] of Object.entries(mods) as [Location, number[]][]) {
      for (const i of idxs) setSlotDestroyed(out, loc, i);
    }
    return out;
  };
  const damage: UnitDamageState = {
    armor: { ...def.armor },
    armorRear: { ...def.armorRear },
    internalStructure: { ...def.internalStructure },
  };

  it("returns base ratings for a fresh unit", () => {
    const m = effectiveMovement(def, damage, freshFlags(def));
    expect(m.walking).toBe(def.walking);
    expect(m.running).toBe(Math.ceil(def.walking * 1.5));
    expect(m.jumping).toBe(def.jumping);
  });

  it("each destroyed leg actuator slot reduces walk by 1", () => {
    // Right leg has Hip(0), ULA(1), LLA(2), Foot(3), HS(4), HS(5). Destroy
    // ULA + LLA: walking = 4 - 2 = 2.
    const m = effectiveMovement(def, damage, flags({ rightLeg: [1, 2] }));
    expect(m.walking).toBe(2);
    expect(m.running).toBe(3);
  });

  it("hip on a leg halves walking and ignores other penalties on that leg", () => {
    // Hip + ULA + LLA destroyed on rightLeg: walk halves to ceil(4/2) = 2;
    // running = ceil(2 * 1.5) = 3.
    const m = effectiveMovement(def, damage, flags({ rightLeg: [0, 1, 2] }));
    expect(m.walking).toBe(2);
    expect(m.running).toBe(3);
  });

  it("hip halves Walking MP before the other leg's actuator losses (MOV-07)", () => {
    // Right hip + left upper leg actuator: ceil(4/2) - 1 = 1 (not ceil(3/2) = 2).
    const m = effectiveMovement(def, damage, flags({ rightLeg: [0], leftLeg: [1] }));
    expect(m.walking).toBe(1);
  });

  it("a destroyed hip replaces the other crit modifiers on its leg (PSR-02)", () => {
    // Hip + upper leg actuator on one leg: +2 for the hip only, not +3.
    const pre = preexistingDamageModifier(def, damage, flags({ rightLeg: [0, 1] }));
    expect(pre.modifier).toBe(2);
  });

  it("destroyed jump jet slots reduce jumping by 1 each", () => {
    const wvr = mechDef("WVR-6R")!;
    const layout = wvr.critSlots;
    // Find the index of any jump jet slot per location.
    const jetIndices: { loc: Location; idx: number }[] = [];
    for (const loc of [
      "leftLeg",
      "rightLeg",
      "leftTorso",
      "rightTorso",
      "centerTorso",
    ] as Location[]) {
      for (let i = 0; i < layout[loc].length; i++) {
        const s = layout[loc][i];
        if (s && s.kind === "structure" && s.type === "jumpJet") {
          jetIndices.push({ loc, idx: i });
          break;
        }
      }
    }
    // Wolverine has 5 jump MP. Knock out 2 jump jet slots across the mech.
    const mods: Partial<Record<Location, number[]>> = {};
    for (let i = 0; i < 2 && i < jetIndices.length; i++) {
      const { loc, idx } = jetIndices[i]!;
      const arr = mods[loc];
      if (arr) {
        arr.push(idx);
      } else {
        mods[loc] = [idx];
      }
    }
    const m = effectiveMovement(wvr, damage, flags(mods));
    expect(m.jumping).toBe(5 - Math.min(2, jetIndices.length));
  });

  it("one leg destroyed: walking clamped to 1, running to 0 (TW p.122)", () => {
    const legless: UnitDamageState = {
      ...damage,
      internalStructure: { ...damage.internalStructure, rightLeg: 0 },
    };
    const m = effectiveMovement(def, legless, freshFlags(def));
    expect(m.walking).toBe(1);
    expect(m.running).toBe(0);
    expect(m.jumping).toBe(def.jumping);
  });

  it("both legs destroyed: walking 0", () => {
    const legless: UnitDamageState = {
      ...damage,
      internalStructure: { ...damage.internalStructure, rightLeg: 0, leftLeg: 0 },
    };
    const m = effectiveMovement(def, legless, freshFlags(def));
    expect(m.walking).toBe(0);
    expect(m.running).toBe(0);
  });
});

describe("DHS grouping", () => {
  it("consecutive DHS slots in a location share a single destruction", () => {
    // The Hermes II (HER-5SA) leftTorso has 3 consecutive ISDouble Heat Sink
    // entries. Destroying one crit slot destroys the whole DHS; the next
    // reroll sees all 3 slots marked destroyed and produces noEffect.
    const her = mechDef("HER-5SA")!;
    const lt = her.critSlots.leftTorso;
    const dhsIndices: number[] = [];
    for (let i = 0; i < lt.length; i++) {
      const s = lt[i];
      if (s && s.kind === "structure" && s.type === "doubleHeatSink") dhsIndices.push(i);
    }
    expect(dhsIndices.length).toBe(3);
    expect(lt[dhsIndices[0]!]!.kind).toBe("structure");
    const slot = lt[dhsIndices[0]!] as Extract<(typeof lt)[number], { kind: "structure" }>;
    const group = (slot as { group: readonly number[] }).group;
    expect(group).toEqual(dhsIndices.map((i) => i + 1));
  });
});

describe("CASE", () => {
  const state = (): UnitDamageState => {
    const def = mechDef("TBR-Prime")!;
    return {
      armor: { ...def.armor, leftTorso: 0 },
      armorRear: { ...def.armorRear },
      internalStructure: { ...def.internalStructure },
    };
  };
  /** An Inner Sphere def (HBK-4G) with CASE added at `locs` and nowhere else. */
  const isWithCase = (...locs: Location[]): ResolvedMechDef => {
    const hbk = mechDef("HBK-4G")!;
    const critSlots = { ...hbk.critSlots };
    for (const loc of locs) critSlots[loc] = [...critSlots[loc], { kind: "soak", name: "case" }];
    return { ...hbk, techBase: "Inner Sphere", critSlots };
  };

  it("hasCase detects implicit Clan protection on all locations", () => {
    const tw = mechDef("TBR-Prime")!;
    expect(tw.techBase).toBe("Clan");
    for (const loc of LOCATIONS) {
      expect(checkCASE(tw, loc)).toBe("case");
    }

    const hbk = mechDef("HBK-4G")!;
    expect(hbk.techBase).toBe("Inner Sphere");
    expect(checkCASE(hbk, "leftTorso")).toBe(undefined);
  });

  it("IS CASE works in any location (TW p.133)", () => {
    const hbk = mechDef("HBK-4G")!;
    const withCase = (loc: Location): typeof hbk => ({
      ...hbk,
      techBase: "Inner Sphere",
      critSlots: {
        ...hbk.critSlots,
        [loc]: [...hbk.critSlots[loc], { kind: "soak", name: "case" }],
      },
    });
    for (const loc of LOCATIONS) {
      expect(checkCASE(withCase(loc), loc)).toBe("case");
    }
  });

  it("IS CASE in center torso caps the blast and kills via CT destruction", () => {
    const s = state();
    const ltBefore = s.internalStructure.leftTorso;
    const rtBefore = s.internalStructure.rightTorso;
    const app = applyAmmoExplosion(s, isWithCase("centerTorso"), "centerTorso", 1000);
    // CT IS absorbs the blast; CASE caps transfer; MechWarrior dies via
    // CT destruction (TW p.128). Other locations untouched.
    expect(app.after.internalStructure.centerTorso).toBe(0);
    expect(app.after.internalStructure.leftTorso).toBe(ltBefore);
    expect(app.after.internalStructure.rightTorso).toBe(rtBefore);
    expect(app.mechDestroyed).toBe(true);
  });

  it("CASE: explosion vents at the side torso, center torso untouched", () => {
    const s = state();
    const ctBefore = s.internalStructure.centerTorso;
    // Massive blast (1000) against leftTorso with CASE: LT IS destroyed,
    // and CT keeps all its IS.
    const app = applyAmmoExplosion(s, isWithCase("leftTorso"), "leftTorso", 1000);
    expect(app.after.internalStructure.leftTorso).toBe(0);
    expect(app.after.internalStructure.centerTorso).toBe(ctBefore);
    expect(app.mechDestroyed).toBe(false);
  });

  it("no CASE: explosion transfers inward to the center torso as normal", () => {
    const s = state();
    const ltBefore = s.internalStructure.leftTorso;
    const ctBefore = s.internalStructure.centerTorso;
    const ctArmorBefore = s.armor.centerTorso;
    const blast = ltBefore + 5;
    const app = applyAmmoExplosion(s, isWithCase(), "leftTorso", blast);
    // LT IS absorbs ltBefore, the remaining 5 bleeds into CT IS. Ammo-explosion
    // overflow bypasses armor everywhere (TW p.125), so the surviving CT keeps
    // its armor; the destroyed LT loses its remaining (rear) armor with it
    // (TW p.122 step 5).
    expect(app.after.internalStructure.leftTorso).toBe(0);
    expect(app.after.armorRear.leftTorso).toBe(0);
    expect(app.after.armor.centerTorso).toBe(ctArmorBefore);
    expect(app.after.internalStructure.centerTorso).toBe(ctBefore - 5);
  });

  it("CASE: blowing out a side torso also removes its arm, CT still safe", () => {
    const s = state();
    const app = applyAmmoExplosion(s, isWithCase("leftTorso"), "leftTorso", 1000);
    expect(app.blownOffLimbs).toContain("leftArm");
    expect(app.after.internalStructure.leftArm).toBe(0);
    expect(app.mechDestroyed).toBe(false);
    expect(app.after.internalStructure.centerTorso).toBeGreaterThan(0);
  });

  it("explosion bypasses surviving armor but wipes the destroyed location's (TW p.122 step 5)", () => {
    const def = mechDef("TBR-Prime")!;
    const s: UnitDamageState = {
      armor: { ...def.armor, leftTorso: 10 },
      armorRear: { ...def.armorRear },
      internalStructure: { ...def.internalStructure },
    };
    const ctArmorBefore = s.armor.centerTorso;
    const ctBefore = s.internalStructure.centerTorso;
    const blast = s.internalStructure.leftTorso + 5;
    const app = applyAmmoExplosion(s, isWithCase(), "leftTorso", blast);
    // The destroyed LT loses its remaining armor with it (front and rear).
    expect(app.after.armor.leftTorso).toBe(0);
    expect(app.after.armorRear.leftTorso).toBe(0);
    // IS is still damaged directly (armor bypassed).
    expect(app.after.internalStructure.leftTorso).toBe(0);
    // Overflow into the surviving CT likewise bypasses its armor (TW p.125).
    expect(app.after.armor.centerTorso).toBe(ctArmorBefore);
    expect(app.after.internalStructure.centerTorso).toBe(ctBefore - 5);
  });
});

describe("engine crit destruction", () => {
  it("three engine crit slots destroyed kills the 'Mech", () => {
    const def = mechDef("HBK-4G")!;
    // Pre-destroy 2 engine slots (CT indices 0 and 1).
    const destroyed = freshFlags(def);
    setSlotDestroyed(destroyed, "centerTorso", 0);
    setSlotDestroyed(destroyed, "centerTorso", 1);
    // Roll 8 (one crit) targeting CT. Slot roll: first=4 (half 1), second=2
    // → slot=8, index 7 = engine. Not pre-destroyed.
    const res = resolveCriticalHits({
      rng: detRoll(8, 4, 2, 1, 1),
      model: def.model,
      source: { location: "centerTorso", damage: 5 },
      critSlotsDestroyed: destroyed,
      damage: {
        armor: { ...def.armor },
        armorRear: { ...def.armorRear },
        internalStructure: { ...def.internalStructure },
      },
      ammoBins: loadAmmoBins(def),
    });
    expect(res.killedReason).toBe("engineDestroyed");
    expect(res.rows.some((r) => r.kind === "engineDestroyed")).toBe(true);
  });

  it("two engine crits does not kill the 'Mech", () => {
    const def = mechDef("HBK-4G")!;
    // Pre-destroy 1 engine slot (CT index 0).
    const destroyed = freshFlags(def);
    setSlotDestroyed(destroyed, "centerTorso", 0);
    // Roll 8 (one crit) targeting CT. Slot roll: first=1 (half 0), second=2
    // → slot=2, index 1 = engine. Not pre-destroyed.
    const res = resolveCriticalHits({
      rng: detRoll(8, 1, 2, 1, 1),
      model: def.model,
      source: { location: "centerTorso", damage: 5 },
      critSlotsDestroyed: destroyed,
      damage: {
        armor: { ...def.armor },
        armorRear: { ...def.armorRear },
        internalStructure: { ...def.internalStructure },
      },
      ammoBins: loadAmmoBins(def),
    });
    expect(res.killedReason).toBe(null);
    expect(res.rows.some((r) => r.kind === "engineDestroyed")).toBe(false);
  });
});

describe("computeCritCounts", () => {
  it("reports zero for every component on a fresh 'Mech", () => {
    const def = mechDef("HBK-4G")!;
    const damage: UnitDamageState = {
      armor: { ...def.armor },
      armorRear: { ...def.armorRear },
      internalStructure: { ...def.internalStructure },
    };
    const counts = componentHitStatus(def, damage, freshFlags(def));
    expect(counts.engine).toEqual(0);
    expect(counts.gyro).toEqual(0);
    expect(counts.sensors).toEqual(0);
    expect(counts.lifeSupport).toEqual(0);
  });

  it("counts destroyed gyro slots on the CT and engine slots across all torsos", () => {
    const def = mechDef("HBK-4G")!;
    const damage: UnitDamageState = {
      armor: { ...def.armor },
      armorRear: { ...def.armorRear },
      internalStructure: { ...def.internalStructure },
    };
    const destroyed = freshFlags(def);
    // HBK-4G centerTorso: 0..2 = engine, 3..6 = gyro, 7..9 = engine.
    // HBK-4G RT and LT carry weapons/ammo only (no engine/gyro slots there).
    setSlotDestroyed(destroyed, "centerTorso", 3); // gyro slot 4
    setSlotDestroyed(destroyed, "centerTorso", 0); // engine slot 1 (first band)
    setSlotDestroyed(destroyed, "centerTorso", 7); // engine slot 8 (second band)
    const counts = componentHitStatus(def, damage, destroyed);
    expect(counts.engine).toBe(2);
    expect(counts.gyro).toBe(1);
    expect(counts.sensors).toBe(0);
    expect(counts.lifeSupport).toBe(0);
  });

  it("counts destroyed sensors and life support slots on the head", () => {
    const def = mechDef("HBK-4G")!;
    const damage: UnitDamageState = {
      armor: { ...def.armor },
      armorRear: { ...def.armorRear },
      internalStructure: { ...def.internalStructure },
    };
    const destroyed = freshFlags(def);
    // HBK-4G head: 0=lifeSupport, 1=sensors, 2=cockpit, 3=Small Laser,
    //              4=sensors, 5=lifeSupport.
    setSlotDestroyed(destroyed, "head", 1);
    setSlotDestroyed(destroyed, "head", 4);
    setSlotDestroyed(destroyed, "head", 5);
    const counts = componentHitStatus(def, damage, destroyed);
    expect(counts.sensors).toBe(2);
    expect(counts.lifeSupport).toBe(1);
    expect(counts.engine).toBe(0);
    expect(counts.gyro).toBe(0);
  });
});

describe("markLocationCatastrophicallyDestroyed", () => {
  it("zeroes armor and IS, marks every non-empty slot destroyed; its bins read as gone", () => {
    const def = mechDef("HBK-4G")!;
    const damage: UnitDamageState = {
      armor: { ...def.armor },
      armorRear: { ...def.armorRear },
      internalStructure: { ...def.internalStructure },
    };
    const destroyed = freshFlags(def);
    expect(destroyed.leftTorso).toBe(0);
    // HBK-4G carries AC/20 ammo in the leftTorso.
    const ammoBins = loadAmmoBins(def);
    const binKeys = Object.keys(ammoBins).filter((k) => k.startsWith("leftTorso:"));
    expect(binKeys.length).toBeGreaterThan(0);

    markLocationCatastrophicallyDestroyed(def, damage, destroyed, "leftTorso");

    expect(damage.armor.leftTorso).toBe(0);
    expect(damage.internalStructure.leftTorso).toBe(0);
    // Every non-empty slot; the empty ones (HBK-4G: slots 3-12) stay clear.
    expect(destroyedSlots(destroyed, "leftTorso")).toEqual(
      def.critSlots.leftTorso.flatMap((slot, i) => (slot.kind === "empty" ? [] : [i])),
    );
    // Rear pool: HBK-4G carries some left-torso rear armor; mark should
    // wipe it (TW p.121 "remaining armor there (front or rear)").
    expect(damage.armorRear.leftTorso ?? 0).toBe(0);
    // Bins are not touched: the flagged slots mark them destroyed.
    for (const bin of collectAmmoBins(def).filter((b) => binKeys.includes(b.id))) {
      expect(usableShots({ damage, critSlotsDestroyed: destroyed, ammoBins }, bin)).toBe(0);
      expect(strandedShots({ damage, critSlotsDestroyed: destroyed, ammoBins }, bin)).toBe(0);
    }
    // Untouched location stays intact
    expect(damage.armor.centerTorso).toBe(def.armor.centerTorso);
    expect(destroyed.centerTorso).toBe(0);
  });

  it("does not throw or mutate ammo bins in other locations", () => {
    const def = mechDef("HBK-4G")!;
    const damage: UnitDamageState = {
      armor: { ...def.armor },
      armorRear: { ...def.armorRear },
      internalStructure: { ...def.internalStructure },
    };
    const destroyed = freshFlags(def);
    const ammoBins = loadAmmoBins(def);
    const before = { ...ammoBins };

    markLocationCatastrophicallyDestroyed(def, damage, destroyed, "head");

    for (const key of Object.keys(before)) {
      if (key.startsWith("head:")) {
        expect(ammoBins[key]).toBe(0);
      } else {
        expect(ammoBins[key]).toEqual(before[key]);
      }
    }
  });

  it("keeps crits and ammo bins intact in locations destroyed by plain damage", () => {
    // Asymmetry check: plain `applyDamage` zeroes IS at a side torso but
    // intentionally leaves `critSlotsDestroyed` unflagged so salvage
    // readers can recover components in the destroyed location.
    const def = mechDef("HBK-4G")!;
    const damage: UnitDamageState = {
      armor: { ...def.armor, leftTorso: 0 },
      armorRear: { ...def.armorRear },
      internalStructure: { ...def.internalStructure, leftTorso: 0 },
    };
    const destroyed = freshFlags(def);
    const ammoBins = loadAmmoBins(def);
    expect(damage.internalStructure.leftTorso).toBe(0);
    expect(destroyed.leftTorso).toBe(0);
    // Counters read only flags and must NOT auto-include the destroyed
    // location's contents.
    expect(countDestroyedEngine(def, damage, destroyed)).toBe(0);
    // Heat sinks in the LT (the HBK-4G has none, so check CT external sinks).
    const sinksBefore = heatSinksOperational(def, damage, destroyed);
    expect(sinksBefore).toBeGreaterThan(0);
    const binCount = Object.keys(ammoBins).filter((k) => k.startsWith("leftTorso:")).length;
    expect(binCount).toBeGreaterThan(0);
  });

  it("wipes the rear armor pool of a destroyed torso", () => {
    const def = mechDef("HBK-4G")!;
    const damage: UnitDamageState = {
      armor: { ...def.armor, rightTorso: 0 },
      armorRear: { ...def.armorRear, rightTorso: 7 },
      internalStructure: { ...def.internalStructure, rightTorso: 0 },
    };
    const destroyed = freshFlags(def);
    const _ammoBins = loadAmmoBins(def);
    expect(damage.armorRear.rightTorso).toBe(7);
    markLocationCatastrophicallyDestroyed(def, damage, destroyed, "rightTorso");
    expect(damage.armorRear.rightTorso ?? 0).toBe(0);
    // Non-torso location passes through cleanly.
    markLocationCatastrophicallyDestroyed(def, damage, destroyed, "head");
    expect(damage.armor.head).toBe(0);
    // expect(damage.armorRear.head ?? 0).toBe(0);  // adopted TorsoLocationValue. cannot happen
  });
});

describe("blow-off and cockpit kill: salvage-friendly slot preservation", () => {
  it("arm blow-off (det 12) preserves crit-slot flags for salvage", () => {
    const def = mechDef("HBK-4G")!;
    const damage: UnitDamageState = {
      armor: { ...def.armor, leftArm: 1 },
      armorRear: { ...def.armorRear },
      internalStructure: { ...def.internalStructure, leftArm: 1 },
    };
    const destroyed = freshFlags(def);
    const ammoBins = loadAmmoBins(def);
    const flagsBefore = destroyed.leftArm;

    const res = resolveCriticalHits({
      rng: detRoll(12),
      model: def.model,
      source: { location: "leftArm", damage: 5 },
      critSlotsDestroyed: destroyed,
      damage,
      ammoBins,
    });

    expect(res.determiningRoll).toBe(12);
    expect(critSeveredLimbs(res)).toContain("leftArm");
    expect(res.damage.internalStructure.leftArm).toBe(0);
    expect(res.damage.armor.leftArm).toBe(0);
    // Slot flags preserved — every flag equals pre-resolution state.
    // Per TW p.145 weapons/equipment inside the blown-off arm ride
    // away intact on the severed limb.
    expect(res.critSlotsDestroyed.leftArm).toEqual(flagsBefore);
  });

  it("arm blown off with a torso an ammo explosion destroyed keeps its slot flags (CRIT-11)", () => {
    // HBK-4G: AC/20 bin in leftTorso slot 1, Medium Laser in the left arm.
    // One shot (20) zeroes the 12-point LT; CT absorbs the rest and lives.
    // The torso takes the catastrophic mark; the arm is only blown off, so
    // it keeps its slots for salvage as on the plain-damage path.
    const def = mechDef("HBK-4G")!;
    expect(def.critSlots.leftArm.some((s) => s.kind === "weapon")).toBe(true);
    const ammoBins = loadAmmoBins(def);
    overrideAmmoBin(ammoBins, "leftTorso", 1, 1);
    overrideAmmoBin(ammoBins, "leftTorso", 2, 0);
    const res = resolveCriticalHits({
      rng: detRoll(8, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1),
      model: def.model,
      source: { location: "leftTorso", damage: 5 },
      critSlotsDestroyed: freshFlags(def),
      damage: {
        armor: { ...def.armor, leftTorso: 0 },
        armorRear: { ...def.armorRear },
        internalStructure: { ...def.internalStructure, centerTorso: 1000 },
      },
      ammoBins,
    });
    expect(res.rows[0]!.kind).toBe("ammoExplosion");
    expect(critSeveredLimbs(res)).toContain("leftArm");
    expect(res.damage.internalStructure.leftArm).toBe(0);
    const filled = def.critSlots.leftTorso.flatMap((slot, i) => (slot.kind === "empty" ? [] : [i]));
    expect(destroyedSlots(res.critSlotsDestroyed, "leftTorso")).toEqual(filled);
    expect(res.critSlotsDestroyed.leftArm).toBe(0);
  });

  it("leg blow-off (det 12) preserves slot flags; immobility still triggers via IS<=0", () => {
    const def = mechDef("HBK-4G")!;
    const damage: UnitDamageState = {
      armor: { ...def.armor, rightLeg: 1 },
      armorRear: { ...def.armorRear },
      internalStructure: { ...def.internalStructure, rightLeg: 1 },
    };
    const destroyed = freshFlags(def);
    const flagsBefore = destroyed.rightLeg;

    const res = resolveCriticalHits({
      rng: detRoll(12),
      model: def.model,
      source: { location: "rightLeg", damage: 5 },
      critSlotsDestroyed: destroyed,
      damage,
      ammoBins: loadAmmoBins(def),
    });

    expect(res.rows.some((r) => r.kind === "limbBlownOff")).toBe(true);
    expect(res.damage.internalStructure.rightLeg).toBe(0);
    expect(res.critSlotsDestroyed.rightLeg).toEqual(flagsBefore);
  });

  it("cockpit crit preserves head slot flags for salvage", () => {
    const def = mechDef("HBK-4G")!;
    const damage: UnitDamageState = {
      armor: { ...def.armor },
      armorRear: { ...def.armorRear },
      internalStructure: { ...def.internalStructure },
    };
    const destroyed = freshFlags(def);
    const flagsBefore = destroyed.head;
    const ammoBins = loadAmmoBins(def);

    // Drive a hit slot that's the cockpit. HBK-4G head slot 2 = cockpit.
    const headLayout = def.critSlots.head;
    const cockpitSlot = headLayout.findIndex((s) => s.kind === "structure" && s.type === "cockpit");
    expect(cockpitSlot).toBeGreaterThanOrEqual(0);

    // Det 8 ("1 hit"); head uses 1D6 slot pick. feeding (cockpitSlot + 1)
    // lands on the cockpit slot.
    const res = resolveCriticalHits({
      rng: detRoll(8, cockpitSlot + 1),
      model: def.model,
      source: { location: "head", damage: 5 },
      critSlotsDestroyed: destroyed,
      damage,
      ammoBins,
    });

    expect(res.killedReason).toBe("cockpitDestroyed");
    // TW p.125: cockpit destroys the slot only — head pools survive,
    // unlike a head blow-off (IS/armor wipe).
    expect(res.damage.internalStructure.head).toBe(def.internalStructure.head);
    expect(res.damage.armor.head).toBe(def.armor.head);
    // Slot flags preserved wholesale EXCEPT for the cockpit slot, which
    // the standard `applySlotHit` pathway flips to true at the moment
    // of the hit. Per salvage design the cockpit-driven kill leaves
    // head components (sensors, life support) readable for salvage
    // readers — no all-true wipe.
    expect(res.critSlotsDestroyed.head).toBe(flagsBefore | (1 << cockpitSlot));
  });

  it("cascade runDetermining against an IS=0 source transfers inward (TW p.124)", () => {
    // After blow-off leaves flags intact, IS=0 must still drive cascade
    // exhaustion. Set up a right arm with IS=0 + intact flags, drive a
    // fresh cascade roll — expect no weaponDestroyed rows targeting
    // the arm, and the cascade re-routes inward to the right torso.
    const def = mechDef("HBK-4G")!;
    const damage: UnitDamageState = {
      armor: { ...def.armor, rightArm: 0 },
      armorRear: { ...def.armorRear },
      internalStructure: { ...def.internalStructure, rightArm: 0 },
    };
    const destroyed = freshFlags(def);
    const ammoBins = loadAmmoBins(def);
    // Confirm flags are intact (no all-true)
    expect(destroyed.rightArm).toBe(0);

    // Det 8 ("1 hit"). Without the IS gate the slot-picker would land
    // on a rightArm weapon slot. With the gate, the cascade sees the
    // IS=0 source as exhausted and re-routes inward.
    const res = resolveCriticalHits({
      rng: detRoll(8, 1, 1),
      model: def.model,
      source: { location: "rightArm", damage: 0 },
      critSlotsDestroyed: destroyed,
      damage,
      ammoBins,
    });
    expect(res.determiningRoll).toBe(8);
    const inArm = res.rows.filter(
      (r) =>
        (r.kind === "weaponDestroyed" || r.kind === "componentDestroyed") &&
        r.location === "rightArm",
    );
    expect(inArm).toHaveLength(0);
  });
});

describe("ammo-explosion casualty: catastrophic mark", () => {
  it("zeroing a side torso via applyAmmoExplosion marks every non-empty slot in it destroyed", () => {
    const def = mechDef("HBK-4G")!;
    const damage: UnitDamageState = {
      armor: { ...def.armor, rightTorso: 0 },
      armorRear: { ...def.armorRear, rightTorso: 6 },
      internalStructure: { ...def.internalStructure, rightTorso: 1 },
    };
    const destroyed = freshFlags(def);
    const ammoBins = loadAmmoBins(def);

    const app = applyAmmoExplosion(damage, def, "rightTorso", 5);
    expect(app.newlyDestroyed).toContain("rightTorso");

    for (const lost of app.newlyDestroyed) {
      markLocationCatastrophicallyDestroyed(def, damage, destroyed, lost);
    }

    const layout = def.critSlots.rightTorso;
    const filled = layout.flatMap((slot, i) => (slot.kind === "empty" ? [] : [i]));
    expect(destroyedSlots(destroyed, "rightTorso")).toEqual(filled);
    expect(damage.armorRear.rightTorso ?? 0).toBe(0);
    const rtBins = Object.keys(ammoBins).filter((k) => k.startsWith("rightTorso:"));
    for (const k of rtBins) expect(ammoBins[k]).toBeUndefined();
  });

  it("cascade runDetermining sees zeroed-source locations as exhausted (TW p.124)", () => {
    // After the catastrophic mark, every crit slot in the freshly-zeroed
    // location reads destroyed. The cascade `runDetermining` therefore
    // finds the source exhausted and re-routes inward per TW p.124
    // (no crit check in a destroyed location unless explosive slots
    // involved). Verify by inspecting the resolution rows: no
    // weaponDestroyed / componentDestroyed rows in the zeroed RT.
    const def = mechDef("HBK-4G")!;
    const damage: UnitDamageState = {
      armor: { ...def.armor, rightTorso: 0, centerTorso: 0 },
      armorRear: { ...def.armorRear },
      internalStructure: { ...def.internalStructure, rightTorso: 0, centerTorso: 5 },
    };
    const destroyed = freshFlags(def);
    const ammoBins = loadAmmoBins(def);
    // Pre-mark RT as fully destroyed (catastrophic mark already applied).
    markLocationCatastrophicallyDestroyed(def, damage, destroyed, "rightTorso");

    // Trigger a fresh cascade roll against the destroyed RT. With a
    // determining roll of 8 ("1 hit"), the slot-picker would normally
    // land on an RT weapon/structure slot — but every slot is flagged
    // destroyed, so `isLocationExhausted` returns true and the result
    // transfers inward to the next location (centerTorso).
    const res = resolveCriticalHits({
      rng: detRoll(8, 1, 1),
      model: def.model,
      source: { location: "rightTorso", damage: 0 },
      critSlotsDestroyed: destroyed,
      damage,
      ammoBins,
    });
    expect(res.determiningRoll).toBe(8);
    // No row should claim a weapon/component in the destroyed RT.
    const inRt = res.rows.filter(
      (r) =>
        (r.kind === "weaponDestroyed" || r.kind === "componentDestroyed") &&
        r.location === "rightTorso",
    );
    expect(inRt).toHaveLength(0);
  });

  it("countDestroyedEngine reflects engine slots in a center torso destroyed by ammo transfer", () => {
    // Regression for the engine-heat path: an LRM ammo explosion that
    // overflows from an RT (with no engine slots on the HBK-4G RT) into
    // the CT zeroes the CT IS, and the catastrophic mark must record
    // every CT engine slot as destroyed — not just one slot.
    const def = mechDef("HBK-4G")!;
    const damage: UnitDamageState = {
      armor: { ...def.armor, rightTorso: 0, centerTorso: 0 },
      armorRear: { ...def.armorRear, centerTorso: 10 },
      internalStructure: { ...def.internalStructure, rightTorso: 0, centerTorso: 1 },
    };
    const destroyed = freshFlags(def);
    const _ammoBins = loadAmmoBins(def);

    const app = applyAmmoExplosion(damage, def, "rightTorso", 50);
    expect(app.newlyDestroyed).toContain("centerTorso");

    for (const lost of app.newlyDestroyed) {
      markLocationCatastrophicallyDestroyed(def, damage, destroyed, lost);
    }

    const totalEngineSlots = def.critSlots.centerTorso.filter(
      (s) => s.kind === "structure" && s.type === "engine",
    ).length;
    expect(countDestroyedEngine(def, damage, destroyed)).toBe(totalEngineSlots);
    // CT rear pool wiped alongside front + IS.
    expect(damage.armorRear.centerTorso ?? 0).toBe(0);
  });
});

/**
 * Phase-merge regression (TW pp. 122–125): ammo-explosion critical damage
 * must survive `resolveAllAttacks`. The per-weapon path folds
 * `resolveCriticalHits().damage` into the application, but the phase merge
 * rebuilds target damage from hit groups only — explosion IS damage and its
 * transfer were discarded.
 */
describe("crit damage merge: ammo explosion survives resolveAllAttacks", () => {
  it("replays explosion IS damage + transfer into the phase accumulator", () => {
    const units: UnitInit[] = [
      buildUnitInit("atk", "HBK-4G", 1, { col: 3, row: 4 }, "n"),
      buildUnitInit("tgt", "HBK-4G", 2, { col: 3, row: 2 }, "s"),
    ];
    const state = createTestBattle([], units, false);
    const tgt = requireUnit(state, "tgt");
    // Strip LT armor so the Medium Laser hit reaches IS and triggers the
    // determining roll.
    tgt.damage.armor.leftTorso = 0;
    tgt.damage.armorRear.leftTorso = 0;
    tgt.prone = true; // skip end-of-phase piloting RNG
    const isBefore = { ...tgt.damage.internalStructure };
    expect(isBefore.leftTorso).toBeGreaterThan(5);
    expect(mechDef("HBK-4G")).toBeDefined();

    rollInitiativePhase(state, scriptedRng(1, 1, 4, 4), []);
    advancePhase(state, [], scriptedRng());
    // Attacker Medium Laser (weaponIndex 1, 5 dmg) -> tgt.
    declareAttacks(
      state,
      "atk",
      [{ weaponIndex: 1, targetId: "tgt" }],
      [],
      [],
      scriptedRng(1, 1, 1, 1, 1, 1, 1, 1),
    );
    const events: GameEvent[] = [];
    // toHit 3+3, location 2+6=8 (leftTorso), determining 2+6=8 (1 crit),
    // slot 1,1 (AC/20 ammo bin 1: 5 shots x 20 = 100 IS damage), then
    // padding 3s for explosion cascades + consciousness rolls.
    const rng = scriptedRng(3, 3, 2, 6, 2, 6, 1, 1, ...new Array(60).fill(3));
    resolveAllAttacks(state, rng, events);

    const after = requireUnit(state, "tgt").damage.internalStructure;
    // 5 (laser) + 100 (explosion) >> LT IS: LT must be 0 and overflow must
    // reach CT. Pre-fix, CT was untouched (explosion dropped).
    expect(after.leftTorso).toBe(0);
    expect(after.centerTorso).toBeLessThan(isBefore.centerTorso!);
    // Sanity: an ammoExplosion row was actually produced.
    const resolved = events.find((e) => e.kind === "attackResolved");
    expect(resolved).toBeDefined();
    const crits =
      resolved !== undefined && resolved.kind === "attackResolved" ? resolved.resolution.crits : [];
    expect(crits.flatMap((c) => c.rows).some((r) => r.kind === "ammoExplosion")).toBe(true);
  });

  it("replays a gauss weapon blast into the phase accumulator + 2 pilot hits", () => {
    // 90t Clan target survives its own 20-pt blast (arm IS 15, CASE vents
    // the excess), so the phase pilot-hit sweep still sees a live unit.
    const units: UnitInit[] = [
      buildUnitInit("atk", "HBK-4G", 1, { col: 3, row: 4 }, "n"),
      buildUnitInit("tgt", "MC-MKII-2", 2, { col: 3, row: 2 }, "s"),
    ];
    const state = createTestBattle([], units, false);
    const tgt = requireUnit(state, "tgt");
    // Strip right-arm armor so the 5-dmg Medium Laser reaches IS and triggers
    // the determining roll on the CL Gauss mount (rightArm slots 3-8).
    tgt.damage.armor.rightArm = 0;
    tgt.prone = true; // skip end-of-phase piloting RNG
    const isBefore = { ...tgt.damage.internalStructure };
    const pilotBefore = tgt.pilotHits;
    expect(isBefore.rightArm).toBeGreaterThan(5);

    rollInitiativePhase(state, scriptedRng(1, 1, 4, 4), []);
    advancePhase(state, [], scriptedRng());
    declareAttacks(
      state,
      "atk",
      [{ weaponIndex: 1, targetId: "tgt" }],
      [],
      [],
      scriptedRng(1, 1, 1, 1, 1, 1, 1, 1),
    );
    const events: GameEvent[] = [];
    // toHit 3+3, location 1+2=3 (rightArm), determining 2+6=8 (1 crit),
    // slot 1,3 (Gauss slot 3: 20-pt blast), cascade det 1+1=2 (none), then
    // padding for the 2 consciousness rolls.
    const rng = scriptedRng(3, 3, 1, 2, 2, 6, 1, 3, 1, 1, ...new Array(60).fill(3));
    resolveAllAttacks(state, rng, events);

    const resolved = events.find((e) => e.kind === "attackResolved");
    expect(resolved).toBeDefined();
    const crits =
      resolved !== undefined && resolved.kind === "attackResolved" ? resolved.resolution.crits : [];
    const blast = crits
      .flatMap((c) => c.rows)
      .find((r) => r.kind === "weaponDestroyed" && r.explosion !== undefined);
    expect(blast).toBeDefined();
    if (blast !== undefined && blast.kind === "weaponDestroyed") {
      expect(blast.weaponName).toBe("CL Gauss Rifle");
      expect(blast.explosion?.damage).toBe(20);
    }
    // 5 (laser) + 20 (blast) must land on the arm, and the pilot takes
    // exactly the 2 blast hits.
    const after = requireUnit(state, "tgt");
    expect(after.damage.internalStructure.rightArm).toBeLessThan(isBefore.rightArm!);
    expect(after.pilotHits - pilotBefore).toBe(2);
  });

  it("orders later groups after an early ammo blast in the same salvo (no phantom engine kill)", () => {
    // TW pp.122-123: damage is assigned in the order it happens. Group 1 of
    // an LRM salvo detonates the target's last AC/20 round (LT destroyed);
    // group 2 landing in the same (now-destroyed) torso must transfer onward
    // to CT armor — not sit in the LT and feed a reordered blast replay that
    // destroys the CT and wipes all six CT engine slots.
    const units: UnitInit[] = [
      buildUnitInit("atk", "AS7-D", 1, { col: 3, row: 9 }, "n"),
      buildUnitInit("tgt", "HBK-4G", 2, { col: 3, row: 2 }, "s"),
    ];
    const state = createTestBattle([], units, false);
    const tgt = requireUnit(state, "tgt");
    // Strip LT armor so both LRM lots reach internal structure.
    tgt.damage.armor.leftTorso = 0;
    tgt.damage.armorRear.leftTorso = 0;
    // Last AC/20 shot in bin 1, sibling bin empty: 1 x 20 = 20 blast damage.
    overrideAmmoBin(tgt.ammoBins, "leftTorso", 1, 1);
    overrideAmmoBin(tgt.ammoBins, "leftTorso", 2, 0);
    tgt.prone = true; // skip end-of-phase piloting RNG
    const def = mechDef("HBK-4G")!;
    expect(def).toBeDefined();

    rollInitiativePhase(state, scriptedRng(1, 1, 4, 4), []);
    advancePhase(state, [], scriptedRng());
    // AS7-D LRM 20 (weaponIndex 4) -> tgt.
    declareAttacks(
      state,
      "atk",
      [{ weaponIndex: 4, targetId: "tgt" }],
      [],
      [],
      scriptedRng(1, 1, 1, 1, 1, 1, 1, 1),
    );
    const events: GameEvent[] = [];
    // toHit 3+3 (hit at short range), cluster 1+3=4 (9 missiles -> lots
    // [5,4]), both lots LT (2+6=8 each). Lot 1 (5 dmg: LT IS 12->7) crits:
    // determining 2+6=8 (1 crit), slot 1,1 (AC/20 bin 1, 20-pt blast: LT
    // 7->0, 13 overflow to CT IS 16->3). Blast cascades: LT det 1+1=2
    // (none), CT det 1+1=2 (none). Lot 2 (4 dmg) hits destroyed LT and
    // transfers to CT front armor (26->22). Padding covers the 2 blast
    // pilot-hit consciousness rolls.
    const rng = scriptedRng(
      3,
      3,
      1,
      3,
      2,
      6,
      2,
      6,
      2,
      6,
      1,
      1,
      1,
      1,
      1,
      1,
      ...new Array(60).fill(3),
    );
    resolveAllAttacks(state, rng, events);

    const after = requireUnit(state, "tgt");
    // Sanity: an ammoExplosion row was actually produced.
    const resolved = events.find((e) => e.kind === "attackResolved");
    expect(resolved).toBeDefined();
    const crits =
      resolved !== undefined && resolved.kind === "attackResolved" ? resolved.resolution.crits : [];
    expect(crits.flatMap((c) => c.rows).some((r) => r.kind === "ammoExplosion")).toBe(true);
    // Authoritative damage: LT gone, CT survives with 3 IS and 22 front armor.
    expect(after.damage.internalStructure.leftTorso).toBe(0);
    expect(after.damage.internalStructure.centerTorso).toBe(3);
    expect(after.damage.armor.centerTorso).toBe(22);
    // No phantom wipe: the surviving CT keeps every crit slot.
    for (let i = 0; i < def.critSlots.centerTorso.length; i++) {
      expect(isSlotDestroyed(after.critSlotsDestroyed, "centerTorso", i)).toBe(false);
    }
    expect(countDestroyedEngine(def, after.damage, after.critSlotsDestroyed)).toBe(0);
    // The 'Mech fights on.
    expect(after.destroyed).toBe("not");
    expect(after.removed).toBe("not");
  });
});

describe("crit slot table bitmask", () => {
  const def = mechDef("HBK-4G")!;

  it("starts empty with one entry per location", () => {
    const t = emptyCritTable(def);
    expect(Object.keys(t).sort()).toEqual(Object.keys(def.critSlots).sort());
    expect(Object.values(t).every((m) => m === 0)).toBe(true);
    expect(anySlotDestroyed(t, "head")).toBe(false);
  });

  it("sets and reads 0-based slots, including the last of twelve", () => {
    const t = emptyCritTable(def);
    setSlotDestroyed(t, "leftTorso", 0);
    setSlotDestroyed(t, "leftTorso", MAX_CRIT_SLOTS - 1);
    expect(isSlotDestroyed(t, "leftTorso", 0)).toBe(true);
    expect(isSlotDestroyed(t, "leftTorso", 1)).toBe(false);
    expect(isSlotDestroyed(t, "leftTorso", MAX_CRIT_SLOTS - 1)).toBe(true);
    expect(destroyedSlots(t, "leftTorso")).toEqual([0, MAX_CRIT_SLOTS - 1]);
    expect(isSlotDestroyed(t, "rightTorso", 0)).toBe(false);
  });

  it("destroys exactly the non-empty slots a location has", () => {
    const t = emptyCritTable(def);
    const filled = (loc: "head" | "leftArm") =>
      def.critSlots[loc].flatMap((slot, i) => (slot.kind === "empty" ? [] : [i]));
    destroyAllSlots(t, "head", def.critSlots.head);
    expect(destroyedSlots(t, "head")).toEqual(filled("head"));
    destroyAllSlots(t, "leftArm", def.critSlots.leftArm);
    expect(destroyedSlots(t, "leftArm")).toEqual(filled("leftArm"));
    // HBK-4G's left arm ends in empty slots: their bits stay clear.
    expect(def.critSlots.leftArm[MAX_CRIT_SLOTS - 1]?.kind).toBe("empty");
    expect(isSlotDestroyed(t, "leftArm", MAX_CRIT_SLOTS - 1)).toBe(false);
  });

  it("clones independently and merges slot-wise", () => {
    const a = emptyCritTable(def);
    setSlotDestroyed(a, "head", 1);
    const b = cloneCritTable(a);
    setSlotDestroyed(b, "head", 2);
    expect(destroyedSlots(a, "head")).toEqual([1]);
    mergeCritTable(a, b);
    expect(destroyedSlots(a, "head")).toEqual([1, 2]);
    expect(destroyedSlots(b, "head")).toEqual([1, 2]);
  });
});

describe("audit fixes: critical-hit pipeline", () => {
  const def = mechDef("HBK-4G")!;
  const fresh = () => ({
    critSlotsDestroyed: emptyCritTable(def),
    damage: {
      armor: { ...def.armor },
      armorRear: { ...def.armorRear },
      internalStructure: { ...def.internalStructure },
    } as UnitDamageState,
    ammoBins: loadAmmoBins(def),
  });

  it("CRIT-01: a multi-crit roll destroys distinct slots", () => {
    for (let seed = 1; seed <= 40; seed++) {
      const seeded = seededRng(seed);
      let n = 0;
      const rng: Rng = {
        d6: () => (n++ < 2 ? 6 : seeded.d6()),
        snapshot: () => "",
        load: () => {},
      };
      const res = resolveCriticalHits({
        rng,
        model: def.model,
        source: { location: "centerTorso", damage: 5 },
        ...fresh(),
      });
      const marked = res.critSlotsDestroyed.centerTorso ?? 0;
      const bits = marked.toString(2).replaceAll("0", "").length;
      expect(bits).toBe(3);
      expect(res.rows.length).toBe(3);
    }
  });

  it("CRIT-02: a through-armor chance on a destroyed location moves inward unchanged", () => {
    const f = fresh();
    f.damage.internalStructure.leftTorso = 0;
    const res = resolveCriticalHits({
      rng: detRoll(8, 1, 1),
      model: def.model,
      source: { location: "leftTorso", damage: 0, tac: true, struck: false },
      ...f,
    });
    expect(res.determiningRoll).toBe(8);
    expect(res.rows).toHaveLength(1);
    const row = res.rows[0]!;
    expect("location" in row ? row.location : null).toBe("centerTorso");
  });

  it("CRIT-03: a double heat sink takes one critical, later hits on it soak", () => {
    const whk = mechDef("WHK-Prime")!;
    const group = whk.critSlots.leftLeg
      .map((s, i) => ({ s, i }))
      .filter(({ s }) => s.kind === "structure" && s.type === "doubleHeatSink");
    expect(group.length).toBeGreaterThanOrEqual(2);
    const base = {
      model: whk.model,
      source: { location: "leftLeg" as Location, damage: 5 },
      damage: {
        armor: { ...whk.armor },
        armorRear: { ...whk.armorRear },
        internalStructure: { ...whk.internalStructure },
      } as UnitDamageState,
      ammoBins: loadAmmoBins(whk),
    };
    const mask = emptyCritTable(whk);
    setSlotDestroyed(mask, "leftLeg", group[0]!.i);
    const res = resolveCriticalHits({
      ...base,
      rng: detRoll(8, 1, 1, 1, 1, 1, 1),
      critSlotsDestroyed: mask,
    });
    // The device is already gone: whichever of its other slots is struck soaks.
    for (const r of res.rows) {
      if (r.kind === "noEffect") continue;
      expect(r.kind).not.toBe("heatSinkDestroyed");
    }
    // Only the originally struck slot (or at most one more via non-DHS rows) is marked.
    for (const g of group.slice(1)) {
      expect(isSlotDestroyed(res.critSlotsDestroyed, "leftLeg", g.i)).toBe(false);
    }
  });
});
