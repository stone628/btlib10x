/**
 * The Instant Action loadout: two sides of 1–4 'Mechs, a map, a victory mode
 * and a seed. Pure data, kept in localStorage between visits.
 */
import {
  catalogMechs,
  DEFAULT_UNIT_POLICY,
  ensureMechRegistered,
  type MechManifestEntry,
  type ResolvedMechDef,
  type Rng,
  type UnitPolicy,
} from "btlib10x";
import { PERSONA_KEYS, type PersonaKey } from "../ai/persona.data";
import type { VictoryMode } from "../battle/victory";
import { createRng } from "../rng";

export interface Slot {
  /** Unit id in the battle (log, banners); user-editable, see `ID_PATTERN`. */
  id: string;
  /** Null: an empty slot added by [+], not chosen yet. */
  model: string | null;
  gunnery: number;
  piloting: number;
  pilotHitMax: number;
  /** Null: played by the person at the keyboard. */
  persona: PersonaKey | null;
  policy: UnitPolicy;
}

export interface Loadout {
  sides: [Slot[], Slot[]];
  map: string;
  mode: VictoryMode;
  seed: number;
}

export const MAX_SLOTS = 4;
export const PILOT_HIT_MIN = 4;
/** House rule: up to 8 (TW kills the MechWarrior on the 6th hit, TW p.41-42). */
export const PILOT_HIT_MAX = 8;
export const TURN_LIMIT_DEFAULT = 10;
export const TURN_LIMIT_MIN = 3;
export const TURN_LIMIT_MAX = 30;

/** 1–12 letters, digits, `-` or `_`. */
export const ID_PATTERN = /^[A-Za-z0-9_-]{1,12}$/;

/** Default id of a slot position: A1…A4, B1…B4. */
export function slotId(side: 0 | 1, index: number): string {
  return `${side === 0 ? "A" : "B"}${index + 1}`;
}

/** The first default id (A1, A2, … / B1, …) no slot of the loadout uses. */
export function freeId(l: Loadout, side: 0 | 1): string {
  const used = new Set(l.sides.flat().map((s) => s.id.toLowerCase()));
  for (let i = 0; ; i++) {
    const id = slotId(side, i);
    if (!used.has(id.toLowerCase())) return id;
  }
}

/** Why `id` cannot name `slot`: a message key, or null when it can. */
export function idProblem(
  l: Loadout,
  slot: Slot,
  id: string,
): "err.idFormat" | "err.idTaken" | null {
  if (!ID_PATTERN.test(id)) return "err.idFormat";
  const lower = id.toLowerCase();
  if (l.sides.flat().some((s) => s !== slot && s.id.toLowerCase() === lower)) return "err.idTaken";
  return null;
}

/** Why the loadout cannot launch yet, or null when it can. */
export function loadoutProblem(
  l: Loadout,
): { key: "err.emptySide" | "err.emptySlot" | "err.idTaken"; vars: Record<string, string> } | null {
  for (const side of [0, 1] as const) {
    if (l.sides[side].length === 0)
      return { key: "err.emptySide", vars: { side: String(side + 1) } };
    const empty = l.sides[side].find((s) => s.model === null);
    if (empty) return { key: "err.emptySlot", vars: { side: String(side + 1), id: empty.id } };
  }
  const seen = new Set<string>();
  for (const s of l.sides.flat()) {
    if (seen.has(s.id.toLowerCase())) return { key: "err.idTaken", vars: { id: s.id } };
    seen.add(s.id.toLowerCase());
  }
  return null;
}

export function newSlot(model: string | null, persona: PersonaKey | null, id: string): Slot {
  return {
    id,
    model,
    gunnery: 4,
    piloting: 5,
    pilotHitMax: 6,
    persona,
    policy: { ...DEFAULT_UNIT_POLICY },
  };
}

export function defaultLoadout(): Loadout {
  return {
    sides: [
      [newSlot("HBK-4G", null, "A1"), newSlot("CN9-YLW2", "alpha", "A2")],
      [newSlot("GRF-1N", "longtom", "B1"), newSlot("ENF-4R", "gladiator", "B2")],
    ],
    map: "quickstart",
    mode: { kind: "destroyAll" },
    seed: 42,
  };
}

/** The resolved sheet of a catalog model (decoded and registered on first use). */
export function mechDef(model: string): ResolvedMechDef {
  const def = ensureMechRegistered(model);
  if (!def) throw new Error(`Unknown 'Mech model ${model}`);
  return def;
}

export type WeightClass = "light" | "medium" | "heavy" | "assault";

export function weightClass(tons: number): WeightClass {
  return tons < 40 ? "light" : tons < 60 ? "medium" : tons < 80 ? "heavy" : "assault";
}

export function bvOf(model: string | null): number {
  if (model === null) return 0;
  return catalogMechs().find((m) => m.model === model)?.bv ?? 0;
}

export function sideBv(side: readonly Slot[]): number {
  return side.reduce((n, s) => n + bvOf(s.model), 0);
}

export interface MechFilter {
  text: string;
  classes: WeightClass[];
  tech: "any" | "is" | "clan";
  pack: "any" | "base" | "sw";
  introMax: number;
  sort: "ton" | "name" | "bv" | "intro";
}

