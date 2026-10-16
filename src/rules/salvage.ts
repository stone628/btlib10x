/**
 * Salvage readout at battle end: what each unit that is
 * not operational left behind. Who gets the salvage (field control) stays
 * with the campaign layer.
 */

import type { HexCoord, LimbLocation, Location } from "../core/types";
import { mechDefFor } from "../data/index";
import { type AmmoBinId, collectAmmoBins, strandedShots } from "./ammo";
import { destroyedSlots, isSlotDestroyed, isWeaponCritted } from "./critical";
import { isUnitLocationDestroyed, type UnitDamageState } from "./damage";
import {
  type BattleState,
  type DestroyedReason,
  isHull,
  type RemovalReason,
  salvageableSeveredLimbs,
  type UnitState,
  WRECKAGE_TONNAGE_MIN,
} from "./game";
import { dhsCritWidth } from "./heat";

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

/** Equipment (non-frame structure components) the salvage list reports. The
 *  frame's own parts (engine, gyro, cockpit, sensors, life support,
 *  actuators) stay with the hull or wreckage and are not listed. */
export type SalvageEquipmentName = "heatSink" | "doubleHeatSink" | "jumpJet" | "targetingComputer";

const SALVAGE_EQUIPMENT: ReadonlySet<string> = new Set<SalvageEquipmentName>([
  "heatSink",
  "doubleHeatSink",
  "jumpJet",
  "targetingComputer",
]);

/** One intact weapon or piece of equipment worth recovering. */
export interface SalvageItem {
  readonly kind: "weapon" | "equipment";
  /** Weapon name, or a {@link SalvageEquipmentName}. */
  readonly name: string;
  /** Where it sits (a weapon's primary location for a split mount). */
  readonly location: Location;
  /** True when it lies in a severed limb on the ground, not on the frame. */
  readonly severed: boolean;
  /** Devices of this name in this location (multi-slot devices count once). */
  readonly count: number;
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
  /** Intact weapons and equipment on the frame or in a severed limb never
   *  picked up; ammo is reported in `strandedAmmo` instead. */
  readonly salvageable: readonly SalvageItem[];
}

/** Locations whose contents can be recovered: still on the frame (internal
 *  structure left), or severed and lying unclaimed. `true` marks severed. */
function recoverableLocations(unit: UnitState): Map<Location, boolean> {
  const out = new Map<Location, boolean>();
  const severed = new Map(unit.blownOffLimbs.map((l) => [l.limb as Location, l.salvageable]));
  for (const location of Object.keys(unit.damage.internalStructure) as Location[]) {
    const limb = severed.get(location);
    if (limb !== undefined) {
      if (limb) out.set(location, true);
    } else if (!isUnitLocationDestroyed(unit.damage, location)) {
      out.set(location, false);
    }
  }
  return out;
}

/** Intact weapons and equipment of `unit`, in location order then mount order. */
function salvageableItems(unit: UnitState): SalvageItem[] {
  const def = mechDefFor(unit);
  const open = recoverableLocations(unit);
  const items: SalvageItem[] = [];
  const add = (kind: SalvageItem["kind"], name: string, location: Location, n: number) => {
    const severed = open.get(location)!;
    const i = items.findIndex(
      (it) => it.kind === kind && it.name === name && it.location === location,
    );
    if (i < 0) items.push({ kind, name, location, severed, count: n });
    else items[i] = { ...items[i]!, count: items[i]!.count + n };
  };
  for (const [key, mount] of Object.entries(def.weapons)) {
    if (!open.has(mount.location)) continue;
    if (mount.splitLocation !== undefined && !open.has(mount.splitLocation)) continue;
    if (isWeaponCritted(def, unit.critSlotsDestroyed, Number(key))) continue;
    add("weapon", mount.weapon, mount.location, 1);
  }
  const width = dhsCritWidth(def);
  for (const location of Object.keys(def.critSlots) as Location[]) {
    if (!open.has(location)) continue;
    const layout = def.critSlots[location];
    let computer = false;
    for (let i = 0; i < layout.length; i++) {
      const slot = layout[i];
      if (slot?.kind !== "structure" || !SALVAGE_EQUIPMENT.has(slot.name)) continue;
      if (slot.name === "doubleHeatSink") {
        // One device per group (`heat.ts`): any destroyed slot loses it.
        const group = slot.group;
        if (group[0] !== i + 1) continue;
        if (group.some((j) => isSlotDestroyed(unit.critSlotsDestroyed, location, j - 1))) continue;
        add("equipment", slot.name, location, Math.floor(group.length / width));
      } else if (slot.name === "targetingComputer") {
        // One computer per location, lost to any hit on its slots.
        if (computer) continue;
        computer = true;
        const hit = layout.some(
          (other, j) =>
            other.kind === "structure" &&
            other.name === "targetingComputer" &&
            isSlotDestroyed(unit.critSlotsDestroyed, location, j),
        );
        if (!hit) add("equipment", slot.name, location, 1);
      } else if (!isSlotDestroyed(unit.critSlotsDestroyed, location, i)) {
        add("equipment", slot.name, location, 1);
      }
    }
  }
  return items;
}

/** Every unit that is not operational, in roster order: hulls and destroyed
 *  frames with their damage, destroyed slots, stranded ammo, salvageable
 *  severed limbs and the intact weapons and equipment left to recover. Read-only: copies what it reports. */
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
      salvageable: salvageableItems(unit),
    });
  }
  return out;
}
