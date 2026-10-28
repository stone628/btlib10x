/** Screen-to-screen flow: launch, deployment, battle start, AI pacing, rematch. */
import {
  buildUnitInit,
  catalogMaps,
  cellAt,
  ensureMapRegistered,
  type Facing,
  type HexCoord,
  isHull,
  isUnitOnBoard,
  type MapDef,
  rotateFacing,
  type TerrainType,
  type UnitSkillRange,
} from "btlib10x";
import type { PersonaKey } from "./ai/persona.data";
import { BattleController } from "./battle/controller";
import {
  autoPlace,
  EDGES,
  type Edge,
  inwardFacing,
  oppositeEdge,
  rollOff,
  setupRng,
} from "./battle/deploy";
import { t } from "./i18n";
import type { Banner, MapSource } from "./map/view";
import { MapView } from "./map/view";
import { type Loadout, loadoutProblem, mechDef, randomLoadout, saveLoadout } from "./setup/loadout";
import { app, type Placement, rerender } from "./state";

export interface DeployUnit {
  id: string;
  side: 0 | 1;
  index: number;
  model: string;
  /** Persona in control; null for a Player unit. */
  persona: PersonaKey | null;
}

export function deployUnits(l: Loadout): DeployUnit[] {
  const out: DeployUnit[] = [];
  l.sides.forEach((side, s) => {
    side.forEach((slot, i) => {
      out.push({
        id: slot.id,
        side: s as 0 | 1,
        index: i,
        model: slot.model ?? "",
        persona: slot.persona,
      });
    });
  });
  return out;
}

/** A side is "played" when any of its slots is a Player slot. */
export function sideHasPlayer(l: Loadout, side: 0 | 1): boolean {
  return l.sides[side].some((s) => s.persona === null);
}

export function currentMap(): MapDef {
  const map = ensureMapRegistered(app.loadout.map);
  if (!map) throw new Error(t("err.unknownMap", { name: app.loadout.map }));
  return map;
}

export function mapNames(): string[] {
  return catalogMaps().map((m) => m.name);
}

export function mapSource(map: MapDef): MapSource {
  const cells = new Map<string, { type: TerrainType; level: number }>();
  for (const h of map.terrain)
    cells.set(`${h.col},${h.row}`, { type: h.type, level: h.level ?? 0 });
  return {
    width: map.width,
    height: map.height,
    terrainAt: (hex) => cells.get(`${hex.col},${hex.row}`)?.type ?? "clear",
    levelAt: (hex) => cells.get(`${hex.col},${hex.row}`)?.level ?? 0,
  };
}

export function ensureMapView(): MapView {
  if (app.mapView === null) {
    const canvas = document.createElement("canvas");
    app.mapView = new MapView(canvas);
  }
  return app.mapView;
}

// ------------------------------------------------------------ setup → deployment

export function launch(): void {
  const l = app.loadout;
  const problem = loadoutProblem(l);
  if (problem) throw new Error(t(problem.key, problem.vars));
  saveLoadout(l);
  const rng = setupRng(l.seed);
  const roll = rollOff(rng);
  const cursor = deployUnits(l).findIndex((u) => u.persona === null);
  app.deploy = {
    roll,
    edges: [null, null],
    placements: {},
    cursor: Math.max(0, cursor),
    hoverEdge: null,
    focusUnit: false,
  };
  app.screen = "deploy";
  const winner = (roll.winner - 1) as 0 | 1;
  // A side without Player units chooses at once.
  if (!sideHasPlayer(l, winner)) chooseEdge(EDGES[rng.d6() % 4]!);
  const view = ensureMapView();
  view.setMap(mapSource(currentMap()));
  view.reset();
}

export function chooseEdge(edge: Edge): void {
  const d = app.deploy!;
  const winner = d.roll.winner - 1;
  d.edges[winner] = edge;
  d.edges[1 - winner] = oppositeEdge(edge);
  autoPlaceAll();
}

