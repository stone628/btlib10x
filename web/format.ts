import type {
  ArmorState,
  AttackResolution,
  BattleState,
  FireBlockerReason,
  FireWeapon,
  GameEvent,
  Location,
  MechDef,
  RangeBracket,
  UnitState,
} from "btlib10x";
import {
  canFireFromLocation,
  getMapDef,
  getWeapon,
  isImmobile,
  isKilled,
  LOCATIONS,
  MAP_DEFS,
  MECH_DEFS,
  suggestFireTargets,
  toEngineTerrain,
  WEAPONS,
} from "btlib10x";
import type { LocaleId, MessageKey } from "./i18n/index.js";
import { t } from "./i18n/index.js";
import type { BoardModel, BoardRenderer } from "./render.js";
import { battleModel, getBoardRenderer, mapModel } from "./render.js";
import type { Session, SetupUnit } from "./session.js";
import { moveStepsInfo } from "./session.js";

/** Board renderer type (re-exported from the render layer). */
export type { BoardRenderer } from "./render.js";

/** One presentation chunk of command output. */
export type Chunk =
  | { lines: readonly string[]; cls?: string }
  | { board: { readonly model: BoardModel; readonly renderer?: BoardRenderer } };

/** Tagged wrapper letting a command emit structured chunks. */
export interface RichOutput {
  readonly rich: readonly Chunk[];
}

interface BoardChunk {
  readonly board: { readonly model: BoardModel; readonly renderer?: BoardRenderer };
}

function boardChunkOf(model: BoardModel): BoardChunk["board"] {
  const r = getBoardRenderer("css-grid");
  return r !== undefined ? { model, renderer: r } : { model };
}

export function rich(...chunks: readonly Chunk[]): RichOutput {
  return { rich: chunks };
}

/** Display coordinates are 1-based (printed mapsheet labels). */
function disp(hex: { col: number; row: number }): string {
  return `${hex.col + 1},${hex.row + 1}`;
}

/**
 * Pilot rating for gunnery 0..7, rendered as `{name}({gunnery})` using the
 * standard experience bands: 0-1 elite, 2-3 veteran, 4-5 regular, 6-7 green.
 */
function gunneryLabel(locale: LocaleId, gunnery: number): string {
  const band =
    gunnery <= 1
      ? "skill.elite"
      : gunnery <= 3
        ? "skill.veteran"
        : gunnery <= 5
          ? "skill.regular"
          : "skill.green";
  return `${t(locale, band)}(${gunnery})`;
}

function mapDims(s: Session): [number, number] | undefined {
  if (!s.mapName) return undefined;
  const map = getMapDef(s.mapName);
  return map ? [map.width, map.height] : undefined;
}

/** `board` output: styled grid chunks, or a plain hint when nothing exists. */
export function boardChunk(s: Session): Chunk {
  const dims = mapDims(s);
  if (!s.battle) {
    if (!s.mapName && s.roster.length === 0) {
      return { lines: [t(s.locale, "board.noMap")] };
    }
    const units = Object.fromEntries(
      s.roster.map((u) => [
        u.id,
        { id: u.id, position: u.position, facing: u.facing, removed: false },
      ]),
    ) as BattleState["units"];
    const terrain: Record<string, string> = {};
    for (const t2 of s.terrainDefs) terrain[`${t2.col},${t2.row}`] = t2.type;
    const model = battleModel({
      units,
      terrain,
      width: dims?.[0],
      height: dims?.[1],
    } as BattleState);
    return { board: boardChunkOf(model) };
  }
  return { board: boardChunkOf(battleModel(s.battle)) };
}

// ---------------------------------------------------------------- info ----

export function infoMechList(locale: LocaleId): string[] {
  const list = Object.values(MECH_DEFS).sort((a, b) => a.model.localeCompare(b.model));
  const modelW = Math.max(
    ...list.map((d) => d.model.length),
    t(locale, "info.mechColModel").length,
  );
  const nameW = Math.max(...list.map((d) => d.name.length), t(locale, "info.mechColName").length);
  const classW = Math.max(
    ...list.map((d) => d.weightClass.length),
    t(locale, "info.mechColClass").length,
  );
  const tonW = Math.max(
    ...list.map((d) => String(d.tonnage).length),
    t(locale, "info.mechColTon").length,
  );
  const head =
    `${t(locale, "info.mechColModel").padEnd(modelW)}  ` +
    `${t(locale, "info.mechColName").padEnd(nameW)}  ` +
    `${t(locale, "info.mechColClass").padEnd(classW)}  ` +
    `${t(locale, "info.mechColTon").padStart(tonW)}  ` +
    t(locale, "info.mechColMove");
  const rows = list.map((d) => {
    const model = d.model.padEnd(modelW);
    const name = d.name.padEnd(nameW);
    const cls = d.weightClass.padEnd(classW);
    const ton = String(d.tonnage).padStart(tonW);
    const move = `${d.walking}/${d.running}/${d.jumping}`;
    return `${model}  ${name}  ${cls}  ${ton}  ${move}`;
  });
  return [head, ...rows];
}

