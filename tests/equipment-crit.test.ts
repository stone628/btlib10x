import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseCritSlots } from "../scripts/mtf-crit.mjs";
import { mechDef, registeredMechDefs } from "../src/data/index";
import { decodeMechLine, encodeMechDef } from "../src/data/mech.codec";
import type { MechDef, ResolvedMechDef } from "../src/data/mech.schema";
import { loadAmmoBins } from "../src/rules/ammo";
import {
  emptyCritTable,
  isSlotDestroyed,
  resolveCriticalHits,
  setSlotDestroyed,
} from "../src/rules/critical";
import type { UnitDamageState } from "../src/rules/damage";
import { infoMechChunk } from "../web/terminal/session.common";
import { chunkText, scriptedRng } from "./helpers";

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
