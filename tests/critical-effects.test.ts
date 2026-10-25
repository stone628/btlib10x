import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseCritSlots } from "../scripts/mtf-crit.mjs";
import type { TerrainType } from "../src/core/types";
import { allAmmo } from "../src/data/ammo.schema";
import { mechDef, mechDefFor, registeredMechDefs } from "../src/data/index";
import { decodeMechLine, encodeMechDef } from "../src/data/mech.codec";
import type { MechDef, ResolvedMechDef } from "../src/data/mech.schema";
import { loadAmmoBins } from "../src/rules/ammo";
import {
  ammoDamagePerShot,
  applyAmmoExplosion,
  cloneCritTable,
  countDestroyedEngine,
  destroyAllSlots,
  emptyCritTable,
  isSlotDestroyed,
  resolveCriticalHits,
  setSlotDestroyed,
} from "../src/rules/critical";
import { applyDamage, dealtOf, type UnitDamageState } from "../src/rules/damage";
import { applyFall } from "../src/rules/game/consequences";
import { buildUnitInit, createBattle } from "../src/rules/game/create";
import { advancePhase } from "../src/rules/game/loop";
import { requireUnit } from "../src/rules/game/queries";
import { rollInitiativePhase } from "../src/rules/game/turnOrder";
import type { GameEvent } from "../src/rules/game/types";
import { largestAmmoBin } from "../src/rules/heat";
import { infoMechChunk } from "../web/terminal/session.common";
import { createTestBattle } from "./helpers/battle";
import { scriptedRng } from "./helpers/rng";
import { chunkText } from "./helpers/session";

// Unmodelled equipment (ECM, probes, Artemis, MASC, command modules, ...)
// takes critical hits like any other equipment (TW p.124); only CASE, endo
// steel, ferro-fibrous, stealth (systems) and TSM re-roll (TW pp.134-143).

/** Rng whose first 2D6 sums to `sum`, then yields `tail`. */
function detRoll(sum: number, ...tail: number[]) {
  const a = Math.max(1, Math.min(6, sum - 1));
  return scriptedRng(a, sum - a, ...tail);
}

function freshDamage(def: ResolvedMechDef): UnitDamageState {
  return {
    armor: { ...def.armor },
    armorRear: { ...def.armorRear },
    internalStructure: { ...def.internalStructure },
  };
}

/** Cyclops CP-10-HQ: the whole right torso is a Collapsible Command Module. */
const HQ = "CP-10-HQ";

function allSlotsDestroyed(def: ResolvedMechDef) {
  const flags = emptyCritTable(def);
  for (let i = 0; i < def.critSlots.rightTorso.length; i++) {
    setSlotDestroyed(flags, "rightTorso", i);
  }
  return flags;
}

