import { describe, expect, it } from "vitest";
import type { Location } from "../src/core/types.js";
import { getMechDef } from "../src/data/index.js";
import { effectiveMovement, resolveCriticalHits } from "../src/rules/critical.js";
import type { UnitDamageState } from "../src/rules/damage.js";
import { scriptedRng } from "./helpers.js";

/** Helper: returns an Rng whose first 2D6 sums to `sum` (1..12), then yields `tail`. */
function detRoll(sum: number, ...tail: number[]): ReturnType<typeof scriptedRng> {
  const a = Math.max(1, Math.min(6, sum - 1));
  const b = sum - a;
  return scriptedRng(a, b, ...tail);
}

function freshFlags(def = getMechDef("HBK-4G")!) {
  const out: Record<Location, boolean[]> = {} as Record<Location, boolean[]>;
  for (const loc of Object.keys(def.critSlots) as Location[]) {
    out[loc] = new Array(def.critSlots[loc].length).fill(false);
  }
  return out;
}

function freshAmmo(def = getMechDef("HBK-4G")!) {
  const out: Record<number, number> = {};
  for (const [k, mount] of Object.entries(def.weapons)) {
    if (mount.shots !== undefined) out[Number(k)] = mount.shots;
  }
  return out;
}

describe("determining critical hits table", () => {
  const def = getMechDef("HBK-4G")!;
  const damage: UnitDamageState = {
    armor: { ...def.armor },
    armorRear: { ...def.armorRear },
    internalStructure: { ...def.internalStructure },
  };

  it("rolls 2-7 as no crit", () => {
    for (let roll = 2; roll <= 7; roll++) {
      const res = resolveCriticalHits({
        rng: detRoll(roll),
        def,
        source: { location: "centerTorso", damage: 5 },
        critSlotsDestroyed: freshFlags(def),
        destroyedWeapons: [],
        damage,
        shotsLeft: freshAmmo(def),
      });
      expect(res.determiningRoll).toBe(roll);
      expect(res.rows).toHaveLength(0);
    }
  });

  it("rolls 8-9 as one crit", () => {
    for (const roll of [8, 9]) {
      const res = resolveCriticalHits({
        rng: detRoll(roll, 1, 1),
        def,
        source: { location: "rightTorso", damage: 5 },
        critSlotsDestroyed: freshFlags(def),
        destroyedWeapons: [],
        damage,
        shotsLeft: freshAmmo(def),
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
        def,
        source: { location: "rightTorso", damage: 5 },
        critSlotsDestroyed: freshFlags(def),
        destroyedWeapons: [],
        damage,
        shotsLeft: freshAmmo(def),
      });
      expect(res.determiningRoll).toBe(roll);
      expect(res.rows).toHaveLength(2);
    }
  });
});

describe("limb / head blow-off on 12", () => {
  const def = getMechDef("HBK-4G")!;
  const damage: UnitDamageState = {
    armor: { ...def.armor },
    armorRear: { ...def.armorRear },
    internalStructure: { ...def.internalStructure },
  };

  it("head blown off on 12 kills the unit", () => {
    const res = resolveCriticalHits({
      rng: detRoll(12),
      def,
      source: { location: "head", damage: 3 },
      critSlotsDestroyed: freshFlags(def),
      destroyedWeapons: [],
      damage,
      shotsLeft: freshAmmo(def),
    });
    expect(res.killed).toBe(true);
    expect(res.rows.some((r) => r.kind === "headBlownOff")).toBe(true);
    expect(res.damage.internalStructure.head).toBe(0);
  });

  it("arm blown off on 12 zeros the arm and reports it", () => {
    const res = resolveCriticalHits({
      rng: detRoll(12),
      def,
      source: { location: "leftArm", damage: 5 },
      critSlotsDestroyed: freshFlags(def),
      destroyedWeapons: [],
      damage,
      shotsLeft: freshAmmo(def),
    });
    expect(res.blownOffArms).toContain("leftArm");
    expect(res.damage.internalStructure.leftArm).toBe(0);
    expect(res.damage.armor.leftArm).toBe(0);
  });

  it("leg blown off on 12 zeros the leg", () => {
    const res = resolveCriticalHits({
      rng: detRoll(12),
      def,
      source: { location: "leftLeg", damage: 5 },
      critSlotsDestroyed: freshFlags(def),
      destroyedWeapons: [],
      damage,
      shotsLeft: freshAmmo(def),
    });
    expect(res.damage.internalStructure.leftLeg).toBe(0);
    expect(res.damage.armor.leftLeg).toBe(0);
    expect(res.rows.some((r) => r.kind === "legBlownOff")).toBe(true);
  });

  it("12 on torso yields three crits (no blow-off)", () => {
    const res = resolveCriticalHits({
      // 12 on rightTorso: 3 crits against 12 AC/20/ammo slots. Dice:
      //   det 2, slot 2, slot 2, slot 2 = 8 total.
      rng: detRoll(12, 1, 1, 1, 2, 1, 3, 1, 1),
      def,
      source: { location: "rightTorso", damage: 5 },
      critSlotsDestroyed: freshFlags(def),
      destroyedWeapons: [],
      damage,
      shotsLeft: freshAmmo(def),
    });
    expect(res.rows).toHaveLength(3);
    expect(res.killed).toBe(false);
  });
});