/** The winner's side has a Player unit, so a person picks (and may change) the edge. */
export function playerChoosesEdge(): boolean {
  const d = app.deploy!;
  return sideHasPlayer(app.loadout, (d.roll.winner - 1) as 0 | 1);
}

/** Drop both edges and every placement so the winner chooses again. */
export function changeEdge(): void {
  const d = app.deploy!;
  d.edges = [null, null];
  d.placements = {};
}

/** Re-place every Player unit; persona units keep their hexes. */
export function autoPlacePlayers(): void {
  const d = app.deploy!;
  for (const u of deployUnits(app.loadout)) if (u.persona === null) delete d.placements[u.id];
  autoPlaceAll();
}

/** Place every unit not placed yet, spread along its side's edge. */
export function autoPlaceAll(): void {
  const d = app.deploy!;
  const map = currentMap();
  const units = deployUnits(app.loadout);
  for (const s of [0, 1] as const) {
    const edge = d.edges[s];
    if (!edge) continue;
    const occupied = new Set(Object.values(d.placements).map((p) => `${p.hex.col},${p.hex.row}`));
    const todo = units.filter((u) => u.side === s && !d.placements[u.id]);
    const hexes = autoPlace(map, edge, todo.length, occupied);
    todo.forEach((u, i) => {
      const hex = hexes[i];
      if (hex) d.placements[u.id] = { hex, facing: inwardFacing(edge) };
    });
  }
}

/** Place a Player unit on its home edge, facing `facing` (else as before, else inward). */
export function placeUnit(id: string, hex: HexCoord, facing: Facing | null = null): void {
  const d = app.deploy!;
  const u = deployUnits(app.loadout).find((x) => x.id === id);
  if (!u) return;
  if (u.persona !== null) throw new Error(t("err.personaUnit", { id }));
  const edge = d.edges[u.side];
  if (!edge) throw new Error(t("err.edgeFirst"));
  if (!onEdge(currentMap(), edge, hex)) throw new Error(t("err.notHomeEdge"));
  const other = Object.entries(d.placements).find(
    ([oid, p]) => oid !== id && p.hex.col === hex.col && p.hex.row === hex.row,
  );
  if (other) throw new Error(t("err.hexTaken", { id: other[0] }));
  d.placements[id] = { hex, facing: facing ?? d.placements[id]?.facing ?? inwardFacing(edge) };
}

export function onEdge(map: MapDef, edge: Edge, hex: HexCoord): boolean {
  return (
    (edge === "north" && hex.row === 1) ||
    (edge === "south" && hex.row === map.height) ||
    (edge === "west" && hex.col === 1) ||
    (edge === "east" && hex.col === map.width)
  );
}

/** Turn a placed Player unit one hexside (+1 clockwise). */
export function turnUnit(id: string, dir: 1 | -1): void {
  const d = app.deploy!;
  const u = deployUnits(app.loadout).find((x) => x.id === id);
  const p = d.placements[id];
  if (!u || !p) return;
  if (u.persona !== null) throw new Error(t("err.personaUnit", { id }));
  p.facing = rotateFacing(p.facing, dir) as Facing;
}

export function deployBanners(): Banner[] {
  const d = app.deploy;
  if (!d) return [];
  const units = deployUnits(app.loadout);
  return units.flatMap((u, i) => {
    const p: Placement | undefined = d.placements[u.id];
    if (!p) return [];
    return [
      {
        id: u.id,
        hex: p.hex,
        facing: p.facing,
        team: u.side + 1,
        sub: u.model.slice(0, 6),
        active: i === d.cursor,
      },
    ];
  });
}

// ------------------------------------------------------------ battle

