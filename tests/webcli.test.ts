import { describe, expect, it } from "vitest";
import { getMapDef, getMechDef } from "../src/data/index.js";
import { canFireFromLocation } from "../src/rules/damage.js";
import { REACHABLE_MARKER, reachableModel } from "../web/format.js";
import { GRID_GLYPHS, TEAM_STYLES } from "../web/render.js";
import * as S from "../web/session.js";
import { execute } from "./helpers.js";

function run(s: S.Session, cmd: string): string[] {
  return execute(s, cmd);
}

function freshSetup(): S.Session {
  const s = S.newSession(42);
  s.critsDisabled = true;
  expect(run(s, "map quickstart")[0]).toContain("15x16");
  // Adjacent foes, facing each other along the n/s axis (1-based coords).
  expect(run(s, "add hunchy HBK-4G 0 4 9 9 n")).toHaveLength(1);
  expect(run(s, "add cicada CDA-3MA 1 4 9 8 s")).toHaveLength(1);
  return s;
}

/** Queue every currently usable mount of the acting unit at its enemy. */
function fireEverything(s: S.Session, enemy: string): void {
  const st = s.battle!;
  const unit = st.units[S.currentActor(s)!.id]!;
  const def = getMechDef(unit.model)!;
  Object.entries(def.weapons).forEach(([key, mount]) => {
    const weaponIndex = Number(key);
    if (unit.jammedWeapons.includes(weaponIndex)) return;
    if (!canFireFromLocation(unit.phaseStartDamage, mount.location)) return;
    if (unit.ammoLeft[weaponIndex] !== undefined && (unit.ammoLeft[weaponIndex] ?? 0) < 1) return;
    S.queueFire(s, { weaponIndex, targetId: enemy });
  });
}

/** Drive a started battle until it is over using minimal legal actions. */
function autoPlay(s: S.Session): void {
  for (let i = 0; i < 500 && s.app === "battle"; i++) {
    const st = s.battle!;
    const actorId = S.currentActor(s)!.id;
    const ids = Object.values(st.units)
      .filter((u) => !u.removed)
      .map((u) => u.id);
    const enemy = ids.find((id) => id !== actorId)!;
    if (st.phase === "movement") {
      S.declareMode(s, "walk");
      S.commitMove(s);
    } else {
      fireEverything(s, enemy);
      S.commitFire(s);
    }
  }
  expect(s.app).toBe("over");
  expect(s.victory).not.toBeNull();
}

