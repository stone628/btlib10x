import { describe, expect, it } from "vitest";
import { mechDef } from "../src/data/index";
import { loadAmmoBins } from "../src/rules/ammo";
import {
  cloneCritTable,
  countDestroyedEngine,
  destroyAllSlots,
  emptyCritTable,
  resolveCriticalHits,
} from "../src/rules/critical";
import { applyDamage, type UnitDamageState } from "../src/rules/damage";
import { scriptedRng } from "./helpers";

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
      def,
      source: { location: "leftArm", damage: 5 },
      critSlotsDestroyed: flags,
      destroyedWeapons: [],
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
      def,
      source: { location: "leftArm", damage: 5 },
      baseCritSlotsDestroyed: base,
      critSlotsDestroyed: flags,
      destroyedWeapons: [],
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
      def,
      source: { location: "rightArm", damage: 5, struck: true },
      critSlotsDestroyed: flags,
      destroyedWeapons: [],
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
      if (slot.kind === "structure" && slot.name === "doubleHeatSink") {
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
