import {
  type ActorQueueActorView,
  AMMO_EXPLOSION_START_HEAT,
  type AmmoBins,
  type AmmoPolicy,
  actorQueue,
  ammoBinId,
  ammoExplosionAvoid,
  ammoExplosionAvoidWithThreshold,
  type CoreComponentStatus,
  type CritSoakName,
  type CritStructureName,
  canFireFromLocation,
  collectAmmoBins,
  consciousnessTarget,
  coreComponentStatus,
  countDestroyedEngine,
  D2D6_AUTO_SUCCESS,
  type DestroyedReason,
  type DestroyedState,
  ENGINE_SLOTS_KILL,
  GYRO_DESTROYED_HITS,
  GYRO_HIT_MOD,
  HEAT_CAP,
  heatDissipation,
  heatDissipationMax,
  internalStructureForTonnage,
  isTorso,
  isUnitAvailable,
  isUnitDestroyed,
  isUnitImmobile,
  type Location,
  type LocationValue,
  loadAmmoBins,
  mapDefFor,
  mechDef,
  mechDefFor,
  movementMpPenalty,
  movementMpPenaltyWithThreshold,
  pooledTotalsByWeaponName,
  type RemovalReason,
  type RemovedState,
  type ResolvedMechDef,
  SENSOR_BLIND_HITS,
  type ShutdownState,
  shutdownAvoid,
  TORSO_LOCATIONS,
  type TorsoLocationValue,
  toHitHeatModifier,
  toHitHeatModifierWithThreshold,
  type UnitDamageState,
  type UnitState,
  weaponDefFor,
} from "btlib10x";
import {
  buildBoardChunk,
  buildCollapsibleChunk,
  buildColumnsChunk,
  buildHeaderTableChunkFromColumns,
  buildLinesChunk,
  type Chunk,
} from "./chunk";
import { compensatedLength, i18n, type MessageKey } from "./i18n";
import {
  F,
  gunneryLabel,
  hexCoordStr,
  PRN,
  requireMechDef,
  SHORT_LOC,
  signedMod,
  TRN,
} from "./misc";
import { createBoardRenderUnit, createEjectedBoardRenderUnits } from "./render";
import { requireBattle, type Session, type SessionGameEvent, victoryBannerChunk } from "./session";
import { critLines, fireSuggestionChunks, resolutionLines } from "./session.weapon";

/** Full heat-scale status for one unit, driven by the `heat` CLI command. */
export function heatStatusLines(unit: UnitState): Chunk {
  const def = mechDefFor(unit);
  const engineOut = countDestroyedEngine(def, unit.damage, unit.critSlotsDestroyed);
  const sinks = heatDissipation(def, unit.critSlotsDestroyed);
  const toHit = toHitHeatModifier(unit.heat);
  const mpPenalty = movementMpPenalty(unit.heat);
  const shutdown = shutdownAvoid(unit.heat);
  const ammo = ammoExplosionAvoid(unit.heat);
  const lines: string[] = [
    i18n("heat.title", { id: unit.id, heat: unit.heat }),
    i18n("heat.sinks", { sinks, engineOut }),
  ];
  if (toHit > 0) lines.push(i18n("heat.toHit", { mod: toHit }));
  if (mpPenalty > 0) lines.push(i18n("heat.mp", { penalty: mpPenalty }));
  if (shutdown === null) lines.push(i18n("heat.shutdownSafe"));
  else lines.push(i18n("heat.shutdown", { avoid: shutdown }));
  if (ammo === null) lines.push(i18n("heat.ammoSafe"));
  else lines.push(i18n("heat.ammo", { avoid: ammo }));
  lines.push(heatStateLabel(unit.shutdown));
  if (unit.heat >= 30) lines.push(i18n("heat.shutdownAuto"));
  return buildLinesChunk(...lines);
}

function heatStateLabel(shutdown: ShutdownState): string {
  if (shutdown === "not") return i18n("heat.stateOnline");
  if (shutdown === "starting") return i18n("heat.stateStarting");
  return i18n("heat.stateDown");
}

/** `board` output: styled grid chunks, or a plain hint when nothing exists. */
export function boardChunk(s: Session): Chunk {
  const mapName = s.setup.mapName;
  if (mapName === null) return buildLinesChunk(i18n("board.noMap"));
  const map = mapDefFor(s.setup);
  if (s.battle) {
    const battleUnits = s.battle.units;
    const units = Object.values(battleUnits)
      .filter((u) => isUnitAvailable(u))
      .map((u) => createBoardRenderUnit(u));
    const ejectedUnits = createEjectedBoardRenderUnits(battleUnits, s.battle.wrecks);
    if (ejectedUnits.length > 0) units.push(...ejectedUnits);
    return buildBoardChunk({ map, units, reachable: null });
  }
  return buildBoardChunk({
    map,
    units: s.setup.roster.map((u) => createBoardRenderUnit(u)),
    reachable: null,
  });
}

// ---------------------------------------------------------------- info ----
export function infoMechChunk(model: string): Chunk[] {
  const d = mechDef(model);
  if (d === undefined) throw new Error(i18n("err.unknownModel", { model }));
  const armorRear: TorsoLocationValue = {} as TorsoLocationValue;
  for (const loc of TORSO_LOCATIONS) {
    const v = d.armorRear[loc];
    if (v !== undefined) armorRear[loc] = v;
  }
  const is = internalStructureForTonnage(d.tonnage);
  const topLines = [
    i18n("info.head", {
      model: d.model,
      name: d.name,
      weightClass: d.weightClass,
      tonnage: d.tonnage,
      techBase: d.techBase,
    }),
    i18n("info.movement", { walk: d.walking, run: d.running, jump: d.jumping }),
  ];
  const weaponLines = [
    i18n("sheet.weaponsHeader", { n: Object.keys(d.weapons).length }),
    ...weaponMountLines(buildMountInfos(d, null, () => ({ jammed: false, destroyed: false }))),
  ];
  return [
    buildHeaderTableChunkFromColumns(
      [i18n("info.specsCol"), i18n("info.armorStructureCol")],
      mergeDiagramToColumns(
        topLines,
        weaponLines,
        armorDiagramInfo({
          armor: d.armor,
          armorRear,
          internalStructure: is,
          originalArmor: d.armor,
          originalArmorRear: armorRear,
          originalStructure: is,
          dissipMax: heatDissipationMax(d),
        }),
      ),
    ),
    critChartChunk(d, null, null),
  ];
}

/**
 * Build the per-mount info rows for sheet / mech-info displays. Every mount
 * of a shared-pool weapon gets the same `shotsMax` (and, if `liveBins` is
 * supplied, the same `shotsLeft`). The first mount by `weapons`-array order
 * is the leader; trailing mounts carry `shotsSharedWith` = leader's 1-based
 * display index so the row can render a `(see #N)` pointer.
 */
