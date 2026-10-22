import { buildUnitInit, setUnitPolicy, unitPolicyOf } from "btlib10x";
import { describe, expect, it } from "vitest";
import { nextAutoPlayCommand, resetAutoplayState } from "../web/terminal/autoplay";
import {
  decodeUnitLine,
  encodePolicyEntry,
  encodeUnitLine,
  replayPlayer,
  replayPrettifier,
} from "../web/terminal/replay";
import { newSession, type Session } from "../web/terminal/session";
import { execute } from "./helpers";

function battle(seed = 5): Session {
  const s = newSession(seed);
  execute(s, "map quickstart");
  execute(s, "add me HBK-4G 9 9 n");
  execute(s, "add foe WVR-6R 9 5 s");
  execute(s, "start");
  return s;
}

function actorId(s: Session): string {
  const id = s.battle!.phase === "attack" ? s.attack?.actorId : s.move?.actorId;
  if (id === undefined) throw new Error("no actor");
  return id;
}

/** Finish activations until the attack phase is due. */
function toAttackPhase(s: Session): void {
  for (let i = 0; i < 10 && s.battle!.phase === "movement"; i++) {
    execute(s, "mode standstill");
    execute(s, "done");
  }
  expect(s.battle!.phase).toBe("attack");
}

describe("policy command", () => {
  it("is unavailable in setup", () => {
    const s = newSession(1);
    expect(execute(s, "policy")[0]).toMatch(/not available in this phase/);
    expect(execute(s, "policy ammoPolicy core")[0]).toMatch(/not available in this phase/);
  });

  it("shows and changes the acting unit's policies in the movement phase", () => {
    const s = battle();
    const id = actorId(s);
    expect(execute(s, "policy")).toEqual([
      `${id}: ammo exposed, auto-eject on, flamer-heat on, AMS expected`,
    ]);
    expect(execute(s, "policy ammoPolicy least-first")).toEqual([
      `${id}: ammoPolicy set to least-first`,
    ]);
    expect(execute(s, "policy AUTOEJECT off")).toEqual([`${id}: autoEject set to off`]);
    expect(execute(s, "policy heatflamer OFF")).toEqual([`${id}: heatFlamer set to off`]);
    expect(unitPolicyOf(s.battle!.units[id]!)).toEqual({
      ammoPolicy: "leastFirst",
      autoEject: false,
      heatFlamer: false,
      amsPolicy: "expected",
    });
    expect(execute(s, "policy")).toEqual([
      `${id}: ammo least-first, auto-eject off, flamer-heat off, AMS expected`,
    ]);
  });

  it("works in the attack phase", () => {
    const s = battle();
    toAttackPhase(s);
    const id = actorId(s);
    expect(execute(s, "policy ammoPolicy core")).toEqual([`${id}: ammoPolicy set to core`]);
    expect(s.battle!.units[id]!.ammoPolicy).toBe("core");
  });

  it("rejects non-policy properties and bad values with the set errors", () => {
    const s = battle();
    expect(execute(s, "policy gunnery 3")[0]).toMatch(
      /unknown property 'gunnery'; legal: ammoPolicy, autoEject, heatFlamer/,
    );
    expect(execute(s, "policy ammoPolicy hoard")[0]).toMatch(/ammo policy must be one of/);
    expect(execute(s, "policy autoEject maybe")[0]).toMatch(/autoEject must be on or off/);
    expect(execute(s, "policy heatFlamer 1")[0]).toMatch(/heatFlamer must be on or off/);
    expect(execute(s, "policy ammoPolicy")[0]).toMatch(/policy \[<prop> <value>\]/);
  });

  it("survives cancel and is undone by rollback", () => {
    const s = battle();
    const first = actorId(s);
    execute(s, "mode standstill");
    execute(s, "done");
    const second = actorId(s);
    execute(s, "policy heatFlamer off");
    execute(s, "cancel");
    expect(s.battle!.units[second]!.heatFlamer).toBe(false);
    const lines = s.replay!.lines.length;
    execute(s, "rollback");
    expect(actorId(s)).toBe(first);
    expect(s.battle!.units[second]!.heatFlamer).toBe(true);
    expect(s.replay!.lines.length).toBeLessThan(lines);
  });

  it("records a P record only for a real change", () => {
    const s = battle();
    const idx = s.replay!.units.indexOf(actorId(s)).toString(36);
    const before = s.replay!.lines.length;
    execute(s, "policy ammoPolicy exposed");
    expect(s.replay!.lines.length).toBe(before);
    execute(s, "policy autoEject off");
    expect(s.replay!.lines.at(-1)).toBe(`P${idx}x`);
  });

  it("set keeps working in setup for the three policies", () => {
    const s = newSession(1);
    execute(s, "map quickstart");
    execute(s, "add me HBK-4G 9 9 n");
    expect(execute(s, "set me ammoPolicy leastfirst")).toEqual([
      "me: ammoPolicy set to least-first",
    ]);
    expect(execute(s, "set me heatFlamer off")).toEqual(["me: heatFlamer set to off"]);
    expect(s.setup.roster[0]!.policy).toEqual({
      ammoPolicy: "leastFirst",
      autoEject: true,
      heatFlamer: false,
      amsPolicy: "expected",
    });
  });
});

