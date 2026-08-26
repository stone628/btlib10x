import type { Location } from "../src/core/types.js";
import { LOCATIONS } from "../src/core/types.js";
import { getMapDef, MAP_DEFS, MECH_DEFS, toEngineTerrain } from "../src/data/index.js";
import type { MechDef } from "../src/data/schema.js";
import { getWeapon, WEAPONS } from "../src/data/weapons.js";
import type { BoardModel, BoardRenderer } from "../src/render.js";
import { battleModel, boardToText, getBoardRenderer, mapModel, TERRAIN_GLYPHS } from "../src/render.js";
import type { AttackResolution } from "../src/rules/attack.js";
import type { ArmorState } from "../src/rules/damage.js";
import { canFireFromLocation } from "../src/rules/damage.js";
import type { BattleState, GameEvent, UnitState } from "../src/rules/game.js";
import type { LocaleId } from "./i18n/index.js";
import { t } from "./i18n/index.js";
import type { Session, SetupUnit } from "./session.js";
import { moveStepsInfo } from "./session.js";

/** Board renderer type (re-exported from the render layer). */
export type { BoardRenderer } from "../src/render.js";

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

/** Bottom-center glyph map for a `"col,row" -> terrain type` record. */
function terrainMarks(terrain: Readonly<Record<string, string>>): Record<string, string> {
  const marks: Record<string, string> = {};
  for (const [key, type] of Object.entries(terrain)) {
    const glyph = TERRAIN_GLYPHS[type];
    if (glyph !== undefined) marks[key] = glyph;
  }
  return marks;
}

/** Terrain legend for the board command: `"w(lightWoods)  W(heavyWoods)"` etc. */
export function boardLegend(locale: LocaleId): string {
  const list = Object.entries(TERRAIN_GLYPHS)
    .map(([type, glyph]) => `${glyph}(${type})`)
    .join("  ");
  return t(locale, "board.legend", { list });
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
    const model = battleModel(
      { units, terrain, width: dims?.[0], height: dims?.[1] } as BattleState,
      undefined,
      terrainMarks(terrain),
    );
    return { board: boardChunkOf(model) };
  }
  return { board: boardChunkOf(battleModel(s.battle, undefined, terrainMarks(s.battle.terrain))) };
}

// ---------------------------------------------------------------- info ----

export function infoMechList(locale: LocaleId): string[] {
  return Object.values(MECH_DEFS).map((d) =>
    t(locale, "info.mechListLine", {
      model: d.model,
      name: d.name,
      weightClass: d.weightClass,
      walk: d.walking,
      run: d.running,
      jump: d.jumping,
    }),
  );
}

export function infoMech(locale: LocaleId, model: string): string[] {
  const d = requireMechDef(model, locale);
  return [
    t(locale, "info.head", {
      model: d.model,
      name: d.name,
      weightClass: d.weightClass,
      tonnage: d.tonnage,
      techBase: d.techBase,
    }),
    t(locale, "info.movement", { walk: d.walking, run: d.running, jump: d.jumping }),
    t(locale, "sheet.armorLine", {
      list: LOCATIONS.map((loc) => `${SHORT_LOC[loc]} ${d.armor[loc]}`).join(" | "),
    }),
    t(locale, "sheet.weaponsHeader", { n: d.weapons.length }),
    ...weaponSummary(d),
  ];
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
        t(locale, "info.legend"),
        "",
      ],
    },
    { board: boardChunkOf(mapModel(toEngineTerrain(map), map.width, map.height)) },
  ];
}

function requireMechDef(model: string, locale: LocaleId): MechDef {
  const def = MECH_DEFS[model];
  if (!def) throw new Error(t(locale, "err.unknownModel", { model }));
  return def;
}

// --------------------------------------------------------------- sheet ----