function buildMountInfos(
  def: ResolvedMechDef,
  liveBins: Readonly<AmmoBins> | null,
  status: (key: number) => {
    readonly jammed: boolean;
    readonly destroyed: boolean;
  },
): WeaponMountInfo[] {
  const designPool = pooledTotalsByWeaponName(def, loadAmmoBins(def));
  const livePool = liveBins !== null ? pooledTotalsByWeaponName(def, liveBins) : null;
  const entries = Object.entries(def.weapons);
  const firstDisplayByWeapon = new Map<string, number>();
  entries.forEach(([_key, mount], displayIndex) => {
    if (!firstDisplayByWeapon.has(mount.weapon)) {
      firstDisplayByWeapon.set(mount.weapon, displayIndex + 1);
    }
  });
  return entries.map(([keyStr, mount], displayIndex) => {
    const key = Number(keyStr);
    const st = status(key);
    const max = designPool[mount.weapon] ?? null;
    const left = livePool !== null ? (livePool[mount.weapon] ?? 0) : null;
    const leaderDisplay = firstDisplayByWeapon.get(mount.weapon) ?? displayIndex + 1;
    const sharedWith = leaderDisplay !== displayIndex + 1 ? leaderDisplay : null;
    return {
      weapon: mount.weapon,
      location: mount.location,
      shotsLeft: max !== null ? left : null,
      shotsMax: max,
      shotsSharedWith: sharedWith,
      jammed: st.jammed,
      destroyed: st.destroyed,
    };
  });
}

function weaponMountLines(mounts: readonly WeaponMountInfo[]): string[] {
  let nameWidth = 0;
  for (const m of mounts) {
    if (m.weapon.length > nameWidth) nameWidth = m.weapon.length;
  }
  return mounts.map((mount, i) => {
    const w = weaponDefFor(mount);
    const shots =
      mount.shotsMax !== null
        ? mount.shotsSharedWith !== null
          ? i18n("sheet.shotsShared", { ref: mount.shotsSharedWith })
          : mount.shotsLeft !== null
            ? i18n("sheet.shotsRange", { curr: mount.shotsLeft, max: mount.shotsMax })
            : i18n("sheet.shotsDesign", { max: mount.shotsMax })
        : null;
    const flags = [shots, mount.jammed ? i18n("sheet.jammed") : null].filter((x) => x !== null);
    const index = (mount.destroyed ? i18n("sheet.destroyed") : `#${i + 1}`).padStart(3);
    const name = mount.weapon.padEnd(nameWidth);
    const min = (w.minRange === undefined ? "" : `m${w.minRange}/`).padStart(4);
    const short = `S${w.short}`.padStart(3);
    const medium = `M${w.medium}`.padStart(3);
    const long = `L${w.long}`.padStart(3);
    const heat = `H${w.heat ?? 0}`.padStart(3);
    return `${index} ${name} [${SHORT_LOC[mount.location]}] ${min}${short}/${medium}/${long} ${heat}${flags.length ? ` ${flags.join(" ")}` : ""}`;
  });
}

// --------------------------------------------------------------- sheet ----

/** Per-mount presentation info used by sheet and mech-info weapon rows. */
export type WeaponMountInfo = {
  readonly weapon: string;
  readonly location: Location;
  readonly shotsLeft: number | null;
  readonly shotsMax: number | null;
  /**
   * 1-based display index of the leader mount for this weapon's shared ammo
   * pool, when this mount is a trailing follower. `undefined` for leaders and
   * for mounts with no shared pool.
   */
  readonly shotsSharedWith: number | null;
  readonly jammed: boolean;
  readonly destroyed: boolean;
};

interface SheetView {
  readonly id: string;
  readonly team: number;
  readonly model: string;
  readonly name: string;
  readonly weightClass: string;
  readonly tonnage: number;
  readonly gunnery: number | null;
  readonly piloting: number | null;
  readonly pilotHits: number;
  readonly prone: boolean;
  readonly unconscious: boolean;
  readonly walking: number;
  readonly running: number;
  readonly jumping: number;
  readonly removed: RemovedState;
  readonly destroyed: DestroyedState;
  readonly positionLine: string;
  /** Current ammo status: depletion policy, explosion prob; null when the unit carries no ammo. */
  readonly ammoStatusLine: string | null;
  /** Current heat + shutdown state; null when only design info exists. */
  readonly heat: number;
  readonly dissipMax: number;
  readonly dissipCurr: number;
  readonly engineHit: number;
  readonly gyroHit: number;
  readonly sensorHit: number;
  readonly lifeHit: number;
  readonly shutdown: ShutdownState;
  /** Current front armor per location. */
  readonly armor: LocationValue;
  /** Current layered damage (front armor, rear armor, internal structure). */
  readonly damage: UnitDamageState;
  /** Designed (start-of-game) front armor per location. */
  readonly originalArmor: Readonly<LocationValue>;
  /** Designed (start-of-game) rear torso armor. */
  readonly originalArmorRear: Readonly<TorsoLocationValue>;
  /** Designed (start-of-game) internal structure per location. */
  readonly originalArmorStructure: LocationValue;
  readonly mounts: readonly WeaponMountInfo[];
  /** Per-unit live crit state for the crit chart; null when only design info exists. */
  readonly critLive: CritChartLive | null;
  /** Aggregate engine/gyro/sensors/life-support counts (destroyed/total); null when only design info exists. */
  readonly critCounts: CoreComponentStatus | null;
}

