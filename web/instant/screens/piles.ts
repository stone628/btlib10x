/**
 * Map hover text (battle and debrief): what lies in a hex marked `%`
 * (wreckage) or `!` (severed limb or dropped club), one line per pile entry.
 */
import type { BattleState, HexCoord } from "btlib10x";
import { locName, t } from "../i18n";
import { UI_THEME } from "../theme";

const { MARK: M } = UI_THEME;

/** Lines for the wreckage and club piles in hex `"col,row"`; null when none. */
export function pileTip(state: BattleState, hexKey: string): string | null {
  const wrecks = state.wreckage[hexKey] ?? [];
  const clubs = state.clubs[hexKey] ?? [];
  if (wrecks.length === 0 && clubs.length === 0) return null;
  const who = (id: string | null, model: string) => (id === null ? model : `${id} ${model}`);
  const lines: string[] = [];
  for (const w of wrecks)
    lines.push(`${who(w.unitId, w.model)} ${M.sep} ${t("debrief.kind.wreckage")}`);
  for (const c of clubs)
    lines.push(
      c.kind === "limb"
        ? `${who(c.ownerId, c.model)} ${M.sep} ${t("debrief.pile.limb", { loc: locName(c.limb) })}`
        : t("debrief.pile.club", { kind: t(`club.${c.kind}`) }),
    );
  return lines.join("\n");
}

/** A `MapView.tipFor` hook showing {@link pileTip} for `state`. */
export function pileTipFor(state: BattleState): (hex: HexCoord) => string | null {
  return (hex) => pileTip(state, `${hex.col},${hex.row}`);
}
