import { FACINGS, listMapNames, VERSION } from "btlib10x";
import type { Chunk } from "./format.js";
import {
  ammoPolicyLabel,
  attackStatusLines,
  boardChunk,
  buildLinesChunk,
  fireSuggestionLines,
  fmtLog,
  fmtSetupStatus,
  infoMapChunks,
  infoMapList,
  infoMechChunk,
  infoMechList,
  infoWeapon,
  infoWeaponList,
  moveStatusLines,
  overStatusLines,
  reachChunk,
  sheetForUnit,
  unitBriefList,
  weaponsLines,
} from "./format.js";
import type { LocaleId, MessageKey } from "./i18n/index.js";
import { i18n, isLocale, localeList } from "./i18n/index.js";
import { canonicalMapName, lookupMap } from "./lookup.js";
import * as S from "./session.js";

export interface CmdDef {
  /** Catalog key of the one-line description. */
  readonly helpKey: MessageKey;
  /** Full invocation form including arguments (locale-neutral syntax). */
  readonly usage?: string;
  /** Per-argument documentation shown by `help <command>` ([pattern, catalog key]). */
  readonly argsDoc?: ReadonlyArray<readonly [string, MessageKey]>;
  /** Plain lines, or an array of {@link Chunk}s for structured output. */
  run: (session: S.Session, args: string[]) => string[] | Chunk[];
}

// ------------------------------------------------------------- parsing ----

function int(locale: LocaleId, value: string, label: string): number {
  const n = Number(value);
  if (!Number.isInteger(n)) throw new Error(i18n(locale, "err.notInteger", { label }));
  return n;
}

/** User-facing 1-based coordinate -> engine coordinate. */
function coord(locale: LocaleId, value: string, label: string): number {
  const n = int(locale, value, label);
  if (n < 1) throw new Error(i18n(locale, "err.oneBased", { label }));
  return n;
}

