/**
 * GameEvent → localized log lines. The terminal's wording is the reference
 * (`web/terminal/session.common.ts`); this is Instant Action's own, shorter
 * formatter. Engine text (thrown errors) stays English.
 */
import type { AttackResolution, BattleState, GameEvent, HitGroup } from "btlib10x";
import { locName, t } from "../i18n";

import { UI_THEME } from "../theme";

const { ARROW: A } = UI_THEME;

export interface LogEntry {
  readonly text: string;
  /** CSS class hint: banner, prompt, hit, miss, crit, err, dim. */
  readonly cls?: string;
}

function tn(r: AttackResolution): number {
  const b = r.breakdown;
  return (
    b.gunnery +
    b.attackerMod +
    b.targetMod +
    b.terrainMod +
    b.coverMod +
    b.rangeMod +
    b.weaponMod +
    b.minRangeMod +
    b.heatMod +
    b.sensorMod +
    b.actuatorMod +
    b.tcMod +
    b.secondaryTargetMod
  );
}

function groupsText(groups: readonly { location: HitGroup["location"]; damage: number }[]): string {
  const byLoc = new Map<string, number>();
  for (const g of groups) byLoc.set(g.location, (byLoc.get(g.location) ?? 0) + g.damage);
  return [...byLoc].map(([loc, dmg]) => `${locName(loc)} ${dmg}`).join(", ");
}

export function formatEvents(events: readonly GameEvent[], _state: BattleState): LogEntry[] {
  const out: LogEntry[] = [];
  for (const e of events) {
    switch (e.kind) {
      case "phase":
        if (e.phase === "movement" && e.prevPhase === "initiative") break;
        if (e.phase === "initiative")
          out.push({ text: t("log.turn", { turn: e.turn }), cls: "banner" });
        else if (e.phase === "attack") out.push({ text: t("log.attackPhase"), cls: "dim" });
        else if (e.phase === "end") out.push({ text: t("log.endPhase"), cls: "dim" });
        break;
      case "initiative": {
        const rolls = Object.entries(e.rolls)
          .map(([team, roll]) => t("log.sideRoll", { side: team, roll }))
          .join(", ");
        out.push({ text: t("log.initiative", { rolls, side: e.winnerTeam }) });
        break;
      }
      case "moved":
        out.push({
          text: e.pendingCharge
            ? t("log.movedCharge", {
                id: e.unitId,
                col: e.position.col,
                row: e.position.row,
                attack: e.pendingCharge.attack,
                target: e.pendingCharge.targetId,
              })
            : t(e.mode === "standStill" ? "log.movedStill" : "log.moved", {
                id: e.unitId,
                mode: t(`mode.${e.mode}`),
                col: e.position.col,
                row: e.position.row,
                facing: e.facing.toUpperCase(),
                mp: e.mpSpent,
              }),
        });
        break;
      case "attackResolved": {
        const r = e.resolution;
        const head = `[${e.unitId} ${A.to} ${e.targetId}] ${r.weapon}`;
        if (!r.hit) {
          out.push({
            text: t("log.miss", { head, tn: tn(r), roll: r.toHitRoll ?? "-" }),
            cls: "miss",
          });
        } else {
          out.push({
            text: t("log.hit", {
              head,
              tn: tn(r),
              roll: r.toHitRoll ?? "-",
              dmg: groupsText(r.groups),
            }),
            cls: "hit",
          });
        }
        break;
      }
      case "physicalAttackResolved": {
        const r = e.resolution;
        const head = `[${e.unitId} ${A.to} ${e.targetId}] ${t(`phys.${r.type}`)}`;
        out.push(
          r.hit
            ? {
                text: t("log.hit", {
                  head,
                  tn: r.toHit,
                  roll: r.roll ?? "-",
                  dmg: groupsText(r.damageToTarget),
                }),
                cls: "hit",
              }
            : { text: t("log.miss", { head, tn: r.toHit, roll: r.roll ?? "-" }), cls: "miss" },
        );
        break;
      }
      case "amsEngaged":
        out.push({
          text: t("log.ams", {
            id: e.unitId,
            from: e.attackWeapon,
            a: e.hitsWithout,
            b: e.hitsWith,
          }),
        });
        break;
      case "pilotingCheck":
        out.push({
          text: t(e.success ? "log.psrPass" : "log.psrFail", {
            id: e.unitId,
            reason: e.reason,
            roll: e.roll ?? "-",
            target: e.basePiloting + e.triggerModifier + e.preexistingModifier,
          }),
          cls: e.success ? "dim" : "crit",
        });
        break;
      case "unitFell":
        if (e.cause.kind === "voluntaryDrop") {
          out.push({ text: t("log.drop", { id: e.unitId }) });
        } else {
          out.push({
            text: t("log.fell", { id: e.unitId, dmg: groupsText(e.groups) }),
            cls: "crit",
          });
        }
        break;
      case "pilotDamaged":
        out.push({ text: t("log.pilotHit", { id: e.unitId, hits: e.totalHits }), cls: "crit" });
        break;
      case "consciousnessCheck":
        if (!e.success) out.push({ text: t("log.unconscious", { id: e.unitId }), cls: "crit" });
        break;
      case "shutdownCheck":
        if (e.result === "shutdown" || e.result === "manual") {
          out.push({ text: t("log.shutdown", { id: e.unitId, heat: e.heat }), cls: "crit" });
        }
        break;
      case "restartCheck":
        out.push({ text: t("log.restart", { id: e.unitId }) });
        break;
      case "ammoExplosionCheck":
        if (!e.avoided)
          out.push({ text: t("log.ammoBoom", { id: e.unitId, weapon: e.weapon }), cls: "crit" });
        break;
      case "heatDissipated":
        if (e.endHeat > 0 || e.startHeat > 0) {
          out.push({
            text: t("log.heat", { id: e.unitId, from: e.startHeat, to: e.endHeat }),
            cls: "dim",
          });
        }
        break;
      case "unitRemoved":
        out.push({ text: t(`log.removed.${e.reason}`, { id: e.unitId }), cls: "banner" });
        break;
      case "wreckageLeft":
        out.push({ text: t("log.wreckage", { id: e.unitId, col: e.col, row: e.row }), cls: "dim" });
        break;
      case "buildingCollapsed":
        out.push({ text: t("log.collapse", { col: e.col, row: e.row }), cls: "crit" });
        break;
      case "clubPickedUp":
        out.push({
          text: t(e.success ? "log.pickup" : "log.pickupFail", {
            id: e.unitId,
            kind: e.clubKind ?? "",
          }),
        });
        break;
      case "clubDropped":
        out.push({ text: t("log.clubDrop", { id: e.unitId, kind: e.clubKind }), cls: "dim" });
        break;
      default:
        break;
    }
  }
  return out;
}