export function infoMech(locale: LocaleId, model: string): string[] {
  const d = requireMechDef(model, locale);
  const topLines = [
    t(locale, "info.head", {
      model: d.model,
      name: d.name,
      weightClass: d.weightClass,
      tonnage: d.tonnage,
      techBase: d.techBase,
    }),
    t(locale, "info.movement", { walk: d.walking, run: d.running, jump: d.jumping }),
  ];
  const weaponLines = [
    t(locale, "sheet.weaponsHeader", { n: d.weapons.length }),
    ...weaponSummary(d),
  ];
  return mergeDiagram(
    topLines,
    weaponLines,
    armorDiagram({ armor: d.armor, originalArmor: d.armor }),
  );
}

export function infoMapList(): string[] {
  return Object.entries(MAP_DEFS).map(
    ([name, m]) => `${name}: ${m.width}x${m.height}, ${m.terrain.length} terrain hexes`,
  );
}

export function infoWeaponList(locale: LocaleId): string[] {
  const grouped = new Map<string, ReturnType<typeof Object.values>[0][]>();
  for (const w of Object.values(WEAPONS)) {
    const cat = weaponCategory(w.name);
    const list = grouped.get(cat) ?? [];
    list.push(w);
    grouped.set(cat, list);
  }
  const lines: string[] = [];
  for (const [cat, weapons] of grouped) {
    lines.push(t(locale, "info.weaponCategory", { category: cat }));
    for (const w of weapons) {
      lines.push(
        `  ${w.name.padEnd(20)} short ${String(w.short).padStart(2)}` +
          ` / medium ${String(w.medium).padStart(2)}` +
          ` / long ${String(w.long).padStart(2)}` +
          `   ${weaponDamageSummary(w)}`,
      );
    }
  }
  return lines;
}

export function infoWeapon(locale: LocaleId, name: string): string[] {
  const w = (() => {
    try {
      return getWeapon(name);
    } catch {
      throw new Error(
        t(locale, "err.unknownWeapon", { name, list: Object.keys(WEAPONS).join(", ") }),
      );
    }
  })();
  const cat = weaponCategory(w.name);
  const lines = [
    t(locale, "info.weaponHead", { name: w.name, category: cat }),
    t(locale, "info.weaponRange", { short: w.short, medium: w.medium, long: w.long }),
    t(locale, "info.weaponDamage", { damage: weaponDamageDetail(w) }),
  ];
  if (w.missiles !== undefined) lines.push(t(locale, "info.weaponMissiles", { count: w.missiles }));
  if (w.pulse) lines.push(t(locale, "info.weaponPulse"));
  if (w.rapidFireShots !== undefined)
    lines.push(t(locale, "info.weaponRapidFire", { shots: w.rapidFireShots }));
  if (w.antiInfantry) lines.push(t(locale, "info.weaponAntiInfantry"));
  return lines;
}

/** `info map <name>` output: header/legend lines followed by the styled grid. */
export function infoMapChunks(locale: LocaleId, name: string): Chunk[] {
  const map = MAP_DEFS[name];
  if (!map)
    throw new Error(t(locale, "err.unknownMap", { name, list: Object.keys(MAP_DEFS).join(", ") }));
  const counts = new Map<string, number>();
  for (const t2 of map.terrain) counts.set(t2.type, (counts.get(t2.type) ?? 0) + 1);
  const breakdown = [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([type, n]) => `${type} ${n}`)
    .join(", ");
  return [
    {
      lines: [
        t(locale, "info.mapHead", { name, w: map.width, h: map.height }),
        t(locale, "info.terrainLine", { breakdown: breakdown || t(locale, "info.terrainNone") }),
      ],
    },
    {
      board: boardChunkOf(mapModel(toEngineTerrain(map), map.width, map.height)),
    },
  ];
}

