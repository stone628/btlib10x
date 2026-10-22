import { buildUnitInit, mechDefFor, type Rng, type UnitState } from "btlib10x";
import { describe, expect, it } from "vitest";
import { LOCATIONS } from "../src/core/types";
import { resolveWeaponAttack } from "../src/rules/attack";
import type { LocationValue, TorsoLocationValue, UnitDamageState } from "../src/rules/damage";
import { suggestFireTargets } from "../src/rules/fireability";
import type { GameEvent } from "../src/rules/game";
import { nextAutoPlayCommand, resetAutoplayState } from "../web/terminal/autoplay";
import { decodeUnitLine, encodeUnitLine } from "../web/terminal/replay";
import { createRng } from "../web/terminal/rng";
import { MAX_SNAPSHOT_COUNT } from "../web/terminal/rollback";
import {
  commitAttack,
  commitMovement,
  declareMovementMode,
  newSession,
  requireAttackActor,
  requireMovementActor,
  type Session,
  setTorsoTwist,
  transferDetail,
} from "../web/terminal/session";
import { formatCritEffect } from "../web/terminal/session.attack";
import { handleSessionGameEvents } from "../web/terminal/session.common";
import { disableCritical, execute, scriptedRng } from "./helpers";

function freshState(hp = 10): UnitDamageState {
  const armor = {} as LocationValue;
  const is = {} as LocationValue;
  for (const loc of LOCATIONS) {
    armor[loc] = hp;
    is[loc] = hp;
  }
  return { armor, armorRear: {} as TorsoLocationValue, internalStructure: is };
}

const BASE = {
  gunnery: 4,
  attackerMoved: "standStill",
  targetHexesMoved: 0,
  targetJumped: false,
  targetTerrain: "clear",
  interveningTerrains: [],
  distance: 1,
} as const;

function strike(
  targetDamage: UnitDamageState,
  rng: ReturnType<typeof scriptedRng>,
  weaponName = "Small Laser",
  arc?: "front" | "rear",
) {
  return resolveWeaponAttack({
    ...BASE,
    rng,
    weapon: weaponName,
    targetDamage,
    ...(arc === undefined ? {} : { arc }),
  });
}

describe("transferDetail", () => {
  it("shows armor-only `before→after` for a non-penetrating hit", () => {
    const s = freshState();
    const rng = scriptedRng(6, 6, 3, 3); // to-hit 12, location 6 -> RT, dmg 3
    const res = strike(s, rng);
    expect(res.applications[0]?.before.armor.rightTorso).toBe(10);
    const text = transferDetail(res);
    expect(text).not.toBeNull();
    expect(text).toMatch(/RTF 10->7\b/);
    expect(text).not.toMatch(/RTI/);
  });

  it("shows armor-then-structure at the same location for a penetrating hit", () => {
    const armor = {} as LocationValue;
    const is = {} as LocationValue;
    for (const loc of LOCATIONS) {
      armor[loc] = loc === "rightTorso" ? 2 : 10;
      is[loc] = 10;
    }
    const s: UnitDamageState = {
      armor,
      armorRear: {} as TorsoLocationValue,
      internalStructure: is,
    };
    const rng = scriptedRng(6, 6, 3, 3); // to-hit 12, location 6 -> RT, dmg 3
    const res = strike(s, rng);
    const text = transferDetail(res);
    expect(text).not.toBeNull();
    expect(text).toMatch(/RTF 2->0\*?/);
    expect(text).toMatch(/RTI 10->9\b/);
  });

  it("uses `app.before` as the snapshot, not a reconstruction from `after`", () => {
    const s = freshState();
    const rng = scriptedRng(6, 6, 3, 3); // to-hit 12, location 6 -> RT
    const res = strike(s, rng);
    expect(res.applications[0]?.before).toBeDefined();
    const first = res.applications[0];
    if (first) {
      const beforeRear = first.before.armorRear;
      const beforeArmor = first.before.armor;
      expect(beforeRear).toEqual({});
      expect(beforeArmor.rightTorso).toBe(10);
    }
  });

  it("never emits NaN for a step at a fresh location", () => {
    const s = freshState();
    const rng = scriptedRng(6, 6, 3, 3);
    const res = strike(s, rng);
    const text = transferDetail(res) ?? "";
    expect(text).not.toMatch(/NaN/);
  });

  it("labels torso armor as front-armor F when a rear pool is present", () => {
    const s: UnitDamageState = {
      ...freshState(),
      armorRear: { rightTorso: 5 } as TorsoLocationValue,
    };
    const rng = scriptedRng(6, 6, 3, 3); // to-hit 12, location 6 -> RT, dmg 3
    const res = strike(s, rng);
    expect(res.applications[0]?.before.armorRear.rightTorso).toBe(5);
    const text = transferDetail(res) ?? "";
    expect(text).toMatch(/RTF 10->7\b/);
    expect(text).not.toMatch(/RTA/);
  });

  it("labels non-torso armor as plain armor A (no rear pool)", () => {
    const s = freshState();
    const rng = scriptedRng(6, 6, 4, 5); // to-hit 12, location 9 -> leftLeg, dmg 3
    const res = strike(s, rng);
    expect(res.applications[0]?.before.armor.leftLeg).toBe(10);
    const text = transferDetail(res) ?? "";
    expect(text).toMatch(/LLA 10->7\b/);
    expect(text).not.toMatch(/LLF/);
  });

  it("labels rear-arc torso hits on the rear pool as R", () => {
    const s: UnitDamageState = {
      ...freshState(),
      armorRear: { rightTorso: 5 } as TorsoLocationValue,
    };
    const rng = scriptedRng(6, 6, 3, 3); // to-hit 12, location 6 -> RT, rear arc
    const res = strike(s, rng, "Small Laser", "rear");
    expect(res.applications[0]?.before.armorRear.rightTorso).toBe(5);
    const text = transferDetail(res) ?? "";
    expect(text).toMatch(/RTR 5->2\b/);
    expect(text).not.toMatch(/RT[AFI]/);
  });
});