interface SheetView {
  readonly model: string;
  readonly name: string;
  readonly weightClass: string;
  readonly tonnage: number;
  readonly gunnery: number | null;
  readonly facingLine: string | null;
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

function battleSheet(battle: BattleState, unit: UnitState, locale: LocaleId): SheetView {
  const def = battle.defs[unit.model]!;
  return {
    model: def.model,
    name: def.name,
    weightClass: def.weightClass,
    tonnage: def.tonnage,
    gunnery: unit.gunnery,
    facingLine:
      t(locale, "sheet.at", { pos: disp(unit.position), facing: unit.facing }) +
      (unit.moveMode !== null
        ? t(locale, "sheet.modeSuffix", { mode: unit.moveMode, mp: unit.mpSpent })
        : "") +
      (unit.removed ? t(locale, "sheet.removedSuffix") : ""),
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

function setupSheet(unit: SetupUnit, locale: LocaleId): SheetView {
  const def = requireMechDef(unit.model, locale);
  return {
    model: def.model,
    name: def.name,
    weightClass: def.weightClass,
    tonnage: def.tonnage,
    gunnery: unit.gunnery,
    facingLine: t(locale, "sheet.at", { pos: disp(unit.position), facing: unit.facing }),
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

/** Record sheet with armor status per location (no body diagram). */
export function sheetLines(view: SheetView, locale: LocaleId): string[] {
  const head = t(locale, "sheet.head", {
    model: view.model,
    name: view.name,
    weightClass: view.weightClass,
    tonnage: view.tonnage,
    gunnery:
      view.gunnery !== null
        ? t(locale, "sheet.gunnerySuffix", { gunnery: gunneryLabel(locale, view.gunnery) })
        : "",
  });
  const lines = [head];
  if (view.facingLine) lines.push(view.facingLine);
  lines.push(
    t(locale, "sheet.armorLine", {
      list: LOCATIONS.map((loc) => {
        const v = view.armor[loc];
        return `${SHORT_LOC[loc]} ${v}/${view.originalArmor[loc]}${v <= 0 ? "!" : ""}`;
      }).join(" | "),
    }),
  );
  lines.push(t(locale, "sheet.weaponsHeader", { n: view.mounts.length }));
  for (const [i, m] of view.mounts.entries()) {
    const w = getWeapon(m.weapon);
    const flags = [
      m.ammoLeft !== null ? t(locale, "sheet.ammoFlag", { n: m.ammoLeft }) : null,
      m.jammed ? t(locale, "sheet.jammed") : null,
      m.destroyed ? t(locale, "sheet.destroyed") : null,
    ].filter((x) => x !== null);
    lines.push(
      `  #${i + 1} ${m.weapon} (${SHORT_LOC[m.location]}) S${w.short}/M${w.medium}/L${w.long}${flags.length ? ` ${flags.join(" ")}` : ""}`,
    );
  }
  return lines;
}

export function sheetForUnit(s: Session, id: string): string[] {
  if (s.battle) {
    const unit = s.battle.units[id];
    if (!unit) throw new Error(t(s.locale, "err.unknownUnitId", { id }));
    return sheetLines(battleSheet(s.battle, unit, s.locale), s.locale);
  }
  const placed = s.roster.find((u) => u.id === id);
  if (!placed) throw new Error(t(s.locale, "err.noSuchUnit", { id }));
  return sheetLines(setupSheet(placed, s.locale), s.locale);
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

export function sheetLinesShort(view: SheetView, locale: LocaleId): string[] {
  const head = t(locale, "sheet.head", {
    model: view.model,
    name: view.name,
    weightClass: view.weightClass,
    tonnage: view.tonnage,
    gunnery:
      view.gunnery !== null
        ? t(locale, "sheet.gunnerySuffix", { gunnery: gunneryLabel(locale, view.gunnery) })
        : "",
  });
  const lines = [head];
  if (view.facingLine) lines.push(view.facingLine);
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
    for (const unit of Object.values(s.battle.units).filter((u) => u.team === team)) {
      const view = battleSheet(s.battle, unit, s.locale);
      for (const line of sheetLinesShort(view, s.locale)) lines.push(`  ${line}`);
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
  return events.slice(-n).flatMap((e) => {
    switch (e.kind) {
      case "turn":
        return [t(locale, "log.turn", { turn: e.turn })];
      case "phase":
        return [t(locale, "log.phase", { phase: e.phase })];
      case "initiative": {
        const rolls = Object.entries(e.rolls)
          .sort((a, b) => Number(a[0]) - Number(b[0]))
          .map(([team, roll]) => `team ${team} (2d6: ${roll})`)
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
  });
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
  if (b.pulseMod) parts.push(`pulse ${b.pulseMod}`);
  const total = b.automatic === "hit" ? t(locale, "res.needAuto") : String(b.total);
  return `Need ${total} (${parts.join(" + ")})`;
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
  const bits: string[] = [];
  for (const step of app.steps) {
    const before = running[step.location];
    const after = before - step.damageApplied;
    running[step.location] = after;
    bits.push(`${SHORT_LOC[step.location]} ${before}->${after}${step.depleted ? "*" : ""}`);
  }
  let text = bits.join(", ");
  if (app.blownOffArms.length > 0)
    text += t(locale, "res.blownOff", { locs: app.blownOffArms.map(shortLoc).join(" + ") });
  if (app.newlyDestroyed.length > 0)
    text += t(locale, "res.destroyedTail", { locs: app.newlyDestroyed.map(shortLoc).join(", ") });
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