function expectArgs(locale: LocaleId, args: readonly string[], count: number, usage: string): void {
  if (args.length < count) throw new Error(i18n(locale, "err.expectedArgs", { usage }));
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
          i18n(L(s), "lang.current", { locale: s.locale }),
          i18n(L(s), "lang.available", { list: localeList() }),
        ];
      }
      if (!isLocale(a[0]))
        throw new Error(i18n(L(s), "err.unknownLocale", { name: a[0], list: localeList() }));
      s.locale = a[0];
      return [i18n(s.locale, "lang.set", { locale: s.locale })];
    },
  },
  board: {
    helpKey: "cmd.board.help",
    run: (s) => [boardChunk(s)],
  },
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
    usage: "info mech [model] | info map [name] | info weapon [name]",
    argsDoc: [
      ["mech [model]", "cmd.info.arg.mech"],
      ["map [name]", "cmd.info.arg.map"],
      ["weapon [name]", "cmd.info.arg.weapon"],
    ],
    run: (s, a) => {
      expectArgs(L(s), a, 1, "info mech [model] | info map [name] | info weapon [name]");
      const what = a[0]!.toLowerCase();
      if (what === "mech")
        return a[1] !== undefined ? infoMechChunk(L(s), a[1]) : [infoMechList(L(s))];
      if (what === "map") {
        return a[1] !== undefined ? infoMapChunks(L(s), a[1]) : infoMapList();
      }
      if (what === "weapon") {
        const name = a.slice(1).join(" ");
        return name ? infoWeapon(L(s), name) : infoWeaponList(L(s));
      }
      throw new Error(
        i18n(L(s), "err.expectedArgs", {
          usage: "info mech [model] | info map [name] | info weapon [name]",
        }),
      );
    },
  },
  seed: {
    helpKey: "cmd.seed.help",
    usage: "seed <n>",
    argsDoc: [["n", "cmd.seed.arg.n"]],
    run: (s, a) => {
      expectArgs(L(s), a, 1, "seed <n>");
      S.setSeed(s, int(L(s), a[0]!, "seed"));
      return [i18n(L(s), "ok.seedSet", { seed: s.seed })];
    },
  },
  reset: {
    helpKey: "cmd.reset.help",
    run: (s) => {
      S.resetSession(s);
      return [i18n(s.locale, "ok.resetDone")];
    },
  },
  ver: {
    helpKey: "cmd.ver.help",
    run: (s) => [i18n(L(s), "version.line", { version: VERSION })],
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
      const name = a[0]!;
      const canonical = canonicalMapName(name);
      if (!canonical) {
        throw new Error(
          i18n(s.locale, "err.unknownMap", { name, list: listMapNames().join(", ") }),
        );
      }
      const m = lookupMap(canonical);
      S.setMap(s, name);
      return [
        i18n(L(s), "ok.mapLoaded", {
          name: canonical,
          w: m?.width ?? 0,
          h: m?.height ?? 0,
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
      if (!facing) throw new Error(i18n(L(s), "err.faceArg", { facings: FACINGS.join("/") }));
      const wantModel = a[1]!.toUpperCase();
      S.addUnit(
        s,
        a[0]!,
        wantModel,
        int(L(s), a[2]!, "team"),
        int(L(s), a[3]!, "gunnery"),
        { col: coord(L(s), a[4]!, "col"), row: coord(L(s), a[5]!, "row") },
        facing,
      );
      return [
        i18n(L(s), "ok.added", { id: a[0]!, model: wantModel, col: a[4]!, row: a[5]!, facing }),
      ];
    },
  },
  rm: {
    helpKey: "cmd.rm.help",
    usage: "rm <id>",
    argsDoc: [["id", "cmd.rm.arg.id"]],
    run: (s, a) => {
      expectArgs(L(s), a, 1, "rm <id>");
      S.removeUnit(s, a[0]!);
      return [i18n(L(s), "ok.removed", { id: a[0]! })];
    },
  },
  status: { helpKey: "cmd.statusSetup.help", run: (s) => fmtSetupStatus(s) },
  start: {
    helpKey: "cmd.start.help",
    run: (s) => {
      S.startBattle(s);
      return [i18n(s.locale, "ok.started"), ...initiativeLine(s)];
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
      const r = S.stepResult(s);
      const lines = [
        i18n(L(s), "ok.modeDeclared", { id: s.actorId ?? "", mode, budget: r.mpBudget }),
      ];
      if (mode === "standStill") return lines;
      const chunk = reachChunk(s);
      if (chunk === null) return lines;
      return [buildLinesChunk(lines), chunk];
    },
  },
  move: {
    helpKey: "cmd.move.help",
    usage: "move <col> <row>",
    argsDoc: [["col row", "cmd.move.arg.colrow"]],
    run: (s, a) => {
      expectArgs(L(s), a, 2, "move <col> <row>");
      S.queueEnter(s, { col: coord(L(s), a[0]!, "col"), row: coord(L(s), a[1]!, "row") });
      const r = S.stepResult(s);
      const col = r.position.col;
      const row = r.position.row;
      return [
        i18n(L(s), "ok.stepResult", {
          id: s.actorId ?? "",
          mode: s.moveMode ?? "",
          col,
          row,
          facing: r.facing,
          spent: r.mpSpent,
          budget: r.mpBudget,
        }),
      ];
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
      const r = S.stepResult(s);
      const col = r.position.col;
      const row = r.position.row;
      return [
        i18n(L(s), "ok.stepResult", {
          id: s.actorId ?? "",
          mode: s.moveMode ?? "",
          col,
          row,
          facing: r.facing,
          spent: r.mpSpent,
          budget: r.mpBudget,
        }),
      ];
    },
  },
  sheet: {
    helpKey: "cmd.sheetActing.help",
    usage: "sheet [id]",
    argsDoc: [["id", "cmd.sheetActing.arg.id"]],
    run: (s, a) => (a[0] !== undefined ? sheetForUnit(s, a[0]) : unitBriefList(s)),
  },
  status: { helpKey: "cmd.statusMove.help", run: (s) => moveStatusLines(s) },
  cancel: {
    helpKey: "cmd.cancelMove.help",
    run: (s) => {
      S.cancelMove(s);
      return [i18n(s.locale, "ok.cancelled")];
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
  ammo: {
    helpKey: "cmd.ammo.help",
    usage: "ammo [policy]",
    argsDoc: [["policy", "cmd.ammo.arg.policy"]],
    run: (s, a) => {
      const unit = S.currentActor(s);
      if (!unit) throw new Error(i18n(L(s), "err.needsActor"));
      if (a[0] === undefined) {
        return [i18n(L(s), "ammo.current", { policy: ammoPolicyLabel(L(s), unit.ammoPolicy) })];
      }
      S.setAmmoPolicy(s, a[0]);
      return [
        i18n(L(s), "ammo.set", { id: unit.id, policy: ammoPolicyLabel(L(s), unit.ammoPolicy) }),
      ];
    },
  },
  fire: {
    helpKey: "cmd.fire.help",
    usage: "fire <targetId> <weapon> [<weapon> ...]",
    argsDoc: [
      ["targetId", "cmd.fire.arg.targetId"],
      ["weapon", "cmd.fire.arg.weaponIndex"],
    ],
    run: (s, a) => {
      expectArgs(L(s), a, 2, "fire <targetId> <weapon> [<weapon> ...]");
      const targetId = a[0]!;
      const weapons = a.slice(1).map((w) => int(L(s), w, "weapon"));
      for (const weaponIndex of weapons) {
        S.queueFire(s, { weaponIndex, targetId });
      }
      return [
        i18n(L(s), "ok.fireQueuedBatch", {
          target: targetId,
          weapons: weapons.join(", "),
        }),
      ];
    },
  },
  sheet: {
    helpKey: "cmd.sheetActing.help",
    usage: "sheet [id]",
    argsDoc: [["id", "cmd.sheetActing.arg.id"]],
    run: (s, a) => (a[0] !== undefined ? sheetForUnit(s, a[0]) : unitBriefList(s)),
  },
  status: { helpKey: "cmd.statusAttack.help", run: (s) => attackStatusLines(s) },
  cancel: {
    helpKey: "cmd.cancelFire.help",
    run: (s) => {
      S.cancelFire(s);
      return [i18n(s.locale, "ok.cancelled")];
    },
  },
  done: {
    helpKey: "cmd.doneFire.help",
    run: (s) => {
      if (s.fireDecls.length === 0) {
        const unit = S.currentActor(s);
        const result = S.passFire(s);
        const passLine = unit ? i18n(s.locale, "log.attacksPassed", { id: unit.id }) : "";
        const rest = fmtLog(s.locale, result.newEvents);
        return passLine ? [passLine, ...rest] : rest;
      }
      return fmtLog(s.locale, S.commitFire(s).newEvents);
    },
  },
};

// ----------------------------------------------------------------- over ----

const OVER_CMDS: Record<string, CmdDef> = {
  sheet: {
    helpKey: "cmd.sheetActing.help",
    usage: "sheet [id]",
    argsDoc: [["id", "cmd.sheetActing.arg.id"]],
    run: (s, a) => (a[0] !== undefined ? sheetForUnit(s, a[0]) : unitBriefList(s)),
  },
  status: { helpKey: "cmd.statusOver.help", run: (s) => overStatusLines(s) },
  rematch: {
    helpKey: "cmd.rematch.help",
    run: (s) => {
      S.rematch(s);
      return [i18n(s.locale, "ok.rematchDone"), ...initiativeLine(s)];
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
  if (!def) throw new Error(i18n(locale, "err.unknownCommand", { name }));
  const names = listMapNames().join("|");
  const lines = [
    def.usage !== undefined
      ? `${i18n(locale, "help.usagePrefix")}${def.usage}`
      : name.toLowerCase(),
  ];
  lines.push(i18n(locale, def.helpKey).replace(/\{names\}/g, names));
  if (def.argsDoc !== undefined && def.argsDoc.length > 0) {
    lines.push(i18n(locale, "help.argumentsHeader"));
    for (const [arg, desc] of def.argsDoc)
      lines.push(`  ${arg.padEnd(12)} ${i18n(locale, desc).replace(/\{names\}/g, names)}`);
  }
  return lines;
}

function commandList(session: S.Session): string[] {
  const locale = session.locale;
  const names = listMapNames().join("|");

  const globalEntries = Object.keys(GLOBAL_CMDS)
    .sort()
    .map((name) => ({ name, def: GLOBAL_CMDS[name]! }));

  const phaseCmds = (() => {
    switch (session.app) {
      case "setup":
        return { cmds: SETUP_CMDS, phase: "setup" as const };
      case "battle": {
        const phase = session.battle?.phase === "weaponAttack" ? "weaponAttack" : "movement";
        return { cmds: phase === "weaponAttack" ? ATTACK_CMDS : MOVE_CMDS, phase };
      }
      case "over":
        return { cmds: OVER_CMDS, phase: "over" as const };
    }
  })();
  const phaseEntries = Object.keys(phaseCmds.cmds)
    .sort()
    .map((name) => ({ name, def: phaseCmds.cmds[name]! }));

  const lines: string[] = [];

  const renderEntries = (entries: { name: string; def: CmdDef }[]) => {
    for (const { name, def } of entries) {
      const help = i18n(locale, def.helpKey).replace(/\{names\}/g, names);
      if (def.usage === undefined) {
        lines.push(`${name.padEnd(9)} ${help}`);
      } else {
        lines.push(`${name.padEnd(9)} ${def.usage}`);
        lines.push(`          ${help}`);
      }
    }
  };

  lines.push(i18n(locale, "help.sectionGeneral"));
  renderEntries(globalEntries);
  lines.push("");
  lines.push(i18n(locale, "help.sectionPhase", { phase: phaseCmds.phase }));
  renderEntries(phaseEntries);

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
  return i18n(s.locale, key).split("\n");
}
function helpText(session: S.Session): string[] {
  return [...stateHint(session), "", ...commandList(session)];
}

function victoryBanner(s: S.Session): string[] {
  if (s.victory === null) return [];
  return s.victory.draw
    ? [i18n(s.locale, "banner.draw")]
    : [i18n(s.locale, "banner.win", { team: String(s.victory.winnerTeam) })];
}

function normalize(out: string[] | Chunk[]): Chunk[] {
  if (out.length === 0) return out as Chunk[];
  return typeof out[0] === "string" ? [buildLinesChunk(out as string[])] : (out as Chunk[]);
}

/** Turn-qualified key identifying the acting unit's fire turn, or null when none. */
function fireHintKey(s: S.Session): string | null {
  if (s.app !== "battle" || s.battle === null || s.battle.phase !== "weaponAttack") return null;
  const actor = S.currentActor(s);
  if (actor === null) return null;
  return `${s.battle.turn}:${actor.id}`;
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
    if (!def) throw new Error(i18n(session.locale, "err.unknownCommand", { name: tokens[0]! }));
    chunks = normalize(def.run(session, tokens.slice(1)));
  } catch (e) {
    return [
      buildLinesChunk(
        [`${i18n(session.locale, "err.prefix")} ${e instanceof Error ? e.message : String(e)}`],
        "err",
      ),
    ];
  }
  if (!wasOver && session.app === "over") {
    chunks = [...chunks, buildLinesChunk(victoryBanner(session), "banner")];
  }
  const hintKey = fireHintKey(session);
  if (hintKey !== null && hintKey !== session.fireHintShownFor) {
    chunks = [...chunks, ...fireSuggestionLines(session)];
    session.fireHintShownFor = hintKey;
  }
  return chunks;
}
