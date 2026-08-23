import type { BattleState, GameEvent, UnitState } from "../src/rules/game.js";
import type { AttackResolution } from "../src/rules/attack.js";
import type { ArmorState } from "../src/rules/damage.js";
import { canFireFromLocation } from "../src/rules/damage.js";
import { getMapDef, MAP_DEFS, MECH_DEFS, toEngineTerrain } from "../src/data/index.js";
import type { MechDef } from "../src/data/schema.js";
import { getWeapon } from "../src/data/weapons.js";
import type { Location, MoveMode } from "../src/core/types.js";
import { LOCATIONS } from "../src/core/types.js";
import { renderBattle, renderMap } from "../src/render.js";
import type { Session, SetupUnit } from "./session.js";
import { moveStepsInfo } from "./session.js";

/** Display coordinates are 1-based (printed mapsheet labels). */
function disp(hex: { col: number; row: number }): string {
  return `(${hex.col + 1},${hex.row + 1})`;
}

function mapDims(s: Session): [number, number] | undefined {
  if (!s.mapName) return undefined;
  const map = getMapDef(s.mapName);
  return map ? [map.width, map.height] : undefined;
}

export function boardLines(s: Session): string[] {
  const dims = mapDims(s);
  if (!s.battle) {
    const units = Object.fromEntries(
      s.roster.map((u) => [u.id, { position: u.position, removed: false }]),
    ) as BattleState["units"];
    const terrain: Record<string, string> = {};
    for (const t of s.terrainDefs) terrain[`${t.col},${t.row}`] = t.type;
    return renderBattle({ units, terrain } as BattleState, dims?.[0], dims?.[1]).split("\n");
  }
  return renderBattle(s.battle, dims?.[0], dims?.[1]).split("\n");
}

// ---------------------------------------------------------------- info ----

export function infoMechList(): string[] {
  return Object.values(MECH_DEFS).map(
    (d) => `${d.model.padEnd(8)} ${d.name} (${d.weightClass}) walk/run/jump ${d.walking}/${d.running}/${d.jumping}`,
  );
}

export function infoMech(model: string): string[] {
  const d = requireMechDef(model);
  return [
    `${d.model} ${d.name} — ${d.weightClass} ${d.tonnage}t (${d.techBase})`,
    `movement: walk ${d.walking} / run ${d.running} / jump ${d.jumping}`,
    `weapons (${d.weapons.length}):`,
    ...weaponSummary(d),
  ];
}

const TERRAIN_LEGEND = "legend: w lightWoods  W heavyWoods  (blank = clear)";

export function infoMapList(): string[] {
  return Object.entries(MAP_DEFS).map(([name, m]) => `${name}: ${m.width}x${m.height}, ${m.terrain.length} terrain hexes`);
}

export function infoMap(name: string): string[] {
  const map = MAP_DEFS[name];
  if (!map) throw new Error(`Unknown map ${name}; available: ${Object.keys(MAP_DEFS).join(", ")}`);
  const counts = new Map<string, number>();
  for (const t of map.terrain) counts.set(t.type, (counts.get(t.type) ?? 0) + 1);
  const breakdown = [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([type, n]) => `${type} ${n}`)
    .join(", ");
  const grid = renderMap(toEngineTerrain(map), map.width, map.height);
  return [
    `${name}: ${map.width}x${map.height}`,
    `terrain: ${breakdown || "none"}`,
    TERRAIN_LEGEND,
    "",
    ...grid.split("\n"),
  ];
}

function requireMechDef(model: string): MechDef {
  const def = MECH_DEFS[model];
  if (!def) throw new Error(`Unknown 'Mech model: ${model} (try 'info mech')`);
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
  readonly armor: ArmorState;
  readonly mounts: readonly {
    readonly weapon: string;
    readonly location: Location;
    readonly ammoLeft: number | null;
    readonly jammed: boolean;
    readonly destroyed: boolean;
  }[];
}

function battleSheet(battle: BattleState, unit: UnitState): SheetView {
  const def = battle.defs[unit.model]!;
  return {
    model: def.model,
    name: def.name,
    weightClass: def.weightClass,
    tonnage: def.tonnage,
    gunnery: unit.gunnery,
    facingLine: `at ${disp(unit.position)} facing ${unit.facing}` +
      (unit.moveMode !== null ? `, ${unit.moveMode} [mp ${unit.mpSpent}]` : "") +
      (unit.removed ? " — REMOVED FROM PLAY" : ""),
    armor: unit.armor,
    mounts: def.weapons.map((mount, i) => ({
      weapon: mount.weapon,
      location: mount.location,
      ammoLeft: mount.ammoShots !== undefined ? (unit.ammoLeft[i] ?? 0) : null,
      jammed: unit.jammedWeapons.includes(i),
      destroyed: !canFireFromLocation(unit.phaseStartArmor, mount.location),
    })),
  };
}