function requireMechDef(model: string, locale: LocaleId): MechDef {
  const def = MECH_DEFS[model];
  if (!def) throw new Error(t(locale, "err.unknownModel", { model }));
  return def;
}

// --------------------------------------------------------------- sheet ----

interface SheetView {
  readonly id: string;
  readonly model: string;
  readonly name: string;
  readonly weightClass: string;
  readonly tonnage: number;
  readonly gunnery: number | null;
  readonly removed: boolean;
  readonly positionLine: string;
  readonly modeLine: string | null;
  /** Current armor per location. */
  readonly armor: ArmorState;
  /** Designed armor per location (from the MechDef). */
  readonly originalArmor: Readonly<Record<Location, number>>;
  readonly mounts: readonly {
    readonly weapon: string;
    readonly location: Location;
    readonly ammoLeft: number | null;
    readonly jammed: boolean;
    readonly destroyed: boolean;
  }[];
}

function battleSheet(
  battle: BattleState,
  unit: UnitState,
  id: string,
  locale: LocaleId,
): SheetView {
  const def = battle.defs[unit.model]!;
  return {
    id,
    model: def.model,
    name: def.name,
    weightClass: def.weightClass,
    tonnage: def.tonnage,
    gunnery: unit.gunnery,
    removed: unit.removed,
    positionLine: t(locale, "sheet.at", { pos: disp(unit.position), facing: unit.facing }),
    modeLine:
      unit.moveMode !== null
        ? t(locale, "sheet.modeSuffix", { mode: unit.moveMode, mp: unit.mpSpent })
        : null,
    armor: unit.armor,
    originalArmor: def.armor,
    mounts: def.weapons.map((mount, i) => ({
      weapon: mount.weapon,
      location: mount.location,
      ammoLeft: mount.ammoShots !== undefined ? (unit.ammoLeft[i] ?? 0) : null,
      jammed: unit.jammedWeapons.includes(i),
      destroyed: !canFireFromLocation(unit.phaseStartArmor, mount.location),
    })),
  };
}

function setupSheet(unit: SetupUnit, id: string, locale: LocaleId): SheetView {
  const def = requireMechDef(unit.model, locale);
  return {
    id,
    model: def.model,
    name: def.name,
    weightClass: def.weightClass,
    tonnage: def.tonnage,
    gunnery: unit.gunnery,
    removed: false,
    positionLine: t(locale, "sheet.at", { pos: disp(unit.position), facing: unit.facing }),
    modeLine: null,
    armor: { ...def.armor } as ArmorState,
    originalArmor: def.armor,
    mounts: def.weapons.map((mount) => ({
      weapon: mount.weapon,
      location: mount.location,
      ammoLeft: mount.ammoShots ?? null,
      jammed: false,
      destroyed: false,
    })),
  };
}

const SHORT_LOC: Readonly<Record<Location, string>> = {
  head: "HD",
  centerTorso: "CT",
  rightTorso: "RT",
  leftTorso: "LT",
  rightArm: "RA",
  leftArm: "LA",
  rightLeg: "RL",
  leftLeg: "LL",
};

interface ArmorInfo {
  readonly armor: ArmorState;
  readonly originalArmor: Readonly<Record<Location, number>>;
}

/** ASCII humanoid armor diagram placed to the right of the sheet. */
function armorDiagram(info: ArmorInfo): string[] {
  const cell = (val: number, max: number, label: string) =>
    `${String(val).padStart(2)}/${String(max).padStart(2)}${label}`;
  const p = (n: number) => " ".repeat(n);
  const CT = 14,
    RT = 7,
    LT = 21;
  const { armor: a, originalArmor: o } = info;
  return [
    `${p(CT)}[ HD ]`,
    `${p(CT)}${cell(0, 0, "S")}`,
    `${p(CT)}${cell(a.head, o.head, "A")}`,
    `[ RA ] [ RT ] [ CT ] [ LT ] [ LA ]`,
    [cell(0, 0, "S"), cell(0, 0, "S"), cell(0, 0, "S"), cell(0, 0, "S"), cell(0, 0, "S")].join(" "),
    [
      cell(a.rightArm, o.rightArm, "A"),
      cell(a.rightTorso, o.rightTorso, "F"),
      cell(a.centerTorso, o.centerTorso, "F"),
      cell(a.leftTorso, o.leftTorso, "F"),
      cell(a.leftArm, o.leftArm, "A"),
    ].join(" "),
    `${p(RT)}${[cell(0, 0, "R"), cell(0, 0, "R"), cell(0, 0, "R")].join(" ")}`,
    `${p(RT)}[ RL ]${p(LT - RT - 6)}[ LL ]`,
    `${p(RT)}${[cell(0, 0, "S"), cell(0, 0, "S")].join(p(LT - RT - 6))}`,
    `${p(RT)}${[cell(a.rightLeg, o.rightLeg, "A"), cell(a.leftLeg, o.leftLeg, "A")].join(p(LT - RT - 6))}`,
  ];
}