describe("unmodelled equipment takes critical hits (TW p.124)", () => {
  it("catalog carries the item name on equipment slots", () => {
    const def = mechDef(HQ)!;
    const rt = def.critSlots.rightTorso;
    expect(rt).toHaveLength(12);
    for (const slot of rt) {
      expect(slot).toMatchObject({
        kind: "structure",
        type: "equipment",
        name: "Collapsible Command Module",
      });
    }
  });

  it("a critical in an all-equipment location lands there instead of transferring", () => {
    const def = mechDef(HQ)!;
    const res = resolveCriticalHits({
      rng: detRoll(8, 1, 3),
      model: def.model,
      source: { location: "rightTorso", damage: 5 },
      critSlotsDestroyed: emptyCritTable(def),
      damage: freshDamage(def),
      ammoBins: loadAmmoBins(def),
    });
    expect(res.rows).toHaveLength(1);
    const row = res.rows[0]!;
    expect(row).toMatchObject({
      kind: "componentDestroyed",
      location: "rightTorso",
      slotIndex: 3,
      name: "equipment",
      label: "Collapsible Command Module",
    });
    expect(isSlotDestroyed(res.critSlotsDestroyed, "rightTorso", 2)).toBe(true);
  });

  it("a 3-critical roll keeps every critical in the location", () => {
    const def = mechDef(HQ)!;
    const res = resolveCriticalHits({
      rng: detRoll(12, 1, 1, 1, 2, 4, 6),
      model: def.model,
      source: { location: "rightTorso", damage: 5 },
      critSlotsDestroyed: emptyCritTable(def),
      damage: freshDamage(def),
      ammoBins: loadAmmoBins(def),
    });
    expect(res.rows.map((r) => r.kind === "componentDestroyed" && r.location)).toEqual([
      "rightTorso",
      "rightTorso",
      "rightTorso",
    ]);
  });

  it("transfers inward once every equipment slot was destroyed in an earlier phase", () => {
    const def = mechDef(HQ)!;
    const destroyed = allSlotsDestroyed(def);
    const res = resolveCriticalHits({
      rng: detRoll(8, 4, 4, 1, 4, 2, 2, 3, 3),
      model: def.model,
      source: { location: "rightTorso", damage: 5 },
      critSlotsDestroyed: destroyed,
      baseCritSlotsDestroyed: destroyed,
      damage: freshDamage(def),
      ammoBins: loadAmmoBins(def),
    });
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]).toMatchObject({ location: "centerTorso" });
  });

  it("loses the critical when the equipment was destroyed earlier in the same phase (TW p.125)", () => {
    const def = mechDef(HQ)!;
    const res = resolveCriticalHits({
      rng: detRoll(8, 1, 1),
      model: def.model,
      source: { location: "rightTorso", damage: 5 },
      critSlotsDestroyed: allSlotsDestroyed(def),
      baseCritSlotsDestroyed: emptyCritTable(def),
      damage: freshDamage(def),
      ammoBins: loadAmmoBins(def),
    });
    expect(res.rows).toEqual([{ kind: "noEffect", rolls: [] }]);
  });

  it("stealth-system slots still re-roll", () => {
    // EXT-4C: two stealth-system slots per leg beside the four actuators.
    const def = mechDef("EXT-4C")!;
    const leg = def.critSlots.leftLeg;
    expect(leg.filter((s) => s.kind === "soak" && s.name === "stealthSystem")).toHaveLength(2);
    const destroyed = emptyCritTable(def);
    leg.forEach((s, i) => {
      if (s.kind === "structure") setSlotDestroyed(destroyed, "leftLeg", i);
    });
    const res = resolveCriticalHits({
      rng: detRoll(8, 4, 4, 1, 4, 2, 2, 3, 3),
      model: def.model,
      source: { location: "leftLeg", damage: 5 },
      critSlotsDestroyed: destroyed,
      baseCritSlotsDestroyed: destroyed,
      damage: freshDamage(def),
      ammoBins: loadAmmoBins(def),
    });
    // Only stealth slots left: the leg is exhausted and the critical moves to the torso.
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]).toMatchObject({ location: "leftTorso" });
  });

  it("no catalog sheet keeps an unnamed equipment slot", () => {
    for (const def of registeredMechDefs()) {
      for (const slots of Object.values(def.critSlots)) {
        for (const slot of slots) {
          if (slot.kind === "structure" && slot.type === "equipment") {
            expect(slot.name, def.model).toBeTruthy();
          }
        }
      }
    }
  });
});

describe("structure slot type + name on the wire", () => {
  it("round-trips the item name", () => {
    const raw = JSON.parse(readFileSync("docs/mtf/sw/json/cp-10-hq.json", "utf8")) as MechDef;
    const strings: string[] = [];
    const line = encodeMechDef(raw, strings);
    const back = decodeMechLine(line, raw, strings);
    expect(back.critSlots.rightTorso[0]).toEqual({
      kind: "structure",
      type: "equipment",
      name: "Collapsible Command Module",
    });
    expect(back.critSlots.centerTorso[0]).toEqual({ kind: "structure", type: "engine" });
  });
});

describe("MTF importer", () => {
  const classify = (token: string) => {
    const errors: string[] = [];
    const lines = ["Left Arm:", token, ...Array(11).fill("-Empty-")];
    return parseCritSlots(lines, errors, "t.mtf", "Inner Sphere").leftArm?.[0];
  };

  it.each([
    ["ISGuardianECMSuite", "Guardian ECM Suite"],
    ["ISBeagleActiveProbe", "Beagle Active Probe"],
    ["ISArtemisIV", "Artemis IV FCS"],
    ["ISMASC", "MASC"],
    ["ISC3SlaveUnit", "C3 Slave Unit"],
    ["ISCollapsibleCommandModule", "Collapsible Command Module"],
  ])("%s becomes hittable equipment named %s", (token, name) => {
    expect(classify(token)).toEqual({ kind: "structure", type: "equipment", name });
  });

  it.each(["Mek Null Signature System", "Chameleon Light Polarization Shield"])(
    "%s stays a re-rolling stealth system",
    (token) => {
      expect(classify(token)).toEqual({ kind: "soak", name: "stealthSystem" });
    },
  );
});

describe("crit chart", () => {
  it("shows the item name without the soak parentheses", () => {
    const text = infoMechChunk(HQ).flatMap(chunkText).join("\n");
    expect(text).toContain("Collapsible Command Module");
    expect(text).not.toContain("(Collapsible Command Module)");
    expect(text).not.toContain("(Equipment)");
  });
});

describe("case-transfer", () => {
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
          leftTorso: [
            ...hbk.critSlots.leftTorso,
            { kind: "soak" as const, name: "caseII" as const },
          ],
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
});

describe("equipment-ammo-explosion", () => {
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
});

