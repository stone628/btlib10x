/**
 * The battle screen's record sheet (22×21 cells, docs/INSTANT_ACTION.html):
 * unit and pilot status chips, policy code, crit pips, the armor grid and
 * heat. Every tooltip opens at one point beside the pilot chip (sheetTip).
 */
import {
  ammoBinId,
  componentHitStatus,
  ENGINE_SLOTS_KILL,
  GYRO_DESTROYED_HITS,
  HEAT_SCALE_MAX,
  heatDissipation,
  heatDissipationMax,
  isHull,
  isSlotDestroyed,
  isUnitDestroyed,
  isWeaponCritted,
  loadAmmoBins,
  mechDefFor,
  pilotStatus,
  SENSOR_BLIND_HITS,
  type UnitState,
  unitPolicyOf,
  usableShots,
} from "btlib10x";
import { locName, t } from "../i18n";
import { UI_THEME } from "../theme";
import type { TipPoint, TuiNode } from "../tui";
import { engineTip, gyroTip, heatTip, lifeSupportTip, pilotTip, sensorTip } from "./battle.hints";
import { fit, h, row, span } from "./common";

const { GRID: G, ROUND: R, MARK: M, ARROW: A, BAR: B } = UI_THEME;

export const SHEET_W = 22;

type Loc =
  | "head"
  | "centerTorso"
  | "leftTorso"
  | "rightTorso"
  | "leftArm"
  | "rightArm"
  | "leftLeg"
  | "rightLeg";

const AMMO_CODE = { exposed: "e", core: "c", spread: "s", leastFirst: "l" } as const;
const AMS_CODE = { expected: "e", firstHit: "f", priority: "p", off: "o" } as const;

/**
 * Unit chip word (8 cells): NOMINAL green, SHUTDOWN red from heat and white
 * when voluntary, HULL and WRECKAGE dim.
 */
function unitChip(u: UnitState): { text: string; cls: string } {
  if (isUnitDestroyed(u.damage)) return { text: t("chip.wreckage"), cls: "ia-dim" };
  if (isHull(u)) return { text: t("chip.hull"), cls: "ia-dim" };
  if (u.shutdown === "heat") return { text: t("chip.shutdown"), cls: "ia-lv-red" };
  if (u.shutdown === "manual") return { text: t("chip.shutdown"), cls: "ia-lv-white" };
  return { text: t("chip.nominal"), cls: "ia-lv-green" };
}

/**
 * Pilot chip word (7 cells): ACTIVE green, UNCONSC and DECEASD red, EJECTED
 * and ABANDON dim.
 */
function pilotChip(u: UnitState): { text: string; cls: string } {
  const s = pilotStatus(u);
  const cls =
    s === "active" ? "ia-lv-green" : s === "unconscious" || s === "dead" ? "ia-lv-red" : "ia-dim";
  return { text: t(`chip.pilot.${s}`), cls };
}

/**
 * Colour of a `cur/max` value by what is left: green from 80%, white from
 * 60%, yellow from 40%, orange from 20%, red above 0, dim at 0.
 */
export function levelCls(cur: number, max: number): string {
  if (max <= 0 || cur <= 0) return "ia-dim";
  const r = cur / max;
  if (r >= 0.8) return "ia-lv-green";
  if (r >= 0.6) return "ia-lv-white";
  if (r >= 0.4) return "ia-lv-yellow";
  if (r >= 0.2) return "ia-lv-orange";
  return "ia-lv-red";
}

/**
 * Colour of a component by the hits it can still take before it is gone:
 * green untouched, red when gone, and between them yellow, then orange
 * (engine: green, yellow, orange, red; gyro and sensors: green, yellow, red;
 * life support: green, red).
 */
function componentCls(hits: number, total: number): string {
  const left = Math.max(0, total - hits);
  if (left >= total) return "ia-lv-green";
  if (left === 0) return "ia-lv-red";
  return total - left === 1 ? "ia-lv-yellow" : "ia-lv-orange";
}

