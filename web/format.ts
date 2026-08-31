import type {
  ArmorState,
  AttackResolution,
  BattleState,
  CriticalEffect,
  CriticalResolution,
  CritSoakName,
  CritStructureName,
  FireBlockerReason,
  FireWeapon,
  GameEvent,
  Hex,
  Location,
  RangeBracket,
  ResolvedMechDef,
  UnitDamageState,
  UnitState,
} from "btlib10x";
import {
  canFireFromLocation,
  getAllMapDefs,
  getAllMechDefs,
  getAllWeapons,
  getMapDef,
  getMechDef,
  getWeapon,
  internalStructureForTonnage,
  isImmobile,
  isKilled,
  LOCATIONS,
  listMapNames,
  listWeaponNames,
  reachableLandings,
  suggestFireTargets,
} from "btlib10x";
import type { LocaleId, MessageKey } from "./i18n/index.js";
import { t } from "./i18n/index.js";
import type { BoardModel, BoardRenderer, CharStyle } from "./render.js";
import { battleModel, getBoardRenderer, mapModel, TEAM_STYLES } from "./render.js";
import type { Session, SetupUnit } from "./session.js";
import { moveStepsInfo } from "./session.js";

/** Board renderer type (re-exported from the render layer). */
export type { BoardRenderer } from "./render.js";

/** One presentation chunk of command output. */
export type Chunk =
  | { readonly kind: "lines"; lines: readonly string[]; cls?: string }
  | {
      readonly kind: "board";
      board: { readonly model: BoardModel; readonly renderer?: BoardRenderer };
    }
  | { readonly kind: "columns"; columns: readonly (readonly string[])[] }
  | {
      readonly kind: "collapsible";
      readonly summary: string;
      readonly chunks: readonly Chunk[];
    };

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

export function buildLinesChunk(lines: readonly string[], cls?: string): Chunk {
  return cls ? { kind: "lines", lines: lines, cls: cls } : { kind: "lines", lines: lines };
}

export function buildBoardChunk(board: {
  readonly model: BoardModel;
  readonly renderer?: BoardRenderer;
}): Chunk {
  return { kind: "board", board: board };
}

export function buildColumnsChunk(columns: readonly (readonly string[])[]): Chunk {
  return { kind: "columns", columns: columns };
}

export function buildCollapsibleChunk(summary: string, chunks: readonly Chunk[]): Chunk {
  return { kind: "collapsible", summary: summary, chunks: chunks };
}

export function rich(...chunks: readonly Chunk[]): RichOutput {
  return { rich: chunks };
}

/** Display coordinates are 1-based (the internal value itself). */
function disp(hex: { col: number; row: number }): string {
  return `${hex.col},${hex.row}`;
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
      return buildLinesChunk([t(s.locale, "board.noMap")]);
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
    return buildBoardChunk(boardChunkOf(model));
  }
  return buildBoardChunk(boardChunkOf(battleModel(s.battle)));
}

// ---------------------------------------------------------------- info ----

export function infoMechList(locale: LocaleId): string[] {
  const list = getAllMechDefs().sort((a, b) => {
    if (a.tonnage !== b.tonnage) return a.tonnage - b.tonnage;
    return a.name.localeCompare(b.name);
  });
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

export function infoMechChunk(locale: LocaleId, model: string): Chunk[] {
  const d = requireMechDef(model, locale);
  const armorRear: Partial<Record<Location, number>> = {};
  for (const loc of ["centerTorso", "rightTorso", "leftTorso"] as const) {
    const v = d.armorRear[loc];
    if (v !== undefined) armorRear[loc] = v;
  }
  const is = internalStructureForTonnage(d.tonnage);
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
    t(locale, "sheet.weaponsHeader", { n: Object.keys(d.weapons).length }),
    ...Object.entries(d.weapons).map(([key, mount]) =>
      weaponMountLine(locale, Number(key), {
        weapon: mount.weapon,
        location: mount.location,
        ammoLeft: mount.ammoShots ?? null,
        jammed: false,
        destroyed: false,
      }),
    ),
  ];
  return [
    ...mergeDiagram(
      topLines,
      weaponLines,
      armorDiagramInfo({
        armor: d.armor,
        armorRear,
        internalStructure: is,
        originalArmor: d.armor,
        originalArmorRear: armorRear,
        originalStructure: is,
      }),
    ),
    critChartChunk(d, locale, null),
  ];
}

export function infoMapList(): string[] {
  return getAllMapDefs().map(
    (m) => `${m.name}: ${m.width}x${m.height}, ${m.terrain.length} terrain hexes`,
  );
}

