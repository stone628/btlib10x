/**
 * Record sheet hover hints for the pilot, the engine, gyro, sensors and
 * life support, and heat: what the current value costs now and what the
 * next step adds (TW pp. 41-42, 60, 125, 159-160).
 */
import {
  collectAmmoBins,
  componentHitStatus,
  consciousnessTarget,
  ENGINE_SLOTS_KILL,
  GYRO_DESTROYED_HITS,
  GYRO_HIT_MOD,
  HEAT_SCALE_MAX,
  type HeatScaleEffects,
  heatScaleEffects,
  mechDefFor,
  pilotStatus,
  SENSOR_BLIND_HITS,
  shutdownAvoid,
  type UnitState,
} from "btlib10x";
import { t } from "../i18n";

/** Engine heat per turn by engine hits (TW p.125): 5 for one, 10 for two+. */
const engineHeat = (hits: number): number => (hits <= 0 ? 0 : hits === 1 ? 5 : 10);
/** Weapon to-hit penalty per sensor hit (TW p.125). */
const SENSOR_TO_HIT = 2;
/** Heat at the end of the Heat Phase that costs a pilot without life support
 *  1 hit, then 2 (TW p.125; the engine's LIFE_SUPPORT_HEAT_* constants). */
const LIFE_HEAT_1 = 15;
const LIFE_HEAT_2 = 26;
/** Below this heat a heat-shut-down 'Mech restarts on its own (TW p.160). */
const AUTO_RESTART_HEAT = 14;

/** Chance in percent that 2D6 rolls `n` or more. */
function chance(n: number): number {
  let hits = 0;
  for (let a = 1; a <= 6; a++) for (let b = 1; b <= 6; b++) if (a + b >= n) hits++;
  return Math.round((hits / 36) * 100);
}

/** A static roll target as `2D6 7+ (58%)`. */
function roll(n: number): string {
  return t("hint.roll", { n, p: chance(n) });
}

/** Pilot hint: hits, the next consciousness roll, or the pilot's fate. */
export function pilotTip(u: UnitState): string {
  const max = u.pilotHitMax;
  const hits = u.pilotHits;
  switch (pilotStatus(u)) {
    case "dead":
      return t("hint.pilot.dead");
    case "ejected":
      return t("hint.pilot.ejected");
    case "abandoned":
      return t("hint.pilot.abandoned");
    case "unconscious":
      return [
        t("hint.pilot.unconscious", { hits, max }),
        t("hint.pilot.wake", { roll: roll(consciousnessTarget(hits, max) ?? 0) }),
        t("hint.pilot.out"),
      ].join("\n");
    default: {
      const next = consciousnessTarget(hits + 1, max);
      return [
        hits === 0 ? t("hint.pilot.unhurt", { max }) : t("hint.pilot.hits", { hits, max }),
        next === null ? t("hint.pilot.nextKills") : t("hint.pilot.next", { roll: roll(next) }),
      ].join("\n");
    }
  }
}

function counts(u: UnitState) {
  return componentHitStatus(mechDefFor(u), u.damage, u.critSlotsDestroyed);
}

export function engineTip(u: UnitState): string {
  const n = Math.min(ENGINE_SLOTS_KILL, counts(u).engine);
  const lines = [
    t(`hint.engine.${n}` as "hint.engine.0", {
      max: ENGINE_SLOTS_KILL,
      heat: engineHeat(n),
      next: engineHeat(n + 1),
    }),
  ];
  if (n > 0 && n < ENGINE_SLOTS_KILL && u.shutdown !== null) lines.push(t("hint.engine.off"));
  return lines.join("\n");
}

export function gyroTip(u: UnitState): string {
  const n = Math.min(GYRO_DESTROYED_HITS, counts(u).gyro);
  return t(`hint.gyro.${n}` as "hint.gyro.0", { max: GYRO_DESTROYED_HITS, mod: GYRO_HIT_MOD });
}

export function sensorTip(u: UnitState): string {
  const n = Math.min(SENSOR_BLIND_HITS, counts(u).sensors);
  return t(`hint.sensors.${n}` as "hint.sensors.0", { max: SENSOR_BLIND_HITS, mod: SENSOR_TO_HIT });
}

