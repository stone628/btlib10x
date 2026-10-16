import { afterEach, describe, expect, it } from "vitest";
import {
  commitMovement,
  declareMovementMode,
  newSession,
  type Session,
  setConfigLocale,
} from "../web/terminal/session";
import { disableCritical, execute } from "./helpers";

function started(): Session {
  const s = newSession(42);
  execute(s, "map quickstart");
  execute(s, "add a HBK-4G 5 5 n");
  execute(s, "add b HBK-4G 6 5 s");
  execute(s, "start");
  disableCritical(s);
  return s;
}

/** Eject whoever moves until the battle ends (bounded). */
function driveToOver(s: Session): void {
  let guard = 0;
  while (s.state === "battle") {
    if (++guard > 200) throw new Error("driveToOver did not finish");
    if (s.battle!.phase === "movement") {
      declareMovementMode(s, "eject");
      commitMovement(s);
    } else {
      execute(s, "done");
    }
  }
}

function over(): Session {
  const s = started();
  driveToOver(s);
  expect(s.state).toBe("over");
  return s;
}

/** Ids of the units that left play, and those still operational. */
function split(s: Session): { gone: string[]; operational: string[] } {
  const units = Object.values(s.battle!.units);
  return {
    gone: units.filter((u) => u.removed !== "not").map((u) => u.id),
    operational: units.filter((u) => u.removed === "not").map((u) => u.id),
  };
}

afterEach(() => setConfigLocale("en"));

describe("salvage command", () => {
  it("is not available before the battle is over", () => {
    const s = started();
    expect(execute(s, "salvage")).toEqual([
      "error: 'salvage' is not available in this phase (try 'help salvage' to read about it)",
    ]);
    const setup = newSession(1);
    expect(execute(setup, "salvage")[0]).toContain("not available in this phase");
    expect(execute(setup, "help salvage")[0]).toBe("usage: salvage [id]");
  });

  it("lists every ejected hull in the roster table", () => {
    const s = over();
    const { gone } = split(s);
    expect(gone.length).toBeGreaterThan(0);
    const out = execute(s, "salvage");
    expect(out[0]).toBe(`salvage (${gone.length}):`);
    for (const id of gone) {
      expect(
        out.some((l) => l.includes(id) && l.includes("hull") && l.includes("pilot ejected")),
      ).toBe(true);
    }
    expect(out.some((l) => l.includes("salvageables"))).toBe(false);
  });

  it("shows a hull's salvageables beside its armor diagram", () => {
    const s = over();
    const { gone, operational } = split(s);
    const id = gone[0]!;
    const unit = s.battle!.units[id]!;
    const out = execute(s, `salvage ${id}`);
    expect(out[0]).toBe(
      `${id} HBK-4G (team ${unit.team}) - hull, pilot ejected, ${unit.position.col},${unit.position.row} standing`,
    );
    expect(out.some((l) => l.includes("salvageables") && l.includes("salvaged hull"))).toBe(true);
    expect(out.some((l) => l.includes("weapons & equipment:") && l.includes("[ HD ]"))).toBe(true);
    expect(out.some((l) => l.includes("  RT: AC/20"))).toBe(true);
    expect(out.some((l) => l.includes("stranded ammo: none"))).toBe(true);
    expect(out.some((l) => l.includes("[ RT ] [ CT ] [ LT ]"))).toBe(true);
    expect(out.some((l) => l.startsWith("salvage ("))).toBe(false);
    expect(execute(s, "salvage nosuch")).toEqual(["error: Unknown unit id: nosuch"]);
    for (const other of operational) {
      expect(execute(s, `salvage ${other}`)).toEqual([`error: '${other}' left nothing to salvage`]);
    }
  });

  it("shows wreckage with the salvageables column only", () => {
    const s = over();
    const unit = s.battle!.units[split(s).gone[0]!]!;
    unit.removed = "destroyed";
    unit.destroyed = "centerTorsoDestroyed";
    unit.prone = true;
    unit.damage = {
      ...unit.damage,
      internalStructure: { ...unit.damage.internalStructure, centerTorso: 0 },
    };
    unit.blownOffLimbs.push({ limb: "leftArm", salvageable: true });
    unit.damage.internalStructure.leftArm = 0;
    const out = execute(s, `salvage ${unit.id}`);
    expect(out[0]).toBe(
      `${unit.id} HBK-4G (team ${unit.team}) - wreckage, CT destroyed, ${unit.position.col},${unit.position.row} prone`,
    );
    expect(out.some((l) => l.includes("salvageables"))).toBe(true);
    expect(out.some((l) => l.includes("salvaged hull") || l.includes("[ HD ]"))).toBe(false);
    expect(out.some((l) => l.includes("  LA (severed): Medium Laser"))).toBe(true);
    const row = execute(s, "salvage").find(
      (l) => l.includes(unit.id) && l.includes("CT destroyed"),
    );
    expect(row).toContain("yes");
  });

  it("speaks Korean after lang ko", () => {
    const s = over();
    execute(s, "lang ko");
    expect(execute(s, "salvage")[0]).toMatch(/^회수 목록 \(\d+\):$/);
    const out = execute(s, `salvage ${split(s).gone[0]!}`);
    expect(out[0]).toContain("기체");
    expect(out.some((l) => l.includes("회수 가능") && l.includes("회수 기체"))).toBe(true);
    expect(out.some((l) => l.includes("무기 및 장비:"))).toBe(true);
  });
});
