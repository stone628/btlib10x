import { buildUnitInit, type PhysicalAttackDecl } from "btlib10x";
import { beforeEach, describe, expect, it } from "vitest";
import { nextAutoPlayCommand, resetAutoplayState } from "../web/autoplay";
import {
  type AttackDeclaration,
  encodeAttackEntry,
  encodeEndLine,
  encodeMoveEntry,
  encodeUnitLine,
  encodeWinnerLine,
  type MoveDecl,
  normalizeRng,
  replayChunk,
  weaponListText,
} from "../web/replay";
import { commitAtomic, newSession, type Session, setSeed } from "../web/session";
import { createTestBattle, disableCritical, execute, scriptedRng } from "./helpers";

const w = (...ns: number[]) => ns.map((weaponIndex) => ({ weaponIndex }));
const idxOf = (id: string) => ({ a: "0", b: "1", c: "2" })[id] ?? "?";

describe("weaponListText", () => {
  it("keeps declaration order and compresses runs of 4+", () => {
    expect(weaponListText(w(1, 2, 3))).toBe("123");
    expect(weaponListText(w(1, 2, 3, 4))).toBe("1~4");
    expect(weaponListText(w(2, 3, 4, 5, 6, 8))).toBe("2~68");
    expect(weaponListText(w(4, 2, 1))).toBe("421");
    expect(weaponListText(w(10, 11, 12, 13))).toBe("a~d");
  });
  it("marks rapid fire and never folds it into a run", () => {
    expect(weaponListText([{ weaponIndex: 3, rapidFire: true }])).toBe("3!");
    expect(
      weaponListText([
        { weaponIndex: 1 },
        { weaponIndex: 2 },
        { weaponIndex: 3, rapidFire: true },
        { weaponIndex: 4 },
      ]),
    ).toBe("123!4");
  });
});

describe("encodeMoveEntry", () => {
  const decl = (over: Partial<MoveDecl>): MoveDecl => ({
    moveMode: "walk",
    postureMove: null,
    moveSteps: [],
    moveFinalFacing: null,
    ...over,
  });
  const enter = (col: number, row: number) => ({ kind: "enter" as const, to: { col, row } });
  const turn = (facings: number) => ({ kind: "turn" as const, facings });

  it("encodes locomotion modes with steps and final facing", () => {
    expect(encodeMoveEntry("1", decl({ moveMode: "standStill" }), false)).toBe("1s");
    expect(
      encodeMoveEntry("1", decl({ moveMode: "run", moveSteps: [enter(5, 7), enter(5, 6)] }), false),
    ).toBe("1r05070506");
    expect(
      encodeMoveEntry("a", decl({ moveSteps: [turn(1), enter(12, 3), turn(-2)] }), false),
    ).toBe("aw+11203-2");
    expect(
      encodeMoveEntry(
        "0",
        decl({ moveMode: "jump", moveSteps: [enter(4, 4)], moveFinalFacing: "sw" }),
        false,
      ),
    ).toBe("0j0404>4");
  });
  it("encodes posture changes", () => {
    expect(
      encodeMoveEntry("0", decl({ moveMode: "standup", postureMove: "standStill" }), false),
    ).toBe("0Us");
    expect(
      encodeMoveEntry(
        "0",
        decl({
          moveMode: "standup",
          postureMove: "run",
          moveSteps: [enter(2, 2)],
          moveFinalFacing: "n",
        }),
        false,
      ),
    ).toBe("0Ur0202>0");
    expect(
      encodeMoveEntry("0", decl({ moveMode: "prone", postureMove: "standStill" }), false),
    ).toBe("0D");
    expect(
      encodeMoveEntry(
        "0",
        decl({ moveMode: "prone", postureMove: "walk", moveSteps: [turn(2)] }),
        false,
      ),
    ).toBe("0D+2");
    expect(encodeMoveEntry("0", decl({ moveMode: "turn", moveSteps: [turn(-1)] }), false)).toBe(
      "0w-1",
    );
    expect(encodeMoveEntry("0", decl({ moveMode: "pronestill" }), false)).toBe("0s");
  });
  it("encodes shutdown, startup, eject and a downed pass", () => {
    expect(encodeMoveEntry("2", decl({ moveMode: "shutdown" }), false)).toBe("2X");
    expect(encodeMoveEntry("2", decl({ moveMode: "startup" }), true)).toBe("2O");
    expect(encodeMoveEntry("2", decl({ moveMode: "eject" }), true)).toBe("2E");
    expect(encodeMoveEntry("2", decl({ moveMode: "walk" }), true)).toBe("2.");
  });
});

