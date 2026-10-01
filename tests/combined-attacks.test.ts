import { describe, expect, it } from "vitest";
import { mechDefFor } from "../src/data/index";
import { requireUnit } from "../src/rules/game";
import {
  commitMovement,
  declareMovementMode,
  newSession,
  queuePhysicalAttack,
  queueWeaponAttacks,
  type Session,
  setTorsoTwist,
} from "../web/session";
import { disableCritical, execute } from "./helpers";

function run(s: Session, cmd: string): string[] {
  return execute(s, cmd);
}

/** Head-to-head adjacency: hunchy (9,9) facing n, cicada (9,8) facing s. */
function attackSetup(): { s: Session; actor: string; enemy: string } {
  const s = newSession(42);
  expect(run(s, "map quickstart")[0]).toContain("15x16");
  expect(run(s, "add hunchy HBK-4G 9 9 n")).toHaveLength(1);
  expect(run(s, "add cicada CDA-3MA 9 8 s")).toHaveLength(1);
  run(s, "start");
  disableCritical(s);
  while (s.state === "battle" && s.battle!.phase === "movement") {
    declareMovementMode(s, "walk");
    commitMovement(s);
  }
  expect(s.battle!.phase).toBe("attack");
  const actor = s.attack!.actorId;
  const enemy = actor === "hunchy" ? "cicada" : "hunchy";
  return { s, actor, enemy };
}

/** Engine-0-based right-arm and torso weapon indices for the actor's 'Mech. */
function armAndTorso(s: Session, actor: string): { arm: number; torso: number } {
  const def = mechDefFor(requireUnit(s.battle!, actor));
  const arm = Number(
    Object.keys(def.weapons).find((k) => def.weapons[Number(k)]?.location === "rightArm"),
  );
  const torso = Number(
    Object.keys(def.weapons).find((k) => {
      const loc = def.weapons[Number(k)]?.location;
      return loc === "centerTorso" || loc === "leftTorso" || loc === "rightTorso";
    }),
  );
  expect(Number.isInteger(arm)).toBe(true);
  expect(Number.isInteger(torso)).toBe(true);
  return { arm, torso };
}

describe("stacked weapon + physical declarations", () => {
  it("rejects firing the punching arm's weapons (punch first)", () => {
    const { s, enemy } = attackSetup();
    const { arm } = armAndTorso(s, s.attack!.actorId);
    queuePhysicalAttack(s, "punch", enemy, "rightArm");
    expect(() => queueWeaponAttacks(s, enemy, [arm])).toThrow(/rightArm/);
    expect(s.attack!.physicalDecls.length).toBe(1);
    expect(s.attack!.weaponDecls).toEqual([]);
  });

  it("rejects punching with an arm whose weapons already fire (fire first)", () => {
    const { s, enemy } = attackSetup();
    const { arm } = armAndTorso(s, s.attack!.actorId);
    queueWeaponAttacks(s, enemy, [arm]);
    expect(() => queuePhysicalAttack(s, "punch", enemy, "rightArm")).toThrow(/rightArm/);
    expect(s.attack!.weaponDecls.length).toBe(1);
    expect(s.attack!.physicalDecls).toEqual([]);
  });

  it("accepts a torso weapon plus punch and resolves both on done", () => {
    const { s, enemy } = attackSetup();
    const { torso } = armAndTorso(s, s.attack!.actorId);
    queueWeaponAttacks(s, enemy, [torso]);
    queuePhysicalAttack(s, "punch", enemy, "rightArm");
    expect(s.attack!.weaponDecls.length).toBe(1);
    expect(s.attack!.physicalDecls.length).toBe(1);
    for (const line of run(s, "done")) expect(line).not.toMatch(/^error:/);
  });

  it("locks the twist after punch or club, but not after kick", () => {
    const first = attackSetup();
    queuePhysicalAttack(first.s, "punch", first.enemy, "rightArm");
    expect(() => setTorsoTwist(first.s, "leftSide")).toThrow(/locked/);

    const second = attackSetup();
    queuePhysicalAttack(second.s, "kick", second.enemy, "rightLeg");
    expect(setTorsoTwist(second.s, "leftSide")).toBe("front");
    expect(second.s.attack!.torsoTwist).toBe("leftSide");
  });
});