describe("setUnitPolicy", () => {
  it("patches only the given fields of the current actor", () => {
    const s = battle();
    const id = actorId(s);
    expect(setUnitPolicy(s.battle!, id, { heatFlamer: false })).toEqual({
      ammoPolicy: "exposed",
      autoEject: true,
      heatFlamer: false,
      amsPolicy: "expected",
    });
  });

  it("refuses a unit that is not the current actor and a bad ammo policy", () => {
    const s = battle();
    const id = actorId(s);
    const other = Object.keys(s.battle!.units).find((u) => u !== id)!;
    expect(() => setUnitPolicy(s.battle!, other, { autoEject: false })).toThrow(
      /not the current actor/,
    );
    expect(() =>
      setUnitPolicy(s.battle!, id, { ammoPolicy: "hoard" as unknown as "core" }),
    ).toThrow(/bad ammo policy/);
  });
});

describe("replay P records", () => {
  function playWithPolicyChanges(seed: number): Session {
    const s = newSession(seed);
    resetAutoplayState(s);
    const words = ["ammoPolicy core", "heatFlamer off", "autoEject off", "ammoPolicy spread"];
    let n = 0;
    for (let i = 0; i < 4000 && s.state !== "over"; i++) {
      const cmd = nextAutoPlayCommand(s);
      if (cmd === null) break;
      if (s.state === "battle" && cmd.startsWith("mode")) {
        execute(s, `policy ${words[n++ % words.length]}`);
      }
      execute(s, cmd);
    }
    expect(s.state).toBe("over");
    return s;
  }

  it("a match with mid-battle policy changes replays and verifies", () => {
    const s = playWithPolicyChanges(5);
    const lines = s.replay!.lines;
    expect(lines.some((l) => l.startsWith("P"))).toBe(true);
    expect(() => replayPlayer(lines.join("\n"))).not.toThrow();
    expect(() => replayPlayer(replayPrettifier(lines).join("\n"))).not.toThrow();
  });

  it("fails when the P record names a unit that is not due", () => {
    const s = playWithPolicyChanges(5);
    const lines = [...s.replay!.lines];
    const i = lines.findIndex((l) => l.startsWith("P"));
    const idx = lines[i]![1] === "0" ? "1" : "0";
    lines[i] = `P${idx}${lines[i]!.slice(2)}`;
    expect(() => replayPlayer(lines.join("\n"))).toThrow(/changes policy but/);
  });

  it("encodes the whole policy and keeps P on its activation's line", () => {
    expect(
      encodePolicyEntry("0", {
        ammoPolicy: "core",
        autoEject: true,
        heatFlamer: true,
        amsPolicy: "expected",
      }),
    ).toBe("P0c");
    expect(
      encodePolicyEntry("a", {
        ammoPolicy: "leastFirst",
        autoEject: false,
        heatFlamer: false,
        amsPolicy: "expected",
      }),
    ).toBe("Palxf");
    expect(
      replayPrettifier([
        "V1",
        "Bm",
        "S1",
        "U1a:X:0101n456",
        "P0c",
        "M0s",
        "M1s",
        "P1",
        "A1F",
        "A0F",
      ]),
    ).toEqual(["V1", "Bm;S1", "U1a:X:0101n456", "P0c;M0s;M1s", "P1;A1F;A0F"]);
  });
});

describe("amsPolicy", () => {
  it("is set in setup and by the acting unit, and rejects other values", () => {
    const s = newSession(1);
    execute(s, "map quickstart");
    execute(s, "add me HBK-4G 9 9 n");
    execute(s, "add foe WVR-6R 9 5 s");
    expect(execute(s, "set me amsPolicy FirstHit")).toEqual(["me: amsPolicy set to first-hit"]);
    expect(s.setup.roster[0]!.policy.amsPolicy).toBe("firstHit");
    expect(execute(s, "status").join("\n")).toMatch(/me .* AMS first-hit @/);
    expect(execute(s, "set me amsPolicy sometimes")[0]).toMatch(
      /amsPolicy must be expected, first-hit, priority or off/,
    );
    execute(s, "start");
    expect(s.battle!.units.me!.amsPolicy).toBe("firstHit");
    const id = actorId(s);
    expect(execute(s, "policy amsPolicy priority")).toEqual([`${id}: amsPolicy set to priority`]);
    expect(s.battle!.units[id]!.amsPolicy).toBe("priority");
    expect(() => setUnitPolicy(s.battle!, id, { amsPolicy: "always" as unknown as "off" })).toThrow(
      /bad AMS policy/,
    );
  });

  it("encodes as m / p / o after the other policy chars; defaults write none", () => {
    const base = {
      ammoPolicy: "exposed",
      autoEject: true,
      heatFlamer: true,
    } as const;
    expect(encodePolicyEntry("0", { ...base, amsPolicy: "expected" })).toBe("P0");
    expect(encodePolicyEntry("0", { ...base, amsPolicy: "firstHit" })).toBe("P0m");
    expect(encodePolicyEntry("0", { ...base, amsPolicy: "priority" })).toBe("P0p");
    expect(encodePolicyEntry("0", { ...base, heatFlamer: false, amsPolicy: "off" })).toBe("P0fo");
    const init = buildUnitInit("me", "EXC-B2", 1, { col: 9, row: 9 }, "n", 4, 5, 6, {
      ...base,
      amsPolicy: "priority",
    });
    const line = encodeUnitLine(init);
    expect(line.endsWith(":p")).toBe(true);
    expect(decodeUnitLine(line).policy.amsPolicy).toBe("priority");
  });
});
