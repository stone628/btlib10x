import {
  buildUnitInit,
  type Facing,
  type HexCoord,
  type MoveStep,
  neighbor,
  oppositeFacing,
  type PhysicalAttackDecl,
  rotateFacing,
  VERSION,
} from "btlib10x";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setSlotDestroyed } from "../src/rules/critical";
import { nextAutoPlayCommand, resetAutoplayState } from "../web/autoplay";
import {
  type AttackDeclaration,
  decodeUnitLine,
  encodeAttackEntry,
  encodeEndLine,
  encodeMoveEntry,
  encodeUnitLine,
  encodeWinnerLine,
  type MoveDecl,
  type MoveStart,
  normalizeRng,
  replayChunk,
  replayPlayer,
  replayPrettifier,
  stepsText,
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
  const at = (col: number, row: number, facing: Facing = "n") => ({
    position: { col, row },
    facing,
  });
  const enc = (d: Partial<MoveDecl>, start = at(5, 7), downed = false) =>
    encodeMoveEntry("0", decl(d), downed, start);

  it("walks and runs are relative: + forward, - backward, < > turns", () => {
    expect(enc({ moveMode: "standStill" })).toBe("0s");
    // (5,7) facing n: north is row - 1.
    expect(enc({ moveSteps: [enter(5, 6), enter(5, 5)] })).toBe("0w++");
    expect(enc({ moveSteps: [enter(5, 8)] })).toBe("0w-");
    expect(enc({ moveSteps: [turn(1), turn(1), turn(1)] })).toBe("0w>>>");
    expect(enc({ moveSteps: [turn(-2)] })).toBe("0w<<");
    // right (now facing north-east), forward to (6,6), left, forward x2 to (6,4).
    expect(
      enc({
        moveMode: "run",
        moveSteps: [turn(1), enter(6, 6), turn(-1), enter(6, 5), enter(6, 4)],
      }),
    ).toBe("0r>+<++");
  });
  it("a jump re-aims for free and lands facing the final letter", () => {
    const jump = (steps: MoveStep[], f: Facing | null) =>
      enc({ moveMode: "jump", moveSteps: steps, moveFinalFacing: f });
    expect(jump([enter(5, 6), enter(5, 5), enter(5, 4)], "se")).toBe("0j+++d");
    expect(jump([enter(6, 6), enter(6, 5)], "se")).toBe("0j>+<+d");
    expect(jump([enter(5, 8)], "nw")).toBe("0j-b");
    // 120 degrees to the right reaches the south-east neighbour, to the left the south-west one.
    expect(jump([enter(6, 7)], "n")).toBe("0j>>+n");
    expect(jump([enter(4, 7)], "sw")).toBe("0j<<+a");
  });
  it("every facing has its keyboard letter", () => {
    const letters = (["n", "ne", "se", "s", "sw", "nw"] as const).map((f) =>
      enc({ moveMode: "jump", moveSteps: [enter(5, 6)], moveFinalFacing: f }),
    );
    expect(letters).toEqual(["0j+n", "0j+m", "0j+d", "0j+s", "0j+a", "0j+b"]);
  });
  it("encodes posture changes", () => {
    expect(enc({ moveMode: "standup", postureMove: "standStill", moveFinalFacing: "s" })).toBe(
      "0Uss",
    );
    expect(enc({ moveMode: "standup", postureMove: "standStill" })).toBe("0Us");
    expect(
      enc({
        moveMode: "standup",
        postureMove: "run",
        moveSteps: [enter(5, 6)],
        moveFinalFacing: "n",
      }),
    ).toBe("0Ur+n");
    expect(enc({ moveMode: "prone", postureMove: "standStill" })).toBe("0D");
    expect(enc({ moveMode: "prone", postureMove: "walk", moveSteps: [turn(2)] })).toBe("0D>>");
    expect(enc({ moveMode: "turn", moveSteps: [turn(-1)] })).toBe("0w<");
    expect(enc({ moveMode: "pronestill" })).toBe("0s");
  });
  it("encodes shutdown, startup, eject and a downed pass", () => {
    expect(enc({ moveMode: "shutdown" })).toBe("0X");
    expect(enc({ moveMode: "startup" }, at(5, 7), true)).toBe("0O");
    expect(enc({ moveMode: "eject" }, at(5, 7), true)).toBe("0E");
    expect(enc({ moveMode: "walk" }, at(5, 7), true)).toBe("0.");
  });
  it("rejects what a relative path cannot say", () => {
    expect(() => enc({ moveSteps: [enter(9, 9)] })).toThrow(/adjacent/);
    // Diagonal entry on the ground is not forward or backward.
    expect(() => enc({ moveSteps: [enter(6, 6)] })).toThrow(/neither forward nor backward/);
  });
  it("round-trips: a reference decoder rebuilds the original steps", () => {
    // Minimal decoder of the step part (ground: turns are steps; jump: re-aims are free).
    const decode = (text: string, start: MoveStart, jumping: boolean): MoveStep[] => {
      const out: MoveStep[] = [];
      let hex: HexCoord = start.position;
      let heading: Facing = start.facing;
      for (const ch of text) {
        if (ch === ">" || ch === "<") {
          heading = rotateFacing(heading, ch === ">" ? 1 : -1);
          if (!jumping) out.push({ kind: "turn", facings: ch === ">" ? 1 : -1 });
        } else {
          hex = neighbor(hex, ch === "+" ? heading : oppositeFacing(heading));
          out.push({ kind: "enter", to: hex });
        }
      }
      return out;
    };
    const cases: [MoveStep[], boolean][] = [
      [[enter(5, 6), enter(5, 5)], false],
      [[turn(1), enter(6, 6), turn(-1), enter(6, 5), enter(6, 4)], false],
      [[enter(5, 8), turn(1), turn(1), turn(1), enter(5, 9)], false],
      [[enter(6, 6), enter(6, 5), enter(5, 5)], true],
      [[enter(4, 7), enter(4, 8), enter(5, 8)], true],
    ];
    for (const [steps, jumping] of cases) {
      const text = stepsText(steps, at(5, 7), jumping);
      expect(decode(text, at(5, 7), jumping)).toEqual(steps);
    }
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
    expect(encodeUnitLine(init())).toBe("U0hunchy:HBK-4G:0503s456");
    expect(
      encodeUnitLine(buildUnitInit("cicada", "CDA-3MA", 1, { col: 5, row: 8 }, "n", 3, 5)),
    ).toBe("U1cicada:CDA-3MA:0508n356");
  });
  it("unit line: starting damage, pilot hits and ammo policy", () => {
    const u = {
      ...buildUnitInit("hunchy", "HBK-4G", 0, { col: 5, row: 3 }, "s", 4, 5, 6, {
        ammoPolicy: "spread" as const,
        autoEject: true,
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
    expect(encodeUnitLine(u)).toBe("U0hunchy:HBK-4G:0503s4562:C26/1/1A16/2:a3a4:L13L22:s");
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
    const startCtArmor = hunchy.damage.armor.centerTorso;
    hunchy.damage.armor.head -= 5;
    hunchy.damage.armor.centerTorso = 0;
    hunchy.damage.armorRear.centerTorso -= 4;
    hunchy.damage.internalStructure.centerTorso -= 1;
    setSlotDestroyed(hunchy.critSlotsDestroyed, "rightArm", 4);
    hunchy.ammoBins["leftTorso:1"]! -= 3;
    const line = encodeEndLine("0", hunchy);
    expect(line).toBe(`E03:h5C${startCtArmor}/4/1:a5:L13`);
  });
  it("end line: bins deleted with a destroyed location are recorded as fully used", () => {
    const state = createTestBattle(
      [],
      [init(), buildUnitInit("b", "ENF-4R", 1, { col: 3, row: 1 })],
      true,
    );
    const hunchy = state.units.hunchy!;
    const full = hunchy.ammoBins["leftTorso:1"]!;
    delete hunchy.ammoBins["leftTorso:1"];
    expect(encodeEndLine("0", hunchy)).toBe(`E00:::L1${full}`);
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

describe("replayPrettifier", () => {
  const raw = [
    "V261008-8211edb",
    "Bquickstart",
    "S42",
    "U0hunchy:HBK-4G:0503s456",
    "U1cicada:CDA-3MA:0508n356",
    "M1r++",
    "M0w+",
    "A1L:01~4",
    "A0F:1124",
    "M0s",
    "M1w+",
    "A0F:11~4",
    "A1F:0Q",
    "W03f9a41c7",
    "E01:h5",
    "E10:C17//12",
  ];
  it("lays the records out as version, setup, units, turns, winner, end", () => {
    expect(replayPrettifier(raw)).toEqual([
      "V261008-8211edb",
      "Bquickstart;S42",
      "U0hunchy:HBK-4G:0503s456",
      "U1cicada:CDA-3MA:0508n356",
      "M1r++;M0w+",
      "A1L:01~4;A0F:1124",
      "M0s;M1w+",
      "A0F:11~4;A1F:0Q",
      "W03f9a41c7",
      "E01:h5",
      "E10:C17//12",
    ]);
  });
  it("is still valid replay text and handles degenerate logs", () => {
    expect(replayPrettifier(raw).join(";").split(";")).toEqual(raw.flatMap((r) => r.split(";")));
    expect(replayPrettifier([])).toEqual([]);
    expect(replayPrettifier(["V1", "Bm", "S1"])).toEqual(["V1", "Bm;S1"]);
    expect(replayPrettifier(["V1", "M0s", "W-0"])).toEqual(["V1", "M0s", "W-0"]);
  });
});

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
      "U0hunchy:HBK-4G:0909n456::::c",
      "U1cicada:CDA-3MA:0908s456",
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
    expect(execute(s, "seed 5")[0]).toMatch(/^error: 'seed' is not available in this phase/);
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
    execute(s, "reset !");
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
    expect(last).toContain(`replay data for version ${VERSION}; keep it as is.`);
    for (const line of replayPrettifier(s.replay!.lines)) expect(last).toContain(line);
    const chunk = replayChunk(s)!;
    expect(chunk.kind).toBe("collapsible");
  });
});

// ------------------------------------------------------------- replayPlayer ----

function recorded(setup: string[], seed = 42, maxCommands = 6000): Session {
  const s = newSession(seed);
  execute(s, "map quickstart");
  for (const cmd of setup) execute(s, cmd);
  execute(s, "start");
  resetAutoplayState(s);
  for (let i = 0; i < maxCommands && s.state !== "over"; i++) {
    const cmd = nextAutoPlayCommand(s);
    if (cmd === null) break;
    execute(s, cmd);
  }
  expect(s.state).toBe("over");
  return s;
}

const TWO = ["add hunchy HBK-4G 9 9 n", "add cicada CDA-3MA 9 8 s"];
const FOUR = [
  "add AT AS7-D 3 4 ne",
  "add MD MC-MKII-2 5 3 sw",
  "add ENF ENF-4R 4 5 ne",
  "add WVR WVR-6R 6 4 sw",
];

describe("replayPlayer: a recorded match replays and verifies", () => {
  it.each([
    ["two units", TWO, 42],
    ["two units, other seed", TWO, 7],
    ["four units", FOUR, 42],
    ["four units, other seed", FOUR, 1234],
  ])("%s", (_name, setup, seed) => {
    const s = recorded(setup, seed);
    const lines = s.replay!.lines;
    expect(() => replayPlayer(lines.join("\n"))).not.toThrow();
    expect(() => replayPlayer(lines.join(";"))).not.toThrow();
    expect(() => replayPlayer(replayPrettifier(lines).join("\n"))).not.toThrow();
  });

  it("prints nothing", () => {
    const s = recorded(TWO);
    const spies = (["log", "info", "warn", "error"] as const).map((m) => vi.spyOn(console, m));
    replayPlayer(s.replay!.lines.join("\n"));
    for (const spy of spies) {
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    }
  });
});

describe("decodeUnitLine", () => {
  it("is the inverse of encodeUnitLine, damage and policy included", () => {
    const init = {
      ...buildUnitInit("hunchy", "HBK-4G", 1, { col: 5, row: 3 }, "sw", 3, 5, 7, {
        ammoPolicy: "leastFirst" as const,
        autoEject: true,
      }),
      damage: {
        pilotHits: 2,
        damageTaken: {
          armor: { centerTorso: 26, leftArm: 16, head: 4 },
          armorRear: { centerTorso: 1 },
          internalStructure: { centerTorso: 1, leftArm: 2 },
        },
        critsDestroyed: { rightArm: [3, 4], head: [2] },
        ammoUsed: { "leftTorso:1": 3, "leftTorso:2": 2 },
      },
    };
    const line = encodeUnitLine(init);
    expect(decodeUnitLine(line)).toEqual(init);
    expect(encodeUnitLine(decodeUnitLine(line))).toBe(line);
    const plain = buildUnitInit("cicada", "CDA-3MA", 0, { col: 5, row: 8 }, "n");
    expect(decodeUnitLine(encodeUnitLine(plain))).toEqual(plain);
  });
  it("rejects malformed records", () => {
    expect(() => decodeUnitLine("U0cicada:CDA-3MA:5n")).toThrow(/place/);
    expect(() => decodeUnitLine("U0cicada:CDA-3MA:0508n456:x9")).toThrow(/armor/);
    expect(() => decodeUnitLine("U0cicada:CDA-3MA:0508n456::::z")).toThrow(/policy/);
  });
});

describe("replayPlayer: failures stop at once, naming turn, phase, actor and why", () => {
  const base = recorded(TWO).replay!.lines;
  const at = (prefix: string, nth = 0): number =>
    base.map((l, i) => [l, i] as const).filter(([l]) => l.startsWith(prefix))[nth]![1];
  /** The recorded text with the first record starting with `prefix` replaced by `f(record)`. */
  const change = (prefix: string, f: (record: string) => string): string => {
    const lines = [...base];
    const i = at(prefix);
    lines[i] = f(lines[i]!);
    return lines.join("\n");
  };
  const without = (prefix: string): string => base.filter((_, i) => i !== at(prefix)).join("\n");
  const insertBefore = (prefix: string, record: string): string => {
    const lines = [...base];
    lines.splice(at(prefix), 0, record);
    return lines.join("\n");
  };
  const failure = (text: string): string => {
    try {
      replayPlayer(text);
    } catch (e) {
      return (e as Error).message;
    }
    throw new Error("expected replayPlayer to throw");
  };
  const located = /^replay failed at turn \d+, (setup|movement|attack|end) phase, actor \S+: /;
  const other = (idx: string) => (idx === "0" ? "1" : "0");

  it("a changed step", () => {
    const msg = failure(change("M", (r) => `M${r[1]}w>>>>`));
    expect(msg).toMatch(located);
  });
  it("the wrong unit acts", () => {
    const msg = failure(change("M", (r) => `M${other(r[1]!)}${r.slice(2)}`));
    expect(msg).toMatch(located);
    expect(msg).toMatch(/acts in the record but/);
  });
  it("an attack where movement is due", () => {
    expect(failure(insertBefore("M", "A0F"))).toMatch(/movement activation|attack activation/);
  });
  it("an impossible attack", () => {
    const msg = failure(change("A", (r) => `A${r[1]}F:${other(r[1]!)}z`));
    expect(msg).toMatch(located);
  });
  it("unknown unit index, stray character, unknown record", () => {
    expect(failure(change("M", () => "Mz"))).toMatch(/unknown unit index/);
    expect(failure(change("M", (r) => `${r}*`))).toMatch(/unexpected "\*"/);
    expect(failure(insertBefore("M", "Q1"))).toMatch(/unknown record/);
  });
  it("wrong winner, rng or end state", () => {
    expect(failure(change("W", (r) => `W${other(r[1]!)}${r.slice(2)}`))).toMatch(/expected W/);
    expect(failure(change("W", (r) => `${r.slice(0, -1)}${r.endsWith("0") ? "1" : "0"}`))).toMatch(
      /expected W/,
    );
    expect(failure(change("E", (r) => `${r}h1`))).toMatch(/ended as/);
  });
  it("missing or extra pieces", () => {
    expect(failure(without("W"))).toMatch(/before W|ends before/);
    expect(failure(base.slice(0, -1).join("\n"))).toMatch(/no E record/);
    expect(failure(insertBefore("W", "M0s"))).toMatch(/already over|not over/);
    expect(failure([...base, base[base.length - 1]!].join("\n"))).toMatch(/two E records/);
    expect(failure([...base, "M0s"].join("\n"))).toMatch(/only E records/);
    expect(failure(change("B", () => "Bnowhere"))).toMatch(/Unknown map/);
    expect(failure(change("U", () => "U0x:NOPE-1:0909n456"))).toMatch(/NOPE/);
  });
  it("names the version when it differs", () => {
    expect(failure(`${change("V", () => "Vold-version")}\nM0s`)).toMatch(
      /recorded with old-version/,
    );
  });
});

describe("replayPlayer: scripted matches reach every movement and attack branch", () => {
  type Script = Record<
    string,
    { movement?: Record<number, string[]>; attack?: Record<number, string[]> }
  >;

  /** Drive a session with fixed per-unit command lists (by phase and turn); autoplay never picks these. */
  function playScript(s: Session, script: Script): string[] {
    const errors: string[] = [];
    for (let guard = 0; guard < 400 && s.state === "battle"; guard++) {
      const battle = s.battle!;
      const phase = battle.phase === "attack" ? "attack" : "movement";
      const actor = phase === "attack" ? s.attack?.actorId : s.move?.actorId;
      if (actor === undefined) break;
      const commands =
        script[actor]?.[phase]?.[battle.turn] ??
        (phase === "attack" ? ["done"] : ["mode standstill", "done"]);
      for (const cmd of commands) {
        const out = execute(s, cmd);
        if (out.some((l) => l.startsWith("error:")))
          errors.push(`turn ${battle.turn} ${actor} ${cmd}: ${out.join(" / ")}`);
      }
    }
    return errors;
  }

  const roster = ["add enf ENF-4R 9 9 n", "add hct HCT-5S 9 8 s"];

  function scripted(seed = 42): Session {
    const s = newSession(seed);
    execute(s, "map quickstart");
    for (const cmd of roster) execute(s, cmd);
    execute(s, "start");
    return s;
  }

  it("punches, a hatchet strike, a jump, a drop, stand-up, shutdown, startup and eject", () => {
    const script: Script = {
      hct: {
        attack: { 1: ["strike enf", "done"] },
        movement: {
          2: ["mode prone", "done"],
          3: ["mode standup", "done"],
          4: ["mode eject", "done"],
        },
      },
      enf: {
        attack: { 1: ["punch hct left", "punch hct right", "done"] },
        movement: {
          2: ["mode jump", "place 9 12 ne", "done"],
          3: ["mode shutdown", "done"],
          4: ["mode startup", "done"],
        },
      },
    };
    const s = scripted();
    expect(playScript(s, script)).toEqual([]);
    expect(s.state).toBe("over");
    const text = s.replay!.lines.join("\n");
    // The branches the script was written to reach actually got recorded.
    expect(text).toMatch(/^A[01]F:[01]Th$/m); // hatchet strike, right arm
    expect(text).toMatch(/^A[01]F:[01]PQ$/m); // both punches
    expect(text).toMatch(/^M[01]j---m$/m); // jump backward, landing facing north-east
    expect(text).toMatch(/^M[01]D$/m); // drop prone
    expect(text).toMatch(/^M[01]Us$/m); // stand up
    expect(text).toMatch(/^M[01]X$/m); // shutdown
    expect(text).toMatch(/^M[01]O$/m); // startup
    expect(text).toMatch(/^M[01]E$/m); // eject
    expect(() => replayPlayer(text)).not.toThrow();
  });
});