/** Record sheet with armor status per location, side-by-side with ASCII diagram. */
export function sheetLines(view: SheetView, locale: LocaleId): string[] {
  const idLine = view.removed
    ? `${t(locale, "sheet.idLine", { id: view.id })}${t(locale, "sheet.removedId")}`
    : t(locale, "sheet.idLine", { id: view.id });
  const topLines = [idLine];
  topLines.push(
    t(locale, "sheet.modelLine", {
      model: view.model,
      name: view.name,
      weightClass: view.weightClass,
      tonnage: view.tonnage,
    }),
  );
  if (view.gunnery !== null) {
    topLines.push(t(locale, "sheet.gunneryLine", { gunnery: gunneryLabel(locale, view.gunnery) }));
  }
  topLines.push(view.positionLine);
  const weaponLines: string[] = [];
  weaponLines.push(t(locale, "sheet.weaponsHeader", { n: view.mounts.length }));
  for (const [i, m] of view.mounts.entries()) {
    const w = getWeapon(m.weapon);
    const flags = [
      m.ammoLeft !== null ? t(locale, "sheet.ammoFlag", { n: m.ammoLeft }) : null,
      m.jammed ? t(locale, "sheet.jammed") : null,
      m.destroyed ? t(locale, "sheet.destroyed") : null,
    ].filter((x) => x !== null);
    weaponLines.push(
      `  #${i + 1} ${m.weapon} (${SHORT_LOC[m.location]}) S${w.short}/M${w.medium}/L${w.long}${flags.length ? ` ${flags.join(" ")}` : ""}`,
    );
  }
  return mergeDiagram(topLines, weaponLines, armorDiagram(view));
}

function mergeDiagram(topLines: string[], weaponLines: string[], diagram: string[]): string[] {
  const dc = diagram.length;
  const leftMax = Math.max(...topLines.map((l) => l.length), ...weaponLines.map((l) => l.length));
  const blank = "".padEnd(leftMax);
  const leftRows = Array.from({ length: dc }, () => blank);
  for (let i = 0; i < topLines.length && i < dc; i++) leftRows[i] = topLines[i]!;
  const wStart = dc - weaponLines.length;
  for (let i = 0; i < weaponLines.length; i++) {
    const r = wStart + i;
    if (r >= 0 && r < dc) leftRows[r] = weaponLines[i]!;
  }
  return leftRows.map((l, i) => `${l.padEnd(leftMax)}  ${diagram[i]}`);
}

export function sheetForUnit(s: Session, id: string): string[] {
  if (s.battle) {
    const unit = s.battle.units[id];
    if (!unit) throw new Error(t(s.locale, "err.unknownUnitId", { id }));
    return sheetLines(battleSheet(s.battle, unit, id, s.locale), s.locale);
  }
  const placed = s.roster.find((u) => u.id === id);
  if (!placed) throw new Error(t(s.locale, "err.noSuchUnit", { id }));
  return sheetLines(setupSheet(placed, id, s.locale), s.locale);
}

/** Brief unit list grouped by team: id, model, position with facing. */
export function unitBriefList(s: Session): string[] {
  const battle = s.battle;
  if (!battle) return [];
  const lines: string[] = [];
  const teams = [...new Set(Object.values(battle.units).map((u) => u.team))].sort((a, b) => a - b);
  for (const team of teams) {
    lines.push(t(s.locale, "setup.teamHeader", { team }));
    for (const [uid, unit] of Object.entries(battle.units).filter(([, u]) => u.team === team)) {
      const def = battle.defs[unit.model]!;
      lines.push(`  ${uid}  ${def.model}  ${disp(unit.position)} facing ${unit.facing}`);
    }
  }
  return lines;
}

// -------------------------------------------------------------- status ----

