import { canFireFromLocation } from "../src/rules/damage.js";
import type * as S from "./session.js";

/** Delay between generated commands, in milliseconds. */
export const AUTOPLAY_INTERVAL_MS = 2000;

/**
 * Roster the demo builds after 'reset' (mirrors freshSetup() in
 * tests/webcli.test.ts): adjacent foes facing each other along the n/s axis.
 */
const SCRIPT_SETUP: ReadonlyArray<{ id: string; command: string }> = [
  { id: "hunchy", command: "add hunchy HBK-4G 0 4 4 3 ne" },
  { id: "cicada", command: "add cicada CDA-3MA 1 4 5 3 sw" },
];

/**
 * Next command a demonstrator would type for this session, derived purely
 * from session internals; null when there is nothing left to do (battle over,
 * or a state the script cannot drive). Feed each result through execute()
 * one AUTOPLAY_INTERVAL_MS at a time.
 */
export function nextAutoPlayCommand(s: S.Session): string | null {
  if (s.app === "setup") {
    if (s.mapName === null) return "map test";
    const missing = SCRIPT_SETUP.find((u) => !s.roster.some((r) => r.id === u.id));
    if (missing !== undefined) return missing.command;
    return "start";
  }
  if (s.app !== "battle" || s.battle === null || s.actorId === null) return null;
  const st = s.battle;
  const actor = st.units[s.actorId];
  if (actor === undefined || actor.removed) return null;
  const enemy = Object.values(st.units).find((u) => !u.removed && u.id !== actor.id);
  if (enemy === undefined) return null;
  if (st.phase === "movement") {
    return actor.moveMode === null ? "mode walk" : "done";
  }
  if (st.phase === "weaponAttack") {
    const def = st.defs[actor.model];
    if (def === undefined) return null;
    // Queued shots live in the session's fireDecls buffer until 'done' commits.
    const declared = new Set(s.fireDecls.map((d) => d.weaponIndex));
    for (let w = 0; w < def.weapons.length; w++) {
      if (declared.has(w)) continue;
      const mount = def.weapons[w]!;
      if (actor.jammedWeapons.includes(w)) continue;
      if (!canFireFromLocation(actor.phaseStartArmor, mount.location)) continue;
      if (actor.ammoLeft[w] !== undefined && (actor.ammoLeft[w] ?? 0) < 1) continue;
      return `fire ${w + 1} ${enemy.id}`;
    }
    return "done";
  }
  return null;
}