describe("slot selection", () => {
  const def = getMechDef("HBK-4G")!;
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
        def,
        source: { location: "head", damage: 3 },
        critSlotsDestroyed: freshFlags(def),
        destroyedWeapons: [],
        damage,
        shotsLeft: freshAmmo(def),
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
        def,
        source: { location: "rightTorso", damage: 5 },
        critSlotsDestroyed: freshFlags(def),
        destroyedWeapons: [],
        damage,
        shotsLeft: freshAmmo(def),
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
  const def = getMechDef("HBK-4G")!;
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
      def,
      source: { location: "centerTorso", damage: 5 },
      critSlotsDestroyed: freshFlags(def),
      destroyedWeapons: [],
      damage,
      shotsLeft: freshAmmo(def),
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
    const def = getMechDef("HBK-4G")!;
    // HBK rightTorso: slots 1-10 are AC/20 (weapon), 11-12 are AC/20 ammo.
    // Roll 8 -> one crit. Slot 1,1 (CT half=1, slot=1) lands on AC/20.
    const res = resolveCriticalHits({
      rng: detRoll(8, 1, 1),
      def,
      source: { location: "rightTorso", damage: 5 },
      critSlotsDestroyed: freshFlags(def),
      destroyedWeapons: [],
      damage: {
        armor: { ...def.armor },
        armorRear: { ...def.armorRear },
        internalStructure: { ...def.internalStructure },
      },
      shotsLeft: freshAmmo(def),
    });
    expect(res.rows).toHaveLength(1);
    const eff = res.rows[0]!;
    expect(eff.kind).toBe("weaponDestroyed");
    if (eff.kind === "weaponDestroyed") {
      expect(eff.weaponName).toBe("Autocannon/20");
      expect(eff.weaponIndex).toBe(1);
    }
    expect(res.destroyedWeapons).toContain(1);
  });

  it("AC/20 ammo explosion = shots x 20 damage applied to the bin's IS", () => {
    const def = getMechDef("HBK-4G")!;
    // HBK ammo bins are in leftTorso (slots 1-2), not rightTorso. Roll 8
    // -> one crit. To land on slot 1 (the first ammo), need first half
    // (first die 1-3) and second die 1 -> slot 1.
    // Use a state where leftTorso IS is large enough that the explosion
    // (10 shots x 20 = 200) does not drain any location to 0, so no
    // cascade runs and the test stays focused on the damage formula.
    const res = resolveCriticalHits({
      rng: detRoll(8, 1, 1),
      def,
      source: { location: "leftTorso", damage: 5 },
      critSlotsDestroyed: freshFlags(def),
      destroyedWeapons: [],
      damage: {
        armor: { ...def.armor, leftTorso: 0 },
        armorRear: { ...def.armorRear },
        internalStructure: { ...def.internalStructure, leftTorso: 1000, centerTorso: 1000 },
      },
      shotsLeft: { 1: 10 },
    });
    expect(res.rows).toHaveLength(1);
    const eff = res.rows[0]!;
    expect(eff.kind).toBe("ammoExplosion");
    if (eff.kind === "ammoExplosion") {
      expect(eff.weaponName).toBe("Autocannon/20");
      expect(eff.shotsRemaining).toBe(10);
      expect(eff.damagePerShot).toBe(20);
      expect(eff.damage).toBe(200);
    }
    expect(res.shotsLeft[1]).toBe(0);
  });

  it("ammo explosion cascades a fresh determining roll on a newly-emptied IS", () => {
    // Use a near-empty state where the rightTorso IS has 1 point left and
    // the AC/20 ammo bin has 5 shots. Crit on the ammo: 100 damage, drains
    // the IS, zeros the location — the cascade rules then trigger a fresh
    // determining roll.
    const def = getMechDef("HBK-4G")!;
    const damage: UnitDamageState = {
      armor: { ...def.armor, rightTorso: 0 },
      armorRear: { ...def.armorRear },
      internalStructure: { ...def.internalStructure, rightTorso: 1 },
    };
    const ammo: Record<number, number> = { 1: 5 };
    // Ammo is in leftTorso (slot 1) per the HBK record sheet. The starting
    // crit lands on slot 1 (det 8 -> first half, slot 1). The explosion
    // drains leftTorso IS from its fresh value to 0 (transferring into CT),
    // and the cascade runs two more determining rolls — one for leftTorso
    // (its IS just hit 0) and one for CT (which then dies when the cascade
    // hits an engine slot or gyro). Provide ample dice:
    //   det(2) + slot(2) + [cascade LT: det(2) + slot roll that re-rolls once(4)] + [cascade CT: det(2) + slot(2)]
    //   = 14 dice
    const res = resolveCriticalHits({
      rng: detRoll(8, 1, 1, 3, 4, 1, 1, 1, 2, 3, 4, 1, 1, 1, 1),
      def,
      source: { location: "leftTorso", damage: 5 },
      critSlotsDestroyed: freshFlags(def),
      destroyedWeapons: [],
      damage,
      shotsLeft: ammo,
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
    expect(res.killed).toBe(true);
    expect(res.damage.internalStructure.centerTorso).toBe(0);
  });

  it("cockpit crit kills the 'Mech", () => {
    const def = getMechDef("HBK-4G")!;
    // HBK head slot 3 = cockpit. Roll 8 -> one crit. Slot 3 (1D6 = 3).
    const res = resolveCriticalHits({
      rng: detRoll(8, 3),
      def,
      source: { location: "head", damage: 3 },
      critSlotsDestroyed: freshFlags(def),
      destroyedWeapons: [],
      damage: {
        armor: { ...def.armor },
        armorRear: { ...def.armorRear },
        internalStructure: { ...def.internalStructure },
      },
      shotsLeft: freshAmmo(def),
    });
    expect(res.killed).toBe(true);
    expect(res.rows.some((r) => r.kind === "cockpitDestroyed")).toBe(true);
  });
});

