import { FACINGS } from "../src/core/types.js";
import { MAP_DEFS } from "../src/data/index.js";
import type { AttackDecl } from "../src/rules/game.js";
import type { Chunk, RichOutput } from "./format.js";
import {
  attackStatusLines,
  boardChunk,
  fmtLog,
  fmtSetupStatus,
  infoMapChunks,
  infoMapList,
  infoMech,
  infoMechList,
  moveStatusLines,
  rich,
  sheetForUnit,
  weaponsLines,
} from "./format.js";
import type { LocaleId, MessageKey } from "./i18n/index.js";
import { isLocale, localeList, t } from "./i18n/index.js";
import * as S from "./session.js";

export interface CmdDef {
  /** Catalog key of the one-line description. */
  readonly helpKey: MessageKey;
  /** Full invocation form including arguments (locale-neutral syntax). */
  readonly usage?: string;
  /** Per-argument documentation shown by `help <command>` ([pattern, catalog key]). */
  readonly argsDoc?: ReadonlyArray<readonly [string, MessageKey]>;
  /** Plain lines, or `{ rich }` for structured chunks (styled boards). */
  run: (session: S.Session, args: string[]) => string[] | RichOutput;
}

// ------------------------------------------------------------- parsing ----

function int(locale: LocaleId, value: string, label: string): number {
  const n = Number(value);
  if (!Number.isInteger(n)) throw new Error(t(locale, "err.notInteger", { label }));
  return n;
}

/** User-facing 1-based coordinate -> engine coordinate. */
function coord(locale: LocaleId, value: string, label: string): number {
  const n = int(locale, value, label);
  if (n < 1) throw new Error(t(locale, "err.oneBased", { label }));
  return n - 1;
}

function expectArgs(locale: LocaleId, args: readonly string[], count: number, usage: string): void {
  if (args.length < count) throw new Error(t(locale, "err.expectedArgs", { usage }));
}

const L = (s: S.Session): LocaleId => s.locale;

// ------------------------------------------------------------- globals ----

const GLOBAL_CMDS: Record<string, CmdDef> = {
  help: {
    helpKey: "cmd.help.help",
    run: (s, a) => (a[0] !== undefined ? commandHelp(s, a[0]) : helpText(s)),
  },
  "?": {
    helpKey: "cmd.q.help",
    run: (s, a) => (a[0] !== undefined ? commandHelp(s, a[0]) : helpText(s)),
  },
  lang: {
    helpKey: "cmd.lang.help",
    usage: "lang [<locale>]",
    argsDoc: [["locale", "cmd.lang.arg.locale"]],
    run: (s, a) => {
      if (a[0] === undefined) {
        return [
          t(L(s), "lang.current", { locale: s.locale }),
          t(L(s), "lang.available", { list: localeList() }),
        ];
      }
      if (!isLocale(a[0]))
        throw new Error(t(L(s), "err.unknownLocale", { name: a[0], list: localeList() }));
      s.locale = a[0];
      return [t(s.locale, "lang.set", { locale: s.locale })];
    },
  },
  board: { helpKey: "cmd.board.help", run: (s) => rich(boardChunk(s)) },
  clear: { helpKey: "cmd.clear.help", run: () => ["\f"] },
  log: {
    helpKey: "cmd.log.help",
    usage: "log [n]",
    argsDoc: [["n", "cmd.log.arg.n"]],
    run: (s, a) => {
      const n = a[0] !== undefined ? int(L(s), a[0], "n") : 10;
      return fmtLog(L(s), s.battle?.events ?? [], n);
    },
  },
  info: {
    helpKey: "cmd.info.help",
    usage: "info mech [model] | info map [name]",
    argsDoc: [
      ["mech [model]", "cmd.info.arg.mech"],
      ["map [name]", "cmd.info.arg.map"],
    ],
    run: (s, a) => {
      expectArgs(L(s), a, 1, "info mech [model] | info map [name]");
      const what = a[0]!.toLowerCase();
      if (what === "mech") return a[1] !== undefined ? infoMech(L(s), a[1]) : infoMechList(L(s));
      if (what === "map") {
        return a[1] !== undefined ? { rich: infoMapChunks(L(s), a[1]) } : infoMapList();
      }
      throw new Error(
        t(L(s), "err.expectedArgs", { usage: "info mech [model] | info map [name]" }),
      );
    },
  },
  sheet: {
    helpKey: "cmd.sheet.help",
    usage: "sheet <id>",
    argsDoc: [["id", "cmd.sheet.arg.id"]],
    run: (s, a) => {
      expectArgs(L(s), a, 1, "sheet <id>");
      return sheetForUnit(s, a[0]!);
    },
  },
  seed: {
    helpKey: "cmd.seed.help",
    usage: "seed <n>",
    argsDoc: [["n", "cmd.seed.arg.n"]],
    run: (s, a) => {
      expectArgs(L(s), a, 1, "seed <n>");
      S.setSeed(s, int(L(s), a[0]!, "seed"));
      return [t(L(s), "ok.seedSet", { seed: s.seed })];
    },
  },
  reset: {
    helpKey: "cmd.reset.help",
    run: (s) => {
      S.resetSession(s);
      return [t(s.locale, "ok.resetDone")];
    },
  },
};