export function fmtSetupStatus(s: Session): string[] {
  const lines: string[] = [
    t(s.locale, "setup.mapLabel", { name: s.mapName ?? t(s.locale, "setup.mapNone") }),
    t(s.locale, "setup.terrainCount", { n: s.terrainDefs.length }),
  ];
  const teams = [...new Set(s.roster.map((u) => u.team))].sort((a, b) => a - b);
  for (const team of teams) {
    lines.push(t(s.locale, "setup.teamHeader", { team }));
    for (const u of s.roster.filter((x) => x.team === team)) {
      const def = MECH_DEFS[u.model]!;
      lines.push(
        t(s.locale, "setup.unitLine", {
          id: u.id,
          model: u.model,
          name: def.name,
          gunnery: gunneryLabel(s.locale, u.gunnery),
          pos: disp(u.position),
          facing: u.facing,
        }),
      );
    }
  }
  if (teams.length === 0) lines.push(t(s.locale, "setup.noUnits"));
  return lines;
}

export function sheetLinesShort(view: SheetView, locale: LocaleId, showMode = true): string[] {
  const head = t(locale, "sheet.modelLine", {
    model: view.model,
    name: view.name,
    weightClass: view.weightClass,
    tonnage: view.tonnage,
  });
  const lines = [head];
  if (view.gunnery !== null) {
    lines.push(t(locale, "sheet.gunneryLine", { gunnery: gunneryLabel(locale, view.gunnery) }));
  }
  lines.push(view.positionLine);
  if (showMode && view.modeLine) lines.push(view.modeLine);
  lines.push(
    t(locale, "sheet.armorLine", {
      list: LOCATIONS.map((loc) => {
        const v = view.armor[loc];
        return `${SHORT_LOC[loc]} ${v}/${view.originalArmor[loc]}${v <= 0 ? "!" : ""}`;
      }).join(" | "),
    }),
  );
  return lines;
}

export function overStatusLines(s: Session): string[] {
  if (!s.battle || !s.victory) return [];
  const lines: string[] = [];
  const teams = [...new Set(Object.values(s.battle.units).map((u) => u.team))].sort(
    (a, b) => a - b,
  );
  for (const team of teams) {
    lines.push(t(s.locale, "setup.teamHeader", { team }));
    for (const [uid, unit] of Object.entries(s.battle.units).filter(([, u]) => u.team === team)) {
      const view = battleSheet(s.battle, unit, uid, s.locale);
      const idLine = view.removed
        ? `${t(s.locale, "sheet.idLine", { id: view.id })}${t(s.locale, "sheet.removedId")}`
        : t(s.locale, "sheet.idLine", { id: view.id });
      lines.push(`  ${idLine}`);
      for (const line of sheetLinesShort(view, s.locale, false)) lines.push(`  ${line}`);
    }
  }
  return lines;
}

export function moveStatusLines(s: Session): string[] {
  const info = moveStepsInfo(s);
  const modeText =
    info.mode === null
      ? t(s.locale, "moveStatus.noMode")
      : t(s.locale, "moveStatus.mode", { mode: info.mode });
  const lines = [modeText, t(s.locale, "moveStatus.budget", { budget: info.budget })];
  if (info.steps.length === 0) {
    lines.push(t(s.locale, "moveStatus.none"));
  } else {
    for (const step of info.steps) {
      lines.push(
        t(s.locale, "moveStatus.stepLine", {
          label: step.label,
          cost: step.mpCost,
          total: step.mpAfter,
        }),
      );
    }
  }
  return lines;
}

export function attackStatusLines(s: Session): string[] {
  const actor = s.battle?.units[s.actorId ?? ""];
  if (!actor || !s.battle)
    throw new Error(t(s.locale, "err.wrongPhase", { phase: "weaponAttack" }));
  if (s.fireDecls.length === 0) return [t(s.locale, "attackStatus.none")];
  const def = s.battle.defs[actor.model]!;
  return s.fireDecls.map((decl) => {
    const mount = def.weapons[decl.weaponIndex];
    const name = mount ? mount.weapon : `#${decl.weaponIndex + 1}`;
    return `#${decl.weaponIndex + 1} ${name} -> ${decl.targetId}${decl.shots !== undefined ? ` x${decl.shots}` : ""}`;
  });
}

const BRACKET_LABEL: Readonly<Record<RangeBracket, string>> = {
  short: "S",
  medium: "M",
  long: "L",
};