export function infoWeaponList(locale: LocaleId): string[] {
  const grouped = new Map<string, ReturnType<typeof Object.values>[0][]>();
  let maxNameLen = 0;
  for (const w of getAllWeapons()) {
    const cat = weaponCategory(w.name);
    const list = grouped.get(cat) ?? [];
    list.push(w);
    grouped.set(cat, list);
    maxNameLen = Math.max(maxNameLen, w.name.length);
  }
  const lines: string[] = [];
  for (const [cat, weapons] of grouped) {
    lines.push(t(locale, "info.weaponCategory", { category: cat }));
    for (const w of weapons) {
      lines.push(
        `  ${w.name.padEnd(maxNameLen)}  short ${String(w.short).padStart(2)}` +
          ` / medium ${String(w.medium).padStart(2)}` +
          ` / long ${String(w.long).padStart(2)}` +
          `  ${weaponDamageSummary(w)}`,
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
      throw new Error(t(locale, "err.unknownWeapon", { name, list: listWeaponNames().join(", ") }));
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
  const map = getMapDef(name);
  if (!map) throw new Error(t(locale, "err.unknownMap", { name, list: listMapNames().join(", ") }));
  const counts = new Map<string, number>();
  for (const t2 of map.terrain) counts.set(t2.type, (counts.get(t2.type) ?? 0) + 1);
  const breakdown = [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([type, n]) => `${type} ${n}`)
    .join(", ");
  const elevationCounts = new Map<number, number>();
  const elevationMap: Record<string, number> = {};
  for (const t2 of map.terrain) {
    if (t2.level !== undefined && t2.level !== 0) {
      elevationMap[`${t2.col},${t2.row}`] = t2.level;
      elevationCounts.set(t2.level, (elevationCounts.get(t2.level) ?? 0) + 1);
    }
  }
  const elevationBreakdown =
    [...elevationCounts.entries()]
      .sort(([a], [b]) => a - b)
      .map(([level, n]) => `L${level} ${n}`)
      .join(", ") || t(locale, "info.terrainNone");
  return [
    buildLinesChunk([
      t(locale, "info.mapHead", { name, w: map.width, h: map.height }),
      t(locale, "info.terrainLine", { breakdown: breakdown || t(locale, "info.terrainNone") }),
      t(locale, "info.elevationLine", { breakdown: elevationBreakdown }),
    ]),
    buildBoardChunk(
      boardChunkOf(
        mapModel(
          map.terrain,
          map.width,
          map.height,
          undefined,
          Object.keys(elevationMap).length > 0 ? elevationMap : undefined,
        ),
      ),
    ),
  ];
}

function requireMechDef(model: string, locale: LocaleId): ResolvedMechDef {
  const def = getMechDef(model);
  if (!def) throw new Error(t(locale, "err.unknownModel", { model }));
  return def;
}

// --------------------------------------------------------------- sheet ----

interface SheetView {
  readonly id: string;
  readonly team: number;
  readonly model: string;
  readonly name: string;
  readonly weightClass: string;
  readonly tonnage: number;
  readonly gunnery: number | null;
  readonly walking: number;
  readonly running: number;
  readonly jumping: number;
  readonly removed: boolean;
  readonly positionLine: string;
  readonly modeLine: string | null;
  /** Current front armor per location. */
  readonly armor: ArmorState;
  /** Current layered damage (front armor, rear armor, internal structure). */
  readonly damage: UnitDamageState;
  /** Designed (start-of-game) front armor per location. */
  readonly originalArmor: Readonly<Record<Location, number>>;
  /** Designed (start-of-game) rear torso armor. */
  readonly originalArmorRear: Partial<Record<Location, number>>;
  /** Designed (start-of-game) internal structure per location. */
  readonly originalArmorStructure: ArmorState;
  readonly mounts: readonly {
    readonly weapon: string;
    readonly location: Location;
    readonly ammoLeft: number | null;
    readonly jammed: boolean;
    readonly destroyed: boolean;
  }[];
  /** Per-unit live crit state for the crit chart; null when only design info exists. */
  readonly critLive: CritChartLive | null;
}

function battleSheet(unit: UnitState, id: string, locale: LocaleId): SheetView {
  const def = getMechDef(unit.model)!;
  return {
    id: id,
    team: unit.team,
    model: def.model,
    name: def.name,
    weightClass: def.weightClass,
    tonnage: def.tonnage,
    gunnery: unit.gunnery,
    walking: def.walking,
    running: def.running,
    jumping: def.jumping,
    removed: unit.removed,
    positionLine: t(locale, "sheet.at", { pos: disp(unit.position), facing: unit.facing }),
    modeLine:
      unit.moveMode !== null
        ? t(locale, "sheet.modeSuffix", { mode: unit.moveMode, mp: unit.mpSpent })
        : null,
    armor: unit.damage.armor,
    damage: unit.damage,
    originalArmor: def.armor,
    originalArmorRear: def.armorRear,
    originalArmorStructure: def.internalStructure,
    mounts: Object.entries(def.weapons).map(([key, mount]) => ({
      weapon: mount.weapon,
      location: mount.location,
      ammoLeft: mount.ammoShots !== undefined ? (unit.ammoLeft[Number(key)] ?? 0) : null,
      jammed: unit.jammedWeapons.includes(Number(key)),
      destroyed:
        unit.destroyedWeapons.includes(Number(key)) ||
        !canFireFromLocation(unit.phaseStartDamage, mount.location),
    })),
    critLive: {
      critSlotsDestroyed: unit.critSlotsDestroyed,
      destroyedWeapons: unit.destroyedWeapons,
      jammedWeapons: unit.jammedWeapons,
      ammoLeft: unit.ammoLeft,
    },
  };
}

function setupSheet(unit: SetupUnit, id: string, locale: LocaleId): SheetView {
  const def = requireMechDef(unit.model, locale);
  const armorRear: Partial<Record<Location, number>> = {};
  for (const loc of ["centerTorso", "rightTorso", "leftTorso"] as const) {
    const v = def.armorRear[loc];
    if (v !== undefined) armorRear[loc] = v;
  }
  const damage: UnitDamageState = {
    armor: { ...def.armor },
    armorRear,
    internalStructure: internalStructureForTonnage(def.tonnage),
  };
  return {
    id: id,
    team: unit.team,
    model: def.model,
    name: def.name,
    weightClass: def.weightClass,
    tonnage: def.tonnage,
    gunnery: unit.gunnery,
    walking: def.walking,
    running: def.running,
    jumping: def.jumping,
    removed: false,
    positionLine: t(locale, "sheet.at", { pos: disp(unit.position), facing: unit.facing }),
    modeLine: null,
    armor: damage.armor,
    damage,
    originalArmor: def.armor,
    originalArmorRear: armorRear,
    originalArmorStructure: damage.internalStructure,
    mounts: Object.values(def.weapons).map((mount) => ({
      weapon: mount.weapon,
      location: mount.location,
      ammoLeft: mount.ammoShots ?? null,
      jammed: false,
      destroyed: false,
    })),
    critLive: null,
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
  readonly armorRear: Partial<Record<Location, number>>;
  readonly internalStructure: ArmorState;
  readonly originalArmor: Readonly<Record<Location, number>>;
  readonly originalArmorRear: Partial<Record<Location, number>>;
  readonly originalStructure: ArmorState;
}

/** ASCII humanoid armor diagram: internal structure (I), front armor (F/A), rear (R). */
/** for 'info mech <model>' command */
function armorDiagramInfo(info: ArmorInfo): string[] {
  const cell = (max: number, label: string) => ` ${String(max).padStart(2)}${label}`;
  const p = (n: number) => " ".repeat(n);
  const CT = 10,
    RT = 5,
    LT = 17;
  const o = info.originalArmor;
  const os = info.originalStructure;
  const or = info.originalArmorRear;
  const rear = (loc: Location) => cell(or[loc] ?? 0, "R");
  return [
    `${p(CT)}[HD]`,
    `${p(CT)}${cell(os.head, "I")}`,
    `${p(CT)}${cell(o.head, "A")}`,
    `[RA] [RT] [CT] [LT] [LA]`,
    [
      cell(os.rightArm, "I"),
      cell(os.rightTorso, "I"),
      cell(os.centerTorso, "I"),
      cell(os.leftTorso, "I"),
      cell(os.leftArm, "I"),
    ].join(" "),
    [
      cell(o.rightArm, "A"),
      cell(o.rightTorso, "F"),
      cell(o.centerTorso, "F"),
      cell(o.leftTorso, "F"),
      cell(o.leftArm, "A"),
    ].join(" "),
    `${p(RT)}${[rear("rightTorso"), rear("centerTorso"), rear("leftTorso")].join(" ")}`,
    `${p(RT)}[RL]${p(LT - RT - 6)}[LL]`,
    `${p(RT)}${[cell(os.rightLeg, "I"), cell(os.leftLeg, "I")].join(p(LT - RT - 6))}`,
    `${p(RT)}${[cell(o.rightLeg, "A"), cell(o.leftLeg, "A")].join(p(LT - RT - 6))}`,
  ];
}

/** ASCII humanoid armor diagram: internal structure (I), front armor (F/A), rear (R). */
/** for 'sheet <id>' command */
function armorDiagramSheet(info: ArmorInfo): string[] {
  const cell = (val: number, max: number, label: string) =>
    `${String(val).padStart(2)}/${String(max).padStart(2)}${label}`;
  const p = (n: number) => " ".repeat(n);
  const CT = 14,
    RT = 7,
    LT = 21;
  const { armor: a, originalArmor: o } = info;
  const s = info.internalStructure;
  const os = info.originalStructure;
  const ar = info.armorRear;
  const or = info.originalArmorRear;
  const rear = (loc: Location) => cell(ar[loc] ?? 0, or[loc] ?? 0, "R");
  return [
    `${p(CT)}[ HD ]`,
    `${p(CT)}${cell(s.head, os.head, "I")}`,
    `${p(CT)}${cell(a.head, o.head, "A")}`,
    `[ RA ] [ RT ] [ CT ] [ LT ] [ LA ]`,
    [
      cell(s.rightArm, os.rightArm, "I"),
      cell(s.rightTorso, os.rightTorso, "I"),
      cell(s.centerTorso, os.centerTorso, "I"),
      cell(s.leftTorso, os.leftTorso, "I"),
      cell(s.leftArm, os.leftArm, "I"),
    ].join(" "),
    [
      cell(a.rightArm, o.rightArm, "A"),
      cell(a.rightTorso, o.rightTorso, "F"),
      cell(a.centerTorso, o.centerTorso, "F"),
      cell(a.leftTorso, o.leftTorso, "F"),
      cell(a.leftArm, o.leftArm, "A"),
    ].join(" "),
    `${p(RT)}${[rear("rightTorso"), rear("centerTorso"), rear("leftTorso")].join(" ")}`,
    `${p(RT)}[ RL ]${p(LT - RT - 6)}[ LL ]`,
    `${p(RT)}${[cell(s.rightLeg, os.rightLeg, "I"), cell(s.leftLeg, os.leftLeg, "I")].join(p(LT - RT - 6))}`,
    `${p(RT)}${[cell(a.rightLeg, o.rightLeg, "A"), cell(a.leftLeg, o.leftLeg, "A")].join(p(LT - RT - 6))}`,
  ];
}

// ------------------------------------------------------- crit slot chart ----

/** Per-unit live crit state shown per slot on the `sheet <id>` chart. */
interface CritChartLive {
  readonly critSlotsDestroyed: Readonly<Record<Location, readonly boolean[]>>;
  readonly destroyedWeapons: readonly number[];
  readonly jammedWeapons: readonly number[];
  readonly ammoLeft: Readonly<Record<number, number>>;
}

/** Human-friendly i18n key for a structure component name. */
const CRIT_COMPONENT_KEY: Readonly<Record<CritStructureName, MessageKey>> = {
  cockpit: "critChart.component.cockpit",
  sensors: "critChart.component.sensors",
  lifeSupport: "critChart.component.lifeSupport",
  engine: "critChart.component.engine",
  gyro: "critChart.component.gyro",
  heatSink: "critChart.component.heatSink",
  doubleHeatSink: "critChart.component.doubleHeatSink",
  jumpJet: "critChart.component.jumpJet",
  shoulder: "critChart.component.shoulder",
  upperArmActuator: "critChart.component.upperArmActuator",
  lowerArmActuator: "critChart.component.lowerArmActuator",
  handActuator: "critChart.component.handActuator",
  upperLegActuator: "critChart.component.upperLegActuator",
  lowerLegActuator: "critChart.component.lowerLegActuator",
  footActuator: "critChart.component.footActuator",
  hip: "critChart.component.hip",
  targetingComputer: "critChart.component.targetingComputer",
};

/** Human-friendly i18n key for a soak (armor-tech) component name. */
const CRIT_SOAK_KEY: Readonly<Record<CritSoakName, MessageKey>> = {
  endoSteel: "critChart.soak.endoSteel",
  ferroFibrous: "critChart.soak.ferroFibrous",
  case: "critChart.soak.case",
};

/** One slot line: dice number + component label, plus live markers. */
function critSlotText(
  def: ResolvedMechDef,
  loc: Location,
  slotIndex: number,
  locale: LocaleId,
  live: CritChartLive | null,
): string {
  const slot = def.critSlots[loc][slotIndex - 1] ?? { kind: "empty" };
  const dice = slotIndex.toString().padStart(2);
  let body: string;
  if (slot.kind === "empty") {
    body = t(locale, "critChart.empty");
  } else if (slot.kind === "soak") {
    const key = CRIT_SOAK_KEY[slot.name as CritSoakName];
    body = `(${key !== undefined ? t(locale, key) : slot.name})`;
  } else if (slot.kind === "weapon" || slot.kind === "ammo") {
    body = slot.weapon;
  } else {
    const key = CRIT_COMPONENT_KEY[slot.name as CritStructureName];
    body = key !== undefined ? t(locale, key) : slot.name;
  }
  const line = ` ${dice} ${body}`;
  const markers: string[] = [];
  if (slot.kind === "ammo") {
    const shots =
      live !== null
        ? (live.ammoLeft[slot.weaponIndex] ?? 0)
        : def.weapons[slot.weaponIndex]?.ammoShots;
    if (shots !== undefined) {
      markers.push(t(locale, "critChart.ammoSuffix", { n: shots }));
    }
  }
  if (live !== null && live.critSlotsDestroyed[loc] !== undefined) {
    const slotHit = live.critSlotsDestroyed[loc]?.[slotIndex - 1] ?? false;
    const mountDestroyed =
      slot.kind === "weapon" && live.destroyedWeapons.includes(slot.weaponIndex);
    const mountJammed = slot.kind === "weapon" && live.jammedWeapons.includes(slot.weaponIndex);
    if (mountJammed) markers.push(t(locale, "critChart.jammedSuffix"));
    if (slotHit || mountDestroyed) markers.push(t(locale, "critChart.destroyedSuffix"));
  }
  return markers.length > 0 ? `${line}${markers.join("")}` : line;
}

/** Render one location's crit slots as a vertical column (unpadded). */
function critCell(
  def: ResolvedMechDef,
  loc: Location,
  locale: LocaleId,
  live: CritChartLive | null,
): string[] {
  const lines = [`[ ${SHORT_LOC[loc]} ]`];
  for (let i = 0; i < def.critSlots[loc].length; i++) {
    lines.push(critSlotText(def, loc, i + 1, locale, live));
  }
  return lines;
}

/** Collapsible crit chart: one columns chunk per row (arena / torso / legs). */
function critChartChunk(def: ResolvedMechDef, locale: LocaleId, live: CritChartLive | null): Chunk {
  const raLines = critCell(def, "rightArm", locale, live);
  const hdLines = critCell(def, "head", locale, live);
  const laLines = critCell(def, "leftArm", locale, live);
  const rtLines = critCell(def, "rightTorso", locale, live);
  const ctLines = critCell(def, "centerTorso", locale, live);
  const ltLines = critCell(def, "leftTorso", locale, live);
  const rlLines = critCell(def, "rightLeg", locale, live);
  const infoLines = [" "];
  const llLines = critCell(def, "leftLeg", locale, live);
  const built = [raLines, hdLines, laLines, rtLines, ctLines, ltLines, rlLines, infoLines, llLines];
  const maxLineLen = built
    .flatMap((lines) => lines)
    .map((l) => l.length)
    .reduce((prev, curr) => Math.max(prev, curr));
  built.forEach((lines) => (lines[0] = lines[0]!.padEnd(maxLineLen)));
  return buildCollapsibleChunk(t(locale, "critChart.summary"), [
    buildColumnsChunk([raLines, hdLines, laLines]),
    buildColumnsChunk([rtLines, ctLines, ltLines]),
    buildColumnsChunk([rlLines, infoLines, llLines]),
  ]);
}

/** Record sheet with armor status per location, side-by-side with ASCII diagram. */
export function sheetLines(view: SheetView, locale: LocaleId): Chunk[] {
  const idLine = view.removed
    ? `${t(locale, "sheet.idLine", { id: view.id, team: view.team })}${t(locale, "sheet.removedId")}`
    : t(locale, "sheet.idLine", { id: view.id, team: view.team });
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
  topLines.push(
    t(locale, "info.movement", { walk: view.walking, run: view.running, jump: view.jumping }),
  );
  topLines.push(view.positionLine);
  const weaponLines: string[] = [];
  weaponLines.push(t(locale, "sheet.weaponsHeader", { n: view.mounts.length }));
  for (const [i, m] of view.mounts.entries()) {
    weaponLines.push(weaponMountLine(locale, i + 1, m));
  }
  return [
    ...mergeDiagram(
      topLines,
      weaponLines,
      armorDiagramSheet({
        armor: view.armor,
        armorRear: view.damage.armorRear,
        internalStructure: view.damage.internalStructure,
        originalArmor: view.originalArmor,
        originalArmorRear: view.originalArmorRear,
        originalStructure: view.originalArmorStructure,
      }),
    ),
    critChartChunk(requireMechDef(view.model, locale), locale, view.critLive),
  ];
}

export function mergeDiagram(
  topLines: string[],
  weaponLines: string[],
  diagram: string[],
): Chunk[] {
  const leftLineCount = topLines.length + weaponLines.length;
  const rightLineCount = diagram.length;
  if (leftLineCount > rightLineCount) {
    return [
      buildColumnsChunk([
        [...topLines, ...weaponLines],
        [...new Array(leftLineCount - rightLineCount).fill(""), ...diagram],
      ]),
    ];
  }
  if (leftLineCount < rightLineCount) {
    return [
      buildColumnsChunk([
        [...topLines, ...new Array(rightLineCount - leftLineCount).fill(""), ...weaponLines],
        diagram,
      ]),
    ];
  }
  return [buildColumnsChunk([[...topLines, ...weaponLines], diagram])];
}

export function sheetForUnit(s: Session, id: string): Chunk[] {
  if (s.battle) {
    const unit = s.battle.units[id];
    if (!unit) throw new Error(t(s.locale, "err.unknownUnitId", { id }));
    return sheetLines(battleSheet(unit, id, s.locale), s.locale);
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
      const def = getMechDef(unit.model)!;
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
      const def = getMechDef(u.model)!;
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
      const view = battleSheet(unit, uid, s.locale);
      const idLine = view.removed
        ? `${t(s.locale, "over.idLine", { id: view.id })}${t(s.locale, "sheet.removedId")}`
        : t(s.locale, "over.idLine", { id: view.id });
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

/** Belly marker drawn in a reachable hex on the reachable map. */
export const REACHABLE_MARKER = "<>";

/**
 * Clipped ASCII-hex map of the reachable hexes for the declared mode.
 *
 * The model crops exactly to the smallest axis-aligned bounding box that holds
 * every reachable hex and is clamped to the board bounds (no padding). All
 * units inside the crop keep their ids (team-tinted); no facing arrows are
 * drawn, reachable hexes show a team-tinted `<>` in the belly, and every
 * reachable (hex, facing) landing tints its grid edge with the actor's team
 * color. Raw `RevealedLanding.path` data is retained on the landing but not
 * rendered here (kept for later use).
 */
export function reachableModel(s: Session): BoardModel | null {
  const actor = s.battle?.units[s.actorId ?? ""];
  if (!actor || !s.battle || s.moveMode === null) return null;
  const w = s.battle.width;
  const h = s.battle.height;
  if (w === undefined || h === undefined) return null;
  const def = getMechDef(actor.model)!;
  const landings = reachableLandings({ ...actor.position }, actor.facing, {
    mode: s.moveMode,
    walking: def.walking,
    running: def.running,
    jumping: def.jumping,
    terrain: s.battle.terrain,
    elevation: s.battle.elevation,
    team: actor.team,
    width: w,
    height: h,
    occupantTeam: (hex: Hex): number | undefined => {
      for (const u of Object.values(s.battle!.units)) {
        if (u.removed) continue;
        if (u.position.col === hex.col && u.position.row === hex.row) return u.team;
      }
      return undefined;
    },
  });
  if (landings.length === 0) return null;

  let minC = Infinity;
  let minR = Infinity;
  let maxC = -Infinity;
  let maxR = -Infinity;
  for (const l of landings) {
    if (l.hex.col < minC) minC = l.hex.col;
    if (l.hex.col > maxC) maxC = l.hex.col;
    if (l.hex.row < minR) minR = l.hex.row;
    if (l.hex.row > maxR) maxR = l.hex.row;
  }
  const col0 = Math.max(1, minC);
  const row0 = Math.max(1, minR);
  const col1 = Math.min(w, maxC);
  const row1 = Math.min(h, maxR);

  const base = battleModel(s.battle);
  const cells = { ...(base.cells ?? {}) };
  const cellStyles = { ...(base.cellStyles ?? {}) };
  const edgeStyles: Record<string, CharStyle> = {};
  const team = TEAM_STYLES[actor.team];
  const actorKey = `${actor.position.col},${actor.position.row}`;
  for (const l of landings) {
    const key = `${l.hex.col},${l.hex.row}`;
    if (key !== actorKey && cells[key] === undefined) {
      cells[key] = REACHABLE_MARKER;
      if (team !== undefined) cellStyles[key] = team;
    }
    if (team !== undefined) edgeStyles[`${l.hex.col},${l.hex.row}:${l.facing}`] = team;
  }

  return {
    cols: col1 - col0 + 1,
    rows: row1 - row0 + 1,
    col0,
    row0,
    cells,
    ...(Object.keys(edgeStyles).length > 0 ? { edgeStyles } : {}),
    ...(base.styles !== undefined ? { styles: base.styles } : {}),
    ...(Object.keys(cellStyles).length > 0 ? { cellStyles } : {}),
    ...(base.marks !== undefined ? { marks: base.marks } : {}),
    ...(base.elevations !== undefined ? { elevations: base.elevations } : {}),
  };
}

/** Board chunk of the reachable hex map, or null when none can be drawn. */
export function reachChunk(s: Session): Chunk | null {
  const model = reachableModel(s);
  if (model === null) return null;
  return buildBoardChunk(boardChunkOf(model));
}

export function attackStatusLines(s: Session): string[] {
  const actor = s.battle?.units[s.actorId ?? ""];
  if (!actor || !s.battle)
    throw new Error(t(s.locale, "err.wrongPhase", { phase: "weaponAttack" }));
  if (s.fireDecls.length === 0) return [t(s.locale, "attackStatus.none")];
  const def = getMechDef(actor.model)!;
  return s.fireDecls.map((decl) => {
    const mount = def.weapons[decl.weaponIndex];
    const name = mount ? mount.weapon : `#${decl.weaponIndex}`;
    const rapid = mount ? getWeapon(mount.weapon).rapidFireShots : undefined;
    const suffix = decl.rapidFire && rapid !== undefined ? ` (rapid-fire x${rapid})` : "";
    return `#${decl.weaponIndex} ${name} -> ${decl.targetId}${suffix}`;
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

interface FireWeaponTableRow {
  readonly indexCell: string;
  readonly nameCell: string;
  readonly locCell: string;
  readonly bracketCell: string;
  readonly tnCell: string;
  readonly dmgCell: string;
}

function fireWeaponTable(locale: LocaleId, weapons: readonly FireWeapon[]): string[] {
  const rows: FireWeaponTableRow[] = weapons.map((w) => ({
    indexCell: `#${w.weaponIndex}`,
    nameCell: w.weapon,
    locCell: SHORT_LOC[w.location],
    bracketCell: `[${BRACKET_LABEL[w.rangeBracket]}]`,
    tnCell: String(w.tn),
    dmgCell:
      w.cluster !== undefined
        ? `${w.expectedDamage} (${t(locale, "fireSuggestion.cluster", {
            shots: String(w.cluster.shots),
            per: String(w.cluster.perMissile),
          })})`
        : String(w.expectedDamage),
  }));
  const ammoCell = (w: FireWeapon): string =>
    w.ammoShots !== null ? `${t(locale, "fireSuggestion.ammo")} ${w.ammoShots}` : "";

  const indexW = Math.max(
    t(locale, "fireSuggestion.colIndex").length,
    ...rows.map((r) => r.indexCell.length),
  );
  const nameW = Math.max(
    t(locale, "fireSuggestion.colWeapon").length,
    ...rows.map((r) => r.nameCell.length),
  );
  const locW = Math.max(
    t(locale, "fireSuggestion.colLoc").length,
    ...rows.map((r) => r.locCell.length),
  );
  const bracketW = Math.max(
    t(locale, "fireSuggestion.colBracket").length,
    ...rows.map((r) => r.bracketCell.length),
  );
  const tnW = Math.max(
    t(locale, "fireSuggestion.colTn").length,
    ...rows.map((r) => r.tnCell.length),
  );
  const dmgW = Math.max(
    t(locale, "fireSuggestion.colDmg").length,
    ...rows.map((r) => r.dmgCell.length),
  );

  const head =
    `${t(locale, "fireSuggestion.colIndex").padEnd(indexW)}  ` +
    `${t(locale, "fireSuggestion.colWeapon").padEnd(nameW)}  ` +
    `${t(locale, "fireSuggestion.colLoc").padEnd(locW)}  ` +
    `${t(locale, "fireSuggestion.colBracket").padEnd(bracketW)}  ` +
    `${t(locale, "fireSuggestion.colTn").padEnd(tnW)}  ` +
    `${t(locale, "fireSuggestion.colDmg").padEnd(dmgW)}  ` +
    t(locale, "fireSuggestion.colAmmo");

  const body = rows.map(
    (r, i) =>
      `${r.indexCell.padEnd(indexW)}  ` +
      `${r.nameCell.padEnd(nameW)}  ` +
      `${r.locCell.padEnd(locW)}  ` +
      `${r.bracketCell.padEnd(bracketW)}  ` +
      `${r.tnCell.padEnd(tnW)}  ` +
      `${r.dmgCell.padEnd(dmgW)}  ` +
      ammoCell(weapons[i]!),
  );

  return [head, ...body];
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
    if (target.weapons.length > 0) {
      lines.push(...fireWeaponTable(s.locale, target.weapons));
    }
    for (const b of target.blocked) {
      lines.push(
        `${t(s.locale, "fireSuggestion.blocked")}: #${b.weaponIndex} ${b.weapon} — ${t(s.locale, BLOCKER_LABEL[b.reason])}`,
      );
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
  const def = getMechDef(unit.model)!;
  return Object.entries(def.weapons).map(([key, mount]) => {
    const w = getWeapon(mount.weapon);
    const index = Number(key);
    const bits = [
      `#${index}`,
      mount.weapon,
      mount.location,
      `S${w.short}/M${w.medium}/L${w.long}`,
      mount.ammoShots !== undefined
        ? t(s.locale, "sheet.ammoFlag", { n: unit.ammoLeft[index] ?? 0 })
        : null,
      unit.jammedWeapons.includes(index) ? t(s.locale, "sheet.jammed") : null,
      unit.destroyedWeapons.includes(index) ? t(s.locale, "sheet.destroyed") : null,
      !unit.destroyedWeapons.includes(index) &&
      !canFireFromLocation(unit.phaseStartDamage, mount.location)
        ? t(s.locale, "sheet.destroyed")
        : null,
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
    case "critsResolved": {
      const lines: string[] = [];
      for (const crit of e.resolutions) {
        lines.push(...critLines(locale, crit));
      }
      return lines;
    }
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
  for (const crit of r.crits) {
    for (const line of critLines(locale, crit)) lines.push(`  ${line}`);
  }
  return lines;
}

/** Pretty-print one CriticalResolution into one or more terminal lines. */
export function critLines(locale: LocaleId, c: CriticalResolution): string[] {
  const headerKey =
    c.determiningRoll <= 7
      ? "res.critNone"
      : c.determiningRoll <= 9
        ? "res.critOne"
        : c.determiningRoll <= 11
          ? "res.critTwo"
          : "res.critThree";
  const lines: string[] = [
    t(locale, "res.critHeader", {
      roll: String(c.determiningRoll),
      count: t(locale, headerKey),
    }),
  ];
  for (const eff of c.rows) lines.push(`  ${formatCritEffect(locale, eff)}`);
  return lines;
}

function formatCritEffect(locale: LocaleId, eff: CriticalEffect): string {
  switch (eff.kind) {
    case "headBlownOff":
      return t(locale, "res.critHeadBlownOff");
    case "armBlownOff":
      return t(locale, "res.critArmBlownOff", { arm: SHORT_LOC[eff.arm] });
    case "legBlownOff":
      return t(locale, "res.critLegBlownOff", { leg: SHORT_LOC[eff.leg] });
    case "weaponDestroyed":
      return t(locale, "res.critWeaponDestroyed", {
        loc: SHORT_LOC[eff.location],
        slot: String(eff.slotIndex),
        weapon: eff.weaponName,
      });
    case "ammoExplosion":
      return t(locale, "res.critAmmoExplosion", {
        loc: SHORT_LOC[eff.location],
        slot: String(eff.slotIndex),
        weapon: eff.weaponName,
        damage: String(eff.damage),
      });
    case "cockpitDestroyed":
      return t(locale, "res.critCockpitDestroyed", {
        loc: SHORT_LOC[eff.location],
        slot: String(eff.slotIndex),
      });
    case "componentDestroyed":
      return t(locale, "res.critComponentDestroyed", {
        loc: SHORT_LOC[eff.location],
        slot: String(eff.slotIndex),
        name: eff.name,
      });
    case "noEffect":
      return t(locale, "res.critNoEffect", { loc: "reroll" });
  }
}

/**
 * Reconstruct before->after armor numbers per transfer step by working back
 * from the final armor state (resolutions carry no pre-damage snapshot).
 */
function transferDetail(locale: LocaleId, r: AttackResolution): string | null {
  const app = r.application;
  if (!app || app.steps.length === 0) return null;
  const armorTotals = {} as ArmorState;
  const rearTotals: Partial<Record<Location, number>> = {};
  const strucTotals = {} as ArmorState;
  for (const step of app.steps) {
    const map =
      step.pool === "armor" ? armorTotals : step.pool === "armorRear" ? rearTotals : strucTotals;
    map[step.location] = (map[step.location] ?? 0) + step.damageApplied;
  }
  const post = app.damage;
  const pre: UnitDamageState = {
    armor: {} as ArmorState,
    armorRear: { ...post.armorRear },
    internalStructure: {} as ArmorState,
  };
  for (const loc of LOCATIONS) {
    pre.armor[loc] = post.armor[loc] + (armorTotals[loc] ?? 0);
    pre.internalStructure[loc] = post.internalStructure[loc] + (strucTotals[loc] ?? 0);
    if (rearTotals[loc]) pre.armorRear[loc] = (post.armorRear[loc] ?? 0) + rearTotals[loc]!;
  }
  const wasImmobile = isImmobile(pre);
  const wasKilled = isKilled(pre);
  const runArmor = { ...pre.armor };
  const runRear = { ...pre.armorRear };
  const runStruc = { ...pre.internalStructure };
  const bits: string[] = [];
  for (const step of app.steps) {
    const map = step.pool === "armor" ? runArmor : step.pool === "armorRear" ? runRear : runStruc;
    const before = map[step.location]!;
    const after = before - step.damageApplied;
    map[step.location] = after;
    const label = step.pool === "armor" ? "A" : step.pool === "armorRear" ? "R" : "I";
    bits.push(`${SHORT_LOC[step.location]}${label} ${before}->${after}${step.depleted ? "*" : ""}`);
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
  if (isImmobile(app.damage) && !wasImmobile) text += t(locale, "res.immobilized");
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
    return `${w.missileDamage * w.missiles} = ${w.missileDamage} per missile × ${w.missiles}`;
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

function weaponMountLine(
  locale: LocaleId,
  n: number,
  mount: {
    readonly weapon: string;
    readonly location: Location;
    readonly ammoLeft: number | null;
    readonly jammed: boolean;
    readonly destroyed: boolean;
  },
): string {
  const w = getWeapon(mount.weapon);
  const flags = [
    mount.ammoLeft !== null ? t(locale, "sheet.ammoFlag", { n: mount.ammoLeft }) : null,
    mount.jammed ? t(locale, "sheet.jammed") : null,
    mount.destroyed ? t(locale, "sheet.destroyed") : null,
  ].filter((x) => x !== null);
  return `  #${n} ${mount.weapon} (${SHORT_LOC[mount.location]}) S${w.short}/M${w.medium}/L${w.long}${flags.length ? ` ${flags.join(" ")}` : ""}`;
}