export function battleSheet(unit: UnitState, id: string): SheetView {
  // Engine guarantee: `unit.model` was validated by `createBattle`.
  const def = mechDefFor(unit);
  let ammoStatusLine: string | null = null;
  if (collectAmmoBins(def).length > 0) {
    const { avoid, threshold } = ammoExplosionAvoidWithThreshold(unit.heat);
    ammoStatusLine = i18n("sheet.ammoStatus", {
      policy: ammoPolicyLabel(unit.ammoPolicy),
      explosion:
        avoid === 0
          ? i18n("sheet.ammoNoExplosion", {
              heat: unit.heat,
              threshold: AMMO_EXPLOSION_START_HEAT,
            })
          : i18n("sheet.ammoExplosion", { heat: unit.heat, avoid, threshold }),
    });
  }
  const ccStatus = coreComponentStatus(def, unit.damage, unit.critSlotsDestroyed);
  return {
    id: id,
    team: unit.team,
    model: def.model,
    name: def.name,
    weightClass: def.weightClass,
    tonnage: def.tonnage,
    gunnery: unit.gunnery,
    piloting: unit.piloting,
    pilotHits: unit.pilotHits,
    prone: unit.prone,
    unconscious: unit.unconscious,
    walking: def.walking,
    running: def.running,
    jumping: def.jumping,
    removed: unit.removed,
    destroyed: unit.destroyed,
    positionLine: i18n("sheet.at", {
      pos: hexCoordStr(unit.position),
      facing: F(unit.facing),
      posture: PRN(unit.prone),
    }),
    ammoStatusLine: ammoStatusLine,
    heat: unit.heat,
    dissipCurr: heatDissipation(def, unit.critSlotsDestroyed),
    dissipMax: heatDissipationMax(def),
    engineHit: ccStatus.engine,
    gyroHit: ccStatus.gyro,
    sensorHit: ccStatus.sensors,
    lifeHit: ccStatus.lifeSupport,
    shutdown: unit.shutdown,
    armor: unit.damage.armor,
    damage: unit.damage,
    originalArmor: def.armor,
    originalArmorRear: def.armorRear,
    originalArmorStructure: def.internalStructure,
    mounts: buildMountInfos(def, unit.ammoBins, (key) => {
      const mount = def.weapons[key];
      return {
        jammed: unit.jammedWeapons.includes(key),
        destroyed:
          unit.destroyedWeapons.includes(key) ||
          (mount !== undefined && !canFireFromLocation(unit.phaseStartDamage, mount.location)),
      };
    }),
    critLive: {
      critSlotsDestroyed: unit.critSlotsDestroyed,
      destroyedWeapons: unit.destroyedWeapons,
      jammedWeapons: unit.jammedWeapons,
      ammoBins: unit.ammoBins,
      locationDestroyed: (loc) => unit.phaseStartDamage.internalStructure[loc] <= 0,
    },
    critCounts: coreComponentStatus(def, unit.damage, unit.critSlotsDestroyed),
  };
}

interface ArmorInfo {
  readonly armor: LocationValue;
  readonly armorRear: Partial<LocationValue>;
  readonly internalStructure: LocationValue;
  readonly originalArmor: Readonly<LocationValue>;
  readonly originalArmorRear: Partial<LocationValue>;
  readonly originalStructure: LocationValue;
  readonly dissipMax: number;
}

/** ASCII humanoid armor diagram: internal structure (I), front armor (F/A), rear (R). */
/** for 'info mech <model>' command */
function armorDiagramInfo(info: ArmorInfo): string[] {
  const cell = (max: number, label: string) => ` ${String(max).padStart(2)}${label}`;
  const o = info.originalArmor;
  const os = info.originalStructure;
  const or = info.originalArmorRear;
  const rear = (loc: Location) => cell(or[loc] ?? 0, "R");
  const hs = `-${info.dissipMax} `.padStart(4);
  return [
    `          [HD]      [HS]`,
    `          ${cell(os.head, "I")}      ${hs}`,
    `          ${cell(o.head, "A")}`,
    `     [RT] [CT] [LT]`,
    [
      "[RA]",
      cell(os.rightTorso, "I"),
      cell(os.centerTorso, "I"),
      cell(os.leftTorso, "I"),
      "[LA]",
    ].join(" "),
    [
      cell(os.rightArm, "I"),
      cell(o.rightTorso, "F"),
      cell(o.centerTorso, "F"),
      cell(o.leftTorso, "F"),
      cell(os.leftArm, "I"),
    ].join(" "),
    [
      cell(o.rightArm, "A"),
      rear("rightTorso"),
      rear("centerTorso"),
      rear("leftTorso"),
      cell(o.leftArm, "A"),
    ].join(" "),
    `     [RL]      [LL]`,
    `     ${cell(os.rightLeg, "I")}      ${cell(os.leftLeg, "I")}`,
    `     ${cell(o.rightLeg, "A")}      ${cell(o.leftLeg, "A")}`,
  ];
}

function shutdownHeader(view: SheetView): string {
  if (isUnitDestroyed(view.damage)) return "[DESTROYED]";
  switch (view.shutdown) {
    case "manual":
      return "[SHUTDOWN]";
    case "heat":
      return "!SHUTDOWN!";
    case "starting":
      return "[STARTING]";
  }
  if (isUnitImmobile(view.damage)) return "[IMMOBILE]";
  return "[NOMINAL]";
}

// E:-OO L:O
// G:OO S:OO
const GLYPH_CORE_COMPONENT_HIT = "-";
const GLYPH_CORE_COMPONENT_UNHIT = "O";

function engineLifeSupport(view: SheetView): string {
  const e = GLYPH_CORE_COMPONENT_HIT.repeat(view.engineHit).padEnd(
    ENGINE_SLOTS_KILL,
    GLYPH_CORE_COMPONENT_UNHIT,
  );
  const l = view.lifeHit > 0 ? GLYPH_CORE_COMPONENT_HIT : GLYPH_CORE_COMPONENT_UNHIT;
  return `E:${e} L:${l}`;
}

function gyroSensors(view: SheetView): string {
  const g = GLYPH_CORE_COMPONENT_HIT.repeat(view.gyroHit).padEnd(
    GYRO_DESTROYED_HITS,
    GLYPH_CORE_COMPONENT_UNHIT,
  );
  const s = GLYPH_CORE_COMPONENT_HIT.repeat(view.sensorHit).padEnd(
    SENSOR_BLIND_HITS,
    GLYPH_CORE_COMPONENT_UNHIT,
  );
  return `G:${g} S:${s}`;
}

/** ASCII humanoid armor diagram: internal structure (I), front armor (F/A), rear (R). */
/** for 'sheet <id>' command */
function armorDiagramSheet(view: SheetView): string[] {
  const cell = (val: number, max: number, label: string) =>
    `${String(val).padStart(2)}/${String(max).padStart(2)}${label}`;
  const p = (n: number) => " ".repeat(n);
  const CT = 14,
    RT = 7;
  const a = view.armor;
  const o = view.originalArmor;
  const s = view.damage.internalStructure;
  const os = view.originalArmorStructure;
  const ar = view.damage.armorRear;
  const or = view.originalArmorRear;
  const rear = (loc: Location) => (isTorso(loc) ? cell(ar[loc], or[loc], "R") : cell(0, 0, "R"));
  const pRT = p(RT);
  const statusHeader = shutdownHeader(view).padEnd(CT);
  const heatHeader = "[HEAT]".padStart(CT);
  const heat = cell(view.heat, HEAT_CAP, " ").padStart(CT);
  const dissip = cell(-view.dissipCurr, view.dissipMax, " ").padStart(CT);
  const el = engineLifeSupport(view).padEnd(CT);
  const gs = gyroSensors(view).padEnd(CT);
  return [
    `${statusHeader}[ HD ]${heatHeader}`,
    `${el}${cell(s.head, os.head, "I")}${heat}`,
    `${gs}${cell(a.head, o.head, "A")}${dissip}`,
    `       [ RT ] [ CT ] [ LT ]`,
    [
      "[ RA ]",
      cell(s.rightTorso, os.rightTorso, "I"),
      cell(s.centerTorso, os.centerTorso, "I"),
      cell(s.leftTorso, os.leftTorso, "I"),
      "[ LA ]",
    ].join(" "),
    [
      cell(s.rightArm, os.rightArm, "I"),
      cell(a.rightTorso, o.rightTorso, "F"),
      cell(a.centerTorso, o.centerTorso, "F"),
      cell(a.leftTorso, o.leftTorso, "F"),
      cell(s.leftArm, os.leftArm, "I"),
    ].join(" "),
    [
      cell(a.rightArm, o.rightArm, "A"),
      rear("rightTorso"),
      rear("centerTorso"),
      rear("leftTorso"),
      cell(a.leftArm, o.leftArm, "A"),
    ].join(" "),
    `${pRT}[ RL ]        [ LL ]`,
    `${pRT}${cell(s.rightLeg, os.rightLeg, "I")}        ${cell(s.leftLeg, os.leftLeg, "I")}`,
    `${pRT}${cell(a.rightLeg, o.rightLeg, "A")}        ${cell(a.leftLeg, o.leftLeg, "A")}`,
  ];
}

