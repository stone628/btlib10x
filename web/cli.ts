import type { AttackDecl } from "../src/rules/game.js";
import { FACINGS } from "../src/core/types.js";
import { MAP_DEFS } from "../src/data/index.js";
import * as S from "./session.js";
import {
  attackStatusLines,
  boardLines,
  fmtLog,
  fmtSetupStatus,
  infoMap,
  infoMapList,
  infoMech,
  infoMechList,
  moveStatusLines,
  sheetForUnit,
  weaponsLines,
} from "./format.js";

export interface CmdDef {
  readonly help: string;
  /** Full invocation form including arguments; omit for argument-less commands. */
  readonly usage?: string;
  /** Per-argument documentation shown by `help <command>` ([pattern, description]). */
  readonly argsDoc?: ReadonlyArray<readonly [string, string]>;
  run: (session: S.Session, args: string[]) => string[];
}

// ------------------------------------------------------------- parsing ----

function int(value: string, label: string): number {
  const n = Number(value);
  if (!Number.isInteger(n)) throw new Error(`${label} must be an integer`);
  return n;
}

/** User-facing 1-based coordinate -> engine coordinate. */
function coord(value: string, label: string): number {
  const n = int(value, label);
  if (n < 1) throw new Error(`${label} is 1-based and must be >= 1`);
  return n - 1;
}

function expectArgs(args: readonly string[], count: number, usage: string): void {
  if (args.length < count) throw new Error(`usage: ${usage}`);
}

// ------------------------------------------------------------- globals ----

const GLOBAL_CMDS: Record<string, CmdDef> = {
  help: {
    help: "list commands for the current state, or detail one command",
    run: (s, a) => (a[0] !== undefined ? commandHelp(s, a[0]) : helpText(s)),
  },
  "?": {
    help: "alias for help",
    run: (s, a) => (a[0] !== undefined ? commandHelp(s, a[0]) : helpText(s)),
  },
  board: { help: "draw the ASCII battle grid", run: (s) => boardLines(s) },
  clear: { help: "clear the scrollback screen", run: () => ["\f"] },
  log: {
    help: "show last N events (default 10)",
    usage: "log [n]",
    argsDoc: [["n", "how many recent events to show (default 10)"]],
    run: (s, a) => {
      const n = a[0] !== undefined ? int(a[0], "n") : 10;
      return fmtLog(s.battle?.events ?? [], n);
    },
  },
  info: {
    help: "look up 'Mech models or bundled maps",
    usage: "info mech [model] | info map [name]",
    argsDoc: [
      ["mech [model]", "model key like HBK-4G; omit to list all models"],
      ["map [name]", "bundled map name; omit to list maps"],
    ],
    run: (_s, a) => {
      expectArgs(a, 1, "info mech [model] | info map [name]");
      const what = a[0]!.toLowerCase();
      if (what === "mech") return a[1] !== undefined ? infoMech(a[1]) : infoMechList();
      if (what === "map") return a[1] !== undefined ? infoMap(a[1]) : infoMapList();
      throw new Error("usage: info mech [model] | info map [name]");
    },
  },
  sheet: {
    help: "record sheet for a unit",
    usage: "sheet <id>",
    argsDoc: [["id", "unit id (placed unit in setup, any unit in battle)"]],
    run: (s, a) => {
      expectArgs(a, 1, "sheet <id>");
      return sheetForUnit(s, a[0]!);
    },
  },
  seed: {
    help: "set the dice seed",
    usage: "seed <n>",
    argsDoc: [["n", "integer seed; the same seed reproduces the same rolls"]],
    run: (s, a) => {
      expectArgs(a, 1, "seed <n>");
      S.setSeed(s, int(a[0]!, "seed"));
      return [`seed set to ${s.seed}`];
    },
  },
  reset: {
    help: "wipe everything back to empty setup",
    run: (s) => {
      S.resetSession(s);
      return ["reset."];
    },
  },
};

// --------------------------------------------------------------- setup ----

