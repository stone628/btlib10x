import { describe, expect, it } from "vitest";
import { mechDef } from "../src/data/index";
import { loadAmmoBins } from "../src/rules/ammo";
import { applyAmmoExplosion, emptyCritTable, resolveCriticalHits } from "../src/rules/critical";
import { applyDamage, type UnitDamageState } from "../src/rules/damage";
import { scriptedRng } from "./helpers";

// DMG-06: "If an ammo explosion transfers into a location protected by CASE,
// the internal structure in that location takes damage as normal. All excess
// damage is dissipated" (TW p.134; p.123 step 8). CASE vents at every location
// a blast reaches, not only where it started.

const fresh = (def: NonNullable<ReturnType<typeof mechDef>>): UnitDamageState => ({
  armor: { ...def.armor },
  armorRear: { ...def.armorRear },
  internalStructure: { ...def.internalStructure },
});

describe("CASE vents a blast that transfers into it (DMG-06)", () => {
  it("arm ammo explosion stops at the CASE side torso; CT untouched (ANH-1X)", () => {
    // ANH-1X: LB 10-X ammo in the right arm (no CASE), CASE in the right torso.
    const def = mechDef("ANH-1X")!;
    expect(def.techBase).toBe("Inner Sphere");
    const s = fresh(def);
    const app = applyAmmoExplosion(s, def, "rightArm", 50);
    expect(app.steps.map((st) => [st.location, st.damageApplied])).toEqual([
      ["rightArm", 17],
      ["rightTorso", 21],
    ]);
    expect(app.newlyDestroyed).toEqual(["rightArm", "rightTorso"]);
    expect(app.after.internalStructure.centerTorso).toBe(s.internalStructure.centerTorso);
    expect(app.mechDestroyed).toBe(false);
  });

  it("crit on the arm ammo bin: the same blast vents at the CASE torso (crit path)", () => {
    const def = mechDef("ANH-1X")!;
    const s = fresh(def);
    const res = resolveCriticalHits({
      // Determining 8 -> 1 crit; (6,6) = slot 12, the LB 10-X bin. Tail:
      // follow-up Determining 2 (no crit) for each location the blast reached.
      rng: scriptedRng(4, 4, 6, 6, 1, 1, 1, 1),
      model: def.model,
      source: { location: "rightArm", damage: 5 },
      critSlotsDestroyed: emptyCritTable(def),
      damage: s,
      ammoBins: loadAmmoBins(def),
    });
    expect(res.rows[0]?.kind).toBe("ammoExplosion");
    expect(res.damage.internalStructure.rightArm).toBe(0);
    expect(res.damage.internalStructure.rightTorso).toBe(0);
    expect(res.damage.internalStructure.centerTorso).toBe(s.internalStructure.centerTorso);
    expect(res.killedReason).toBe(null);
  });

  it("Gauss rifle explosion (equipment) vents at the CASE side torso (HGN-732)", () => {
    // HGN-732: Gauss Rifle in the right arm, CASE in the right torso. Both
    // locations nearly gone, so most of the 20-point blast reaches the CASE.
    const def = mechDef("HGN-732")!;
    const s = fresh(def);
    s.internalStructure.rightArm = 2;
    s.internalStructure.rightTorso = 3;
    const res = resolveCriticalHits({
      // Determining 8 -> 1 crit; (1,4) = slot 4, the Gauss Rifle. Tail as above.
      rng: scriptedRng(4, 4, 1, 4, 1, 1, 1, 1),
      model: def.model,
      source: { location: "rightArm", damage: 5 },
      critSlotsDestroyed: emptyCritTable(def),
      damage: s,
      ammoBins: loadAmmoBins(def),
    });
    const eff = res.rows[0]!;
    expect(eff.kind).toBe("weaponDestroyed");
    if (eff.kind === "weaponDestroyed") {
      expect(eff.explosion?.damage).toBe(20);
      expect(eff.explosion?.application.newlyDestroyed).toEqual(["rightArm", "rightTorso"]);
    }
    // 2 + 3 absorbed, 15 vented: the CT keeps all its structure.
    expect(res.damage.internalStructure.centerTorso).toBe(def.internalStructure.centerTorso);
    expect(res.killedReason).toBe(null);
  });

  it("CASE II at the origin caps the blast at 1 point", () => {
    const hbk = mechDef("HBK-4G")!;
    const def = {
      ...hbk,
      critSlots: {
        ...hbk.critSlots,
        leftTorso: [...hbk.critSlots.leftTorso, { kind: "soak" as const, name: "caseII" as const }],
      },
    };
    const s = fresh(def);
    const app = applyAmmoExplosion(s, def, "leftTorso", 100);
    expect(app.steps).toEqual([
      { location: "leftTorso", pool: "structure", damageApplied: 1, depleted: false },
    ]);
  });

  it("without CASE on the path the blast still reaches the CT (HBK-4G)", () => {
    const def = mechDef("HBK-4G")!;
    const s = fresh(def);
    const blast = s.internalStructure.rightArm + s.internalStructure.rightTorso + 5;
    const app = applyAmmoExplosion(s, def, "rightArm", blast);
    expect(app.after.internalStructure.centerTorso).toBe(s.internalStructure.centerTorso - 5);
  });

  it("ordinary damage spilling into a CASE torso is not vented (ANH-1X)", () => {
    const def = mechDef("ANH-1X")!;
    const s = fresh(def);
    s.armor.rightArm = 0;
    s.armor.rightTorso = 0;
    const app = applyDamage(s, "rightArm", 17 + 21 + 5);
    expect(app.after.internalStructure.centerTorso).toBe(s.internalStructure.centerTorso);
    // Front armor of the CT soaks the 5 that carry past the CASE torso.
    expect(app.steps.at(-1)).toMatchObject({ location: "centerTorso", damageApplied: 5 });
  });
});
