import {
  FACINGS,
  getMechDefFor,
  getWeaponDefFor,
  hexDistance,
  isShutdown,
  listMapNames,
  sameHex,
  suggestFireTargets,
  VERSION,
} from "btlib10x";
import type { Chunk } from "./format.js";
import {
  ammoPolicyLabel,
  attackStatusLines,
  boardChunk,
  buildLinesChunk,
  F,
  fireSuggestionChunks,
  fmtSetupStatus,
  formatLog,
  heatStatusLines,
  infoMapChunks,
  infoMapList,
  infoMechChunk,
  infoMechList,
  infoWeapon,
  infoWeaponList,
  listTables,
  moveStatusLines,
  overStatusLines,
  PRN,
  queuedMoveLines,
  reachableChunk,
  reachablesInfo,
  renderClusterTable,
  renderCriticalTable,
  renderHeatScaleTable,
  renderHitLocationTables,
  sheetForUnit,
  stepResultFromLine,
  stepResultLines,
  unitBriefList,
} from "./format.js";
import type { LocaleId, MessageKey } from "./i18n/index.js";
import { i18n, isLocale, localeList } from "./i18n/index.js";
import { lookupMap } from "./lookup.js";
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

/** Command id argument: explicit unit id, else the acting unit when present. */
function idOrActor(s: S.Session, args: readonly string[]): string {
  if (args[0] !== undefined) return args[0];
  if (s.actorId !== null) return s.actorId;
  throw new Error(i18n(s.locale, "err.needsActor"));
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
      return formatLog(L(s), s.battle?.events ?? [], n);
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
  reset: {
    helpKey: "cmd.reset.help",
    run: (s) => {
      S.resetSession(s);
      return [buildLinesChunk([i18n(s.locale, "ok.resetDone")], "banner")];
    },
  },
  ver: {
    helpKey: "cmd.ver.help",
    run: (s) => [i18n(L(s), "version.line", { version: VERSION })],
  },
  table: {
    helpKey: "cmd.table.help",
    usage: "table [cluster|hitloc|crit|heat]",
    argsDoc: [["name", "cmd.table.arg.name"]],
    run: (s, a) => {
      const name = a[0]?.toLowerCase();
      const locale = L(s);
      if (!name) return listTables(locale);
      switch (name) {
        case "cluster":
          return renderClusterTable(locale);
        case "hitloc":
          return renderHitLocationTables(locale);
        case "crit":
          return renderCriticalTable(locale);
        case "heat":
          return renderHeatScaleTable(locale);
        default:
          throw new Error(i18n(locale, "err.unknownCommand", { name }));
      }
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
      const name = a[0]!;
      const m = lookupMap(name);
      if (m === undefined) {
        throw new Error(
          i18n(s.locale, "err.unknownMap", { name, list: listMapNames().join(", ") }),
        );
      }
      S.setMap(s, m);
      return [i18n(L(s), "ok.mapLoaded", { name: m.name, w: m.width, h: m.height })];
    },
  },
  add: {
    helpKey: "cmd.add.help",
    usage: "add <id> <model> <team> <gunnery> <col> <row> [facing|piloting] [piloting]",
    argsDoc: [
      ["id", "cmd.add.arg.id"],
      ["model", "cmd.add.arg.model"],
      ["team", "cmd.add.arg.team"],
      ["gunnery", "cmd.add.arg.gunnery"],
      ["col row", "cmd.add.arg.colrow"],
      ["facing", "cmd.add.arg.facing"],
      ["piloting", "cmd.add.arg.piloting"],
    ],
    run: (s, a) => {
      expectArgs(
        L(s),
        a,
        6,
        "add <id> <model> <team> <gunnery> <col> <row> [facing|piloting] [piloting]",
      );
      let facing = "n";
      let piloting = 5;
      for (const token of a.slice(6, 8)) {
        if (/^-?\d+$/.test(token)) {
          piloting = int(L(s), token, "piloting");
        } else {
          const f = FACINGS.find((x) => x === token.toLowerCase());
          if (!f) throw new Error(i18n(L(s), "err.faceArg", { facings: FACINGS.join("/") }));
          facing = f;
        }
      }
      const validModel = S.addUnit(
        s,
        a[0]!,
        a[1]!,
        int(L(s), a[2]!, "team"),
        int(L(s), a[3]!, "gunnery"),
        { col: coord(L(s), a[4]!, "col"), row: coord(L(s), a[5]!, "row") },
        facing as (typeof FACINGS)[number],
        piloting,
      );
      return [
        i18n(L(s), "ok.added", { id: a[0]!, model: validModel, col: a[4]!, row: a[5]!, facing }),
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
  seed: {
    helpKey: "cmd.seed.help",
    usage: "seed <n>",
    argsDoc: [["n", "cmd.seed.arg.n"]],
    run: (s, a) => {
      expectArgs(L(s), a, 1, "seed <n>");
      S.setSeed(s, int(L(s), a[0]!, "seed"));
      return [i18n(L(s), "ok.seedSet", { seed: s.setup.seed })];
    },
  },
  start: {
    helpKey: "cmd.start.help",
    run: (s) => {
      const newEvents = S.startBattle(s);
      return [
        buildLinesChunk([i18n(s.locale, "ok.started")], "banner"),
        buildLinesChunk(formatLog(s.locale, newEvents)),
      ];
    },
  },
};

// ---------------------------------------------------------- turn:move ----

/** In-battle maintenance/status commands shared by both battle phases. */
const BATTLE_CMDS: Record<string, CmdDef> = {
  heat: {
    helpKey: "cmd.heat.help",
    usage: "heat [id]",
    argsDoc: [["id", "cmd.heat.arg.id"]],
    run: (s, a) => heatStatusLines(s, idOrActor(s, a)),
  },
  sheet: {
    helpKey: "cmd.sheetActing.help",
    usage: "sheet [id]",
    argsDoc: [["id", "cmd.sheetActing.arg.id"]],
    run: (s, a) => (a[0] !== undefined ? sheetForUnit(s, a[0]) : unitBriefList(s)),
  },
};

const MOVE_CMDS: Record<string, CmdDef> = {
  candidate: {
    helpKey: "cmd.candidateMove.help",
    run: (s, _a) => {
      if (
        s.moveMode === null ||
        s.moveMode === "shutdown" ||
        s.moveMode === "startup" ||
        s.moveMode === "eject"
      ) {
        throw new Error(i18n(L(s), "err.candidate.movemode"));
      }
      const lines = queuedMoveLines(s);
      if (s.moveCandidate === null) {
        s.moveCandidate = reachablesInfo(s) ?? null;
      }
      if (s.moveCandidate === null) return lines;
      return [buildLinesChunk(lines), reachableChunk(s.setup, s.battle!, s.moveCandidate)];
    },
  },
  mode: {
    helpKey: "cmd.mode.help",
    usage: "mode <standstill|walk|run|jump|standup|drop|shutdown|startup|eject>",
    argsDoc: [["mode", "cmd.mode.arg.mode"]],
    run: (s, a) => {
      const locale = L(s);
      expectArgs(locale, a, 1, "mode standstill|walk|run|jump|standup|drop|shutdown|startup|eject");
      const mode = S.parseMoveMode(locale, a[0]!);
      S.declareMode(s, a[0]!);
      const actor = S.currentActor(s)!;
      if (
        mode === "shutdown" ||
        mode === "startup" ||
        mode === "eject" ||
        mode === "standup" ||
        mode === "drop"
      ) {
        s.moveCandidate = null;
        return [
          i18n(locale, "ok.modeDeclaredVoluntary", { id: actor.id, mode }),
          i18n(locale, "stepResult.from", {
            col: actor.position.col,
            row: actor.position.row,
            facing: F(locale, actor.facing),
            posture: PRN(locale, actor.prone),
          }),
        ];
      }
      const r = S.stepResult(s);
      const lines = [
        i18n(locale, "ok.modeDeclared", { id: actor.id, mode, budget: r.mpBudget }),
        stepResultFromLine(locale, r),
      ];
      if (mode === "standStill") {
        s.moveCandidate = null;
        return lines;
      }
      s.moveCandidate = reachablesInfo(s) ?? null;
      if (s.moveCandidate === null) return lines;
      return [buildLinesChunk(lines), reachableChunk(s.setup, s.battle!, s.moveCandidate)];
    },
  },
  place: {
    helpKey: "cmd.place.help",
    usage: "place <col> <row> <facing>",
    argsDoc: [["col row facing", "cmd.place.arg.colrowfacing"]],
    run: (s, a) => {
      expectArgs(L(s), a, 3, "place <col> <row> <facing>");
      const hex = {
        col: coord(L(s), a[0]!, "col"),
        row: coord(L(s), a[1]!, "row"),
      };
      const facing = S.resolveFacing(L(s), a[2]!);
      if (s.moveCandidate === null) {
        throw new Error(i18n(L(s), "err.place.noCandidate"));
      }
      const landing = s.moveCandidate.revealed.find(
        (l) => sameHex(l.hex, hex) && l.facing === facing,
      );
      if (!landing) {
        const hexReachable = s.moveCandidate.revealed.some((l) => sameHex(l.hex, hex));
        if (!hexReachable) {
          throw new Error(i18n(L(s), "err.place.unreachable", { col: hex.col, row: hex.row }));
        }
        throw new Error(i18n(L(s), "err.place.facing", { col: hex.col, row: hex.row, facing }));
      }
      const r = S.placeLanding(s, landing);
      return stepResultLines(s, r);
    },
  },
  status: { helpKey: "cmd.statusMove.help", run: (s) => moveStatusLines(s) },
  turn: {
    helpKey: "cmd.turn.help",
    usage: "turn <left|right>",
    argsDoc: [["dir", "cmd.turn.arg.dir"]],
    run: (s, a) => {
      expectArgs(L(s), a, 1, "turn <left|right>");
      S.queueProneTurn(s, a[0]!);
      const r = S.stepResult(s);
      return stepResultLines(s, r);
    },
  },
  cancel: {
    helpKey: "cmd.cancelMove.help",
    run: (s) => {
      S.cancelMove(s);
      return [i18n(s.locale, "ok.cancelled")];
    },
  },
  done: {
    helpKey: "cmd.doneMove.help",
    run: (s) => formatLog(s.locale, S.commitMove(s).newEvents),
  },
  ...BATTLE_CMDS,
};

// -------------------------------------------------------- turn:attack ----

const ATTACK_CMDS: Record<string, CmdDef> = {
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
  candidate: {
    helpKey: "cmd.candidateAttack.help",
    run: (s, _a) => {
      if (!checkFireHint(s)) throw new Error(i18n(L(s), "err.candidate.attack"));
      return fireSuggestionChunks(s.locale, s.fireCandidate!);
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
      const unit = S.currentActor(s);
      const battle = s.battle;
      if (!unit || !battle) {
        throw new Error(i18n(L(s), "err.wrongPhase", { phase: "weaponAttack" }));
      }
      const target = battle.units[targetId];
      if (!target) throw new Error(i18n(L(s), "err.unknownUnitId", { id: targetId }));
      const def = getMechDefFor(unit);
      const warnings: string[] = [];
      for (const weaponIndex of weapons) {
        const mount = def.weapons[weaponIndex];
        if (!mount) {
          throw new Error(
            i18n(L(s), "err.weaponIndex", { unit: unit.id, index: String(weaponIndex) }),
          );
        }
        const weapon = getWeaponDefFor(mount);
        const dist = hexDistance(unit.position, target.position);
        if (dist > weapon.long) {
          throw new Error(
            i18n(L(s), "err.overRange", {
              weapon: mount.weapon,
              dist: String(dist),
              max: String(weapon.long),
            }),
          );
        }
        if (weapon.minRange !== undefined && dist <= weapon.minRange) {
          warnings.push(
            i18n(L(s), "err.minRange", {
              weapon: mount.weapon,
              dist: String(dist),
              min: String(weapon.minRange),
              penalty: String(weapon.minRange - dist + 1),
            }),
          );
        }
        S.queueFire(s, { weaponIndex, targetId });
      }
      const lines = [
        i18n(L(s), "ok.fireQueuedBatch", {
          target: targetId,
          weapons: weapons.join(", "),
        }),
      ];
      return [...lines, ...warnings];
    },
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
        const rest = formatLog(s.locale, result.newEvents);
        return passLine ? [passLine, ...rest] : rest;
      }
      return formatLog(s.locale, S.commitFire(s).newEvents);
    },
  },
  ...BATTLE_CMDS,
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
      const newEvents = S.rematch(s);
      return [
        buildLinesChunk([i18n(s.locale, "ok.rematchDone")], "banner"),
        buildLinesChunk(formatLog(s.locale, newEvents)),
      ];
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
      if (phase === "weaponAttack") return { ...GLOBAL_CMDS, ...ATTACK_CMDS };
      if (phase !== "movement") return { ...GLOBAL_CMDS, ...MOVE_CMDS };
      const actor = S.currentActor(session);
      const down = actor !== null && isShutdown(actor);
      if (
        down ||
        session.moveMode === "shutdown" ||
        session.moveMode === "startup" ||
        session.moveMode === "standup" ||
        session.moveMode === "drop" ||
        session.moveMode === "proneTurn"
      ) {
        // Pending voluntary declaration: no hex movement.
        const { move: _move, face: _face, ...rest } = MOVE_CMDS;
        return { ...GLOBAL_CMDS, ...rest };
      }
      return { ...GLOBAL_CMDS, ...MOVE_CMDS };
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
    chunks.push(buildLinesChunk(victoryBanner(session), "banner"));
  }
  if (checkFireHint(session)) {
    chunks.push(...fireSuggestionChunks(session.locale, session.fireCandidate!));
  }
  return chunks;
}

function checkFireHint(s: S.Session): boolean {
  if (s.app !== "battle" || s.battle === null || s.battle.phase !== "weaponAttack") return false;
  const actor = S.currentActor(s);
  if (actor === null) return false;
  const newKey = `${s.battle.turn}:${actor.id}`;
  if (newKey !== s.fireHintShownFor || s.fireCandidate === null) {
    s.fireCandidate = suggestFireTargets(s.battle, actor.id);
    s.fireHintShownFor = newKey;
    return true;
  }

  return false;
}