const SETUP_CMDS: Record<string, CmdDef> = {
  map: {
    help: "load a bundled rulebook map (beginner|quickstart)",
    usage: "map <name>",
    argsDoc: [["name", "bundled map name: beginner | quickstart"]],
    run: (s, a) => {
      expectArgs(a, 1, "map <name>");
      S.setMap(s, a[0]!);
      const map = MAP_DEFS[a[0]!]!;
      return [`map ${a[0]}: ${map.width}x${map.height}, ${s.terrainDefs.length} terrain hexes`];
    },
  },
  add: {
    help: "place a 'Mech on the map",
    usage: "add <id> <model> <team> <gunnery> <col> <row> [facing]",
    argsDoc: [
      ["id", "unique unit id used by later commands"],
      ["model", "'Mech model key, see 'info mech'"],
      ["team", "team number (0 or 1)"],
      ["gunnery", "pilot gunnery skill; lower is better"],
      ["col row", "target hex, 1-based, must be inside the map"],
      ["facing", "optional facing n|ne|se|s|sw|nw (default n)"],
    ],
    run: (s, a) => {
      expectArgs(a, 6, "add <id> <model> <team> <gunnery> <col> <row> [facing]");
      const facingWord = (a[6] ?? "n").toLowerCase();
      const facing = FACINGS.find((f) => f === facingWord);
      if (!facing) throw new Error(`facing must be one of ${FACINGS.join("/")}`);
      S.addUnit(
        s,
        a[0]!,
        a[1]!,
        int(a[2]!, "team"),
        int(a[3]!, "gunnery"),
        { col: coord(a[4]!, "col"), row: coord(a[5]!, "row") },
        facing,
      );
      return [`${a[0]} (${a[1]}) placed at (${a[4]},${a[5]}) facing ${facing}`];
    },
  },
  rm: {
    help: "remove a placed unit",
    usage: "rm <id>",
    argsDoc: [["id", "id of a previously added unit"]],
    run: (s, a) => {
      expectArgs(a, 1, "rm <id>");
      S.removeUnit(s, a[0]!);
      return [`removed ${a[0]}`];
    },
  },
  status: { help: "setup summary: units grouped by team, selected map", run: (s) => fmtSetupStatus(s) },
  start: {
    help: "start the battle (needs >=2 units on >=2 teams)",
    run: (s) => {
      S.startBattle(s);
      return ["battle started", ...initiativeLine(s)];
    },
  },
};

function initiativeLine(s: S.Session): string[] {
  const tail = (s.battle?.events ?? []).slice(-2);
  return fmtLog(tail.filter((e) => e.kind === "initiative" || e.kind === "phase"));
}

// ---------------------------------------------------------- turn:move ----

const MOVE_CMDS: Record<string, CmdDef> = {
  mode: {
    help: "declare movement mode",
    usage: "mode <standstill|walk|run|jump>",
    argsDoc: [["mode", "standstill | walk | run | jump; each has its own MP pool"]],
    run: (s, a) => {
      expectArgs(a, 1, "mode standstill|walk|run|jump");
      S.declareMode(s, a[0]!);
      return [`${s.actorId} declares ${S.parseMoveMode(a[0]!)}`];
    },
  },
  move: {
    help: "queue a step into an adjacent hex",
    usage: "move <col> <row>",
    argsDoc: [["col row", "adjacent destination hex, 1-based"]],
    run: (s, a) => {
      expectArgs(a, 2, "move <col> <row>");
      S.queueEnter(s, { col: coord(a[0]!, "col"), row: coord(a[1]!, "row") });
      return [`queued step to (${a[0]},${a[1]})`];
    },
  },
  face: {
    help: "queue a facing change",
    usage: "face <n|ne|se|s|sw|nw|-5..5>",
    argsDoc: [
      [
        "facing|steps",
        "absolute facing word, or relative turn of -5..5 hex sides; each side costs 1 MP",
      ],
    ],
    run: (s, a) => {
      expectArgs(a, 1, "face <facing|steps>");
      const unit = S.currentActor(s)!;
      const steps = S.faceSteps(unit.facing, a[0]!);
      S.queueTurn(s, steps);
      return [`queued facing change ${steps > 0 ? "+" : ""}${steps}`];
    },
  },
  sheet: { help: "record sheet of the acting 'Mech", run: (s) => sheetForUnit(s, s.actorId ?? "") },
  status: { help: "queued move steps with running MP cost per step", run: (s) => moveStatusLines(s) },
  cancel: { help: "clear mode and queued steps", run: (s) => (S.cancelMove(s), ["cancelled"]) },
  done: {
    help: "commit the declared move",
    run: (s) => fmtLog(S.commitMove(s).newEvents),
  },
};

// -------------------------------------------------------- turn:attack ----

const ATTACK_CMDS: Record<string, CmdDef> = {
  weapons: {
    help: "list a unit's weapons (default: acting unit)",
    usage: "weapons [id]",
    argsDoc: [["id", "unit to inspect; defaults to the acting unit"]],
    run: (s, a) => weaponsLines(s, a[0]),
  },
  fire: {
    help: "queue a weapon attack",
    usage: "fire <weaponIndex> <targetId> [shots]",
    argsDoc: [
      ["weaponIndex", "index from the 'weapons' listing"],
      ["targetId", "enemy unit id; all shots must share one target"],
      ["shots", "optional shot count for multi-shot weapons (SRM/LRM)"],
    ],
    run: (s, a) => {
      expectArgs(a, 2, "fire <weaponIndex> <targetId> [shots]");
      const decl: AttackDecl =
        a[2] !== undefined
          ? { weaponIndex: int(a[0]!, "weaponIndex"), targetId: a[1]!, shots: int(a[2], "shots") }
          : { weaponIndex: int(a[0]!, "weaponIndex"), targetId: a[1]! };
      S.queueFire(s, decl);
      return [
        `queued #${decl.weaponIndex} -> ${decl.targetId}${decl.shots !== undefined ? ` x${decl.shots}` : ""}`,
      ];
    },
  },
  sheet: { help: "record sheet of the acting 'Mech", run: (s) => sheetForUnit(s, s.actorId ?? "") },
  status: { help: "queued attack declarations", run: (s) => attackStatusLines(s) },
  cancel: { help: "clear queued shots", run: (s) => (S.cancelFire(s), ["cancelled"]) },
  done: {
    help: "declare attacks and resolve them",
    run: (s) => fmtLog(S.commitFire(s).newEvents),
  },
};