export function beginBattle(): void {
  const d = app.deploy!;
  const l = app.loadout;
  const units = deployUnits(l);
  const missing = units.find((u) => !d.placements[u.id]);
  if (missing) throw new Error(t("err.notPlaced", { id: missing.id }));
  const inits = units.map((u) => {
    const slot = l.sides[u.side][u.index]!;
    mechDef(u.model);
    const p = d.placements[u.id]!;
    const skill = (n: number) => Math.max(0, Math.min(7, Math.round(n))) as UnitSkillRange;
    return buildUnitInit(
      u.id,
      u.model,
      u.side === 0 ? 1 : 2,
      p.hex,
      p.facing,
      skill(slot.gunnery),
      skill(slot.piloting),
      slot.pilotHitMax,
      slot.policy,
    );
  });
  const control = Object.fromEntries(units.map((u) => [u.id, l.sides[u.side][u.index]!.persona]));
  app.battle = new BattleController(currentMap(), inits, control, l.seed, l.mode);
  app.screen = "battle";
  app.orderCursor = 0;
  app.modal = null;
  const view = ensureMapView();
  const battle = app.battle;
  view.setMap({
    width: battle.state.width,
    height: battle.state.height,
    terrainAt: (hex) => cellAt(app.battle!.state, hex).terrain,
    levelAt: (hex) => cellAt(app.battle!.state, hex).level,
  });
  view.reset();
  pumpAi();
}

export function rematch(): void {
  beginBattle();
}

export function randomBattle(): void {
  app.loadout = randomLoadout((Date.now() & 0x7fffffff) >>> 0, mapNames());
  launch();
}

/** Banners for every unit on the board; hulls are neutral. */
export function battleBanners(): Banner[] {
  const b = app.battle;
  if (!b) return [];
  const out: Banner[] = [];
  for (const u of Object.values(b.state.units)) {
    if (!isUnitOnBoard(u)) continue;
    const hull = isHull(u);
    const left = b.totals[u.id] ? unitLeft(u, b.totals[u.id]!) : 1;
    const pips = Math.max(0, Math.min(5, Math.ceil(left * 5)));
    const sub = hull
      ? "HULL"
      : u.shutdown !== "not"
        ? "OFF"
        : u.prone
          ? `PRN ${"▮".repeat(Math.min(2, pips))}`
          : `${"▮".repeat(pips)}${"▯".repeat(5 - pips)}`;
    out.push({
      id: hull ? `-${u.id}` : u.id,
      hex: u.position,
      facing: u.facing,
      team: hull ? 0 : u.team,
      sub,
      active: u.id === b.actorId,
    });
  }
  const m = b.move;
  if (m?.landing && b.actor) {
    out.push({
      id: b.actor.id,
      hex: m.landing.hex,
      facing: m.landing.facing,
      team: b.actor.team,
      sub: "",
      ghost: true,
    });
  }
  return out;
}

function unitLeft(
  u: { damage: { armor: object; armorRear: object; internalStructure: object } },
  start: number,
): number {
  let n = 0;
  for (const part of [u.damage.armor, u.damage.armorRear, u.damage.internalStructure]) {
    for (const v of Object.values(part as Record<string, number>)) n += Math.max(0, v);
  }
  return start > 0 ? n / start : 0;
}

let aiTimer: ReturnType<typeof setTimeout> | null = null;

/** Advance persona prompts at the chosen pace until a Player prompt or the end. */
export function pumpAi(force = false): void {
  if (aiTimer !== null) {
    clearTimeout(aiTimer);
    aiTimer = null;
  }
  const b = app.battle;
  if (!b || app.screen !== "battle") return;
  b.reasoning = app.aiReasoning;
  if (b.result !== null) {
    app.screen = "debrief";
    app.tab = 0;
    rerender();
    return;
  }
  if (b.actorPersona === null) {
    rerender();
    return;
  }
  if (app.aiPace === "step" && !force) {
    rerender();
    return;
  }
  const delay = app.aiPace === "timed" ? 600 : 20;
  aiTimer = setTimeout(() => {
    aiTimer = null;
    b.stepAi();
    app.orderCursor = 0;
    rerender();
    if (app.aiPace !== "step") pumpAi();
    else if (b.result !== null || b.actorPersona === null) pumpAi();
  }, delay);
  rerender();
}

export function stopAi(): void {
  if (aiTimer !== null) clearTimeout(aiTimer);
  aiTimer = null;
}