// ------------------------------------------------------- crit slot chart ----

/** Per-unit live crit state shown per slot on the `sheet <id>` chart. */
interface CritChartLive {
  readonly critSlotsDestroyed: Readonly<Record<Location, readonly boolean[]>>;
  readonly destroyedWeapons: readonly number[];
  readonly jammedWeapons: readonly number[];
  /** Per-crit-slot ammo state (identity + remaining shots). */
  readonly ammoBins: Readonly<AmmoBins>;
  /** Location destroyed by damage (phase-start internal structure at 0). */
  readonly locationDestroyed: (location: Location) => boolean;
}

/** i18n key per ammo depletion policy. */
const AMMO_POLICY_KEY: Readonly<Record<AmmoPolicy, MessageKey>> = {
  exposed: "ammo.policy.exposed",
  core: "ammo.policy.core",
  spread: "ammo.policy.spread",
  leastFirst: "ammo.policy.leastFirst",
};

/** Human-friendly i18n label for an ammo depletion policy. */
export function ammoPolicyLabel(policy: AmmoPolicy): string {
  return i18n(AMMO_POLICY_KEY[policy]);
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
  caseII: "critChart.soak.caseII",
};

/** One slot line: dice number + component label, plus live markers. */
function critSlotText(
  def: ResolvedMechDef,
  loc: Location,
  slotIndex: number,
  live: CritChartLive | null,
): string {
  const slot = def.critSlots[loc][slotIndex - 1] ?? { kind: "empty" };
  const dice = slotIndex.toString().padStart(2);
  const markers: string[] = [];
  let body: string;
  if (slot.kind === "empty") {
    body = i18n("critChart.empty");
  } else if (slot.kind === "soak") {
    const key = CRIT_SOAK_KEY[slot.name];
    body = `(${key !== undefined ? i18n(key) : slot.name})`;
  } else if (slot.kind === "weapon") {
    body = slot.weapon;
  } else if (slot.kind === "ammo") {
    body = slot.weapon;
    const binId = ammoBinId(loc, slotIndex);
    const max = loadAmmoBins(def)[binId]?.shots;
    if (max !== undefined) {
      const curr = live !== null ? (live.ammoBins[binId]?.shots ?? max) : max;
      markers.push(
        live === null
          ? i18n("critChart.ammoDesign", { max })
          : i18n("critChart.ammoSuffix", { curr, max }),
      );
    }
  } else {
    const key = CRIT_COMPONENT_KEY[slot.name as CritStructureName];
    body = key !== undefined ? i18n(key) : slot.name;
  }
  const line = ` ${dice} ${body}`;
  if (live !== null && live.critSlotsDestroyed[loc] !== undefined) {
    const slotHit = live.critSlotsDestroyed[loc]?.[slotIndex - 1] ?? false;
    const mountDestroyed =
      slot.kind === "weapon" && live.destroyedWeapons.includes(slot.weaponIndex);
    const mountJammed = slot.kind === "weapon" && live.jammedWeapons.includes(slot.weaponIndex);
    // A location whose internal structure is gone has every slot in it
    // destroyed, even when no crit roll marked them (matches the mount list).
    const locationGone = slot.kind !== "empty" && live.locationDestroyed(loc);
    if (mountJammed) markers.push(i18n("critChart.jammedSuffix"));
    if (slotHit || mountDestroyed || locationGone) {
      markers.push(i18n("critChart.destroyedSuffix"));
    }
  }
  return markers.length > 0 ? `${line}${markers.join("")}` : line;
}

function critCountLine(comp: CritStructureName, hit: number, messageForHit: MessageKey[]): string {
  const maxHit = messageForHit.length;
  const effectiveHit = Math.min(hit, maxHit);
  const effect = effectiveHit === 0 ? "" : `: ${i18n(messageForHit[effectiveHit - 1]!)}`;

  return i18n("critChart.coreComponent", {
    name: i18n(CRIT_COMPONENT_KEY[comp]),
    hit: effectiveHit,
    total: maxHit,
    effect,
  });
}

function critCountLines(counts: CoreComponentStatus | null): string[] {
  const out: string[] = new Array<string>(7).fill("");
  if (counts !== null) {
    out[1] = critCountLine("engine", counts.engine, [
      "critChart.coreComponentEffect.engine1",
      "critChart.coreComponentEffect.engine2",
      "critChart.coreComponentEffect.engine3",
    ]);
    out[2] = critCountLine("gyro", counts.gyro, [
      "critChart.coreComponentEffect.gyro1",
      "critChart.coreComponentEffect.gyro2",
    ]);
    out[3] = critCountLine("sensors", counts.sensors, [
      "critChart.coreComponentEffect.sensor1",
      "critChart.coreComponentEffect.sensor2",
    ]);
    out[4] = critCountLine("lifeSupport", counts.lifeSupport, [
      "critChart.coreComponentEffect.lifeSupport1",
    ]);
  }
  return out;
}

/** Render one location's crit slots as a vertical column (unpadded). */
function critCell(def: ResolvedMechDef, loc: Location, live: CritChartLive | null): string[] {
  const lines = [`[ ${SHORT_LOC[loc]} ]`];
  for (let i = 0; i < def.critSlots[loc].length; i++) {
    lines.push(critSlotText(def, loc, i + 1, live));
  }
  return lines;
}

const GRID_THEME = {
  LIGHT: {
    tnw: "┌", // top left corner of grid
    tn: "┬", // separator for top line of grid
    tne: "┐", // top right corner of grid
    tw: "├", // left end of bottom line of grid
    tc: "┼", // seperator for bottom line of grid
    te: "┤", // right end of bottom line of grid
    tsw: "└", // bottom left corner of grid
    ts: "┴", // separator for bottom line of grid
    tse: "┘", // bottom right corner of grid

    th: "─", // horizontal line of grid
    tv: "│", // vertical line of grid
  },
};