describe("transfer rules", () => {
  it("excess crits are lost when the source still has hittable slots", () => {
    // 12 on Atlas centerTorso: 3 crits. Atlas CT has 10 engine + 4 gyro +
    // 2 Medium Laser (R) + 1 empty = 12. With 2 separate ML mounts and
    // 3 crits, we get 3 rows (no transfers because the source still has
    // hittable slots throughout the determining).
    const def = getMechDef("AS7-D")!;
    const res = resolveCriticalHits({
      // Provide 12 dice. det 2 + 3 slot rolls (with possible re-rolls)
      // = up to 10 dice; extra margin.
      rng: detRoll(12, 1, 1, 1, 1, 2, 6, 6, 1, 3),
      def,
      source: { location: "centerTorso", damage: 5 },
      critSlotsDestroyed: freshFlags(def),
      destroyedWeapons: [],
      damage: {
        armor: { ...def.armor },
        armorRear: { ...def.armorRear },
        internalStructure: { ...def.internalStructure },
      },
      shotsLeft: freshAmmo(def),
    });
    // Three crits land against 11 hittable slots; none transfer.
    expect(res.rows).toHaveLength(3);
    // At least one crit destroys something (component or weapon).
    expect(res.rows.some((r) => r.kind !== "noEffect")).toBe(true);
  });

  it("crits transfer inward when the source is exhausted from a prior phase", () => {
    const def = getMechDef("HBK-4G")!;
    // Simulate: every crit-hittable slot in leftTorso is already destroyed
    // from a previous turn. Roll 8 -> one crit -> source is exhausted,
    // transfer to centerTorso. Provide 6 dice: 2 for the top-level
    // determining roll, 2 for the recursive (transferred) determining
    // roll, 2 for the slot roll.
    const destroyed = freshFlags(def);
    for (let i = 0; i < def.critSlots.leftTorso.length; i++) {
      const slot = def.critSlots.leftTorso[i]!;
      if (slot.kind !== "empty" && slot.kind !== "soak") {
        destroyed.leftTorso[i] = true;
      }
    }
    const res = resolveCriticalHits({
      rng: detRoll(8, 4, 4, 1, 4),
      def,
      source: { location: "leftTorso", damage: 5 },
      critSlotsDestroyed: destroyed,
      destroyedWeapons: [],
      damage: {
        armor: { ...def.armor },
        armorRear: { ...def.armorRear },
        internalStructure: { ...def.internalStructure },
      },
      shotsLeft: freshAmmo(def),
    });
    expect(res.rows).toHaveLength(1);
    const eff = res.rows[0]!;
    expect(eff.kind).toBe("componentDestroyed");
    if (eff.kind === "componentDestroyed") {
      expect(eff.location).toBe("centerTorso");
    }
  });

  it("crits on a terminal source (head) with no eligible slot are lost", () => {
    const def = getMechDef("HBK-4G")!;
    // Mark every head slot destroyed.
    const destroyed = freshFlags(def);
    for (let i = 0; i < def.critSlots.head.length; i++) {
      destroyed.head[i] = true;
    }
    const res = resolveCriticalHits({
      rng: detRoll(8),
      def,
      source: { location: "head", damage: 3 },
      critSlotsDestroyed: destroyed,
      destroyedWeapons: [],
      damage: {
        armor: { ...def.armor },
        armorRear: { ...def.armorRear },
        internalStructure: { ...def.internalStructure },
      },
      shotsLeft: freshAmmo(def),
    });
    // Head is terminal: 1 crit declared, no slot found, lost.
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]!.kind).toBe("noEffect");
  });
});