describe("help", () => {
  it("lists only commands legal in the current state", () => {
    const s = S.newSession();
    s.critsDisabled = true;
    const setupHelp = run(s, "help").join("\n");
    expect(setupHelp).toContain("add");
    expect(setupHelp).toContain("info mech");
    expect(setupHelp).not.toContain("fire");
    expect(setupHelp).not.toContain("rematch");

    const battle = freshSetup();
    run(battle, "start");
    const moveHelp = run(battle, "?").join("\n");
    expect(moveHelp).toContain("mode");
    expect(moveHelp).toContain("face");
    expect(moveHelp).not.toContain("fire");
    expect(moveHelp).not.toContain("map <name>");
  });

  it("shows usage and explanation on separate lines for arg commands", () => {
    const s = S.newSession();
    s.critsDisabled = true;
    const help = run(s, "help");
    const addIdx = help.findIndex((l) => l.startsWith("add"));
    expect(help[addIdx]).toMatch(/^add\s+add <id>/);
    expect(help[addIdx! + 1]).toMatch(/^\s{10}place a 'Mech/);

    const boardIdx = help.findIndex((l) => l.startsWith("board"));
    expect(help[boardIdx]).toContain("draw the ASCII battle grid"); // arg-less stays one line
  });
});

describe("hint", () => {
  it("heads the help message with per-state guidance", () => {
    const s = S.newSession();
    s.critsDisabled = true;
    const setupHelp = run(s, "help");
    expect(setupHelp.slice(0, 3).join(" ")).toContain("'setup' phase");
    expect(setupHelp[1]).toContain("'add'");
    expect(setupHelp[1]).not.toContain("<");
    expect(setupHelp[2]).toContain("'start'");
    expect(setupHelp[3]).toBe("");

    const battle = freshSetup();
    run(battle, "start");
    const moveHelp = run(battle, "?");
    expect(moveHelp[0]).toContain("movement phase");
    expect(moveHelp[1]).toContain("'mode'");
    expect(moveHelp[1]).toContain("'move'");
    expect(moveHelp[1]).not.toContain("<");
    expect(moveHelp[2]).toContain("'done'");
    expect(moveHelp[3]).toBe("");

    while (battle.battle?.phase !== "weaponAttack") {
      run(battle, "mode walk");
      run(battle, "done");
    }
    const attackHelp = run(battle, "help");
    expect(attackHelp[0]).toContain("weapon attack phase");
    expect(attackHelp[1]).toContain("'fire'");
    expect(attackHelp.slice(0, 3).join("\n")).not.toContain("<");
  });

  it("points at rematch/reset once over", () => {
    const s = freshSetup();
    run(s, "start");
    autoPlay(s);
    expect(s.app).toBe("over");
    const help = run(s, "help");
    expect(help[0]).toContain("over");
    expect(help[1]).toContain("'rematch'");
    expect(help[1]).toContain("'reset'");
    expect(help[2]).toBe("");
  });
});

describe("help <command>", () => {
  it("details usage and arguments without the state hint", () => {
    const s = S.newSession();
    s.critsDisabled = true;
    const out = run(s, "help add");
    expect(out[0]).toBe("usage: add <id> <model> <team> <gunnery> <col> <row> [facing]");
    expect(out.join("\n")).toContain("arguments:");
    expect(out.join("\n")).toMatch(/gunnery\s+pilot gunnery skill/);
    expect(out.join("\n")).not.toContain("setup' phase");

    const board = run(s, "help board");
    expect(board.join("\n")).not.toContain("arguments:");
    expect(run(s, "? map")[0]).toBe("usage: map <name>");

    const err = run(s, "help bogus")[0];
    expect(err).toMatch(/^error: unknown command 'bogus'/);
  });

  it("only details commands legal in the current state", () => {
    const battle = freshSetup();
    run(battle, "start");
    expect(run(battle, "help fire")[0]).toMatch(/^error: unknown command 'fire'/);
    while (battle.battle?.phase !== "weaponAttack") {
      run(battle, "mode walk");
      run(battle, "done");
    }
    expect(run(battle, "help fire")[0]).toBe("usage: fire <targetId> <weapon> [<weapon> ...]");
    expect(run(battle, "help add")[0]).toMatch(/^error: unknown command 'add'/);
    expect(run(battle, "help fire").join("\n")).toContain("declare several weapons");
  });
});

describe("board", () => {
  it("explains instead of drawing a 1x1 grid when nothing is loaded", () => {
    const s = S.newSession();
    s.critsDisabled = true;
    const out = run(s, "board").join("\n");
    expect(out).toContain("no battlefield yet");
    expect(out).toContain("'map'");
    expect(out).not.toContain("---");

    run(s, "map beginner");
    run(s, "add hbk HBK-4G 0 4 3 3");
    const board = run(s, "board").join("\n");
    expect(board).toContain(`${GRID_GLYPHS.vertW}  hbk ${GRID_GLYPHS.vertE}`); // placed unit id drawn
    expect(board).toContain("\u2191"); // facing glyph drawn in setup
    expect(board).toContain(`${GRID_GLYPHS.edgeNW}0101${GRID_GLYPHS.edgeNE}`); // map renders even with no units
    expect(board).toContain(`${GRID_GLYPHS.edgeSW} W0 ${GRID_GLYPHS.edgeSE}`); // terrain glyphs + elevation
    expect(board).toContain(`${GRID_GLYPHS.edgeSW}  0 ${GRID_GLYPHS.edgeSE}`); // clear hex elevation
    expect(board).toContain("legend: w(lightWoods)  W(heavyWoods)");
  });

  it("reports occupied hexes with 1-based coordinates", () => {
    const s = S.newSession();
    s.critsDisabled = true;
    run(s, "add hbk HBK-4G 0 4 3 3");
    expect(run(s, "add grf GRF-1N 1 4 3 3")[0]).toBe("error: Hex 3,3 already occupied");
  });
});

describe("clear", () => {
  it("signals a screen wipe via form feed", () => {
    const s = S.newSession();
    s.critsDisabled = true;
    expect(run(s, "clear")).toEqual(["\f"]);
  });
});

describe("info", () => {
  it("lists mechs and details one", () => {
    const s = S.newSession();
    s.critsDisabled = true;
    const list = run(s, "info mech");
    expect(list.some((l) => l.startsWith("HBK-4G"))).toBe(true);
    const detail = run(s, "info mech HBK-4G").join("\n");
    expect(detail).toContain("walk 4 / run 6 / jump 0");
    expect(detail).toContain(" 9A");
    expect(detail).toContain("26F");
    expect(detail).toContain("Autocannon/20");
    expect(detail).toContain("#1 Autocannon/20 (RT)");
    expect(detail).toContain("critical slots");
    expect(detail).toContain("  3 Cockpit");
    expect(run(s, "info mech NOPE")[0]).toMatch(/^error: Unknown 'Mech model/);
  });

  it("matches mech model case-insensitively", () => {
    const s = S.newSession();
    s.critsDisabled = true;
    const upper = run(s, "info mech hbk-4g").join("\n");
    const mixed = run(s, "info mech Hbk-4g").join("\n");
    expect(upper).toContain("Autocannon/20");
    expect(mixed).toContain("Autocannon/20");
  });

  it("lists maps and renders the ASCII sheet", () => {
    const s = S.newSession();
    s.critsDisabled = true;
    expect(run(s, "info map").join("\n")).toContain("quickstart");
    const qs = getMapDef("quickstart")!;
    const detail = run(s, "info map quickstart");
    const text = detail.join("\n");
    expect(text).toContain(`${qs.width}x${qs.height}`);
    expect(text).toMatch(/lightWoods \d+/);
    expect(text).toMatch(/heavyWoods \d+/);
    expect(text).toContain("legend: w(lightWoods)  W(heavyWoods)");
    expect(text).toContain(`${GRID_GLYPHS.edgeSW} w0 ${GRID_GLYPHS.edgeSE}`);
    expect(text).toContain(`${GRID_GLYPHS.edgeSW} W0 ${GRID_GLYPHS.edgeSE}`);
    const beginner = run(s, "info map beginner").join("\n");
    expect(beginner).toContain(`${GRID_GLYPHS.edgeSW} W0 ${GRID_GLYPHS.edgeSE}`);
  });

  it("matches map name case-insensitively", () => {
    const s = S.newSession();
    s.critsDisabled = true;
    const upper = run(s, "info map QUICKSTART").join("\n");
    const mixed = run(s, "info map QuickStart").join("\n");
    expect(upper).toMatch(/lightWoods \d+/);
    expect(mixed).toMatch(/lightWoods \d+/);
  });

  it("matches weapon name case-insensitively", () => {
    const s = S.newSession();
    s.critsDisabled = true;
    const upper = run(s, "info weapon MEDIUM LASER").join("\n");
    const mixed = run(s, "info weapon medium laser").join("\n");
    expect(upper).toMatch(/Medium Laser/);
    expect(mixed).toMatch(/Medium Laser/);
  });
});

describe("sheet", () => {
  it("shows a record sheet during a move phase", () => {
    const s = freshSetup();
    run(s, "start");
    const lines = run(s, "sheet hunchy").join("\n");
    expect(lines).toContain("Hunchback HBK-4G");
    expect(lines).toContain("gunnery: Regular(4)");
    expect(lines).toContain("9/ 9A");
    expect(lines).toContain("26/26F");
    expect(lines).toContain("#1 Autocannon/20 (RT)");
    expect(lines).toContain("critical slots");
    expect(lines).toContain("  1 Shoulder");
  });

  it("lists units grouped by team when no id is given", () => {
    const s = freshSetup();
    run(s, "start");
    const out = run(s, "sheet").join("\n");
    expect(out).toContain("team 0:");
    expect(out).toContain("hunchy  HBK-4G  9,9 facing n");
    expect(out).toContain("team 1:");
    expect(out).toContain("cicada  CDA-3MA  9,8 facing s");
  });

  it("tracks armor damage during battle", () => {
    const s = freshSetup();
    run(s, "start");
    const before = run(s, "sheet hunchy").join("\n");
    expect(before).toContain("position: 9,9 facing n");
    expect(before).toContain("26/26F");
    autoPlay(s);
    // Battle ended; at least one unit took damage.
    const allUnits = Object.values(s.battle!.units);
    const damaged = allUnits.some((u) =>
      Object.values(u.damage.armor).some(
        (v) =>
          v <
          Object.values(getMechDef(u.model)!.armor).reduce(
            (a: number, b: number) => Math.max(a, b),
            0,
          ),
      ),
    );
    expect(damaged).toBe(true);
  });
});

describe("setup flow", () => {
  it("status groups units by team and names the map", () => {
    const s = freshSetup();
    const out = run(s, "status").join("\n");
    expect(out).toContain("map: quickstart");
    expect(out).toContain("team 0:");
    expect(out).toContain("team 1:");
    expect(out).toContain("hunchy  HBK-4G");
    expect(out).toMatch(/hunchy\s+HBK-4G \(Hunchback\) gunnery Regular\(4\)/);
  });

  it("starts the battle and lands on a turn(N):move prompt", () => {
    const s = freshSetup();
    const out = run(s, "start");
    expect(out[0]).toBe("battle started");
    expect(out.join("\n")).toMatch(/initiative:.*team \d wins initiative and moves last/);
    expect(S.promptBody(s)).toMatch(/^turn\(1\):move\(team \d, mech \w+\)$/);
  });

  it("rejects starting with one team", () => {
    const s = S.newSession();
    s.critsDisabled = true;
    run(s, "add a HBK-4G 0 4 2 2 n");
    run(s, "add b GRF-1N 0 4 3 3 n");
    expect(run(s, "start")[0]).toMatch(/^error: .*\bteam/);
  });

  it("accepts map and model arguments case-insensitively", () => {
    const s = S.newSession();
    s.critsDisabled = true;
    expect(run(s, "map QUICKSTART")[0]).toMatch(/^map quickstart:/);
    expect(s.mapName).toBe("quickstart");
    expect(run(s, "add lower hbk-4g 0 4 2 2 n")[0]).toMatch(/lower \(HBK-4G\) placed at/);
    expect(s.roster.find((u) => u.id === "lower")?.model).toBe("HBK-4G");
  });
});

describe("movement", () => {
  it("queues steps with running MP totals and commits", () => {
    const s = freshSetup();
    run(s, "start");
    const firstActor = S.currentActor(s)!;
    const declared = run(s, "mode walk");
    // 'mode walk' acknowledges the declaration and prints a clipped hex map
    // (board legend + grid) instead of a textual reachable list.
    expect(declared[0]).toMatch(/declares walk, can use 4 movement point\.$/);
    expect(declared.join("\n")).toContain("legend:");
    // Walk straight back relative to facing is illegal; sideways too. Forward
    // depends on facing, so use standstill-safe single forward step toward foe.
    const status0 = run(s, "status").join("\n");
    expect(status0).toContain("budget: 4 MP");

    const queued = run(s, "face ne");
    expect(queued.join("\n")).toMatch(/facing ne \[MP 1\/4\]/);
    const status1 = run(s, "status").join("\n");
    expect(status1).toMatch(/1\. face \+\d+ .*total 1/);

    expect(run(s, "done").length).toBeGreaterThan(0);
    expect(s.battle!.units[firstActor.id]!.facing).toBe("ne");
  });

  it("rejects illegal steps without corrupting state", () => {
    const s = freshSetup();
    run(s, "start");
    const posBefore = { ...S.currentActor(s)!.position };
    expect(run(s, "move 5 5")[0]).toMatch(/^error: Declare a movement mode/);
    run(s, "mode walk");
    // Whatever the facing, display (5,5) is not adjacent-forward/back from (9,9).
    const err = run(s, "move 5 5")[0]!;
    expect(err.startsWith("error:")).toBe(true);
    expect(S.currentActor(s)!.position).toEqual(posBefore);
  });

  it("rolls back the battle when a commit fails", () => {
    const s = freshSetup();
    run(s, "start");
    run(s, "mode walk");
    // Tamper directly with the internal step buffer to force executeMove to
    // throw at commit time (illegal sideways step) rather than at queue time.
    const actor = S.currentActor(s)!;
    const beforeLen = s.battle!.events.length;
    const beforePos = { ...actor.position };
    s.moveSteps.push({ kind: "enter", to: { col: 2, row: 2 } }); // not straight ahead/back
    expect(run(s, "done")[0]).toMatch(/^error:/);
    expect(s.battle!.events).toHaveLength(beforeLen);
    expect(s.battle!.units[actor.id]!.position).toEqual(beforePos);
  });

  it("shows a clipped reachable hex map on 'mode' except for standstill", () => {
    const s = freshSetup();
    run(s, "start");
    const actor = S.currentActor(s)!;
    const ownCoord = `${String(actor.position.col).padStart(2, "0")}${String(
      actor.position.row,
    ).padStart(2, "0")}`;

    // standstill: only the acknowledgement, no board chunk.
    const still = run(s, "mode standstill");
    expect(still).toHaveLength(1);
    expect(still.join("\n")).not.toContain("legend:");

    // walk/run always have MP; they render a clipped hex map of reachable
    // hexes (board legend + grid) with reachable markers.
    for (const word of ["walk", "run"]) {
      const out = run(s, `mode ${word}`).join("\n");
      expect(out).toContain("legend:");
      expect(out).toContain(`/${ownCoord}\\`);
      expect(out).toContain(REACHABLE_MARKER);
      // Clipped exactly to the reachable bbox (no padding): far fewer hex
      // coordinate labels than the full 15x16 board's 240.
      const labels = (out.match(/\/\d{4}\\/g) ?? []).length;
      expect(labels).toBeLessThan(200);
      // No facing arrows are drawn (edges carry the team color instead).
      expect(out).not.toContain("\u2191");
      expect(out).not.toContain("\u2197");
      expect(out).not.toContain("\u2198");
      expect(out).not.toContain("\u2199");
      expect(out).not.toContain("\u2192");
    }
  });

  it("shows a clipped reachable hex map for jump", () => {
    const s = S.newSession(42);
    s.critsDisabled = true;
    // Load a map so the board bounds exist; place two jump-capable 'Mechs
    // far apart on a clear region of the board; either may act first.
    run(s, "map quickstart");
    expect(run(s, "add grf GRF-1N 0 4 5 5 n")).toHaveLength(1);
    expect(run(s, "add wvr WVR-6R 1 4 12 12 s")).toHaveLength(1);
    run(s, "start");
    const out = run(s, "mode jump").join("\n");
    expect(out).toContain("legend:");
    expect(out).toContain(REACHABLE_MARKER);
    // Clipped exactly to the reachable bbox (no padding): far fewer hex
    // coordinate labels than the full 15x16 board's 240.
    const labels = (out.match(/\/\d{4}\\/g) ?? []).length;
    expect(labels).toBeLessThan(200);
    expect(out).not.toContain("\u2191");
  });

  it("reachableModel crops to the reachable bbox and tints edges with the actor team", () => {
    const s = freshSetup();
    run(s, "start");
    run(s, "mode walk");
    const actor = S.currentActor(s)!;
    const model = reachableModel(s);
    expect(model).not.toBeNull();
    const m = model!;
    // Exact reachable bbox, clamped to the board: larger than one hex and
    // smaller than the full 15x16 board.
    expect(m.col0).toBeGreaterThanOrEqual(1);
    expect(m.row0).toBeGreaterThanOrEqual(1);
    expect(m.cols * m.rows).toBeLessThan(15 * 16);
    // The acting unit's hex is inside the crop; no per-hex facing arrows.
    expect(m.facings).toBeUndefined();
    // Reachable (hex, facing) edges are tinted with the actor's team color.
    const team = TEAM_STYLES[actor.team];
    expect(Object.values(m.edgeStyles ?? {})).toContainEqual(team);
    // Reachable hexes show a team-tinted `<>` belly marker.
    const markerKey = Object.keys(m.cells ?? {}).find((k) => m.cells![k] === REACHABLE_MARKER);
    expect(markerKey).toBeDefined();
    expect(markerKey).not.toBe(`${actor.position.col},${actor.position.row}`);
    expect(m.cellStyles?.[markerKey ?? ""]).toEqual(team);
  });
});

describe("attack", () => {
  it("reaches weaponAttack phase, queues fire and resolves", () => {
    const s = freshSetup();
    run(s, "start");
    // Both units walk in place to burn the movement phase.
    while (s.app === "battle" && s.battle!.phase === "movement") {
      S.declareMode(s, "walk");
      S.commitMove(s);
    }
    expect(s.battle!.phase).toBe("weaponAttack");
    expect(S.promptBody(s)).toMatch(/^turn\(1\):attack\(team \d, mech \w+\)$/);

    const actor = S.currentActor(s)!.id;
    const enemy = actor === "hunchy" ? "cicada" : "hunchy";
    expect(run(s, "weapons").join("\n")).toMatch(/#1 .+S\d+\/M\d+\/L\d+/);

    const ammoBefore = actor === "hunchy" ? (s.battle!.units.hunchy!.ammoLeft[1] ?? 0) : null;
    expect(run(s, `fire ${enemy} 1`).join("\n")).toContain("queued");
    expect(run(s, `fire ${enemy} 1`)[0]).toMatch(
      /error: Weapon #1 may only be declared once per turn/,
    );
    expect(run(s, `fire ${actor} 2`)[0]).toMatch(/^error: Target must belong to another team/);
    expect(run(s, "status").join("\n")).toContain(`-> ${enemy}`);
    // First unit declares; no resolution yet (sweep at phase end).
    run(s, "done");
    // Second unit declares and triggers resolution sweep at phase end.
    const actor2 = S.currentActor(s)!.id;
    expect(run(s, "weapons").join("\n")).toMatch(/#1 .+S\d+\/M\d+\/L\d+/);
    expect(run(s, `fire ${actor} 1`).join("\n")).toContain("queued");
    const out = run(s, "done").join("\n");
    expect(out).toMatch(new RegExp(`${actor2} fires at ${actor}`));
    expect(out).toMatch(/-> (HIT|MISS|auto-hit)/);
    expect(out).toMatch(/=== resolving declared attacks ===/);
    expect(out).toMatch(/=== attack damage resolved ===/);
    if (ammoBefore !== null) {
      expect(s.battle!.units.hunchy!.ammoLeft[1]).toBe(ammoBefore - 1);
    }
  });
});

describe("full game", () => {
  it("plays to victory, emits a banner once, and supports rematch/reset", () => {
    const s = freshSetup();
    run(s, "start");
    let sawBanner = false;
    for (let i = 0; i < 500 && s.app === "battle"; i++) {
      const st = s.battle!;
      const actorId = S.currentActor(s)!.id;
      const ids = Object.values(st.units)
        .filter((u) => !u.removed)
        .map((u) => u.id);
      const enemy = ids.find((id) => id !== actorId)!;
      let out: string[];
      if (st.phase === "movement") {
        run(s, "mode walk");
        out = run(s, "done");
      } else {
        const unit = st.units[actorId]!;
        const def = getMechDef(unit.model)!;
        Object.entries(def.weapons).forEach(([key, mount]) => {
          const weaponIndex = Number(key);
          if (unit.jammedWeapons.includes(weaponIndex)) return;
          if (!canFireFromLocation(unit.phaseStartDamage, mount.location)) return;
          if (unit.ammoLeft[weaponIndex] !== undefined && (unit.ammoLeft[weaponIndex] ?? 0) < 1)
            return;
          run(s, `fire ${enemy} ${weaponIndex}`);
        });
        out = run(s, "done");
      }
      if (out.some((l) => l.startsWith("=== TEAM") || l.startsWith("=== DRAW"))) {
        expect(sawBanner).toBe(false);
        sawBanner = true;
      }
    }
    expect(s.app).toBe("over");
    expect(sawBanner).toBe(true);
    expect(S.promptBody(s)).toMatch(/^over\(.*won, total turn \d+\)$/);
    expect(run(s, "fire 1 x")[0]).toMatch(/error: unknown command 'fire'/);

    run(s, "rematch");
    expect(s.app).toBe("battle");
    expect(s.victory).toBeNull();

    run(s, "reset");
    expect(s.app).toBe("setup");
    expect(s.roster).toHaveLength(0);
    expect(s.mapName).toBeNull();
  });
});

describe("seed", () => {
  it("replays identically for the same seed", () => {
    const transcript = (): string[] => {
      const s = S.newSession(7);
      s.critsDisabled = true;
      run(s, "map beginner");
      run(s, "add hunchy HBK-4G 0 4 9 9 n");
      run(s, "add cicada CDA-3MA 1 4 9 8 s");
      run(s, "start");
      autoPlay(s);
      return s.battle!.events.flatMap((e) =>
        e.kind === "attackResolved"
          ? [`${e.unitId}:${e.resolution.weapon}:${e.resolution.toHitRoll}:${e.resolution.hit}`]
          : [],
      );
    };
    expect(transcript()).toEqual(transcript());
  });
});