/** Collapsible crit chart: one columns chunk per row (arena / torso / legs). */
function critChartChunk(
  def: ResolvedMechDef,
  live: CritChartLive | null,
  counts: CoreComponentStatus | null,
): Chunk {
  const { tnw, tn, tne, tw, tc, te, tsw, /*ts,*/ tse, th, tv } = GRID_THEME.LIGHT;
  const raLines = critCell(def, "rightArm", live);
  const hdLines = [...critCell(def, "head", live), ...new Array<string>(6).fill("")];
  const laLines = critCell(def, "leftArm", live);
  const rtLines = critCell(def, "rightTorso", live);
  const ctLines = critCell(def, "centerTorso", live);
  const ltLines = critCell(def, "leftTorso", live);
  const rlLines = critCell(def, "rightLeg", live);
  // const infoLines = new Array<string>(7).fill("");
  const infoLines = critCountLines(counts);
  const llLines = critCell(def, "leftLeg", live);
  const built = [raLines, hdLines, laLines, rtLines, ctLines, ltLines, rlLines, infoLines, llLines];
  const maxLineLen = built
    .flat()
    .map((l) => compensatedLength(l))
    .reduce((prev, curr) => (prev > curr ? prev : curr));
  const horzLine = th.repeat(maxLineLen);
  const tvPrefix = (l: string) => tv + l;
  return buildCollapsibleChunk(i18n("critChart.summary"), [
    buildColumnsChunk([
      [`${tnw}${horzLine}`, ...raLines.map(tvPrefix)],
      [`${tn}${horzLine}`, ...hdLines.map(tvPrefix)],
      [`${tn}${horzLine}`, ...laLines.map(tvPrefix)],
      [tne, ...new Array<string>(13).fill(tv)],
    ]),
    buildColumnsChunk([
      [`${tw}${horzLine}`, ...rtLines.map(tvPrefix)],
      [`${tc}${horzLine}`, ...ctLines.map(tvPrefix)],
      [`${tc}${horzLine}`, ...ltLines.map(tvPrefix)],
      [te, ...new Array<string>(13).fill(tv)],
    ]),
    buildColumnsChunk([
      [`${tw}${horzLine}`, ...rlLines.map(tvPrefix), `${tsw}${horzLine}`],
      [`${tc}${horzLine}`, ...infoLines.map(tvPrefix), tse],
      [`${tc}${horzLine}`, ...llLines.map(tvPrefix), `${tsw}${horzLine}`],
      [te, ...new Array<string>(7).fill(tv), tse],
    ]),
  ]);
}

const REMOVAL_REASON_KEY: Readonly<Record<RemovalReason, MessageKey>> = {
  destroyed: "sheet.remove.destroyed",
  pilotEjected: "sheet.remove.pilotEjected",
  pilotKilled: "sheet.remove.pilotKilled",
};
const DESTROYED_REASON_KEY: Readonly<Record<DestroyedReason, MessageKey>> = {
  headDestroyed: "sheet.remove.hdDestroyed",
  centerTorsoDestroyed: "sheet.remove.ctDestroyed",
  cockpitDestroyed: "sheet.remove.cockpitDestroyed",
  headBlownOff: "sheet.remove.hdBlownOff",
  engineDestroyed: "sheet.remove.engineDestroyed",
};

export function sheetIdLine(view: SheetView): string {
  if (view.removed === "not") return i18n("sheet.idLine", { id: view.id, team: view.team });
  if (view.removed === "destroyed" && view.destroyed !== "not") {
    return `${i18n("sheet.idLine", { id: view.id, team: view.team })}${i18n("sheet.removedId", { reason: i18n(DESTROYED_REASON_KEY[view.destroyed]) })}`;
  }
  return `${i18n("sheet.idLine", { id: view.id, team: view.team })}${i18n("sheet.removedId", { reason: i18n(REMOVAL_REASON_KEY[view.removed]) })}`;
}

function sheetMovementLine(view: SheetView): string {
  const { penalty, threshold } = movementMpPenaltyWithThreshold(view.heat);
  if (penalty > 0) {
    return i18n("info.movementHeat", {
      walk: view.walking,
      run: view.running,
      jump: view.jumping,
      penalty,
      threshold,
    });
  }
  return i18n("info.movement", {
    walk: view.walking,
    run: view.running,
    jump: view.jumping,
  });
}

/** Record sheet with armor status per location, side-by-side with ASCII diagram. */
export function sheetLines(view: SheetView): Chunk[] {
  const topLines = [
    i18n("sheet.modelLine", {
      model: view.model,
      name: view.name,
      weightClass: view.weightClass,
      tonnage: view.tonnage,
    }),
  ];
  if (view.gunnery !== null) topLines.push(sheetGunneryLine(view));
  if (view.piloting !== null) topLines.push(sheetPilotLine(view));
  topLines.push(sheetMovementLine(view));
  topLines.push(view.positionLine);
  if (view.ammoStatusLine !== null) topLines.push(view.ammoStatusLine);
  const weaponLines: string[] = [i18n("sheet.weaponsHeader", { n: view.mounts.length })];
  weaponLines.push(...weaponMountLines(view.mounts));
  return [
    buildHeaderTableChunkFromColumns(
      [sheetIdLine(view), i18n("info.armorStructureCol")],
      mergeDiagramToColumns(topLines, weaponLines, armorDiagramSheet(view)),
    ),
    critChartChunk(requireMechDef(view.model), view.critLive, view.critCounts),
  ];
}

function mergeDiagramToColumns(
  topLines: string[],
  weaponLines: string[],
  diagram: string[],
): (readonly string[])[] {
  const leftLineCount = topLines.length + weaponLines.length;
  const rightLineCount = diagram.length;
  if (leftLineCount > rightLineCount) {
    const lineDiff = leftLineCount - rightLineCount;
    const topPad = Math.floor(lineDiff / 2);
    return [
      [...topLines, ...weaponLines],
      [...new Array(topPad).fill(""), ...diagram, ...new Array(lineDiff - topPad).fill("")],
    ];
  }
  if (leftLineCount < rightLineCount) {
    return [
      [...topLines, ...new Array(rightLineCount - leftLineCount).fill(""), ...weaponLines],
      diagram,
    ];
  }
  return [[...topLines, ...weaponLines], diagram];
}

export function sheetForUnit(s: Session, id: string): Chunk[] {
  const unit = requireBattle(s).units[id];
  if (!unit) throw new Error(i18n("err.unknownUnitId", { id }));
  return sheetLines(battleSheet(unit, id));
}