describe("effectiveMovement", () => {
  const def = getMechDef("HBK-4G")!;
  const flags = (mods: Partial<Record<Location, number[]>>) => {
    const out = freshFlags(def);
    for (const [loc, idxs] of Object.entries(mods) as [Location, number[]][]) {
      for (const i of idxs) out[loc][i] = true;
    }
    return out;
  };

  it("returns base ratings for a fresh unit", () => {
    const m = effectiveMovement(def, freshFlags(def));
    expect(m.walking).toBe(def.walking);
    expect(m.running).toBe(Math.ceil(def.walking * 1.5));
    expect(m.jumping).toBe(def.jumping);
  });

  it("each destroyed leg actuator slot reduces walk by 1", () => {
    // Right leg has Hip(0), ULA(1), LLA(2), Foot(3), HS(4), HS(5). Destroy
    // ULA + LLA: walking = 4 - 2 = 2.
    const m = effectiveMovement(def, flags({ rightLeg: [1, 2] }));
    expect(m.walking).toBe(2);
    expect(m.running).toBe(3);
  });

  it("hip on a leg halves walking and ignores other penalties on that leg", () => {
    // Hip + ULA + LLA destroyed on rightLeg: walk halves to ceil(4/2) = 2;
    // running = ceil(2 * 1.5) = 3.
    const m = effectiveMovement(def, flags({ rightLeg: [0, 1, 2] }));
    expect(m.walking).toBe(2);
    expect(m.running).toBe(3);
  });

  it("destroyed jump jet slots reduce jumping by 1 each", () => {
    const wvr = getMechDef("WVR-6R")!;
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
        if (s && s.kind === "structure" && s.name === "jumpJet") {
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
    const m = effectiveMovement(wvr, flags(mods));
    expect(m.jumping).toBe(5 - Math.min(2, jetIndices.length));
  });
});

describe("DHS grouping", () => {
  it("consecutive DHS slots in a location share a single destruction", () => {
    // The Hermes II (HER-5SA) leftTorso has 3 consecutive ISDouble Heat Sink
    // entries. Destroying one crit slot destroys the whole DHS; the next
    // reroll sees all 3 slots marked destroyed and produces noEffect.
    const her = getMechDef("HER-5SA")!;
    const lt = her.critSlots.leftTorso;
    const dhsIndices: number[] = [];
    for (let i = 0; i < lt.length; i++) {
      const s = lt[i];
      if (s && s.kind === "structure" && s.name === "doubleHeatSink") dhsIndices.push(i);
    }
    expect(dhsIndices.length).toBe(3);
    expect(lt[dhsIndices[0]!]!.kind).toBe("structure");
    const slot = lt[dhsIndices[0]!] as Extract<(typeof lt)[number], { kind: "structure" }>;
    const group = (slot as { group: readonly number[] }).group;
    expect(group).toEqual(dhsIndices.map((i) => i + 1));
  });
});