export function defaultFilter(): MechFilter {
  return { text: "", classes: [], tech: "any", pack: "any", introMax: 3150, sort: "ton" };
}

/** The `info mech` filters (class, tech, pack, intro, text) as data. */
export function filterMechs(f: MechFilter): MechManifestEntry[] {
  const text = f.text.trim().toLowerCase();
  const list = catalogMechs().filter((m) => {
    if (text && !`${m.model} ${m.name} ${m.clanName ?? ""}`.toLowerCase().includes(text))
      return false;
    if (f.classes.length > 0 && !f.classes.includes(weightClass(m.tonnage))) return false;
    const clan = m.techBase.toLowerCase().startsWith("clan");
    if (f.tech === "is" && clan) return false;
    if (f.tech === "clan" && !clan) return false;
    if (f.pack !== "any" && m.pack !== f.pack) return false;
    if (m.intro > f.introMax) return false;
    return true;
  });
  const by: Record<MechFilter["sort"], (a: MechManifestEntry, b: MechManifestEntry) => number> = {
    ton: (a, b) =>
      a.tonnage - b.tonnage || a.name.localeCompare(b.name) || a.model.localeCompare(b.model),
    name: (a, b) => a.name.localeCompare(b.name) || a.model.localeCompare(b.model),
    bv: (a, b) => a.bv - b.bv || a.model.localeCompare(b.model),
    intro: (a, b) => a.intro - b.intro || a.model.localeCompare(b.model),
  };
  return list.sort(by[f.sort]);
}

function pick<T>(rng: Rng, list: readonly T[]): T {
  let n = 0;
  for (let i = 0; i < 6; i++) n = n * 6 + (rng.d6() - 1);
  return list[n % list.length]!;
}

export interface GenerateOptions {
  count: number;
  /** BV target for the whole side; 0 picks freely. */
  bvTarget: number;
  classes: WeightClass[];
  personas: "random" | "none";
  /** Side whose default ids (A… / B…) the slots get; 0 when omitted. */
  side?: 0 | 1;
}

/**
 * Random side for Generate / Random battle: draws 'Mechs with MUL BV, then
 * swaps single slots while that brings the total closer to the target (±10%).
 */
export function generateSide(rng: Rng, o: GenerateOptions): Slot[] {
  const pool = catalogMechs().filter(
    (m) => m.bv > 0 && (o.classes.length === 0 || o.classes.includes(weightClass(m.tonnage))),
  );
  if (pool.length === 0) return [];
  const persona = (): PersonaKey | null => (o.personas === "none" ? null : pick(rng, PERSONA_KEYS));
  const slots = Array.from({ length: o.count }, (_, i) =>
    newSlot(pick(rng, pool).model, persona(), slotId(o.side ?? 0, i)),
  );
  if (o.bvTarget > 0) {
    for (let round = 0; round < 60; round++) {
      const total = sideBv(slots);
      if (Math.abs(total - o.bvTarget) <= o.bvTarget * 0.1) break;
      const i = round % slots.length;
      const want = o.bvTarget - (total - bvOf(slots[i]!.model));
      const near = pool
        .filter((m) => Math.abs(m.bv - want) <= Math.max(150, Math.abs(want) * 0.15))
        .map((m) => m.model);
      if (near.length > 0) slots[i]!.model = pick(rng, near);
    }
  }
  return slots;
}

export function randomLoadout(seed: number, maps: readonly string[]): Loadout {
  const rng = createRng((seed ^ 0x1a5eed) >>> 0);
  const count = 2 + (rng.d6() % 3);
  const a = generateSide(rng, { count, bvTarget: 0, classes: [], personas: "none" });
  a.slice(1).forEach((s) => {
    s.persona = pick(rng, PERSONA_KEYS);
  });
  const b = generateSide(rng, {
    count,
    bvTarget: sideBv(a),
    classes: [],
    personas: "random",
    side: 1,
  });
  return { sides: [a, b], map: pick(rng, maps), mode: { kind: "destroyAll" }, seed };
}

const STORAGE_KEY = "bt10x.instant.loadout";

export function saveLoadout(l: Loadout): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(l));
  } catch {
    // storage unavailable: the loadout just won't survive a reload
  }
}

export function loadLoadout(): Loadout | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return null;
    const l = JSON.parse(raw) as Loadout;
    const known = new Set(catalogMechs().map((m) => m.model));
    if (!Array.isArray(l.sides) || l.sides.length !== 2) return null;
    for (const side of l.sides) {
      if (!Array.isArray(side) || side.length > MAX_SLOTS) return null;
      for (const s of side) if (s.model !== null && !known.has(s.model)) return null;
    }
    // Loadouts saved before ids were editable: give each slot its default id.
    l.sides.forEach((side, si) => {
      side.forEach((s, i) => {
        if (typeof s.id !== "string" || !ID_PATTERN.test(s.id)) s.id = slotId(si as 0 | 1, i);
        s.pilotHitMax = Math.max(PILOT_HIT_MIN, Math.min(PILOT_HIT_MAX, s.pilotHitMax));
      });
    });
    return l;
  } catch {
    return null;
  }
}