/** Brief unit list grouped by team: id, model, position with facing. */
export function unitBriefList(s: Session): Chunk {
  const battle = s.battle!;
  const lines: string[] = [];
  const teams = [...new Set(Object.values(battle.units).map((u) => u.team))].sort((a, b) => a - b);
  for (const team of teams) {
    lines.push(i18n("setup.teamHeader", { team }));
    for (const [uid, unit] of Object.entries(battle.units).filter(([, u]) => u.team === team)) {
      // Engine guarantee: `unit.model` was validated by `createBattle`.
      const def = mechDefFor(unit);
      const flags = `${unit.prone ? " PRONE" : ""}${unit.unconscious ? " UNCONSCIOUS" : ""}`;
      lines.push(
        `  ${uid}  ${def.model}  ${hexCoordStr(unit.position)} facing ${unit.facing}${flags}`,
      );
      const view = battleSheet(unit, uid);
      lines.push(...mechStatusLines(view).map((l) => `    ${l}`));
    }
  }
  return buildLinesChunk(...lines);
}

function sheetGunneryLine(view: SheetView): string {
  const { toHit, threshold } = toHitHeatModifierWithThreshold(view.heat);
  const gunnery = view.gunnery!;
  return toHit > 0
    ? i18n("sheet.gunneryLineHeat", {
        gunnery: gunneryLabel(gunnery),
        toHit,
        threshold,
      })
    : i18n("sheet.gunneryLine", { gunnery: gunneryLabel(gunnery) });
}

function sheetPilotLine(view: SheetView): string {
  const killed = consciousnessTarget(view.pilotHits) === null;
  return i18n("sheet.pilotLine", {
    piloting: view.piloting!,
    hits: view.pilotHits,
    state: i18n(
      killed ? "sheet.pilotKilled" : view.unconscious ? "sheet.pilotOut" : "sheet.pilotOk",
    ),
  });
}

export function sheetLinesShort(view: SheetView): string[] {
  const head = i18n("sheet.modelLine", {
    model: view.model,
    name: view.name,
    weightClass: view.weightClass,
    tonnage: view.tonnage,
  });
  const lines = [head];
  if (view.gunnery !== null) lines.push(sheetGunneryLine(view));
  if (view.piloting !== null) lines.push(sheetPilotLine(view));
  lines.push(view.positionLine, ...mechStatusLines(view));
  return lines;
}

/** One-line summary of each crit-affected component (engine/gyro/sensors/life-support). */
function critEffectLines(counts: CoreComponentStatus | null): string | null {
  if (counts === null) return null;
  const out: string[] = [];
  if (counts.engine >= 1) {
    out.push(
      i18n("sheet.critEffect.engine", {
        destroyed: counts.engine,
        total: ENGINE_SLOTS_KILL,
      }),
    );
  }
  if (counts.gyro >= 1) {
    out.push(
      i18n("sheet.critEffect.gyro", {
        destroyed: counts.gyro,
        total: GYRO_DESTROYED_HITS,
        mod: GYRO_HIT_MOD,
      }),
    );
  }
  if (counts.sensors >= 1) {
    out.push(
      i18n("sheet.critEffect.sensors", {
        destroyed: counts.sensors,
        total: SENSOR_BLIND_HITS,
      }),
    );
  }
  if (counts.lifeSupport >= 1) {
    out.push(i18n("sheet.critEffect.lifeSupport"));
  }
  return out.length > 0 ? `  ${out.join(" ")}` : null;
}

/** Compact two-line armor summary: head+torso on line 1, limbs on line 2.
 * Each location shows front + rear + internal-structure summed as `cur/max`,
 * with `[-F]`/`[-R]`/`[-A]`/`[-I]` annotations for depleted pools. */
function mechStatusLines(view: SheetView): string[] {
  const status = isUnitDestroyed(view.damage)
    ? i18n("sheet.statusDestroyed")
    : view.shutdown === "not"
      ? i18n("sheet.statusOnline")
      : view.shutdown === "starting"
        ? i18n("sheet.statusStarting")
        : i18n("sheet.statusShutdown");
  const lines: string[] = [
    i18n("sheet.statusHeader", { status, currHeat: view.heat, maxHeat: HEAT_CAP }),
    `  ${durabilityFrag(view, "head")} ${durabilityFrag(view, "leftTorso")} ${durabilityFrag(view, "centerTorso")} ${durabilityFrag(view, "rightTorso")}`,
    `  ${durabilityFrag(view, "leftArm")} ${durabilityFrag(view, "rightArm")} ${durabilityFrag(view, "leftLeg")} ${durabilityFrag(view, "rightLeg")}`,
  ];
  const critLine = critEffectLines(view.critCounts);
  if (critLine !== null) lines.push(critLine);
  return lines;
}

function durabilityFrag(view: SheetView, loc: Location): string {
  const frontCur = view.armor[loc];
  const torso = isTorso(loc);
  const frontMax = view.originalArmor[loc];
  const structCur = view.damage.internalStructure[loc];
  const structMax = view.originalArmorStructure[loc];
  const rearCur = torso ? (view.damage.armorRear[loc] ?? 0) : 0;
  const rearMax = torso ? (view.originalArmorRear[loc] ?? 0) : 0;
  const cur = frontCur + rearCur + structCur;
  const max = frontMax + rearMax + structMax;

  // Build annotation from depleted pool letters
  let note = "";
  if (cur > 0) {
    if (torso) {
      if (frontCur <= 0) note += "F";
      if (rearCur <= 0) note += "R";
    } else {
      if (frontCur <= 0) note += "A";
    }
    if (structCur <= 0) note += "I";
    if (note.length > 0) note = `[-${note}]`;
  }

  return `${SHORT_LOC[loc]}(${cur}/${max}${note})`;
}

function queueActorViewStr(av: ActorQueueActorView | undefined): string {
  if (av === undefined) return i18n("status.none");
  return i18n(av.hasPriority ? "status.actorViewPriority" : "status.actorView", {
    id: av.id,
    team: av.team,
  });
}

/** Turn-order section for the `status` command: who acted, who is next, who
 *  remains. Appended to the phase-specific status lines. */
export function actorOrderLines(s: Session): string[] {
  const q = actorQueue(requireBattle(s));
  const list = (ids: readonly ActorQueueActorView[]): string =>
    ids.length > 0 ? ids.map((a) => queueActorViewStr(a)).join(", ") : i18n("status.none");
  return [
    i18n("status.orderHeader", { init: q.initiative ?? "-" }),
    i18n("status.done", { ids: list(q.acted) }),
    i18n("status.current", { id: queueActorViewStr(q.pending[0]) }),
    i18n("status.pendingAfter", { ids: list(q.pending.slice(1)) }),
  ];
}

const _UNIT_ID_PREFIX_REGEX = /^\[[^\]]+\] /;