/** Pilot hits a pilot without life support takes at `heat` (TW p.125). */
function lifeHits(heat: number): number {
  return heat >= LIFE_HEAT_2 ? 2 : heat >= LIFE_HEAT_1 ? 1 : 0;
}

export function lifeSupportTip(u: UnitState): string {
  if (counts(u).lifeSupport === 0) return t("hint.life.0");
  const heat = u.heat;
  const n = lifeHits(heat);
  return [
    t("hint.life.1", { lo: LIFE_HEAT_1, hi: LIFE_HEAT_2 - 1, two: LIFE_HEAT_2 }),
    n > 0 ? t("hint.life.now", { n, heat }) : t("hint.life.nowNone", { heat }),
  ].join("\n");
}

/** Movement and to-hit penalties, or "no heat effects". */
function penalties(e: HeatScaleEffects): string {
  const parts: string[] = [];
  if (e.mpPenalty > 0) parts.push(t("hint.heat.mp", { n: e.mpPenalty }));
  if (e.toHitMod > 0) parts.push(t("hint.heat.toHit", { n: e.toHitMod }));
  return parts.length > 0 ? parts.join(", ") : t("hint.heat.noEffects");
}

function shutdownText(s: HeatScaleEffects["shutdown"]): string {
  return s === "auto"
    ? t("hint.heat.shutdownAuto")
    : t("hint.heat.shutdown", { roll: roll(s?.avoid ?? 0) });
}

/** The Heat Phase checks at `e.heat`, one indented line each. */
function checks(e: HeatScaleEffects, ammo: boolean, life: boolean): string[] {
  const out: string[] = [];
  if (e.shutdown) out.push(shutdownText(e.shutdown));
  if (ammo && e.ammoExplosion) out.push(t("hint.heat.ammo", { roll: roll(e.ammoExplosion.avoid) }));
  const lh = life ? lifeHits(e.heat) : 0;
  if (lh > 0) out.push(t("hint.heat.life", { n: lh }));
  return out.map((s) => `  ${s}`);
}

/** The first heat above `heat` whose effects differ, and what changes there. */
function nextStep(heat: number): string | null {
  if (heat >= HEAT_SCALE_MAX) return null;
  const cur = heatScaleEffects(heat);
  for (let h = heat + 1; h <= HEAT_SCALE_MAX; h++) {
    const e = heatScaleEffects(h);
    const parts: string[] = [];
    if (e.mpPenalty !== cur.mpPenalty) parts.push(t("hint.heat.mp", { n: e.mpPenalty }));
    if (e.toHitMod !== cur.toHitMod) parts.push(t("hint.heat.toHit", { n: e.toHitMod }));
    if (JSON.stringify(e.shutdown) !== JSON.stringify(cur.shutdown))
      parts.push(shutdownText(e.shutdown));
    if (JSON.stringify(e.ammoExplosion) !== JSON.stringify(cur.ammoExplosion))
      parts.push(t("hint.heat.ammo", { roll: roll(e.ammoExplosion?.avoid ?? 0) }));
    if (parts.length > 0) return t("hint.heat.step", { t: h, effects: parts.join(", ") });
  }
  return null;
}

/** Heat hint: the scale value the engine reads now, its penalties and
 *  checks, and the next threshold. */
export function heatTip(u: UnitState): string {
  const now = u.heat;
  const lines = [t("hint.heat.scale", { now })];
  if (u.shutdown === "heat") {
    lines.push(t("hint.heat.offHeat"));
    lines.push(
      now >= HEAT_SCALE_MAX
        ? t("hint.heat.noRestart", { max: HEAT_SCALE_MAX })
        : t("hint.heat.restart", { roll: roll(shutdownAvoid(now)), auto: AUTO_RESTART_HEAT }),
    );
    return lines.join("\n");
  }
  if (u.shutdown === "manual") {
    const n = shutdownAvoid(now);
    lines.push(t("hint.heat.offManual"));
    lines.push(n > 0 ? t("hint.heat.startupOn", { roll: roll(n) }) : t("hint.heat.startup"));
    return lines.join("\n");
  }
  const e = heatScaleEffects(now);
  lines.push(t("hint.heat.now", { effects: penalties(e) }));
  lines.push(...checks(e, collectAmmoBins(mechDefFor(u)).length > 0, counts(u).lifeSupport > 0));
  const step = nextStep(now);
  if (step) lines.push(step);
  return lines.join("\n");
}