const BLOCKER_LABEL: Readonly<Record<FireBlockerReason, MessageKey>> = {
  jammed: "fireSuggestion.reason.jammed",
  destroyed: "fireSuggestion.reason.destroyed",
  outOfRange: "fireSuggestion.reason.outOfRange",
  outOfArc: "fireSuggestion.reason.outOfArc",
  noLos: "fireSuggestion.reason.noLos",
  outOfAmmo: "fireSuggestion.reason.outOfAmmo",
  autoMiss: "fireSuggestion.reason.autoMiss",
};

function fireWeaponLine(locale: LocaleId, w: FireWeapon): string {
  const bits = [
    `#${w.weaponIndex + 1} ${w.weapon} (${SHORT_LOC[w.location]}) [${BRACKET_LABEL[w.rangeBracket]}]`,
    `${t(locale, "fireSuggestion.tn")} ${w.tn}`,
    `${t(locale, "fireSuggestion.damage")} ${w.expectedDamage}`,
  ];
  if (w.cluster !== undefined) {
    bits.push(
      t(locale, "fireSuggestion.cluster", {
        shots: String(w.cluster.shots),
        per: String(w.cluster.perMissile),
      }),
    );
  }
  if (w.ammoShots !== null) {
    bits.push(`${t(locale, "fireSuggestion.ammo")} ${w.ammoShots}`);
  }
  return bits.join("  ");
}

/** Automatic hint shown at the start of a unit's fire turn. */
export function fireSuggestionLines(s: Session): string[] {
  const battle = s.battle;
  if (!battle || s.actorId === null) {
    throw new Error(t(s.locale, "err.wrongPhase", { phase: "weaponAttack" }));
  }
  const sugg = suggestFireTargets(battle, s.actorId);
  const lines = [t(s.locale, "fireSuggestion.header", { id: sugg.targetId })];
  if (sugg.targets.length === 0) {
    lines.push(t(s.locale, "fireSuggestion.noTargets"));
    return lines;
  }
  for (const target of sugg.targets) {
    lines.push(
      t(s.locale, "fireSuggestion.target", {
        id: target.targetId,
        distance: String(target.distance),
      }),
    );
    if (target.weapons.length === 0) {
      for (const b of target.blocked) {
        lines.push(
          `${t(s.locale, "fireSuggestion.blocked")}: #${b.weaponIndex + 1} ${b.weapon} — ${t(s.locale, BLOCKER_LABEL[b.reason])}`,
        );
      }
      continue;
    }
    for (const w of target.weapons) lines.push(fireWeaponLine(s.locale, w));
    if (target.blocked.length > 0) {
      for (const b of target.blocked) {
        lines.push(
          `${t(s.locale, "fireSuggestion.blocked")}: #${b.weaponIndex + 1} ${b.weapon} — ${t(s.locale, BLOCKER_LABEL[b.reason])}`,
        );
      }
    }
  }
  return lines;
}

export function weaponsLines(s: Session, unitId?: string): string[] {
  const id = unitId ?? s.actorId;
  const unit = id !== undefined && id !== null && id !== "" ? s.battle?.units[id] : undefined;
  if (!unit || !s.battle) {
    throw new Error(
      t(s.locale, "err.unknownUnitId", { id: unitId ?? t(s.locale, "weapons.noActorId") }),
    );
  }
  const def = s.battle.defs[unit.model]!;
  return def.weapons.map((mount, i) => {
    const w = getWeapon(mount.weapon);
    const bits = [
      `#${i + 1}`,
      mount.weapon,
      mount.location,
      `S${w.short}/M${w.medium}/L${w.long}`,
      mount.ammoShots !== undefined
        ? t(s.locale, "sheet.ammoFlag", { n: unit.ammoLeft[i] ?? 0 })
        : null,
      unit.jammedWeapons.includes(i) ? t(s.locale, "sheet.jammed") : null,
      canFireFromLocation(unit.phaseStartArmor, mount.location)
        ? null
        : t(s.locale, "sheet.destroyed"),
    ].filter((b) => b !== null);
    return bits.join("  ");
  });
}

// ------------------------------------------------------------------ log ----