describe("crit-pipeline", () => {
  function fresh(model: string) {
    const def = mechDef(model)!;
    const flags = emptyCritTable(def);
    const damage: UnitDamageState = {
      armor: { ...def.armor },
      armorRear: { ...def.armorRear },
      internalStructure: { ...def.internalStructure },
    };
    return { def, flags, damage };
  }

  /** First 2D6 sums to `sum`; `tail` follows. */
  function dice(sum: number, ...tail: number[]) {
    const a = Math.max(1, Math.min(6, sum - 1));
    return scriptedRng(a, sum - a, ...tail);
  }

  describe("DMG-01: a destroyed location stops soaking damage (TW p.122)", () => {
    it("rear damage to a side torso destroyed from the front carries to the center torso", () => {
      const { def, damage } = fresh("AS7-D");
      damage.internalStructure.leftTorso = 0;
      damage.armor.leftTorso = 0;
      const rearBefore = damage.armorRear.leftTorso;
      const app = applyDamage(damage, "leftTorso", 5, "rear");
      expect(app.after.armorRear.leftTorso).toBe(rearBefore);
      expect(app.after.armorRear.centerTorso).toBe(def.armorRear.centerTorso - 5);
    });
  });

  describe("CRIT-08: transferred criticals are carried, not re-rolled (TW pp.122, 125)", () => {
    it("one crit on an exhausted arm lands in the torso without a fresh roll", () => {
      const { def, flags, damage } = fresh("AS7-D");
      destroyAllSlots(flags, "leftArm", def.critSlots.leftArm);
      const res = resolveCriticalHits({
        rng: dice(8, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1),
        model: def.model,
        source: { location: "leftArm", damage: 5 },
        critSlotsDestroyed: flags,
        damage,
        ammoBins: loadAmmoBins(def),
      });
      const hits = res.rows.filter((r) => r.kind !== "noEffect");
      expect(hits.length).toBe(1);
      expect(hits[0] && "location" in hits[0] ? hits[0].location : null).toBe("leftTorso");
    });
  });

  describe("CRIT-03: step-4 uses phase-start flags (TW p.122)", () => {
    it("a second crit on a location that is only now exhausted is lost, not transferred", () => {
      const { def, flags, damage } = fresh("AS7-D");
      const base = cloneCritTable(flags);
      // Running state: every left-arm slot already hit this phase; phase start: none hit.
      destroyAllSlots(flags, "leftArm", def.critSlots.leftArm);
      const res = resolveCriticalHits({
        rng: dice(8, ...new Array<number>(400).fill(1)),
        model: def.model,
        source: { location: "leftArm", damage: 5 },
        baseCritSlotsDestroyed: base,
        critSlotsDestroyed: flags,
        damage,
        ammoBins: loadAmmoBins(def),
      });
      expect(res.rows.every((r) => r.kind === "noEffect")).toBe(true);
    });
  });

  describe("CRIT-02: a location destroyed by the hit only crits explosive slots (TW p.124)", () => {
    it("non-explosive crits in a just-destroyed arm are discarded, not sent inward", () => {
      const { def, flags, damage } = fresh("AS7-D");
      damage.internalStructure.rightArm = 0;
      const res = resolveCriticalHits({
        rng: dice(8, 1, 1, 1, 1, 1, 1),
        model: def.model,
        source: { location: "rightArm", damage: 5, struck: true },
        critSlotsDestroyed: flags,
        damage,
        ammoBins: loadAmmoBins(def),
      });
      expect(res.rows.every((r) => r.kind === "noEffect")).toBe(true);
      expect(res.damage.internalStructure.rightTorso).toBe(def.internalStructure.rightTorso);
    });
  });

  describe("CRIT-04: adjacent double heat sinks are separate sinks (TW p.125)", () => {
    it("WHK-Prime left torso has four Clan double heat sinks in 2-slot groups", () => {
      const def = mechDef("WHK-Prime")!;
      const groups = new Set<string>();
      for (const slot of def.critSlots.leftTorso) {
        if (slot.kind === "structure" && slot.type === "doubleHeatSink") {
          groups.add(slot.group.join(","));
        }
      }
      expect(groups.size).toBe(4);
      for (const g of groups) expect(g.split(",").length).toBe(2);
    });
  });

  describe("CRIT-05: engine slots in a destroyed location count (TW pp.125, 128)", () => {
    it("an Inner Sphere XL side torso lost to damage is three engine hits", () => {
      const { def, flags, damage } = fresh("CN9-YLW2");
      damage.internalStructure.leftTorso = 0;
      expect(countDestroyedEngine(def, damage, flags)).toBeGreaterThanOrEqual(3);
    });
  });
});

describe("fall-crit-transfer", () => {
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
});

describe("air-supply", () => {
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
});