describe("encodeAttackEntry", () => {
  const base: AttackDeclaration = {
    weaponDecls: [],
    physicalDecls: [],
    pickupDecl: null,
    pickupArgs: null,
    dropClub: false,
    torsoTwist: "front",
  };
  const fire = (targetId: string, ...ns: number[]) =>
    ns.map((weaponIndex) => ({ weaponIndex, targetId }));
  const phys = (d: Partial<PhysicalAttackDecl> & Pick<PhysicalAttackDecl, "type" | "targetId">) =>
    d as PhysicalAttackDecl;

  it("a bare header is a pass; twist is always written", () => {
    expect(encodeAttackEntry("1", base, idxOf)).toBe("1F");
    expect(encodeAttackEntry("1", { ...base, torsoTwist: "leftSide" }, idxOf)).toBe("1L");
    expect(encodeAttackEntry("1", { ...base, torsoTwist: "rightSide" }, idxOf)).toBe("1R");
  });
  it("weapons and physicals group by target", () => {
    expect(
      encodeAttackEntry(
        "1",
        {
          ...base,
          weaponDecls: fire("a", 1, 2, 3, 4),
          physicalDecls: [phys({ type: "punch", targetId: "a", limb: "rightArm" })],
        },
        idxOf,
      ),
    ).toBe("1F:01~4Q");
    expect(
      encodeAttackEntry(
        "1",
        {
          ...base,
          weaponDecls: fire("a", 1, 2, 3),
          physicalDecls: [phys({ type: "kick", targetId: "c", limb: "rightLeg" })],
        },
        idxOf,
      ),
    ).toBe("1F:0123:2L");
  });
  it("encodes every physical command", () => {
    const one = (d: PhysicalAttackDecl) =>
      encodeAttackEntry("0", { ...base, physicalDecls: [d] }, idxOf);
    expect(one(phys({ type: "punch", targetId: "b", limb: "leftArm" }))).toBe("0F:1P");
    expect(one(phys({ type: "punch", targetId: "b", limb: "rightArm" }))).toBe("0F:1Q");
    expect(one(phys({ type: "kick", targetId: "b", limb: "leftLeg" }))).toBe("0F:1K");
    expect(one(phys({ type: "kick", targetId: "b", limb: "rightLeg" }))).toBe("0F:1L");
    expect(one(phys({ type: "push", targetId: "b" }))).toBe("0F:1U");
    expect(one(phys({ type: "club", targetId: "b" }))).toBe("0F:1C");
    expect(one(phys({ type: "strike", targetId: "b", limb: "leftArm", weapon: "Hatchet" }))).toBe(
      "0F:1Sh",
    );
    expect(one(phys({ type: "strike", targetId: "b", limb: "rightArm", weapon: "Sword" }))).toBe(
      "0F:1Ts",
    );
    expect(
      one(phys({ type: "strike", targetId: "b", limb: "rightArm", weapon: "Retractable Blade" })),
    ).toBe("0F:1Tb");
    const two = encodeAttackEntry(
      "0",
      {
        ...base,
        physicalDecls: [
          phys({ type: "punch", targetId: "b", limb: "leftArm" }),
          phys({ type: "punch", targetId: "c", limb: "rightArm" }),
        ],
      },
      idxOf,
    );
    expect(two).toBe("0F:1P:2Q");
  });
  it("drop and pickup", () => {
    expect(encodeAttackEntry("0", { ...base, dropClub: true }, idxOf)).toBe("0F-");
    expect(
      encodeAttackEntry("0", { ...base, dropClub: true, weaponDecls: fire("a", 2) }, idxOf),
    ).toBe("0F-:02");
    const pick = (args: AttackDeclaration["pickupArgs"]) =>
      encodeAttackEntry("0", { ...base, pickupDecl: {}, pickupArgs: args }, idxOf);
    expect(pick({})).toBe("0F+");
    expect(pick({ source: "tree" })).toBe("0F+t");
    expect(pick({ source: "limb", tokenIndex: 2 })).toBe("0F+l2");
    expect(pick({ tokenIndex: 1 })).toBe("0F+1");
  });
});