/** Six-letter policy code, e.g. `AeJFMe` (see the tooltip for the breakdown). */
export function policyCode(u: UnitState): { code: string; tip: string } {
  const p = unitPolicyOf(u);
  const a = `A${AMMO_CODE[p.ammoPolicy]}`;
  const j = p.autoEject ? "J" : "j";
  const f = p.heatFlamer ? "F" : "f";
  const m = `M${AMS_CODE[p.amsPolicy]}`;
  const onOff = (on: boolean) => t(on ? "policy.on" : "policy.off");
  const tip = [
    t("policy.title", { id: u.id }),
    `${a} ${t("policy.ammo")}: ${t(`ammo.${p.ammoPolicy}`)}`,
    `${fit(j, 2)} ${t("policy.autoEject")}: ${onOff(p.autoEject)}`,
    `${fit(f, 2)} ${t("policy.heatFlamer")}: ${onOff(p.heatFlamer)}`,
    `${m} ${t("policy.ams")}: ${t(`ams.${p.amsPolicy}`)}`,
  ].join("\n");
  return { code: `${a}${j}${f}${m}`, tip };
}

/** Hits taken as □, what is left as ■. */
function pips(taken: number, total: number): string {
  const n = Math.max(0, Math.min(total, taken));
  return B.pipTaken.repeat(n) + B.pipLeft.repeat(total - n);
}

function slotLabel(slot: ReturnType<typeof mechDefFor>["critSlots"]["head"][number]): string {
  switch (slot.kind) {
    case "empty":
      return t("crit.empty");
    case "soak":
      return t(`crit.soak.${slot.name}`);
    case "weapon":
    case "ammo":
      return slot.weapon;
    default:
      return slot.name ?? t(`crit.${slot.type}`);
  }
}

/** Crit slots of one location, one per line, with live ammo and hits. */
export function critTip(u: UnitState, loc: Loc): string {
  const def = mechDefFor(u);
  const bins = loadAmmoBins(def);
  const gone = u.damage.internalStructure[loc] <= 0;
  const lines = [`${u.id} ${locName(loc)}`];
  def.critSlots[loc].forEach((slot, i) => {
    let text = `${fit(i + 1, 2, "right")} ${slotLabel(slot)}`;
    if (slot.kind === "ammo") {
      const id = ammoBinId(loc, i + 1);
      const max = bins[id];
      if (max !== undefined) {
        const curr = usableShots(u, { id, location: loc, slotIndex: i + 1 });
        text += ` (${curr}/${max})`;
      }
    }
    if (slot.kind === "weapon" && u.jammedWeapons.includes(slot.weaponIndex))
      text += ` ${M.chipL}J${M.chipR}`;
    const hit =
      slot.kind !== "empty" &&
      (gone ||
        isSlotDestroyed(u.critSlotsDestroyed, loc, i) ||
        (slot.kind === "weapon" && isWeaponCritted(def, u.critSlotsDestroyed, slot.weaponIndex)));
    if (hit) text += ` ${M.chipL}X${M.chipR}`;
    lines.push(text);
  });
  return lines.join("\n");
}

/** One 6-cell grid value: `cur/max` plus the pool letter (I, A, F, R). */
function cell(
  side: 0 | 1,
  u: UnitState,
  loc: Loc,
  cur: number,
  max: number,
  pool: string,
  key: string,
): TuiNode {
  const text = `${fit(Math.max(0, cur), 2, "right")}/${fit(max, 2, "right")}${pool}`;
  return span(text, { cls: levelCls(cur, max), tip: critTip(u, loc), key, ...sheetTip(side) });
}

function label(side: 0 | 1, u: UnitState, loc: Loc): TuiNode {
  return span(`${M.chipL}${fit(locName(loc), 2)}${M.chipR}`, {
    tip: critTip(u, loc),
    key: `l${loc}`,
    ...sheetTip(side),
  });
}

const TORSO = new Set<Loc>(["centerTorso", "leftTorso", "rightTorso"]);
/** Id of a sheet's status chip, the origin of its tooltip point. */
const chipId = (side: 0 | 1, chip: "unit" | "pilot") => `ia-sheet${side}-${chip}`;
/** Pilot chip width: ⦗ + 7 + ⦘. */
const PILOT_CHIP_W = 9;

/**
 * Every sheet tooltip opens at one point: on the left sheet one cell right
 * of the pilot chip's right end and one row above it, over the SHEET tab,
 * hanging from the tip's top-left; the right sheet mirrors it, one cell left
 * of the unit chip's left end, hanging from the tip's top-right.
 */
function sheetTip(side: 0 | 1): { tipXY: string; tipFrom: string; tipAnchor: TipPoint } {
  return side === 0
    ? { tipXY: `${PILOT_CHIP_W + 1},-1`, tipFrom: `#${chipId(0, "pilot")}`, tipAnchor: "nw" }
    : { tipXY: "-1,-1", tipFrom: `#${chipId(1, "unit")}`, tipAnchor: "ne" };
}