describe("formatCritEffect limb blow-off", () => {
  it("fills the placeholder for leg and arm blow-offs", () => {
    const leg = formatCritEffect({ kind: "limbBlownOff", limb: "leftLeg", rolls: [12] });
    const arm = formatCritEffect({ kind: "limbBlownOff", limb: "leftArm", rolls: [12] });
    expect(leg).not.toMatch(/[{}]/);
    expect(arm).not.toMatch(/[{}]/);
  });
});

describe("blastDetail destruction tail (TW p. 128)", () => {
  it("reports the 'Mech destroyed, never the pilot killed", () => {
    const s = freshState();
    s.armor.centerTorso = 0;
    s.internalStructure.centerTorso = 1;
    const res = strike(s, scriptedRng(6, 6, 3, 4)); // to-hit 12, location 7 -> CT
    expect(res.applications.some((a) => a.mechDestroyed)).toBe(true);
    const text = transferDetail(res);
    expect(text).toMatch(/CTI 1->0\*.*; 'Mech destroyed$/);
    expect(text).not.toMatch(/killed/);
  });
});

/** Fixed dice first, then a seeded stream for whatever follows (PSRs, initiative). */
function diceThen(fixed: readonly number[], seed = 1): Rng {
  const rest = createRng(seed);
  let i = 0;
  return {
    d6: () => (i < fixed.length ? fixed[i++]! : rest.d6()),
    snapshot: () => rest.snapshot(),
    load: (v: string) => rest.load(v),
  };
}

/** HBK (me) fires its medium laser at an adjacent WVR (foe) with the given hit location dice. */
function shootFoe(
  prepare: (foe: UnitState) => void,
  locationDice: [number, number],
  crits: readonly number[] = [],
): string[] {
  return shootFoeSession(prepare, locationDice, crits).out;
}

function shootFoeSession(
  prepare: (foe: UnitState) => void,
  locationDice: [number, number],
  crits: readonly number[] = [],
): { out: string[]; s: Session } {
  const s = newSession(3);
  execute(s, "map quickstart");
  execute(s, "add me HBK-4G 9 9 n");
  execute(s, "add foe WVR-6R 9 8 s");
  execute(s, "start");
  if (crits.length === 0) disableCritical(s);
  prepare(s.battle!.units.foe!);
  for (let i = 0; i < 4 && s.battle!.phase === "movement"; i++) {
    execute(s, "mode standstill");
    execute(s, "done");
  }
  // Let the foe pass its attack first if it acts first.
  if (s.attack?.actorId === "foe") execute(s, "done");
  expect(s.attack?.actorId).toBe("me");
  const laser = Object.entries(mechDefFor(s.battle!.units.me!).weapons).find(
    ([, w]) => w.weapon === "Medium Laser" && w.location !== "rightArm",
  )![0];
  s.rng = diceThen([6, 6, ...locationDice, ...crits]);
  execute(s, `fire foe ${laser}`);
  const out = execute(s, "done");
  if (s.attack?.actorId === "foe") out.push(...execute(s, "done"));
  return { out, s };
}

describe("web log: 'Mech destroyed vs. the pilot's fate", () => {
  it("plain CT kill: 'Mech destroyed, then DESTROYED (pilot stays inside)", () => {
    const out = shootFoe(
      (foe) => {
        foe.damage.armor.centerTorso = 0;
        foe.damage.internalStructure.centerTorso = 1;
      },
      [3, 4],
    ).join("\n");
    expect(out).toMatch(/CTI 1->0\*.*; 'Mech destroyed/);
    // The salvage fall and wreckage follow in the same [foe] box.
    expect(out).toMatch(/\[foe\]┌? \*\*\* DESTROYED/);
    expect(out).not.toMatch(/killed/i);
  });

  it("head kill: 'Mech destroyed, then the ejection PSR and the pilot ejects", () => {
    const out = shootFoe(
      (foe) => {
        foe.damage.armor.head = 0;
        foe.damage.internalStructure.head = 1;
      },
      [6, 6],
    ).join("\n");
    const destroyed = out.indexOf("'Mech destroyed");
    const psr = out.indexOf("ejecting");
    // Consecutive [foe] lines share one box, so the eject line has no prefix.
    const ejects = out.indexOf("ejects — the 'Mech stays as an empty hull");
    expect(destroyed).toBeGreaterThan(-1);
    expect(psr).toBeGreaterThan(destroyed);
    expect(ejects).toBeGreaterThan(psr);
    expect(out).not.toMatch(/; killed/);
  });

  it("head blown off by a critical: the pilot still tries to eject", () => {
    // Extra head structure keeps the laser from destroying the head by damage,
    // so the 12 on the determining roll is what removes it.
    const out = shootFoe(
      (foe) => {
        foe.damage.armor.head = 0;
        foe.damage.internalStructure.head = 9;
      },
      [6, 6],
      [6, 6],
    ).join("\n");
    expect(out).toMatch(/PSR ejecting/);
    expect(out).toMatch(/ejects — the 'Mech stays as an empty hull/);
  });

  it("auto-eject off: a head kill destroys the 'Mech and kills the pilot", () => {
    const { out, s } = shootFoeSession(
      (foe) => {
        foe.autoEject = false;
        foe.damage.armor.head = 0;
        foe.damage.internalStructure.head = 1;
      },
      [6, 6],
    );
    const text = out.join("\n");
    expect(text).toMatch(/'Mech destroyed/);
    expect(text).not.toMatch(/PSR ejecting/);
    expect(text).toMatch(/\*\*\* DESTROYED \(HD destroyed\) \*\*\*/);
    const foe = s.battle!.units.foe!;
    expect(foe.pilotHits).toBe(foe.pilotHitMax);
  });
});

describe("set <id> autoEject", () => {
  it("toggles the policy in setup, shows it in status, and rejects other values", () => {
    const s = newSession(1);
    execute(s, "map quickstart");
    execute(s, "add me HBK-4G 9 9 n");
    expect(s.setup.roster[0]!.policy.autoEject).toBe(true);
    expect(execute(s, "set me autoEject off")).toEqual(["me: autoEject set to off"]);
    expect(s.setup.roster[0]!.policy).toEqual({
      ammoPolicy: "exposed",
      autoEject: false,
      heatFlamer: true,
    });
    expect(execute(s, "status").join("\n")).toMatch(/auto-eject off/);
    expect(execute(s, "set me autoEject maybe")[0]).toMatch(/autoEject must be on or off/);
    execute(s, "set me ammoPolicy core");
    expect(s.setup.roster[0]!.policy).toEqual({
      ammoPolicy: "core",
      autoEject: false,
      heatFlamer: true,
    });
  });

  it("round-trips through replay unit records", () => {
    const base = buildUnitInit("me", "HBK-4G", 1, { col: 9, row: 9 }, "n");
    const off = {
      ...base,
      policy: { ammoPolicy: "exposed" as const, autoEject: false, heatFlamer: true },
    };
    const line = encodeUnitLine(off);
    expect(line.endsWith(":ex")).toBe(true);
    expect(decodeUnitLine(line).policy).toEqual({
      ammoPolicy: "exposed",
      autoEject: false,
      heatFlamer: true,
    });
    expect(encodeUnitLine(base)).not.toMatch(/:e?x?$/);
    expect(decodeUnitLine(encodeUnitLine(base)).policy.autoEject).toBe(true);
  });
});

describe("session-contexts", () => {
  function started(): { s: Session; actor: string } {
    const s = newSession(7);
    expect(execute(s, "map quickstart")[0]).toContain("15x16");
    expect(execute(s, "add hunchy HBK-4G 9 9 n")).toHaveLength(1);
    expect(execute(s, "add cicada HBK-4G 9 8 s")).toHaveLength(1);
    expect(execute(s, "start")[0]).toContain("BATTLE STARTED");
    disableCritical(s);
    return { s, actor: requireMovementActor(s).id };
  }

  /** Drain the movement phase by walking in place until weapon phase opens.
   *  Two units → two movement activations per round; cap iterations to break
   *  any inadvertent loop. */
  function burnMovePhase(s: Session): void {
    let guard = 0;
    while (s.state === "battle" && s.battle!.phase === "movement") {
      declareMovementMode(s, "walk");
      commitMovement(s);
      if (++guard > 64) throw new Error("burnMovePhase did not advance");
    }
  }

  /** Drive a session to `app === "over"` by ejecting both units. Bounded. */
  function driveToOver(s: Session): void {
    let guard = 0;
    while (s.state === "battle") {
      if (++guard > 200) throw new Error("driveToOver did not finish");
      if (s.battle!.phase === "movement") {
        // Eject whoever's acting this turn.
        declareMovementMode(s, "eject");
        try {
          commitMovement(s);
        } catch {
          // Some units can't eject (already ejected). Skip the round.
          commitMovement(s);
        }
      } else {
        // Pass through attack phase.
        execute(s, "done");
      }
    }
  }

  describe("per-AppState context invariants", () => {
    it("setup: all per-phase contexts are null, only setup populated", async () => {
      const s = newSession(42);
      expect(s.move).toBeNull();
      expect(s.attack).toBeNull();
      expect(s.over).toBeNull();
      expect(s.battle).toBeNull();
      expect(s.setup.roster).toEqual([]);
    });

    it("battle + movement: move allocated, attack null, over null", async () => {
      const { s } = await started();
      expect(s.state).toBe("battle");
      expect(s.battle!.phase).toBe("movement");
      expect(s.move).not.toBeNull();
      expect(s.attack).toBeNull();
      expect(s.over).toBeNull();
      expect(s.move!.actorId).toBe(requireMovementActor(s).id);
    });

    it("battle + attack: move null, attack allocated with torsoTwist front, over null", async () => {
      const { s } = await started();
      burnMovePhase(s);
      expect(s.battle!.phase).toBe("attack");
      expect(s.move).toBeNull();
      expect(s.attack).not.toBeNull();
      expect(s.over).toBeNull();
      expect(s.attack!.torsoTwist).toBe("front");
      expect(s.attack!.weaponDecls).toEqual([]);
    });

    it("over: move null, attack null, over populated with victory", async () => {
      const s = newSession(42);
      execute(s, "map quickstart");
      execute(s, "add a HBK-4G 5 5 n");
      execute(s, "add b HBK-4G 6 5 s");
      execute(s, "start");
      disableCritical(s);
      await driveToOver(s);
      expect(s.state).toBe("over");
      expect(s.over).not.toBeNull();
      expect(s.move).toBeNull();
      expect(s.attack).toBeNull();
      expect(s.over!.victory).toBeDefined();
    });

    it("phase transition reallocates the active context; inactive side stays null", async () => {
      const { s } = await started();
      const moveBefore = s.move;
      burnMovePhase(s);
      expect(s.battle!.phase).toBe("attack");
      expect(s.move).toBeNull();
      expect(s.attack).not.toBeNull();
      expect(moveBefore).not.toBe(s.attack);
    });

    it("actor change inside the same phase reallocates the context", async () => {
      const { s } = await started();
      const firstActor = s.move!.actorId;
      burnMovePhase(s);
      expect(s.attack).not.toBeNull();
      const firstAttackActor = s.attack!.actorId;
      // Pass-fire hands off to cicada's attack activation: same phase, new actor.
      execute(s, "done");
      expect(s.battle!.phase).toBe("attack");
      expect(s.attack).not.toBeNull();
      expect(firstAttackActor).not.toBe(s.attack!.actorId);
      expect(s.attack!.torsoTwist).toBe("front");
      expect(firstActor).not.toBe(s.attack!.actorId);
    });

    it("declareMode throws when not in movement phase", async () => {
      const { s } = await started();
      burnMovePhase(s);
      expect(s.battle!.phase).toBe("attack");
      expect(() => declareMovementMode(s, "walk")).toThrow(/requires the movement phase/i);
    });

    it("setTorsoTwist throws when not in weaponAttack phase", async () => {
      const { s } = await started();
      expect(s.battle!.phase).toBe("movement");
      expect(() => setTorsoTwist(s, "leftSide")).toThrow(/requires the attack phase/i);
    });

    it("fresh attack context always starts with torsoTwist: front", async () => {
      const { s } = await started();
      burnMovePhase(s);
      const firstAttackActor = s.attack!.actorId;
      expect(s.attack!.torsoTwist).toBe("front");
      execute(s, "torso right");
      expect(s.attack!.torsoTwist).toBe("rightSide");
      // Pass-fire on first attacker advances to next activation; twist should
      // reset whenever a fresh attack context is allocated.
      execute(s, "done");
      expect(s.battle!.phase).toBe("attack");
      expect(s.attack).not.toBeNull();
      // Either the same actor across rounds (fresh twist) or a different actor
      // (also fresh twist): in both cases torsoTwist must equal "front".
      if (s.attack!.actorId === firstAttackActor) {
        expect(s.attack!.torsoTwist).toBe("front");
      } else {
        expect(s.attack!.torsoTwist).toBe("front");
      }
    });

    it("commit rollback preserves the move context only", async () => {
      const { s } = await started();
      const actor = requireMovementActor(s).id;
      execute(s, "mode walk");
      s.move!.moveSteps = [{ kind: "enter", to: { col: 1, row: 1 } }];
      const out = execute(s, "done");
      expect(out[0]).toMatch(/^error:/);
      expect(s.move).not.toBeNull();
      expect(s.move!.actorId).toBe(actor);
      expect(s.move!.moveSteps).toHaveLength(1);
    });
  });
});

describe("torso-web", () => {
  function freshSetup(): Session {
    const s = newSession(42);
    expect(execute(s, "map quickstart")[0]).toContain("15x16");
    // Place two HBK-4Gs adjacent along the n/s axis with the bodies facing each
    // other so the head-to-head shot is in the front arc; we move them into a
    // side-arc configuration for the torso tests below.
    expect(execute(s, "add hunchy HBK-4G 9 9 n")).toHaveLength(1);
    expect(execute(s, "add cicada CDA-3MA 9 8 s")).toHaveLength(1);
    execute(s, "start");
    disableCritical(s);
    return s;
  }

  /** Drain the movement phase by walking in place until the weapon phase opens. */
  function burnMovePhase(s: Session): void {
    while (s.state === "battle" && s.battle!.phase === "movement") {
      declareMovementMode(s, "walk");
      commitMovement(s);
    }
  }

  /** Place hunchy facing north, cicada in the southeast-adjacent hex (rightSide template arc). */
  function sideArcSetup(): Session {
    const s = newSession(42);
    expect(execute(s, "map quickstart")[0]).toContain("15x16");
    // hunchy at (9,9) facing n; cicada at (10,9) — rightSide arc when twist
    // is "front", and the front arc when twist=right.
    expect(execute(s, "add hunchy HBK-4G 9 9 n")).toHaveLength(1);
    expect(execute(s, "add cicada CDA-3MA 10 9 s")).toHaveLength(1);
    execute(s, "start");
    disableCritical(s);
    return s;
  }

  describe("torso command", () => {
    it("defaults the twist to front at attack-phase entry", () => {
      const s = freshSetup();
      burnMovePhase(s);
      expect(s.battle!.phase).toBe("attack");
      expect(s.attack!.torsoTwist).toBe("front");
    });

    it("rejects the torso command outside the weapon attack phase", () => {
      const s = freshSetup();
      expect(s.battle!.phase).toBe("movement");
      expect(execute(s, "torso left")[0]).toMatch(/^error:/);
      // Movement phase → attack context absent, default twist "front".
      expect(s.attack?.torsoTwist ?? "front").toBe("front");
    });

    it("accepts front|left|right and updates the session state", () => {
      const s = sideArcSetup();
      burnMovePhase(s);
      expect(execute(s, "torso left")[0]).toMatch(/torso twisted to/);
      expect(s.attack!.torsoTwist).toBe("leftSide");
      expect(execute(s, "torso right")[0]).toMatch(/torso twisted to/);
      expect(s.attack!.torsoTwist).toBe("rightSide");
      expect(execute(s, "torso front")[0]).toMatch(/torso twisted to/);
      expect(s.attack!.torsoTwist).toBe("front");
    });

    it("reports when the twist is already in the requested direction", () => {
      const s = sideArcSetup();
      burnMovePhase(s);
      execute(s, "torso left");
      const out = execute(s, "torso left");
      expect(out[0]).toMatch(/already facing/);
    });

    it("rejects unknown direction words", () => {
      const s = sideArcSetup();
      burnMovePhase(s);
      expect(execute(s, "torso back")[0]).toMatch(/^error:.*front, left, or right/);
    });

    it("locks once a fire command is queued", () => {
      const s = sideArcSetup();
      burnMovePhase(s);
      expect(execute(s, "fire cicada 2")[0]).toContain("queued");
      expect(execute(s, "torso left")[0]).toMatch(/^error:.*locked/);
      expect(s.attack!.torsoTwist).toBe("front");
    });

    it("unlocks again after cancel", () => {
      const s = sideArcSetup();
      burnMovePhase(s);
      execute(s, "fire cicada 2");
      expect(execute(s, "torso left")[0]).toMatch(/^error:.*locked/);
      expect(execute(s, "cancel")[0]).toMatch(/cancelled/);
      expect(s.attack!.weaponDecls).toEqual([]);
      expect(execute(s, "torso left")[0]).toMatch(/torso twisted to/);
      expect(s.attack!.torsoTwist).toBe("leftSide");
    });

    it("auto-suggestion reflects the current twist", () => {
      const s = sideArcSetup();
      burnMovePhase(s);
      const baseSugg = suggestFireTargets(s.battle!, "hunchy", "front");
      const baseEnf = baseSugg.targets.find((t) => t.targetId === "cicada")!;
      // With twist front: only the right-arm Medium Laser (weapon 2) reaches
      // the cicada (rightSide arc of the body).
      expect(baseEnf.weapons.map((w) => w.weaponIndex)).toEqual([2]);

      execute(s, "torso right");
      const twistSugg = suggestFireTargets(s.battle!, "hunchy", "rightSide");
      const twistEnf = twistSugg.targets.find((t) => t.targetId === "cicada")!;
      expect(twistEnf.weapons.map((w) => w.weaponIndex).sort()).toEqual([1, 2, 3, 4]);
    });

    it("renders the current twist in the auto-hint suggestion", () => {
      const s = sideArcSetup();
      burnMovePhase(s);
      // `torso left` clears fireCandidate, so the auto-hint regenerates and is
      // appended to the torso command's own output.
      const out = execute(s, "torso right").join("\n");
      expect(out).toContain('twist(right), by "torso right" (current)');
    });

    it("marks the front twist group current when untwisted", () => {
      const s = sideArcSetup();
      burnMovePhase(s);
      const out = execute(s, "candidate").join("\n");
      expect(out).toContain('twist(front), by "torso front" (current)');
    });

    it("resets the twist when a new actor becomes current", () => {
      const s = sideArcSetup();
      burnMovePhase(s);
      execute(s, "torso right");
      expect(s.attack!.torsoTwist).toBe("rightSide");
      // Queue a fire so hunchy's turn ends and cicada becomes current.
      expect(execute(s, "fire cicada 2")[0]).toContain("queued");
      execute(s, "done");
      expect(requireAttackActor(s).id).toBe("cicada");
      expect(s.attack!.torsoTwist).toBe("front");
      // Cicada's own twist should also start at "front".
      expect(s.attack!.torsoTwist).toBe("front");
    });
  });
});

describe("session-atomic", () => {
  /** Started quickstart battle; returns session plus acting-unit id. */
  function started(piloting?: number): { s: Session; actor: string } {
    const s = newSession(7);
    expect(execute(s, "map quickstart")[0]).toContain("15x16");
    const pilotArg = piloting === undefined ? "" : ` ${piloting}`;
    expect(execute(s, `add hunchy HBK-4G 9 9 n${pilotArg}`)).toHaveLength(1);
    expect(execute(s, `add cicada HBK-4G 9 8 s${pilotArg}`)).toHaveLength(1);
    expect(execute(s, "start")[0]).toContain("BATTLE STARTED");
    disableCritical(s);
    return { s, actor: requireMovementActor(s).id };
  }

  /** Drain the movement phase by walking in place until the weapon phase opens. */
  function burnMovePhase(s: Session): void {
    while (s.state === "battle" && s.battle!.phase === "movement") {
      declareMovementMode(s, "walk");
      commitMovement(s);
    }
  }

  describe("commitAtomic rollback", () => {
    it("failed standup+move restores battle, rng, and session buffers", () => {
      const { s, actor } = started(4);
      s.battle!.units[actor]!.prone = true;
      execute(s, "mode standup");
      expect(s.move!.moveMode).toBe("standup");

      const heatBefore = s.battle!.units[actor]!.heat;
      const rng = scriptedRng(6, 6, 6, 6);
      s.rng = rng;
      const rngSnap = rng.snapshot();
      // Illegal enter step (an on-board hex, so the stand-still check is what
      // refuses it): attemptStandUp draws 2D6 first, then executeMove throws,
      // so the commit consumed rng before failing.
      s.move!.moveSteps = [{ kind: "enter", to: { col: 9, row: 10 } }];

      expect(() => commitMovement(s)).toThrow(/Standing still forbids entering hexes/);

      // Rng rewound: retry sees identical sequence.
      expect(rng.snapshot()).toBe(rngSnap);
      expect(rng.remaining()).toBe(4);
      // Battle rewound: standup effects (prone cleared, heat) gone; no log stored.
      expect("events" in s.battle!).toBe(false);
      expect(s.battle!.units[actor]!.prone).toBe(true);
      expect(s.battle!.units[actor]!.heat).toBe(heatBefore);
      expect(s.battle!.units[actor]!.mpSpent).toBe(0);
      expect(s.battle!.units[actor]!.declaredWeaponAttacks ?? []).toEqual([]);
      // Session buffers preserved: declaration intact, actor still current.
      expect(s.move!.moveMode).toBe("standup");
      expect(s.move!.moveSteps).toHaveLength(1);
      expect(s.move!.actorId).toBe(actor);

      // Retry with legal (empty) steps succeeds on identical rolls and returns
      // the live battle object.
      s.move!.moveSteps = [];
      const res = commitMovement(s);
      expect(res.length).toBeGreaterThan(0);
      expect(s.battle!.units[actor]!.prone).toBe(false);
      expect(rng.remaining()).toBe(2);
    });

    it("failed commitFire mid-resolution restores battle, rng, and session", () => {
      const { s } = started();
      burnMovePhase(s);
      expect(s.battle!.phase).toBe("attack");
      const first = requireAttackActor(s).id;
      const firstTarget = first === "hunchy" ? "cicada" : "hunchy";
      // First unit declares + commits: rival still pending, so drive resolves
      // nothing and draws no rng.
      expect(execute(s, `fire ${firstTarget} 1`)[0]).toContain("queued");
      expect(execute(s, `fire ${firstTarget} 2`)[0]).toContain("queued");
      execute(s, "done");
      const attacker = requireAttackActor(s).id;
      const target = attacker === "hunchy" ? "cicada" : "hunchy";
      // Two ammo-free medium lasers (CLI weapon numbers are 1-based: HBK-4G
      // weapons 1+2 are the arm medium lasers): declaration draws no rng.
      expect(execute(s, `fire ${target} 1`)[0]).toContain("queued");
      expect(execute(s, `fire ${target} 2`)[0]).toContain("queued");

      const damageBefore = structuredClone(s.battle!.units[target]!.damage);
      // Per hitting laser: to-hit 2D6 + location 2D6. Script covers three full
      // lasers (all CT hits, TN hit) plus one to-hit die; the fourth laser's
      // second to-hit die hits the exhausted script after partial battle
      // mutation (damage applied, buffers cleared, actor nulled).
      const rng = scriptedRng(6, 6, 3, 4, 6, 6, 3, 4, 6, 6, 3, 4, 6);
      s.rng = rng;
      const rngSnap = rng.snapshot();

      expect(() => commitAttack(s)).toThrow(/RNG script exhausted/);

      expect(rng.snapshot()).toBe(rngSnap);
      expect(rng.remaining()).toBe(13);
      expect(s.battle!.units[target]!.damage).toEqual(damageBefore);
      expect(s.battle!.units[attacker]!.declaredWeaponAttacks).toEqual([]);
      // First unit committed successfully before the scripted rng was
      // installed: its declarations predate the snapshot and survive.
      expect(s.battle!.units[first]!.declaredWeaponAttacks).toHaveLength(2);
      expect(s.attack!.actorId).toBe(attacker);
      expect(s.attack!.weaponDecls).toHaveLength(2);
      expect(s.attack!.torsoTwist).toBe("front");
    });

    it("successful commits return the live battle object", () => {
      const { s } = started();
      const actor = requireMovementActor(s).id;
      declareMovementMode(s, "walk");
      const res = commitMovement(s);
      expect(res.length).toBeGreaterThan(0);
      expect(res.some((e) => e.kind === "moveDeclared")).toBe(true);
      expect(requireMovementActor(s)?.id).not.toBe(actor);
    });
  });
});

describe("rollback", () => {
  function battle(seed = 5): Session {
    const s = newSession(seed);
    execute(s, "map quickstart");
    execute(s, "add me HBK-4G 9 9 n");
    execute(s, "add foe WVR-6R 9 5 s");
    execute(s, "start");
    return s;
  }

  /** Complete the current actor's activation with a plain stand-still / pass. */
  function finishActivation(s: Session): void {
    if (s.battle!.phase === "movement") execute(s, "mode standstill");
    execute(s, "done");
  }

  function fingerprint(s: Session): string {
    return JSON.stringify({
      state: s.state,
      battle: s.battle,
      move: s.move,
      attack: s.attack,
      over: s.over,
      rng: s.rng.snapshot(),
      replay: s.replay?.lines.length,
    });
  }

  describe("rollback", () => {
    it("undoes the last completed done and restores state and dice", () => {
      const s = battle();
      const before = fingerprint(s);
      finishActivation(s);
      expect(fingerprint(s)).not.toBe(before);
      expect(execute(s, "rollback")[0]).toMatch(/rolled back/);
      expect(fingerprint(s)).toBe(before);
    });

    it("declarations and failed commands add no snapshot", () => {
      const s = battle();
      finishActivation(s); // snapshot 2
      const mid = fingerprint(s);
      execute(s, "mode walk");
      execute(s, "place 99 99 n"); // fails
      execute(s, "cancel");
      execute(s, "rollback"); // back to snapshot 1, not to `mid`
      expect(fingerprint(s)).not.toBe(mid);
      expect(execute(s, "rollback")[0]).toMatch(/nothing to roll back/);
    });

    it("is unavailable in setup and with a single snapshot", () => {
      const setup = newSession(1);
      expect(execute(setup, "rollback")[0]).toMatch(/not available in this phase/);
      const s = battle();
      expect(execute(s, "rollback")[0]).toMatch(/nothing to roll back/);
    });

    it("keeps at most MAX_SNAPSHOT_COUNT snapshots", () => {
      const s = battle();
      for (let i = 0; i < MAX_SNAPSHOT_COUNT + 4 && s.state === "battle"; i++) finishActivation(s);
      expect(s.state).toBe("battle");
      let ok = 0;
      while (!/nothing to roll back/.test(execute(s, "rollback")[0]!)) ok++;
      expect(ok).toBe(MAX_SNAPSHOT_COUNT - 1);
    });

    it("from game over returns to the last battle prompt, and the end replays identically", () => {
      const s = newSession(5);
      resetAutoplayState(s);
      for (let i = 0; i < 2000 && s.state !== "over"; i++) {
        const cmd = nextAutoPlayCommand(s);
        if (cmd === null) break;
        execute(s, cmd);
      }
      expect(s.state).toBe("over");
      const winner = s.over!.victory;
      const lines = s.replay!.lines.length;
      execute(s, "rollback");
      expect(s.state).toBe("battle");
      expect(s.over).toBeNull();
      // Re-issue the commands that ended the game: same dice, same result.
      for (let i = 0; i < 20 && s.state === "battle"; i++) {
        const cmd = nextAutoPlayCommand(s);
        if (cmd === null) break;
        execute(s, cmd);
      }
      expect(s.state).toBe("over");
      expect(s.over!.victory).toEqual(winner);
      expect(s.replay!.lines.length).toBe(lines);
    });

    it("reset and rematch clear the history", () => {
      const s = battle();
      finishActivation(s);
      execute(s, "reset !");
      expect(execute(s, "rollback")[0]).toMatch(/not available in this phase/);
    });
  });
});

describe("session-stage-box", () => {
  const stage = (s: "begin" | "weaponDone" | "physicalDone" | "end"): GameEvent => ({
    kind: "attackPhaseStage",
    stage: s,
    turn: 3,
  });
  const initiative: GameEvent = { kind: "initiative", rolls: { 1: 8, 2: 4 }, winnerTeam: 1 };

  function render(events: GameEvent[]): string[] {
    return handleSessionGameEvents({} as Session, events).flatMap((c) =>
      c.kind === "lines" ? [...c.lines] : [],
    );
  }

  describe("attack-stage log boxes", () => {
    it("frames a stage's lines under its title", () => {
      const lines = render([stage("begin"), initiative, stage("weaponDone")]);
      expect(lines).toHaveLength(2);
      expect(lines[0]).toBe("┌[Weapon Attacks — turn 3]");
      expect(lines[1]?.startsWith("└─ initiative")).toBe(true);
    });

    it("draws inner lines with │ and the last line with the corner", () => {
      const lines = render([stage("begin"), initiative, initiative, stage("weaponDone")]);
      expect(lines).toHaveLength(3);
      expect(lines[1]?.startsWith("│  initiative")).toBe(true);
      expect(lines[2]?.startsWith("└─ initiative")).toBe(true);
    });

    it("renders nothing for an empty stage and closes on end", () => {
      const lines = render([
        stage("begin"),
        stage("weaponDone"),
        stage("physicalDone"),
        initiative,
        stage("end"),
        initiative,
      ]);
      expect(lines[0]).toBe("┌[Attack Aftermath — turn 3]");
      expect(lines[1]?.startsWith("└─ initiative")).toBe(true);
      expect(lines[2]?.startsWith("initiative")).toBe(true);
      expect(lines).toHaveLength(3);
    });
  });
});