describe("unit and end lines", () => {
  const init = (model = "HBK-4G") =>
    buildUnitInit("hunchy", model, 0, { col: 5, row: 3 }, "s", 4, 5, 6);

  it("unit line: defaults omit every optional field", () => {
    expect(encodeUnitLine(init())).toBe("U0hunchy:HBK-4G:05033456");
    expect(
      encodeUnitLine(buildUnitInit("cicada", "CDA-3MA", 1, { col: 5, row: 8 }, "n", 3, 5)),
    ).toBe("U1cicada:CDA-3MA:05080356");
  });
  it("unit line: starting damage, pilot hits and ammo policy", () => {
    const u = {
      ...buildUnitInit("hunchy", "HBK-4G", 0, { col: 5, row: 3 }, "s", 4, 5, 6, {
        ammoPolicy: "spread" as const,
      }),
      damage: {
        pilotHits: 2,
        damageTaken: {
          armor: { centerTorso: 26, leftArm: 16 },
          armorRear: { centerTorso: 1 },
          internalStructure: { centerTorso: 1, leftArm: 2 },
        },
        critsDestroyed: { rightArm: [3, 4] },
        ammoUsed: { "leftTorso:1": 3, "leftTorso:2": 2 },
      },
    };
    expect(encodeUnitLine(u)).toBe("U0hunchy:HBK-4G:050334562:C26/1/1A16/2:a3a4:L13L22:s");
  });
  it("end line: pristine unit is just the hit count; damage is diffed vs the model", () => {
    const state = createTestBattle(
      [],
      [init(), buildUnitInit("b", "ENF-4R", 1, { col: 3, row: 1 })],
      true,
    );
    const hunchy = state.units.hunchy!;
    expect(encodeEndLine("0", hunchy)).toBe("E00");
    hunchy.pilotHits = 3;
    hunchy.damage.armor.head -= 5;
    hunchy.damage.armor.centerTorso = 0;
    hunchy.damage.armorRear.centerTorso -= 4;
    hunchy.damage.internalStructure.centerTorso -= 1;
    hunchy.critSlotsDestroyed.rightArm[4] = true;
    hunchy.ammoBins["leftTorso:1"]!.shots -= 3;
    const line = encodeEndLine("0", hunchy);
    expect(line).toBe(`E03:h5C${state.units.hunchy!.baseDamage.armor.centerTorso}/4/1:a5:L13`);
  });
  it("winner line: team or '-', rng as 8 hex digits (negative snapshots included)", () => {
    expect(normalizeRng("3f9a41c7")).toBe("3f9a41c7");
    expect(normalizeRng("ff")).toBe("000000ff");
    expect(normalizeRng("-1")).toBe("ffffffff");
    expect(encodeWinnerLine({ winnerTeam: 0, draw: false }, "3f9a41c7")).toBe("W03f9a41c7");
    expect(encodeWinnerLine({ winnerTeam: null, draw: true }, "ff")).toBe("W-000000ff");
  });
});

/** Two adjacent mechs on quickstart, ready to `start`. */
function readySession(seed = 42): Session {
  const s = newSession(seed);
  execute(s, "map quickstart");
  execute(s, "add hunchy HBK-4G 9 9 n");
  execute(s, "add cicada CDA-3MA 9 8 s");
  return s;
}

/** Run autoplay until the battle ends (bounded). */
function playToEnd(s: Session): void {
  resetAutoplayState(s);
  for (let i = 0; i < 4000 && s.state !== "over"; i++) {
    const cmd = nextAutoPlayCommand(s);
    if (cmd === null) break;
    execute(s, cmd);
  }
}