// ----------------------------------------------------------------- over ----

const OVER_CMDS: Record<string, CmdDef> = {
  rematch: {
    help: "new battle with the same roster, terrain and seed",
    run: (s) => {
      S.rematch(s);
      return ["rematch!", ...initiativeLine(s)];
    },
  },
};

// ------------------------------------------------------------ dispatch ----

function availableCmds(session: S.Session): Record<string, CmdDef> {
  switch (session.app) {
    case "setup":
      return { ...GLOBAL_CMDS, ...SETUP_CMDS };
    case "battle": {
      const phase = session.battle?.phase;
      return phase === "weaponAttack" ? { ...GLOBAL_CMDS, ...ATTACK_CMDS } : { ...GLOBAL_CMDS, ...MOVE_CMDS };
    }
    case "over":
      return { ...GLOBAL_CMDS, ...OVER_CMDS };
  }
}

/** Detailed single-command help: usage + argument explanations, no state hint. */
function commandHelp(session: S.Session, name: string): string[] {
  const def = availableCmds(session)[name.toLowerCase()];
  if (!def) throw new Error(`unknown command '${name}' (try 'help')`);
  const lines = [def.usage !== undefined ? `usage: ${def.usage}` : name.toLowerCase()];
  lines.push(def.help);
  if (def.argsDoc !== undefined && def.argsDoc.length > 0) {
    lines.push("arguments:");
    for (const [arg, desc] of def.argsDoc) lines.push(`  ${arg.padEnd(12)} ${desc}`);
  }
  return lines;
}

function commandList(session: S.Session): string[] {
  const merged = availableCmds(session);
  const lines: string[] = [];
  for (const name of Object.keys(merged).sort()) {
    const def = merged[name]!;
    if (def.usage === undefined) {
      lines.push(`${name.padEnd(9)} ${def.help}`);
    } else {
      // Commands with arguments get their usage and explanation on separate lines.
      lines.push(`${name.padEnd(9)} ${def.usage}`);
      lines.push(`          ${def.help}`);
    }
  }
  return lines;
}

// ---------------------------------------------------------------- hints ----

/** Per-state guidance shown at the top of `help`, focused on legal commands. */
const HINT_SETUP: readonly string[] = [
  "you are in 'setup' phase.",
  "load a battlefield via 'map' and place mechs via 'add'.",
  "review the roster via 'status', remove mistakes via 'rm', then begin with 'start'.",
];

const HINT_MOVE: readonly string[] = [
  "you are in the movement phase - the prompt shows whose turn it is.",
  "declare a speed via 'mode', then queue steps via 'move' or 'face'; check MP costs with 'status'.",
  "commit the move with 'done', or discard it with 'cancel'.",
];

const HINT_ATTACK: readonly string[] = [
  "you are in the weapon attack phase - the prompt shows who is firing.",
  "browse the acting unit's guns via 'weapons', then declare shots against one target via 'fire'.",
  "review the declaration with 'status', resolve with 'done', or discard it with 'cancel'.",
];

const HINT_OVER: readonly string[] = [
  "the battle is over.",
  "replay the same roster and seed with 'rematch', or return to an empty setup with 'reset'.",
];

/** Per-state guidance, focused on the commands legal right now. */
function stateHint(s: S.Session): string[] {
  switch (s.app) {
    case "setup":
      return [...HINT_SETUP];
    case "battle":
      return s.battle?.phase === "weaponAttack" ? [...HINT_ATTACK] : [...HINT_MOVE];
    case "over":
      return [...HINT_OVER];
  }
}
function helpText(session: S.Session): string[] {
  return [...stateHint(session), "", ...commandList(session)];
}

function victoryBanner(s: S.Session): string[] {
  if (s.victory === null) return [];
  return s.victory.draw
    ? ["=== DRAW - NO UNITS REMAIN ==="]
    : [`=== TEAM ${s.victory.winnerTeam} WINS ===`];
}

/** Run one input line against the session; returns output lines. */
export function execute(session: S.Session, raw: string): string[] {
  const wasOver = session.app === "over";
  let out: string[];
  try {
    const tokens = raw.trim().split(/\s+/).filter((t) => t.length > 0);
    if (tokens.length === 0) return [];
    const def = availableCmds(session)[tokens[0]!.toLowerCase()];
    if (!def) throw new Error(`unknown command '${tokens[0]}' (try 'help')`);
    out = def.run(session, tokens.slice(1));
  } catch (e) {
    return [`error: ${e instanceof Error ? e.message : String(e)}`];
  }
  if (!wasOver && session.app === "over") out = [...out, ...victoryBanner(session)];
  return out;
}