export function handleSessionGameEvents(s: Session, events: SessionGameEvent[]): Chunk[] {
  const result: Chunk[] = [];
  const linesBuf: string[] = [];
  const idLinesBuf: string[] = [];
  const { tnw, tsw, tv } = GRID_THEME.LIGHT;
  let lastUnitPrefix: string = "";
  let skipUnitPrefix: boolean = false;
  const flushIdLinesBuf = () => {
    const bufferedLen = idLinesBuf.length;
    if (bufferedLen > 0) {
      const prefixLen = lastUnitPrefix.length;
      const blank = " ".repeat(prefixLen);
      const firstLine = idLinesBuf[0]!;
      if (bufferedLen === 1) {
        if (skipUnitPrefix) {
          linesBuf.push(`${blank} ${firstLine}`);
        } else {
          linesBuf.push(`${lastUnitPrefix} ${firstLine}`);
        }
      } else {
        if (skipUnitPrefix) {
          linesBuf.push(`${blank}${tnw} ${firstLine}`);
        } else {
          linesBuf.push(`${lastUnitPrefix}${tnw} ${firstLine}`);
        }
        for (let i = 1; i < bufferedLen - 1; i++) {
          linesBuf.push(`${blank}${tv} ${idLinesBuf[i]!}`);
        }
        linesBuf.push(`${blank}${tsw} ${idLinesBuf[bufferedLen - 1]!}`);
      }
      idLinesBuf.length = 0;
    }
    lastUnitPrefix = "";
    skipUnitPrefix = false;
  };
  const flushLinesBuf = () => {
    flushIdLinesBuf();
    if (linesBuf.length > 0) {
      result.push(buildLinesChunk(...linesBuf));
      linesBuf.length = 0;
    }
  };
  const lines = (...lines: string[]) => {
    if (lines.length === 0) return;
    flushIdLinesBuf();
    linesBuf.push(...lines);
  };
  const idLines = (id: string, ...lines: string[]) => {
    if (lines.length === 0) return;
    const currUnitPrefix = `[${id}]`;
    const firstLine = lines.shift()!;
    const firstLineHasPrefix = firstLine.startsWith(currUnitPrefix);
    if (lastUnitPrefix !== currUnitPrefix) {
      flushIdLinesBuf();
      lastUnitPrefix = currUnitPrefix;
    }
    if (firstLineHasPrefix) {
      idLinesBuf.push(firstLine.substring(currUnitPrefix.length).trimStart());
    } else {
      if (idLinesBuf.length === 0) {
        skipUnitPrefix = true;
        linesBuf.push(firstLine);
      }
    }
    idLinesBuf.push(...lines);
  };
  const chunks = (...chunks: Chunk[]) => {
    flushLinesBuf();
    result.push(...chunks);
  };
  for (const e of events) handleSessionGameEvent(s, e, lines, idLines, chunks);
  flushLinesBuf();
  return result;
}