/**
 * The record sheet: 21 rows of SHEET_W cells. The box rows fill the width;
 * the text rows above them start one cell in. `side` is the drawer (0 left,
 * 1 right) for tooltip placement. `onPick` opens the unit picker;
 * `onPolicy`, when set, makes the policy code a button.
 */
export function recordSheet(
  u: UnitState,
  side: 0 | 1,
  onPick: (e: MouseEvent) => void,
  onPolicy: (() => void) | null,
): TuiNode[] {
  const H = h();
  const textW = SHEET_W - 1;
  const text = (s: string, o: { cls?: string; key: string }) => row(` ${fit(s, textW)}`, o);
  const def = mechDefFor(u);
  const team = `ia-team${u.team}`;
  const a = u.damage.armor;
  const ar = u.damage.armorRear;
  const is = u.damage.internalStructure;
  // The scale value the engine reads this turn; pending heat lands in the
  // Heat Phase (the heat tooltip shows the forecast).
  const heat = u.heat;
  const counts = componentHitStatus(def, u.damage, u.critSlotsDestroyed);
  const pol = policyCode(u);
  const uc = unitChip(u);
  const pc = pilotChip(u);
  const L = (key: string, ...kids: (TuiNode | string)[]) =>
    H.el("div", { class: "ia-row", key }, ...kids);
  // Internal-structure row, armor row(s) for a band of three locations.
  const band = (locs: readonly [Loc, Loc, Loc], k: string): TuiNode[] => {
    const rows: TuiNode[] = [];
    const isRow: (TuiNode | string)[] = [G.tv];
    for (const loc of locs)
      isRow.push(cell(side, u, loc, is[loc], def.internalStructure[loc], "I", `i${loc}`), G.tv);
    rows.push(L(`${k}i`, ...isRow));
    const torso = locs.every((l) => TORSO.has(l));
    const front: (TuiNode | string)[] = [G.tv];
    for (const loc of locs)
      front.push(cell(side, u, loc, a[loc], def.armor[loc], torso ? "F" : "A", `a${loc}`), G.tv);
    rows.push(L(`${k}a`, ...front));
    if (torso) {
      const rear: (TuiNode | string)[] = [G.tv];
      for (const loc of locs) {
        const tl = loc as "centerTorso" | "leftTorso" | "rightTorso";
        rear.push(cell(side, u, loc, ar[tl], def.armorRear[tl], "R", `r${loc}`), G.tv);
      }
      rows.push(L(`${k}r`, ...rear));
    }
    return rows;
  };
  const sinks = heatDissipation(def, u.damage, u.critSlotsDestroyed);
  const sinksMax = heatDissipationMax(def);
  const filled = Math.max(0, Math.min(20, Math.round((heat / HEAT_SCALE_MAX) * 20)));
  const heatCls = heat >= 14 ? "ia-err" : heat >= 5 ? "ia-warn" : "ia-accent";
  const pilotMax = Math.min(8, u.pilotHitMax);
  // The unit picker: the sheet width less a cell on each side.
  const head = fit(` ${t("sheet.side", { team: u.team })} : ${u.id}`, SHEET_W - 4);
  return [
    H.el(
      "div",
      { class: "ia-row", key: "head" },
      " ",
      H.el(
        "span",
        { class: "ia-sheet-head", attrs: { "data-click": "" }, onClick: onPick },
        span(head, { cls: team }),
        `${A.pick} `,
      ),
      " ",
    ),
    text(G.th.repeat(textW), { cls: "ia-dim", key: "rule" }),
    text(`${def.model} ${def.name}`, { cls: "ia-bright", key: "model" }),
    text(`walk:${def.walking} run:${def.running} jump:${def.jumping}`, { key: "mp" }),
    text(`gun:${u.gunnery} pilot:${u.piloting}`, { key: "skill" }),
    row(`${R.nw}${G.th.repeat(SHEET_W - 2)}${R.ne}`, { key: "top" }),
    L(
      "chips",
      G.tv,
      span(`${M.chipL}${fit(uc.text, 8)}${M.chipR}`, { cls: uc.cls, id: chipId(side, "unit") }),
      " ",
      span(`${M.chipL}${fit(pc.text, 7)}${M.chipR}`, {
        cls: pc.cls,
        id: chipId(side, "pilot"),
        tip: pilotTip(u),
        ...sheetTip(side),
      }),
      G.tv,
    ),
    L(
      "pilot",
      G.tv,
      span(fit(`P:${pips(u.pilotHits, pilotMax)}`, 12), {
        cls: levelCls(u.pilotHitMax - u.pilotHits, u.pilotHitMax),
        tip: pilotTip(u),
        ...sheetTip(side),
      }),
      // The acting player unit's policy is a [button] to its dialog.
      onPolicy
        ? span(`[${pol.code}]`, {
            tip: pol.tip,
            cls: "ia-bright",
            onClick: () => onPolicy(),
            ...sheetTip(side),
          })
        : span(`${M.chipL}${pol.code}${M.chipR}`, {
            tip: pol.tip,
            cls: "ia-bright",
            ...sheetTip(side),
          }),
      G.tv,
    ),
    L(
      "crits",
      G.tv,
      span(`E:${pips(counts.engine, ENGINE_SLOTS_KILL)}`, {
        cls: componentCls(counts.engine, ENGINE_SLOTS_KILL),
        tip: engineTip(u),
        ...sheetTip(side),
      }),
      " ",
      span(`G:${pips(counts.gyro, GYRO_DESTROYED_HITS)}`, {
        cls: componentCls(counts.gyro, GYRO_DESTROYED_HITS),
        tip: gyroTip(u),
        ...sheetTip(side),
      }),
      " ",
      span(`S:${pips(counts.sensors, SENSOR_BLIND_HITS)}`, {
        cls: componentCls(counts.sensors, SENSOR_BLIND_HITS),
        tip: sensorTip(u),
        ...sheetTip(side),
      }),
      " ",
      span(`L:${pips(counts.lifeSupport, 1)}`, {
        cls: componentCls(counts.lifeSupport, 1),
        tip: lifeSupportTip(u),
        ...sheetTip(side),
      }),
      ` ${G.tv}`,
    ),
    L(
      "h1",
      `${G.tw}${G.th}`,
      label(side, u, "rightArm"),
      `${G.th}${G.tn}${G.th}`,
      label(side, u, "head"),
      `${G.th}${G.tn}${G.th}`,
      label(side, u, "leftArm"),
      `${G.th}${G.te}`,
    ),
    ...band(["rightArm", "head", "leftArm"], "b1"),
    L(
      "h2",
      `${G.tw}${G.th}`,
      label(side, u, "rightTorso"),
      `${G.th}${G.tc}${G.th}`,
      label(side, u, "centerTorso"),
      `${G.th}${G.tc}${G.th}`,
      label(side, u, "leftTorso"),
      `${G.th}${G.te}`,
    ),
    ...band(["rightTorso", "centerTorso", "leftTorso"], "b2"),
    L(
      "h3",
      `${G.tw}${G.th}`,
      label(side, u, "rightLeg"),
      `${G.th}${G.tc}${G.th.repeat(6)}${G.tc}${G.th}`,
      label(side, u, "leftLeg"),
      `${G.th}${G.te}`,
    ),
    L(
      "l1",
      G.tv,
      cell(side, u, "rightLeg", is.rightLeg, def.internalStructure.rightLeg, "I", "irl"),
      `${G.tv} ${M.chipL}HS${M.chipR} ${G.tv}`,
      cell(side, u, "leftLeg", is.leftLeg, def.internalStructure.leftLeg, "I", "ill"),
      G.tv,
    ),
    L(
      "l2",
      G.tv,
      cell(side, u, "rightLeg", a.rightLeg, def.armor.rightLeg, "A", "arl"),
      G.tv,
      span(`-${fit(sinks, 2, "right")}/${fit(sinksMax, 2, "right")}`, {
        cls: levelCls(sinks, sinksMax),
      }),
      G.tv,
      cell(side, u, "leftLeg", a.leftLeg, def.armor.leftLeg, "A", "all"),
      G.tv,
    ),
    L(
      "bottom",
      `${R.sw}${G.th.repeat(6)}${R.se}`,
      span(`${R.nw}HT${fit(heat, 2, "right")}${R.ne}`, {
        cls: heatCls,
        tip: heatTip(u),
        ...sheetTip(side),
      }),
      `${R.sw}${G.th.repeat(6)}${R.se}`,
    ),
    L(
      "heat",
      B.capL,
      span(B.full.repeat(filled), { cls: heatCls, tip: heatTip(u), ...sheetTip(side) }),
      span(B.empty.repeat(20 - filled), { cls: "ia-dim", tip: heatTip(u), ...sheetTip(side) }),
      B.capR,
    ),
  ];
}