export function fmtLog(
  locale: LocaleId,
  events: readonly GameEvent[],
  n: number = events.length,
): string[] {
  const slice = events.slice(-n);
  const lines: string[] = [];
  let prevKind: GameEvent["kind"] | null = null;
  let removedLines: string[] = [];
  for (let i = 0; i < slice.length; i++) {
    const e = slice[i]!;
    const currKind = e.kind;
    if (isAttacResolutionKind(e.kind)) {
      if (!isAttacResolutionKind(prevKind)) {
        lines.push(t(locale, "res.attackResolutionStart"));
      }
      if (currKind === "unitRemoved") {
        removedLines.push(...eventLines(locale, e));
      } else if (currKind === "attackResolved") {
        const resolvedLines = eventLines(locale, e);
        const unitPrefix = `[${e.unitId} -> ${e.targetId}] `;
        lines.push(unitPrefix + resolvedLines.shift());
        if (resolvedLines.length > 0) {
          const indent = " ".repeat(unitPrefix.length);
          lines.push(...resolvedLines.map((l) => indent + l));
        }
      } else {
        lines.push(...eventLines(locale, e));
      }
      if (!isAttacResolutionKind(getKindInBatch(i + 1, slice))) {
        lines.push(t(locale, "res.attackResolutionEnd"));
        if (removedLines.length > 0) {
          lines.push(...removedLines);
          removedLines = [];
        }
      }
    } else {
      lines.push(...eventLines(locale, e));
    }
    prevKind = currKind;
  }
  return lines;
}

function isAttacResolutionKind(kind: GameEvent["kind"] | null): boolean {
  return kind === "attackResolved" || kind === "unitDestroyed" || kind === "unitRemoved";
}

function getKindInBatch(i: number, slice: readonly GameEvent[]): GameEvent["kind"] | null {
  return i >= 0 && i < slice.length ? slice[i]!.kind : null;
}

function eventLines(locale: LocaleId, e: GameEvent): string[] {
  switch (e.kind) {
    case "turn":
      return [t(locale, "log.turn", { turn: e.turn })];
    case "phase":
      return [t(locale, "log.phase", { phase: e.phase })];
    case "initiative": {
      const rolls = Object.entries(e.rolls)
        .sort((a, b) => Number(a[0]) - Number(b[0]))
        .map(([team, roll]) => `team ${team} (2D6: ${roll})`)
        .join(", ");
      return [t(locale, "log.initiative", { rolls, winner: e.winnerTeam })];
    }
    case "moveDeclared":
      return [t(locale, "log.moveDeclared", { id: e.unitId, mode: e.mode })];
    case "moved":
      return [
        t(locale, "log.moved", {
          id: e.unitId,
          mode: e.mode,
          pos: disp(e.position),
          facing: e.facing,
          mp: e.mpSpent,
          budget: e.mpBudget,
        }),
      ];
    case "attacksDeclared":
      return [
        t(locale, e.count === 1 ? "log.attacksDeclaredOne" : "log.attacksDeclaredOther", {
          id: e.unitId,
          target: e.targetId,
          count: e.count,
          rangeCtx: `range ${e.distance} (${e.rangeBracket}, ${signedMod(e.rangeMod)})`,
        }),
      ];
    case "attackResolved":
      return resolutionLines(locale, e.resolution);
    case "unitDestroyed":
      return [t(locale, "log.destroyed", { id: e.unitId })];
    case "unitRemoved":
      return [t(locale, "log.removedEvent", { id: e.unitId })];
    default: {
      // Exhaustiveness guard: adding a GameEvent kind must add a case above.
      const unreachable: never = e;
      return unreachable;
    }
  }
}

function signedMod(n: number): string {
  return n >= 0 ? `+${n}` : String(n);
}

/** Labeled GATOR breakdown: "gunnery 4 + move 1 + terrain 1 + range 2". */
function gatorText(locale: LocaleId, r: AttackResolution): string {
  if (r.breakdown.outOfRange) return t(locale, "res.outOfRange");
  const b = r.breakdown;
  const parts = [`gunnery ${b.gunnery}`];
  if (b.attackerMod) parts.push(`move ${b.attackerMod}`);
  if (b.targetMod) parts.push(`target ${b.targetMod}`);
  if (b.terrainMod) parts.push(`terrain ${b.terrainMod}`);
  if (b.rangeMod) parts.push(`range ${b.rangeMod}`);
  if (b.minRangeMod) parts.push(`min ${b.minRangeMod}`);
  if (b.pulseMod) parts.push(`pulse ${b.pulseMod}`);
  const total = b.automatic === "hit" ? t(locale, "res.needAuto") : String(b.total);
  return `${t(locale, "res.need", { total })} (${parts.join(" + ")})`;
}