describe("replay log in the session", () => {
  beforeEach(() => resetAutoplayState(newSession(1)));

  it("starts with V B S U… when the battle starts", () => {
    const s = readySession(7);
    expect(s.replay).toBeNull();
    execute(s, "set hunchy ammoPolicy core");
    execute(s, "start");
    const lines = s.replay!.lines;
    expect(lines[0]).toMatch(/^V\S+$/);
    expect(lines.slice(1)).toEqual([
      "Bquickstart",
      "S7",
      "U0hunchy:HBK-4G:09090456::::c",
      "U1cicada:CDA-3MA:09083456",
    ]);
  });

  it("records activations in order and closes with W + E lines (seeded autoplay)", () => {
    const s = readySession(42);
    execute(s, "start");
    playToEnd(s);
    expect(s.state).toBe("over");
    const lines = s.replay!.lines;
    const body = lines.slice(5, -3);
    expect(body.length).toBeGreaterThan(0);
    expect(body.every((l) => /^[MA][0-9a-z]/.test(l))).toBe(true);
    // Phases alternate: runs of M then runs of A.
    const kinds = body
      .map((l) => l[0])
      .join("")
      .replace(/(.)\1+/g, "$1");
    expect(kinds).toMatch(/^(MA)+$/);
    const [w, e0, e1] = lines.slice(-3);
    const victory = s.over!.victory;
    expect(w).toBe(`W${victory.draw ? "-" : victory.winnerTeam}${normalizeRng(s.rng.snapshot())}`);
    expect(e0).toMatch(/^E0[0-9a-z]/);
    expect(e1).toMatch(/^E1[0-9a-z]/);
    // The victor's state is in the end lines; the loser's centre torso or head is gone.
    expect(`${e0}${e1}`).toMatch(/[CH]|h/);
  });

  it("is identical for identical seeds and differs from the final rng for others", () => {
    const run = (seed: number) => {
      const s = readySession(seed);
      execute(s, "start");
      playToEnd(s);
      return s.replay!.lines;
    };
    expect(run(5)).toEqual(run(5));
    expect(run(5)).not.toEqual(run(6));
  });

  it("a rejected commit leaves no trace", () => {
    const s = readySession();
    execute(s, "start");
    disableCritical(s);
    const before = [...s.replay!.lines];
    expect(() =>
      commitAtomic(s, () => {
        s.replay!.lines.push("Mjunk");
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(s.replay!.lines).toEqual(before);
    execute(s, "mode walk");
    execute(s, "done");
    expect(s.replay!.lines.length).toBe(before.length + 1);
    expect(s.replay!.lines.at(-1)).toMatch(/^M[01]w/);
  });

  it("the seed is set in setup only and ends up in the header", () => {
    const s = readySession();
    execute(s, "seed 99");
    execute(s, "start");
    expect(s.replay!.lines[2]).toBe("S99");
    const before = [...s.replay!.lines];
    expect(execute(s, "seed 5")[0]).toMatch(/^error: unknown command 'seed'/);
    expect(() => setSeed(s, 5)).toThrow(/already started/);
    expect(s.setup.seed).toBe(99);
    expect(s.replay!.lines).toEqual(before);
  });

  it("rematch restarts the log; reset clears it and re-seeds", () => {
    const s = readySession(42);
    execute(s, "start");
    playToEnd(s);
    const first = [...s.replay!.lines];
    execute(s, "rematch");
    expect(s.replay!.lines).toHaveLength(first.indexOf(first.find((l) => l.startsWith("M"))!));
    expect(s.replay!.lines.slice(0, 3)).toEqual(first.slice(0, 3));
    execute(s, "reset");
    expect(s.replay).toBeNull();
    // After a reset the generator is fresh again, so the next battle is recordable.
    execute(s, "map quickstart");
    execute(s, "add hunchy HBK-4G 9 9 n");
    execute(s, "add cicada CDA-3MA 9 8 s");
    execute(s, "start");
    expect(s.replay!.disabled).toBe(false);
    expect(s.replay!.lines.length).toBeGreaterThan(0);
  });

  it("is disabled when the rng was replaced (cannot be reproduced)", () => {
    const s = readySession();
    s.rng = scriptedRng(2, 3, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6);
    execute(s, "start");
    expect(s.replay!.disabled).toBe(true);
    expect(s.replay!.lines).toEqual([]);
    expect(replayChunk(s)).toBeNull();
  });

  it("shows a collapsible block with the data when the game ends", () => {
    const s = readySession(42);
    execute(s, "start");
    const outputs: string[][] = [];
    resetAutoplayState(s);
    for (let i = 0; i < 4000 && s.state !== "over"; i++) {
      const cmd = nextAutoPlayCommand(s);
      if (cmd === null) break;
      outputs.push(execute(s, cmd));
    }
    const last = outputs.at(-1)!;
    expect(last).toContain("you can replay this match with this data");
    for (const line of s.replay!.lines) expect(last).toContain(line);
    const chunk = replayChunk(s)!;
    expect(chunk.kind).toBe("collapsible");
  });
});
