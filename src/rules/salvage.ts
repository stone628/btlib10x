/**
 * Salvage readout at battle end: what each unit that is
 * not operational left behind. Who gets the salvage (field control) stays
 * with the campaign layer.
 */

import type { HexCoord, LimbLocation, Location } from "../core/types";
import { mechDefFor } from "../data/index";
import { type AmmoBinId, collectAmmoBins, strandedShots } from "./ammo";
import { destroyedSlots } from "./critical";
import type { UnitDamageState } from "./damage";
import {
  type BattleState,
  type DestroyedReason,
  isHull,
  type RemovalReason,
  salvageableSeveredLimbs,
  WRECKAGE_TONNAGE_MIN,
} from "./game";

/** A hull is an abandoned, intact frame still on the board (TO:AR
 *  pp.184-185); wreckage is a destroyed frame (TO:AR p.155). */
export type SalvageKind = "hull" | "wreckage";

/** One destroyed critical slot (1-based `slot`, as on the record sheet). */
export interface SalvageSlot {
  readonly location: Location;
  readonly slot: number;
  /** Weapon or equipment name, or `ammo:<weapon>` for an ammo bin. */
  readonly name: string;
}

/** Shots left in a bin whose location was lost to plain damage. */
export interface SalvageAmmo {
  readonly binId: AmmoBinId;
  readonly weapon: string;
  readonly shots: number;
}

export interface SalvageEntry {
  readonly unitId: string;
  readonly model: string;
  readonly team: number;
  readonly kind: SalvageKind;
  /** Why the unit left play: ejected / abandoned / pilot killed / destroyed. */
  readonly reason: RemovalReason;
  /** The frame's kill reason; null for a hull. */
  readonly destroyReason: DestroyedReason | null;
  readonly hex: HexCoord;
  readonly prone: boolean;
  /** True when the frame left wreckage on the board (40 t or more). */
  readonly leftWreckage: boolean;
  readonly damage: UnitDamageState;
  readonly destroyedSlots: readonly SalvageSlot[];
  readonly strandedAmmo: readonly SalvageAmmo[];
  /** Severed limbs never picked up that still carry an intact weapon. */
  readonly severedLimbs: readonly LimbLocation[];
}

/** Every unit that is not operational, in roster order: hulls and destroyed
 *  frames with their damage, destroyed slots, stranded ammo and salvageable
 *  severed limbs. Read-only: copies what it reports. */
export function salvageReport(state: BattleState): SalvageEntry[] {
  const out: SalvageEntry[] = [];
  for (const unit of Object.values(state.units)) {
    if (unit.removed === "not") continue;
    const def = mechDefFor(unit);
    const slots: SalvageSlot[] = [];
    for (const location of Object.keys(def.critSlots) as Location[]) {
      const layout = def.critSlots[location];
      for (const i of destroyedSlots(unit.critSlotsDestroyed, location)) {
        const slot = layout[i];
        if (slot === undefined || slot.kind === "empty") continue;
        const name =
          slot.kind === "weapon"
            ? slot.weapon
            : slot.kind === "ammo"
              ? `ammo:${slot.weapon}`
              : slot.name;
        slots.push({ location, slot: i + 1, name });
      }
    }
    const ammo: SalvageAmmo[] = [];
    for (const bin of collectAmmoBins(def)) {
      const shots = strandedShots(unit, bin);
      if (shots > 0) ammo.push({ binId: bin.id, weapon: bin.weapon, shots });
    }
    const hull = isHull(unit);
    out.push({
      unitId: unit.id,
      model: unit.model,
      team: unit.team,
      kind: hull ? "hull" : "wreckage",
      reason: unit.removed,
      destroyReason: unit.destroyed === "not" ? null : unit.destroyed,
      hex: unit.position,
      prone: unit.prone,
      leftWreckage: !hull && def.tonnage >= WRECKAGE_TONNAGE_MIN,
      damage: {
        armor: { ...unit.damage.armor },
        armorRear: { ...unit.damage.armorRear },
        internalStructure: { ...unit.damage.internalStructure },
      },
      destroyedSlots: slots,
      strandedAmmo: ammo,
      severedLimbs: salvageableSeveredLimbs(state, unit.id),
    });
  }
  return out;
}
