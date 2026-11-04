/**
 * Policy rows shared by the policy dialog (`setup.ts`) and the record sheet's
 * policy code and tooltip (`battle.sheet.ts`): for each of the four per-unit
 * policies (docs/VISION.md §2.2) its label, the code letters of each value,
 * the value name, a one-sentence description and a few-word brief.
 */
import {
  AMMO_POLICIES,
  AMS_POLICIES,
  type AmmoPolicy,
  type AmsPolicy,
  type UnitPolicy,
} from "btlib10x";
import { t } from "../i18n";

const AMMO_CODE: Readonly<Record<AmmoPolicy, string>> = {
  exposed: "Ae",
  core: "Ac",
  spread: "As",
  leastFirst: "Al",
};
const AMS_CODE: Readonly<Record<AmsPolicy, string>> = {
  expected: "Me",
  firstHit: "Mf",
  priority: "Mp",
  off: "Mo",
};

/** One policy as a choice among `values`, read from and written to a `UnitPolicy`. */
export interface PolicyRow<V> {
  /** `ammo`, `eject`, `flamer` or `ams`: the message key part. */
  readonly id: string;
  readonly values: readonly V[];
  get(p: UnitPolicy): V;
  set(p: UnitPolicy, v: V): void;
  /** Value word in the message keys (`exposed`, `on`, `heat`, …). */
  word(v: V): string;
  /** Sheet code letters of a value (`Ae`, `J`, `f`, `Mo`, …). */
  code(v: V): string;
}

const ammo: PolicyRow<AmmoPolicy> = {
  id: "ammo",
  values: AMMO_POLICIES,
  get: (p) => p.ammoPolicy,
  set: (p, v) => {
    p.ammoPolicy = v;
  },
  word: (v) => v,
  code: (v) => AMMO_CODE[v],
};
const eject: PolicyRow<boolean> = {
  id: "eject",
  values: [true, false],
  get: (p) => p.autoEject,
  set: (p, v) => {
    p.autoEject = v;
  },
  word: (v) => (v ? "on" : "off"),
  code: (v) => (v ? "J" : "j"),
};
const flamer: PolicyRow<boolean> = {
  id: "flamer",
  values: [true, false],
  get: (p) => p.heatFlamer,
  set: (p, v) => {
    p.heatFlamer = v;
  },
  word: (v) => (v ? "heat" : "damage"),
  code: (v) => (v ? "F" : "f"),
};
const ams: PolicyRow<AmsPolicy> = {
  id: "ams",
  values: AMS_POLICIES,
  get: (p) => p.amsPolicy,
  set: (p, v) => {
    p.amsPolicy = v;
  },
  word: (v) => v,
  code: (v) => AMS_CODE[v],
};

/** The four policies in dialog and code order. */
// biome-ignore lint/suspicious/noExplicitAny: rows differ in value type
export const POLICY_ROWS: readonly PolicyRow<any>[] = [ammo, eject, flamer, ams];

/** Row label, e.g. "Ammo order". */
export function policyLabel<V>(r: PolicyRow<V>): string {
  return t(`policy.${r.id}`);
}

/** Value name, e.g. "exposed". */
export function policyValue<V>(r: PolicyRow<V>, v: V): string {
  return t(`policy.${r.id}.${r.word(v)}`);
}

/** One-sentence description of a value (policy dialog). */
export function policyDesc<V>(r: PolicyRow<V>, v: V): string {
  return t(`policy.desc.${r.id}.${r.word(v)}`);
}

/** Few-word description of a value (sheet tooltip). */
export function policyBrief<V>(r: PolicyRow<V>, v: V): string {
  return t(`policy.brief.${r.id}.${r.word(v)}`);
}

/** The six-letter code of a policy set, e.g. `AeJFMe`. */
export function policyCodeOf(p: UnitPolicy): string {
  return POLICY_ROWS.map((r) => r.code(r.get(p))).join("");
}