function handleSessionGameEvent(
  s: Session,
  e: SessionGameEvent,
  lines: (...lines: string[]) => void,
  idLines: (id: string, ...lines: string[]) => void,
  chunks: (...chunks: Chunk[]) => void,
): void {
  switch (e.kind) {
    case "phase":
      {
        const phaseLine = i18n("log.phase", { turn: e.turn, phase: e.phase });
        const len = compensatedLength(phaseLine);
        const separator = "-".repeat(len);
        lines(" ", separator, phaseLine, separator);
      }
      break;
    case "initiative":
      {
        const rolls = Object.entries(e.rolls)
          .sort((a, b) => Number(a[0]) - Number(b[0]))
          .map(([team, roll]) => `team ${team} (2D6: ${roll})`)
          .join(", ");
        lines(i18n("log.initiative", { rolls, winner: e.winnerTeam }));
      }
      break;
    case "moveDeclared":
      idLines(e.unitId, i18n("log.moveDeclared", { id: e.unitId, mode: e.mode }));
      break;
    case "moved":
      if (e.mode === "prone") {
        idLines(e.unitId, i18n("log.droppedProne", { id: e.unitId }));
        break;
      }
      if (e.prevMode === "prone") {
        idLines(e.unitId, i18n("log.stoodUp", { id: e.unitId }));
        break;
      }
      idLines(
        e.unitId,
        i18n("log.moved", {
          id: e.unitId,
          mode: e.mode,
          pos: hexCoordStr(e.position),
          facing: e.facing,
          mp: e.mpSpent,
          budget: e.mpBudget,
        }),
      );
      break;
    case "attacksDeclared":
      idLines(
        e.unitId,
        i18n(e.count === 1 ? "log.attacksDeclaredOne" : "log.attacksDeclaredOther", {
          id: e.unitId,
          target: e.targetId,
          count: e.count,
          rangeCtx: `range ${e.distance} (${e.rangeBracket}, ${signedMod(e.rangeMod)})`,
        }),
      );
      break;
    case "attackResolved":
      idLines(e.unitId, `[${e.unitId} -> ${e.targetId}]`, ...resolutionLines(e.resolution));
      break;
    case "unitRemoved":
      switch (e.reason) {
        case "pilotEjected":
          idLines(e.unitId, i18n("log.ejected", { id: e.unitId }));
          break;
        case "pilotKilled":
          idLines(e.unitId, i18n("log.pilotKilled", { id: e.unitId }));
          break;
      }
      idLines(e.unitId, i18n("log.destroyed", { id: e.unitId, destroyed: e.destroyReason! }));
      break;
    case "buildingCollapsed":
      lines(i18n("log.buildingCollapsed", { hex: `${e.col},${e.row}` }));
      break;
    case "buildingDamaged":
      lines(
        i18n("log.buildingDamaged", {
          hex: `${e.col},${e.row}`,
          damage: e.damage,
          cf: e.cf,
        }),
      );
      break;
    case "collapseDamage":
      lines(
        i18n("log.collapseDamage", {
          id: e.unitId,
          hex: `${e.col},${e.row}`,
          loc: SHORT_LOC[e.location],
          damage: e.damage,
        }),
      );
      break;
    case "heatMove":
      idLines(
        e.unitId,
        i18n("log.heatMove", {
          id: e.unitId,
          heat: e.heat,
          base: e.base,
          total: e.totalGenerated,
        }),
      );
      break;
    case "heatWeapon":
      idLines(
        e.unitId,
        i18n("log.heatWeapon", {
          id: e.unitId,
          weapon: e.weapon,
          heat: e.heat,
          base: e.base,
          total: e.totalGenerated,
        }),
      );
      break;
    case "heatEngineCrit":
      idLines(
        e.unitId,
        i18n("log.heatEngineCrit", {
          id: e.unitId,
          heat: e.heat,
          base: e.base,
          total: e.totalGenerated,
        }),
      );
      break;
    case "heatDissipated":
      idLines(
        e.unitId,
        i18n("log.heatDissipated", {
          id: e.unitId,
          dissip: e.dissip,
          start: e.startHeat,
          total: e.totalGenerated,
          end: e.endHeat,
          net: e.netChange,
          cap: e.capacity,
          capMax: e.capacityMax,
        }),
      );
      break;
    case "shutdownCheck":
      if (e.manual) {
        idLines(e.unitId, i18n("log.shutdownManual", { id: e.unitId }));
        break;
      }
      if (e.avoided) {
        idLines(
          e.unitId,
          i18n("log.shutdownAvoided", {
            id: e.unitId,
            roll: e.roll,
            heat: e.heat,
            avoid: e.avoid,
            threshold: e.threshold,
          }),
        );
        break;
      }
      if (e.avoid >= D2D6_AUTO_SUCCESS) {
        idLines(
          e.unitId,
          i18n("log.shutdownAuto", { id: e.unitId, heat: e.heat, threshold: e.threshold }),
        );
        break;
      }
      idLines(
        e.unitId,
        i18n("log.shutdown", {
          id: e.unitId,
          roll: e.roll,
          heat: e.heat,
          avoid: e.avoid,
          threshold: e.threshold,
        }),
      );
      break;
    case "restartCheck":
      if (e.manual && e.success) {
        idLines(
          e.unitId,
          i18n("log.startupSuccess", {
            id: e.unitId,
            roll: e.roll,
            heat: e.heat,
            avoid: e.avoid,
          }),
        );
        break;
      }
      if (e.manual) {
        idLines(
          e.unitId,
          i18n("log.startupFailed", {
            id: e.unitId,
            roll: e.roll,
            heat: e.heat,
            avoid: e.avoid,
          }),
        );
        break;
      }
      if (e.success && e.avoid === 0) {
        idLines(
          e.unitId,
          i18n("log.restartedNoCheck", {
            id: e.unitId,
            heat: e.heat,
            threshold: e.threshold,
          }),
        );
        break;
      }
      if (e.success) {
        idLines(
          e.unitId,
          i18n("log.restarted", {
            id: e.unitId,
            roll: e.roll,
            heat: e.heat,
            avoid: e.avoid,
            threshold: e.threshold,
          }),
        );
        break;
      }
      idLines(
        e.unitId,
        i18n("log.restartFailed", {
          id: e.unitId,
          roll: e.roll,
          heat: e.heat,
          avoid: e.avoid,
          threshold: e.threshold,
        }),
      );
      break;
    case "ammoExplosionCheck":
      if (e.avoided) {
        idLines(
          e.unitId,
          i18n("log.ammoExplosionAvoidCheck", {
            id: e.unitId,
            weapon: e.weapon,
            loc: SHORT_LOC[e.location],
            slot: String(e.slotIndex),
            roll: e.roll,
            heat: e.heat,
            avoid: e.avoid,
            threshold: e.threshold,
            verdict: i18n("log.psrSuccess"),
          }),
        );
        break;
      }
      idLines(
        e.unitId,
        i18n("log.ammoExplosionAvoidCheck", {
          id: e.unitId,
          weapon: e.weapon,
          loc: SHORT_LOC[e.location],
          slot: String(e.slotIndex),
          roll: e.roll,
          heat: e.heat,
          avoid: e.avoid,
          threshold: e.threshold,
          verdict: i18n("log.psrFail"),
        }),
        i18n("log.heatAmmoExplosion", {
          shots: e.shotsRemaining,
          damage: e.damage,
          damagePerShot: e.damagePerShot,
        }),
      );
      break;
    case "pilotingCheck":
      {
        const verdict = e.success ? i18n("log.psrSuccess") : i18n("log.psrFail");
        idLines(
          e.unitId,
          i18n("log.pilotingCheck", {
            id: e.unitId,
            reason: e.reason,
            target: e.target,
            roll: e.roll === null ? i18n("log.psrAuto") : String(e.roll),
            verdict,
          }),
        );
      }
      break;
    case "unitFell":
      {
        const lines = [
          i18n("log.unitFell", {
            id: e.unitId,
            cause: e.cause,
            facing: e.facingAfter,
            groups: e.groups.map((g) => `${SHORT_LOC[g.location]}(${g.damage})`).join(" "),
            damage: e.totalDamage,
            levels: e.levelsFallen,
          }),
        ];
        for (const crit of e.crits) {
          for (const line of critLines(crit)) lines.push(`  ${line}`);
        }
        idLines(e.unitId, ...lines);
      }
      break;
    case "pilotDamaged":
      idLines(
        e.unitId,
        i18n("log.pilotDamaged", { id: e.unitId, reason: e.reason, total: e.totalHits }),
      );
      break;
    case "consciousnessCheck":
      {
        const { unitId, roll, target, success, consciousBefore } = e;
        if (consciousBefore && !success) {
          idLines(e.unitId, i18n("log.pilotUnconscious", { id: unitId, roll, target }));
          break;
        }
        if (!consciousBefore && success) {
          idLines(e.unitId, i18n("log.pilotRecovered", { id: unitId, roll, target }));
          break;
        }
        idLines(
          e.unitId,
          i18n(success ? "log.consciousnessCheckSuccess" : "log.consciousnessCheckFail", {
            id: unitId,
            roll,
            target,
          }),
        );
      }
      break;
    case "buildingCrash":
      {
        const lines = [
          i18n("log.buildingCrash", {
            id: e.unitId,
            hex: `${e.col},${e.row}`,
            groups: e.groups.map((g) => `${SHORT_LOC[g.location]}(${g.damage})`).join(" "),
            damage: e.totalDamage,
          }),
        ];
        for (const crit of e.crits) {
          for (const line of critLines(crit)) lines.push(`  ${line}`);
        }
        idLines(e.unitId, ...lines);
      }
      break;
    case "sessionMoveActor":
      idLines(
        e.actorId,
        i18n("log.moveActor", {
          id: e.actorId,
          pos: hexCoordStr(e.position),
          facing: F(e.facing),
          posture: PRN(e.prone),
          terrain: TRN(e.terrain),
          elevation: e.elevation,
        }),
        i18n("mode.hint", { modes: e.modes }),
      );
      break;
    case "sessionMoveActorDone":
      break;
    case "sessionAttackActor":
      chunks(...fireSuggestionChunks(s));
      break;
    case "sessionAttackActorDone":
      if (e.pass) {
        lines(i18n("log.attacksPassed", { id: e.actorId }));
        break;
      }
      break;
    case "sessionPhase":
      if (e.phase === "weaponAttackResolution") {
        lines(i18n("res.attackResolutionStart"));
      }
      break;
    case "sessionPhaseDone":
      if (e.phase === "weaponAttackResolution") {
        lines(i18n("res.attackResolutionEnd"));
      }
      break;
    case "sessionOver":
      chunks(victoryBannerChunk(s));
      break;
    default: {
      // Exhaustiveness guard: adding a GameEvent kind must add a case above.
      const unreachable: never = e;
      throw new Error(unreachable);
    }
  }
}