export function resolutionLines(locale: LocaleId, r: AttackResolution): string[] {
  if (r.breakdown.outOfRange) {
    return [t(locale, "res.outOfRangeLine", { weapon: r.weapon, distance: r.distance })];
  }
  const verdict =
    r.breakdown.automatic === "hit"
      ? t(locale, "res.autoHit")
      : r.hit
        ? t(locale, "res.hit")
        : t(locale, "res.miss");
  const lines = [
    t(locale, "res.line", {
      weapon: r.weapon,
      gator: gatorText(locale, r),
      roll: String(r.toHitRoll),
      verdict,
      jam: r.jammed ? t(locale, "res.jamSuffix") : "",
    }),
  ];
  if (r.clusterRoll !== null) lines.push(t(locale, "res.clusterRoll", { roll: r.clusterRoll }));
  if (r.hit && r.groups.length > 0) {
    lines.push(
      t(locale, "res.hits", {
        groups: r.groups.map((g) => `${SHORT_LOC[g.location]}(${g.damage})`).join(" "),
      }),
    );
    const detail = transferDetail(locale, r);
    if (detail) lines.push(`  ${detail}`);
  }
  return lines;
}

/**
 * Reconstruct before->after armor numbers per transfer step by working back
 * from the final armor state (resolutions carry no pre-damage snapshot).
 */
function transferDetail(locale: LocaleId, r: AttackResolution): string | null {
  const app = r.application;
  if (!app || app.steps.length === 0) return null;
  const totals = {} as ArmorState;
  for (const step of app.steps) {
    totals[step.location] = (totals[step.location] ?? 0) + step.damageApplied;
  }
  const running = {} as ArmorState;
  for (const loc of LOCATIONS) {
    running[loc] = app.armor[loc] + (totals[loc] ?? 0);
  }
  const wasImmobile = isImmobile(running);
  const wasKilled = isKilled(running);
  const bits: string[] = [];
  for (const step of app.steps) {
    const before = running[step.location];
    const after = before - step.damageApplied;
    running[step.location] = after;
    bits.push(`${SHORT_LOC[step.location]} ${before}->${after}${step.depleted ? "*" : ""}`);
  }
  let text = bits.join(", ");
  for (const arm of app.blownOffArms) {
    const cause = arm === "rightArm" ? "rightTorso" : "leftTorso";
    text += t(locale, "res.armBlownOff", { cause: shortLoc(cause), arm: shortLoc(arm) });
  }
  const otherDestroyed = app.newlyDestroyed.filter((loc) => !app.blownOffArms.includes(loc));
  if (otherDestroyed.length > 0) {
    text += t(locale, "res.destroyedTail", { locs: otherDestroyed.map(shortLoc).join(", ") });
  }
  if (isImmobile(app.armor) && !wasImmobile) text += t(locale, "res.immobilized");
  if (app.killed && !wasKilled) text += t(locale, "res.killed");
  return text;
}

function shortLoc(loc: Location): string {
  return SHORT_LOC[loc];
}

function weaponDamageSummary(w: {
  damage?: number;
  missileDamage?: 1 | 2;
  missiles?: number;
  variableDamage?: readonly [number, number, number];
}): string {
  if (w.variableDamage)
    return `${w.variableDamage[0]} / ${w.variableDamage[1]} / ${w.variableDamage[2]}`;
  if (w.missileDamage !== undefined && w.missiles !== undefined)
    return `${w.missileDamage} per missile × ${w.missiles}`;
  return String(w.damage ?? 0);
}

function weaponDamageDetail(w: {
  damage?: number;
  missileDamage?: 1 | 2;
  missiles?: number;
  variableDamage?: readonly [number, number, number];
}): string {
  if (w.variableDamage)
    return `${w.variableDamage[0]} (short) / ${w.variableDamage[1]} (medium) / ${w.variableDamage[2]} (long)`;
  if (w.missileDamage !== undefined && w.missiles !== undefined)
    return `${w.missileDamage} per missile`;
  return `${w.damage ?? 0} (direct fire)`;
}

function weaponCategory(name: string): string {
  if (name.includes("LRM") || name.includes("SRM")) return "Missile";
  if (name.includes("Autocannon") || name.includes("AC/") || name.includes("Machine Gun"))
    return "Ballistic";
  return "Energy";
}

function weaponSummary(def: MechDef): string[] {
  return def.weapons.map((mount, i) => {
    const w = getWeapon(mount.weapon);
    const ammo = mount.ammoShots !== undefined ? ` ammo ${mount.ammoShots}` : "";
    return `  #${i + 1} ${mount.weapon} (${SHORT_LOC[mount.location]}) S${w.short}/M${w.medium}/L${w.long}${ammo}`;
  });
}
