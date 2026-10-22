import {
  AMMO_POLICIES,
  type AmmoPolicy,
  setUnitPolicy,
  type UnitPolicy,
  type UnitState,
  unitPolicyOf,
} from "btlib10x";
import { i18n } from "./i18n";
import { recordPolicy } from "./replay";
import type { Session } from "./session";
import { ammoPolicyLabel } from "./session.common";

/** Unit properties that are policies: set in setup (`set`) and by the acting
 *  unit during the movement and attack phases (`policy`). */
export type PolicyProp = keyof UnitPolicy;

export const POLICY_PROPS: ReadonlyArray<PolicyProp> = ["ammoPolicy", "autoEject", "heatFlamer"];

/** Case-insensitive property name lookup; the error lists `props`. */
export function findProp<P extends string>(word: string, props: ReadonlyArray<P>): P {
  const lower = word.toLowerCase();
  const prop = props.find((p) => p.toLowerCase() === lower);
  if (prop !== undefined) return prop;
  throw new Error(i18n("err.unknownProp", { name: word, list: props.join(", ") }));
}

export function parsePolicyProp(word: string): PolicyProp {
  return findProp(word, POLICY_PROPS);
}

/** Parse a CLI word into a policy. Case-insensitive; `least-first` and
 *  `leastfirst` are accepted for `leastFirst`. Null when unrecognized. */
function resolveAmmoPolicy(word: string): AmmoPolicy | null {
  const normalized = word.toLowerCase().replaceAll("-", "");
  return AMMO_POLICIES.find((p) => p.toLowerCase() === normalized) ?? null;
}

/** Parse a policy value as `set` and `policy` accept it: the patch to apply
 *  and the value as echoed back. */
export function parsePolicyValue(
  prop: PolicyProp,
  raw: string,
): { patch: Partial<UnitPolicy>; value: string } {
  switch (prop) {
    case "ammoPolicy": {
      const policy = resolveAmmoPolicy(raw);
      if (policy === null) throw new Error(i18n("err.badAmmoPolicy"));
      return { patch: { ammoPolicy: policy }, value: ammoPolicyLabel(policy) };
    }
    case "autoEject": {
      const word = raw.toLowerCase();
      if (word !== "on" && word !== "off") throw new Error(i18n("err.badAutoEject"));
      return { patch: { autoEject: word === "on" }, value: word };
    }
    case "heatFlamer": {
      const word = raw.toLowerCase();
      if (word !== "on" && word !== "off") throw new Error(i18n("err.badHeatFlamer"));
      return { patch: { heatFlamer: word === "on" }, value: word };
    }
  }
}

/** One line naming the unit's live policies. */
export function policySummaryLine(unit: UnitState): string {
  const p = unitPolicyOf(unit);
  return i18n("policy.summary", {
    id: unit.id,
    ammo: ammoPolicyLabel(p.ammoPolicy),
    eject: p.autoEject ? "on" : "off",
    flamer: p.heatFlamer ? "on" : "off",
  });
}

/** Change one policy of the acting unit, effective at once. A real change is
 *  recorded in the replay; setting the current value records nothing. */
export function setActorPolicy(
  s: Session,
  actor: UnitState,
  prop: PolicyProp,
  raw: string,
): { prop: PolicyProp; value: string } {
  const { patch, value } = parsePolicyValue(prop, raw);
  const before = unitPolicyOf(actor);
  const after = setUnitPolicy(s.battle!, actor.id, patch);
  if (after[prop] !== before[prop]) recordPolicy(s, actor.id, after);
  return { prop, value };
}
