/**
 * `dp setup 2|4`: a random doctrine-vs-doctrine setup. Picks a random catalog
 * map, then for each player a random catalog 'Mech, a random open hex and
 * facing, and a random doctrine, through the setup API directly
 * (`setupSetMap` / `setupAddUnit`, which keep the usual bounds and occupancy
 * checks) and reports each pick. Teams split evenly because `setupAddUnit`
 * alternates teams (`setupPickTeam`).
 *
 * Draws come from a stream seeded off the setup seed (salted apart from the
 * battle dice and the doctrine player's tie-break stream), so a seed always
 * produces the same setup and the battle dice are untouched.
 */
import {
  catalogMaps,
  catalogMechs,
  ensureMapRegistered,
  FACINGS,
  type HexCoord,
  type MapDef,
  type Rng,
  type TerrainType,
  terrainDef,
} from "btlib10x";
import { buildLinesChunk, buildLinesChunkWith, type Chunk } from "./chunk";
import { DOCTRINE_KEYS, DOCTRINES } from "./doctrine.data";
import { i18n } from "./i18n/index";
import { createRng } from "./rng";
import type { Session } from "./session";
import { setupAddUnit, setupSetMap } from "./session.setup";

/** Player counts `dp setup` accepts. */
export const SETUP_PLAYER_COUNTS: readonly number[] = [2, 4];
export const DP_SETUP_USAGE = "dp setup 2|4";
/** Keeps the setup stream apart from the battle dice seeded with the same number. */
const SETUP_SEED_SALT = 0x5eed5e7;
/** Unit ids by add order; `setupAddUnit` alternates teams, so A* are team 1 and B* team 2. */
const PLAYER_IDS: readonly string[] = ["A1", "B1", "A2", "B2"];
/** Base-6 digits per uniform draw (6^8 ≈ 1.7M ≫ any catalog or board size). */
const DIGITS = 8;
const RANGE = 6 ** DIGITS;

/** Uniform integer in [0, n) from d6 rolls (rejection sampling, no modulo bias). */
export function randomInt(rng: Rng, n: number): number {
  if (n <= 1) return 0;
  const limit = RANGE - (RANGE % n);
  for (;;) {
    let v = 0;
    for (let i = 0; i < DIGITS; i++) v = v * 6 + (rng.d6() - 1);
    if (v < limit) return v % n;
  }
}

function pick<T>(rng: Rng, list: readonly T[]): T {
  return list[randomInt(rng, list.length)]!;
}

/** A 'Mech may start here: dry ground, not inside a building. */
function openTerrain(type: TerrainType): boolean {
  return terrainDef(type).waterDepth === 0 && !type.endsWith("Building");
}

/** Every hex of `map` a 'Mech may start in. */
function openHexes(map: MapDef): HexCoord[] {
  const blocked = new Set(
    map.terrain.filter((t) => !openTerrain(t.type)).map((t) => `${t.col},${t.row}`),
  );
  const hexes: HexCoord[] = [];
  for (let row = 1; row <= map.height; row++) {
    for (let col = 1; col <= map.width; col++) {
      if (!blocked.has(`${col},${row}`)) hexes.push({ col, row });
    }
  }
  return hexes;
}

/** Reasons `dp setup` refuses; null when the setup is empty. */
function setupBlocker(s: Session): string | null {
  if (s.state !== "setup") return i18n("dp.err.setupPhase");
  if (s.setup.mapName !== null) return i18n("dp.err.setupMapSet", { map: s.setup.mapName });
  if (s.setup.roster.length > 0) {
    return i18n("dp.err.setupRoster", { count: s.setup.roster.length });
  }
  return null;
}

/** Build the random setup and report the picks. A failure leaves the setup empty. */
export function randomDoctrineSetup(s: Session, players: number): Chunk[] {
  if (!SETUP_PLAYER_COUNTS.includes(players)) {
    throw new Error(i18n("err.expectedArgs", { usage: DP_SETUP_USAGE }));
  }
  const blocker = setupBlocker(s);
  if (blocker !== null) throw new Error(blocker);

  // Maps too small for the players are skipped.
  const maps = catalogMaps().filter((m) => m.width * m.height >= players * 4);
  const mechs = catalogMechs();
  if (maps.length === 0 || mechs.length === 0) throw new Error(i18n("dp.err.setupCatalog"));

  const rng = createRng((s.setup.seed ^ SETUP_SEED_SALT) >>> 0);
  const name = pick(rng, maps).name;
  const map = ensureMapRegistered(name);
  if (map === undefined) throw new Error(i18n("dp.err.setupCatalog"));
  const free = openHexes(map);
  if (free.length < players) throw new Error(i18n("dp.err.setupNoRoom", { map: map.name }));

  const lines = [i18n("dp.setup.map", { name: map.name, w: map.width, h: map.height })];
  try {
    setupSetMap(s.setup, map);
    for (const id of PLAYER_IDS.slice(0, players)) {
      const hex = free.splice(randomInt(rng, free.length), 1)[0]!;
      const facing = pick(rng, FACINGS);
      const doctrine = pick(rng, DOCTRINE_KEYS);
      const { model, team } = setupAddUnit(s.setup, id, pick(rng, mechs).model, hex, facing);
      s.doctrine.assignments[id] = doctrine;
      lines.push(
        i18n("dp.setup.unit", {
          id,
          model,
          col: hex.col,
          row: hex.row,
          facing,
          team,
          doctrine: DOCTRINES[doctrine].name,
        }),
      );
    }
  } catch (e) {
    s.setup.mapName = null;
    s.setup.roster = [];
    s.doctrine.assignments = {};
    throw e;
  }
  return [
    buildLinesChunk(...lines),
    buildLinesChunkWith("banner", i18n("dp.setup.done", { players, seed: s.setup.seed })),
  ];
}