// --------------------------------------------------------------- setup ----

const SETUP_CMDS: Record<string, CmdDef> = {
  map: {
    helpKey: "cmd.map.help",
    usage: "map <name>",
    argsDoc: [["name", "cmd.map.arg.name"]],
    run: (s, a) => {
      expectArgs(L(s), a, 1, "map <name>");
      S.setMap(s, a[0]!);
      const map = MAP_DEFS[a[0]!]!;
      return [
        t(L(s), "ok.mapLoaded", {
          name: a[0]!,
          w: map.width,
          h: map.height,
          n: s.terrainDefs.length,
        }),
      ];
    },
  },
  add: {
    helpKey: "cmd.add.help",
    usage: "add <id> <model> <team> <gunnery> <col> <row> [facing]",
    argsDoc: [
      ["id", "cmd.add.arg.id"],
      ["model", "cmd.add.arg.model"],
      ["team", "cmd.add.arg.team"],
      ["gunnery", "cmd.add.arg.gunnery"],
      ["col row", "cmd.add.arg.colrow"],
      ["facing", "cmd.add.arg.facing"],
    ],
    run: (s, a) => {
      expectArgs(L(s), a, 6, "add <id> <model> <team> <gunnery> <col> <row> [facing]");
      const facingWord = (a[6] ?? "n").toLowerCase();
      const facing = FACINGS.find((f) => f === facingWord);
      if (!facing) throw new Error(t(L(s), "err.faceArg", { facings: FACINGS.join("/") }));
      S.addUnit(
        s,
        a[0]!,
        a[1]!,
        int(L(s), a[2]!, "team"),
        int(L(s), a[3]!, "gunnery"),
        { col: coord(L(s), a[4]!, "col"), row: coord(L(s), a[5]!, "row") },
        facing,
      );
      return [t(L(s), "ok.added", { id: a[0]!, model: a[1]!, col: a[4]!, row: a[5]!, facing })];
    },
  },
  rm: {
    helpKey: "cmd.rm.help",
    usage: "rm <id>",
    argsDoc: [["id", "cmd.rm.arg.id"]],
    run: (s, a) => {
      expectArgs(L(s), a, 1, "rm <id>");
      S.removeUnit(s, a[0]!);
      return [t(L(s), "ok.removed", { id: a[0]! })];
    },
  },
  status: { helpKey: "cmd.statusSetup.help", run: (s) => fmtSetupStatus(s) },
  start: {
    helpKey: "cmd.start.help",
    run: (s) => {
      S.startBattle(s);
      return [t(s.locale, "ok.started"), ...initiativeLine(s)];
    },
  },
};

function initiativeLine(s: S.Session): string[] {
  const tail = (s.battle?.events ?? []).slice(-2);
  return fmtLog(
    s.locale,
    tail.filter((e) => e.kind === "initiative" || e.kind === "phase"),
  );
}

// ---------------------------------------------------------- turn:move ----