function setupSheet(unit: SetupUnit): SheetView {
  const def = requireMechDef(unit.model);
  return {
    model: def.model,
    name: def.name,
    weightClass: def.weightClass,
    tonnage: def.tonnage,
    gunnery: unit.gunnery,
    facingLine: `at ${disp(unit.position)} facing ${unit.facing}`,
    armor: { ...def.armor } as ArmorState,
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
export function sheetLines(view: SheetView): string[] {
  const head = `${view.model} ${view.name} — ${view.weightClass} ${view.tonnage}t` +
    (view.gunnery !== null ? ` gunnery ${view.gunnery}` : "");
  const lines = [head];
  if (view.facingLine) lines.push(view.facingLine);
  lines.push(
    `armor: ${LOCATIONS.map((loc) => {
      const v = view.armor[loc];
      return `${SHORT_LOC[loc]} ${v}${v <= 0 ? "!" : ""}`;
    }).join(" | ")}`,
  );
  lines.push(`weapons (${view.mounts.length}):`);
  for (const [i, m] of view.mounts.entries()) {
    const w = getWeapon(m.weapon);
    const flags = [
      m.ammoLeft !== null ? `ammo ${m.ammoLeft}` : null,
      m.jammed ? "[JAMMED]" : null,
      m.destroyed ? "[DESTROYED]" : null,
    ].filter((x) => x !== null);
    lines.push(`  #${i} ${m.weapon} (${SHORT_LOC[m.location]}) S${w.short}/M${w.medium}/L${w.long}${flags.length ? " " + flags.join(" ") : ""}`);
  }
  return lines;
}

export function sheetForUnit(s: Session, id: string): string[] {
  if (s.battle) {
    const unit = s.battle.units[id];
    if (!unit) throw new Error(`Unknown unit id: ${id}`);
    return sheetLines(battleSheet(s.battle, unit));
  }
  const placed = s.roster.find((u) => u.id === id);
  if (!placed) throw new Error(`No such unit: ${id}`);
  return sheetLines(setupSheet(placed));
}

// -------------------------------------------------------------- status ----

export function fmtSetupStatus(s: Session): string[] {
  const lines: string[] = [`map: ${s.mapName ?? "(none)"}`, `terrain hexes: ${s.terrainDefs.length}`];
  const teams = [...new Set(s.roster.map((u) => u.team))].sort((a, b) => a - b);
  for (const team of teams) {
    lines.push(`team ${team}:`);
    for (const u of s.roster.filter((x) => x.team === team)) {
      const def = MECH_DEFS[u.model]!;
      lines.push(`  ${u.id}  ${u.model} (${def.name}) gunnery ${u.gunnery} @ ${disp(u.position)} facing ${u.facing}`);
    }
  }
  if (teams.length === 0) lines.push("(no units placed)");
  return lines;
}

export function moveStatusLines(s: Session): string[] {
  const info = moveStepsInfo(s);
  const modeText = info.mode === null ? "(mode not declared)" : `mode: ${info.mode}`;
  const lines = [modeText, `budget: ${info.budget} MP`];
  if (info.steps.length === 0) {
    lines.push("(no steps queued)");
  } else {
    for (const step of info.steps) {
      lines.push(`${step.label} +${step.mpCost} MP (total ${step.mpAfter})`);
    }
  }
  return lines;
}

export function attackStatusLines(s: Session): string[] {
  const actor = s.battle?.units[s.actorId ?? ""];
  if (!actor || !s.battle) throw new Error("Command requires the weaponAttack phase");
  if (s.fireDecls.length === 0) return ["(no attacks queued)"];
  const def = s.battle.defs[actor.model]!;
  return s.fireDecls.map((decl) => {
    const mount = def.weapons[decl.weaponIndex];
    const name = mount ? mount.weapon : `#${decl.weaponIndex}`;
    return `#${decl.weaponIndex} ${name} -> ${decl.targetId}${decl.shots !== undefined ? ` x${decl.shots}` : ""}`;
  });
}

export function weaponsLines(s: Session, unitId?: string): string[] {
  const id = unitId ?? s.actorId;
  const unit = id !== undefined && id !== null && id !== "" ? s.battle?.units[id] : undefined;
  if (!unit || !s.battle) throw new Error(`Unknown unit id: ${unitId ?? "(no active unit)"}`);
  const def = s.battle.defs[unit.model]!;
  return def.weapons.map((mount, i) => {
    const w = getWeapon(mount.weapon);
    const bits = [
      `#${i}`,
      mount.weapon,
      mount.location,
      `S${w.short}/M${w.medium}/L${w.long}`,
      mount.ammoShots !== undefined ? `ammo ${unit.ammoLeft[i] ?? 0}` : null,
      unit.jammedWeapons.includes(i) ? "[JAMMED]" : null,
      canFireFromLocation(unit.phaseStartArmor, mount.location) ? null : "[DESTROYED]",
    ].filter((b) => b !== null);
    return bits.join("  ");
  });
}

// ------------------------------------------------------------------ log ----

export function fmtLog(events: readonly GameEvent[], n: number = events.length): string[] {
  return events.slice(-n).flatMap((e) => {
    switch (e.kind) {
      case "turn":
        return [`-- turn ${e.turn} --`];
      case "phase":
        return [`phase: ${e.phase}`];
      case "initiative": {
        const rolls = Object.entries(e.rolls)
          .sort((a, b) => Number(a[0]) - Number(b[0]))
          .map(([team, roll]) => `t${team}=${roll}`)
          .join(" ");
        return [`initiative: team ${e.winnerTeam} wins (${rolls})`];
      }
      case "moveDeclared":
        return [`${e.unitId} declares ${e.mode}`];
      case "moved":
        return [`${e.unitId} ${e.mode} -> ${disp(e.position)} facing ${e.facing} [mp ${e.mpSpent}]`];
      case "attacksDeclared":
        return [`${e.unitId} fires at ${e.targetId} (${e.count} weapon${e.count === 1 ? "" : "s"})`];
      case "attackResolved":
        return resolutionLines(e.resolution);
      case "unitDestroyed":
        return [`*** ${e.unitId} DESTROYED ***`];
      case "unitRemoved":
        return [`${e.unitId} removed from play`];
    }
  });
}

function signedMod(n: number): string {
  return n >= 0 ? `+${n}` : String(n);
}

function gatorText(r: AttackResolution): string {
  if (r.breakdown.outOfRange) return "out of range";
  const b = r.breakdown;
  const parts = [`G${b.gunnery}`];
  if (b.attackerMod) parts.push(`A${signedMod(b.attackerMod)}`);
  if (b.targetMod) parts.push(`M${signedMod(b.targetMod)}`);
  if (b.terrainMod) parts.push(`T${signedMod(b.terrainMod)}`);
  if (b.rangeMod) parts.push(`R${signedMod(b.rangeMod)}`);
  if (b.pulseMod) parts.push(`P${signedMod(b.pulseMod)}`);
  return `TN ${b.automatic === "hit" ? "auto" : b.total} (${parts.join(" ")})`;
}

export function resolutionLines(r: AttackResolution): string[] {
  if (r.breakdown.outOfRange) return [`${r.weapon} @ ${r.distance}: out of range`];
  const verdict = r.breakdown.automatic === "hit" ? "auto-hit" : r.hit ? "HIT" : "MISS";
  const lines = [`${r.weapon} @ ${r.distance}: ${gatorText(r)}, roll ${r.toHitRoll} -> ${verdict}${r.jammed ? " JAMMED" : ""}`];
  if (r.clusterRoll !== null) lines.push(`  cluster roll ${r.clusterRoll}`);
  if (r.hit && r.groups.length > 0) {
    lines.push(`  hits: ${r.groups.map((g) => `${SHORT_LOC[g.location]}(${g.damage})`).join(" ")}`);
    const detail = transferDetail(r);
    if (detail) lines.push(`  ${detail}`);
  }
  return lines;
}

/**
 * Reconstruct before->after armor numbers per transfer step by working back
 * from the final armor state (resolutions carry no pre-damage snapshot).
 */
function transferDetail(r: AttackResolution): string | null {
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
  if (app.blownOffArms.length > 0) text += `; ${app.blownOffArms.map(shortLoc).join(" + ")} blown off`;
  if (app.newlyDestroyed.length > 0) text += `; destroyed ${app.newlyDestroyed.map(shortLoc).join(", ")}`;
  return text;
}

function shortLoc(loc: Location): string {
  return SHORT_LOC[loc];
}

function weaponSummary(def: MechDef): string[] {
  return def.weapons.map((mount, i) => {
    const w = getWeapon(mount.weapon);
    const ammo = mount.ammoShots !== undefined ? ` ammo ${mount.ammoShots}` : "";
    return `  #${i} ${mount.weapon} (${SHORT_LOC[mount.location]}) S${w.short}/M${w.medium}/L${w.long}${ammo}`;
  });
}
