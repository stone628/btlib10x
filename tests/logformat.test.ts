import type { AttackResolution, CriticalResolution } from "btlib10x";
import { describe, expect, it } from "vitest";
import { getMechDef } from "../src/data/index.js";
import { getWeaponOrThrow } from "../src/data/weapons.js";
import { resolveCriticalHits } from "../src/rules/critical.js";
import type { UnitDamageState } from "../src/rules/damage.js";
import { computeToHit } from "../src/rules/tohit.js";
import { fmtLog } from "../web/format.js";
import { scriptedRng } from "./helpers.js";

const LOCS = [
  "head",
  "centerTorso",
  "rightTorso",
  "leftTorso",
  "rightArm",
  "leftArm",
  "rightLeg",
  "leftLeg",
] as const;

function freshFlags(def = getMechDef("HBK-4G")!) {
  const out: Record<string, boolean[]> = {} as Record<string, boolean[]>;
  for (const loc of LOCS)
    out[loc] = new Array(def.critSlots[loc as (typeof LOCS)[number]].length).fill(false);
  return out;
}

function freshAmmo(def = getMechDef("HBK-4G")!) {
  const out: Record<number, number> = {};
  for (const [k, mount] of Object.entries(def.weapons)) {
    if (mount.shots !== undefined) out[Number(k)] = mount.shots;
  }
  return out;
}

function freshDamage(def = getMechDef("HBK-4G")!): UnitDamageState {
  return {
    armor: { ...def.armor },
    armorRear: { ...def.armorRear },
    internalStructure: { ...def.internalStructure },
  };
}

describe("critical hit log formatting", () => {
  function critResolution(): AttackResolution {
    const def = getMechDef("HBK-4G")!;
    const crit: CriticalResolution = resolveCriticalHits({
      rng: scriptedRng(4, 4, 3, 2), // determining 8 -> 1 crit
      def,
      source: { location: "rightTorso", damage: 5 },
      critSlotsDestroyed: freshFlags(def),
      destroyedWeapons: [],
      damage: freshDamage(def),
      shotsLeft: freshAmmo(def),
    });
    return {
      weapon: "Autocannon/20",
      distance: 1,
      breakdown: computeToHit({
        gunnery: 4,
        attackerMovement: "standStill",
        targetHexesMoved: 0,
        targetJumped: false,
        targetTerrain: "clear",
        interveningWoods: 0,
        distance: 1,
        weapon: getWeaponOrThrow("Autocannon/20"),
      }),
      toHitRoll: 7,
      hit: true,
      jammed: false,
      clusterRoll: null,
      groups: [],
      application: null,
      crits: [crit],
    };
  }

  it("renders each critical hit exactly once, nested under its attack", () => {
    // The engine emits one attackResolved event whose resolution.crits carry
    // the crit; no separate critsResolved event exists.
    const lines = fmtLog("en", [
      { kind: "attackResolved", unitId: "hbk", targetId: "enf", resolution: critResolution() },
    ]);
    const critHeaders = lines.filter((l) => l.includes("crit roll"));
    expect(critHeaders).toHaveLength(1);
    expect(critHeaders[0]).toMatch(/\S/);
  });

  it("batches consecutive attack resolutions under a single delimiter pair", () => {
    const lines = fmtLog("en", [
      { kind: "attackResolved", unitId: "hbk", targetId: "enf", resolution: critResolution() },
      { kind: "attackResolved", unitId: "hbk", targetId: "enf", resolution: critResolution() },
    ]);
    const starts = lines.filter((l) => l === "=== resolving declared attacks ===");
    const ends = lines.filter((l) => l === "=== attack damage resolved ===");
    expect(starts).toHaveLength(1);
    expect(ends).toHaveLength(1);
  });
});