const MOVE_CMDS: Record<string, CmdDef> = {
  mode: {
    helpKey: "cmd.mode.help",
    usage: "mode <standstill|walk|run|jump>",
    argsDoc: [["mode", "cmd.mode.arg.mode"]],
    run: (s, a) => {
      expectArgs(L(s), a, 1, "mode standstill|walk|run|jump");
      const mode = S.parseMoveMode(L(s), a[0]!);
      S.declareMode(s, a[0]!);
      return [t(L(s), "ok.modeDeclared", { id: s.actorId ?? "", mode })];
    },
  },
  move: {
    helpKey: "cmd.move.help",
    usage: "move <col> <row>",
    argsDoc: [["col row", "cmd.move.arg.colrow"]],
    run: (s, a) => {
      expectArgs(L(s), a, 2, "move <col> <row>");
      S.queueEnter(s, { col: coord(L(s), a[0]!, "col"), row: coord(L(s), a[1]!, "row") });
      return [t(L(s), "ok.stepQueued", { col: a[0]!, row: a[1]! })];
    },
  },
  face: {
    helpKey: "cmd.face.help",
    usage: "face <n|ne|se|s|sw|nw|-5..5>",
    argsDoc: [["facing|steps", "cmd.face.arg.facingsteps"]],
    run: (s, a) => {
      expectArgs(L(s), a, 1, "face <facing|steps>");
      const unit = S.currentActor(s)!;
      const steps = S.faceSteps(L(s), unit.facing, a[0]!);
      S.queueTurn(s, steps);
      return [t(L(s), "ok.turnQueued", { steps: steps > 0 ? `+${steps}` : String(steps) })];
    },
  },
  sheet: { helpKey: "cmd.sheetActing.help", run: (s) => sheetForUnit(s, s.actorId ?? "") },
  status: { helpKey: "cmd.statusMove.help", run: (s) => moveStatusLines(s) },
  cancel: {
    helpKey: "cmd.cancelMove.help",
    run: (s) => {
      S.cancelMove(s);
      return [t(s.locale, "ok.cancelled")];
    },
  },
  done: {
    helpKey: "cmd.doneMove.help",
    run: (s) => fmtLog(s.locale, S.commitMove(s).newEvents),
  },
};

// -------------------------------------------------------- turn:attack ----

const ATTACK_CMDS: Record<string, CmdDef> = {
  weapons: {
    helpKey: "cmd.weapons.help",
    usage: "weapons [id]",
    argsDoc: [["id", "cmd.weapons.arg.id"]],
    run: (s, a) => weaponsLines(s, a[0]),
  },
  fire: {
    helpKey: "cmd.fire.help",
    usage: "fire <weapon> <targetId> [shots]",
    argsDoc: [
      ["weapon", "cmd.fire.arg.weaponIndex"],
      ["targetId", "cmd.fire.arg.targetId"],
      ["shots", "cmd.fire.arg.shots"],
    ],
    run: (s, a) => {
      expectArgs(L(s), a, 2, "fire <weapon> <targetId> [shots]");
      const weapon = int(L(s), a[0]!, "weapon");
      const weaponIndex = weapon - 1;
      const decl: AttackDecl =
        a[2] !== undefined
          ? { weaponIndex, targetId: a[1]!, shots: int(L(s), a[2], "shots") }
          : { weaponIndex, targetId: a[1]! };
      S.queueFire(s, decl);
      return [
        t(L(s), "ok.fireQueued", {
          index: weapon,
          target: decl.targetId,
          suffix: decl.shots !== undefined ? ` x${decl.shots}` : "",
        }),
      ];
    },
  },
  sheet: { helpKey: "cmd.sheetActing.help", run: (s) => sheetForUnit(s, s.actorId ?? "") },
  status: { helpKey: "cmd.statusAttack.help", run: (s) => attackStatusLines(s) },
  cancel: {
    helpKey: "cmd.cancelFire.help",
    run: (s) => {
      S.cancelFire(s);
      return [t(s.locale, "ok.cancelled")];
    },
  },
  done: {
    helpKey: "cmd.doneFire.help",
    run: (s) => fmtLog(s.locale, S.commitFire(s).newEvents),
  },
};

// ----------------------------------------------------------------- over ----

const OVER_CMDS: Record<string, CmdDef> = {
  rematch: {
    helpKey: "cmd.rematch.help",
    run: (s) => {
      S.rematch(s);
      return [t(s.locale, "ok.rematchDone"), ...initiativeLine(s)];
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
      return phase === "weaponAttack"
        ? { ...GLOBAL_CMDS, ...ATTACK_CMDS }
        : { ...GLOBAL_CMDS, ...MOVE_CMDS };
    }
    case "over":
      return { ...GLOBAL_CMDS, ...OVER_CMDS };
  }
}

/** Detailed single-command help: usage + argument explanations, no state hint. */
function commandHelp(session: S.Session, name: string): string[] {
  const locale = session.locale;
  const def = availableCmds(session)[name.toLowerCase()];
  if (!def) throw new Error(t(locale, "err.unknownCommand", { name }));
  const lines = [
    def.usage !== undefined ? `${t(locale, "help.usagePrefix")}${def.usage}` : name.toLowerCase(),
  ];
  lines.push(t(locale, def.helpKey));
  if (def.argsDoc !== undefined && def.argsDoc.length > 0) {
    lines.push(t(locale, "help.argumentsHeader"));
    for (const [arg, desc] of def.argsDoc) lines.push(`  ${arg.padEnd(12)} ${t(locale, desc)}`);
  }
  return lines;
}

function commandList(session: S.Session): string[] {
  const merged = availableCmds(session);
  const locale = session.locale;
  const lines: string[] = [];
  for (const name of Object.keys(merged).sort()) {
    const def = merged[name]!;
    const help = t(locale, def.helpKey);
    if (def.usage === undefined) {
      lines.push(`${name.padEnd(9)} ${help}`);
    } else {
      // Commands with arguments get their usage and explanation on separate lines.
      lines.push(`${name.padEnd(9)} ${def.usage}`);
      lines.push(`          ${help}`);
    }
  }
  return lines;
}

// ---------------------------------------------------------------- hints ----

/** Per-state guidance shown at the top of `help`, focused on legal commands. */
/** Per-state guidance shown at the top of `help`, focused on legal commands. */
const HINT_SETUP: MessageKey = "hint.setup";
const HINT_MOVE: MessageKey = "hint.move";
const HINT_ATTACK: MessageKey = "hint.attack";
const HINT_OVER: MessageKey = "hint.over";

/** Per-state guidance, focused on the commands legal right now. */
function stateHint(s: S.Session): string[] {
  const key =
    s.app === "battle"
      ? s.battle?.phase === "weaponAttack"
        ? HINT_ATTACK
        : HINT_MOVE
      : s.app === "over"
        ? HINT_OVER
        : HINT_SETUP;
  return t(s.locale, key).split("\n");
}
function helpText(session: S.Session): string[] {
  return [...stateHint(session), "", ...commandList(session)];
}

function victoryBanner(s: S.Session): string[] {
  if (s.victory === null) return [];
  return s.victory.draw
    ? [t(s.locale, "banner.draw")]
    : [t(s.locale, "banner.win", { team: String(s.victory.winnerTeam) })];
}

function normalize(out: string[] | RichOutput): Chunk[] {
  return typeof out === "object" && out !== null && "rich" in out
    ? [...out.rich]
    : [{ lines: out }];
}

/**
 * Run one input line against the session; returns presentation chunks
 * (plain text with a class hint, or styled board spans).
 */
export function runChunks(session: S.Session, raw: string): Chunk[] {
  const wasOver = session.app === "over";
  let chunks: Chunk[];
  try {
    const tokens = raw
      .trim()
      .split(/\s+/)
      .filter((x) => x.length > 0);
    if (tokens.length === 0) return [];
    const def = availableCmds(session)[tokens[0]!.toLowerCase()];
    if (!def) throw new Error(t(session.locale, "err.unknownCommand", { name: tokens[0]! }));
    chunks = normalize(def.run(session, tokens.slice(1)));
  } catch (e) {
    return [
      {
        lines: [`${t(session.locale, "err.prefix")} ${e instanceof Error ? e.message : String(e)}`],
        cls: "err",
      },
    ];
  }
  if (!wasOver && session.app === "over") {
    chunks = [...chunks, { lines: victoryBanner(session), cls: "banner" }];
  }
  return chunks;
}

/** Flat text of one chunk (boards contribute their visible characters). */
export function chunkText(chunk: Chunk): string[] {
  if ("board" in chunk) {
    return chunk.board.map((line) => line.map((sp) => sp.text).join(""));
  }
  return [...chunk.lines];
}

/** Run one input line against the session; returns plain output lines. */
export function execute(session: S.Session, raw: string): string[] {
  return runChunks(session, raw).flatMap(chunkText);
}
